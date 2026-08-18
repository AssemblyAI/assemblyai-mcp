# Async API Parity + Speech Understanding + Guardrails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand the MCP server to the full public `POST /v2/transcript` parameter surface, Speech Understanding (inline + post-hoc `understand_transcript`), Guardrails, and `delete_transcript`.

**Architecture:** API-shape pass-through — tool inputs use exact public AssemblyAI names/shapes; params are copied into the request payload only when provided. Two new tools (`understand_transcript`, `delete_transcript`) join the existing three. Section renderers are extracted to a shared module so `get_transcript` and `understand_transcript` format feature results identically.

**Tech Stack:** TypeScript, Next.js 16, `@modelcontextprotocol/sdk` 1.26, `mcp-handler`, zod 4.3.6, tsx (smoke/live tests are plain scripts, no test framework).

**Spec:** `docs/superpowers/specs/2026-08-11-api-parity-speech-understanding-guardrails-design.md`

## Global Constraints

- Additive-only contract (README "Extending the tool surface"): tool names permanent; new inputs always optional; existing text sections and `structuredContent` fields never renamed/reshaped; new text sections only added.
- New zod params use `.optional()` with **no `.default()`** — an omitted param must NOT appear in the AssemblyAI request payload ("omitted params are not sent").
- `speech_models` default stays pinned: `["universal-3-5-pro", "universal-2"]` on every submit unless the caller overrides.
- Param names/shapes 1:1 with the public API. Never expose internal-only params (spec "Out of scope" list) or deprecated params.
- Nested/open objects use `z.looseObject({...})` (zod 4) so unknown keys pass through — the API/Gateway is the validator of record; AssemblyAI 400s surface verbatim.
- Never log the raw API key, transcript text, or unredacted content — only `keyHash()`.
- Node 24.x. After every task: `npm test` and `npm run typecheck` must pass.
- All work on branch `feature/api-parity-speech-understanding-guardrails`.

---

### Task 1: `submit_transcript` scalar & boolean pass-through params

**Files:**
- Modify: `src/assemblyai.ts` (extend `TranscriptSubmitOptions`, add `PASSTHROUGH_KEYS` + generic copy, `speech_models` override)
- Modify: `src/tools/submit-transcript.ts` (new zod inputs; forward args)
- Test: `src/smoke-test.ts` (tests 16–18)

**Interfaces:**
- Consumes: existing `submitTranscript(apiKey, options)`, `requestWithRetry`.
- Produces: `TranscriptSubmitOptions` with all scalar/boolean fields below; `PASSTHROUGH_KEYS` mechanism that Task 2 extends with nested keys. Tool forwards args via `const { audio_url, summarization: _ignored, ...rest } = args`.

- [ ] **Step 1: Write failing smoke tests 16–18**

Append to `src/smoke-test.ts` before the `globalThis.fetch = originalFetch;` line (and add `16.–18.` to the header comment):

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: tests 16–18 FAIL (new params rejected/dropped by zod schema, so payload lacks them; 17 passes only if bare payload already minimal — it should PASS today; 16 & 18 must FAIL).

- [ ] **Step 3: Extend `TranscriptSubmitOptions` + payload builder in `src/assemblyai.ts`**

Replace the `TranscriptSubmitOptions` interface and `submitTranscript` with:

```ts
export interface TranscriptSubmitOptions {
  audio_url: string;
  // Established flags (behavior unchanged — sent only when true; redact_pii
  // applies the server's default policies/sub).
  speaker_labels?: boolean;
  sentiment_analysis?: boolean;
  entity_detection?: boolean;
  redact_pii?: boolean;
  redact_pii_policies?: string[];
  redact_pii_sub?: "entity_name" | "hash";
  // Prompting (Universal-3.5 Pro)
  prompt?: string;
  keyterms_prompt?: string[];
  // Language
  language_code?: string;
  language_codes?: string[];
  language_detection?: boolean;
  language_detection_options?: {
    expected_languages?: string[];
    fallback_language?: string;
    code_switching?: boolean;
    code_switching_confidence_threshold?: number;
    localization?: string[];
  };
  language_confidence_threshold?: number;
  // Models
  speech_models?: Array<"universal-3-5-pro" | "universal-2">;
  temperature?: number;
  // Diarization
  speaker_options?: { min_speakers_expected?: number; max_speakers_expected?: number };
  // Guardrails
  filter_profanity?: boolean;
  speech_threshold?: number;
  content_safety?: boolean;
  content_safety_confidence?: number;
  redact_pii_audio?: boolean;
  redact_pii_audio_quality?: "mp3" | "wav";
  redact_pii_audio_options?: {
    override_audio_redaction_method?: "silence";
    return_redacted_no_speech_audio?: boolean;
  };
  redact_pii_return_unredacted?: boolean;
  redact_static_entities?: Record<string, string[]>;
  // Speech Understanding (inline)
  speech_understanding?: { request: Record<string, unknown> };
  // Other STT
  multichannel?: boolean;
  disfluencies?: boolean;
  custom_spelling?: Array<{ from: string[]; to: string }>;
  audio_start_from?: number;
  audio_end_at?: number;
  domain?: string;
  remove_audio_tags?: "all" | "speaker";
  iab_categories?: boolean;
  auto_highlights?: boolean;
  // Webhooks (pass-through parity; agent flows should poll instead)
  webhook_url?: string;
  webhook_auth_header_name?: string;
  webhook_auth_header_value?: string;
}

/**
 * Params copied verbatim into the request body when defined. Additive-only:
 * append new public API params here; never add internal-only params (see the
 * 2026-08-11 design spec "Out of scope").
 */
const PASSTHROUGH_KEYS = [
  "prompt",
  "keyterms_prompt",
  "language_code",
  "language_codes",
  "language_detection",
  "language_detection_options",
  "language_confidence_threshold",
  "temperature",
  "speaker_options",
  "filter_profanity",
  "speech_threshold",
  "content_safety",
  "content_safety_confidence",
  "redact_pii_audio",
  "redact_pii_audio_quality",
  "redact_pii_audio_options",
  "redact_pii_return_unredacted",
  "redact_static_entities",
  "speech_understanding",
  "multichannel",
  "disfluencies",
  "custom_spelling",
  "audio_start_from",
  "audio_end_at",
  "domain",
  "remove_audio_tags",
  "iab_categories",
  "auto_highlights",
  "webhook_url",
  "webhook_auth_header_name",
  "webhook_auth_header_value",
] as const satisfies readonly (keyof TranscriptSubmitOptions)[];

export async function submitTranscript(
  apiKey: string,
  options: TranscriptSubmitOptions
): Promise<TranscriptRecord> {
  const payload: Record<string, unknown> = {
    audio_url: options.audio_url,
    // The v2 API only accepts universal-3-5-pro and universal-2. Pin the
    // priority list unless the caller overrides, so model selection doesn't
    // drift with API-side defaults.
    speech_models: options.speech_models ?? ["universal-3-5-pro", "universal-2"],
  };
  if (options.speaker_labels) payload.speaker_labels = true;
  if (options.sentiment_analysis) payload.sentiment_analysis = true;
  if (options.entity_detection) payload.entity_detection = true;
  if (options.redact_pii) {
    payload.redact_pii = true;
    payload.redact_pii_policies = options.redact_pii_policies ?? DEFAULT_REDACT_PII_POLICIES;
    payload.redact_pii_sub = options.redact_pii_sub ?? "entity_name";
  }
  for (const key of PASSTHROUGH_KEYS) {
    const value = options[key];
    if (value !== undefined) payload[key] = value;
  }
  return requestWithRetry<TranscriptRecord>(apiKey, "POST", "/v2/transcript", payload);
}
```

