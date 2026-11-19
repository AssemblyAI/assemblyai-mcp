import { z } from "zod";

/**
 * AssemblyAI transcript ids are UUID-like strings: letters, digits, "-" and
 * "_". Anything else is refused before it reaches a URL path. In particular,
 * encodeURIComponent leaves "." untouched, so an id of ".." would make fetch
 * normalize `/v2/transcript/..` to `/v2/` and send the request (DELETE
 * included) to another endpoint (issue #73).
 */
export const TRANSCRIPT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function isValidTranscriptId(id: unknown): id is string {
  return typeof id === "string" && TRANSCRIPT_ID_PATTERN.test(id);
}

/** Zod schema for a transcript_id tool argument. */
export function transcriptIdSchema(description: string) {
  return z
    .string()
    .regex(TRANSCRIPT_ID_PATTERN, "transcript_id must be the id returned by submit_transcript (letters, digits, '-' and '_' only).")
    .describe(description);
}
