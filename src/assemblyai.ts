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
import { isValidTranscriptId } from "./transcript-id";

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
  /**
   * The reasons from an LLM Gateway error body (metadata.errors). They can
   * echo caller input, so they are not part of `message`, which goes to the
   * logs. handleToolError adds them only to the error the caller gets.
   */
  detail: string | undefined;

  constructor(message: string, status: number, transcriptId?: string, detail?: string) {
    super(message);
    this.name = "AssemblyAIError";
    this.status = status;
    this.transcriptId = transcriptId;
    this.detail = detail;
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
  // Prompting (AssemblyAI-STT-3.7)
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
  // universal-3-5-pro is deprecated but still accepted.
  speech_models?: Array<"assemblyai-stt-3-7" | "universal-2" | "universal-3-5-pro">;
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
  language_code?: string | null;
  language_confidence?: number | null;
  language_detection?: boolean | null;
  /** Which model actually transcribed the audio (e.g. universal-2 after a language fallback). */
  speech_model_used?: string;
  audio_duration?: number;
  /** Per-word timestamps for the whole transcript; the only word timings when speaker_labels is off. */
  words?: Array<{ text: string; start: number; end: number; confidence: number; speaker: string | null }>;
  utterances?: Array<{
    speaker: string;
    text: string;
    start: number;
    end: number;
    /** Present when translation.match_original_utterance was requested. */
    translated_texts?: Record<string, string>;
    /** Per-word timestamps. About 85% of a transcript's size, so get_transcript drops them unless asked. */
    words?: Array<{ text: string; start: number; end: number; confidence: number; speaker: string | null }>;
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
 * Options with special-cased handling above the generic copy loop in
 * submitTranscript (defaults, combined flags, truthy-only sends). Every
 * other TranscriptSubmitOptions key is copied verbatim into the request body
 * whenever it's defined — so a new pass-through API param needs only a zod
 * schema entry + an interface field here, never a third place to register
 * it (that third list — PASSTHROUGH_KEYS — used to drift from the other two).
 */
const HANDLED_KEYS = new Set<keyof TranscriptSubmitOptions>([
  "audio_url",
  "speech_models",
  "speaker_labels",
  "sentiment_analysis",
  "entity_detection",
  "redact_pii",
  "redact_pii_policies",
  "redact_pii_sub",
]);

export async function submitTranscript(
  apiKey: string,
  options: TranscriptSubmitOptions
): Promise<TranscriptRecord> {
  const payload: Record<string, unknown> = {
    audio_url: options.audio_url,
    // AssemblyAI-STT-3.7 for every language it supports, Universal-2 for the
    // rest. Pin the priority list unless the caller overrides, so model
    // selection doesn't drift with API-side defaults.
    speech_models: options.speech_models ?? ["assemblyai-stt-3-7", "universal-2"],
  };
  if (options.speaker_labels) payload.speaker_labels = true;
  if (options.sentiment_analysis) payload.sentiment_analysis = true;
  if (options.entity_detection) payload.entity_detection = true;
  if (options.redact_pii) {
    payload.redact_pii = true;
    payload.redact_pii_policies = options.redact_pii_policies ?? DEFAULT_REDACT_PII_POLICIES;
    payload.redact_pii_sub = options.redact_pii_sub ?? "entity_name";
  }
  for (const [key, value] of Object.entries(options)) {
    if (HANDLED_KEYS.has(key as keyof TranscriptSubmitOptions)) continue;
    if (value !== undefined) payload[key] = value;
  }
  // retries=1: POST /v2/transcript is a billable, non-idempotent create —
  // retrying it on a transient 5xx would queue a second transcription and
  // double-charge, unlike the read-only GETs.
  return requestWithRetry<TranscriptRecord>(apiKey, "POST", "/v2/transcript", payload, 1);
}

/**
 * `/v2/transcript/<id>`, refusing an id that could leave that path ("..",
 * "/", "%2e" and the like; issue #73). The tool schemas already check the id;
 * this guards every other caller.
 */
function transcriptPath(transcriptId: string): string {
  if (!isValidTranscriptId(transcriptId)) {
    throw new AssemblyAIError("Invalid transcript_id: use the id returned by submit_transcript.", 400);
  }
  return `/v2/transcript/${transcriptId}`;
}

export async function getTranscript(
  apiKey: string,
  transcriptId: string
): Promise<TranscriptRecord> {
  return requestWithRetry<TranscriptRecord>(
    apiKey,
    "GET",
    transcriptPath(transcriptId)
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
    `${transcriptPath(transcriptId)}/redacted-audio`,
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
    transcriptPath(transcriptId),
    undefined,
    1
  );
}

// Below the upload route's 60 s maxDuration.
export const UPLOAD_TIMEOUT_MS = 50_000;

/**
 * Upload raw file bytes to AssemblyAI's private storage. The returned
 * upload_url only works with the same account's key, as an audio_url.
 * Not retried: the body is a one-shot upload, and a retry after a slow
 * success would just store the file twice.
 */
export async function uploadFile(
  apiKey: string,
  data: ArrayBuffer,
  baseUrl: string = DEFAULT_BASE_URL
): Promise<{ upload_url: string }> {
  const response = await fetch(`${baseUrl}/v2/upload`, {
    method: "POST",
    headers: { Authorization: apiKey, "Content-Type": "application/octet-stream" },
    body: data,
    // A hung upstream becomes the route's own logged 502, not a platform 504.
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw await errorFromResponse(response);
  }
  return (await response.json()) as { upload_url: string };
}

// Below our 60 s request budget (src/deadline.ts): every attempt and backoff of
// one call shares this budget, so a hung upstream becomes our own error instead
// of a request that runs past the budget.
export const REQUEST_BUDGET_MS = 50_000;

export async function requestWithRetry<T>(
  apiKey: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
  retries = 3,
  baseUrl: string = DEFAULT_BASE_URL,
  budgetMs: number = REQUEST_BUDGET_MS
): Promise<T> {
  const deadline = Date.now() + budgetMs;
  let lastError: unknown;
  let attempts = 0;
  for (let attempt = 0; attempt < retries; attempt++) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    attempts++;
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
        signal: AbortSignal.timeout(remainingMs),
      });
    } catch (err) {
      lastError = err;
      if (!(await backoff(attempt, retries, deadline))) break;
      continue;
    }

    if (response.status >= 500) {
      lastError = await errorFromResponse(response);
      if (!(await backoff(attempt, retries, deadline))) break;
      continue;
    }

    if (response.status >= 400) {
      throw await errorFromResponse(response);
    }

    return (await response.json()) as T;
  }

  if (lastError instanceof AssemblyAIError) throw lastError;
  const timedOut = lastError instanceof Error && lastError.name === "TimeoutError";
  throw new AssemblyAIError(
    timedOut
      ? `AssemblyAI did not answer within ${Math.round(budgetMs / 1000)} s`
      : `AssemblyAI request failed after ${attempts} attempt${attempts === 1 ? "" : "s"}: ${String(lastError)}`,
    timedOut ? 504 : 502
  );
}

