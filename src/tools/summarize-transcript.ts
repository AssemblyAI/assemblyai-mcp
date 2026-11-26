import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { summarizeViaLlmGateway, LLM_GATEWAY_MODEL } from "../llm-gateway";
import { log, keyHash } from "../log";
import { handleToolError, requireApiKey } from "../tool-errors";
import { transcriptIdSchema } from "../transcript-id";

const STYLE_PROMPTS = {
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
        "with the transcript_id. Choose a `style` or pass a `custom_prompt` for a tailored summary." +
        " For a CHAPTERED summary with timestamps/headlines, or decision-aware action items, use the " +
        "`understand_transcript` tool (summarization / action_items features) instead — this tool is " +
        "the freeform/custom-prompt option.",
      annotations: {
        // Not read-only: every call is a billable LLM Gateway run, so clients should ask first (issue #100).
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        transcript_id: transcriptIdSchema("The id of a completed transcript (from submit_transcript / get_transcript)."),
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
      const apiKey = requireApiKey(extra);

      // ||-style check: models often fill an unused optional param with "", and a
      // blank custom_prompt would reach the gateway as a prompt with no instruction.
      const customPrompt = args.custom_prompt?.trim() ? args.custom_prompt : undefined;

      if (args.style === "custom" && !customPrompt) {
        throw new Error(
          "style='custom' requires a custom_prompt. Either provide custom_prompt or choose a built-in style (bullets, paragraph, headline, action_items)."
        );
      }

      const prompt = customPrompt ?? STYLE_PROMPTS[args.style === "custom" ? "bullets" : args.style];

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
        handleToolError(err, {
          tool: "summarize_transcript",
          apiKey,
          start,
          transcriptId: args.transcript_id,
          notFoundMessage: `LLM Gateway could not find transcript ${args.transcript_id} (404). Make sure it has completed and belongs to this API key.`,
          rateLimitMessage:
            "Speech Understanding rate limit reached (30 requests/min on paid accounts, 2/min free). Retry shortly.",
          errorEvent: "llm_gateway_error",
        });
      }
    }
  );
}