- [ ] **Step 4: Add the scalar/boolean zod inputs to `src/tools/submit-transcript.ts`**

Add to the `inputSchema` object (after the existing `summarization` entry). Nested-object params (`language_detection_options`, `speaker_options`, `redact_pii_audio_options`, `redact_static_entities`, `custom_spelling`, `speech_understanding`) are Task 2 — do NOT add them here.

```ts
        prompt: z
          .string()
          .optional()
          .describe(
            "Contextual DESCRIPTION of the audio (domain, scenario, or details — e.g. " +
              "'Cardiology consultation about chest pain'). Improves accuracy on Universal-3.5 Pro. " +
              "NOT instructions: formatting/behavioral commands are ignored."
          ),
        keyterms_prompt: z
          .array(z.string())
          .optional()
          .describe(
            "Names/brands/domain terms to boost recognition (exact spelling). " +
              "Up to 1000 terms on universal-3-5-pro, 200 on universal-2. Complementary with prompt."
          ),
        language_code: z
          .string()
          .optional()
          .describe("Language code of the audio (e.g. 'en_us', 'es', 'fr'). Defaults to en_us."),
        language_codes: z
          .array(z.string())
          .optional()
          .describe(
            "Languages for code-switching audio (must include 'en'), e.g. ['en','es']. universal-3-5-pro only."
          ),
        language_detection: z
          .boolean()
          .optional()
          .describe("Auto-detect the spoken language. Needs ≥15s of speech for reliable results."),
        language_confidence_threshold: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Fail transcription if detected-language confidence is below this (0–1)."),
        speech_models: z
          .array(z.enum(["universal-3-5-pro", "universal-2"]))
          .optional()
          .describe(
            "Priority-ordered model list; first supported model runs, falls back to next. " +
              "Default ['universal-3-5-pro','universal-2'] is right for almost all cases."
          ),
        temperature: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Sampling randomness 0–1. universal-3-5-pro only. Leave unset normally."),
        filter_profanity: z
          .boolean()
          .optional()
          .describe("Guardrail: replace profanity in the transcript text with asterisks."),
        speech_threshold: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe(
            "Guardrail: reject files whose spoken-audio fraction is below this (0–1); the transcript " +
              "then completes with an error message. Needs ≥30s of audio."
          ),
        content_safety: z
          .boolean()
          .optional()
          .describe(
            "Guardrail: detect sensitive content (hate speech, violence, drugs, …). Adds a " +
              "content_safety section to the get_transcript response."
          ),
        content_safety_confidence: z
          .number()
          .int()
          .min(25)
          .max(100)
          .optional()
          .describe("Confidence threshold (25–100, default 50) for content_safety labels."),
        redact_pii_audio: z
          .boolean()
          .optional()
          .describe(
            "Guardrail: also produce a redacted AUDIO file (PII beeped out). Retrieve the URL from " +
              "get_transcript once completed; the link expires after ~24h. Requires redact_pii=true."
          ),
        redact_pii_audio_quality: z
          .enum(["mp3", "wav"])
          .optional()
          .describe("Format of the redacted audio file (default mp3)."),
        redact_pii_return_unredacted: z
          .boolean()
          .optional()
          .describe(
            "Also return the ORIGINAL unredacted transcript alongside the redacted one. " +
              "Opts into receiving sensitive data — only set when the user explicitly needs it."
          ),
        multichannel: z
          .boolean()
          .optional()
          .describe("Transcribe each audio channel independently (speakers labeled '1A', '2A', …)."),
        disfluencies: z
          .boolean()
          .optional()
          .describe("Keep filler words ('um', 'uh') in the transcript."),
        audio_start_from: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Start transcribing at this offset, in milliseconds."),
        audio_end_at: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Stop transcribing at this offset, in milliseconds."),
        domain: z
          .string()
          .optional()
          .describe(
            "Domain add-on. 'medical-v1' enables Medical Mode (EN/ES/DE/FR only; separately billed; " +
              "silently skipped with a warning for other languages)."
          ),
        remove_audio_tags: z
          .enum(["all", "speaker"])
          .optional()
          .describe("Strip inline annotations: 'all' removes audio-event + speaker tags, 'speaker' only speaker cues."),
        iab_categories: z
          .boolean()
          .optional()
          .describe("Detect IAB topic categories. Adds a topics section to get_transcript."),
        auto_highlights: z
          .boolean()
          .optional()
          .describe("Extract key phrases. Adds a highlights section to get_transcript."),
        webhook_url: z
          .string()
          .optional()
          .describe(
            "URL AssemblyAI POSTs to when the transcript finishes. Most agent flows should poll " +
              "get_transcript instead — only set when the user runs their own webhook receiver."
          ),
        webhook_auth_header_name: z
          .string()
          .optional()
          .describe("Custom auth header name to send on the webhook request."),
        webhook_auth_header_value: z
          .string()
          .optional()
          .describe("Custom auth header value to send on the webhook request."),
```

Then replace the hand-built options object in the callback with a forward of everything except the inert `summarization` flag:

