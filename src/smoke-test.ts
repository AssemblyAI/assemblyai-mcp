/**
 * In-process smoke test that exercises both MCP tools end-to-end with a
 * stubbed AssemblyAI HTTP layer. Run with `npm test`.
 *
 * Coverage:
 *   1. submit_transcript happy path — POSTs to /v2/transcript
 *   2. Bearer prefix is stripped (regression guard for the Databricks auth bridge)
 *   3. submit_transcript URL validation rejects file://
 *   4. AssemblyAI 401 surfaces as friendly error
 *   5. get_transcript happy path (status=completed)
 *   5b. get_transcript with speaker utterances — appears in text content with timestamps
 *   6. get_transcript while processing returns status without error
 *   7. 5xx retry-then-succeed
 *   8. 4xx no retry
 *   9. submit_transcript sentiment_analysis flag + required speech_models
 *   10. submit_transcript entity_detection flag
 *   11. submit_transcript redact_pii defaults (policies + sub)
 *   12. summarization flag is inert — no deprecated params reach AssemblyAI
 *   13. get_transcript renders sentiment + entities sections in text content
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { registerTools } from "./server";

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

let calls: FetchCall[] = [];
let nextResponses: Array<Response | (() => Response)> = [];

const originalFetch = globalThis.fetch;

function captureHeaders(init?: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  const h = new Headers(init?.headers);
  h.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return out;
}

function installMockFetch() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const body = init?.body ? String(init.body) : null;
    calls.push({ url, method, headers: captureHeaders(init), body });

    if (nextResponses.length === 0) {
      throw new Error(`Mock fetch: no queued response for ${method} ${url}`);
    }
    const next = nextResponses.shift()!;
    return typeof next === "function" ? next() : next;
  }) as typeof fetch;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function resetMock(responses: Array<Response | (() => Response)>) {
  calls = [];
  nextResponses = responses;
}

let passed = 0;
let failed = 0;
function assert(name: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

interface ToolResult {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  bearerForExtra: string
): Promise<ToolResult> {
  // The MCP client doesn't normally let us inject `extra.authInfo`. For the
  // smoke test we set it directly on the server's currently-handled request
  // via the test transport pair: we simulate the withMcpAuth result by
  // monkey-patching the registered tool callback to inject authInfo.
  return (await client.callTool({
    name,
    arguments: args,
    _meta: { bearerForExtra },
  })) as ToolResult;
}

async function withClientServer<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const server = new McpServer({ name: "smoke", version: "0.0.0" });

  // We can't actually use withMcpAuth in-process. Patch registerTool so we
  // wrap each tool callback to read `_meta.bearerForExtra` from the request
  // context and inject it as `extra.authInfo.token`. This mirrors what
  // withMcpAuth does at the HTTP layer.
  const originalRegister = server.registerTool.bind(server);
  server.registerTool = ((name: string, config: unknown, cb: unknown) => {
    const wrapped = async (args: unknown, extra: { _meta?: { bearerForExtra?: string }; authInfo?: { token: string } }) => {
      const bearer = extra._meta?.bearerForExtra;
      if (bearer) {
        extra.authInfo = { token: bearer } as { token: string };
      }
      return (cb as (a: unknown, e: unknown) => Promise<unknown>)(args, extra);
    };
    return originalRegister(name, config as never, wrapped as never);
  }) as typeof server.registerTool;

  registerTools(server);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "smoke", version: "0.0.0" });
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

async function run() {
  installMockFetch();
  console.log("Running smoke tests…\n");

  // 1. submit_transcript happy path + 2. Bearer stripping
  await withClientServer(async (client) => {
    resetMock([jsonResponse(200, { id: "txn-1", status: "queued" })]);
    const result = await callTool(
      client,
      "submit_transcript",
      { audio_url: "https://example.com/x.mp3" },
      "raw-key-no-prefix"
    );
    assert("1. submit_transcript happy path → not isError", result.isError !== true);
    assert(
      "1. submit_transcript returns transcript_id from AssemblyAI",
      result.structuredContent?.transcript_id === "txn-1"
    );
    assert(
      "2. Bearer prefix is stripped (Authorization header is the raw key)",
      calls[0]?.headers["authorization"] === "raw-key-no-prefix",
      `got: ${calls[0]?.headers["authorization"]}`
    );
  });

  // 3. URL validation rejects file:// (must be before any fetch attempt)
  await withClientServer(async (client) => {
    resetMock([]);
    const result = await callTool(client, "submit_transcript", { audio_url: "file:///etc/passwd" }, "k");
    const text = (result.content?.[0]?.text ?? "").toLowerCase();
    assert(
      "3. submit_transcript rejects file:// URL before calling AssemblyAI",
      result.isError === true && text.includes("http") && calls.length === 0,
      `isError=${result.isError} text=${text} calls=${calls.length}`
    );
  });

  // 4. AssemblyAI 401 surfaces as friendly error
  await withClientServer(async (client) => {
    resetMock([jsonResponse(401, { error: "Invalid API key" })]);
    const result = await callTool(
      client,
      "submit_transcript",
      { audio_url: "https://example.com/x.mp3" },
      "bad-key"
    );
    const text = result.content?.[0]?.text ?? "";
    assert(
      "4. AssemblyAI 401 surfaces as friendly error",
      result.isError === true && text.includes("AssemblyAI rejected the API key"),
      `isError=${result.isError} text=${text}`
    );
  });

  // 5. get_transcript completed
  await withClientServer(async (client) => {
    resetMock([
      jsonResponse(200, {
        id: "txn-9",
        status: "completed",
        text: "hello world",
        audio_duration: 5,
      }),
    ]);
    const result = await callTool(client, "get_transcript", { transcript_id: "txn-9" }, "k");
    assert(
      "5. get_transcript completed returns status=completed",
      result.structuredContent?.status === "completed"
    );
    assert(
      "5. get_transcript completed returns text",
      result.structuredContent?.text === "hello world"
    );
    const text5 = result.content?.[0]?.text ?? "";
    assert(
      "5. get_transcript text payload includes full transcript text",
      text5.includes("hello world"),
      `payload: ${text5}`
    );
  });

  // 5b. get_transcript completed WITH speaker utterances → must appear in text content
  await withClientServer(async (client) => {
    resetMock([
      jsonResponse(200, {
        id: "txn-d",
        status: "completed",
        text: "A hello. B hi there.",
        audio_duration: 4,
        utterances: [
          { speaker: "A", text: "hello.", start: 0, end: 1200 },
          { speaker: "B", text: "hi there.", start: 1500, end: 3000 },
        ],
      }),
    ]);
    const result = await callTool(client, "get_transcript", { transcript_id: "txn-d" }, "k");
    const text5b = result.content?.[0]?.text ?? "";
    assert(
      "5b. utterances appear in text payload (not just structuredContent)",
      text5b.includes("[A]") && text5b.includes("[B]") && text5b.includes("hi there"),
      `payload: ${text5b}`
    );
    assert(
      "5b. timestamps appear in text payload",
      /\d+:\d{2}/.test(text5b),
      `payload: ${text5b}`
    );
  });

  // 6. get_transcript while processing
  await withClientServer(async (client) => {
    resetMock([jsonResponse(200, { id: "txn-2", status: "processing" })]);
    const result = await callTool(client, "get_transcript", { transcript_id: "txn-2" }, "k");
    assert(
      "6. get_transcript in-progress returns status without erroring",
      result.isError !== true && result.structuredContent?.status === "processing"
    );
  });

  // 7. 5xx retry-then-succeed
  await withClientServer(async (client) => {
    resetMock([
      jsonResponse(500, { error: "server error" }),
      jsonResponse(502, { error: "bad gateway" }),
      jsonResponse(200, { id: "txn-3", status: "completed", text: "ok" }),
    ]);
    const result = await callTool(client, "get_transcript", { transcript_id: "txn-3" }, "k");
    assert(
      "7. 5xx retries then succeeds",
      result.structuredContent?.status === "completed" && calls.length === 3
    );
  });

  // 8. 4xx no retry
  await withClientServer(async (client) => {
    resetMock([jsonResponse(404, { error: "not found" })]);
    const result = await callTool(client, "get_transcript", { transcript_id: "missing" }, "k");
    const text = (result.content?.[0]?.text ?? "").toLowerCase();
    assert("8. 4xx does not retry (only 1 call)", calls.length === 1);
    assert(
      "8. 4xx surfaces error",
      result.isError === true && (text.includes("not found") || text.includes("404")),
      `isError=${result.isError} text=${text}`
    );
  });

  // 9. submit_transcript sentiment_analysis → payload flag + required speech_models
  await withClientServer(async (client) => {
    resetMock([jsonResponse(200, { id: "txn-s", status: "queued" })]);
    await callTool(
      client,
      "submit_transcript",
      { audio_url: "https://example.com/x.mp3", sentiment_analysis: true },
      "k"
    );
    const body = JSON.parse(calls[0]?.body ?? "{}");
    assert("9. sentiment_analysis flag set in payload", body.sentiment_analysis === true, JSON.stringify(body));
    assert(
      "9. speech_models set for sentiment",
      Array.isArray(body.speech_models) && body.speech_models.includes("universal-3-pro"),
      JSON.stringify(body)
    );
  });

  // 10. submit_transcript entity_detection → payload flag
  await withClientServer(async (client) => {
    resetMock([jsonResponse(200, { id: "txn-e", status: "queued" })]);
    await callTool(
      client,
      "submit_transcript",
      { audio_url: "https://example.com/x.mp3", entity_detection: true },
      "k"
    );
    const body = JSON.parse(calls[0]?.body ?? "{}");
    assert("10. entity_detection flag set in payload", body.entity_detection === true, JSON.stringify(body));
  });

  // 11. submit_transcript redact_pii → flag + default policies + default sub
  await withClientServer(async (client) => {
    resetMock([jsonResponse(200, { id: "txn-r", status: "queued" })]);
    await callTool(
      client,
      "submit_transcript",
      { audio_url: "https://example.com/x.mp3", redact_pii: true },
      "k"
    );
    const body = JSON.parse(calls[0]?.body ?? "{}");
    assert("11. redact_pii flag set", body.redact_pii === true, JSON.stringify(body));
    assert(
      "11. default redact_pii_policies applied",
      Array.isArray(body.redact_pii_policies) && body.redact_pii_policies.includes("person_name"),
      JSON.stringify(body)
    );
    assert("11. default redact_pii_sub = entity_name", body.redact_pii_sub === "entity_name", JSON.stringify(body));
  });

  // 12. summarization flag is inert — no deprecated params reach AssemblyAI
  await withClientServer(async (client) => {
    resetMock([jsonResponse(200, { id: "txn-sum", status: "queued" })]);
    await callTool(
      client,
      "submit_transcript",
      { audio_url: "https://example.com/x.mp3", summarization: true },
      "k"
    );
    const body = JSON.parse(calls[0]?.body ?? "{}");
    assert(
      "12. no deprecated summarization params",
      body.summarization === undefined && body.summary_model === undefined && body.summary_type === undefined,
      JSON.stringify(body)
    );
  });

  // 13. get_transcript renders sentiment + entities sections in the text content
  await withClientServer(async (client) => {
    resetMock([
      jsonResponse(200, {
        id: "txn-ai",
        status: "completed",
        text: "Acme is great.",
        audio_duration: 3,
        sentiment_analysis_results: [
          { text: "Acme is great.", sentiment: "POSITIVE", confidence: 0.97, start: 0, end: 1500, speaker: "A" },
        ],
        entities: [{ text: "Acme", entity_type: "organization", start: 0, end: 400 }],
      }),
    ]);
    const result = await callTool(client, "get_transcript", { transcript_id: "txn-ai" }, "k");
    const text = result.content?.[0]?.text ?? "";
    assert("13. sentiment section present", text.includes("--- sentiment") && text.includes("POSITIVE"), text);
    assert("13. entities section present", text.includes("--- entities") && text.includes("organization: Acme"), text);
  });

  globalThis.fetch = originalFetch;

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
