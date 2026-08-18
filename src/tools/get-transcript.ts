import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { getTranscript, getRedactedAudio, AssemblyAIError, type TranscriptRecord } from "../assemblyai";
import { log, logError, keyHash } from "../log";
import {
  formatMs,
  renderTranslations,
  renderTranslatedUtterances,
  renderSpeechUnderstanding,
  renderContentSafety,
  renderTopics,
  renderHighlights,
  renderUnredactedText,
  renderRedactedAudio,
  renderWarnings,
  type SpeechUnderstandingResponse,
  type ContentSafetyLabels,
  type IabCategoriesResult,
  type AutoHighlightsResult,
  type TranslatedUtterance,
} from "../transcript-sections";

export function registerGetTranscript(server: McpServer): void {
  server.registerTool(
    "get_transcript",
    {
      title: "Get AssemblyAI Transcript",
      description:
        "Fetch the current state of a transcript by id. " +
        "Returns the full transcript when `status` is `completed`, an error message when `status` is `error`, " +
        "or just the in-progress status (`queued` / `processing`) otherwise. " +
        "Poll this tool every ~3 seconds after `submit_transcript` until you see `completed` or `error`.",
      inputSchema: {
        transcript_id: z
          .string()
          .describe("The transcript id returned by submit_transcript."),
      },
    },
    async (args, extra) => {
      const start = Date.now();
      const apiKey = extra.authInfo?.token;
      if (!apiKey) {
        throw new Error(
          "No AssemblyAI API key in request context. Configure your AssemblyAI API key " +
            "as the Bearer token in the Databricks HTTP connection."
        );
      }

      try {
        const record = await getTranscript(apiKey, args.transcript_id);
        let redactedAudioUrl: string | undefined;
        let redactedAudioPending = false;
        let redactedAudioError: string | undefined;
        if (record.status === "completed" && record.redact_pii_audio === true) {
          try {
            const audio = await getRedactedAudio(apiKey, args.transcript_id);
            redactedAudioUrl = audio.redacted_audio_url;
            redactedAudioPending = redactedAudioUrl === undefined;
          } catch (err) {
            // 400 (not ready yet) and "200 but no URL yet" both mean "keep
            // polling" — the existing pending note. Anything else (401/403/
            // 404/5xx/network, all surfaced as AssemblyAIError by
            // requestWithRetry) means the audio is genuinely unavailable
            // (e.g. the ~24h link expiry), which is a different message.
            if (err instanceof AssemblyAIError && err.status === 400) {
              redactedAudioPending = true;
            } else {
              redactedAudioError = err instanceof AssemblyAIError ? `HTTP ${err.status}` : "unknown error";
            }
            logError(
              {
                event: "redacted_audio_unavailable",
                level: "warn",
                tool: "get_transcript",
                keyHash: keyHash(apiKey),
                transcript_id: args.transcript_id,
                status: "error",
              },
              err
            );
          }
        }
        const shaped = shape(record, redactedAudioUrl);
        if (redactedAudioPending) shaped.redacted_audio_pending = true;
        if (redactedAudioError) shaped.redacted_audio_error = redactedAudioError;
        log({
          event: "tool_call",
          tool: "get_transcript",
          keyHash: keyHash(apiKey),
          transcript_id: record.id,
          assemblyai_status: record.status,
          status: "success",
          latencyMs: Date.now() - start,
        });
        return {
          content: [{ type: "text" as const, text: formatTranscript(shaped) }],
          structuredContent: shaped as unknown as Record<string, unknown>,
        };
      } catch (err) {
        if (err instanceof AssemblyAIError && err.status === 401) {
          logError(
            {
              event: "assemblyai_rejected_key",
              tool: "get_transcript",
              keyHash: keyHash(apiKey),
              latencyMs: Date.now() - start,
              status: "error",
            },
            err
          );
          throw new Error(
            "AssemblyAI rejected the API key (401). " +
              "Check the Bearer token configured in the Databricks HTTP connection."
          );
        }
        logError(
          {
            event: "tool_error",
            tool: "get_transcript",
            keyHash: keyHash(apiKey),
            latencyMs: Date.now() - start,
            status: "error",
          },
          err
        );
        throw err;
      }
    }
  );
}

interface ShapedTranscript {
  transcript_id: string;
  status: TranscriptRecord["status"];
  text?: string;
  speech_model_used?: string;
  audio_duration?: number;
  speakers?: TranslatedUtterance[];
  summary?: string;
  error?: string;
  sentiment?: Array<{ text: string; sentiment: string; confidence: number; start: number; end: number; speaker: string | null }>;
  entities?: Array<{ text: string; entity_type: string; start: number; end: number }>;
  translated_texts?: Record<string, string>;
  speech_understanding?: { request?: unknown; response?: SpeechUnderstandingResponse };
  content_safety_labels?: ContentSafetyLabels;
  iab_categories_result?: IabCategoriesResult;
  auto_highlights_result?: AutoHighlightsResult;
  unredacted_text?: string;
  redacted_audio_url?: string;
  redacted_audio_pending?: boolean;
  redacted_audio_error?: string;
  metadata?: { domain_used?: string | null; warnings?: Array<{ message: string }> };
}

