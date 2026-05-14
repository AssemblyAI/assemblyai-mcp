import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { submitTranscript, AssemblyAIError } from "../assemblyai";
import { log, logError, keyHash } from "../log";

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

function validateAudioUrl(audioUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(audioUrl);
  } catch {
    throw new Error(`audio_url must be an http:// or https:// URL, got ${JSON.stringify(audioUrl)}`);
  }
  if (!ALLOWED_SCHEMES.has(parsed.protocol) || !parsed.hostname) {
    throw new Error(`audio_url must be an http:// or https:// URL, got ${JSON.stringify(audioUrl)}`);
  }
}

export function registerSubmitTranscript(server: McpServer): void {
  server.registerTool(
    "submit_transcript",
    {
      title: "Submit AssemblyAI Transcript",
      description:
        "Submit a public audio or video URL to AssemblyAI for transcription. " +
        "Returns immediately with a `transcript_id` and the current status (usually `queued`). " +
        "The caller MUST then call `get_transcript` with the returned id in a loop " +
        "(every ~3 seconds) until status becomes `completed` or `error`. " +
        "Do not expect the transcript text from this tool — only the id.",
      inputSchema: {
        audio_url: z
          .string()
          .describe("Public http(s) URL to an audio or video file."),
        speaker_labels: z
          .boolean()
          .optional()
          .default(false)
          .describe("If true, AssemblyAI returns per-speaker utterances."),
        summarization: z
          .boolean()
          .optional()
          .default(false)
          .describe("If true, AssemblyAI auto-generates a bulleted summary."),
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
        validateAudioUrl(args.audio_url);
      } catch (err) {
        log({
          event: "bad_audio_url",
          tool: "submit_transcript",
          keyHash: keyHash(apiKey),
          latencyMs: Date.now() - start,
          status: "error",
        });
        throw err;
      }

      try {
        const record = await submitTranscript(apiKey, {
          audio_url: args.audio_url,
          speaker_labels: args.speaker_labels,
          summarization: args.summarization,
        });
        log({
          event: "tool_call",
          tool: "submit_transcript",
          keyHash: keyHash(apiKey),
          transcript_id: record.id,
          status: "success",
          latencyMs: Date.now() - start,
        });
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Submitted. transcript_id=${record.id} status=${record.status}. ` +
                `Call get_transcript with this id every ~3s until status is completed or error.`,
            },
          ],
          structuredContent: {
            transcript_id: record.id,
            status: record.status,
          },
        };
      } catch (err) {
        if (err instanceof AssemblyAIError && err.status === 401) {
          logError(
            {
              event: "assemblyai_rejected_key",
              tool: "submit_transcript",
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
            tool: "submit_transcript",
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
