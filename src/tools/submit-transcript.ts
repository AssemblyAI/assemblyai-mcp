import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { submitTranscript } from "../assemblyai";
import { log, keyHash } from "../log";
import { publicOrigin } from "../origin";
import { speechUnderstandingSchema } from "../speech-understanding-schema";
import { handleToolError, requireApiKey } from "../tool-errors";
import { uploadsConfigured } from "../upload-token";

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

/** ChatGPT fills `_meta["openai/fileParams"]` params with this object; OpenAI's tool scan requires all four properties, with exactly download_url and file_id required. */
const chatgptFileSchema = z
  .looseObject({
    download_url: z.string(),
    file_id: z.string(),
    mime_type: z.string().optional(),
    file_name: z.string().optional(),
  })
  .describe(
    "ChatGPT only: a file the user attached in ChatGPT, filled in by ChatGPT. " +
      "Other clients: do not set this; pass a public URL in `audio_url`.",
  );

/** ChatGPT may send null or {} when nothing is attached. A preprocess, not `.nullish()`: OpenAI's tool scan needs a plain object schema. */
const chatgptFileParam = z.preprocess((value) => {
  if (value === null) return { download_url: "", file_id: "", _empty: "null" };
  if (typeof value === "object" && !Array.isArray(value)) {
    const file = value as { download_url?: unknown; file_id?: unknown };
    if (file.download_url === undefined || file.download_url === null || file.download_url === "") {
      return {
        ...file,
        download_url: "",
        file_id: typeof file.file_id === "string" ? file.file_id : "",
        _empty: "no_download_url",
      };
    }
  }
  return value;
}, chatgptFileSchema.optional());

