import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { getTranscript, getRedactedAudio, AssemblyAIError, type TranscriptRecord } from "../assemblyai";
import { log, logError, keyHash } from "../log";
import { handleToolError, requireApiKey } from "../tool-errors";
import {
  formatMs,
  renderTranslations,
  renderTranslatedUtterances,
  renderSpeechUnderstanding,
  renderContentSafety,
  renderContentSafetyEvidence,
  renderEntityEvidence,
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
import { transcriptIdSchema } from "../transcript-id";

export function registerGetTranscript(server: McpServer): void {
  server.registerTool(
    "get_transcript",
    {
      title: "Get AssemblyAI Transcript",
      description:
        "Fetch the current state of a transcript by id. " +
        "Returns the full transcript when `status` is `completed`, an error message when `status` is `error`, " +
        "or just the in-progress status (`queued` / `processing`) otherwise. " +
        "Poll this tool every ~3 seconds after `submit_transcript` until you see `completed` or `error`. " +
        "Per-word timestamps are left out unless you set `include_words` (only for word-level tasks such as subtitles); " +
          "they come per utterance with speaker_labels, otherwise as a top-level `words` list.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        transcript_id: transcriptIdSchema("The transcript id returned by submit_transcript."),
        include_words: z
          .boolean()
          .optional()
          .describe(
            "Also return per-word timestamps: inside each utterance for speaker_labels transcripts, " +
              "otherwise as a top-level `words` list. " +
              "Large: about 17 KB per minute of audio. Leave unset unless the task needs word-level timing."
          ),
      },
    },
    async (args, extra) => {
      const start = Date.now();
      const apiKey = requireApiKey(extra);

      try {
        const record = await getTranscript(apiKey, args.transcript_id);
        let redactedAudioUrl: string | undefined;
        let redactedAudioPending = false;
        let redactedAudioError: string | undefined;
        if (record.status === "completed" && record.redact_pii_audio === true) {
          try {
            const audio = await getRedactedAudio(apiKey, args.transcript_id);
            redactedAudioUrl =
              typeof audio.redacted_audio_url === "string" && audio.redacted_audio_url.length > 0
                ? audio.redacted_audio_url
                : undefined;
            redactedAudioPending = redactedAudioUrl === undefined;
          } catch (err) {
            // 400, 200 with no URL, or 504 from our own deadline means not ready yet; any other failure means unavailable (the link expires after ~24h).
            if (err instanceof AssemblyAIError && (err.status === 400 || err.status === 504)) {
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
        const shaped = shape(record, redactedAudioUrl, args.include_words === true);
        if (redactedAudioPending) shaped.redacted_audio_pending = true;
        if (redactedAudioError) shaped.redacted_audio_error = redactedAudioError;
        if (shaped.status === "queued" || shaped.status === "processing") {
          shaped.next_step = "Not finished yet. Call get_transcript again with the same transcript_id in ~3 seconds.";
        } else if (redactedAudioPending) {
          shaped.next_step = "The redacted audio is not ready yet. Call get_transcript again shortly to get redacted_audio_url.";
        }
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
        handleToolError(err, {
          tool: "get_transcript",
          apiKey,
          start,
          transcriptId: args.transcript_id,
          rateLimitMessage:
            "Rate limited by AssemblyAI. Wait ~60 seconds before calling get_transcript again — much longer than the usual ~3 seconds.",
          errorEvent: "tool_error",
        });
      }
    }
  );
}

type WordTiming = NonNullable<NonNullable<TranscriptRecord["utterances"]>[number]["words"]>[number];

interface ShapedTranscript {
  transcript_id: string;
  status: TranscriptRecord["status"];
  text?: string;
  language_code?: string;
  language_confidence?: number;
  language_detection?: boolean;
  speech_model_used?: string;
  audio_duration?: number;
  speakers?: Array<TranslatedUtterance & { words?: WordTiming[] }>;
  words?: WordTiming[];
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
  /** Claude Code shows the model only structuredContent. */
  next_step?: string;
  metadata?: { domain_used?: string | null; warnings?: Array<string | { message: string }> };
}

function shape(record: TranscriptRecord, redactedAudioUrl?: string, includeWords = false): ShapedTranscript {
  const out: ShapedTranscript = {
    transcript_id: record.id,
    status: record.status,
  };
  if (record.text !== undefined) out.text = record.text;
  if (record.language_code != null) out.language_code = record.language_code;
  if (record.language_confidence != null) out.language_confidence = record.language_confidence;
  if (record.language_detection != null) out.language_detection = record.language_detection;
  if (record.speech_model_used !== undefined) out.speech_model_used = record.speech_model_used;
  if (record.audio_duration !== undefined) out.audio_duration = record.audio_duration;
  // The API sends explicit nulls for missing data.
  if (record.utterances != null && record.utterances.length > 0) {
    out.speakers = includeWords ? record.utterances : record.utterances.map(({ words: _words, ...u }) => u);
  } else if (includeWords && record.words != null && record.words.length > 0) {
    // No speaker_labels: utterances are null and the words only exist at the top level.
    out.words = record.words;
  }
  if (record.summary !== undefined) out.summary = record.summary;
  if (record.error !== undefined) out.error = record.error;
  if (record.sentiment_analysis_results && record.sentiment_analysis_results.length > 0)
    out.sentiment = record.sentiment_analysis_results;
  if (record.entities && record.entities.length > 0) out.entities = record.entities;
  if (record.translated_texts != null) out.translated_texts = record.translated_texts;
  if (record.speech_understanding != null) {
    const su = record.speech_understanding;
    const formatting = su.response?.custom_formatting;
    // Clone only the affected path: preserve every other SU field and never
    // mutate the API response when applying the per-word opt-in.
    out.speech_understanding = !includeWords && formatting?.formatted_utterances
      ? {
          ...su,
          response: {
            ...su.response,
            custom_formatting: {
              ...formatting,
              formatted_utterances: formatting.formatted_utterances.map(({ words: _words, ...u }) => u),
            },
          },
        }
      : su;
  }
  if (record.content_safety_labels != null) out.content_safety_labels = record.content_safety_labels;
  if (record.iab_categories_result != null) out.iab_categories_result = record.iab_categories_result;
  if (record.auto_highlights_result != null) out.auto_highlights_result = record.auto_highlights_result;
  if (record.unredacted_text != null) out.unredacted_text = record.unredacted_text;
  if (redactedAudioUrl !== undefined) out.redacted_audio_url = redactedAudioUrl;
  if (record.metadata != null) out.metadata = record.metadata;
  return out;
}

/** Some MCP clients show the model only content[].text, so everything the agent needs must appear here. */
function formatTranscript(s: ShapedTranscript): string {
  if (s.status === "error") {
    return `status=error transcript_id=${s.transcript_id} error="${s.error ?? ""}"`;
  }
  if (s.status !== "completed") {
    return `status=${s.status} transcript_id=${s.transcript_id}. Not finished yet — call get_transcript again with the same id in ~3 seconds.`;
  }

  const lines: string[] = [];
  lines.push(`status=completed transcript_id=${s.transcript_id}${s.speech_model_used ? ` speech_model_used=${s.speech_model_used}` : ""}${s.audio_duration !== undefined ? ` audio_duration=${s.audio_duration}s` : ""}`);

  if (s.language_code !== undefined) lines.push(`language_code=${s.language_code}`);
  if (s.language_confidence !== undefined) lines.push(`language_confidence=${s.language_confidence}`);
  if (s.language_detection !== undefined) lines.push(`language_detection=${s.language_detection}`);

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

  if (s.speakers && s.speakers.some((u) => u.words && u.words.length > 0)) {
    lines.push("");
    lines.push("--- words (start/end are milliseconds from audio start) ---");
    for (const u of s.speakers) {
      for (const w of u.words ?? []) lines.push(`[${w.speaker ?? u.speaker}] ${w.start}–${w.end}: ${w.text}`);
    }
  } else if (s.words && s.words.length > 0) {
    lines.push("");
    lines.push("--- words (start/end are milliseconds from audio start) ---");
    for (const w of s.words) lines.push(`${w.speaker ? `[${w.speaker}] ` : ""}${w.start}–${w.end}: ${w.text}`);
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
    lines.push(...renderEntityEvidence(s.entities));
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
  if (s.content_safety_labels && (
    (s.content_safety_labels.status !== undefined && s.content_safety_labels.status !== "success") ||
    (s.content_safety_labels.summary && Object.keys(s.content_safety_labels.summary).length > 0)
  )) {
    lines.push(...renderContentSafety(s.content_safety_labels));
  }
  if (s.content_safety_labels) {
    lines.push(...renderContentSafetyEvidence(s.content_safety_labels));
  }
  if (s.iab_categories_result && (
    (s.iab_categories_result.status !== undefined && s.iab_categories_result.status !== "success") ||
    (s.iab_categories_result.summary && Object.keys(s.iab_categories_result.summary).length > 0)
  )) {
    lines.push(...renderTopics(s.iab_categories_result));
  }
  if (s.auto_highlights_result && (
    (s.auto_highlights_result.status !== undefined && s.auto_highlights_result.status !== "success") ||
    (s.auto_highlights_result.results && s.auto_highlights_result.results.length > 0)
  )) {
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
