/**
 * AssemblyAI LLM Gateway wrapper. Used for summaries today (and, later, Q&A /
 * translation) so we stay off the deprecated transcript-level summarization
 * params. Same pass-through API key as the REST API; different host.
 *
 * Pass a `transcript_id` and include the `{{ transcript }}` tag in the prompt —
 * the Gateway substitutes the transcript's text server-side, so transcript text
 * never has to round-trip through this server.
 */
import { requestWithRetry } from "./assemblyai";
import type { SpeechUnderstandingResponse } from "./transcript-sections";

const DEFAULT_LLM_GATEWAY_BASE_URL =
  process.env.ASSEMBLYAI_LLM_GATEWAY_BASE_URL ?? "https://llm-gateway.assemblyai.com";

export const LLM_GATEWAY_MODEL = "claude-sonnet-4-6";

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

export interface SummarizeOptions {
  transcript_id: string;
  prompt: string;
  model?: string;
  maxTokens?: number;
}

export async function summarizeViaLlmGateway(
  apiKey: string,
  options: SummarizeOptions
): Promise<string> {
  const body = {
    model: options.model ?? LLM_GATEWAY_MODEL,
    messages: [{ role: "user", content: `${options.prompt}\n\n{{ transcript }}` }],
    transcript_id: options.transcript_id,
    max_tokens: options.maxTokens ?? 1000,
  };
  const data = await requestWithRetry<ChatCompletionResponse>(
    apiKey,
    "POST",
    "/v1/chat/completions",
    body,
    3,
    DEFAULT_LLM_GATEWAY_BASE_URL
  );
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("LLM Gateway returned no summary content.");
  }
  return content;
}

export interface UnderstandOptions {
  transcript_id: string;
  speech_understanding: { request: Record<string, unknown> };
}

export interface UnderstandingResponse {
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

/** Post-hoc Speech Understanding on a completed transcript. */
export async function understandTranscript(
  apiKey: string,
  options: UnderstandOptions
): Promise<UnderstandingResponse> {
  // retries=1: POST /v1/understanding is a billable, non-idempotent Speech
  // Understanding run — retrying it on a transient 5xx would double-charge
  // and could return two divergent results, unlike the read-only GETs.
  return requestWithRetry<UnderstandingResponse>(
    apiKey,
    "POST",
    "/v1/understanding",
    { transcript_id: options.transcript_id, speech_understanding: options.speech_understanding },
    1,
    DEFAULT_LLM_GATEWAY_BASE_URL
  );
}
