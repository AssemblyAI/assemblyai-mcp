import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { deleteTranscript, AssemblyAIError } from "../assemblyai";
import { log, logError, keyHash } from "../log";

export function registerDeleteTranscript(server: McpServer): void {
  server.registerTool(
    "delete_transcript",
    {
      title: "Delete AssemblyAI Transcript",
      description:
        "PERMANENTLY delete a transcript and its associated data from AssemblyAI. Irreversible. " +
        "Only call this when the user explicitly asks for deletion (e.g. compliance cleanup after " +
        "processing) — never delete proactively.",
      inputSchema: {
        transcript_id: z.string().describe("The id of the transcript to permanently delete."),
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
        await deleteTranscript(apiKey, args.transcript_id);
        log({
          event: "tool_call",
          tool: "delete_transcript",
          keyHash: keyHash(apiKey),
          transcript_id: args.transcript_id,
          status: "success",
          latencyMs: Date.now() - start,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `Deleted transcript ${args.transcript_id}. This is permanent — the transcript data is gone.`,
            },
          ],
          structuredContent: { transcript_id: args.transcript_id, deleted: true },
        };
      } catch (err) {
        if (err instanceof AssemblyAIError && err.status === 401) {
          logError(
            {
              event: "assemblyai_rejected_key",
              tool: "delete_transcript",
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
        if (err instanceof AssemblyAIError && err.status === 404) {
          logError(
            {
              event: "delete_error",
              tool: "delete_transcript",
              keyHash: keyHash(apiKey),
              transcript_id: args.transcript_id,
              latencyMs: Date.now() - start,
              status: "error",
            },
            err
          );
          throw new Error(
            `Transcript ${args.transcript_id} is already deleted or not found for this API key (404).`
          );
        }
        logError(
          {
            event: "delete_error",
            tool: "delete_transcript",
            keyHash: keyHash(apiKey),
            transcript_id: args.transcript_id,
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
