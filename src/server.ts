import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerSubmitTranscript } from "./tools/submit-transcript";
import { registerGetTranscript } from "./tools/get-transcript";
import { registerSummarizeTranscript } from "./tools/summarize-transcript";
import { registerUnderstandTranscript } from "./tools/understand-transcript";
import { registerDeleteTranscript } from "./tools/delete-transcript";
import { registerCreateUploadUrl } from "./tools/create-upload-url";
import { registerCreateSpeech } from "./tools/create-speech";
import { uploadsConfigured } from "./upload-token";
import { ttsEnabled } from "./tts";

export function registerTools(server: McpServer): void {
  registerSubmitTranscript(server);
  registerGetTranscript(server);
  registerSummarizeTranscript(server);
  registerUnderstandTranscript(server);
  registerDeleteTranscript(server);
  if (uploadsConfigured()) registerCreateUploadUrl(server);
  if (ttsEnabled()) registerCreateSpeech(server);
}
