
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { registerTools } from "./server";
import { log, logError, MAX_LOG_FIELD_CHARS, MAX_LOG_STACK_CHARS } from "./log";
import { MAX_BODY_BYTES, withJsonBodyCheck } from "./json-body";
import { renderSuSummary } from "./transcript-sections";

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  bytes: Uint8Array | null;
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
    const bytes = init?.body instanceof ArrayBuffer ? new Uint8Array(init.body.slice(0)) : null;
    const body = init?.body && !bytes ? String(init.body) : null;
    calls.push({ url, method, headers: captureHeaders(init), body, bytes });

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
  return (await client.callTool({
    name,
    arguments: args,
    _meta: { bearerForExtra },
  })) as ToolResult;
}

async function withClientServer<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const server = new McpServer({ name: "smoke", version: "0.0.0" });

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
      "2. the key reaches AssemblyAI as the raw Authorization header",
      calls[0]?.headers["authorization"] === "raw-key-no-prefix",
      `got: ${calls[0]?.headers["authorization"]}`
    );
    const body1 = JSON.parse(calls[0]?.body ?? "{}");
    assert(
      "1. every submission pins speech_models to assemblyai-stt-3-7 + universal-2",
      JSON.stringify(body1.speech_models) === JSON.stringify(["assemblyai-stt-3-7", "universal-2"]),
      JSON.stringify(body1)
    );
  });

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

  await withClientServer(async (client) => {
    resetMock([
      jsonResponse(200, {
        id: "txn-9",
        status: "completed",
        text: "hello world",
        speech_model_used: "assemblyai-stt-3-7",
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
      result.structuredContent?.speech_model_used === "assemblyai-stt-3-7"
    );
    const text5 = result.content?.[0]?.text ?? "";
    assert(
      "5. get_transcript text payload includes full transcript text",
      text5.includes("hello world"),
      `payload: ${text5}`
    );
    assert(
      "5. get_transcript text payload includes speech_model_used",
      text5.includes("speech_model_used=assemblyai-stt-3-7"),
      `payload: ${text5}`
    );
  });

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

  for (const languageFields of [
    { language_code: "es", language_confidence: 0.98, language_detection: true },
    { language_code: "en", language_confidence: 0, language_detection: false },
    {},
    { language_code: null, language_confidence: null, language_detection: null },
  ]) {
    await withClientServer(async (client) => {
      resetMock([jsonResponse(200, {
        id: "txn-language",
        status: "completed",
        text: "hello",
        ...languageFields,
      })]);
      const result = await callTool(client, "get_transcript", { transcript_id: "txn-language" }, "k");
      const text = result.content?.[0]?.text ?? "";
      for (const key of ["language_code", "language_confidence", "language_detection"] as const) {
        const value = languageFields[key];
        assert(
          `get_transcript preserves ${key}=${value} in structured and readable output`,
          value == null
            ? !(key in (result.structuredContent ?? {})) && !text.includes(`${key}=`)
            : result.structuredContent?.[key] === value && text.includes(`${key}=${value}`),
          JSON.stringify(result)
        );
      }
    });
  }

  await withClientServer(async (client) => {
    resetMock([jsonResponse(200, { id: "txn-2", status: "processing" })]);
    const result = await callTool(client, "get_transcript", { transcript_id: "txn-2" }, "k");
    assert(
      "6. get_transcript in-progress returns status without erroring",
      result.isError !== true && result.structuredContent?.status === "processing"
    );
  });

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
      "9. speech_models pinned to assemblyai-stt-3-7 + universal-2",
      JSON.stringify(body.speech_models) === JSON.stringify(["assemblyai-stt-3-7", "universal-2"]),
      JSON.stringify(body)
    );
  });

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

  await withClientServer(async (client) => {
    resetMock([jsonResponse(200, { id: "txn-p1", status: "queued" })]);
    await callTool(
      client,
      "submit_transcript",
      {
        audio_url: "https://example.com/x.mp3",
        prompt: "Cardiology consultation.",
        keyterms_prompt: ["AssemblyAI", "Universal-3"],
        language_code: "en_us",
        language_codes: ["en", "es"],
        language_detection: true,
        language_confidence_threshold: 0.6,
        temperature: 0.2,
        filter_profanity: true,
        speech_threshold: 0.5,
        content_safety: true,
        content_safety_confidence: 60,
        redact_pii: true,
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
      JSON.stringify(body.keyterms_prompt) === JSON.stringify(["AssemblyAI", "Universal-3"]),
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

  // zod violations are rejected at the MCP protocol layer, so callTool throws instead of returning isError.
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
              block_summary: "High-level summary of the wildfire smoke situation.",
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
      "23. su_block_summary section with executive overview",
      text.includes("--- su_block_summary ---") && text.includes("High-level summary of the wildfire smoke situation."),
      text
    );
    assert(
      "23. action_items section with quote + timestamp",
      text.includes("--- action_items ---") && text.includes("Check air quality daily.") && text.includes("0:09"),
      text
    );
  });

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
        auto_highlights_result: { results: [{ count: 1, rank: 0.12, text: "wildfire smoke" }, { count: 3, rank: 0.08, text: "air quality" }] },
        unredacted_text: "Jane Doe reported the fire.",
        metadata: { domain_used: null, warnings: [{ message: "'ur' is not supported in assemblyai-stt-3-7" }] },
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
      "24. highlights render most-relevant first",
      text.indexOf('1× "wildfire smoke"') >= 0 && text.indexOf('1× "wildfire smoke"') < text.indexOf('3× "air quality"'),
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

  await withClientServer(async (client) => {
    resetMock([
      jsonResponse(200, {
        id: "txn-g2",
        status: "completed",
        text: "hi",
        audio_duration: 3,
        metadata: { domain_used: null, warnings: ["Universal-3 Pro fallback"] },
      }),
    ]);
    const result = await callTool(client, "get_transcript", { transcript_id: "txn-g2" }, "k");
    const text = result.content?.[0]?.text ?? "";
    assert(
      "24b. warnings section renders string array without undefined",
      text.includes("--- warnings") && text.includes("- Universal-3 Pro fallback") && !text.includes("undefined"),
      text
    );
  });

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

  await withClientServer(async (client) => {
    resetMock([jsonResponse(200, { id: "txn-del", status: "completed" })]);
    const result = await callTool(client, "delete_transcript", { transcript_id: "txn-del" }, "k");
    assert(
      "29. DELETE to /v2/transcript/{id}",
      calls[0]?.method === "DELETE" && (calls[0]?.url ?? "").endsWith("/v2/transcript/txn-del"),
      `${calls[0]?.method} ${calls[0]?.url}`
    );
    assert(
      "29. returns deleted confirmation",
      result.isError !== true && result.structuredContent?.deleted === true &&
        result.structuredContent?.transcript_id === "txn-del",
      JSON.stringify(result.structuredContent)
    );
  });

  await withClientServer(async (client) => {
    resetMock([jsonResponse(404, { error: "not found" })]);
    const result = await callTool(client, "delete_transcript", { transcript_id: "gone" }, "k");
    const text = (result.content?.[0]?.text ?? "").toLowerCase();
    assert(
      "30. 404 → already deleted or not found message",
      result.isError === true && text.includes("already deleted or not found"),
      `isError=${result.isError} text=${text}`
    );
  });

  await withClientServer(async (client) => {
    resetMock([
      jsonResponse(200, {
        id: "txn-su3",
        status: "completed",
        text: "hello",
        audio_duration: 10,
        speech_understanding: {
          response: {
            custom_formatting: { status: "success", mapping: { "555 123 4567": "(555) 123-4567" } },
          },
        },
      }),
    ]);
    const result = await callTool(client, "get_transcript", { transcript_id: "txn-su3" }, "k");
    const text = result.content?.[0]?.text ?? "";
    assert(
      "31a. mapping-only custom_formatting renders original → formatted lines",
      text.includes("--- custom_formatting") && text.includes("555 123 4567 → (555) 123-4567"),
      text
    );
  });
  await withClientServer(async (client) => {
    resetMock([
      jsonResponse(200, {
        id: "txn-su4",
        status: "completed",
        text: "hello",
        audio_duration: 10,
        speech_understanding: { response: { speaker_identification: { status: "error" } } },
      }),
    ]);
    const result = await callTool(client, "get_transcript", { transcript_id: "txn-su4" }, "k");
    const text = result.content?.[0]?.text ?? "";
    assert(
      "31b. failed feature renders a visible (feature: status) marker",
      text.includes("(speaker_identification: error)"),
      text
    );
  });
  await withClientServer(async (client) => {
    resetMock([
      jsonResponse(200, {
        id: "txn-su5",
        status: "completed",
        text: "hello",
        audio_duration: 10,
        speech_understanding: { response: { action_items: { status: "success", items: [] } } },
      }),
    ]);
    const result = await callTool(client, "get_transcript", { transcript_id: "txn-su5" }, "k");
    const text = result.content?.[0]?.text ?? "";
    assert(
      "31c. empty action_items.items renders header + (none found)",
      text.includes("--- action_items ---") && text.includes("(none found)"),
      text
    );
  });

  await withClientServer(async (client) => {
    resetMock([
      jsonResponse(200, {
        id: "txn-su-ai",
        status: "completed",
        text: "meeting transcript",
        audio_duration: 60,
        speech_understanding: {
          response: {
            action_items: {
              status: "success",
              items: [
                {
                  action_item: "Full item",
                  quote: "We need this done",
                  timestamp: 12000,
                },
                {
                  action_item: "Quote only",
                  quote: "Just do it",
                },
                {
                  action_item: "Timestamp only",
                  timestamp: 30000,
                },
                {
                  action_item: "Bare item",
                },
              ],
            },
          },
        },
      }),
    ]);
    const result = await callTool(client, "get_transcript", { transcript_id: "txn-su-ai" }, "k");
    const text = result.content?.[0]?.text ?? "";
    assert(
      "31d. action items render quote and timestamp safely without undefined or NaN",
      text.includes("- Full item (quote: \"We need this done\" @ 0:12)") &&
        text.includes("- Quote only (quote: \"Just do it\")") &&
        text.includes("- Timestamp only (@ 0:30)") &&
        text.includes("- Bare item") &&
        !text.includes("undefined") &&
        !text.includes("NaN"),
      text
    );
  });

  await withClientServer(async (client) => {
    resetMock([]);
    const result = await callTool(
      client,
      "submit_transcript",
      { audio_url: "https://example.com/x.mp3", redact_pii_policies: ["person_name"] },
      "k"
    );
    const text = (result.content?.[0]?.text ?? "").toLowerCase();
    assert(
      "32. redact_pii_policies without redact_pii rejected before calling AssemblyAI",
      result.isError === true && text.includes("redact_pii: true") && calls.length === 0,
      `isError=${result.isError} text=${text} calls=${calls.length}`
    );
  });

  await withClientServer(async (client) => {
    for (const option of [
      { redact_pii_audio: true },
      { redact_pii_audio_quality: "wav" },
      { redact_pii_audio_options: { return_redacted_no_speech_audio: true } },
      { redact_pii_return_unredacted: true },
      { redact_static_entities: { INTERNAL: ["secret"] } },
      { redact_pii_sub: "hash" },
    ]) {
      resetMock([]);
      const res = await callTool(
        client,
        "submit_transcript",
        { audio_url: "https://example.com/x.mp3", ...option },
        "k"
      );
      const text = (res.content?.[0]?.text ?? "").toLowerCase();
      assert(
        `32b. ${Object.keys(option)[0]} without redact_pii rejected before calling AssemblyAI`,
        res.isError === true && text.includes("redact_pii: true") && calls.length === 0,
        `isError=${res.isError} text=${text} calls=${calls.length}`
      );
    }
    resetMock([jsonResponse(200, { id: "txn-pii", status: "queued" })]);
    const ok = await callTool(
      client,
      "submit_transcript",
      {
        audio_url: "https://example.com/x.mp3",
        redact_pii: true,
        redact_pii_audio: true,
        redact_static_entities: { INTERNAL: ["secret"] },
      },
      "k"
    );
    const sent = JSON.parse(calls[0]?.body ?? "{}") as Record<string, unknown>;
    assert(
      "32b. redact_pii_* options still pass through with redact_pii: true",
      ok.isError !== true &&
        sent.redact_pii === true &&
        sent.redact_pii_audio === true &&
        (sent.redact_static_entities as Record<string, string[]>)?.INTERNAL?.[0] === "secret",
      calls[0]?.body ?? "no call"
    );
  });

  await withClientServer(async (client) => {
    resetMock([jsonResponse(500, { error: "server error" })]);
    const result = await callTool(
      client,
      "understand_transcript",
      { transcript_id: "txn-u1", speech_understanding: { request: { action_items: {} } } },
      "k"
    );
    assert(
      "33. billable /v1/understanding is not retried on 5xx (exactly 1 call)",
      calls.length === 1 && result.isError === true,
      `calls=${calls.length} isError=${result.isError}`
    );
  });

  await withClientServer(async (client) => {
    resetMock([jsonResponse(200, { id: "txn-pf", status: "queued" })]);
    await callTool(
      client,
      "submit_transcript",
      { audio_url: "https://example.com/x.mp3", punctuate: false, format_text: false },
      "k"
    );
    const body = JSON.parse(calls[0]?.body ?? "{}");
    assert(
      "34. punctuate:false and format_text:false pass through explicitly",
      body.punctuate === false && body.format_text === false,
      JSON.stringify(body)
    );
  });

  await withClientServer(async (client) => {
    resetMock([]);
    let rejected = false;
    try {
      const result = await callTool(
        client,
        "submit_transcript",
        { audio_url: "https://example.com/x.mp3", speech_models: [] },
        "k"
      );
      rejected = result.isError === true;
    } catch {
      rejected = true;
    }
    assert(
      "35. speech_models: [] rejected before calling AssemblyAI",
      rejected && calls.length === 0,
      `rejected=${rejected} calls=${calls.length}`
    );
  });

  await withClientServer(async (client) => {
    resetMock([jsonResponse(500, { error: "server error" })]);
    const result = await callTool(client, "delete_transcript", { transcript_id: "txn-del2" }, "k");
    assert(
      "36. delete_transcript's DELETE is not retried on 5xx (exactly 1 call)",
      calls.length === 1 && result.isError === true,
      `calls=${calls.length} isError=${result.isError}`
    );
  });

  await withClientServer(async (client) => {
    resetMock([
      jsonResponse(200, { id: "txn-rd", status: "completed", text: "hi", audio_duration: 3, redact_pii_audio: true }),
      jsonResponse(502, { error: "bad gateway" }),
    ]);
    const result = await callTool(client, "get_transcript", { transcript_id: "txn-rd" }, "k");
    const text = result.content?.[0]?.text ?? "";
    assert(
      "37. redacted audio 5xx renders an unavailable note (not pending) and the tool still succeeds",
      result.isError !== true &&
        text.includes("redacted audio unavailable (HTTP 502)") &&
        result.structuredContent?.redacted_audio_error === "HTTP 502" &&
        result.structuredContent?.redacted_audio_pending === undefined,
      `isError=${result.isError} text=${text} structuredContent=${JSON.stringify(result.structuredContent)}`
    );
  });

  await withClientServer(async (client) => {
    resetMock([]);
    let rejected = false;
    try {
      const result = await callTool(
        client,
        "submit_transcript",
        {
          audio_url: "https://example.com/x.mp3",
          speech_understanding: {
            request: { action_items: {} },
            translation: { target_languages: ["es"] },
          },
        },
        "k"
      );
      rejected = result.isError === true;
    } catch {
      rejected = true;
    }
    assert(
      "38. misplaced feature key outside the request wrapper rejected (strict envelope)",
      rejected && calls.length === 0,
      `rejected=${rejected} calls=${calls.length}`
    );
  });

  await withClientServer(async (client) => {
    resetMock([
      jsonResponse(200, {
        id: "txn-tu",
        status: "completed",
        text: "hello",
        audio_duration: 5,
        utterances: [
          { speaker: "A", text: "hello", start: 0, end: 1200, translated_texts: { es: "hola" } },
          { speaker: "B", text: "hi", start: 1500, end: 2600 },
        ],
      }),
    ]);
    const result = await callTool(client, "get_transcript", { transcript_id: "txn-tu" }, "k");
    const text = result.content?.[0]?.text ?? "";
    assert(
      "39. translated_utterances section renders per-utterance translation",
      text.includes("--- translated_utterances") && text.includes("[A] 0:00–0:01 es: hola"),
      text
    );
  });

  await withClientServer(async (client) => {
    resetMock([
      jsonResponse(200, {
        id: "txn-nulls",
        status: "completed",
        text: "hello",
        audio_duration: 2,
        content_safety_labels: null,
        translated_texts: null,
      }),
    ]);
    const result = await callTool(client, "get_transcript", { transcript_id: "txn-nulls" }, "k");
    const text = result.content?.[0]?.text ?? "";
    assert(
      "40. explicit API nulls are dropped from structuredContent",
      result.structuredContent?.content_safety_labels === undefined &&
        result.structuredContent?.translated_texts === undefined,
      JSON.stringify(result.structuredContent)
    );
    assert(
      "40. no sections rendered for null fields",
      !text.includes("--- content_safety") && !text.includes("--- translation:"),
      text
    );
  });

  await withClientServer(async (client) => {
    resetMock([
      jsonResponse(200, {
        id: "txn-cs-null",
        status: "completed",
        text: "hi",
        audio_duration: 3,
        content_safety_labels: { summary: { disasters: null } },
      }),
    ]);
    const result = await callTool(client, "get_transcript", { transcript_id: "txn-cs-null" }, "k");
    const text = result.content?.[0]?.text ?? "";
    assert(
      "41. content_safety renders without throwing when a confidence value is non-numeric",
      result.isError !== true && text.includes("disasters: null"),
      text
    );
  });

  await withClientServer(async (client) => {
    resetMock([jsonResponse(429, { error: "rate limit exceeded" })]);
    const result = await callTool(client, "summarize_transcript", { transcript_id: "txn-ai" }, "k");
    const text = (result.content?.[0]?.text ?? "").toLowerCase();
    assert(
      "42. summarize_transcript 429 → rate limit message with retry hint",
      result.isError === true && text.includes("rate limit") && text.includes("retry"),
      `isError=${result.isError} text=${text}`
    );
  });

  await withClientServer(async (client) => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const t of tools) {
      const a = t.annotations ?? {};
      assert(
        `43. ${t.name} has a title and explicit boolean behavior hints`,
        Boolean(t.title) && [a.readOnlyHint, a.destructiveHint, a.openWorldHint].every((hint) => typeof hint === "boolean"),
        JSON.stringify({ title: t.title, annotations: t.annotations })
      );
    }
    assert(
      "43. delete_transcript is marked destructive",
      byName.delete_transcript?.annotations?.destructiveHint === true,
      JSON.stringify(byName.delete_transcript?.annotations)
    );
    assert(
      "43. get_transcript is read-only and explicitly non-destructive",
      byName.get_transcript?.annotations?.readOnlyHint === true && byName.get_transcript?.annotations?.destructiveHint === false,
      JSON.stringify(byName.get_transcript?.annotations)
    );
    // Billable LLM Gateway calls must not claim read-only, or clients run them without asking (issue #100).
    for (const name of ["summarize_transcript", "understand_transcript"]) {
      assert(
        `43. ${name} is not marked read-only, and not destructive`,
        byName[name]?.annotations?.readOnlyHint === false && byName[name]?.annotations?.destructiveHint === false,
        JSON.stringify(byName[name]?.annotations)
      );
    }
  });

  {
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      logError(
        { event: "scrub_check" },
        new Error(
          "HTTP 400: could not download https://bucket.example.com/call.mp3?sig=abc and " +
            `token ${"FAKETOKEN" + "x".repeat(24)} was rejected`
        )
      );
    } finally {
      console.log = originalLog;
    }
    const out = lines.join("\n");
    assert(
      "44. logError removes URLs and long tokens, keeps the HTTP status",
      !out.includes("bucket.example.com") && !out.includes("FAKETOKENxxxx") && out.includes("HTTP 400") && out.includes("[url]"),
      out
    );
  }

  delete process.env.UPLOAD_TOKEN_SECRET;
  await withClientServer(async (client) => {
    const { tools } = await client.listTools();
    assert(
      "45. create_upload_url is not offered without UPLOAD_TOKEN_SECRET",
      !tools.some((t) => t.name === "create_upload_url"),
      tools.map((t) => t.name).join(", ")
    );
    const submit = JSON.stringify(tools.find((t) => t.name === "submit_transcript"));
    assert(
      "45. submit_transcript (description and parameters) doesn't mention uploads when they aren't offered",
      !submit.includes("create_upload_url") && !submit.includes("/upload/"),
      submit
    );
  });

  process.env.UPLOAD_TOKEN_SECRET = "test-secret-" + "s".repeat(32);
  let uploadToken = "";
  await withClientServer(async (client) => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "create_upload_url");
    assert(
      "46. create_upload_url is offered, titled, not read-only and not destructive",
      Boolean(tool?.title) && tool?.annotations?.readOnlyHint === false && tool?.annotations?.destructiveHint === false,
      JSON.stringify(tool)
    );
    assert(
      "46. submit_transcript points local files at create_upload_url",
      tools.find((t) => t.name === "submit_transcript")?.description?.includes("create_upload_url") === true
    );
    resetMock([]);
    const res = await callTool(client, "create_upload_url", {}, "test-key");
    const url = String(res.structuredContent?.upload_link ?? "");
    uploadToken = url.split("/upload/")[1] ?? "";
    const text = res.content?.[0]?.text ?? "";
    assert(
      "46. link points at /upload/<token>, comes with a curl command, calls no API",
      !res.isError && url.startsWith("https://mcp.assemblyai.com/upload/") && text.includes("curl") && calls.length === 0,
      JSON.stringify(res)
    );
    assert("46. the link does not contain the API key", !url.includes("test-key"), url);
    assert(
      "46. the link is upload_link, not upload_url (that name is the printed AssemblyAI URL)",
      !("upload_url" in (res.structuredContent ?? {})),
      JSON.stringify(res.structuredContent)
    );
    assert(
      "46. the curl command single-quotes the link",
      String(res.structuredContent?.command ?? "").endsWith(`'${url}'`),
      String(res.structuredContent?.command)
    );
    assert(
      "46. the curl command works on curl < 7.76 (no --fail-with-body)",
      !String(res.structuredContent?.command ?? "").includes("--fail-with-body"),
      String(res.structuredContent?.command)
    );
  });

  {
    const { createUploadToken, readUploadToken, UPLOAD_TTL_MS } = await import("./upload-token");
    const now = Date.now();
    const { token } = createUploadToken("key-123", now);
    const tampered = token.slice(0, -2) + (token.endsWith("A") ? "BB" : "AA");
    assert("47. a fresh token yields the key", readUploadToken(token, now) === "key-123");
    assert("47. an expired token is refused", readUploadToken(token, now + UPLOAD_TTL_MS + 1) === undefined);
    assert("47. a tampered token is refused", readUploadToken(tampered, now) === undefined);
    assert("47. garbage is refused", readUploadToken("not-a-token", now) === undefined);
    process.env.UPLOAD_TOKEN_SECRET = "another-secret-" + "z".repeat(32);
    assert("47. a token from another secret is refused", readUploadToken(token, now) === undefined);
    process.env.UPLOAD_TOKEN_SECRET = "test-secret-" + "s".repeat(32);
  }

  {
    const { POST } = await import("../app/upload/[token]/route");
    const ctx = (token: string) => ({ params: Promise.resolve({ token }) });
    const body = new Uint8Array([1, 2, 3, 4]);

    resetMock([jsonResponse(200, { upload_url: "https://cdn.assemblyai.com/upload/abc" })]);
    const ok = await POST(new Request("https://mcp.assemblyai.com/upload/x", { method: "POST", body }), ctx(uploadToken));
    const okBody = (await ok.json()) as { upload_url?: string };
    assert(
      "48. upload forwards to /v2/upload with the raw key and returns upload_url",
      ok.status === 200 &&
        okBody.upload_url === "https://cdn.assemblyai.com/upload/abc" &&
        calls.length === 1 &&
        calls[0]?.url.endsWith("/v2/upload") === true &&
        calls[0]?.method === "POST" &&
        calls[0]?.headers.authorization === "test-key" &&
        calls[0]?.headers["content-type"] === "application/octet-stream" &&
        Array.from(calls[0]?.bytes ?? []).join() === "1,2,3,4",
      JSON.stringify({ status: ok.status, okBody, calls })
    );

    resetMock([]);
    const bad = await POST(new Request("https://mcp.assemblyai.com/upload/x", { method: "POST", body }), ctx("bogus"));
    assert("48. a bad token answers 401 without calling AssemblyAI", bad.status === 401 && calls.length === 0, String(bad.status));

    resetMock([]);
    const empty = await POST(new Request("https://mcp.assemblyai.com/upload/x", { method: "POST" }), ctx(uploadToken));
    assert("48. an empty body answers 400 without calling AssemblyAI", empty.status === 400 && calls.length === 0, String(empty.status));

    resetMock([jsonResponse(401, { error: "Invalid API key" })]);
    const rejected = await POST(new Request("https://mcp.assemblyai.com/upload/x", { method: "POST", body }), ctx(uploadToken));
    assert("48. AssemblyAI's 401 passes through as 401", rejected.status === 401, String(rejected.status));

    resetMock([jsonResponse(503, { error: "unavailable" })]);
    const down = await POST(new Request("https://mcp.assemblyai.com/upload/x", { method: "POST", body }), ctx(uploadToken));
    assert("48. AssemblyAI's 5xx answers 502", down.status === 502, String(down.status));

    const { MAX_UPLOAD_BYTES } = await import("./upload-token");
    resetMock([]);
    const declared = await POST(
      new Request("https://mcp.assemblyai.com/upload/x", {
        method: "POST",
        body,
        headers: { "Content-Length": String(MAX_UPLOAD_BYTES + 1) },
      }),
      ctx(uploadToken)
    );
    assert("48. a Content-Length over the limit answers 413 without calling AssemblyAI", declared.status === 413 && calls.length === 0, String(declared.status));

    resetMock([]);
    const chunk = new Uint8Array(1_000_000);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 20) return controller.close();
        sent++;
        controller.enqueue(chunk);
      },
    });
    const streamed = await POST(
      new Request("https://mcp.assemblyai.com/upload/x", { method: "POST", body: stream, duplex: "half" } as RequestInit),
      ctx(uploadToken)
    );
    assert(
      "48. a body without Content-Length that passes the limit answers 413 and stops reading",
      streamed.status === 413 && calls.length === 0 && sent < 20,
      JSON.stringify({ status: streamed.status, sent })
    );

    resetMock([
      () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      },
    ]);
    const hung = await POST(new Request("https://mcp.assemblyai.com/upload/x", { method: "POST", body }), ctx(uploadToken));
    assert("48. an upstream timeout answers 502", hung.status === 502, String(hung.status));

    resetMock([]);
    const abortedStream = new ReadableStream<Uint8Array>({
      pull() {
        throw new DOMException("The user aborted a request.", "AbortError");
      },
    });
    const aborted = await POST(
      new Request("https://mcp.assemblyai.com/upload/x", { method: "POST", body: abortedStream, duplex: "half" } as RequestInit),
      ctx(uploadToken)
    );
    assert("48. an aborted client stream answers 400", aborted.status === 400, String(aborted.status));

    delete process.env.UPLOAD_TOKEN_SECRET;
    resetMock([]);
    const off = await POST(new Request("https://mcp.assemblyai.com/upload/x", { method: "POST", body }), ctx(uploadToken));
    const offBody = await off.text();
    assert(
      "48. uploads turned off: 404, no mention of create_upload_url, nothing forwarded",
      off.status === 404 && !offBody.includes("create_upload_url") && calls.length === 0,
      `${off.status} ${offBody}`
    );
  }
  delete process.env.UPLOAD_TOKEN_SECRET;

  {
    const record = {
      id: "txn-w",
      status: "completed",
      text: "hello there.",
      utterances: [
        {
          speaker: "A",
          text: "hello there.",
          start: 0,
          end: 900,
          words: [
            { text: "hello", start: 0, end: 400, confidence: 0.9, speaker: "A" },
            { text: "there.", start: 450, end: 900, confidence: 0.9, speaker: "A" },
          ],
        },
      ],
    };
    await withClientServer(async (client) => {
      resetMock([jsonResponse(200, record), jsonResponse(200, record)]);
      const plain = await callTool(client, "get_transcript", { transcript_id: "txn-w" }, "k");
      const speakers = (plain.structuredContent as { speakers?: Array<Record<string, unknown>> }).speakers ?? [];
      const plainText = plain.content?.[0]?.text ?? "";
      assert(
        "49. by default, utterances keep text and timing but no words",
        speakers.length === 1 && speakers[0]?.text === "hello there." && !("words" in (speakers[0] ?? {})) && !plainText.includes("--- words"),
        JSON.stringify(plain.structuredContent)
      );
      const full = await callTool(client, "get_transcript", { transcript_id: "txn-w", include_words: true }, "k");
      const fullSpeakers = (full.structuredContent as { speakers?: Array<{ words?: unknown[] }> }).speakers ?? [];
      const fullText = full.content?.[0]?.text ?? "";
      assert(
        "49. include_words returns the words and renders a words section",
        fullSpeakers[0]?.words?.length === 2 && fullText.includes("--- words") && fullText.includes("[A] 450–900: there."),
        fullText
      );
    });
  }

  {
    const record = {
      id: "txn-nw",
      status: "completed",
      text: "hello there.",
      utterances: null,
      words: [
        { text: "hello", start: 0, end: 400, confidence: 0.9, speaker: null },
        { text: "there.", start: 450, end: 900, confidence: 0.9, speaker: null },
      ],
    };
    await withClientServer(async (client) => {
      resetMock([jsonResponse(200, record), jsonResponse(200, record)]);
      const plain = await callTool(client, "get_transcript", { transcript_id: "txn-nw" }, "k");
      assert(
        "50. without include_words, top-level words stay out",
        !("words" in (plain.structuredContent ?? {})) && !(plain.content?.[0]?.text ?? "").includes("--- words"),
        JSON.stringify(plain.structuredContent)
      );
      const full = await callTool(client, "get_transcript", { transcript_id: "txn-nw", include_words: true }, "k");
      const words = (full.structuredContent as { words?: unknown[] }).words ?? [];
      const fullText = full.content?.[0]?.text ?? "";
      assert(
        "50. include_words returns top-level words when speaker_labels is off",
        words.length === 2 && fullText.includes("--- words") && fullText.includes("450–900: there.") && !fullText.includes("[null]"),
        fullText
      );
    });
  }

  {
    const { publicOrigin } = await import("./origin");
    assert(
      "51. a multi-proxy x-forwarded-host uses the first host",
      publicOrigin("mcp.assemblyai.com, edge.internal", "edge.internal") === "https://mcp.assemblyai.com"
    );
    assert("51. falls back to host, then the production host", publicOrigin(undefined, "localhost:3000") === "http://localhost:3000" && publicOrigin(null, null) === "https://mcp.assemblyai.com");
    // localhost.example.com is not local: it gets https, and only when allowed.
    process.env.PUBLIC_HOSTS = "localhost.example.com";
    assert("51. localhost.example.com gets https", publicOrigin("localhost.example.com", null) === "https://localhost.example.com");
    delete process.env.PUBLIC_HOSTS;
    assert(
      "51. a host with shell or URL syntax falls back to production",
      publicOrigin("example.com$(printf injected >&2)", null) === "https://mcp.assemblyai.com" &&
        publicOrigin("evil.com/x?", null) === "https://mcp.assemblyai.com" &&
        publicOrigin(null, "a'b.com") === "https://mcp.assemblyai.com"
    );
    assert("51. local IPv6 and ports still work", publicOrigin(null, "[::1]:3000") === "http://[::1]:3000" && publicOrigin("127.0.0.1:3001", null) === "http://127.0.0.1:3001");
  }

  // 51b. A header can only pick among trusted hosts, and the result always parses (issue #74).
  {
    const { publicOrigin } = await import("./origin");
    const saved = { ...process.env };
    for (const k of ["PUBLIC_HOSTS", "VERCEL_URL", "VERCEL_BRANCH_URL", "VERCEL_PROJECT_PRODUCTION_URL"]) delete process.env[k];
    const prod = "https://mcp.assemblyai.com";
    assert(
      "51b. an unknown x-forwarded-host falls back to production",
      publicOrigin("evil.example", "mcp.assemblyai.com") === prod && publicOrigin("evil.example, mcp.assemblyai.com", null) === prod
    );
    for (const bad of ["example.com:99999", "[:::]", "999.999.999.999", "mcp.assemblyai.com:70000", "[zz::1]"]) {
      const origin = publicOrigin(bad, null);
      let parses = true;
      try {
        new URL(origin);
      } catch {
        parses = false;
      }
      assert(`51b. ${JSON.stringify(bad)} falls back to production and parses`, origin === prod && parses, origin);
    }
    process.env.VERCEL_URL = "assemblyai-mcp-abc123-assemblyai.vercel.app";
    process.env.VERCEL_BRANCH_URL = "assemblyai-mcp-git-fix-assemblyai.vercel.app";
    assert(
      "51b. the deployment's own Vercel hostnames are allowed",
      publicOrigin("assemblyai-mcp-abc123-assemblyai.vercel.app", null) === "https://assemblyai-mcp-abc123-assemblyai.vercel.app" &&
        publicOrigin(null, "Assemblyai-Mcp-Git-Fix-Assemblyai.vercel.app") === "https://assemblyai-mcp-git-fix-assemblyai.vercel.app"
    );
    assert("51b. another vercel.app host is not", publicOrigin("attacker.vercel.app", null) === prod);
    process.env.PUBLIC_HOSTS = " mcp.example.org , https://other.example.net/ ";
    assert(
      "51b. PUBLIC_HOSTS adds self-hosted domains (scheme, path and spaces ignored)",
      publicOrigin("mcp.example.org", null) === "https://mcp.example.org" &&
        publicOrigin("other.example.net:8443", null) === "https://other.example.net:8443"
    );
    assert("51b. IPv4 shorthand for loopback is normalized", publicOrigin("127.1:3000", null) === "http://127.0.0.1:3000");
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }

  await withClientServer(async (client) => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "submit_transcript");
    const schema = tool?.inputSchema as {
      required?: string[];
      properties?: Record<string, { type?: string; properties?: Record<string, unknown>; required?: string[] }>;
    };
    const file = schema?.properties?.file;
    assert(
      "52. submit_transcript lists file in _meta openai/fileParams",
      JSON.stringify(tool?._meta?.["openai/fileParams"]) === JSON.stringify(["file"]),
      JSON.stringify(tool?._meta)
    );
    assert(
      "52. file declares all four properties and requires only download_url and file_id",
      file?.type === "object" &&
        JSON.stringify(Object.keys(file.properties ?? {}).sort()) ===
          JSON.stringify(["download_url", "file_id", "file_name", "mime_type"]) &&
        JSON.stringify([...(file.required ?? [])].sort()) === JSON.stringify(["download_url", "file_id"]),
      JSON.stringify(file)
    );
    assert(
      "52. neither audio_url nor file is required by the schema",
      !(schema?.required ?? []).includes("audio_url") && !(schema?.required ?? []).includes("file"),
      JSON.stringify(schema?.required)
    );

    const download = "https://files.oaiusercontent.com/file-abc?sig=xyz";
    resetMock([jsonResponse(200, { id: "txn-file", status: "queued" })]);
    const ok = await callTool(
      client,
      "submit_transcript",
      { file: { download_url: download, file_id: "file-abc", mime_type: "audio/mpeg", file_name: "call.mp3" } },
      "k"
    );
    const sent = JSON.parse(calls[0]?.body ?? "{}");
    assert(
      "52. a ChatGPT file is submitted with its download_url as audio_url, and no file field",
      ok.isError !== true && ok.structuredContent?.transcript_id === "txn-file" && sent.audio_url === download && !("file" in sent),
      JSON.stringify({ ok, sent })
    );

    resetMock([jsonResponse(200, { id: "txn-file2", status: "queued" })]);
    const emptyUrl = await callTool(
      client,
      "submit_transcript",
      { audio_url: "", file: { download_url: download, file_id: "file-abc" } },
      "k"
    );
    assert(
      "52. an empty audio_url next to a file uses the file",
      emptyUrl.isError !== true && JSON.parse(calls[0]?.body ?? "{}").audio_url === download,
      JSON.stringify({ emptyUrl, calls })
    );

    resetMock([]);
    const both = await callTool(
      client,
      "submit_transcript",
      { audio_url: "https://example.com/x.mp3", file: { download_url: download, file_id: "file-abc" } },
      "k"
    );
    assert("52. audio_url and file together are refused without calling AssemblyAI", both.isError === true && calls.length === 0);

    resetMock([]);
    const neither = await callTool(client, "submit_transcript", {}, "k");
    assert(
      "52. no source at all is refused without calling AssemblyAI",
      neither.isError === true && calls.length === 0 && (neither.content?.[0]?.text ?? "").includes("audio_url"),
      JSON.stringify(neither)
    );

    resetMock([]);
    const badFile = await callTool(
      client,
      "submit_transcript",
      { file: { download_url: "file:///etc/passwd", file_id: "file-abc" } },
      "k"
    );
    assert("52. a file whose download_url is not http(s) is refused", badFile.isError === true && calls.length === 0);

    for (const [label, emptyFile] of [["null", null], ["{}", {}], ['{download_url: ""}', { download_url: "", file_id: "" }]] as const) {
      resetMock([jsonResponse(200, { id: "txn-empty", status: "queued" })]);
      const res = await callTool(client, "submit_transcript", { audio_url: "https://example.com/a.mp3", file: emptyFile }, "k");
      const sentBody = JSON.parse(calls[0]?.body ?? "{}");
      assert(
        `52. file: ${label} next to a public audio_url is ignored`,
        res.isError !== true && sentBody.audio_url === "https://example.com/a.mp3" && !("file" in sentBody),
        JSON.stringify(res)
      );
    }

    for (const [label, echo] of [["its file name", "call.mp3"], ["its download_url", download]] as const) {
      resetMock([jsonResponse(200, { id: "txn-echo", status: "queued" })]);
      const res = await callTool(
        client,
        "submit_transcript",
        { audio_url: echo, file: { download_url: download, file_id: "file-abc", file_name: "call.mp3" } },
        "k"
      );
      assert(
        `52. audio_url set to ${label} next to a file uses the file`,
        res.isError !== true && JSON.parse(calls[0]?.body ?? "{}").audio_url === download,
        JSON.stringify(res)
      );
    }

    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      resetMock([]);
      await callTool(client, "submit_transcript", {}, "k");
      await callTool(
        client,
        "submit_transcript",
        { audio_url: "https://example.com/x.mp3", file: { download_url: download, file_id: "file-abc" } },
        "k"
      );
      await callTool(client, "submit_transcript", { file: { download_url: "file:///etc/passwd", file_id: "f" } }, "k");
      await callTool(client, "submit_transcript", { file: null }, "k");
      await callTool(
        client,
        "submit_transcript",
        { file: { download_url: "file:///x", file_id: "f", _empty: "https://leak.example.com/secret?sig=1" } },
        "k"
      );
      await callTool(client, "submit_transcript", { file: { download_url: "", file_id: "f", _empty: "LEAK-2" } }, "k");
    } finally {
      console.log = originalLog;
    }
    const events = lines
      .map((l) => { try { return JSON.parse(l); } catch { return {}; } })
      .filter((e) => e.event === "bad_audio_url")
      .map((e) => `${e.sent}/${e.file_param}/${e.reason}`);
    assert(
      "52. bad_audio_url logs sent, file_param and reason (incl. an empty file from ChatGPT)",
      JSON.stringify(events) ===
        JSON.stringify([
          "none/absent/none",
          "both/set/conflict",
          "file/set/bad_url",
          "none/null/none",
          "file/set/bad_url",
          "none/no_download_url/none",
        ]),
      JSON.stringify(events)
    );
    assert(
      "52. a caller-supplied _empty value never reaches the logs",
      !lines.join("\n").includes("leak.example.com") && !lines.join("\n").includes("LEAK-2"),
      lines.filter((l) => l.includes("LEAK") || l.includes("leak")).join("\n")
    );
  });

  await withClientServer(async (client) => {
    resetMock([jsonResponse(500, { error: "server error" })]);
    const result = await callTool(
      client,
      "submit_transcript",
      { audio_url: "https://example.com/x.mp3" },
      "k"
    );
    assert(
      "53. billable POST /v2/transcript is not retried on 5xx (exactly 1 call)",
      calls.length === 1 && result.isError === true,
      `calls=${calls.length} isError=${result.isError}`
    );
  });

  await withClientServer(async (client) => {
    resetMock([jsonResponse(500, { error: "server error" })]);
    const result = await callTool(client, "summarize_transcript", { transcript_id: "txn-sum" }, "k");
    assert(
      "54. billable POST /v1/chat/completions is not retried on 5xx (exactly 1 call)",
      calls.length === 1 && result.isError === true,
      `calls=${calls.length} isError=${result.isError}`
    );
  });

  process.env.UPLOAD_TOKEN_SECRET = "test-secret-" + "s".repeat(32);
  await withClientServer(async (client) => {
    const link = "https://mcp.assemblyai.com/upload/tok-SECRET-abc123";
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (line: string) => lines.push(line);
    let res;
    try {
      resetMock([]);
      res = await callTool(client, "submit_transcript", { audio_url: link }, "k");
    } finally {
      console.log = originalLog;
    }
    const text = res.content?.[0]?.text ?? "";
    assert(
      "55. the /upload/<token> link is refused without calling AssemblyAI",
      res.isError === true && calls.length === 0 && text.includes("upload_url") && text.includes("curl"),
      JSON.stringify(res)
    );
    assert("55. the refusal does not echo the token", !text.includes("tok-SECRET-abc123"), text);
    assert(
      "55. the refusal is logged as reason upload_link, without the link",
      lines.some((l) => l.includes('"reason":"upload_link"')) && !lines.join("\n").includes("tok-SECRET"),
      lines.join("\n")
    );
    for (const [label, other] of [
      ["another host's /upload/ path", "https://example.com/upload/abc.mp3"],
      ["a deeper path on our host", "https://mcp.assemblyai.com/upload/abc/file.mp3"],
      ["the AssemblyAI CDN upload_url", "https://cdn.assemblyai.com/upload/abc-123"],
      ["an encoded path on another host", "https://example.com/upload%2Fabc.mp3"],
      ["an encoded deeper path on our host", "https://mcp.assemblyai.com/upload%2Fabc%2Ffile.mp3"],
    ]) {
      resetMock([jsonResponse(200, { id: "txn-ok", status: "queued" })]);
      const ok = await callTool(client, "submit_transcript", { audio_url: other }, "k");
      assert(`55. ${label} is still accepted`, ok.isError !== true && calls.length === 1, JSON.stringify(ok));
    }
    for (const [label, variant] of [
      ["trailing-dot host", "https://mcp.assemblyai.com./upload/tok-SECRET-abc123"],
      ["doubled leading slash", "https://mcp.assemblyai.com//upload/tok-SECRET-abc123"],
      ["empty path segment", "https://mcp.assemblyai.com/upload//tok-SECRET-abc123"],
      ["uppercase path", "https://mcp.assemblyai.com/UPLOAD/tok-SECRET-abc123"],
      ["explicit port", "https://mcp.assemblyai.com:8080/upload/tok-SECRET-abc123"],
      // Percent-encoded paths: new URL keeps them encoded, the router decodes them (issue #79).
      ["encoded slash", "https://mcp.assemblyai.com/upload%2Ftok-SECRET-abc123"],
      ["encoded letter", "https://mcp.assemblyai.com/uploa%64/tok-SECRET-abc123"],
      ["every slash encoded", "https://mcp.assemblyai.com/%2Fupload%2Ftok-SECRET-abc123"],
      ["double-encoded letter", "https://mcp.assemblyai.com/%2575pload/tok-SECRET-abc123"],
      ["encoded backslash", "https://mcp.assemblyai.com/upload%5Ctok-SECRET-abc123"],
      ["encoded dot segment", "https://mcp.assemblyai.com/x/%2e%2e/upload/tok-SECRET-abc123"],
      ["undecodable path", "https://mcp.assemblyai.com/upload/tok-SECRET-abc123%"],
      // Look-alike slashes (issue #107).
      ["fullwidth solidus", "https://mcp.assemblyai.com/upload\uFF0Ftok-SECRET-abc123"],
      ["encoded fullwidth solidus", "https://mcp.assemblyai.com/upload%EF%BC%8Ftok-SECRET-abc123"],
      ["fullwidth reverse solidus", "https://mcp.assemblyai.com/upload\uFF3Ctok-SECRET-abc123"],
      ["division slash", "https://mcp.assemblyai.com/upload\u2215tok-SECRET-abc123"],
      ["fraction slash", "https://mcp.assemblyai.com/upload\u2044tok-SECRET-abc123"],
      ["fullwidth letters", "https://mcp.assemblyai.com/\uFF55\uFF50\uFF4C\uFF4F\uFF41\uFF44/tok-SECRET-abc123"],
      // Normalizing creates a new escape after a decode round (PR #121 review).
      ["fullwidth percent escape", "https://mcp.assemblyai.com/upload\uFF052Ftok-SECRET-abc123"],
      ["fullwidth letters on an undecodable path", "https://mcp.assemblyai.com/\uFF55\uFF50\uFF4C\uFF4F\uFF41\uFF44\uFF0Ftok-SECRET-abc123%"],
      ["deeply stacked encoding", "https://mcp.assemblyai.com/upload%2525252525252Ftok-SECRET-abc123"],
    ]) {
      resetMock([]);
      const res = await callTool(client, "submit_transcript", { audio_url: variant }, "k");
      const variantText = res.content?.[0]?.text ?? "";
      assert(
        `55. the ${label} variant of the upload link is refused`,
        res.isError === true && calls.length === 0 && !variantText.includes("tok-SECRET"),
        `isError=${res.isError} calls=${calls.length} text=${variantText}`
      );
    }
    resetMock([]);
    const viaFile = await callTool(
      client,
      "submit_transcript",
      { file: { download_url: "https://mcp.assemblyai.com/upload/tok-SECRET-abc123", file_id: "x" } },
      "k"
    );
    assert(
      "55. the upload link passed via file.download_url is refused",
      viaFile.isError === true && calls.length === 0 && !(viaFile.content?.[0]?.text ?? "").includes("tok-SECRET"),
      `isError=${viaFile.isError} calls=${calls.length}`
    );
    resetMock([]);
    const viaFileLookalike = await callTool(
      client,
      "submit_transcript",
      { file: { download_url: "https://mcp.assemblyai.com/upload\uFF0Ftok-SECRET-abc123", file_id: "x" } },
      "k"
    );
    assert(
      "55. a fullwidth-slash upload link passed via file.download_url is refused",
      viaFileLookalike.isError === true &&
        calls.length === 0 &&
        !(viaFileLookalike.content?.[0]?.text ?? "").includes("tok-SECRET"),
      `isError=${viaFileLookalike.isError} calls=${calls.length}`
    );
  });

  await withClientServer(async (client) => {
    resetMock([]);
    const res = await callTool(client, "create_upload_url", {}, "k");
    const text = res.content?.[0]?.text ?? "";
    assert(
      "56. create_upload_url explains a blocked network: allow the host, public URL, or a local client",
      text.includes("Could not resolve host") && text.includes("mcp.assemblyai.com") &&
        text.includes("public URL") && text.includes("Claude Code") && text.includes("do not retry"),
      text
    );
  });

  {
    let reached = 0;
    const inner = async () => { reached++; return new Response("ok"); };
    const checked = withJsonBodyCheck(inner);
    const post = (body: string, type = "application/json") =>
      new Request("http://localhost/mcp", { method: "POST", headers: { "content-type": type }, body });
    const bad = await checked(post("not json"));
    const badBody = await bad.json();
    assert(
      "57. a non-JSON body gets 400 with JSON-RPC error -32700",
      bad.status === 400 && badBody?.error?.code === -32700 && badBody?.id === null && reached === 0,
      JSON.stringify(badBody)
    );
    const good = await checked(post('{"jsonrpc":"2.0","id":1,"method":"ping"}'));
    assert("57. a JSON body is passed on, still readable", good.status === 200 && reached === 1);
    await checked(post("not json", "text/plain"));
    await checked(new Request("http://localhost/mcp", { method: "GET" }));
    assert("57. other content types and GET are passed on unchanged", reached === 3);

    const big = "x".repeat(MAX_BODY_BYTES + 1);
    const declared = await checked(post(big));
    assert(
      "57. a body over the limit gets 413 before it reaches the handler",
      declared.status === 413 && (await declared.json())?.error?.code === -32000 && reached === 3
    );
    let pulled = 0;
    const chunk = new Uint8Array(1024 * 1024).fill(120);
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        if (pulled > 50) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const chunked = await checked(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: endless,
        duplex: "half",
      } as RequestInit)
    );
    assert(
      "57. a chunked body with no Content-Length stops being read once it passes the limit",
      chunked.status === 413 && pulled <= 8 && reached === 3,
      `status=${chunked.status} pulled=${pulled}`
    );
    const atLimit = await checked(post(JSON.stringify({ pad: "y".repeat(MAX_BODY_BYTES - 20) })));
    assert("57. a JSON body just under the limit is passed on", atLimit.status === 200 && reached === 4);
  }

  {
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      log({ event: "t", transcript_id: "x".repeat(100_000), nested: { v: "y".repeat(5_000) }, short: "ok" });
      const prose = "the audio file could not be read ".repeat(3_000);
      const err = new Error(prose);
      err.name = "Bad".repeat(1_000);
      logError({ event: "e", transcript_id: "z".repeat(100_000) }, err);
    } finally {
      console.log = originalLog;
    }
    const [first, second] = lines.map((l) => JSON.parse(l));
    assert(
      "58. long fields are cut to the limit with a count of dropped chars",
      first.transcript_id.length < MAX_LOG_FIELD_CHARS + 30 && first.transcript_id.endsWith("…[+99744 chars]") &&
        first.nested.v.length < MAX_LOG_FIELD_CHARS + 30 && first.short === "ok",
      JSON.stringify(first).slice(0, 300)
    );
    assert(
      "58. logError caps event fields, the error name, message and stack (long prose)",
      second.transcript_id.length < MAX_LOG_FIELD_CHARS + 30 && second.error.message.length < MAX_LOG_FIELD_CHARS + 30 &&
        second.error.name.length < MAX_LOG_FIELD_CHARS + 30 && second.error.stack.length < MAX_LOG_STACK_CHARS + 30 &&
        second.error.stack.includes("…[+"),
      JSON.stringify(second).slice(0, 300)
    );
    assert("58. a capped log line stays small", lines.every((l) => l.length < 5_000), String(lines.map((l) => l.length)));
  }

  await withClientServer(async (client) => {
    resetMock([jsonResponse(200, { id: "txn-59", status: "queued" })]);
    const result = await callTool(
      client,
      "submit_transcript",
      { audio_url: "https://example.com/x.mp3", speech_models: ["assemblyai-stt-3-7"] },
      "k"
    );
    assert(
      "59. speech_models: ['assemblyai-stt-3-7'] is accepted",
      result.isError !== true,
      JSON.stringify(result.content)
    );
    const body = JSON.parse(calls[0]?.body ?? "{}");
    assert(
      "59. assemblyai-stt-3-7 is sent to AssemblyAI unchanged",
      JSON.stringify(body.speech_models) === JSON.stringify(["assemblyai-stt-3-7"]),
      JSON.stringify(body)
    );
  });

  process.env.UPLOAD_TOKEN_SECRET = "test-secret-" + "s".repeat(32);
  await withClientServer(async (client) => {
    resetMock([]);
    const res = await callTool(client, "create_upload_url", {}, "k");
    const command = String(res.structuredContent?.command ?? "");
    const text = res.content?.[0]?.text ?? "";
    assert(
      "60. the curl command sends Content-Type: application/octet-stream",
      command.includes("-H 'Content-Type: application/octet-stream'") && text.includes(command),
      command
    );
    assert(
      "60. the guidance says what to do on \"Bad request\"",
      text.includes('"Bad request"') && text.includes("Content-Type"),
      text
    );
  });
  delete process.env.UPLOAD_TOKEN_SECRET;

  {
    const bulletLines = renderSuSummary([
      { start: 0, end: 280000, headline: "Wildfire smoke", bullets: ["- Smoke reaches the US.", "Air quality drops."] },
    ]);
    const bulletText = bulletLines.join("\n");
    assert(
      "61. bullets chapters render each bullet, never \"undefined\"",
      !bulletText.includes("undefined") &&
        bulletText.includes("[0:00–4:40] Wildfire smoke") &&
        bulletText.includes("  - Smoke reaches the US.") &&
        bulletText.includes("  - Air quality drops."),
      bulletText
    );
    const multiText = renderSuSummary([
      { start: 0, end: 1000, headline: "Multi", bullets: "- First\n- Second\r\n\n- Third" },
    ]).join("\n");
    assert(
      "61. a multiline bullet string renders each bullet indented under its chapter",
      multiText.includes("  - First\n  - Second\n  - Third") && !/\n- /.test(multiText),
      multiText
    );
    const paraText = renderSuSummary([{ start: 0, end: 60000, headline: "Intro", text: "A short intro." }]).join("\n");
    assert("61. paragraph chapters render as before", paraText.includes("[0:00–1:00] Intro — A short intro."), paraText);
    const emptyText = renderSuSummary([{ start: 0, end: 1000, headline: "Empty" }]).join("\n");
    assert("61. a chapter with no text or bullets renders the headline only", !emptyText.includes("undefined"), emptyText);
  }
  await withClientServer(async (client) => {
    resetMock([
      jsonResponse(200, {
        speech_understanding: {
          response: {
            summarization: {
              status: "success",
              summary_type: "bullets",
              summary: [{ start: 0, end: 5000, headline: "Topic", bullets: ["One point."] }],
            },
          },
        },
      }),
    ]);
    const res = await callTool(
      client,
      "understand_transcript",
      { transcript_id: "txn-b", speech_understanding: { request: { summarization: { summary_type: "bullets" } } } },
      "k"
    );
    const text = res.content?.[0]?.text ?? "";
    assert(
      "61. understand_transcript text shows the bullets",
      !res.isError && text.includes("  - One point.") && !text.includes("undefined"),
      text
    );
  });

  await withClientServer(async (client) => {
    resetMock([
      jsonResponse(400, {
        metadata: { errors: ["target_language 'klingon' is invalid"] },
        request_id: "r",
        message: "invalid request body",
        code: 400,
      }),
    ]);
    const logged: string[] = [];
    const originalLog = console.log;
    console.log = (line: string) => logged.push(String(line));
    let res: ToolResult;
    try {
      res = await callTool(
        client,
        "understand_transcript",
        { transcript_id: "txn-k", speech_understanding: { request: { translation: { target_languages: ["klingon"] } } } },
        "k"
      );
    } finally {
      console.log = originalLog;
    }
    const text = res.content?.[0]?.text ?? "";
    assert(
      "62. the error is logged, but without the metadata.errors reason (it can echo caller input)",
      logged.some((l) => l.includes("invalid request body")) && !logged.some((l) => l.includes("klingon")),
      logged.join("\n").slice(0, 500)
    );
    assert(
      "62. understand_transcript error includes the metadata.errors reason",
      res.isError === true && text.includes("invalid request body") && text.includes("target_language 'klingon' is invalid"),
      text
    );
  });
  await withClientServer(async (client) => {
    resetMock([
      jsonResponse(400, {
        metadata: { errors: ["one of messages or prompt required", "model nope is not supported"] },
        message: "invalid request body",
      }),
    ]);
    const res = await callTool(client, "summarize_transcript", { transcript_id: "txn-s" }, "k");
    const text = res.content?.[0]?.text ?? "";
    assert(
      "62. summarize_transcript error includes every metadata.errors reason",
      res.isError === true && text.includes("one of messages or prompt required") && text.includes("model nope is not supported"),
      text
    );
  });

  process.env.UPLOAD_TOKEN_SECRET = "test-secret-" + "s".repeat(32);
  await withClientServer(async (client) => {
    resetMock([]);
    const up = await callTool(client, "create_upload_url", {}, "k");
    const upNext = String(up.structuredContent?.next_step ?? "");
    assert(
      "63. create_upload_url next_step says to pass the printed upload_url to submit_transcript",
      upNext.includes("upload_url") && upNext.includes("submit_transcript") && upNext.includes("Bad request"),
      upNext
    );

    resetMock([jsonResponse(200, { id: "txn-n", status: "queued" })]);
    const sub = await callTool(client, "submit_transcript", { audio_url: "https://example.com/a.mp3" }, "k");
    assert(
      "63. submit_transcript next_step says to poll get_transcript",
      String(sub.structuredContent?.next_step ?? "").includes("get_transcript"),
      JSON.stringify(sub.structuredContent)
    );

    resetMock([jsonResponse(200, { id: "txn-n", status: "processing" })]);
    const pending = await callTool(client, "get_transcript", { transcript_id: "txn-n" }, "k");
    assert(
      "63. get_transcript while processing has a next_step",
      String(pending.structuredContent?.next_step ?? "").includes("get_transcript"),
      JSON.stringify(pending.structuredContent)
    );

    resetMock([jsonResponse(200, { id: "txn-n", status: "completed", text: "hi" })]);
    const done = await callTool(client, "get_transcript", { transcript_id: "txn-n" }, "k");
    assert(
      "63. a completed get_transcript has no next_step",
      !("next_step" in (done.structuredContent ?? {})),
      JSON.stringify(done.structuredContent)
    );
  });

  const badIds = ["..", ".", "a/b", "%2e%2e", "", "abc?x=1", "../upload"];
  await withClientServer(async (client) => {
    for (const tool of ["get_transcript", "delete_transcript", "understand_transcript", "summarize_transcript"]) {
      for (const id of badIds) {
        resetMock([jsonResponse(200, { id: "x", status: "completed", text: "hi" })]);
        const args: Record<string, unknown> = { transcript_id: id };
        if (tool === "understand_transcript") args.speech_understanding = { sentiment_analysis: true };
        if (tool === "summarize_transcript") args.style = "bullets";
        const r = await callTool(client, tool, args, "k");
        assert(
          `64. ${tool} refuses transcript_id ${JSON.stringify(id)} with no fetch`,
          r.isError === true && calls.length === 0,
          `isError=${r.isError} calls=${calls.map((c) => c.method + " " + c.url).join(", ")}`
        );
      }
    }
    resetMock([jsonResponse(200, { id: "5551722-f677-48a6-9287-39c0aafd9ac1", status: "completed", text: "hi" })]);
    const ok = await callTool(client, "get_transcript", { transcript_id: "5551722-f677-48a6-9287-39c0aafd9ac1" }, "k");
    assert(
      "64. a normal transcript id still works",
      ok.isError !== true && (calls[0]?.url ?? "").endsWith("/v2/transcript/5551722-f677-48a6-9287-39c0aafd9ac1"),
      JSON.stringify(ok.content)
    );
  });
  {
    const { getTranscript, deleteTranscript, getRedactedAudio } = await import("./assemblyai");
    for (const [name, fn] of [["getTranscript", getTranscript], ["deleteTranscript", deleteTranscript], ["getRedactedAudio", getRedactedAudio]] as const) {
      resetMock([jsonResponse(200, {})]);
      let threw = false;
      try {
        await fn("k", "..");
      } catch {
        threw = true;
      }
      assert(`64. ${name}("..") throws with no fetch`, threw && calls.length === 0);
    }
  }
  // #84. Precise timestamp evidence is additive to the existing summaries.
  await withClientServer(async (client) => {
    const id = "55517222-f677-48a6-9287-39c0aafd9ac1";
    const record = {
      id, status: "completed",
      entities: [
        { entity_type: "person_name", text: "Ada", start: 0, end: 250 },
        { entity_type: "location", text: "London", start: 61234, end: 62999 },
      ],
      auto_highlights_result: { results: [
        { text: "second", count: 1, rank: 1, timestamps: [{ start: 90000, end: 90500 }] },
        { text: "key phrase", count: 2, rank: 2, timestamps: [{ start: 0, end: 250 }, { start: 61234, end: 62999 }] },
      ] },
      content_safety_labels: {
        summary: { violence: 0.9 },
        results: [
          { text: "first segment", labels: [{ label: "violence", confidence: 0.9 }], timestamp: { start: 0, end: 250 } },
          { text: "second segment", labels: [{ label: "violence", confidence: 0.8 }], timestamp: { start: 61234, end: 62999 } },
        ],
      },
    };
    resetMock([jsonResponse(200, record)]);
    const result = await callTool(client, "get_transcript", { transcript_id: id }, "k");
    const text = result.content?.[0]?.text ?? "";
    assert("#84 legacy entities are unchanged", text.includes("--- entities ---\nperson_name: Ada\nlocation: London"));
    assert("#84 legacy highlights retain rank order and counts",
      text.includes('--- highlights (key phrases; count = occurrences) ---\n2× "key phrase"\n1× "second"'));
    assert("#84 legacy safety summary is unchanged",
      text.includes("--- content_safety (label: confidence 0–1) ---\nviolence: 0.90"));
    for (const [header, evidence] of [
      ["entity_evidence", [
        "person_name: Ada @ 0:00–0:00 (start=0ms end=250ms from audio start)",
        "location: London @ 1:01–1:02 (start=61234ms end=62999ms from audio start)",
      ]],
      ["highlight_evidence", [
        '"key phrase" @ 0:00–0:00 (start=0ms end=250ms from audio start)',
        '"key phrase" @ 1:01–1:02 (start=61234ms end=62999ms from audio start)',
        '"second" @ 1:30–1:30 (start=90000ms end=90500ms from audio start)',
      ]],
      ["content_safety_evidence", [
        "0:00–0:00 (start=0ms end=250ms from audio start) [violence: 0.90]: first segment",
        "1:01–1:02 (start=61234ms end=62999ms from audio start) [violence: 0.80]: second segment",
      ]],
    ] as const) {
      assert(`#84 ${header}: all precise ranges and labels render`,
        !result.isError && text.includes(`--- ${header} ---\n${evidence.join("\n")}`), text);
    }
    assert("#84 structured evidence is unchanged",
      ["entities", "auto_highlights_result", "content_safety_labels"].every((key) =>
        JSON.stringify(result.structuredContent?.[key]) === JSON.stringify(record[key as keyof typeof record])));

    for (const range of [undefined, null, {}, { start: 0 }, { start: "0", end: 250 },
      { start: -1, end: 250 }, { start: 250, end: 0 }, { start: null, end: 250 },
      { start: NaN, end: Infinity }]) {
      resetMock([jsonResponse(200, {
        id, status: "completed",
        entities: [{ entity_type: "person_name", text: "Ada", ...(range ?? {}) }],
        auto_highlights_result: { results: [{ count: 1, rank: 1, text: "key phrase", timestamps: [range] }] },
        content_safety_labels: { summary: { violence: 0.9 }, results: [{ text: "segment", timestamp: range }] },
      })]);
      const r = await callTool(client, "get_transcript", { transcript_id: id }, "k");
      const output = r.content?.[0]?.text ?? "";
      assert(`#84 malformed/absent range ${JSON.stringify(range)} is not fabricated`,
        !r.isError && !output.includes("_evidence ---") && !output.includes("NaN") &&
        output.includes("person_name: Ada") && output.includes('1× "key phrase"') && output.includes("violence: 0.90"));
    }
    for (const timestamps of [undefined, null, "invalid", [], [null, { start: 0, end: 0 }]]) {
      resetMock([jsonResponse(200, { id, status: "completed",
        auto_highlights_result: { results: [{ count: 1, rank: 1, text: "zero", timestamps }] },
        content_safety_labels: { results: [{ text: "zero segment", timestamp: { start: 0, end: 0 } }] },
      })]);
      const r = await callTool(client, "get_transcript", { transcript_id: id }, "k");
      const output = r.content?.[0]?.text ?? "";
      assert(`#84 timestamp collection ${JSON.stringify(timestamps)} is safe`,
        !r.isError && output.includes("content_safety_evidence") && !output.includes("--- content_safety (") &&
        output.includes("start=0ms end=0ms") &&
        output.includes("highlight_evidence") === (Array.isArray(timestamps) && timestamps.length > 0),
        output);
    }
  });

  // #83. Feature statuses must be visible to text-only clients.
  await withClientServer(async (client) => {
    const id = "55517222-f677-48a6-9287-39c0aafd9ac1";
    for (const status of ["unavailable", "error", "success", undefined]) {
      for (const populated of [false, true]) {
        const features = {
          content_safety_labels: { status, summary: populated ? { violence: 0.9 } : {} },
          iab_categories_result: { status, summary: populated ? { Technology: 0.8 } : {} },
          auto_highlights_result: { status, results: populated ? [{ count: 2, rank: 1, text: "key phrase" }] : [] },
        };
        resetMock([jsonResponse(200, { id, status: "completed", ...features })]);
        const result = await callTool(client, "get_transcript", { transcript_id: id }, "k");
        const text = result.content?.[0]?.text ?? "";
        for (const [feature, header, line] of [
          ["content_safety", "--- content_safety (label: confidence 0–1) ---", "violence: 0.90"],
          ["topics", "--- topics (IAB categories; relevance 0–1; top 10) ---", "Technology: 0.80"],
          ["highlights", "--- highlights (key phrases; count = occurrences) ---", '2× "key phrase"'],
        ] as const) {
          const unavailable = status !== undefined && status !== "success";
          assert(`#83 ${feature} ${status} populated=${populated}: correct text`,
            !result.isError && (unavailable ? text.includes(`(${feature}: ${status})`) && !text.includes(header)
              : populated ? text.includes(header + "\n" + line) && !text.includes(`(${feature}:`)
                : !text.includes(header) && !text.includes(`(${feature}:`)), text);
        }
        assert(`#83 ${status} populated=${populated}: structured data unchanged`,
          Object.entries(features).every(([key, value]) =>
            JSON.stringify(result.structuredContent?.[key]) === JSON.stringify(value)));
      }
    }
    for (const value of [undefined, null]) {
      resetMock([jsonResponse(200, { id, status: "completed", content_safety_labels: value,
        iab_categories_result: value, auto_highlights_result: value })]);
      const result = await callTool(client, "get_transcript", { transcript_id: id }, "k");
      assert(`#83 ${value}: absent features remain silent`,
        result.content?.[0]?.text === `status=completed transcript_id=${id}` &&
        !("content_safety_labels" in (result.structuredContent ?? {})) &&
        !("iab_categories_result" in (result.structuredContent ?? {})) &&
        !("auto_highlights_result" in (result.structuredContent ?? {})));
    }
  });

  // #82. The formatted utterance word gate applies through the real handler,
  // and must not mutate an API record reused by another caller.
  await withClientServer(async (client) => {
    const id = "55517222-f677-48a6-9287-39c0aafd9ac1";
    const words = Object.freeze([{ text: "Call", start: 0, end: 150, confidence: 0.99, speaker: "A" }]);
    const utterance = Object.freeze({ speaker: "A", text: "Call me", start: 0, end: 500, words, confidence: 0.98 });
    const source = Object.freeze({
      id, status: "completed", text: "Call me",
      metadata: { domain_used: "medical", warnings: [{ message: "note" }] },
      speech_understanding: Object.freeze({
        request: { custom_formatting: { formats: ["phone"] } }, extra: "preserve",
        response: Object.freeze({
          custom_formatting: Object.freeze({
            status: "success", formatted_text: "Call me", mapping: { call: "Call" },
            formatted_utterances: Object.freeze([utterance, Object.freeze({ speaker: "B", text: "Yes", start: 500, end: 600 })]),
          }),
          action_items: { status: "unavailable" },
        }),
      }),
    });
    const before = JSON.stringify(source);
    for (const includeWords of [undefined, false, true]) {
      // Return the exact frozen record, not a JSON clone, to detect mutation.
      resetMock([Object.assign(jsonResponse(200, source), { json: async () => source })]);
      const result = await callTool(client, "get_transcript", {
        transcript_id: id, ...(includeWords === undefined ? {} : { include_words: includeWords }),
      }, "k");
      const su = result.structuredContent?.speech_understanding as typeof source.speech_understanding;
      const formatting = su?.response.custom_formatting;
      assert(`#82 ${includeWords}: handler fetches valid UUID`, !result.isError && calls.length === 1);
      const first = formatting?.formatted_utterances[0];
      assert(`#82 ${includeWords}: nested words are opt-in`,
        includeWords === true ? !!first && "words" in first && JSON.stringify(first.words) === JSON.stringify(words)
          : !("words" in (formatting?.formatted_utterances[0] ?? {})));
      const expected = { ...utterance, words: undefined };
      assert(`#82 ${includeWords}: utterance fields survive`,
        JSON.stringify({ ...formatting?.formatted_utterances[0], words: undefined }) === JSON.stringify(expected));
      assert(`#82 ${includeWords}: request, status, mapping, other response and metadata survive`,
        JSON.stringify({ ...su, response: { ...su?.response, custom_formatting: { ...formatting, formatted_utterances: undefined } } }) ===
        JSON.stringify({ ...source.speech_understanding, response: { ...source.speech_understanding.response,
          custom_formatting: { ...source.speech_understanding.response.custom_formatting, formatted_utterances: undefined } } }) &&
        JSON.stringify(result.structuredContent?.metadata) === JSON.stringify(source.metadata));
      assert(`#82 ${includeWords}: API source is unchanged`, JSON.stringify(source) === before);
      assert(`#82 ${includeWords}: legacy formatting text survives`,
        (result.content?.[0]?.text ?? "").includes("[A] 0:00–0:00: Call me"));
    }
    for (const speech_understanding of [undefined, null, {}, { request: {} }, { response: {} },
      { response: { custom_formatting: { status: "success", formatted_utterances: [] } } }]) {
      resetMock([jsonResponse(200, { id, status: "completed", speech_understanding })]);
      const result = await callTool(client, "get_transcript", { transcript_id: id }, "k");
      assert(`#82 missing/empty SU ${JSON.stringify(speech_understanding)} is preserved`,
        !result.isError && JSON.stringify(result.structuredContent?.speech_understanding) === JSON.stringify(speech_understanding ?? undefined));
    }
  });
  delete process.env.UPLOAD_TOKEN_SECRET;
  // 65. a blank custom_prompt falls back to the style prompt instead of an empty instruction
  for (const blank of ["", "   "]) {
    await withClientServer(async (client) => {
      resetMock([jsonResponse(200, { choices: [{ message: { content: "- point" } }] })]);
      await callTool(
        client,
        "summarize_transcript",
        { transcript_id: "txn-ai", style: "headline", custom_prompt: blank },
        "k"
      );
      const content = JSON.parse(calls[0]?.body ?? "{}").messages?.[0]?.content ?? "";
      assert(
        `65. custom_prompt=${JSON.stringify(blank)} sends the headline style prompt`,
        content.startsWith("Provide a single-sentence headline") && content.includes("{{ transcript }}"),
        content
      );
    });
    await withClientServer(async (client) => {
      resetMock([]);
      const result = await callTool(
        client,
        "summarize_transcript",
        { transcript_id: "txn-ai", style: "custom", custom_prompt: blank },
        "k"
      );
      assert(
        `65. style=custom with custom_prompt=${JSON.stringify(blank)} errors before calling the gateway`,
        result.isError === true && calls.length === 0,
        `isError=${result.isError} calls=${calls.length}`
      );
    });
  }

  globalThis.fetch = originalFetch;

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
