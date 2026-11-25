import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { log, keyHash } from "../log";
import { publicOrigin } from "../origin";
import { createUploadToken, MAX_UPLOAD_BYTES, UPLOAD_TTL_MS } from "../upload-token";
import { requireApiKey } from "../tool-errors";

type Headers = Record<string, string | string[] | undefined> | undefined;

function header(headers: Headers, name: string): string | undefined {
  const value = headers?.[name];
  return Array.isArray(value) ? value[0] : value;
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
        "Then call `submit_transcript` with that printed `upload_url` as `audio_url` (not the link itself). The file goes to the user's " +
        "private AssemblyAI storage, not a public host. Files up to 4.5 MB; the link expires in 10 minutes.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: {},
    },
    async (_args, extra) => {
      const start = Date.now();
      const apiKey = requireApiKey(extra);

      const { token, expiresAt } = createUploadToken(apiKey);
      const headers = extra.requestInfo?.headers;
      const origin = publicOrigin(header(headers, "x-forwarded-host"), header(headers, "host"));
      const host = new URL(origin).host;
      const uploadLink = `${origin}/upload/${token}`;
      // No --fail-with-body: it needs curl 7.76+.
      // Without Content-Type curl sends form-urlencoded, and Vercel rejects most binary bodies of that type over ~270 KB.
      const command = `curl -sS -X POST -H 'Content-Type: application/octet-stream' --data-binary @"/path/to/file" '${uploadLink.replaceAll("'", "'\\''")}'`;
      log({
        event: "tool_call",
        tool: "create_upload_url",
        keyHash: keyHash(apiKey),
        status: "success",
        latencyMs: Date.now() - start,
      });
      // Claude Code shows the model only structuredContent.
      const guidance =
        `It prints {"upload_url": "..."}. Pass that printed upload_url (not this link) as audio_url to submit_transcript. ` +
        `If it prints {"error": ...} instead, follow the message. If it prints "Bad request", ` +
        `make sure the command still has -H 'Content-Type: application/octet-stream' and run it again. ` +
        `If it prints "Request Entity Too Large" ` +
        `or the error says the file is too large, the file is over 4.5 MB: compress it ` +
        `(e.g. ffmpeg -i in -ac 1 -b:a 32k out.mp3) or ask the user for a public URL. ` +
        `If curl cannot connect at all (e.g. "Could not resolve host", "Connection refused", ` +
        `or a 403 from a proxy saying the host is not allowed), your environment blocks ${host}: ` +
        `do not retry or work around it. Tell the user to allow ${host} in their client's network ` +
        `settings (claude.ai: Settings > Capabilities), or to give a public URL, or to run this ` +
        `from a local client such as Claude Code. ` +
        `Do not show this link to anyone: it uploads into the user's account.`;
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Upload link created (expires in ${UPLOAD_TTL_MS / 60000} minutes, files up to 4.5 MB). ` +
              `Replace /path/to/file and run:\n\n${command}\n\n` +
              guidance,
          },
        ],
        structuredContent: {
          upload_link: uploadLink,
          method: "POST",
          expires_at: new Date(expiresAt).toISOString(),
          max_bytes: MAX_UPLOAD_BYTES,
          command,
          next_step: `Replace /path/to/file in command with the file path and run it. ${guidance}`,
        },
      };
    }
  );
}
