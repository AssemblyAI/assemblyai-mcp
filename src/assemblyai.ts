/**
 * Thin wrapper around the AssemblyAI v2 REST API.
 *
 * Auth: AssemblyAI expects the raw API key in the `Authorization` header (no
 * `Bearer ` prefix). Each function takes `apiKey` as the first argument so the
 * client is stateless and request-scoped — the key comes from `withMcpAuth`'s
 * `extra.authInfo.token` and never lives in module state.
 */

import type {
  SpeechUnderstandingResponse,
  ContentSafetyLabels,
  IabCategoriesResult,
  AutoHighlightsResult,
} from "./transcript-sections";

const DEFAULT_BASE_URL =
  process.env.ASSEMBLYAI_BASE_URL ?? "https://api.assemblyai.com";

/** PII categories redacted when redact_pii is enabled but no policies are given. */
export const DEFAULT_REDACT_PII_POLICIES = [
  "person_name",
  "phone_number",
  "email_address",
  "us_social_security_number",
  "credit_card_number",
];

export class AssemblyAIError extends Error {
  status: number;
  transcriptId: string | undefined;

  constructor(message: string, status: number, transcriptId?: string) {
    super(message);
    this.name = "AssemblyAIError";
    this.status = status;
    this.transcriptId = transcriptId;
  }
}

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
  // Verbatim/formatting toggles — both default true server-side.
  punctuate?: boolean;
  format_text?: boolean;
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

export interface TranscriptRecord {
  id: string;
  status: "queued" | "processing" | "completed" | "error";
  text?: string;
  /** Which model actually transcribed the audio (e.g. universal-2 after a language fallback). */
  speech_model_used?: string;
  audio_duration?: number;
  utterances?: Array<{
    speaker: string;
    text: string;
    start: number;
    end: number;
    /** Present when translation.match_original_utterance was requested. */
    translated_texts?: Record<string, string>;
  }>;
  summary?: string;
  error?: string;
  sentiment_analysis_results?: Array<{
    text: string;
    sentiment: string;
    confidence: number;
    start: number;
    end: number;
    speaker: string | null;
  }>;
  entities?: Array<{ text: string; entity_type: string; start: number; end: number }>;
  translated_texts?: Record<string, string>;
  speech_understanding?: { request?: unknown; response?: SpeechUnderstandingResponse };
  content_safety_labels?: ContentSafetyLabels;
  iab_categories_result?: IabCategoriesResult;
  auto_highlights_result?: AutoHighlightsResult;
  unredacted_text?: string;
  /** Echo of the request param — signals a redacted audio file exists. */
  redact_pii_audio?: boolean;
  // Not yet observed in a live response — verify via test:live before relying on it (see PR #1 review).
  metadata?: { domain_used?: string | null; warnings?: Array<{ message: string }> };
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
  "punctuate",
  "format_text",
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

export async function getTranscript(
  apiKey: string,
  transcriptId: string
): Promise<TranscriptRecord> {
  return requestWithRetry<TranscriptRecord>(
    apiKey,
    "GET",
    `/v2/transcript/${encodeURIComponent(transcriptId)}`
  );
}

export interface RedactedAudioResponse {
  status: string;
  redacted_audio_url?: string;
}

export async function getRedactedAudio(
  apiKey: string,
  transcriptId: string
): Promise<RedactedAudioResponse> {
  // retries=1: this is polled repeatedly from get_transcript's hot path
  // (every ~3s until the redacted audio is ready); retrying each poll would
  // multiply request volume and latency for a call that's cheap to just
  // re-issue on the caller's next poll anyway.
  return requestWithRetry<RedactedAudioResponse>(
    apiKey,
    "GET",
    `/v2/transcript/${encodeURIComponent(transcriptId)}/redacted-audio`,
    undefined,
    1
  );
}

export async function deleteTranscript(
  apiKey: string,
  transcriptId: string
): Promise<TranscriptRecord> {
  // retries=1: DELETE is not idempotent from the caller's point of view — a
  // retry after a successful-but-slow-to-respond delete would 404 on the
  // already-deleted transcript and mislabel a successful deletion as a
  // failure.
  return requestWithRetry<TranscriptRecord>(
    apiKey,
    "DELETE",
    `/v2/transcript/${encodeURIComponent(transcriptId)}`,
    undefined,
    1
  );
}

export async function requestWithRetry<T>(
  apiKey: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
  retries = 3,
  baseUrl: string = DEFAULT_BASE_URL
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          // No `Bearer ` prefix — AssemblyAI expects the raw key.
          Authorization: apiKey,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      lastError = err;
      await sleep(2 ** attempt * 1000);
      continue;
    }

    if (response.status >= 500) {
      lastError = new AssemblyAIError(
        await safeErrorMessage(response),
        response.status
      );
      await sleep(2 ** attempt * 1000);
      continue;
    }

    if (response.status >= 400) {
      throw new AssemblyAIError(
        await safeErrorMessage(response),
        response.status
      );
    }

    return (await response.json()) as T;
  }

  if (lastError instanceof AssemblyAIError) throw lastError;
  throw new AssemblyAIError(
    `AssemblyAI request failed after ${retries} retries: ${String(lastError)}`,
    502
  );
}

async function safeErrorMessage(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const body = JSON.parse(text);
    for (const key of ["error", "message", "detail"] as const) {
      if (body && typeof body === "object" && body[key]) {
        return `HTTP ${response.status}: ${body[key]}`;
      }
    }
  } catch {
    // not JSON
  }
  return `HTTP ${response.status}: ${text.slice(0, 500)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
