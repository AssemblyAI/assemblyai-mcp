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
        "Do not expect the transcript text from this tool — only the id. " +
        "Enable `speaker_labels` whenever the user asks who said what or about speaker changes. " +
        "Enable `sentiment_analysis` for per-sentence positive/negative/neutral (English only), " +
        "`entity_detection` to extract named entities, and `redact_pii` to remove PII from the " +
        "transcript text. These features cannot be retro-fitted to a finished transcript — re-submit " +
        "with the flag set. For SUMMARIES do not set a flag here: after the transcript completes, " +
        "call the `summarize_transcript` tool.",
      inputSchema: {
        audio_url: z
          .string()
          .describe("Public http(s) URL to an audio or video file."),
        speaker_labels: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Enable speaker diarization. Required if the user wants to know who said what, " +
              "when speakers change, or per-speaker timestamps. Adds an `utterances` block " +
              "to the eventual get_transcript response with start/end times per speaker."
          ),
        sentiment_analysis: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Enable Sentiment Analysis. English audio only. Adds a per-sentence sentiment " +
              "(POSITIVE/NEUTRAL/NEGATIVE) with confidence and timestamps to the get_transcript response."
          ),
        entity_detection: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Enable Entity Detection. Extracts named entities (people, organizations, locations, " +
              "phone numbers, etc.) into the get_transcript response."
          ),
        redact_pii: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Enable PII redaction of the transcript text. Sensitive values are replaced before the " +
              "text is returned. Configure with redact_pii_policies and redact_pii_sub."
          ),
        redact_pii_policies: z
          .array(z.string())
          .optional()
          .describe(
            "Which PII categories to redact when redact_pii is true (e.g. person_name, phone_number, " +
              "email_address). Defaults to a common set if omitted."
          ),
        redact_pii_sub: z
          .enum(["entity_name", "hash"])
          .optional()
          .describe(
            "How redacted PII is substituted: 'entity_name' replaces with [PERSON_NAME] etc. (default), " +
              "'hash' replaces with #."
          ),
        summarization: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "DEPRECATED / no effect. Summaries are now produced by the `summarize_transcript` tool " +
              "after the transcript completes. Retained for compatibility only."
          ),
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
          sentiment_analysis: args.sentiment_analysis,
          entity_detection: args.entity_detection,
          redact_pii: args.redact_pii,
          redact_pii_policies: args.redact_pii_policies,
          redact_pii_sub: args.redact_pii_sub,
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