```ts
      const { audio_url, summarization: _ignored, ...rest } = args;
      try {
        const record = await submitTranscript(apiKey, { audio_url, ...rest });
```

(Keep the rest of the callback — logging, error mapping — unchanged. Note `_ignored` keeps the deprecated no-op flag out of the API payload; smoke test 12 guards this.)

- [ ] **Step 5: Run tests + typecheck**

Run: `npm test && npm run typecheck`
Expected: all tests PASS including 16–18 (and 1–15 unchanged — especially 12 and 17).

- [ ] **Step 6: Commit**

```bash
git add src/assemblyai.ts src/tools/submit-transcript.ts src/smoke-test.ts
git commit -m "feat: full scalar/boolean async submit param surface on submit_transcript"
```

---

### Task 2: `submit_transcript` nested params + Speech Understanding schema

**Files:**
- Create: `src/speech-understanding-schema.ts`
- Modify: `src/tools/submit-transcript.ts` (nested zod inputs)
- Test: `src/smoke-test.ts` (tests 19–21)

**Interfaces:**
- Consumes: `TranscriptSubmitOptions` + `PASSTHROUGH_KEYS` from Task 1 (nested keys are already in both — only the tool schema is missing).
- Produces: `speechUnderstandingSchema` (zod) — reused verbatim by Task 5's `understand_transcript`.

- [ ] **Step 1: Write failing smoke tests 19–21**

Append to `src/smoke-test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: 19–21 FAIL (params not in schema → stripped or rejected).

- [ ] **Step 3: Create `src/speech-understanding-schema.ts`**

```ts
import { z } from "zod";

/**
 * The speech_understanding object accepted by POST /v2/transcript (inline) and
 * POST /v1/understanding (post-hoc) — identical shape, per the 2026-08-11
 * design spec. Typed for the five known features but open to unknown keys
 * (z.looseObject): the public API treats this as a loose dict and the LLM
 * Gateway is the validator of record, so new API features flow through
 * without a server change.
 */
export const speechUnderstandingSchema = z.looseObject({
  request: z
    .looseObject({
      translation: z
        .looseObject({
          target_languages: z
            .array(z.string())
            .min(1)
            .describe("Language codes to translate into, e.g. ['es','de']."),
          formal: z.boolean().optional().describe("Use formal pronouns/grammar."),
          match_original_utterance: z
            .boolean()
            .optional()
            .describe("Add translated_texts to each utterance. Requires speaker_labels=true."),
          force_translation: z
            .boolean()
            .optional()
            .describe("Translate even when the detected source language equals a target."),
        })
        .optional()
        .describe("Translate the transcript into one or more languages."),
      speaker_identification: z
        .looseObject({
          speaker_type: z.enum(["name", "role"]).describe("Map diarization labels to real names or to roles."),
          known_values: z
            .array(z.string())
            .optional()
            .describe("Known names/roles (≤35 chars each). Use known_values OR speakers, not both."),
          speakers: z
            .array(
              z.looseObject({
                name: z.string().optional(),
                role: z.string().optional(),
                description: z.string().optional(),
              })
            )
            .optional()
            .describe(
              "Richer metadata per speaker; each entry needs name (speaker_type='name') or role " +
                "(speaker_type='role'); extra custom fields allowed."
            ),
        })
        .optional()
        .describe("Requires the transcript to have speaker_labels=true."),
      custom_formatting: z
        .looseObject({
          date: z.string().optional().describe("Date FORMAT PATTERN string, e.g. 'mm/dd/yyyy' — not a boolean."),
          phone_number: z.string().optional().describe("Phone format pattern, e.g. '(xxx)xxx-xxxx'."),
          email: z.string().optional().describe("Email format pattern, e.g. 'username@domain.com'."),
          format_utterances: z.boolean().optional().describe("Also format utterance-level text."),
        })
        .optional()
        .describe("Reformat dates/phone numbers/emails in the transcript."),
      summarization: z
        .looseObject({
          summary_type: z.enum(["paragraph", "bullets"]).describe("Chapter summary style."),
          effort: z
            .enum(["low", "medium"])
            .optional()
            .describe("'medium' = higher quality for long (1.5h+) or multilingual audio; default 'low'."),
        })
        .optional()
        .describe("Chaptered summary with timestamps and headlines."),
      action_items: z
        .looseObject({
          include_decisions: z.boolean().optional().describe("Also capture decisions made in the conversation."),
          effort: z.enum(["low", "medium"]).optional(),
        })
        .optional()
        .describe("Extract action items with source quote + timestamp. Pass {} for defaults."),
    })
    .describe("Feature requests. This 'request' wrapper is required by the API."),
});
```

- [ ] **Step 4: Add the nested zod inputs to `src/tools/submit-transcript.ts`**

Import the schema, then add to `inputSchema`:

```ts
import { speechUnderstandingSchema } from "../speech-understanding-schema";
```

```ts
        language_detection_options: z
          .looseObject({
            expected_languages: z.array(z.string()).optional().describe("Restrict detection to these codes."),
            fallback_language: z.string().optional().describe("Fallback code if detection fails."),
            code_switching: z.boolean().optional().describe("Detect language switches (universal-2 only)."),
            code_switching_confidence_threshold: z.number().min(0).max(1).optional(),
            localization: z
              .array(z.string())
              .optional()
              .describe("Regional English spelling: only 'en_au' and 'en_uk' accepted."),
          })
          .optional()
          .describe("Options refining language_detection."),
        speaker_options: z
          .looseObject({
            min_speakers_expected: z.number().int().min(1).optional(),
            max_speakers_expected: z.number().int().min(1).optional(),
          })
          .optional()
          .describe("Diarization hints; use with speaker_labels=true."),
        redact_pii_audio_options: z
          .looseObject({
            override_audio_redaction_method: z
              .enum(["silence"])
              .optional()
              .describe("Replace PII with silence instead of the default beep."),
            return_redacted_no_speech_audio: z
              .boolean()
              .optional()
              .describe("Also redact non-speech segments."),
          })
          .optional()
          .describe("Options for the redacted audio file (with redact_pii_audio=true)."),
        redact_static_entities: z
          .record(z.string(), z.array(z.string()))
          .optional()
          .describe(
            "Literal find-and-replace redaction on top of PII policies: label → exact terms, " +
              "e.g. {\"INTERNAL_TOOL\": [\"Bearclaw\"]}. Requires redact_pii=true."
          ),
        custom_spelling: z
          .array(
            z.object({
              from: z.array(z.string()).min(1).describe("Variants to replace (case-insensitive)."),
              to: z.string().describe("Replacement — single word, case-sensitive."),
            })
          )
          .optional()
          .describe("Spelling corrections applied to the transcript."),
        speech_understanding: speechUnderstandingSchema
          .optional()
          .describe(
            "Run Speech Understanding features (translation, speaker_identification, custom_formatting, " +
              "summarization, action_items) inline with transcription — results appear in get_transcript. " +
              "For an ALREADY-COMPLETED transcript use the understand_transcript tool instead of re-submitting."
          ),
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npm test && npm run typecheck`
Expected: all PASS, including 17 (bare payload still minimal) and 19–21.

- [ ] **Step 6: Commit**

```bash
git add src/speech-understanding-schema.ts src/tools/submit-transcript.ts src/smoke-test.ts
git commit -m "feat: nested submit params + inline speech_understanding on submit_transcript"
```

---

### Task 3: Section renderers module + `get_transcript` feature output

**Files:**
- Create: `src/transcript-sections.ts`
- Modify: `src/assemblyai.ts` (extend `TranscriptRecord`)
- Modify: `src/tools/get-transcript.ts` (shape + format additions; `formatMs` moves out)
- Test: `src/smoke-test.ts` (tests 22–24)

**Interfaces:**
- Consumes: `TranscriptRecord` from Task-1-era `assemblyai.ts`.
- Produces: `src/transcript-sections.ts` exporting `formatMs(ms: number): string`, `SpeechUnderstandingResponse` (type), `renderTranslations(t: Record<string,string>): string[]`, `renderSpeechUnderstanding(r: SpeechUnderstandingResponse): string[]`, `renderContentSafety`, `renderTopics`, `renderHighlights`, `renderUnredactedText`, `renderRedactedAudio(url: string): string[]`, `renderWarnings` — each returns lines starting with a blank line + `--- header ---`. Task 5 reuses `renderTranslations` + `renderSpeechUnderstanding`. Task 4 reuses `renderRedactedAudio`.

- [ ] **Step 1: Write failing smoke tests 22–24**

Append to `src/smoke-test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: 22–24 FAIL (sections not rendered, structuredContent fields missing).

