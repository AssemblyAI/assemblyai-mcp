# Design: Async API parity + Speech Understanding + Guardrails

**Date:** 2026-08-11
**Branch:** `feature/api-parity-speech-understanding-guardrails`
**Status:** Approved (pending spec review)

## Motivation

The tool surface should track the public AssemblyAI API — "supported as it is
in the API" — rather than a hand-picked subset. Three doc areas drive this
round:

- Pre-recorded async API — full `POST /v2/transcript` parameter surface
  (https://www.assemblyai.com/docs/pre-recorded-audio/api-reference/transcripts/submit)
- Speech Understanding — translation, speaker identification, custom
  formatting, summarization, action items
  (https://www.assemblyai.com/docs/speech-understanding/getting-started)
- Guardrails — PII redaction (incl. audio), content moderation, profanity
  filtering, speech threshold
  (https://www.assemblyai.com/docs/guardrails/getting-started)

The additive-only contract (see the 2026-05-29 spec and `README.md`) makes all
of this shippable without a Databricks connection re-test: new tools and new
optional params are discovered at runtime via `list_tools`.

Parameter shapes were validated against the API implementation in the
`DeepLearning` monorepo (async_api request DTO, transcriber input model, LLM
Gateway framework), not just the docs. Two findings shaped the design:

1. **`speech_understanding` is a loose dict at the public API boundary** —
   async_api passes it through and the LLM Gateway validates
   (`speech_understanding.request` must be a non-empty object). Our schema
   mirrors that: typed for the five known features, open to unknown keys.
2. **All five understanding features are registered in the one Gateway
   framework** serving both the inline path and post-hoc
   `POST /v1/understanding` — so a post-hoc tool can expose the full set.

### Scope (decided with the user)

Approach approved: **API-shape pass-through** — tool inputs use the exact
public API names and nesting, so AssemblyAI's docs document the MCP tools and
param additions stay near-mechanical. Five tools total:

- `submit_transcript` — grows to the full public submit-param surface.
- `get_transcript` — output gains a labeled section per new feature result.
- `summarize_transcript` — unchanged; description gains one disambiguation line.
- `understand_transcript` — **new**, post-hoc Speech Understanding via the LLM
  Gateway `/v1/understanding`.
- `delete_transcript` — **new**, `DELETE /v2/transcript/{id}`.

### Out of scope (YAGNI — all non-breaking to add later)

- Subtitles (SRT/VTT), sentences, paragraphs, word search, list transcripts —
  re-chunkings or searches an agent can do over the text it already has; each
  extra tool dilutes tool-selection accuracy in AI Playground.
- Sync STT API (≤120s clips), upload endpoint, EU host routing.
- Internal-only / undocumented params found in source (never expose):
  `speaker_options.{use_two_stage_clustering, short_file_diarization_method,
  long_file_diarization_method, enforce_sentence_level_consistency,
  enable_narrowband, speaker_labels_model, advanced_speaker_segmentation}`,
  `language_detection_options.{on_low_language_confidence, swiss_german,
  language_detection_model}`, `keyterms_prompt_options`, `custom_topics`,
  `topics`, `domain_options`.
- Deprecated params (never expose): `auto_chapters`, `summarization` +
  `summary_model`/`summary_type` (as API params), `word_boost`, `boost_param`,
  singular `speech_model`, `dual_channel`, `speakers_expected`. The existing
  no-op `summarization` boolean on the tool schema stays (additive contract).

## `submit_transcript` — full public param surface

All new inputs optional; omitted params are **not sent** to the API, so
defaults reproduce today's behavior exactly. Names/shapes are 1:1 with the
public API.

| Group | New inputs |
|---|---|
| Prompting | `prompt` (string; contextual description, not instructions), `keyterms_prompt` (string[]; ≤1000 terms U3.5-Pro / ≤200 U2) |
| Language | `language_code`, `language_codes` (string[], U3.5-Pro), `language_detection` (bool), `language_detection_options` `{expected_languages, fallback_language, code_switching, code_switching_confidence_threshold, localization}`, `language_confidence_threshold` (0–1) |
| Models | `speech_models` (array; enum `universal-3-5-pro`, `universal-2`; **default stays the pinned `["universal-3-5-pro", "universal-2"]`**), `temperature` (0–1, U3.5-Pro) |
| Diarization | `speaker_options` `{min_speakers_expected, max_speakers_expected}` (existing `speaker_labels` unchanged) |
| Guardrails | `filter_profanity` (bool), `speech_threshold` (0–1; needs ≥30s audio), `content_safety` (bool), `content_safety_confidence` (int 25–100), `redact_pii_audio` (bool), `redact_pii_audio_quality` (`mp3`\|`wav`), `redact_pii_audio_options` `{override_audio_redaction_method, return_redacted_no_speech_audio}`, `redact_pii_return_unredacted` (bool), `redact_static_entities` (record: label → string[]; requires `redact_pii: true`) |
| Speech Understanding | `speech_understanding` `{request: {translation?, speaker_identification?, custom_formatting?, summarization?, action_items?}}` — see feature shapes below |
| Other STT | `multichannel`, `disfluencies`, `custom_spelling` (`[{from: string[], to: string}]`), `audio_start_from` (ms), `audio_end_at` (ms), `domain` (`medical-v1`), `remove_audio_tags` (`all`\|`speaker`), `iab_categories`, `auto_highlights` |
| Webhooks | `webhook_url`, `webhook_auth_header_name`, `webhook_auth_header_value` — pass-through parity; descriptions note agent flows should poll `get_transcript` instead |

Existing `redact_pii`/`redact_pii_policies`/`redact_pii_sub` are unchanged,
including this server's `entity_name` substitution default and default policy
set (established behavior, kept per contract).

### Speech Understanding feature shapes (`speech_understanding.request.*`)

- `translation`: `{target_languages: string[] (required), formal?, match_original_utterance?, force_translation?}` —
  `match_original_utterance` requires `speaker_labels: true`.
- `speaker_identification`: `{speaker_type: "name"|"role", known_values?: string[], speakers?: [{name?|role?, description?, ...}]}` —
  requires `speaker_labels: true`; `known_values` XOR `speakers`.
- `custom_formatting`: `{date?, phone_number?, email?: string patterns, format_utterances?: bool}` —
  patterns are **strings**, not booleans.
- `summarization`: `{summary_type: "paragraph"|"bullets" (required), effort?: "low"|"medium"}`.
- `action_items`: `{include_decisions?: bool, effort?: "low"|"medium"}` — `{}` valid.

Tool-description guidance baked in: enable at submit time when the need is
known upfront; for an already-completed transcript use `understand_transcript`
instead of re-submitting audio.

## `get_transcript` — output additions

`shape()`/`formatTranscript()` gain sections rendered **only when present**;
all existing sections and `structuredContent` fields are untouched.

| Section | Source field | Rendering |
|---|---|---|
| `--- translation:<lang> ---` (one per language) | `translated_texts` | full translated text |
| `--- speaker_identification ---` | `speech_understanding.response.speaker_identification.mapping` | `A → Michel Martin` lines (utterances already carry identified names) |
| `--- custom_formatting ---` | `speech_understanding.response.custom_formatting.formatted_text` | formatted transcript text |
| `--- su_summary ---` | `speech_understanding.response.summarization.summary[]` | `[m:ss–m:ss] Headline — text` per chapter |
| `--- action_items ---` | `speech_understanding.response.action_items.items[]` | `- action (quote @ m:ss)` |
| `--- content_safety ---` | `content_safety_labels` | per-label: name, confidence, severity summary |
| `--- topics ---` | `iab_categories_result.summary` | top categories with relevance |
| `--- highlights ---` | `auto_highlights_result.results[]` | `count× "phrase"` |
| `--- unredacted_text ---` | `unredacted_text` | only when `redact_pii_return_unredacted` was set |
| `--- redacted_audio ---` | `GET /v2/transcript/{id}/redacted-audio` | URL + "expires in 24h" note; fetched only when the record shows `redact_pii_audio: true` and status `completed`; non-200 → section replaced by a one-line "not ready yet" note, never fails the tool |
| `--- warnings ---` | `metadata.warnings[]` | one line per warning — surfaces silent model fallbacks and skipped Medical Mode |

`structuredContent` gains the corresponding raw fields (additive):
`translated_texts`, `speech_understanding` (response object),
`content_safety_labels`, `iab_categories_result`, `auto_highlights_result`,
`unredacted_text`, `redacted_audio_url`, `metadata`.

## `understand_transcript` (new tool)

Post-hoc Speech Understanding on a **completed** transcript.

- Inputs: `transcript_id` (required) + `speech_understanding` — identical shape
  to the inline object (all five features).
- Behavior: `POST {llm-gateway}/v1/understanding` with
  `{transcript_id, speech_understanding}` (reuses `requestWithRetry` with the
  Gateway base URL, raw-key auth). Renders whichever features were requested
  using the same section formats as `get_transcript`, plus raw
  `structuredContent` (the Gateway also returns top-level `translated_texts` /
  `utterances` for translation and speaker identification).
- Errors: `404` → "transcript not found or deleted for this API key"; `429` →
  "Speech Understanding rate limit (30 req/min on paid accounts) — retry
  shortly"; `401` → same bad-key wording as the other tools.
- Description guidance: use when the transcript already completed; prefer
  inline `speech_understanding` on `submit_transcript` when the need is known
  at submit time. Speaker identification and `match_original_utterance` only
  work if the transcript was created with `speaker_labels: true`.

## `delete_transcript` (new tool)

- Input: `transcript_id` (required).
- Behavior: `DELETE /v2/transcript/{id}`; returns a confirmation line and
  `structuredContent` `{transcript_id, deleted: true}`.
- Description states: permanently deletes the transcript and associated data,
  irreversible, call only when the user explicitly asks for deletion (e.g.
  compliance cleanup after processing).
- Errors: `404` → "already deleted or not found"; `401` → bad-key wording.

## `summarize_transcript` — description-only change

Behavior unchanged (LLM Gateway `/v1/chat/completions`, `claude-sonnet-4-6`).
Description gains one line: for chaptered summaries with timestamps/headlines
or decision-aware action items, use `understand_transcript` with
`summarization`/`action_items`; `summarize_transcript` remains the
custom-prompt/freeform option.

## Validation strategy — permissive pass-through

Zod schemas mirror the public API but stay permissive where the API is
permissive:

- The five `speech_understanding.request` features are typed (fields above)
  but allow unknown keys (`.passthrough()`), matching the loose-dict API
  boundary — the Gateway is the validator of record.
- Where the API enforces enums/ranges we mirror them in zod for better agent
  feedback (`speech_models`, `redact_pii_sub`, `redact_pii_audio_quality`,
  `remove_audio_tags`, `summary_type`, `effort`, numeric ranges).
- AssemblyAI 400 messages surface verbatim through `AssemblyAIError` — no
  rewriting, so the API's own validation errors reach the agent.

This keeps the server evergreen: new subfields flow through with no redeploy;
new top-level params are a one-line zod addition.

## Components touched

- `src/assemblyai.ts` — extend `TranscriptSubmitOptions` (all new params,
  built into the payload only when provided) and `TranscriptRecord` (new
  response fields); add `deleteTranscript()`; add `getRedactedAudio()`.
- `src/llm-gateway.ts` — add `understandTranscript()`
  (`POST /v1/understanding`).
- `src/tools/submit-transcript.ts` — new optional inputs + descriptions.
- `src/tools/get-transcript.ts` — `shape()` + `formatTranscript()` additions;
  conditional redacted-audio fetch.
- `src/tools/understand-transcript.ts` — **new** tool (shares section
  formatters with get-transcript via a small extracted formatting module).
- `src/tools/delete-transcript.ts` — **new** tool.
- `src/tools/summarize-transcript.ts` — description line only.
- `src/server.ts` — register the two new tools.
- `README.md` — tool table, additive-contract section list, Guardrails/Speech
  Understanding notes.

## Error handling & logging

Unchanged pattern: request-scoped key from `withMcpAuth`, `AssemblyAIError`
status mapping, JSON-to-stdout logs (`event`, `tool`, `keyHash`, `latencyMs`,
`status`). New high-signal events: `understanding_error`, `delete_error`,
`redacted_audio_unavailable` (warn-level; tool still succeeds). Never log the
raw key, transcript text, or unredacted content.

## Testing

Extend `src/smoke-test.ts` (InMemoryTransport + mocked `fetch`, no network):

1. `submit_transcript` pass-through: each new param group appears in the
   request payload byte-exact when provided, and is absent when omitted;
   `speech_understanding` nests under `request`; deprecated params never sent.
2. `get_transcript` renders each new section only when its source field is
   present; existing sections byte-identical when new fields are absent
   (backward-compat check); redacted-audio fetch mocked for ready/not-ready.
3. `understand_transcript` posts `{transcript_id, speech_understanding}` to
   the Gateway host; 404/429 map to the documented messages.
4. `delete_transcript` issues DELETE and maps 404.

Extend `src/live-test.ts` (`npm run test:live`, real API, few cents/run):

1. Inline SU submit: `translation` + `summarization` on a short clip; assert
   `translated_texts` and chaptered summary render.
2. Guardrails submit: `filter_profanity` + `content_safety`; assert sections.
3. Post-hoc `understand_transcript` (`action_items`) on the transcript from
   step 1.
4. `delete_transcript` teardown of every transcript the suite creates —
   asserts deletion and keeps live runs self-cleaning.

`notebooks/mcp-live-test.py` gains the two new tools. `npm run typecheck` and
`npm test` must pass.

## Sources

- AssemblyAI docs — async submit endpoint, Speech Understanding
  getting-started, Guardrails getting-started (links in Motivation).
- `DeepLearning` monorepo (internal source-of-truth validation):
  `assemblyai/engineering/projects/async_api/api/models/dto/transcription/transcription.py`,
  `assemblyai/engineering/projects/transcriber/public/types/transcription_request.py`,
  `assemblyai/engineering/projects/llm_gateway/pkg/framework/framework.go`
  (five features registered), `.../framework/understanding.go` (loose-dict
  validation of `speech_understanding.request`).
- Public API spec: https://github.com/AssemblyAI/assemblyai-api-spec
- Prior spec: `docs/superpowers/specs/2026-05-29-audio-intelligence-tools-design.md`
  (additive-only contract).
