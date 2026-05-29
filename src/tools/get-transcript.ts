import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { getTranscript, AssemblyAIError, type TranscriptRecord } from "../assemblyai";
import { log, logError, keyHash } from "../log";

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
        const shaped = shape(record);
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
  audio_duration?: number;
  speakers?: Array<{ speaker: string; text: string; start: number; end: number }>;
  summary?: string;
  error?: string;
  sentiment?: Array<{ text: string; sentiment: string; confidence: number; start: number; end: number; speaker: string | null }>;
  entities?: Array<{ text: string; entity_type: string; start: number; end: number }>;
}

function shape(record: TranscriptRecord): ShapedTranscript {
  const out: ShapedTranscript = {
    transcript_id: record.id,
    status: record.status,
  };
  if (record.text !== undefined) out.text = record.text;
  if (record.audio_duration !== undefined) out.audio_duration = record.audio_duration;
  if (record.utterances && record.utterances.length > 0) out.speakers = record.utterances;
  if (record.summary !== undefined) out.summary = record.summary;
  if (record.error !== undefined) out.error = record.error;
  if (record.sentiment_analysis_results && record.sentiment_analysis_results.length > 0)
    out.sentiment = record.sentiment_analysis_results;
  if (record.entities && record.entities.length > 0) out.entities = record.entities;
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
  lines.push(`status=completed transcript_id=${s.transcript_id}${s.audio_duration !== undefined ? ` audio_duration=${s.audio_duration}s` : ""}`);

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

  return lines.join("\n");
}

function formatMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
