import { z } from "zod";

/** encodeURIComponent leaves "." alone, so ".." would make fetch normalize `/v2/transcript/..` to `/v2/`. */
export const TRANSCRIPT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function isValidTranscriptId(id: unknown): id is string {
  return typeof id === "string" && TRANSCRIPT_ID_PATTERN.test(id);
}

export function transcriptIdSchema(description: string) {
  return z
    .string()
    .regex(TRANSCRIPT_ID_PATTERN, "transcript_id must be the id returned by submit_transcript (letters, digits, '-' and '_' only).")
    .describe(description);
}
