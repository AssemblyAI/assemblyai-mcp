/** AssemblyAI expects the raw API key in `Authorization`, with no `Bearer ` prefix. */

import { AsyncLocalStorage } from "node:async_hooks";

import type {
  SpeechUnderstandingResponse,
  ContentSafetyLabels,
  IabCategoriesResult,
  AutoHighlightsResult,
} from "./transcript-sections";
import { isValidTranscriptId } from "./transcript-id";
import { remainingMs, RETURN_RESERVE_MS } from "./deadline";

const DEFAULT_BASE_URL =
  process.env.ASSEMBLYAI_BASE_URL ?? "https://api.assemblyai.com";

const DEFAULT_REDACT_PII_POLICIES = [
  "person_name",
  "phone_number",
  "email_address",
  "us_social_security_number",
  "credit_card_number",
];

export class AssemblyAIError extends Error {
  status: number;
  transcriptId: string | undefined;
  /** LLM Gateway reasons can echo caller input, so they stay out of `message`, which is logged. */
  detail: string | undefined;

  constructor(message: string, status: number, transcriptId?: string, detail?: string) {
    super(message);
    this.name = "AssemblyAIError";
    this.status = status;
    this.transcriptId = transcriptId;
    this.detail = detail;
  }
}

interface TranscriptSubmitOptions {
  audio_url: string;
  speaker_labels?: boolean;
  sentiment_analysis?: boolean;
  entity_detection?: boolean;
  redact_pii?: boolean;
  redact_pii_policies?: string[];
  redact_pii_sub?: "entity_name" | "hash";
  punctuate?: boolean;
  format_text?: boolean;
  prompt?: string;
  keyterms_prompt?: string[];
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
  // universal-3-5-pro is deprecated but still accepted.
  speech_models?: Array<"assemblyai-stt-3-7" | "universal-2" | "universal-3-5-pro">;
  temperature?: number;
  speaker_options?: { min_speakers_expected?: number; max_speakers_expected?: number };
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
  speech_understanding?: { request: Record<string, unknown> };
  multichannel?: boolean;
  disfluencies?: boolean;
  custom_spelling?: Array<{ from: string[]; to: string }>;
  audio_start_from?: number;
  audio_end_at?: number;
  domain?: string;
  remove_audio_tags?: "all" | "speaker";
  iab_categories?: boolean;
  auto_highlights?: boolean;
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
  speech_model_used?: string;
  audio_duration?: number;
  words?: Array<{ text: string; start: number; end: number; confidence: number; speaker: string | null }>;
  utterances?: Array<{
    speaker: string;
    text: string;
    start: number;
    end: number;
    translated_texts?: Record<string, string>;
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
  redact_pii_audio?: boolean;
  metadata?: { domain_used?: string | null; warnings?: Array<string | { message: string }> };
}

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
    // Pin the model list so selection doesn't drift with API-side defaults.
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
  // retries=1: POST /v2/transcript is billable and non-idempotent; a retry on 5xx could double-charge.
  return requestWithRetry<TranscriptRecord>(apiKey, "POST", "/v2/transcript", payload, 1);
}

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

interface RedactedAudioResponse {
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
    `${transcriptPath(transcriptId)}/redacted-audio`,
    undefined,
    1
  );
}

export async function deleteTranscript(
  apiKey: string,
  transcriptId: string
): Promise<TranscriptRecord> {
  // retries=1: a retried DELETE after a slow success 404s and reports a successful deletion as a failure.
  return requestWithRetry<TranscriptRecord>(
    apiKey,
    "DELETE",
    transcriptPath(transcriptId),
    undefined,
    1
  );
}

const UPLOAD_TIMEOUT_MS = 50_000;

/** Not retried: the body is a one-shot upload, and a retry after a slow success stores the file twice. */
export async function uploadFile(
  apiKey: string,
  data: ArrayBuffer
): Promise<{ upload_url: string }> {
  const response = await fetch(`${DEFAULT_BASE_URL}/v2/upload`, {
    method: "POST",
    headers: { Authorization: apiKey, "Content-Type": "application/octet-stream" },
    body: data,
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw await errorFromResponse(response);
  }
  return (await response.json()) as { upload_url: string };
}

/** Below this much time left, do not start an attempt or retry: it could not finish. */
const MIN_ATTEMPT_MS = 1_000;

function timeoutError(method: "GET" | "POST" | "DELETE", timeoutMs: number): AssemblyAIError {
  return new AssemblyAIError(
    `AssemblyAI did not answer within ${Math.round(timeoutMs / 1000)} s. ` +
      (method === "GET"
        ? "This is usually temporary; try again."
        : "The request may still have gone through, so repeating it could run it twice."),
    504
  );
}

/**
 * One deadline covers all attempts, backoffs and body reads. By default it is
 * what remains of the 60 s request budget (deadline.ts), minus the return
 * reserve, so sign-in time counts. A timeout ends the call with a 504 and
 * no retry: the deadline is spent. There is no backoff after the last attempt
 * or when it would leave less than MIN_ATTEMPT_MS for the next attempt.
 */
async function attemptRequest<T>(
  apiKey: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
  retries = 3,
  baseUrl: string = DEFAULT_BASE_URL,
  timeoutMs: number = remainingMs() - RETURN_RESERVE_MS,
  onStatus?: (status: number) => void
): Promise<T> {
  if (!(timeoutMs >= MIN_ATTEMPT_MS)) {
    throw new AssemblyAIError(
      "Not enough time left in this request to call AssemblyAI, so nothing was sent. Call the tool again.",
      504
    );
  }
  const deadline = Date.now() + timeoutMs;
  const signal = AbortSignal.timeout(timeoutMs);
  let lastError: unknown;
  let attempts = 0;
  for (let attempt = 0; attempt < retries; attempt++) {
    if (attempt > 0) {
      // Back off only between attempts, and only if the next one still fits.
      const delayMs = 2 ** (attempt - 1) * 1000;
      if (deadline - Date.now() < delayMs + MIN_ATTEMPT_MS) break;
      await sleep(delayMs);
    }
    attempts++;
    let response: Response | undefined;
    let text: string;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: apiKey,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal,
      });
      onStatus?.(response.status);
      // fetch resolves at the headers, so a dropped connection can still fail while the body is read.
      text = response.status >= 400 ? await readErrorText(response) : await response.text();
    } catch (err) {
      if (signal.aborted) throw timeoutError(method, timeoutMs);
      if (response && response.status >= 400 && response.status < 500) {
        throw new AssemblyAIError(`HTTP ${response.status}: failed to read AssemblyAI error response: ${String(err)}`, 502);
      }
      lastError = err;
      continue;
    }

    if (response.status >= 500) {
      lastError = errorFromText(response.status, text);
      continue;
    }
    if (response.status >= 400) throw errorFromText(response.status, text);
    return JSON.parse(text) as T;
  }

  if (lastError instanceof AssemblyAIError) throw lastError;
  throw new AssemblyAIError(
    `AssemblyAI request failed after ${attempts} attempt${attempts === 1 ? "" : "s"}: ${String(lastError)}`,
    502
  );
}