class AudioSourceError extends Error {
  constructor(
    message: string,
    readonly reason: "none" | "conflict" | "bad_url" | "upload_link",
  ) {
    super(message);
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return ALLOWED_SCHEMES.has(parsed.protocol) && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

function validateAudioUrl(audioUrl: string): void {
  if (!isHttpUrl(audioUrl)) {
    throw new AudioSourceError(
      `audio_url must be an http:// or https:// URL, got ${JSON.stringify(audioUrl)}`,
      "bad_url",
    );
  }
}

const UPLOAD_LINK_PATH = /^\/upload\/[^/]+\/?$/i;
/** Division slash, fraction slash, big solidus and big reverse solidus. */
const SLASH_LOOKALIKES = /[\u2044\u2215\u29F8\u29F9]/g;

function routedPath(rawPath: string): string | undefined {
  let path = rawPath;
  for (let i = 0; i < 3; i++) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      return undefined;
    }
    if (decoded === path) break;
    path = decoded;
  }
  // Fold look-alike slashes into "/" so they can't hide the link (issue #107):
  // NFKC turns fullwidth "／" and "＼" into "/" and "\\"; the rest have no NFKC form.
  path = path.normalize("NFKC").replace(SLASH_LOOKALIKES, "/");
  const out: string[] = [];
  for (const segment of path.replace(/\\/g, "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }
  return `/${out.join("/")}${path.endsWith("/") && out.length > 0 ? "/" : ""}`;
}

function isOwnUploadLink(audioUrl: string, ownHosts: ReadonlySet<string>): boolean {
  try {
    const parsed = new URL(audioUrl);
    const hostname = parsed.hostname.replace(/\.+$/, "").toLowerCase();
    let ours = false;
    for (const own of ownHosts) {
      if (hostname === own.replace(/:\d+$/, "").replace(/\.+$/, "")) ours = true;
    }
    if (!ours) return false;
    const path = routedPath(parsed.pathname);
    // A path on our host that won't decode: refuse it if it could be the
    // link. Our hosts serve no audio, so this costs nothing real.
    if (path === undefined) return /upload/i.test(parsed.pathname);
    return UPLOAD_LINK_PATH.test(path);
  } catch {
    return false;
  }
}

type Headers = Record<string, string | string[] | undefined> | undefined;

function header(headers: Headers, name: string): string | undefined {
  const value = headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

function ownHostsOf(headers: Headers): Set<string> {
  const requestHost = new URL(publicOrigin(header(headers, "x-forwarded-host"), header(headers, "host"))).host;
  return new Set(["mcp.assemblyai.com", requestHost.toLowerCase()]);
}

function pickAudioUrl(
  audioUrl: string | undefined,
  fileUrl: string | undefined,
): { url: string; source: "audio_url" | "file" } {
  if (fileUrl) {
    // ||-style check: models often fill an unused optional param with "".
    if (!audioUrl || audioUrl === fileUrl || !isHttpUrl(audioUrl)) {
      return { url: fileUrl, source: "file" };
    }
    throw new AudioSourceError(
      "audio_url and file point to different files. Pass only one of them.",
      "conflict",
    );
  }
  if (audioUrl) return { url: audioUrl, source: "audio_url" };
  throw new AudioSourceError(
    "Pass audio_url: a public http(s) URL to the audio or video. " +
      "(In ChatGPT, an attached file goes in file.)",
    "none",
  );
}

export function registerSubmitTranscript(server: McpServer): void {
  server.registerTool(
    "submit_transcript",
    {
      title: "Submit AssemblyAI Transcript",
      description:
        "Submit a public audio or video URL to AssemblyAI for transcription: pass it in `audio_url`. " +
        (uploadsConfigured()
          ? "For a LOCAL file, first call `create_upload_url` and run its curl command, then pass the " +
            "`upload_url` that the command prints here as `audio_url`. "
          : "") +
        "In ChatGPT only, a file the user attached can go in `file` instead. If both are set, the file is " +
        "used, unless `audio_url` is a different http(s) URL: then the call is refused. " +
        "Returns immediately with a `transcript_id` and the current status (usually `queued`). " +
        "The caller MUST then call `get_transcript` with the returned id in a loop " +
        "(every ~3 seconds) until status becomes `completed` or `error`. " +
        "Do not expect the transcript text from this tool — only the id. " +
        "Enable `speaker_labels` whenever the user asks who said what or about speaker changes. " +
        "Enable `sentiment_analysis` for per-sentence positive/negative/neutral (English only), " +
        "`entity_detection` to extract named entities, and `redact_pii` to remove PII from the " +
        "transcript text. These features cannot be retro-fitted to a finished transcript — re-submit " +
        "with the flag set. For SUMMARIES do not set a flag here: after the transcript completes, " +
        "call the `summarize_transcript` tool.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: { "openai/fileParams": ["file"] },
      inputSchema: {
        audio_url: z
          .string()
          .optional()
          .describe(
            "Public http(s) URL to an audio or video file" +
              (uploadsConfigured()
                ? ", or, for a local file, the upload_url printed by create_upload_url's curl command " +
                  "(not the /upload/ link itself)."
                : ".") +
              " Omit when `file` is set; if both are set, the file is used."
          ),
        file: chatgptFileParam,
        speaker_labels: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Enable speaker diarization. Required if the user wants to know who said what, " +
              "when speakers change, or per-speaker timestamps. Adds an `utterances` block " +
              "to the eventual get_transcript response with start/end times per speaker."
          ),
        sentiment_analysis: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Enable Sentiment Analysis. English audio only; runs on the universal speech models. " +
              "Adds a per-sentence sentiment (POSITIVE/NEUTRAL/NEGATIVE) with confidence and " +
              "timestamps to the get_transcript response."
          ),
        entity_detection: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Enable Entity Detection. Extracts named entities (people, organizations, locations, " +
              "phone numbers, etc.) into the get_transcript response."
          ),
        redact_pii: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Enable PII redaction of the transcript text. Sensitive values are replaced before the " +
              "text is returned. Configure with redact_pii_policies and redact_pii_sub."
          ),
        redact_pii_policies: z
          .array(z.string())
          .optional()
          .describe(
            "Which PII categories to redact when redact_pii is true (e.g. person_name, phone_number, " +
              "email_address). Defaults to a common set if omitted."
          ),
        redact_pii_sub: z
          .enum(["entity_name", "hash"])
          .optional()
          .describe(
            "How redacted PII is substituted: 'entity_name' replaces with [PERSON_NAME] etc. (default), " +
              "'hash' replaces with #."
          ),
        summarization: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "DEPRECATED / no effect. Summaries are now produced by the `summarize_transcript` tool " +
              "after the transcript completes. Retained for compatibility only."
          ),
        punctuate: z
          .boolean()
          .optional()
          .describe("Default true. Set false for raw, unpunctuated/unformatted verbatim text."),
        format_text: z
          .boolean()
          .optional()
          .describe("Default true. Set false for raw, unpunctuated/unformatted verbatim text."),
        prompt: z
          .string()
          .optional()
          .describe(
            "Contextual DESCRIPTION of the audio (domain, scenario, or details — e.g. " +
              "'Cardiology consultation about chest pain'). Improves accuracy on AssemblyAI-STT-3.7. " +
              "NOT instructions: formatting/behavioral commands are ignored."
          ),
        keyterms_prompt: z
          .array(z.string())
          .optional()
          .describe(
            "Names/brands/domain terms to boost recognition (exact spelling). " +
              "Up to 1000 terms on assemblyai-stt-3-7, 200 on universal-2. Complementary with prompt."
          ),
        language_code: z
          .string()
          .optional()
          .describe("Language code of the audio (e.g. 'en_us', 'es', 'fr'). Defaults to en_us."),
        language_codes: z
          .array(z.string())
          .optional()
          .describe(
            "Languages for code-switching audio, e.g. ['en','es']. On assemblyai-stt-3-7, any number of supported languages " +
              "(English not required); on universal-2, at most two, one of them 'en'. " +
              "Don't combine with language_code or language_detection."
          ),
        language_detection: z
          .boolean()
          .optional()
          .describe("Auto-detect the spoken language. Needs ≥15s of speech for reliable results."),
        language_confidence_threshold: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Fail transcription if detected-language confidence is below this (0–1)."),
        speech_models: z
          .array(z.enum(["assemblyai-stt-3-7", "universal-2", "universal-3-5-pro"]))
          .min(1)
          .optional()
          .describe(
            "Priority-ordered model list. Default ['assemblyai-stt-3-7','universal-2'] (AssemblyAI-STT-3.7, with Universal-2 " +
              "for languages 3.7 doesn't support) is right for almost all cases. 'assemblyai-stt-3-7' runs for every " +
              "language it supports wherever it appears in the list, and keeps disfluencies (filler words) by default. " +
              "'universal-3-5-pro' is deprecated. Must not be empty — omit the field entirely to use the default."
          ),
        temperature: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Sampling randomness 0–1. Leave unset normally."),
        filter_profanity: z
          .boolean()
          .optional()
          .describe("Guardrail: replace profanity in the transcript text with asterisks."),
        speech_threshold: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe(
            "Guardrail: reject files whose spoken-audio fraction is below this (0–1); the transcript " +
              "then completes with an error message. Needs ≥30s of audio."
          ),
        content_safety: z
          .boolean()
          .optional()
          .describe(
            "Guardrail: detect sensitive content (hate speech, violence, drugs, …). Adds a " +
              "content_safety section to the get_transcript response."
          ),
        content_safety_confidence: z
          .number()
          .int()
          .min(25)
          .max(100)
          .optional()
          .describe("Confidence threshold (25–100, default 50) for content_safety labels."),
        redact_pii_audio: z
          .boolean()
          .optional()
          .describe(
            "Guardrail: also produce a redacted AUDIO file (PII beeped out). Retrieve the URL from " +
              "get_transcript once completed; the link expires after ~24h. Requires redact_pii=true."
          ),
        redact_pii_audio_quality: z
          .enum(["mp3", "wav"])
          .optional()
          .describe("Format of the redacted audio file (default mp3)."),
        redact_pii_return_unredacted: z
          .boolean()
          .optional()
          .describe(
            "Also return the ORIGINAL unredacted transcript alongside the redacted one. " +
              "Opts into receiving sensitive data — only set when the user explicitly needs it."
          ),
        multichannel: z
          .boolean()
          .optional()
          .describe("Transcribe each audio channel independently (speakers labeled '1A', '2A', …)."),
        disfluencies: z
          .boolean()
          .optional()
          .describe(
            "Keep filler words ('um', 'uh') in the transcript. Defaults to true with assemblyai-stt-3-7 (the default model), " +
              "which also keeps repetitions and false starts; set false for a cleaner transcript."
          ),
        audio_start_from: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Start transcribing at this offset, in milliseconds."),
        audio_end_at: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Stop transcribing at this offset, in milliseconds."),
        domain: z
          .string()
          .optional()
          .describe(
            "Domain add-on. 'medical-v1' enables Medical Mode (EN/ES/DE/FR only; separately billed; " +
              "silently skipped with a warning for other languages)."
          ),
        remove_audio_tags: z
          .enum(["all", "speaker"])
          .optional()
          .describe("Strip inline annotations: 'all' removes audio-event + speaker tags, 'speaker' only speaker cues."),
        iab_categories: z
          .boolean()
          .optional()
          .describe("Detect IAB topic categories. Adds a topics section to get_transcript."),
        auto_highlights: z
          .boolean()
          .optional()
          .describe("Extract key phrases. Adds a highlights section to get_transcript."),
        webhook_url: z
          .string()
          .optional()
          .describe(
            "URL AssemblyAI POSTs to when the transcript finishes. Most agent flows should poll " +
              "get_transcript instead — only set when the user runs their own webhook receiver."
          ),
        webhook_auth_header_name: z
          .string()
          .optional()
          .describe("Custom auth header name to send on the webhook request."),
        webhook_auth_header_value: z
          .string()
          .optional()
          .describe("Custom auth header value to send on the webhook request."),
        language_detection_options: z
          .looseObject({
            expected_languages: z.array(z.string()).optional().describe("Restrict detection to these codes."),
            fallback_language: z.string().optional().describe("Fallback code if detection fails."),
            code_switching: z.boolean().optional().describe("Detect language switches (universal-2 only; assemblyai-stt-3-7 code-switches natively)."),
            code_switching_confidence_threshold: z.number().min(0).max(1).optional(),
            localization: z
              .array(z.string())
              .optional()
              .describe("Regional English spelling: only 'en_au' and 'en_uk' accepted."),
          })
          .optional()
          .describe("Options refining language_detection."),
        speaker_options: z
          .looseObject({
            min_speakers_expected: z.number().int().min(1).optional(),
            max_speakers_expected: z.number().int().min(1).optional(),
          })
          .optional()
          .describe("Diarization hints; use with speaker_labels=true."),
        redact_pii_audio_options: z
          .looseObject({
            override_audio_redaction_method: z
              .enum(["silence"])
              .optional()
              .describe("Replace PII with silence instead of the default beep."),
            return_redacted_no_speech_audio: z
              .boolean()
              .optional()
              .describe("Also redact non-speech segments."),
          })
          .optional()
          .describe("Options for the redacted audio file (with redact_pii_audio=true)."),
        redact_static_entities: z
          .record(z.string(), z.array(z.string()))
          .optional()
          .describe(
            "Literal find-and-replace redaction on top of PII policies: label → exact terms, " +
              "e.g. {\"INTERNAL_TOOL\": [\"Bearclaw\"]}. Requires redact_pii=true."
          ),
        custom_spelling: z
          .array(
            z.object({
              from: z.array(z.string()).min(1).describe("Variants to replace (case-insensitive)."),
              to: z.string().describe("Replacement — single word, case-sensitive."),
            })
          )
          .optional()
          .describe("Spelling corrections applied to the transcript."),
        speech_understanding: speechUnderstandingSchema
          .optional()
          .describe(
            "Run Speech Understanding features (translation, speaker_identification, custom_formatting, " +
              "summarization, action_items) inline with transcription — results appear in get_transcript. " +
              "For an ALREADY-COMPLETED transcript use the understand_transcript tool instead of re-submitting."
          ),
      },
    },
    async (args, extra) => {
      const start = Date.now();
      const apiKey = requireApiKey(extra);

      let audioUrl: string;
      const fileUrl = args.file?.download_url || undefined;
      const sent = fileUrl ? (args.audio_url ? "both" : "file") : args.audio_url ? "audio_url" : "none";
      // `file` is a loose object: log fixed categories only, never a caller-set `_empty`.
      const fileParam = !args.file
        ? "absent"
        : fileUrl
          ? "set"
          : args.file._empty === "null"
            ? "null"
            : "no_download_url";
      let source: "audio_url" | "file";
      try {
        ({ url: audioUrl, source } = pickAudioUrl(args.audio_url, fileUrl));
        validateAudioUrl(audioUrl);
        // Do not echo our upload link: its token can upload into the user's account.
        if (isOwnUploadLink(audioUrl, ownHostsOf(extra.requestInfo?.headers))) {
          throw new AudioSourceError(
            "That is the upload link from create_upload_url, not the uploaded file. " +
              "Run the curl command it gave you with the file path, then pass the `upload_url` " +
              "that the command prints as audio_url.",
            "upload_link",
          );
        }
      } catch (err) {
        log({
          event: "bad_audio_url",
          tool: "submit_transcript",
          keyHash: keyHash(apiKey),
          latencyMs: Date.now() - start,
          status: "error",
          sent,
          file_param: fileParam,
          reason: err instanceof AudioSourceError ? err.reason : "unknown",
        });
        throw err;
      }

      try {
        const needsRedactPii = (
          [
            "redact_pii_policies",
            "redact_pii_sub",
            "redact_pii_audio",
            "redact_pii_audio_quality",
            "redact_pii_audio_options",
            "redact_pii_return_unredacted",
            "redact_static_entities",
          ] as const
        ).filter((k) => args[k]);
        if (!args.redact_pii && needsRedactPii.length > 0) {
          throw new Error(
            `${needsRedactPii.join(", ")} require redact_pii: true. Set redact_pii to enable redaction.`
          );
        }
        const { audio_url: _url, file: _file, summarization: _ignored, ...rest } = args;
        const record = await submitTranscript(apiKey, { audio_url: audioUrl, ...rest });
        log({
          event: "tool_call",
          tool: "submit_transcript",
          keyHash: keyHash(apiKey),
          transcript_id: record.id,
          status: "success",
          latencyMs: Date.now() - start,
          sent,
          file_param: fileParam,
          source,
        });
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Submitted. transcript_id=${record.id} status=${record.status}. ` +
                `Call get_transcript with this id every ~3s until status is completed or error.`,
            },
          ],
          structuredContent: {
            transcript_id: record.id,
            status: record.status,
            next_step: "Call get_transcript with this transcript_id every ~3s until status is completed or error.",
          },
        };
      } catch (err) {
        handleToolError(err, {
          tool: "submit_transcript",
          apiKey,
          start,
          errorEvent: "tool_error",
        });
      }
    }
  );
}
