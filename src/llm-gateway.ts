/** The Gateway substitutes the `{{ transcript }}` tag with transcript_id's text server-side. */
import { requestWithRetry } from "./assemblyai";
import type { SpeechUnderstandingResponse } from "./transcript-sections";

const DEFAULT_LLM_GATEWAY_BASE_URL =
  process.env.ASSEMBLYAI_LLM_GATEWAY_BASE_URL ?? "https://llm-gateway.assemblyai.com";

export const LLM_GATEWAY_MODEL = "claude-sonnet-4-6";

/**
 * LLM calls can run longer than the 60 s request budget (deadline.ts leaves
 * the 300 s Fluid compute platform limit above it so they are not cut off).
 * Give them their own deadline below that platform limit instead.
 */
export const LLM_GATEWAY_TIMEOUT_MS = 240_000;

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

interface SummarizeOptions {
  transcript_id: string;
  prompt: string;
}

export async function summarizeViaLlmGateway(
  apiKey: string,
  options: SummarizeOptions
): Promise<string> {
  const promptContent = options.prompt.includes("{{ transcript }}")
    ? options.prompt
    : `${options.prompt}\n\n{{ transcript }}`;
  const body = {
    model: LLM_GATEWAY_MODEL,
    messages: [{ role: "user", content: promptContent }],
    transcript_id: options.transcript_id,
    max_tokens: 1000,
  };
  // retries=1: POST /v1/chat/completions is billable and non-idempotent; a retry on 5xx could double-charge.
  const data = await requestWithRetry<ChatCompletionResponse>(
    apiKey,
    "POST",
    "/v1/chat/completions",
    body,
    1,
    DEFAULT_LLM_GATEWAY_BASE_URL,
    LLM_GATEWAY_TIMEOUT_MS
  );
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("LLM Gateway returned no summary content.");
  }
  return content;
}

interface UnderstandOptions {
  transcript_id: string;
  speech_understanding: { request: Record<string, unknown> };
}

interface UnderstandingResponse {
  request_id?: string;
  translated_texts?: Record<string, string>;
  utterances?: Array<{
    speaker: string;
    text: string;
    start: number;
    end: number;
    translated_texts?: Record<string, string>;
  }>;
  speech_understanding?: { response?: SpeechUnderstandingResponse };
}

export async function understandTranscript(
  apiKey: string,
  options: UnderstandOptions
): Promise<UnderstandingResponse> {
  // retries=1: POST /v1/understanding is billable and non-idempotent; a retry on 5xx could double-charge.
  return requestWithRetry<UnderstandingResponse>(
    apiKey,
    "POST",
    "/v1/understanding",
    { transcript_id: options.transcript_id, speech_understanding: options.speech_understanding },
    1,
    DEFAULT_LLM_GATEWAY_BASE_URL,
    LLM_GATEWAY_TIMEOUT_MS
  );
}