- [ ] **Step 3: Create `src/transcript-sections.ts`**

```ts
/**
 * Shared renderers for the labeled text sections emitted by get_transcript
 * and understand_transcript. Databricks AI Playground reads only
 * content[].text, so every feature result must render as plain text here.
 * Section headers are contract (README "Extending the tool surface"): once
 * shipped, never rename or reshape a section — only add new ones.
 */

export interface SuChapter {
  start: number;
  end: number;
  text: string;
  headline: string;
}

export interface SuActionItem {
  action_item: string;
  quote: string;
  timestamp: number;
}

export interface SpeechUnderstandingResponse {
  translation?: { status?: string };
  speaker_identification?: { status?: string; mapping?: Record<string, string> };
  custom_formatting?: { status?: string; formatted_text?: string; mapping?: Record<string, string> };
  summarization?: { status?: string; summary_type?: string; effort?: string; summary?: SuChapter[] };
  action_items?: { status?: string; effort?: string; items?: SuActionItem[] };
}

export interface ContentSafetyLabels {
  summary?: Record<string, number>;
  severity_score_summary?: Record<string, { low?: number; medium?: number; high?: number }>;
}

export interface IabCategoriesResult {
  summary?: Record<string, number>;
}

export interface AutoHighlightsResult {
  results?: Array<{ count: number; rank: number; text: string }>;
}

export function formatMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function renderTranslations(translatedTexts: Record<string, string>): string[] {
  const lines: string[] = [];
  for (const [lang, text] of Object.entries(translatedTexts)) {
    lines.push("", `--- translation:${lang} ---`, text);
  }
  return lines;
}

export function renderSpeakerIdentification(mapping: Record<string, string>): string[] {
  const lines = ["", "--- speaker_identification (diarization label → identified speaker) ---"];
  for (const [label, who] of Object.entries(mapping)) lines.push(`${label} → ${who}`);
  return lines;
}

export function renderCustomFormatting(formattedText: string): string[] {
  return ["", "--- custom_formatting (transcript with requested formats applied) ---", formattedText];
}

export function renderSuSummary(chapters: SuChapter[]): string[] {
  const lines = ["", "--- su_summary (chaptered summary; start–end are m:ss) ---"];
  for (const c of chapters) lines.push(`[${formatMs(c.start)}–${formatMs(c.end)}] ${c.headline} — ${c.text}`);
  return lines;
}

export function renderActionItems(items: SuActionItem[]): string[] {
  const lines = ["", "--- action_items ---"];
  for (const i of items) lines.push(`- ${i.action_item} (quote: "${i.quote}" @ ${formatMs(i.timestamp)})`);
  return lines;
}

/** Renders every present feature of a speech_understanding.response object. */
export function renderSpeechUnderstanding(response: SpeechUnderstandingResponse): string[] {
  const lines: string[] = [];
  if (response.speaker_identification?.mapping && Object.keys(response.speaker_identification.mapping).length > 0) {
    lines.push(...renderSpeakerIdentification(response.speaker_identification.mapping));
  }
  if (response.custom_formatting?.formatted_text) {
    lines.push(...renderCustomFormatting(response.custom_formatting.formatted_text));
  }
  if (response.summarization?.summary && response.summarization.summary.length > 0) {
    lines.push(...renderSuSummary(response.summarization.summary));
  }
  if (response.action_items?.items && response.action_items.items.length > 0) {
    lines.push(...renderActionItems(response.action_items.items));
  }
  return lines;
}

export function renderContentSafety(labels: ContentSafetyLabels): string[] {
  const lines = ["", "--- content_safety (label: confidence 0–1) ---"];
  for (const [label, confidence] of Object.entries(labels.summary ?? {})) {
    const sev = labels.severity_score_summary?.[label];
    const sevText = sev
      ? ` (severity low=${sev.low ?? 0} medium=${sev.medium ?? 0} high=${sev.high ?? 0})`
      : "";
    lines.push(`${label}: ${confidence.toFixed(2)}${sevText}`);
  }
  return lines;
}

export function renderTopics(result: IabCategoriesResult): string[] {
  const lines = ["", "--- topics (IAB categories; relevance 0–1; top 10) ---"];
  const entries = Object.entries(result.summary ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  for (const [topic, relevance] of entries) lines.push(`${topic}: ${relevance.toFixed(2)}`);
  return lines;
}

export function renderHighlights(result: AutoHighlightsResult): string[] {
  const lines = ["", "--- highlights (key phrases; count = occurrences) ---"];
  const results = [...(result.results ?? [])].sort((a, b) => a.rank - b.rank);
  for (const r of results) lines.push(`${r.count}× "${r.text}"`);
  return lines;
}

export function renderUnredactedText(text: string): string[] {
  return ["", "--- unredacted_text (returned because redact_pii_return_unredacted was set) ---", text];
}

export function renderRedactedAudio(url: string): string[] {
  return ["", "--- redacted_audio ---", url, "(link expires ~24 hours after transcription)"];
}

export function renderWarnings(warnings: Array<{ message: string }>): string[] {
  const lines = ["", "--- warnings (processing notes from AssemblyAI) ---"];
  for (const w of warnings) lines.push(`- ${w.message}`);
  return lines;
}
```

