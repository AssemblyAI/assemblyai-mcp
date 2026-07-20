# Audio-Intelligence Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add audio-intelligence flags (`sentiment_analysis`, `entity_detection`, `redact_pii`) to `submit_transcript`, surface them in `get_transcript`, and add a `summarize_transcript` tool backed by AssemblyAI's LLM Gateway — all under an additive-only contract so future additions never require a Databricks connection re-test.

**Architecture:** The MCP server (Next.js + `mcp-handler`) wraps AssemblyAI's REST API via request-scoped pass-through Bearer auth. New transcript features are additive **optional** params on the existing tools; summaries move off the deprecated `summarization` transcript params onto LLM Gateway (`/v1/chat/completions`, stateless via `transcript_id` + a `{{ transcript }}` tag). All new behavior defaults off so existing calls are byte-identical.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk`, `zod`, native `fetch`. Tests run in-process via `npm test` (`tsx src/smoke-test.ts`) using `InMemoryTransport` + a mocked global `fetch`.

**Spec:** `docs/superpowers/specs/2026-05-29-audio-intelligence-tools-design.md`

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/assemblyai.ts` | REST wrapper: types, payload builder, retrying fetch | Modify: new submit options + response fields; export `requestWithRetry` with a `baseUrl` param; export `DEFAULT_REDACT_PII_POLICIES`; drop deprecated summarization params |
| `src/tools/submit-transcript.ts` | `submit_transcript` tool: inputs, validation, logging | Modify: new optional inputs; `summarization` becomes inert/redirect; forward new flags |
| `src/tools/get-transcript.ts` | `get_transcript` tool: shape + text formatting | Modify: add `--- sentiment ---` and `--- entities ---` sections |
| `src/llm-gateway.ts` | LLM Gateway wrapper (summaries; future Q&A/translate) | **Create** |
| `src/tools/summarize-transcript.ts` | `summarize_transcript` tool | **Create** |
| `src/server.ts` | tool registration factory | Modify: register the new tool |
| `src/smoke-test.ts` | in-process test harness | Modify: add tests 9–14 |
| `README.md` | docs | Modify: "Extending the tool surface" + new flags/tool |

---

## Task 1: Audio-intelligence flags on `submit_transcript`

Adds `sentiment_analysis`, `entity_detection`, `redact_pii` (+ `redact_pii_policies`, `redact_pii_sub`) as optional inputs, and makes the existing `summarization` flag inert (no more deprecated AssemblyAI params).

**Files:**
- Modify: `src/assemblyai.ts`
- Modify: `src/tools/submit-transcript.ts`
- Test: `src/smoke-test.ts`

- [ ] **Step 1: Write the failing tests**

Add these four blocks inside `run()` in `src/smoke-test.ts`, immediately before the line `globalThis.fetch = originalFetch;`:

```ts
  // 9. submit_transcript sentiment_analysis → payload flag + required speech_models
  await withClientServer(async (client) => {
    resetMock([jsonResponse(200, { id: "txn-s", status: "queued" })]);
    await callTool(
      client,
      "submit_transcript",
      { audio_url: "https://example.com/x.mp3", sentiment_analysis: true },
      "k"
    );
    const body = JSON.parse(calls[0].body ?? "{}");
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
    const body = JSON.parse(calls[0].body ?? "{}");
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
    const body = JSON.parse(calls[0].body ?? "{}");
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
    const body = JSON.parse(calls[0].body ?? "{}");
    assert(
      "12. no deprecated summarization params",
      body.summarization === undefined && body.summary_model === undefined && body.summary_type === undefined,
      JSON.stringify(body)
    );
  });
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npm test`
Expected: tests 1–8 still pass; tests **9, 10, 11 fail** (the new flags aren't in the zod schema yet, so they never reach the payload). Test 12 currently **fails** too (the existing code still sets `summarization`/`summary_model`/`summary_type`). Exit code non-zero.

- [ ] **Step 3: Update `src/assemblyai.ts` — submit options, payload builder, default policies**

Add the exported constant just below the `DEFAULT_BASE_URL` declaration near the top of the file:

```ts
/** PII categories redacted when redact_pii is enabled but no policies are given. */
export const DEFAULT_REDACT_PII_POLICIES = [
  "person_name",
  "phone_number",
  "email_address",
  "us_social_security_number",
  "credit_card_number",
];
```

Replace the `TranscriptSubmitOptions` interface with:

```ts
export interface TranscriptSubmitOptions {
  audio_url: string;
  speaker_labels?: boolean;
  sentiment_analysis?: boolean;
  entity_detection?: boolean;
  redact_pii?: boolean;
  redact_pii_policies?: string[];
  redact_pii_sub?: "entity_name" | "hash";
}
```

Replace the entire `submitTranscript` function with:

```ts
export async function submitTranscript(
  apiKey: string,
  options: TranscriptSubmitOptions
): Promise<TranscriptRecord> {
  const payload: Record<string, unknown> = { audio_url: options.audio_url };
  if (options.speaker_labels) payload.speaker_labels = true;
  if (options.sentiment_analysis) {
    payload.sentiment_analysis = true;
    // Sentiment Analysis requires the universal speech models.
    payload.speech_models = ["universal-3-pro", "universal-2"];
  }
  if (options.entity_detection) payload.entity_detection = true;
  if (options.redact_pii) {
    payload.redact_pii = true;
    payload.redact_pii_policies = options.redact_pii_policies ?? DEFAULT_REDACT_PII_POLICIES;
    payload.redact_pii_sub = options.redact_pii_sub ?? "entity_name";
  }
  return requestWithRetry<TranscriptRecord>(apiKey, "POST", "/v2/transcript", payload);
}
```

- [ ] **Step 4: Update `src/tools/submit-transcript.ts` — inputs + forwarding**

Replace the tool `description` string and `inputSchema` object in `registerTool` with:

```ts
      description:
        "Submit a public audio or video URL to AssemblyAI for transcription. " +
        "Returns immediately with a `transcript_id` and the current status (usually `queued`). " +
        "The caller MUST then call `get_transcript` with the returned id in a loop " +
        "(every ~3 seconds) until status becomes `completed` or `error`. " +
        "Do not expect the transcript text from this tool — only the id. " +
        "Enable `speaker_labels` whenever the user asks who said what or about speaker changes. " +
        "Enable `sentiment_analysis` for per-sentence positive/negative/neutral (English only), " +
        "`entity_detection` to extract named entities, and `redact_pii` to remove PII from the " +
        "transcript text. These features cannot be retro-fitted to a finished transcript — re-submit " +
        "with the flag set. For SUMMARIES do not set a flag here: after the transcript completes, " +
        "call the `summarize_transcript` tool.",
      inputSchema: {
        audio_url: z
          .string()
          .describe("Public http(s) URL to an audio or video file."),
        speaker_labels: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Enable speaker diarization. Required if the user wants to know who said what, " +
              "when speakers change, or per-speaker timestamps. Adds an `utterances` block " +
              "to the eventual get_transcript response with start/end times per speaker."
          ),
        sentiment_analysis: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Enable Sentiment Analysis. English audio only. Adds a per-sentence sentiment " +
              "(POSITIVE/NEUTRAL/NEGATIVE) with confidence and timestamps to the get_transcript response."
          ),
        entity_detection: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Enable Entity Detection. Extracts named entities (people, organizations, locations, " +
              "phone numbers, etc.) into the get_transcript response."
          ),
        redact_pii: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Enable PII redaction of the transcript text. Sensitive values are replaced before the " +
              "text is returned. Configure with redact_pii_policies and redact_pii_sub."
          ),
        redact_pii_policies: z
          .array(z.string())
          .optional()
          .describe(
            "Which PII categories to redact when redact_pii is true (e.g. person_name, phone_number, " +
              "email_address). Defaults to a common set if omitted."
          ),
        redact_pii_sub: z
          .enum(["entity_name", "hash"])
          .optional()
          .describe(
            "How redacted PII is substituted: 'entity_name' replaces with [PERSON_NAME] etc. (default), " +
              "'hash' replaces with #."
          ),
        summarization: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "DEPRECATED / no effect. Summaries are now produced by the `summarize_transcript` tool " +
              "after the transcript completes. Retained for compatibility only."
          ),
      },
