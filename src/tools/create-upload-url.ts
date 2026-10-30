import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { log, keyHash } from "../log";
import { createUploadToken, MAX_UPLOAD_BYTES, UPLOAD_TTL_MS } from "../upload-token";

const FALLBACK_ORIGIN = "https://mcp.assemblyai.com";

type Headers = Record<string, string | string[] | undefined> | undefined;

function header(headers: Headers, name: string): string | undefined {
  const value = headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

// Same rule as the homepage: only an exact local host gets http.
function originFrom(headers: Headers): string {
  const host = header(headers, "x-forwarded-host") ?? header(headers, "host");
  if (!host) return FALLBACK_ORIGIN;
  const hostname = host.split(":")[0];
  const proto = hostname === "localhost" || hostname === "127.0.0.1" ? "http" : "https";
  return `${proto}://${host}`;
}

export function registerCreateUploadUrl(server: McpServer): void {
  server.registerTool(
    "create_upload_url",
    {
      title: "Create AssemblyAI Upload Link",
      description:
        "Use this when the user wants to transcribe a LOCAL file (on their computer), not a public URL. " +
        "Returns a short-lived link and a ready-to-run `curl` command. Run the command with the file path " +
        "(you need shell access, e.g. in Claude Code, Cursor or Codex); it prints JSON with an `upload_url`. " +
        "Then call `submit_transcript` with that `upload_url` as `audio_url`. The file goes to the user's " +
        "private AssemblyAI storage, not a public host. Files up to 4.5 MB; the link expires in 10 minutes.",
      // Only mints a link; nothing changes until the agent uploads to it.
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
      inputSchema: {},
    },
    async (_args, extra) => {
      const start = Date.now();
      const apiKey = extra.authInfo?.token;
      if (!apiKey) {
        throw new Error(
          "No AssemblyAI API key in request context. Configure your AssemblyAI API key " +
            "as the Bearer token in your MCP client connection."
        );
      }

      const { token, expiresAt } = createUploadToken(apiKey);
      const uploadUrl = `${originFrom(extra.requestInfo?.headers)}/upload/${token}`;
      const command = `curl -sS --fail-with-body -X POST --data-binary @"/path/to/file" "${uploadUrl}"`;
      log({
        event: "tool_call",
        tool: "create_upload_url",
        keyHash: keyHash(apiKey),
        status: "success",
        latencyMs: Date.now() - start,
      });
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Upload link created (expires in ${UPLOAD_TTL_MS / 60000} minutes, files up to 4.5 MB). ` +
              `Replace /path/to/file and run:\n\n${command}\n\n` +
              `It prints {"upload_url": "..."}. Pass that upload_url as audio_url to submit_transcript. ` +
              `If it fails with 413 or "Request Entity Too Large", the file is over 4.5 MB: compress it ` +
              `(e.g. ffmpeg -i in -ac 1 -b:a 32k out.mp3) or ask the user for a public URL. ` +
              `Do not show this link to anyone: it uploads into the user's account.`,
          },
        ],
        structuredContent: {
          upload_url: uploadUrl,
          method: "POST",
          expires_at: new Date(expiresAt).toISOString(),
          max_bytes: MAX_UPLOAD_BYTES,
          command,
        },
      };
    }
  );
}