export const MAX_ERROR_BODY_BYTES = 16384;

export async function readErrorText(response: Response, maxBytes = MAX_ERROR_BODY_BYTES): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      const keep = Math.max(0, maxBytes - (total - value.byteLength));
      if (keep > 0) chunks.push(value.slice(0, keep));
      // Cancelling one tee branch can wait for its unread sibling indefinitely.
      void reader.cancel().catch(() => {});
      total = maxBytes;
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

interface KeyProbe {
  result: Promise<boolean>;
  rejected?: boolean;
}

const requestKeyProbes = new AsyncLocalStorage<Map<string, KeyProbe>>();
const MAX_KEY_PROBE_WAIT_MS = 250;

export function withRequestKeyProbes<Req, Res>(
  handler: (req: Req) => Promise<Res>
): (req: Req) => Promise<Res> {
  return (req) => requestKeyProbes.run(new Map(), () => handler(req));
}

async function probeRejected(probe: KeyProbe, timeoutMs: number): Promise<boolean> {
  if (probe.rejected !== undefined) return probe.rejected;
  if (timeoutMs <= 0) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      probe.result,
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Run an outbound API-keyed request within the current batch's shared key probe gate.
 * Sibling calls with the same key wait up to 250 ms for the first probe and short-circuit with 401 if rejected.
 */
export async function runWithBatchKeyProbe<T>(
  apiKey: string,
  timeoutMs: number | undefined,
  fn: (setRejected: (rejected: boolean) => void) => Promise<T>,
  isRejectedError: (error: unknown) => boolean = (error) =>
    error instanceof AssemblyAIError && error.status === 401
): Promise<T> {
  const probes = requestKeyProbes.getStore();
  if (!probes) return fn(() => {});

  const existing = probes.get(apiKey);
  if (existing) {
    const spareMs = (timeoutMs ?? remainingMs() - RETURN_RESERVE_MS) - MIN_ATTEMPT_MS;
    if (await probeRejected(existing, Math.min(MAX_KEY_PROBE_WAIT_MS, spareMs))) {
      throw new AssemblyAIError("AssemblyAI rejected the API key (401).", 401);
    }
    return fn(() => {});
  }

  let resolve!: (rejected: boolean) => void;
  const probe: KeyProbe = { result: new Promise<boolean>(r => { resolve = r; }) };
  probes.set(apiKey, probe);
  const settle = (rejected: boolean) => {
    if (probe.rejected !== undefined) return;
    probe.rejected = rejected;
    resolve(rejected);
  };
  try {
    const result = await fn(settle);
    settle(false);
    return result;
  } catch (error) {
    settle(isRejectedError(error));
    throw error;
  }
}

export async function requestWithRetry<T>(
  apiKey: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
  retries = 3,
  baseUrl: string = DEFAULT_BASE_URL,
  timeoutMs?: number
): Promise<T> {
  return runWithBatchKeyProbe(apiKey, timeoutMs, (setRejected) =>
    attemptRequest<T>(apiKey, method, path, body, retries, baseUrl, timeoutMs,
      status => setRejected(status === 401))
  );
}

async function errorFromResponse(response: Response): Promise<AssemblyAIError> {
  const text = await readErrorText(response);
  return errorFromText(response.status, text);
}

function errorFromText(status: number, text: string): AssemblyAIError {
  try {
    const body = JSON.parse(text);
    for (const key of ["error", "message", "detail"] as const) {
      if (body && typeof body === "object" && body[key]) {
        // The LLM Gateway puts the real reason in metadata.errors; message is only "invalid request body".
        const reasons = gatewayErrorReasons(body);
        return new AssemblyAIError(
          `HTTP ${status}: ${body[key]}`,
          status,
          undefined,
          reasons.length > 0 ? reasons.join("; ") : undefined
        );
      }
    }
  } catch {
  }
  return new AssemblyAIError(`HTTP ${status}: ${text.slice(0, 500)}`, status);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function gatewayErrorReasons(body: unknown): string[] {
  const errors = (body as { metadata?: { errors?: unknown } })?.metadata?.errors;
  if (!Array.isArray(errors)) return [];
  return errors
    .filter((e): e is string => typeof e === "string" && e.length > 0)
    .slice(0, 10)
    .map((e) => e.slice(0, 300));
}