```

Replace the `submitTranscript(...)` call in the handler (the `const record = await submitTranscript(...)` statement) with:

```ts
        const record = await submitTranscript(apiKey, {
          audio_url: args.audio_url,
          speaker_labels: args.speaker_labels,
          sentiment_analysis: args.sentiment_analysis,
          entity_detection: args.entity_detection,
          redact_pii: args.redact_pii,
          redact_pii_policies: args.redact_pii_policies,
          redact_pii_sub: args.redact_pii_sub,
        });
```

(Note: `args.summarization` is intentionally **not** forwarded — the flag is inert.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: all tests pass (1–12), `0 failed`.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/assemblyai.ts src/tools/submit-transcript.ts src/smoke-test.ts
git commit -m "feat: add sentiment/entity/PII-redaction flags to submit_transcript; retire deprecated summarization params"
```

---

## Task 2: Surface sentiment + entities in `get_transcript`

Adds the response fields and renders `--- sentiment ---` / `--- entities ---` sections in the text content (only when present).

**Files:**
- Modify: `src/assemblyai.ts`
- Modify: `src/tools/get-transcript.ts`
- Test: `src/smoke-test.ts`

- [ ] **Step 1: Write the failing test**

Add this block inside `run()` in `src/smoke-test.ts`, immediately before `globalThis.fetch = originalFetch;`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: test 13 **fails** (sections not rendered yet). Tests 1–12 still pass.