- [ ] **Step 4: Extend `TranscriptRecord` in `src/assemblyai.ts`**

Add the import at the top and the new optional fields to `TranscriptRecord`:

```ts
import type {
  SpeechUnderstandingResponse,
  ContentSafetyLabels,
  IabCategoriesResult,
  AutoHighlightsResult,
} from "./transcript-sections";
```

```ts
  // Appended to TranscriptRecord (all optional — additive contract):
  translated_texts?: Record<string, string>;
  speech_understanding?: { request?: unknown; response?: SpeechUnderstandingResponse };
  content_safety_labels?: ContentSafetyLabels;
  iab_categories_result?: IabCategoriesResult;
  auto_highlights_result?: AutoHighlightsResult;
  unredacted_text?: string;
  /** Echo of the request param — signals a redacted audio file exists. */
  redact_pii_audio?: boolean;
  metadata?: { domain_used?: string | null; warnings?: Array<{ message: string }> };
```

- [ ] **Step 5: Extend `shape()`/`formatTranscript()` in `src/tools/get-transcript.ts`**

Delete the local `formatMs` function; import renderers instead:

```ts
import {
  formatMs,
  renderTranslations,
  renderSpeechUnderstanding,
  renderContentSafety,
  renderTopics,
  renderHighlights,
  renderUnredactedText,
  renderWarnings,
  type SpeechUnderstandingResponse,
  type ContentSafetyLabels,
  type IabCategoriesResult,
  type AutoHighlightsResult,
} from "../transcript-sections";
```

Add to `ShapedTranscript`:

```ts
  translated_texts?: Record<string, string>;
  speech_understanding?: { request?: unknown; response?: SpeechUnderstandingResponse };
  content_safety_labels?: ContentSafetyLabels;
  iab_categories_result?: IabCategoriesResult;
  auto_highlights_result?: AutoHighlightsResult;
  unredacted_text?: string;
  metadata?: { domain_used?: string | null; warnings?: Array<{ message: string }> };
```

Add to `shape()` (before `return out;`):

```ts
  if (record.translated_texts !== undefined) out.translated_texts = record.translated_texts;
  if (record.speech_understanding !== undefined) out.speech_understanding = record.speech_understanding;
  if (record.content_safety_labels !== undefined) out.content_safety_labels = record.content_safety_labels;
  if (record.iab_categories_result !== undefined) out.iab_categories_result = record.iab_categories_result;
  if (record.auto_highlights_result !== undefined) out.auto_highlights_result = record.auto_highlights_result;
  if (record.unredacted_text !== undefined) out.unredacted_text = record.unredacted_text;
  if (record.metadata !== undefined) out.metadata = record.metadata;
```

Add to `formatTranscript()` after the existing `if (s.summary) {...}` block, before `return lines.join("\n");`:

```ts
  if (s.translated_texts && Object.keys(s.translated_texts).length > 0) {
    lines.push(...renderTranslations(s.translated_texts));
  }
  if (s.speech_understanding?.response) {
    lines.push(...renderSpeechUnderstanding(s.speech_understanding.response));
  }
  if (s.content_safety_labels?.summary && Object.keys(s.content_safety_labels.summary).length > 0) {
    lines.push(...renderContentSafety(s.content_safety_labels));
  }
  if (s.iab_categories_result?.summary && Object.keys(s.iab_categories_result.summary).length > 0) {
    lines.push(...renderTopics(s.iab_categories_result));
  }
  if (s.auto_highlights_result?.results && s.auto_highlights_result.results.length > 0) {
    lines.push(...renderHighlights(s.auto_highlights_result));
  }
  if (s.unredacted_text) {
    lines.push(...renderUnredactedText(s.unredacted_text));
  }
  if (s.metadata?.warnings && s.metadata.warnings.length > 0) {
    lines.push(...renderWarnings(s.metadata.warnings));
  }
```

- [ ] **Step 6: Run tests + typecheck**

Run: `npm test && npm run typecheck`
Expected: all PASS, including 5/5b/13 (existing sections byte-identical when new fields absent) and 22–24.

- [ ] **Step 7: Commit**

```bash
git add src/transcript-sections.ts src/assemblyai.ts src/tools/get-transcript.ts src/smoke-test.ts
git commit -m "feat: render Speech Understanding + Guardrails results in get_transcript"
```

---

### Task 4: Redacted-audio URL in `get_transcript`

**Files:**
- Modify: `src/assemblyai.ts` (add `getRedactedAudio`)
- Modify: `src/tools/get-transcript.ts` (conditional fetch; `shape(record, redactedAudioUrl?)`)
- Test: `src/smoke-test.ts` (test 25)

**Interfaces:**
- Consumes: `requestWithRetry`, `renderRedactedAudio` (Task 3), `TranscriptRecord.redact_pii_audio` (Task 3).
- Produces: `getRedactedAudio(apiKey: string, transcriptId: string): Promise<{ status: string; redacted_audio_url?: string }>`; `shape()` gains an optional second param `redactedAudioUrl?: string`.

- [ ] **Step 1: Write failing smoke test 25**

