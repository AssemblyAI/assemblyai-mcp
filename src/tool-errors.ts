import { AssemblyAIError } from "./assemblyai";
import { logError, keyHash } from "./log";

interface ToolErrorContext {
  tool: string;
  apiKey: string;
  start: number;
  transcriptId?: string;
  notFoundMessage?: string;
  rateLimitMessage?: string | ((retryAfterSeconds: number | undefined) => string);
  errorEvent: string;
}

/** Shown on a 401 from AssemblyAI. It covers API-key users and OAuth (Claude.ai) users, who set no Bearer token. */
export const REJECTED_KEY_MESSAGE =
  "AssemblyAI rejected the API key (401). " +
  "Check the Bearer token configured in your MCP client connection (or re-authenticate if connected via Claude.ai).";

export function requireApiKey(extra: { authInfo?: { token: string } }): string {
  const apiKey = extra.authInfo?.token;
  if (!apiKey) {
    throw new Error(
      "No AssemblyAI API key in request context. Configure your AssemblyAI API key " +
        "as the Bearer token in your MCP client connection (or re-authenticate if using Claude.ai)."
    );
  }
  return apiKey;
}

export function handleToolError(err: unknown, ctx: ToolErrorContext): never {
  const payload: Record<string, unknown> = {
    tool: ctx.tool,
    keyHash: keyHash(ctx.apiKey),
    latencyMs: Date.now() - ctx.start,
    status: "error",
  };
  if (ctx.transcriptId !== undefined) payload.transcript_id = ctx.transcriptId;

  if (err instanceof AssemblyAIError && err.status === 401) {
    logError({ ...payload, event: "assemblyai_rejected_key" }, err);
    throw new Error(REJECTED_KEY_MESSAGE);
  }
  if (err instanceof AssemblyAIError && err.status === 404 && ctx.notFoundMessage) {
    logError({ ...payload, event: ctx.errorEvent }, err);
    throw new Error(ctx.notFoundMessage);
  }
  if (err instanceof AssemblyAIError && err.status === 429 && ctx.rateLimitMessage) {
    logError({ ...payload, event: ctx.errorEvent }, err);
    throw new Error(
      typeof ctx.rateLimitMessage === "function"
        ? ctx.rateLimitMessage(err.retryAfterSeconds)
        : ctx.rateLimitMessage
    );
  }
  logError({ ...payload, event: ctx.errorEvent }, err);
  // Gateway reasons can echo caller input, so they go to the caller only, never to the log.
  if (err instanceof AssemblyAIError && err.detail) {
    throw new AssemblyAIError(`${err.message} (${err.detail})`, err.status, err.transcriptId);
  }
  throw err;
}
