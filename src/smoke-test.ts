/**
 * In-process smoke test that exercises both MCP tools end-to-end with a
 * stubbed AssemblyAI HTTP layer. Run with `npm test`.
 *
 * Coverage:
 *   1. submit_transcript happy path — POSTs to /v2/transcript
 *   2. Bearer prefix is stripped (regression guard for the Databricks auth bridge)
 *   3. submit_transcript URL validation rejects file://
 *   4. AssemblyAI 401 surfaces as friendly error
 *   5. get_transcript happy path (status=completed, incl. speech_model_used)
 *   5b. get_transcript with speaker utterances — appears in text content with timestamps
 *   6. get_transcript while processing returns status without error
 *   7. 5xx retry-then-succeed
 *   8. 4xx no retry
 *   9. submit_transcript sentiment_analysis flag + pinned speech_models
 *   10. submit_transcript entity_detection flag
 *   11. submit_transcript redact_pii defaults (policies + sub)
 *   12. summarization flag is inert — no deprecated params reach AssemblyAI
 *   13. get_transcript renders sentiment + entities sections in text content
 *   14. summarize_transcript calls LLM Gateway with transcript_id + {{ transcript }} tag
 *   15. summarize_transcript with style=custom but no custom_prompt → validation error, no gateway call
 *   16.–18. scalar/boolean pass-through params
 *   19. nested objects pass through unchanged (language_detection_options, speaker_options, etc.)
 *   20. speech_understanding.request nests correctly with translation, summarization, action_items
 *   21. speech_understanding without request wrapper rejected before API call
 *   22. get_transcript renders translation / speaker_identification / custom_formatting
 *   23. get_transcript renders su_summary + action_items
 *   24. get_transcript renders content_safety / topics / highlights / unredacted / warnings
 *   25. get_transcript fetches redacted audio URL when flag present; degrades gracefully when not ready
 *   26. understand_transcript posts to the Gateway /v1/understanding and renders results
 *   27. understand_transcript 404 → friendly message
 *   27b. understand_transcript 401 → friendly bad-key error
 *   28. understand_transcript 429 → rate-limit message; summarize_transcript description points here
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
    const body1 = JSON.parse(calls[0]?.body ?? "{}");
    assert(
      "1. every submission pins speech_models to universal-3-5-pro + universal-2",
      JSON.stringify(body1.speech_models) === JSON.stringify(["universal-3-5-pro", "universal-2"]),
      JSON.stringify(body1)
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
        speech_model_used: "universal-3-5-pro",
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
    assert(
      "5. get_transcript surfaces speech_model_used in structuredContent",
      result.structuredContent?.speech_model_used === "universal-3-5-pro"
    );
    const text5 = result.content?.[0]?.text ?? "";
    assert(
      "5. get_transcript text payload includes full transcript text",
      text5.includes("hello world"),
      `payload: ${text5}`
    );
    assert(
      "5. get_transcript text payload includes speech_model_used",
      text5.includes("speech_model_used=universal-3-5-pro"),
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

  // 9. submit_transcript sentiment_analysis → payload flag + pinned speech_models
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
      "9. speech_models pinned to universal-3-5-pro + universal-2",
      JSON.stringify(body.speech_models) === JSON.stringify(["universal-3-5-pro", "universal-2"]),
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

  // 14. summarize_transcript calls LLM Gateway with transcript_id + {{ transcript }} tag
  await withClientServer(async (client) => {
    resetMock([jsonResponse(200, { choices: [{ message: { content: "- point one\n- point two" } }] })]);
    const result = await callTool(client, "summarize_transcript", { transcript_id: "txn-ai" }, "k");
    assert("14. posts to LLM Gateway host", (calls[0]?.url ?? "").includes("llm-gateway"), calls[0]?.url);
    const body = JSON.parse(calls[0]?.body ?? "{}");
    assert("14. sends transcript_id", body.transcript_id === "txn-ai", JSON.stringify(body));
    assert(
      "14. prompt includes {{ transcript }} tag",
      typeof body.messages?.[0]?.content === "string" && body.messages[0].content.includes("{{ transcript }}"),
      JSON.stringify(body)
    );
    const text = result.content?.[0]?.text ?? "";
    assert("14. returns summary content", text.includes("point one"), text);
  });

  // 15. summarize_transcript with style=custom but no custom_prompt → error, no gateway call
  await withClientServer(async (client) => {
    resetMock([]);
    const result = await callTool(
      client,
      "summarize_transcript",
      { transcript_id: "txn-ai", style: "custom" },
      "k"
    );
    const text = (result.content?.[0]?.text ?? "").toLowerCase();
    assert(
      "15. style=custom without custom_prompt errors before calling the gateway",
      result.isError === true && text.includes("custom_prompt") && calls.length === 0,
      `isError=${result.isError} text=${text} calls=${calls.length}`
    );
  });

  // 16. submit_transcript scalar/boolean params pass through with API names
  await withClientServer(async (client) => {
    resetMock([jsonResponse(200, { id: "txn-p1", status: "queued" })]);
    await callTool(
      client,
      "submit_transcript",
      {
        audio_url: "https://example.com/x.mp3",
        prompt: "Cardiology consultation.",
        keyterms_prompt: ["AssemblyAI", "Databricks"],
        language_code: "en_us",
        language_codes: ["en", "es"],
        language_detection: true,
        language_confidence_threshold: 0.6,
        temperature: 0.2,
        filter_profanity: true,
        speech_threshold: 0.5,
        content_safety: true,
        content_safety_confidence: 60,
        redact_pii_return_unredacted: true,
        multichannel: true,
        disfluencies: true,
        audio_start_from: 1000,
        audio_end_at: 9000,
        domain: "medical-v1",
        remove_audio_tags: "all",
        iab_categories: true,
        auto_highlights: true,
        webhook_url: "https://example.com/hook",
        webhook_auth_header_name: "X-Auth",
        webhook_auth_header_value: "secret",
      },
      "k"
    );
    const body = JSON.parse(calls[0]?.body ?? "{}");
    assert("16. prompt passes through", body.prompt === "Cardiology consultation.", JSON.stringify(body));
    assert(
      "16. keyterms_prompt passes through",
      JSON.stringify(body.keyterms_prompt) === JSON.stringify(["AssemblyAI", "Databricks"]),
      JSON.stringify(body)
    );
    assert(
      "16. language params pass through",
      body.language_code === "en_us" &&
        JSON.stringify(body.language_codes) === JSON.stringify(["en", "es"]) &&
        body.language_detection === true &&
        body.language_confidence_threshold === 0.6,
      JSON.stringify(body)
    );
    assert(
      "16. guardrail scalars pass through",
      body.filter_profanity === true &&
        body.speech_threshold === 0.5 &&
        body.content_safety === true &&
        body.content_safety_confidence === 60 &&
        body.redact_pii_return_unredacted === true,
      JSON.stringify(body)
    );
    assert(
      "16. other STT params pass through",
      body.multichannel === true &&
        body.disfluencies === true &&
        body.audio_start_from === 1000 &&
        body.audio_end_at === 9000 &&
        body.domain === "medical-v1" &&
        body.remove_audio_tags === "all" &&
        body.iab_categories === true &&
        body.auto_highlights === true &&
        body.temperature === 0.2,
      JSON.stringify(body)
    );
    assert(
      "16. webhook params pass through",
      body.webhook_url === "https://example.com/hook" &&
        body.webhook_auth_header_name === "X-Auth" &&
        body.webhook_auth_header_value === "secret",
      JSON.stringify(body)
    );
  });

  // 17. omitted params are NOT sent — bare submit payload is exactly audio_url + speech_models
  await withClientServer(async (client) => {
    resetMock([jsonResponse(200, { id: "txn-p2", status: "queued" })]);
    await callTool(client, "submit_transcript", { audio_url: "https://example.com/x.mp3" }, "k");
    const body = JSON.parse(calls[0]?.body ?? "{}");
    assert(
      "17. bare submit sends only audio_url + speech_models",
      JSON.stringify(Object.keys(body).sort()) === JSON.stringify(["audio_url", "speech_models"]),
      JSON.stringify(body)
    );
  });

  // 18. speech_models is overridable but defaults to the pinned list
  await withClientServer(async (client) => {
    resetMock([jsonResponse(200, { id: "txn-p3", status: "queued" })]);
    await callTool(
      client,
      "submit_transcript",
      { audio_url: "https://example.com/x.mp3", speech_models: ["universal-2"] },
      "k"
    );
    const body = JSON.parse(calls[0]?.body ?? "{}");
    assert(
      "18. explicit speech_models overrides the pin",
      JSON.stringify(body.speech_models) === JSON.stringify(["universal-2"]),
      JSON.stringify(body)
    );
  });

  // 19. nested objects pass through unchanged
  await withClientServer(async (client) => {
    resetMock([jsonResponse(200, { id: "txn-n1", status: "queued" })]);
    await callTool(
      client,
      "submit_transcript",
      {
        audio_url: "https://example.com/x.mp3",
        language_detection: true,
        language_detection_options: {
          expected_languages: ["en", "de"],
          fallback_language: "en",
          localization: ["en_uk"],
        },
        speaker_labels: true,
        speaker_options: { min_speakers_expected: 2, max_speakers_expected: 4 },
        redact_pii: true,
        redact_pii_audio: true,
        redact_pii_audio_options: { override_audio_redaction_method: "silence" },
        redact_static_entities: { INTERNAL_TOOL: ["Bearclaw"] },
        custom_spelling: [{ from: ["gothe"], to: "Goethe" }],
      },
      "k"
    );
    const body = JSON.parse(calls[0]?.body ?? "{}");
    assert(
      "19. language_detection_options passes through",
      JSON.stringify(body.language_detection_options) ===
        JSON.stringify({ expected_languages: ["en", "de"], fallback_language: "en", localization: ["en_uk"] }),
      JSON.stringify(body)
    );
    assert(
      "19. speaker_options passes through",
      JSON.stringify(body.speaker_options) === JSON.stringify({ min_speakers_expected: 2, max_speakers_expected: 4 }),
      JSON.stringify(body)
    );
    assert(
      "19. redact_pii_audio_options + static entities pass through",
      body.redact_pii_audio === true &&
        body.redact_pii_audio_options?.override_audio_redaction_method === "silence" &&
        JSON.stringify(body.redact_static_entities) === JSON.stringify({ INTERNAL_TOOL: ["Bearclaw"] }),
      JSON.stringify(body)
    );
    assert(
      "19. custom_spelling passes through",
      JSON.stringify(body.custom_spelling) === JSON.stringify([{ from: ["gothe"], to: "Goethe" }]),
      JSON.stringify(body)
    );
  });

  // 20. inline speech_understanding passes through with the request wrapper
  await withClientServer(async (client) => {
    resetMock([jsonResponse(200, { id: "txn-su", status: "queued" })]);
    await callTool(
      client,
      "submit_transcript",
      {
        audio_url: "https://example.com/x.mp3",
        speaker_labels: true,
        speech_understanding: {
          request: {
            translation: { target_languages: ["es"], formal: true },
            summarization: { summary_type: "bullets" },
            action_items: {},
          },
        },
      },
      "k"
    );
    const body = JSON.parse(calls[0]?.body ?? "{}");
    assert(
      "20. speech_understanding.request nests correctly",
      JSON.stringify(body.speech_understanding?.request?.translation) ===
        JSON.stringify({ target_languages: ["es"], formal: true }) &&
        body.speech_understanding?.request?.summarization?.summary_type === "bullets" &&
        JSON.stringify(body.speech_understanding?.request?.action_items) === "{}",
      JSON.stringify(body)
    );
  });

  // 21. speech_understanding without the request wrapper → schema error, no API call.
  // NOTE: zod violations are rejected at the MCP protocol layer (InvalidParams),
  // so client.callTool THROWS here rather than returning isError — catch both shapes.
  await withClientServer(async (client) => {
    resetMock([]);
    let rejected = false;
    try {
      const result = await callTool(
        client,
        "submit_transcript",
        {
          audio_url: "https://example.com/x.mp3",
          speech_understanding: { translation: { target_languages: ["es"] } },
        },
        "k"
      );
      rejected = result.isError === true;
    } catch {
      rejected = true;
    }
    assert(
      "21. missing request wrapper rejected before calling AssemblyAI",
      rejected && calls.length === 0,
      `rejected=${rejected} calls=${calls.length}`
    );
  });

  // 22. get_transcript renders translation / speaker_identification / custom_formatting
  await withClientServer(async (client) => {
    resetMock([
      jsonResponse(200, {
        id: "txn-su1",
        status: "completed",
        text: "hello",
        audio_duration: 5,
        translated_texts: { es: "hola mundo", de: "hallo welt" },
        speech_understanding: {
          response: {
            translation: { status: "success" },
            speaker_identification: { status: "success", mapping: { A: "Michel Martin" } },
            custom_formatting: { status: "success", formatted_text: "Call me at (555)123-4567" },
          },
        },
      }),
    ]);
    const result = await callTool(client, "get_transcript", { transcript_id: "txn-su1" }, "k");
    const text = result.content?.[0]?.text ?? "";
    assert(
      "22. translation sections per language",
      text.includes("--- translation:es ---") && text.includes("hola mundo") && text.includes("--- translation:de ---"),
      text
    );
    assert(
      "22. speaker_identification section",
      text.includes("--- speaker_identification") && text.includes("A → Michel Martin"),
      text
    );
    assert(
      "22. custom_formatting section",
      text.includes("--- custom_formatting") && text.includes("(555)123-4567"),
      text
    );
    assert(
      "22. structuredContent carries translated_texts + speech_understanding",
      (result.structuredContent?.translated_texts as Record<string, string>)?.es === "hola mundo" &&
        result.structuredContent?.speech_understanding !== undefined,
      JSON.stringify(result.structuredContent)
    );
  });

  // 23. get_transcript renders su_summary + action_items
  await withClientServer(async (client) => {
    resetMock([
      jsonResponse(200, {
        id: "txn-su2",
        status: "completed",
        text: "hello",
        audio_duration: 40,
        speech_understanding: {
          response: {
            summarization: {
              status: "success",
              summary_type: "paragraph",
              summary: [{ start: 240, end: 37100, text: "Wildfire smoke discussion.", headline: "Wildfire Smoke" }],
            },
            action_items: {
              status: "success",
              items: [{ action_item: "Check air quality daily.", quote: "check the air quality", timestamp: 9520 }],
            },
          },
        },
      }),
    ]);
    const result = await callTool(client, "get_transcript", { transcript_id: "txn-su2" }, "k");
    const text = result.content?.[0]?.text ?? "";
    assert(
      "23. su_summary section with headline + timestamps",
      text.includes("--- su_summary") && text.includes("Wildfire Smoke") && text.includes("0:00–0:37"),
      text
    );
    assert(
      "23. action_items section with quote + timestamp",
      text.includes("--- action_items ---") && text.includes("Check air quality daily.") && text.includes("0:09"),
      text
    );
  });

  // 24. get_transcript renders content_safety / topics / highlights / unredacted / warnings
  await withClientServer(async (client) => {
    resetMock([
      jsonResponse(200, {
        id: "txn-g1",
        status: "completed",
        text: "[PERSON_NAME] reported the fire.",
        audio_duration: 30,
        content_safety_labels: {
          summary: { disasters: 0.9 },
          severity_score_summary: { disasters: { low: 0.56, medium: 0.44, high: 0 } },
        },
        iab_categories_result: { summary: { "NewsAndPolitics>Weather": 0.99 } },
        auto_highlights_result: { results: [{ count: 3, rank: 0.08, text: "air quality" }] },
        unredacted_text: "Jane Doe reported the fire.",
        metadata: { domain_used: null, warnings: [{ message: "'ur' is not supported in universal-3-5-pro" }] },
      }),
    ]);
    const result = await callTool(client, "get_transcript", { transcript_id: "txn-g1" }, "k");
    const text = result.content?.[0]?.text ?? "";
    assert(
      "24. content_safety section with severity",
      text.includes("--- content_safety") && text.includes("disasters: 0.90") && text.includes("medium=0.44"),
      text
    );
    assert(
      "24. topics section",
      text.includes("--- topics") && text.includes("NewsAndPolitics>Weather: 0.99"),
      text
    );
    assert(
      "24. highlights section",
      text.includes("--- highlights") && text.includes('3× "air quality"'),
      text
    );
    assert(
      "24. unredacted_text section",
      text.includes("--- unredacted_text") && text.includes("Jane Doe reported the fire."),
      text
    );
    assert(
      "24. warnings section",
      text.includes("--- warnings") && text.includes("'ur' is not supported"),
      text
    );
    assert(
      "24. structuredContent gains guardrail fields",
      result.structuredContent?.content_safety_labels !== undefined &&
        result.structuredContent?.iab_categories_result !== undefined &&
        result.structuredContent?.auto_highlights_result !== undefined &&
        result.structuredContent?.unredacted_text === "Jane Doe reported the fire." &&
        result.structuredContent?.metadata !== undefined,
      JSON.stringify(result.structuredContent)
    );
  });

  // 25. redacted audio: second fetch when redact_pii_audio, graceful when not ready
  await withClientServer(async (client) => {
    resetMock([
      jsonResponse(200, { id: "txn-ra", status: "completed", text: "hi", audio_duration: 3, redact_pii_audio: true }),
      jsonResponse(200, { status: "redacted_audio_ready", redacted_audio_url: "https://cdn.example/redacted.mp3" }),
    ]);
    const result = await callTool(client, "get_transcript", { transcript_id: "txn-ra" }, "k");
    const text = result.content?.[0]?.text ?? "";
    assert(
      "25. fetches /redacted-audio when flag present",
      calls.length === 2 && (calls[1]?.url ?? "").endsWith("/v2/transcript/txn-ra/redacted-audio"),
      calls.map((c) => c.url).join(", ")
    );
    assert(
      "25. redacted_audio section with URL + expiry note",
      text.includes("--- redacted_audio ---") &&
        text.includes("https://cdn.example/redacted.mp3") &&
        text.includes("24 hours"),
      text
    );
    assert(
      "25. structuredContent carries redacted_audio_url",
      result.structuredContent?.redacted_audio_url === "https://cdn.example/redacted.mp3",
      JSON.stringify(result.structuredContent)
    );
  });
  await withClientServer(async (client) => {
    resetMock([
      jsonResponse(200, { id: "txn-rb", status: "completed", text: "hi", audio_duration: 3, redact_pii_audio: true }),
      jsonResponse(400, { error: "Redacted audio is not ready yet" }),
    ]);
    const result = await callTool(client, "get_transcript", { transcript_id: "txn-rb" }, "k");
    const text = result.content?.[0]?.text ?? "";
    assert(
      "25. not-ready redacted audio degrades gracefully (tool still succeeds)",
      result.isError !== true && text.includes("redacted audio not ready yet"),
      `isError=${result.isError} text=${text}`
    );
    assert(
      "25. structuredContent has no redacted_audio_url when fetch fails (400)",
      result.structuredContent?.redacted_audio_url === undefined,
      JSON.stringify(result.structuredContent)
    );
  });
  await withClientServer(async (client) => {
    resetMock([
      jsonResponse(200, { id: "txn-rc", status: "completed", text: "hi", audio_duration: 3, redact_pii_audio: true }),
      jsonResponse(200, { status: "redacted_audio_processing" }),
    ]);
    const result = await callTool(client, "get_transcript", { transcript_id: "txn-rc" }, "k");
    const text = result.content?.[0]?.text ?? "";
    assert(
      "25. 200 without redacted_audio_url still degrades gracefully",
      result.isError !== true && text.includes("redacted audio not ready yet"),
      `isError=${result.isError} text=${text}`
    );
    assert(
      "25. structuredContent has no redacted_audio_url when 200 without URL",
      result.structuredContent?.redacted_audio_url === undefined,
      JSON.stringify(result.structuredContent)
    );
  });

  // 26. understand_transcript posts to the Gateway /v1/understanding and renders results
  await withClientServer(async (client) => {
    resetMock([
      jsonResponse(200, {
        request_id: "req-1",
        translated_texts: { es: "hola" },
        speech_understanding: {
          response: {
            translation: { status: "success" },
            action_items: {
              status: "success",
              items: [{ action_item: "Send the report.", quote: "send the report", timestamp: 4000 }],
            },
          },
        },
      }),
    ]);
    const result = await callTool(
      client,
      "understand_transcript",
      {
        transcript_id: "txn-u1",
        speech_understanding: { request: { translation: { target_languages: ["es"] }, action_items: {} } },
      },
      "k"
    );
    assert(
      "26. posts to LLM Gateway /v1/understanding",
      (calls[0]?.url ?? "").includes("llm-gateway") && (calls[0]?.url ?? "").endsWith("/v1/understanding"),
      calls[0]?.url
    );
    const body = JSON.parse(calls[0]?.body ?? "{}");
    assert(
      "26. sends transcript_id + speech_understanding.request",
      body.transcript_id === "txn-u1" &&
        JSON.stringify(body.speech_understanding?.request?.translation) ===
          JSON.stringify({ target_languages: ["es"] }),
      JSON.stringify(body)
    );
    const text = result.content?.[0]?.text ?? "";
    assert(
      "26. renders translation + action_items sections",
      text.includes("--- translation:es ---") && text.includes("hola") && text.includes("Send the report."),
      text
    );
    assert(
      "26. structuredContent carries the raw response",
      (result.structuredContent?.translated_texts as Record<string, string>)?.es === "hola",
      JSON.stringify(result.structuredContent)
    );
  });

  // 27. understand_transcript 404 → friendly message
  await withClientServer(async (client) => {
    resetMock([jsonResponse(404, { error: "transcript not found" })]);
    const result = await callTool(
      client,
      "understand_transcript",
      { transcript_id: "missing", speech_understanding: { request: { action_items: {} } } },
      "k"
    );
    const text = (result.content?.[0]?.text ?? "").toLowerCase();
    assert(
      "27. 404 → not found / deleted message",
      result.isError === true && text.includes("not found or deleted"),
      `isError=${result.isError} text=${text}`
    );
  });

  // 27b. understand_transcript 401 → friendly bad-key error
  await withClientServer(async (client) => {
    resetMock([jsonResponse(401, { error: "Invalid API key" })]);
    const result = await callTool(
      client,
      "understand_transcript",
      { transcript_id: "txn-u1", speech_understanding: { request: { action_items: {} } } },
      "bad-key"
    );
    const text = result.content?.[0]?.text ?? "";
    assert(
      "27b. 401 → friendly bad-key error",
      result.isError === true && text.includes("AssemblyAI rejected the API key"),
      `isError=${result.isError} text=${text}`
    );
  });

  // 28. understand_transcript 429 → rate-limit message; summarize description points here
  await withClientServer(async (client) => {
    resetMock([jsonResponse(429, { error: "rate limit exceeded" })]);
    const result = await callTool(
      client,
      "understand_transcript",
      { transcript_id: "txn-u1", speech_understanding: { request: { action_items: {} } } },
      "k"
    );
    const text = (result.content?.[0]?.text ?? "").toLowerCase();
    assert(
      "28. 429 → rate limit message with retry hint",
      result.isError === true && text.includes("rate limit") && text.includes("retry"),
      `isError=${result.isError} text=${text}`
    );
    const tools = await client.listTools();
    const summarize = tools.tools.find((t) => t.name === "summarize_transcript");
    assert(
      "28. summarize_transcript description mentions understand_transcript",
      (summarize?.description ?? "").includes("understand_transcript"),
      summarize?.description
    );
  });

  globalThis.fetch = originalFetch;

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
