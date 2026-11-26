import { AssemblyAIError } from "./assemblyai";
import { resolveHttpsUrl } from "./config";

export function ttsEnabled(): boolean {
  return process.env.TTS_ENABLED === "1";
}

export function ttsBaseUrl(): string {
  return resolveHttpsUrl("ASSEMBLYAI_TTS_BASE_URL", "https://tts.us.assemblyai.com", { allowHttpLocalhost: true });
}

function tokenBaseUrl(): string {
  return resolveHttpsUrl("ASSEMBLYAI_TOKEN_BASE_URL", "https://token.us.assemblyai.com", { allowHttpLocalhost: true });
}

/** The API's own limit: 1 to 5,000 Unicode code points per request. */
export const MAX_SPEECH_CHARS = 5000;

export const MAX_INLINE_SPEECH_CHARS = 1000;
export const INLINE_BIT_RATE = 48000;
export const MAX_INLINE_AUDIO_BYTES = 1_500_000;

export const SPEECH_TOKEN_TTL_SECONDS = 300;

export const SPEECH_TIMEOUT_MS = 50_000;

export const TOKEN_DEADLINE_MS = 15_000;
const TOKEN_ATTEMPTS = 2;
const TOKEN_BACKOFF_MS = 1_000;

export const SPEECH_LANGUAGES = ["english", "spanish", "german", "italian", "portuguese", "french"] as const;
export type SpeechLanguage = (typeof SPEECH_LANGUAGES)[number];

/** Not the whole catalog: the API has no endpoint to list voices, so an unknown voice ID only gets a warning. */
export const KNOWN_VOICES: Readonly<Record<string, SpeechLanguage>> = {
  "aai-aaliyah": "english", "aai-abdiel": "english", "aai-annabelle": "english", "aai-april": "english",
  "aai-audrey": "english", "aai-buford": "english", "aai-carrie": "english", "aai-cloyd": "english",
  "aai-dorsey": "english", "aai-ernest": "english", "aai-ewald": "english", "aai-gunnar": "english",
  "aai-hailey": "english", "aai-kyla": "english", "aai-lilla": "english", "aai-nancy": "english",
  "aai-percival": "english", "aai-peter": "english", "aai-sara": "english", "aai-steven": "english",
  "aai-titus": "english", "aai-troy": "english", "aai-yasmin": "english",
  "aai-antonioluis": "spanish", "aai-constanza": "spanish", "aai-malvina": "spanish", "aai-oriol": "spanish",
  "aai-gunther": "german", "aai-jorg": "german", "aai-magdalena": "german",
  "aai-giada": "italian", "aai-donatien": "french", "aai-benicio": "portuguese", "aai-nelson": "portuguese",
};
type SpeechFormat = "mp3" | "wav";

export class TtsError extends AssemblyAIError {
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

interface SpeechResult {
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
  }
  return new TtsError(`HTTP ${response.status}: ${message}`, response.status, code, retryAfter);
}

/** The speech was already synthesized, so it was billed. */
export class AudioTooLargeError extends Error {
  constructor(
    readonly bytes: number,
    readonly exact: boolean
  ) {
    super(`The audio is ${exact ? "" : "more than "}${bytes} bytes.`);
    this.name = "AudioTooLargeError";
  }
}

async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = numberHeader(response, "content-length");
  if (declared !== undefined && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new AudioTooLargeError(declared, true);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new AudioTooLargeError(maxBytes, false);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

export interface SpeechLimits {
  timeoutMs?: number;
  maxBytes?: number;
}

/** Not retried: an error status costs nothing, and the calling agent can call again. */
export async function createSpeech(
  apiKey: string,
  options: SpeechOptions,
  limits: SpeechLimits = {}
): Promise<SpeechResult> {
  const response = await fetch(`${ttsBaseUrl()}/v1/speech`, {
    method: "POST",
    headers: { Authorization: apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(speechRequestBody(options)),
    signal: AbortSignal.timeout(limits.timeoutMs ?? SPEECH_TIMEOUT_MS),
  });
  if (!response.ok) throw await ttsError(response);
  return {
    audio:
      limits.maxBytes === undefined
        ? Buffer.from(await response.arrayBuffer())
        : await readCapped(response, limits.maxBytes),
    mimeType: ((response.headers.get("content-type") ?? "audio/mpeg").split(";")[0] ?? "audio/mpeg").trim(),
    voiceId: response.headers.get("x-tts-voice-id") ?? undefined,
    language: response.headers.get("x-tts-language") ?? undefined,
    billedCharacters: numberHeader(response, "x-tts-billed-characters"),
    durationMs: numberHeader(response, "x-tts-audio-duration-ms"),
  };
}

// product: "tts" alone does not keep the token off the LLM Gateway, so deny it explicitly.
export const TTS_TOKEN_ACCESS = {
  tts: { enabled: true },
  llm_gateway: { enabled: false },
} as const;

export async function createTtsToken(
  apiKey: string,
  expiresInSeconds: number,
  deadlineMs: number = TOKEN_DEADLINE_MS
): Promise<string> {
  // Retrying is safe here: a token costs nothing, unlike the speech itself.
  const signal = AbortSignal.timeout(deadlineMs);
  let lastError: unknown;
  for (let attempt = 0; attempt < TOKEN_ATTEMPTS; attempt++) {
    try {
      if (attempt > 0) await sleepUnlessAborted(TOKEN_BACKOFF_MS, signal);
      const response = await fetch(`${tokenBaseUrl()}/v1/token`, {
        method: "POST",
        headers: { Authorization: apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ product: "tts", expires_in_seconds: expiresInSeconds, access: TTS_TOKEN_ACCESS }),
        signal,
      });
      if (response.status >= 500) {
        lastError = new AssemblyAIError(await errorMessage(response), response.status);
        continue;
      }
      if (!response.ok) {
        const message = await errorMessage(response);
        // The token host answers a bad key with 404 "Invalid API key"; report it as the 401 it is.
        const status = response.status === 404 && /invalid api key/i.test(message) ? 401 : response.status;
        throw new AssemblyAIError(message, status);
      }
      const { token } = (await response.json()) as { token?: unknown };
      if (typeof token !== "string" || token.length === 0) {
        throw new AssemblyAIError("The token service returned no token.", 502);
      }
      return token;
    } catch (err) {
      if (err instanceof AssemblyAIError) throw err;
      if (signal.aborted) {
        throw new AssemblyAIError(
          `The token service did not answer within ${deadlineMs / 1000} seconds. ` +
            "This is temporary; nothing was billed. Call again once; if it fails again, tell the user.",
          504
        );
      }
      lastError = err;
    }
  }
  if (lastError instanceof AssemblyAIError) throw lastError;
  throw new AssemblyAIError(`The token service could not be reached: ${String(lastError)}`, 502);
}

async function errorMessage(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const body = JSON.parse(text);
    for (const key of ["error", "message", "detail"] as const) {
      if (body && typeof body === "object" && typeof body[key] === "string") {
        return `HTTP ${response.status}: ${body[key]}`;
      }
    }
  } catch {
  }
  return `HTTP ${response.status}: ${text.slice(0, 500)}`;
}

function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
