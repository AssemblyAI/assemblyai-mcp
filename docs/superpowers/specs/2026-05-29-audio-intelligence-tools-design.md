# Design: Extensible tool surface + audio-intelligence features

**Date:** 2026-05-29
**Branch:** `feature/audio-intelligence-tools`
**Status:** Approved (pending spec review)

## Motivation

A Databricks partner conversation asked whether the AssemblyAI MCP server should
support the breadth the AssemblyAI n8n connector does (audio intelligence, LLM
Gateway, subtitles, etc.). The driver we settled on is **future-proofing the
surface** — not 1:1 n8n parity — so we can add AssemblyAI capabilities over time
without forcing customers to re-run the Databricks connection test.

Key platform fact that shapes everything: **Databricks discovers MCP tools at
runtime.** AI Playground and agents call `list_tools` against the server; the
Unity Catalog connection stores only URL + auth. So adding tools or optional
params requires **no connection change and no re-test**. The only breaking moves
are: renaming/removing a tool, adding a required input, or reshaping existing
output.

Therefore "future-proof" = commit to an **additive-only contract**, then seed a
first slice of audio-intelligence features as a worked example of that contract.

### Scope (decided with the user)

- **A** — Additive-only contract, documented in the repo.
- **B** — Seed audio-intelligence flags on `submit_transcript`:
  `sentiment_analysis`, `entity_detection`, `redact_pii` (text redaction only).
- **Summarization** — reimplement off the now-deprecated transcript params onto
  **LLM Gateway**, exposed as a **new `summarize_transcript` tool**.

### Out of scope (YAGNI — drop in later, all non-breaking)

- Redacted **audio** generation/retrieval (`redact_pii_audio` + the
  `/redacted-audio` endpoint, second async poll).
- `auto_chapters` — **deprecated** by AssemblyAI in favour of LLM Gateway.
- Subtitles (SRT/VTT), sentences, paragraphs, word search — granular n8n ops an
  LLM agent can reproduce from the transcript text.
- Other LLM Gateway tools: Q&A (`ask_transcript`), translation, speaker-ID. The
  `summarize_transcript` tool establishes the pattern these will follow.
- `list` / `delete` transcript management.
- EU host routing for the REST + LLM Gateway endpoints.

## A — Additive-only contract

To be documented in `README.md` under an "Extending the tool surface" section:

1. **Tool names are permanent.** Only add tools; never rename or remove.
2. **New inputs are always optional**, with defaults that preserve current
   behavior (every new flag defaults to off/unset).
3. **`get_transcript`'s text output only gains new labeled sections**
   (`--- sentiment ---`, `--- entities ---`, …). Existing sections
   (`--- text ---`, `--- utterances ---`, `--- summary ---`) are never renamed
   or reshaped — Databricks AI Playground reads `content[].text`.
4. **`structuredContent` is additive only** — new fields, never removed/renamed.
5. **Avoid deprecated AssemblyAI transcript params**; prefer LLM Gateway. Mirror
   AssemblyAI's own official MCP tool shapes where they exist, for consistency
   across AssemblyAI's MCP footprint.

## B — Audio-intelligence flags on `submit_transcript`

All new params optional; defaults reproduce today's behavior exactly.

| New input | Type | AssemblyAI request mapping | Surfaced in `get_transcript` |
|---|---|---|---|
| `sentiment_analysis` | boolean (default `false`) | `sentiment_analysis: true` **and** `speech_models: ["universal-3-pro","universal-2"]` (required by the feature) | `--- sentiment ---` section + `sentiment_analysis_results` in `structuredContent` |
| `entity_detection` | boolean (default `false`) | `entity_detection: true` | `--- entities ---` section + `entities` in `structuredContent` |
| `redact_pii` | boolean (default `false`) | `redact_pii: true` (+ policies + sub, below) | none new — existing `--- text ---` comes back already redacted |
| `redact_pii_policies` | string[] (default `["person_name","phone_number","email_address","us_social_security_number","credit_card_number"]`) | `redact_pii_policies` | — |
| `redact_pii_sub` | `"entity_name" \| "hash"` (default `"entity_name"`) | `redact_pii_sub` | — |

Notes baked into tool descriptions:
- Sentiment is **English-only** and requires the universal models (handled by
  setting `speech_models` automatically when the flag is on).
- `redact_pii_policies`/`redact_pii_sub` are only sent when `redact_pii` is true.

### Verified AssemblyAI response shapes

- `sentiment_analysis_results[]` = `{ text, sentiment ("POSITIVE"|"NEUTRAL"|"NEGATIVE"), confidence (0–1), start, end, speaker|null }`
- `entities[]` = `{ text, entity_type, start, end }`
- PII text redaction returns the redacted transcript in the existing `text` field.

### `get_transcript` output additions

`shape()` gains optional `sentiment_analysis_results` and `entities`.
`formatTranscript()` appends, only when present:

