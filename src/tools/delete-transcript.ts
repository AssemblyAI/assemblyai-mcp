import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { deleteTranscript } from "../assemblyai";
import { log, keyHash } from "../log";
import { handleToolError, requireApiKey } from "../tool-errors";
import { transcriptIdSchema } from "../transcript-id";

export function registerDeleteTranscript(server: McpServer): void {
  server.registerTool(
    "delete_transcript",
    {
      title: "Delete AssemblyAI Transcript",
      description:
        "PERMANENTLY delete a transcript and its associated data from AssemblyAI. Irreversible. " +
        "Only call this when the user explicitly asks for deletion (e.g. compliance cleanup after " +
        "processing) — never delete proactively.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        transcript_id: transcriptIdSchema("The id of the transcript to permanently delete."),
      },
    },
    async (args, extra) => {
      const start = Date.now();
      const apiKey = requireApiKey(extra);

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
        handleToolError(err, {
          tool: "delete_transcript",
          apiKey,
          start,
          transcriptId: args.transcript_id,
          notFoundMessage: `Transcript ${args.transcript_id} is already deleted or not found for this API key (404).`,
          errorEvent: "delete_error",
        });
      }
    }
  );
}
