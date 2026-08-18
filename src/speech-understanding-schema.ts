import { z } from "zod";

/**
 * The speech_understanding object accepted by POST /v2/transcript (inline) and
 * POST /v1/understanding (post-hoc) — identical shape, per the 2026-08-11
 * design spec. Typed for the five known features but open to unknown keys
 * inside `request` (z.looseObject): the public API treats the request body
 * as a loose dict and the LLM Gateway is the validator of record, so new API
 * features flow through without a server change. The outer envelope, though,
 * is a fixed shape — exactly `{ request }` — so it's a z.strictObject: a
 * feature key placed at the top level by mistake (outside `request`) is a
 * caller bug worth catching, not silently ignoring.
 */
export const speechUnderstandingSchema = z.strictObject({
  request: z
    .looseObject({
      translation: z
        .looseObject({
          target_languages: z
            .array(z.string())
            .min(1)
            .describe("Language codes to translate into, e.g. ['es','de']."),
          formal: z.boolean().optional().describe("Use formal pronouns/grammar."),
          match_original_utterance: z
            .boolean()
            .optional()
            .describe("Add translated_texts to each utterance. Requires speaker_labels=true."),
          force_translation: z
            .boolean()
            .optional()
            .describe("Translate even when the detected source language equals a target."),
        })
        .optional()
        .describe("Translate the transcript into one or more languages."),
      speaker_identification: z
        .looseObject({
          speaker_type: z.enum(["name", "role"]).describe("Map diarization labels to real names or to roles."),
          known_values: z
            .array(z.string())
            .optional()
            .describe("Known names/roles (≤35 chars each). Use known_values OR speakers, not both."),
          speakers: z
            .array(
              z.looseObject({
                name: z.string().optional(),
                role: z.string().optional(),
                description: z.string().optional(),
              })
            )
            .optional()
            .describe(
              "Richer metadata per speaker; each entry needs name (speaker_type='name') or role " +
                "(speaker_type='role'); extra custom fields allowed."
            ),
        })
        .optional()
        .describe("Requires the transcript to have speaker_labels=true."),
      custom_formatting: z
        .looseObject({
          date: z.string().optional().describe("Date FORMAT PATTERN string, e.g. 'mm/dd/yyyy' — not a boolean."),
          phone_number: z.string().optional().describe("Phone format pattern, e.g. '(xxx)xxx-xxxx'."),
          email: z.string().optional().describe("Email format pattern, e.g. 'username@domain.com'."),
          format_utterances: z.boolean().optional().describe("Also format utterance-level text."),
        })
        .optional()
        .describe("Reformat dates/phone numbers/emails in the transcript."),
      summarization: z
        .looseObject({
          summary_type: z.enum(["paragraph", "bullets"]).describe("Chapter summary style."),
          effort: z
            .enum(["low", "medium"])
            .optional()
            .describe("'medium' = higher quality for long (1.5h+) or multilingual audio; default 'low'."),
        })
        .optional()
        .describe("Chaptered summary with timestamps and headlines."),
      action_items: z
        .looseObject({
          include_decisions: z.boolean().optional().describe("Also capture decisions made in the conversation."),
          effort: z.enum(["low", "medium"]).optional(),
        })
        .optional()
        .describe("Extract action items with source quote + timestamp. Pass {} for defaults."),
    })
    .describe("Feature requests. This 'request' wrapper is required by the API."),
});