```
--- sentiment (per-sentence; start/end are ms) ---
[POSITIVE 0.97] 0:03–0:07 (Speaker A): <sentence text>
...

--- entities ---
person_name: Dr. Sanjay Gupta
organization: CNN
...
```

Timestamps reuse the existing `formatMs` helper. Existing sections unchanged.

## Summarization → LLM Gateway (new `summarize_transcript` tool)

The deprecated `summarization`/`summary_model`/`summary_type` params produced a
server-stored `summary` field. LLM Gateway is an on-demand, **stateless** call —
and crucially it accepts a `transcript_id` directly (a `{{ transcript }}` tag in
the prompt is substituted with the transcript's `text` server-side), so no
submit→get state is needed and the same pass-through API key works.

### New module `src/llm-gateway.ts`

- Host: `https://llm-gateway.assemblyai.com` (distinct from the REST host; its
  own constant, overridable via env for testing).
- `Authorization: <raw key>` — same key, no `Bearer` prefix.
- `POST /v1/chat/completions`, body:
  ```json
  {
    "model": "claude-sonnet-4-6",
    "messages": [{ "role": "user", "content": "<prompt>\n\n{{ transcript }}" }],
    "transcript_id": "<id>",
    "max_tokens": 1000
  }
  ```
- Returns `choices[0].message.content`. Reuse the `AssemblyAIError` /
  retry-with-backoff pattern from `assemblyai.ts`.

### New tool `summarize_transcript`

- Inputs:
  - `transcript_id: string` (required) — must be a **completed** transcript;
    description tells the agent to poll `get_transcript` to `completed` first.
  - `style?: "bullets" | "paragraph" | "headline" | "action_items" | "custom"`
    (default `"bullets"`) — maps to a canned prompt.
  - `custom_prompt?: string` — used when `style="custom"` (or to override).
- Behavior: build the prompt from `style`, call LLM Gateway with `transcript_id`,
  return the summary as `content[].text` and `structuredContent`
  `{ summary, style, model }`.
- Errors: LLM Gateway returns **404** if the transcript ID doesn't exist or
  belongs to another account → surface a clear message; **401** → bad key
  (same wording as the other tools).

### Existing `summarization` flag on `submit_transcript`

Kept in the schema (additive contract — not removed), but **stops setting the
deprecated params**. Its description redirects the agent: "summaries are produced
by the `summarize_transcript` tool after the transcript completes." The
`--- summary ---` formatting in `get_transcript` is left in place (harmless;
simply won't populate from the transcript anymore since AssemblyAI no longer
returns `summary`).

## Components touched

- `src/assemblyai.ts` — extend `TranscriptSubmitOptions` (new flags) and
  `TranscriptRecord` (new response fields); build payload conditionally; drop
  deprecated summarization params.
- `src/llm-gateway.ts` — **new**, LLM Gateway fetch wrapper.
- `src/tools/submit-transcript.ts` — new optional inputs + descriptions.
- `src/tools/get-transcript.ts` — `shape()` + `formatTranscript()` additions.
- `src/tools/summarize-transcript.ts` — **new** tool.
- `src/server.ts` — register the new tool.
- `README.md` — "Extending the tool surface" section (contract) + new tool docs.

## Error handling & logging

Reuse the existing JSON-to-stdout logging (`event`, `tool`, `keyHash`,
`latencyMs`, `status`) and `keyHash` for the new tool and the LLM Gateway path.
Never log the raw key or transcript text. New high-signal events:
`llm_gateway_error`, `assemblyai_rejected_key` (already exists).

## Testing

Extend `src/smoke-test.ts` (InMemoryTransport + mocked `fetch`), no network:

1. `submit_transcript` with each new flag sets the correct request payload
   (incl. `speech_models` when sentiment is on; policies/sub only when
   `redact_pii` is on; no deprecated summarization params ever).
2. `get_transcript` renders `--- sentiment ---` and `--- entities ---` only when
   those arrays are present; existing sections unchanged when they're absent.
3. `summarize_transcript` posts to the LLM Gateway host with `transcript_id` and
   the `{{ transcript }}` tag, and returns `choices[0].message.content`.
4. Backward-compat: a plain `submit_transcript(audio_url)` + `get_transcript`
   call produces byte-identical output to today.

`npm run typecheck` and `npm test` must pass.

## Sources

- Databricks — Use Databricks managed MCP servers (runtime tool discovery):
  https://docs.databricks.com/aws/en/generative-ai/mcp/managed-mcp
- AssemblyAI API reference — `/v2/transcript`, sentiment, entity detection, PII
  redaction, LLM Gateway `/v1/chat/completions` (via the AssemblyAI Docs MCP).
- AssemblyAI — Summarization via LLM Gateway:
  https://www.assemblyai.com/docs/speech-understanding/summarize-transcripts