```ts
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
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: test 25 FAILs (only 1 call made; no section).

- [ ] **Step 3: Add `getRedactedAudio` to `src/assemblyai.ts`**

```ts
export interface RedactedAudioResponse {
  status: string;
  redacted_audio_url?: string;
}

export async function getRedactedAudio(
  apiKey: string,
  transcriptId: string
): Promise<RedactedAudioResponse> {
  return requestWithRetry<RedactedAudioResponse>(
    apiKey,
    "GET",
    `/v2/transcript/${encodeURIComponent(transcriptId)}/redacted-audio`
  );
}
```

- [ ] **Step 4: Wire the conditional fetch into `src/tools/get-transcript.ts`**

Import `getRedactedAudio` and `renderRedactedAudio`. In the callback, replace `const record = await getTranscript(...); const shaped = shape(record);` with:

```ts
        const record = await getTranscript(apiKey, args.transcript_id);
        let redactedAudioUrl: string | undefined;
        let redactedAudioPending = false;
        if (record.status === "completed" && record.redact_pii_audio === true) {
          try {
            const audio = await getRedactedAudio(apiKey, args.transcript_id);
            redactedAudioUrl = audio.redacted_audio_url;
            redactedAudioPending = redactedAudioUrl === undefined;
          } catch {
            redactedAudioPending = true;
            log({
              event: "redacted_audio_unavailable",
              level: "warn",
              tool: "get_transcript",
              keyHash: keyHash(apiKey),
              transcript_id: args.transcript_id,
              status: "warn",
            });
          }
        }
        const shaped = shape(record, redactedAudioUrl);
