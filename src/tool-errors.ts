/**
 * Shared 401/404/429 error mapping for the five AssemblyAI-backed tools.
 * Each tool used to hand-roll this switch, and the copies had drifted — most
 * notably, several tools' 401 branch omitted transcript_id from the log
 * payload while their 404/429 branches included it. Centralizing the mapping
 * here means all five tools log and word errors the same way, and future
 * drift has exactly one place to fix.
 */
import { AssemblyAIError } from "./assemblyai";
import { logError, keyHash } from "./log";

export interface ToolErrorContext {
  tool: string;
  apiKey: string;
  start: number;
  /** Included in every log payload below (including the 401 case) when provided. */
  transcriptId?: string;
  /** 404 message to throw. Omit to let a 404 rethrow as the raw AssemblyAIError (e.g. get_transcript). */
  notFoundMessage?: string;
  /** 429 message to throw. Omit to let a 429 rethrow as the raw AssemblyAIError. */
  rateLimitMessage?: string;
  /** Log event name for every branch except the 401 case (which always logs "assemblyai_rejected_key"). */
  errorEvent: string;
}

/** Maps a caught error to the tool's standard log + user-facing error, then throws. */
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
    throw new Error(
      "AssemblyAI rejected the API key (401). " +
        "Check the Bearer token configured in the Databricks HTTP connection."
    );
  }
  if (err instanceof AssemblyAIError && err.status === 404 && ctx.notFoundMessage) {
    logError({ ...payload, event: ctx.errorEvent }, err);
    throw new Error(ctx.notFoundMessage);
  }
  if (err instanceof AssemblyAIError && err.status === 429 && ctx.rateLimitMessage) {
    logError({ ...payload, event: ctx.errorEvent }, err);
    throw new Error(ctx.rateLimitMessage);
  }
  logError({ ...payload, event: ctx.errorEvent }, err);
  throw err;
}
