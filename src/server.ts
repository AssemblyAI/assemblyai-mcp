import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerSubmitTranscript } from "./tools/submit-transcript";
import { registerGetTranscript } from "./tools/get-transcript";
import { registerSummarizeTranscript } from "./tools/summarize-transcript";
import { registerUnderstandTranscript } from "./tools/understand-transcript";

/** Wire all tools onto an MCP server instance. */
export function registerTools(server: McpServer): void {
  registerSubmitTranscript(server);
  registerGetTranscript(server);
  registerSummarizeTranscript(server);
  registerUnderstandTranscript(server);
}
