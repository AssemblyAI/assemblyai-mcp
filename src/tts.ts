/**
 * Thin wrapper around the AssemblyAI Streaming TTS HTTP API and the token
 * host. Like ./assemblyai, it is stateless: the API key comes in per call.
 *
 * The base URLs are read per call, so a deployment (or a test) can point them
 * at another data zone or a fake.
 */
import { AssemblyAIError, requestWithRetry } from "./assemblyai";

/** The tool is only offered where the deployment turns it on. */
export function ttsEnabled(): boolean {
  return process.env.TTS_ENABLED === "1";
}

export function ttsBaseUrl(): string {
  return process.env.ASSEMBLYAI_TTS_BASE_URL ?? "https://tts.us.assemblyai.com";
}

function tokenBaseUrl(): string {
  return process.env.ASSEMBLYAI_TOKEN_BASE_URL ?? "https://token.us.assemblyai.com";
}

/** The API's own limit: 1 to 5,000 Unicode code points per request. */
export const MAX_SPEECH_CHARS = 5000;

/**
 * Inline audio goes back through the MCP response as base64, and a client may
 * hand it to the model. 1,000 characters is about a minute of speech: about
 * 400 KB of MP3 at INLINE_BIT_RATE. Longer text goes to a file instead.
 */
export const MAX_INLINE_SPEECH_CHARS = 1000;
export const INLINE_BIT_RATE = 48000;
/** A guard for the response size, should the audio be longer than expected. */
export const MAX_INLINE_AUDIO_BYTES = 1_500_000;

/** How long the token in a curl command stays valid. */
export const SPEECH_TOKEN_TTL_SECONDS = 300;

// Below the MCP route's 60 s maxDuration.
const SPEECH_TIMEOUT_MS = 50_000;

export const SPEECH_LANGUAGES = ["english", "spanish", "german", "italian", "portuguese", "french"] as const;
export type SpeechLanguage = (typeof SPEECH_LANGUAGES)[number];
export type SpeechFormat = "mp3" | "wav";

export class TtsError extends AssemblyAIError {
  /** The API's stable, machine-readable code, e.g. `voice_not_found`. */
  code: string | undefined;
  retryAfterSeconds: number | undefined;

  constructor(message: string, status: number, code?: string, retryAfterSeconds?: number) {
    super(message, status);
    this.name = "TtsError";
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface SpeechOptions {
  text: string;
  voice_id?: string;
  language?: SpeechLanguage;
  format: SpeechFormat;
  bit_rate?: number;
}

/** The JSON body of POST /v1/speech. Buffered: a whole file with exact sizes, never cut. */
export function speechRequestBody(options: SpeechOptions): Record<string, unknown> {
  const body: Record<string, unknown> = { text: options.text };
  if (options.voice_id) body.voice_id = options.voice_id;
  if (options.language) body.language = options.language;
  if (options.format === "wav") {
    body.encoding = "pcm_s16le";
    body.container = "wav";
  } else {
    body.encoding = "mp3";
    if (options.bit_rate) body.bit_rate = options.bit_rate;
  }
  body.stream = false;
  return body;
}

export interface SpeechResult {
  audio: Buffer;
  mimeType: string;
  voiceId: string | undefined;
  language: string | undefined;
  billedCharacters: number | undefined;
  durationMs: number | undefined;
}

function numberHeader(response: Response, name: string): number | undefined {
  const raw = response.headers.get(name);
  if (raw === null || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

async function ttsError(response: Response): Promise<TtsError> {
  const text = await response.text();
  let code: string | undefined;
  let message = text.slice(0, 500);
  let retryAfter = numberHeader(response, "retry-after");
  try {
    const body = JSON.parse(text);
    if (body && typeof body === "object") {
      if (typeof body.code === "string") code = body.code;
      if (typeof body.message === "string") message = body.message;
      if (typeof body.retry_after_seconds === "number") retryAfter = body.retry_after_seconds;
    }
  } catch {
    // Not JSON: a proxy's HTML page. Keep the status and the start of the text.
  }
  return new TtsError(`HTTP ${response.status}: ${message}`, response.status, code, retryAfter);
}

/**
 * Synthesize the whole clip. Not retried: an error status costs nothing, and
 * the caller (an agent) can decide to call again.
 */
export async function createSpeech(apiKey: string, options: SpeechOptions): Promise<SpeechResult> {
  const response = await fetch(`${ttsBaseUrl()}/v1/speech`, {
    method: "POST",
    headers: { Authorization: apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(speechRequestBody(options)),
    signal: AbortSignal.timeout(SPEECH_TIMEOUT_MS),
  });
  if (!response.ok) throw await ttsError(response);
  return {
    audio: Buffer.from(await response.arrayBuffer()),
    mimeType: ((response.headers.get("content-type") ?? "audio/mpeg").split(";")[0] ?? "audio/mpeg").trim(),
    voiceId: response.headers.get("x-tts-voice-id") ?? undefined,
    language: response.headers.get("x-tts-language") ?? undefined,
    billedCharacters: numberHeader(response, "x-tts-billed-characters"),
    durationMs: numberHeader(response, "x-tts-audio-duration-ms"),
  };
}

/**
 * A short-lived token that can only call Streaming TTS. It goes into the curl
 * command we hand out, so the API key itself never does.
 */
export async function createTtsToken(apiKey: string, expiresInSeconds: number): Promise<string> {
  const { token } = await requestWithRetry<{ token?: string }>(
    apiKey,
    "POST",
    "/v1/token",
    { product: "tts", expires_in_seconds: expiresInSeconds },
    2,
    tokenBaseUrl()
  );
  if (typeof token !== "string" || token.length === 0) {
    throw new AssemblyAIError("The token service returned no token.", 502);
  }
  return token;
}