- [ ] **Step 3: Add response fields to `src/assemblyai.ts`**

Add these two fields to the `TranscriptRecord` interface (after the existing `error?: string;` field):

```ts
  sentiment_analysis_results?: Array<{
    text: string;
    sentiment: string;
    confidence: number;
    start: number;
    end: number;
    speaker: string | null;
  }>;
  entities?: Array<{ text: string; entity_type: string; start: number; end: number }>;
```

- [ ] **Step 4: Extend shaping + formatting in `src/tools/get-transcript.ts`**

Add these two fields to the `ShapedTranscript` interface (after `error?: string;`):

```ts
  sentiment?: Array<{ text: string; sentiment: string; confidence: number; start: number; end: number; speaker: string | null }>;
  entities?: Array<{ text: string; entity_type: string; start: number; end: number }>;
```

In `shape()`, add before the `return out;` line:

```ts
  if (record.sentiment_analysis_results && record.sentiment_analysis_results.length > 0)
    out.sentiment = record.sentiment_analysis_results;
  if (record.entities && record.entities.length > 0) out.entities = record.entities;
```

In `formatTranscript()`, insert these two blocks **after** the existing `--- utterances ---` block and **before** the `--- summary ---` block:

```ts
  if (s.sentiment && s.sentiment.length > 0) {
    lines.push("");
    lines.push("--- sentiment (per-sentence; start/end are mm:ss) ---");
    for (const r of s.sentiment) {
      const who = r.speaker ? ` (Speaker ${r.speaker})` : "";
      lines.push(`[${r.sentiment} ${r.confidence.toFixed(2)}] ${formatMs(r.start)}–${formatMs(r.end)}${who}: ${r.text}`);
    }
  }

  if (s.entities && s.entities.length > 0) {
    lines.push("");
    lines.push("--- entities ---");
    for (const e of s.entities) {
      lines.push(`${e.entity_type}: ${e.text}`);
    }
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: all tests pass (1–13), `0 failed`. (Test 5, the plain `completed` path with no sentiment/entities, must still pass — confirms sections only appear when present.)

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/assemblyai.ts src/tools/get-transcript.ts src/smoke-test.ts
git commit -m "feat: surface sentiment and entities in get_transcript output"
```

---

## Task 3: `summarize_transcript` tool via LLM Gateway

Adds a stateless summary tool backed by `llm-gateway.assemblyai.com`, reusing the existing retry/error machinery.

**Files:**
- Modify: `src/assemblyai.ts` (export `requestWithRetry`, add `baseUrl` param)
- Create: `src/llm-gateway.ts`
- Create: `src/tools/summarize-transcript.ts`
- Modify: `src/server.ts`
- Test: `src/smoke-test.ts`

- [ ] **Step 1: Write the failing test**

Add this block inside `run()` in `src/smoke-test.ts`, immediately before `globalThis.fetch = originalFetch;`:

```ts
  // 14. summarize_transcript calls LLM Gateway with transcript_id + {{ transcript }} tag
  await withClientServer(async (client) => {
    resetMock([jsonResponse(200, { choices: [{ message: { content: "- point one\n- point two" } }] })]);
    const result = await callTool(client, "summarize_transcript", { transcript_id: "txn-ai" }, "k");
    assert("14. posts to LLM Gateway host", (calls[0]?.url ?? "").includes("llm-gateway"), calls[0]?.url);
    const body = JSON.parse(calls[0].body ?? "{}");
    assert("14. sends transcript_id", body.transcript_id === "txn-ai", JSON.stringify(body));
    assert(
      "14. prompt includes {{ transcript }} tag",
      typeof body.messages?.[0]?.content === "string" && body.messages[0].content.includes("{{ transcript }}"),
      JSON.stringify(body)
    );
    const text = result.content?.[0]?.text ?? "";
    assert("14. returns summary content", text.includes("point one"), text);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: test 14 **fails** — the tool isn't registered yet, so `callTool` returns an error result (or the assert on host fails). Tests 1–13 still pass.

- [ ] **Step 3: Export `requestWithRetry` with a `baseUrl` param in `src/assemblyai.ts`**

Change the `requestWithRetry` signature and its `fetch` URL. Replace the function header line:

```ts
async function requestWithRetry<T>(
  apiKey: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  retries = 3
): Promise<T> {
```

with:

```ts
export async function requestWithRetry<T>(
  apiKey: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  retries = 3,
  baseUrl: string = DEFAULT_BASE_URL
): Promise<T> {
```

and replace the fetch target line `response = await fetch(\`${DEFAULT_BASE_URL}${path}\`, {` with:

```ts
      response = await fetch(`${baseUrl}${path}`, {
```

(Existing callers pass no `baseUrl`, so they keep hitting `DEFAULT_BASE_URL` — no behavior change.)

- [ ] **Step 4: Create `src/llm-gateway.ts`**

```ts
/**
 * AssemblyAI LLM Gateway wrapper. Used for summaries today (and, later, Q&A /
 * translation) so we stay off the deprecated transcript-level summarization
 * params. Same pass-through API key as the REST API; different host.
 *
 * Pass a `transcript_id` and include the `{{ transcript }}` tag in the prompt —
 * the Gateway substitutes the transcript's text server-side, so transcript text
 * never has to round-trip through this server.
 */
import { requestWithRetry } from "./assemblyai";

const DEFAULT_LLM_GATEWAY_BASE_URL =
  process.env.ASSEMBLYAI_LLM_GATEWAY_BASE_URL ?? "https://llm-gateway.assemblyai.com";

export const LLM_GATEWAY_MODEL = "claude-sonnet-4-6";

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

export interface SummarizeOptions {
  transcript_id: string;
  prompt: string;
  model?: string;
  maxTokens?: number;
}

export async function summarizeViaLlmGateway(
  apiKey: string,
  options: SummarizeOptions
): Promise<string> {
  const body = {
    model: options.model ?? LLM_GATEWAY_MODEL,
    messages: [{ role: "user", content: `${options.prompt}\n\n{{ transcript }}` }],
    transcript_id: options.transcript_id,
    max_tokens: options.maxTokens ?? 1000,
  };
  const data = await requestWithRetry<ChatCompletionResponse>(
    apiKey,
    "POST",
    "/v1/chat/completions",
    body,
    3,
    DEFAULT_LLM_GATEWAY_BASE_URL
  );
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("LLM Gateway returned no summary content.");
  }
  return content;
}
```

- [ ] **Step 5: Create `src/tools/summarize-transcript.ts`**

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { AssemblyAIError } from "../assemblyai";
import { summarizeViaLlmGateway, LLM_GATEWAY_MODEL } from "../llm-gateway";
import { log, logError, keyHash } from "../log";

const STYLE_PROMPTS: Record<string, string> = {
  bullets:
    "Provide a brief summary of the transcript in bullet-point format. Focus on the key points and main takeaways.",
  paragraph:
    "Provide a concise paragraph summary of the transcript. Capture the main topics and conclusions.",
  headline: "Provide a single-sentence headline that captures the main topic of the transcript.",
  action_items:
    "List the action items mentioned in the transcript as bullet points. If there are none, say so.",
};

export function registerSummarizeTranscript(server: McpServer): void {
  server.registerTool(
    "summarize_transcript",
    {
      title: "Summarize AssemblyAI Transcript",
      description:
        "Generate a summary of a COMPLETED transcript using AssemblyAI's LLM Gateway. " +
        "First submit_transcript, then poll get_transcript until status=completed, then call this " +
        "with the transcript_id. Choose a `style` or pass a `custom_prompt` for a tailored summary.",
      inputSchema: {
        transcript_id: z
          .string()
          .describe("The id of a completed transcript (from submit_transcript / get_transcript)."),
        style: z
          .enum(["bullets", "paragraph", "headline", "action_items", "custom"])
          .optional()
          .default("bullets")
          .describe("Summary style. Use 'custom' together with custom_prompt for a tailored summary."),
        custom_prompt: z
          .string()
          .optional()
          .describe("Instruction used when style='custom' (or to override the canned style prompt)."),
      },
    },
    async (args, extra) => {
      const start = Date.now();
      const apiKey = extra.authInfo?.token;
      if (!apiKey) {
        throw new Error(
          "No AssemblyAI API key in request context. Configure your AssemblyAI API key " +
            "as the Bearer token in the Databricks HTTP connection."
        );
      }

      const prompt = args.custom_prompt ?? STYLE_PROMPTS[args.style] ?? STYLE_PROMPTS.bullets;

      try {
        const summary = await summarizeViaLlmGateway(apiKey, {
          transcript_id: args.transcript_id,
          prompt,
        });
        log({
          event: "tool_call",
          tool: "summarize_transcript",
          keyHash: keyHash(apiKey),
          transcript_id: args.transcript_id,
          status: "success",
          latencyMs: Date.now() - start,
        });
        return {
          content: [{ type: "text" as const, text: summary }],
          structuredContent: {
            transcript_id: args.transcript_id,
            summary,
            style: args.style,
            model: LLM_GATEWAY_MODEL,
          },
        };
      } catch (err) {
        if (err instanceof AssemblyAIError && err.status === 401) {
          logError(
            {
              event: "assemblyai_rejected_key",
              tool: "summarize_transcript",
              keyHash: keyHash(apiKey),
              latencyMs: Date.now() - start,
              status: "error",
            },
            err
          );
          throw new Error(
            "AssemblyAI rejected the API key (401). " +
              "Check the Bearer token configured in the Databricks HTTP connection."
          );
        }
        if (err instanceof AssemblyAIError && err.status === 404) {
          logError(
            {
              event: "llm_gateway_error",
              tool: "summarize_transcript",
              keyHash: keyHash(apiKey),
              transcript_id: args.transcript_id,
              latencyMs: Date.now() - start,
              status: "error",
            },
            err
          );
          throw new Error(
            `LLM Gateway could not find transcript ${args.transcript_id} (404). ` +
              "Make sure it has completed and belongs to this API key."
          );
        }
        logError(
          {
            event: "llm_gateway_error",
            tool: "summarize_transcript",
            keyHash: keyHash(apiKey),
            transcript_id: args.transcript_id,
            latencyMs: Date.now() - start,
            status: "error",
          },
          err
        );
        throw err;
      }
    }
  );
}
```

- [ ] **Step 6: Register the tool in `src/server.ts`**

Replace the whole file with:

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerSubmitTranscript } from "./tools/submit-transcript";
import { registerGetTranscript } from "./tools/get-transcript";
import { registerSummarizeTranscript } from "./tools/summarize-transcript";

/** Wire all tools onto an MCP server instance. */
export function registerTools(server: McpServer): void {
  registerSubmitTranscript(server);
  registerGetTranscript(server);
  registerSummarizeTranscript(server);
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test`
Expected: all tests pass (1–14), `0 failed`.

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 9: Commit**

```bash
git add src/assemblyai.ts src/llm-gateway.ts src/tools/summarize-transcript.ts src/server.ts src/smoke-test.ts
git commit -m "feat: add summarize_transcript tool backed by LLM Gateway"
```

---

## Task 4: Documentation — extensibility contract + new surface

Documents the additive-only contract (the actual future-proofing deliverable) and the new flags/tool. No new tests; verify the suite is green.

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the Tools section of `README.md`**

Replace the `## Tools` list with:

```markdown
## Tools

- **`submit_transcript(audio_url, speaker_labels?, sentiment_analysis?, entity_detection?, redact_pii?, redact_pii_policies?, redact_pii_sub?)`** —
  submits a public URL to AssemblyAI and returns `{ transcript_id, status }`
  immediately. Optional flags enable speaker diarization, sentiment analysis
  (English only), entity detection, and PII redaction of the transcript text.
- **`get_transcript(transcript_id)`** — single fetch of the current state. The
  agent polls this (~every 3s) until `status` is `completed` or `error`. When
  enabled, the response text includes `--- sentiment ---` and `--- entities ---`
  sections alongside `--- text ---` and `--- utterances ---`.
- **`summarize_transcript(transcript_id, style?, custom_prompt?)`** — generates a
  summary of a completed transcript via AssemblyAI's LLM Gateway. Call after
  `get_transcript` shows `completed`. `style` is one of `bullets` (default),
  `paragraph`, `headline`, `action_items`, or `custom` (with `custom_prompt`).
```

- [ ] **Step 2: Add an "Extending the tool surface" section to `README.md`**

Insert this section immediately after the `## Auth: pass-through Bearer` section:

```markdown
## Extending the tool surface (additive-only contract)

Databricks discovers MCP tools at runtime (`list_tools`); the Unity Catalog
connection stores only URL + auth, not a tool-schema snapshot. So new tools and
new **optional** parameters appear automatically and need **no connection
re-test**. To keep that guarantee, all changes here are additive:

1. **Tool names are permanent** — only add tools, never rename or remove.
2. **New inputs are always optional**, with defaults that preserve current behavior.
3. **`get_transcript` text output only *gains* labeled sections** — existing
   sections (`--- text ---`, `--- utterances ---`, `--- sentiment ---`,
   `--- entities ---`, `--- summary ---`) are never renamed or reshaped, because
   Databricks AI Playground reads `content[].text`.
4. **`structuredContent` is additive only** — new fields, never removed/renamed.
5. **Avoid deprecated AssemblyAI transcript params** (`auto_chapters`,
   `summarization`, `summary_model`, `summary_type`); use LLM Gateway instead.
   Mirror AssemblyAI's official MCP tool shapes where they exist.
```

- [ ] **Step 3: Verify the full suite and typecheck are green**

Run: `npm test && npm run typecheck`
Expected: `14 passed, 0 failed` from the smoke test, then no typecheck output. Exit 0.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document additive-only contract and new audio-intelligence tools"
```

---

## Self-Review

**1. Spec coverage:**
- A (additive-only contract) → Task 4 Step 2 (README) + followed throughout.
- B sentiment / entity / redact_pii flags → Task 1 (submit) + Task 2 (get output for sentiment/entities). ✓
- `redact_pii_policies` / `redact_pii_sub` defaults → Task 1 Step 3 + test 11. ✓
- Drop deprecated summarization params → Task 1 Steps 3–4 + test 12. ✓
- `summarize_transcript` via LLM Gateway (stateless `transcript_id` + `{{ transcript }}`) → Task 3 + test 14. ✓
- `summarization` flag kept-but-inert → Task 1 Step 4 (zod param retained, not forwarded). ✓
- Out-of-scope items (redacted audio, auto_chapters, subtitles, Q&A/translate) → not implemented, by design. ✓
- Error handling (401/404) + logging → Task 3 Step 5. ✓
- Backward compatibility → existing tests 1/5/5b remain green (asserted in Task 1 Step 2, Task 2 Step 5). ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows complete code; every run step states the exact command + expected result.

**3. Type consistency:** `summarizeViaLlmGateway(apiKey, {transcript_id, prompt})` defined in Task 3 Step 4 and called identically in Step 5. `requestWithRetry` 6th param `baseUrl` defined in Step 3 and used by `llm-gateway.ts` in Step 4. `LLM_GATEWAY_MODEL` exported in Step 4, imported in Step 5. `DEFAULT_REDACT_PII_POLICIES` exported in Task 1 Step 3, used in the same `submitTranscript`. `ShapedTranscript.sentiment`/`.entities` (Task 2 Step 4) match the `TranscriptRecord.sentiment_analysis_results`/`.entities` source fields (Task 2 Step 3) via the explicit copy in `shape()`.
