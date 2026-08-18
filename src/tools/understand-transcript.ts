import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { understandTranscript } from "../llm-gateway";
import { speechUnderstandingSchema } from "../speech-understanding-schema";
import { renderTranslations, renderTranslatedUtterances, renderSpeechUnderstanding } from "../transcript-sections";
import { log, keyHash } from "../log";
import { handleToolError } from "../tool-errors";

export function registerUnderstandTranscript(server: McpServer): void {
  server.registerTool(
    "understand_transcript",
    {
      title: "Run Speech Understanding on a Transcript",
      description:
        "Run Speech Understanding features on an ALREADY-COMPLETED transcript without re-submitting " +
        "the audio: translation, speaker_identification, custom_formatting, summarization (chaptered, " +
        "with timestamps + headlines), and action_items. First submit_transcript, then poll " +
        "get_transcript until status=completed, then call this with the transcript_id. If the need is " +
        "known before transcription, prefer passing speech_understanding to submit_transcript instead. " +
        "speaker_identification (and translation's match_original_utterance) only work if the " +
        "transcript was created with speaker_labels=true.",
      inputSchema: {
        transcript_id: z
          .string()
          .describe("The id of a completed transcript (from submit_transcript / get_transcript)."),
        speech_understanding: speechUnderstandingSchema.describe(
          "Feature requests, e.g. { request: { translation: { target_languages: ['es'] } } }. " +
            "Multiple features may be combined in one call."
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
        const response = await understandTranscript(apiKey, {
          transcript_id: args.transcript_id,
          speech_understanding: args.speech_understanding,
        });
        log({
          event: "tool_call",
          tool: "understand_transcript",
          keyHash: keyHash(apiKey),
          transcript_id: args.transcript_id,
          status: "success",
          latencyMs: Date.now() - start,
        });

        const lines: string[] = [`transcript_id=${args.transcript_id}`];
        if (response.translated_texts && Object.keys(response.translated_texts).length > 0) {
          lines.push(...renderTranslations(response.translated_texts));
        }
        if (
          response.utterances &&
          response.utterances.some((u) => u.translated_texts && Object.keys(u.translated_texts).length > 0)
        ) {
          lines.push(...renderTranslatedUtterances(response.utterances));
        }
        if (response.speech_understanding?.response) {
          lines.push(...renderSpeechUnderstanding(response.speech_understanding.response));
        }
        if (lines.length === 1) {
          lines.push("", "(no feature results returned — check the requested features and transcript)");
        }
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          structuredContent: {
            transcript_id: args.transcript_id,
            translated_texts: response.translated_texts,
            speech_understanding: response.speech_understanding,
            utterances: response.utterances,
            request_id: response.request_id,
          },
        };
      } catch (err) {
        handleToolError(err, {
          tool: "understand_transcript",
          apiKey,
          start,
          transcriptId: args.transcript_id,
          notFoundMessage: `Transcript ${args.transcript_id} not found or deleted for this API key (404). Make sure it completed and belongs to the same key.`,
          rateLimitMessage:
            "Speech Understanding rate limit reached (30 requests/min on paid accounts, 2/min free). Retry shortly.",
          errorEvent: "understanding_error",
        });
      }
    }
  );
}
