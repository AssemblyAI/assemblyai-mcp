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
          content: [{ type: "text" as const, text: summarize(shaped) }],
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
  return out;
}

function summarize(s: ShapedTranscript): string {
  if (s.status === "completed") {
    return `status=completed text="${(s.text ?? "").slice(0, 200)}${(s.text ?? "").length > 200 ? "..." : ""}"`;
  }
  if (s.status === "error") {
    return `status=error ${s.error ?? ""}`;
  }
  return `status=${s.status}. Not finished yet — call get_transcript again in ~3 seconds.`;
}