function shape(record: TranscriptRecord, redactedAudioUrl?: string): ShapedTranscript {
  const out: ShapedTranscript = {
    transcript_id: record.id,
    status: record.status,
  };
  if (record.text !== undefined) out.text = record.text;
  if (record.speech_model_used !== undefined) out.speech_model_used = record.speech_model_used;
  if (record.audio_duration !== undefined) out.audio_duration = record.audio_duration;
  // != null (not !== undefined): an explicit `null` from the API means
  // "no data", same as the field being absent — don't leak it downstream.
  if (record.utterances != null && record.utterances.length > 0) out.speakers = record.utterances;
  if (record.summary !== undefined) out.summary = record.summary;
  if (record.error !== undefined) out.error = record.error;
  if (record.sentiment_analysis_results && record.sentiment_analysis_results.length > 0)
    out.sentiment = record.sentiment_analysis_results;
  if (record.entities && record.entities.length > 0) out.entities = record.entities;
  if (record.translated_texts != null) out.translated_texts = record.translated_texts;
  if (record.speech_understanding != null) out.speech_understanding = record.speech_understanding;
  if (record.content_safety_labels != null) out.content_safety_labels = record.content_safety_labels;
  if (record.iab_categories_result != null) out.iab_categories_result = record.iab_categories_result;
  if (record.auto_highlights_result != null) out.auto_highlights_result = record.auto_highlights_result;
  if (record.unredacted_text != null) out.unredacted_text = record.unredacted_text;
  if (redactedAudioUrl !== undefined) out.redacted_audio_url = redactedAudioUrl;
  if (record.metadata != null) out.metadata = record.metadata;
  return out;
}

/**
 * Format the transcript into the `content[].text` payload. Some MCP clients
 * (Databricks AI Playground at the time of writing) only surface this text
 * to the underlying model and ignore `structuredContent`. So everything the
 * agent might need — full text, per-speaker utterances with timestamps,
 * sentiment, entities, and summary — must appear here as plain text.
 */
function formatTranscript(s: ShapedTranscript): string {
  if (s.status === "error") {
    return `status=error transcript_id=${s.transcript_id} error="${s.error ?? ""}"`;
  }
  if (s.status !== "completed") {
    return `status=${s.status} transcript_id=${s.transcript_id}. Not finished yet — call get_transcript again with the same id in ~3 seconds.`;
  }

  const lines: string[] = [];
  lines.push(`status=completed transcript_id=${s.transcript_id}${s.speech_model_used ? ` speech_model_used=${s.speech_model_used}` : ""}${s.audio_duration !== undefined ? ` audio_duration=${s.audio_duration}s` : ""}`);

  if (s.text) {
    lines.push("");
    lines.push("--- text ---");
    lines.push(s.text);
  }

  if (s.speakers && s.speakers.length > 0) {
    lines.push("");
    lines.push("--- utterances (per-speaker segments; start/end are milliseconds from audio start) ---");
    for (const u of s.speakers) {
      lines.push(`[${u.speaker}] ${formatMs(u.start)}–${formatMs(u.end)}: ${u.text}`);
    }
  }

  if (s.sentiment && s.sentiment.length > 0) {
    lines.push("");
    lines.push("--- sentiment (per-sentence; start/end are mm:ss) ---");
    for (const r of s.sentiment) {
      const who = r.speaker ? ` (Speaker ${r.speaker})` : "";
      lines.push(`[${r.sentiment} ${r.confidence.toFixed(2)}] ${formatMs(r.start)}–${formatMs(r.end)}${who}: ${r.text}`);
    }
  }

  if (s.entities && s.entities.length > 0) {
    lines.push("");
    lines.push("--- entities ---");
    for (const e of s.entities) {
      lines.push(`${e.entity_type}: ${e.text}`);
    }
  }

  if (s.summary) {
    lines.push("");
    lines.push("--- summary ---");
    lines.push(s.summary);
  }

  if (s.translated_texts && Object.keys(s.translated_texts).length > 0) {
    lines.push(...renderTranslations(s.translated_texts));
  }
  if (s.speakers && s.speakers.some((u) => u.translated_texts && Object.keys(u.translated_texts).length > 0)) {
    lines.push(...renderTranslatedUtterances(s.speakers));
  }
  if (s.speech_understanding?.response) {
    lines.push(...renderSpeechUnderstanding(s.speech_understanding.response));
  }
  if (s.content_safety_labels?.summary && Object.keys(s.content_safety_labels.summary).length > 0) {
    lines.push(...renderContentSafety(s.content_safety_labels));
  }
  if (s.iab_categories_result?.summary && Object.keys(s.iab_categories_result.summary).length > 0) {
    lines.push(...renderTopics(s.iab_categories_result));
  }
  if (s.auto_highlights_result?.results && s.auto_highlights_result.results.length > 0) {
    lines.push(...renderHighlights(s.auto_highlights_result));
  }
  if (s.unredacted_text) {
    lines.push(...renderUnredactedText(s.unredacted_text));
  }
  if (s.metadata?.warnings && s.metadata.warnings.length > 0) {
    lines.push(...renderWarnings(s.metadata.warnings));
  }
  if (s.redacted_audio_url) {
    lines.push(...renderRedactedAudio(s.redacted_audio_url));
  } else if (s.redacted_audio_error) {
    lines.push(
      "",
      `(redacted audio unavailable (${s.redacted_audio_error}) — the link may have expired ~24h after transcription)`
    );
  } else if (s.redacted_audio_pending) {
    lines.push("", "(redacted audio not ready yet — call get_transcript again shortly)");
  }

  return lines.join("\n");
}