```

Extend `ShapedTranscript` with `redacted_audio_url?: string;` and `redacted_audio_pending?: boolean;`, extend `shape`:

```ts
function shape(record: TranscriptRecord, redactedAudioUrl?: string): ShapedTranscript {
```

with, before `return out;`:

```ts
  if (redactedAudioUrl !== undefined) out.redacted_audio_url = redactedAudioUrl;
```

Set `shaped.redacted_audio_pending = true` in the callback when `redactedAudioPending` is true. In `formatTranscript()`, after the warnings block:

```ts
  if (s.redacted_audio_url) {
    lines.push(...renderRedactedAudio(s.redacted_audio_url));
  } else if (s.redacted_audio_pending) {
    lines.push("", "(redacted audio not ready yet — call get_transcript again shortly)");
  }
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npm test && npm run typecheck`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/assemblyai.ts src/tools/get-transcript.ts src/smoke-test.ts
git commit -m "feat: surface redacted audio URL in get_transcript"
```

---

### Task 5: `understand_transcript` tool (+ summarize_transcript pointer)

**Files:**
- Modify: `src/llm-gateway.ts` (add `understandTranscript`)
- Create: `src/tools/understand-transcript.ts`
- Modify: `src/tools/summarize-transcript.ts` (description line only)
- Modify: `src/server.ts` (register)
- Test: `src/smoke-test.ts` (tests 26–28)

**Interfaces:**
- Consumes: `requestWithRetry`, `AssemblyAIError`, `speechUnderstandingSchema` (Task 2), `renderTranslations`/`renderSpeechUnderstanding` (Task 3), `log`/`logError`/`keyHash`.
- Produces: `understandTranscript(apiKey: string, options: { transcript_id: string; speech_understanding: { request: Record<string, unknown> } }): Promise<UnderstandingResponse>` where `UnderstandingResponse = { request_id?: string; translated_texts?: Record<string, string>; utterances?: Array<{ speaker: string; text: string; start: number; end: number }>; speech_understanding?: { response?: SpeechUnderstandingResponse } }`. Tool name `understand_transcript`.

- [ ] **Step 1: Write failing smoke tests 26–28**

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: 26–28 FAIL (`understand_transcript` unknown tool).

- [ ] **Step 3: Add `understandTranscript` to `src/llm-gateway.ts`**

```ts
import type { SpeechUnderstandingResponse } from "./transcript-sections";

export interface UnderstandOptions {
  transcript_id: string;
  speech_understanding: { request: Record<string, unknown> };
}

export interface UnderstandingResponse {
  request_id?: string;
  translated_texts?: Record<string, string>;
  utterances?: Array<{ speaker: string; text: string; start: number; end: number }>;
  speech_understanding?: { response?: SpeechUnderstandingResponse };
}

/** Post-hoc Speech Understanding on a completed transcript. */
export async function understandTranscript(
  apiKey: string,
  options: UnderstandOptions
): Promise<UnderstandingResponse> {
  return requestWithRetry<UnderstandingResponse>(
    apiKey,
    "POST",
    "/v1/understanding",
    { transcript_id: options.transcript_id, speech_understanding: options.speech_understanding },
    3,
    DEFAULT_LLM_GATEWAY_BASE_URL
  );
}
```

- [ ] **Step 4: Create `src/tools/understand-transcript.ts`**

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { AssemblyAIError } from "../assemblyai";
import { understandTranscript } from "../llm-gateway";
import { speechUnderstandingSchema } from "../speech-understanding-schema";
import { renderTranslations, renderSpeechUnderstanding } from "../transcript-sections";
import { log, logError, keyHash } from "../log";

export function registerUnderstandTranscript(server: McpServer): void {
  server.registerTool(
    "understand_transcript",
    {
      title: "Run Speech Understanding on a Transcript",
      description:
        "Run Speech Understanding features on an ALREADY-COMPLETED transcript without re-submitting " +
        "the audio: translation, speaker_identification, custom_formatting, summarization (chaptered, " +
        "with timestamps + headlines), and action_items. First submit_transcript, then poll " +
        "get_transcript until status=completed, then call this with the transcript_id. If the need is " +
        "known before transcription, prefer passing speech_understanding to submit_transcript instead. " +
        "speaker_identification (and translation's match_original_utterance) only work if the " +
        "transcript was created with speaker_labels=true.",
      inputSchema: {
        transcript_id: z
          .string()
          .describe("The id of a completed transcript (from submit_transcript / get_transcript)."),
        speech_understanding: speechUnderstandingSchema.describe(
          "Feature requests, e.g. { request: { translation: { target_languages: ['es'] } } }. " +
            "Multiple features may be combined in one call."
        ),
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

      try {
        const response = await understandTranscript(apiKey, {
          transcript_id: args.transcript_id,
          speech_understanding: args.speech_understanding as { request: Record<string, unknown> },
        });
        log({
          event: "tool_call",
          tool: "understand_transcript",
          keyHash: keyHash(apiKey),
          transcript_id: args.transcript_id,
          status: "success",
          latencyMs: Date.now() - start,
        });

        const lines: string[] = [`transcript_id=${args.transcript_id}`];
        if (response.translated_texts && Object.keys(response.translated_texts).length > 0) {
          lines.push(...renderTranslations(response.translated_texts));
        }
        if (response.speech_understanding?.response) {
          lines.push(...renderSpeechUnderstanding(response.speech_understanding.response));
        }
        if (lines.length === 1) {
          lines.push("", "(no feature results returned — check the requested features and transcript)");
        }
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          structuredContent: {
            transcript_id: args.transcript_id,
            translated_texts: response.translated_texts,
            speech_understanding: response.speech_understanding,
            utterances: response.utterances,
            request_id: response.request_id,
          },
        };
      } catch (err) {
        if (err instanceof AssemblyAIError && err.status === 401) {
          logError(
            {
              event: "assemblyai_rejected_key",
              tool: "understand_transcript",
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
              event: "understanding_error",
              tool: "understand_transcript",
              keyHash: keyHash(apiKey),
              transcript_id: args.transcript_id,
              latencyMs: Date.now() - start,
              status: "error",
            },
            err
          );
          throw new Error(
            `Transcript ${args.transcript_id} not found or deleted for this API key (404). ` +
              "Make sure it completed and belongs to the same key."
          );
        }
        if (err instanceof AssemblyAIError && err.status === 429) {
          logError(
            {
              event: "understanding_error",
              tool: "understand_transcript",
              keyHash: keyHash(apiKey),
              transcript_id: args.transcript_id,
              latencyMs: Date.now() - start,
              status: "error",
            },
            err
          );
          throw new Error(
            "Speech Understanding rate limit reached (30 requests/min on paid accounts, 2/min free). " +
              "Retry shortly."
          );
        }
        logError(
          {
            event: "understanding_error",
            tool: "understand_transcript",
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

- [ ] **Step 5: Register + summarize pointer**

In `src/server.ts`:

```ts
import { registerUnderstandTranscript } from "./tools/understand-transcript";
// inside registerTools(), after registerSummarizeTranscript(server):
  registerUnderstandTranscript(server);
```

In `src/tools/summarize-transcript.ts`, append to the tool `description` string:

```ts
        " For a CHAPTERED summary with timestamps/headlines, or decision-aware action items, use the " +
        "`understand_transcript` tool (summarization / action_items features) instead — this tool is " +
        "the freeform/custom-prompt option.",
```

- [ ] **Step 6: Run tests + typecheck**

Run: `npm test && npm run typecheck`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/llm-gateway.ts src/tools/understand-transcript.ts src/tools/summarize-transcript.ts src/server.ts src/smoke-test.ts
git commit -m "feat: add understand_transcript tool (post-hoc Speech Understanding)"
```

---

### Task 6: `delete_transcript` tool

**Files:**
- Modify: `src/assemblyai.ts` (`requestWithRetry` DELETE support; `deleteTranscript`)
- Create: `src/tools/delete-transcript.ts`
- Modify: `src/server.ts` (register)
- Test: `src/smoke-test.ts` (tests 29–30)

**Interfaces:**
- Consumes: `requestWithRetry`, `AssemblyAIError`, `log`/`logError`/`keyHash`.
- Produces: `deleteTranscript(apiKey: string, transcriptId: string): Promise<TranscriptRecord>`; tool name `delete_transcript` returning `structuredContent { transcript_id, deleted: true }`.

- [ ] **Step 1: Write failing smoke tests 29–30**

```ts
  // 29. delete_transcript issues DELETE and confirms
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

  // 30. delete_transcript 404 → already deleted / not found
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: 29–30 FAIL (unknown tool).

- [ ] **Step 3: Widen `requestWithRetry` + add `deleteTranscript` in `src/assemblyai.ts`**

Change the method parameter type:

```ts
export async function requestWithRetry<T>(
  apiKey: string,
  method: "GET" | "POST" | "DELETE",
```

Add:

```ts
export async function deleteTranscript(
  apiKey: string,
  transcriptId: string
): Promise<TranscriptRecord> {
  return requestWithRetry<TranscriptRecord>(
    apiKey,
    "DELETE",
    `/v2/transcript/${encodeURIComponent(transcriptId)}`
  );
}
```

- [ ] **Step 4: Create `src/tools/delete-transcript.ts`**

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { deleteTranscript, AssemblyAIError } from "../assemblyai";
import { log, logError, keyHash } from "../log";

export function registerDeleteTranscript(server: McpServer): void {
  server.registerTool(
    "delete_transcript",
    {
      title: "Delete AssemblyAI Transcript",
      description:
        "PERMANENTLY delete a transcript and its associated data from AssemblyAI. Irreversible. " +
        "Only call this when the user explicitly asks for deletion (e.g. compliance cleanup after " +
        "processing) — never delete proactively.",
      inputSchema: {
        transcript_id: z.string().describe("The id of the transcript to permanently delete."),
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

      try {
        await deleteTranscript(apiKey, args.transcript_id);
        log({
          event: "tool_call",
          tool: "delete_transcript",
          keyHash: keyHash(apiKey),
          transcript_id: args.transcript_id,
          status: "success",
          latencyMs: Date.now() - start,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `Deleted transcript ${args.transcript_id}. This is permanent — the transcript data is gone.`,
            },
          ],
          structuredContent: { transcript_id: args.transcript_id, deleted: true },
        };
      } catch (err) {
        if (err instanceof AssemblyAIError && err.status === 401) {
          logError(
            {
              event: "assemblyai_rejected_key",
              tool: "delete_transcript",
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
              event: "delete_error",
              tool: "delete_transcript",
              keyHash: keyHash(apiKey),
              transcript_id: args.transcript_id,
              latencyMs: Date.now() - start,
              status: "error",
            },
            err
          );
          throw new Error(
            `Transcript ${args.transcript_id} is already deleted or not found for this API key (404).`
          );
        }
        logError(
          {
            event: "delete_error",
            tool: "delete_transcript",
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

- [ ] **Step 5: Register in `src/server.ts`**

```ts
import { registerDeleteTranscript } from "./tools/delete-transcript";
// inside registerTools(), after registerUnderstandTranscript(server):
  registerDeleteTranscript(server);
```

- [ ] **Step 6: Run tests + typecheck**

Run: `npm test && npm run typecheck`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/assemblyai.ts src/tools/delete-transcript.ts src/server.ts src/smoke-test.ts
git commit -m "feat: add delete_transcript tool"
```

---

### Task 7: Live e2e, Databricks notebook, README

**Files:**
- Modify: `src/live-test.ts`
- Modify: `notebooks/mcp-live-test.py`
- Modify: `README.md`

**Interfaces:**
- Consumes: the five registered tools and their input/output contracts from Tasks 1–6.
- Produces: updated docs + live suites. No code interfaces.

- [ ] **Step 1: Update `src/live-test.ts`**

(a) Tool discovery — replace the test-1 expected list:

```ts
  assert(
    "1. tools/list exposes exactly the 5 tools",
    JSON.stringify(names) ===
      JSON.stringify([
        "delete_transcript",
        "get_transcript",
        "submit_transcript",
        "summarize_transcript",
        "understand_transcript",
      ]),
    names.join(", ")
  );
```

(b) Add two submissions to the up-front `Promise.all` batch:

```ts
  const [plain, features, entities, pii, understanding, guardrails] = await Promise.all([
    submitAndPoll(client, { audio_url: SHORT_CLIP }),
    submitAndPoll(client, { audio_url: INTERVIEW_CLIP, speaker_labels: true, sentiment_analysis: true }),
    submitAndPoll(client, { audio_url: M4A_CLIP, entity_detection: true }),
    submitAndPoll(client, { audio_url: INTERVIEW_CLIP, redact_pii: true }),
    submitAndPoll(client, {
      audio_url: INTERVIEW_CLIP,
      speaker_labels: true,
      speech_understanding: {
        request: {
          translation: { target_languages: ["es"] },
          summarization: { summary_type: "bullets" },
        },
      },
    }),
    submitAndPoll(client, { audio_url: SHORT_CLIP, filter_profanity: true, content_safety: true }),
  ]);
```

(c) New assertions after existing test 7 (renumber comments 8–11):

```ts
  // 8. Inline Speech Understanding: translation + chaptered summary
  const suText = textOf(understanding.final);
  assert(
    "8. inline SU renders translation:es section",
    suText.includes("--- translation:es ---"),
    suText.slice(0, 300)
  );
  assert("8. inline SU renders su_summary section", suText.includes("--- su_summary"), suText.slice(0, 300));

  // 9. Guardrails: content safety section (label presence depends on audio; the
  // structuredContent field must exist even when no labels fire)
  assert(
    "9. content_safety_labels in structuredContent",
    guardrails.final.structuredContent?.content_safety_labels !== undefined ||
      textOf(guardrails.final).includes("--- content_safety"),
    JSON.stringify(guardrails.final.structuredContent).slice(0, 300)
  );

  // 10. Post-hoc understanding on the plain transcript
  const understood = await callTool(client, "understand_transcript", {
    transcript_id: plain.id,
    speech_understanding: { request: { action_items: {} } },
  });
  assert(
    "10. understand_transcript returns action_items",
    understood.isError !== true && textOf(understood).includes("--- action_items ---"),
    textOf(understood).slice(0, 300)
  );

  // 11. Teardown: delete every transcript created above
  for (const t of [plain, features, entities, pii, understanding, guardrails]) {
    const deleted = await callTool(client, "delete_transcript", { transcript_id: t.id });
    assert(
      `11. delete_transcript ${t.id}`,
      deleted.isError !== true && deleted.structuredContent?.deleted === true,
      textOf(deleted)
    );
  }
```

- [ ] **Step 2: Update `notebooks/mcp-live-test.py`**

(a) Tool-list check:

```python
check(
    "tools/list exposes the 5 tools",
    tool_names
    == ["delete_transcript", "get_transcript", "submit_transcript", "summarize_transcript", "understand_transcript"],
    ", ".join(tool_names),
)
```

(b) After the summarize check, add:

```python
understood_struct, understood_text, understood_raw = call_tool(
    "understand_transcript",
    {"transcript_id": transcript_id, "speech_understanding": {"request": {"action_items": {}}}},
)
check(
    "understand_transcript returns action_items",
    not understood_raw.get("isError") and "--- action_items ---" in understood_text,
    understood_text[:200],
)

deleted_struct, _, deleted_raw = call_tool("delete_transcript", {"transcript_id": transcript_id})
check(
    "delete_transcript cleans up the test transcript",
    not deleted_raw.get("isError") and deleted_struct.get("deleted") is True,
    json.dumps(deleted_struct),
)
```

(c) Update the notebook's intro markdown cell to mention the two new tools in the exercised flow.

- [ ] **Step 3: Update `README.md`**

- Tools section: extend the `submit_transcript` line to say it accepts the full public async param surface (prompting, language, guardrails, diarization options, inline `speech_understanding`, webhooks) with a pointer to AssemblyAI's submit-endpoint docs as the parameter reference; add bullets for **`understand_transcript(transcript_id, speech_understanding)`** (post-hoc translation / speaker ID / formatting / chaptered summarization / action items via LLM Gateway `/v1/understanding`) and **`delete_transcript(transcript_id)`** (permanent, irreversible).
- "Extending the tool surface" item 3: extend the protected-sections list with the new section names: `--- translation:<lang> ---`, `--- speaker_identification ---`, `--- custom_formatting ---`, `--- su_summary ---`, `--- action_items ---`, `--- content_safety ---`, `--- topics ---`, `--- highlights ---`, `--- unredacted_text ---`, `--- redacted_audio ---`, `--- warnings ---`.
- Project layout: add `src/transcript-sections.ts`, `src/speech-understanding-schema.ts`, `src/tools/understand-transcript.ts`, `src/tools/delete-transcript.ts`.
- Live-test section: note the suite now covers SU inline + post-hoc, guardrails, and deletes its own transcripts.

- [ ] **Step 4: Verify**

Run: `npm test && npm run typecheck`
Expected: PASS (live test is not run here — it needs a real key; run manually with `ASSEMBLYAI_API_KEY=... npm run test:live` against a dev server when available).

- [ ] **Step 5: Commit**

```bash
git add src/live-test.ts notebooks/mcp-live-test.py README.md
git commit -m "test+docs: live coverage for SU/guardrails/delete; README tool surface update"
```
