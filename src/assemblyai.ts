/**
 * Thin wrapper around the AssemblyAI v2 REST API.
 *
 * Auth: AssemblyAI expects the raw API key in the `Authorization` header (no
 * `Bearer ` prefix). Each function takes `apiKey` as the first argument so the
 * client is stateless and request-scoped — the key comes from `withMcpAuth`'s
 * `extra.authInfo.token` and never lives in module state.
 */

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
  speaker_labels?: boolean;
  sentiment_analysis?: boolean;
  entity_detection?: boolean;
  redact_pii?: boolean;
  redact_pii_policies?: string[];
  redact_pii_sub?: "entity_name" | "hash";
}

export interface TranscriptRecord {
  id: string;
  status: "queued" | "processing" | "completed" | "error";
  text?: string;
  audio_duration?: number;
  utterances?: Array<{
    speaker: string;
    text: string;
    start: number;
    end: number;
  }>;
  summary?: string;
  error?: string;
}

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

async function requestWithRetry<T>(
  apiKey: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  retries = 3
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    let response: Response;
    try {
      response = await fetch(`${DEFAULT_BASE_URL}${path}`, {
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
