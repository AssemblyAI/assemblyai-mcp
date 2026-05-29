import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { AssemblyAIError } from "../assemblyai";
import { summarizeViaLlmGateway, LLM_GATEWAY_MODEL } from "../llm-gateway";
import { log, logError, keyHash } from "../log";

const STYLE_PROMPTS: Record<string, string> = {
  bullets:
    "Provide a brief summary of the transcript in bullet-point format. Focus on the key points and main takeaways.",
  paragraph:
    "Provide a concise paragraph summary of the transcript. Capture the main topics and conclusions.",
  headline: "Provide a single-sentence headline that captures the main topic of the transcript.",
  action_items:
    "List the action items mentioned in the transcript as bullet points. If there are none, say so.",
};

export function registerSummarizeTranscript(server: McpServer): void {
  server.registerTool(
    "summarize_transcript",
    {
      title: "Summarize AssemblyAI Transcript",
      description:
        "Generate a summary of a COMPLETED transcript using AssemblyAI's LLM Gateway. " +
        "First submit_transcript, then poll get_transcript until status=completed, then call this " +
        "with the transcript_id. Choose a `style` or pass a `custom_prompt` for a tailored summary.",
      inputSchema: {
        transcript_id: z
          .string()
          .describe("The id of a completed transcript (from submit_transcript / get_transcript)."),
        style: z
          .enum(["bullets", "paragraph", "headline", "action_items", "custom"])
          .optional()
          .default("bullets")
          .describe("Summary style. Use 'custom' together with custom_prompt for a tailored summary."),
        custom_prompt: z
          .string()
          .optional()
          .describe("Instruction used when style='custom' (or to override the canned style prompt)."),
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

      if (args.style === "custom" && !args.custom_prompt) {
        throw new Error(
          "style='custom' requires a custom_prompt. Either provide custom_prompt or choose a built-in style (bullets, paragraph, headline, action_items)."
        );
      }

      const prompt: string =
        args.custom_prompt ??
        (args.style != null ? STYLE_PROMPTS[args.style] : undefined) ??
        // STYLE_PROMPTS.bullets is always defined — the key is a literal in STYLE_PROMPTS.
        (STYLE_PROMPTS.bullets as string);

      try {
        const summary = await summarizeViaLlmGateway(apiKey, {
          transcript_id: args.transcript_id,
          prompt,
        });
        log({
          event: "tool_call",
          tool: "summarize_transcript",
          keyHash: keyHash(apiKey),
          transcript_id: args.transcript_id,
          status: "success",
          latencyMs: Date.now() - start,
        });
        return {
          content: [{ type: "text" as const, text: summary }],
          structuredContent: {
            transcript_id: args.transcript_id,
            summary,
            style: args.style,
            model: LLM_GATEWAY_MODEL,
          },
        };
      } catch (err) {
        if (err instanceof AssemblyAIError && err.status === 401) {
          logError(
            {
              event: "assemblyai_rejected_key",
              tool: "summarize_transcript",
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
              event: "llm_gateway_error",
              tool: "summarize_transcript",
              keyHash: keyHash(apiKey),
              transcript_id: args.transcript_id,
              latencyMs: Date.now() - start,
              status: "error",
            },
            err
          );
          throw new Error(
            `LLM Gateway could not find transcript ${args.transcript_id} (404). ` +
              "Make sure it has completed and belongs to this API key."
          );
        }
        logError(
          {
            event: "llm_gateway_error",
            tool: "summarize_transcript",
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
