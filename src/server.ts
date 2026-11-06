import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerSubmitTranscript } from "./tools/submit-transcript";
import { registerGetTranscript } from "./tools/get-transcript";
import { registerSummarizeTranscript } from "./tools/summarize-transcript";
import { registerUnderstandTranscript } from "./tools/understand-transcript";
import { registerDeleteTranscript } from "./tools/delete-transcript";
import { registerCreateUploadUrl } from "./tools/create-upload-url";
import { uploadsConfigured } from "./upload-token";

/** Wire all tools onto an MCP server instance. */
export function registerTools(server: McpServer): void {
  registerSubmitTranscript(server);
  registerGetTranscript(server);
  registerSummarizeTranscript(server);
  registerUnderstandTranscript(server);
  registerDeleteTranscript(server);
  // Only offered when the deployment can sign upload links.
  if (uploadsConfigured()) registerCreateUploadUrl(server);
}
