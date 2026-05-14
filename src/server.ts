import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerSubmitTranscript } from "./tools/submit-transcript";
import { registerGetTranscript } from "./tools/get-transcript";

/** Wire both tools onto an MCP server instance. */
export function registerTools(server: McpServer): void {
  registerSubmitTranscript(server);
  registerGetTranscript(server);
}