/**
 * Wait before the next attempt. Returns false, without waiting, when this was
 * the last attempt or the backoff would run past the call's deadline.
 */
async function backoff(attempt: number, retries: number, deadline: number): Promise<boolean> {
  if (attempt >= retries - 1) return false;
  const delayMs = 2 ** attempt * 1000;
  if (Date.now() + delayMs >= deadline) return false;
  await sleep(delayMs);
  return true;
}

async function errorFromResponse(response: Response): Promise<AssemblyAIError> {
  const text = await response.text();
  try {
    const body = JSON.parse(text);
    for (const key of ["error", "message", "detail"] as const) {
      if (body && typeof body === "object" && body[key]) {
        // The LLM Gateway puts the real reason in metadata.errors and only a
        // generic "invalid request body" in message. Keep the reason, apart
        // from the message (see AssemblyAIError.detail).
        const reasons = gatewayErrorReasons(body);
        return new AssemblyAIError(
          `HTTP ${response.status}: ${body[key]}`,
          response.status,
          undefined,
          reasons.length > 0 ? reasons.join("; ") : undefined
        );
      }
    }
  } catch {
    // not JSON
  }
  return new AssemblyAIError(`HTTP ${response.status}: ${text.slice(0, 500)}`, response.status);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** String reasons from an LLM Gateway error body's metadata.errors, capped. */
function gatewayErrorReasons(body: unknown): string[] {
  const errors = (body as { metadata?: { errors?: unknown } })?.metadata?.errors;
  if (!Array.isArray(errors)) return [];
  return errors
    .filter((e): e is string => typeof e === "string" && e.length > 0)
    .slice(0, 10)
    .map((e) => e.slice(0, 300));
}
