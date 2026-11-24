import { randomBytes } from "node:crypto";

import { REJECTED_KEY_MESSAGE, requireApiKey } from "../tool-errors";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { AssemblyAIError } from "../assemblyai";
import { remainingMs, RETURN_RESERVE_MS } from "../deadline";
import { log, logError, keyHash } from "../log";
import {
  AudioTooLargeError,
  createSpeech,
  createTtsToken,
  INLINE_BIT_RATE,
  KNOWN_VOICES,
  MAX_INLINE_AUDIO_BYTES,
  MAX_INLINE_SPEECH_CHARS,
  MAX_SPEECH_CHARS,
  SPEECH_LANGUAGES,
  type SpeechLanguage,
  SPEECH_TIMEOUT_MS,
  SPEECH_TOKEN_TTL_SECONDS,
  speechRequestBody,
  TOKEN_DEADLINE_MS,
  ttsBaseUrl,
  TtsError,
} from "../tts";

export const MIN_SPEECH_MS = 10_000;
export const MIN_TOKEN_MS = 3_000;

const VOICE_CATALOG = "https://www.assemblyai.com/dashboard/text-to-speech/voices";

class Refusal extends Error {}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** A PowerShell literal. PowerShell also reads the Unicode single quotes as quote marks. */
function powershellQuote(value: string): string {
  return `'${value.replace(/['\u2018\u2019\u201A\u201B]/g, "$&$&")}'`;
}

function knownVoiceLanguage(voiceId: string): SpeechLanguage | undefined {
  return Object.hasOwn(KNOWN_VOICES, voiceId) ? KNOWN_VOICES[voiceId] : undefined;
}

function voicesFor(language: SpeechLanguage): string[] {
  return Object.entries(KNOWN_VOICES)
    .filter(([, lang]) => lang === language)
    .map(([id]) => id);
}

/** SSML is not supported: the tags would be spoken, and billed. */
function looksLikeSsml(text: string): boolean {
  return /^\s*<speak[\s>/]/i.test(text);
}

/** The API counts Unicode code points, not UTF-16 units. */
function countChars(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

function hintFor(err: TtsError): string {
  switch (err.code) {
    case "voice_not_found":
      return ` Leave voice_id out for the default voice, or ask the user to copy a voice ID from ${VOICE_CATALOG}.`;
    case "insufficient_funds":
      return " The AssemblyAI account has no funds for text to speech. Tell the user; do not retry.";
    case "biometric_terms_not_accepted":
    case "voice_expired":
    case "voice_blocked":
      return " This is about the user's cloned voice and needs the user, in the AssemblyAI dashboard. Do not retry; offer a library voice instead.";
    case "rate_limited":
    case "at_capacity":
      return ` Wait ${err.retryAfterSeconds ?? 5} seconds, then call again once.`;
    default:
      return err.status >= 500 ? " This is temporary. Call again once; if it fails again, tell the user." : "";
  }
}

export function registerCreateSpeech(server: McpServer): void {
  server.registerTool(
    "create_speech",
    {
      title: "Create Speech with AssemblyAI (Text to Speech)",
      description:
        "Use this when the user explicitly asks to turn text into spoken audio (text to speech): " +
        "\"read this aloud\", a voice-over, a spoken version of a summary. " +
        "COST: speech is billed to the user's AssemblyAI account per character of `text`, so do not call it " +
        "unless the user asked for audio, and do not call it again for the same text. " +
        `Two ways to get the audio, chosen with \`delivery\`. "file" (default; you need shell access, e.g. Claude Code, ` +
        `Cursor or Codex): returns a ready-to-run \`curl\` command that saves the audio as a file on the user's computer; ` +
        `text up to ${MAX_SPEECH_CHARS} characters, and nothing is billed until the command runs. ` +
        `"inline" (no shell, e.g. a chat app): returns the audio itself as MP3 in this response; text up to ` +
        `${MAX_INLINE_SPEECH_CHARS} characters (about a minute), billed when you call. ` +
        "For longer text, split it at sentence ends and make one call per part. " +
        "Languages: English, Spanish, German, Italian, Portuguese, French. " +
        "Do not add markup or SSML; write the text as it should be spoken.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        text: z
          .string()
          .min(1)
          .max(
            MAX_SPEECH_CHARS * 2,
            `text is too long: the limit is ${MAX_SPEECH_CHARS} characters with delivery "file" and ` +
              `${MAX_INLINE_SPEECH_CHARS} with "inline". Split it at sentence ends and call once per part.`
          )
          .describe(
            `The text to speak, as it should be said. Up to ${MAX_SPEECH_CHARS} characters with delivery "file", ` +
              `${MAX_INLINE_SPEECH_CHARS} with "inline".`
          ),
        voice_id: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[A-Za-z0-9_-]+$/, "A voice ID is letters, digits, '-' and '_' only.")
          .optional()
          .describe(
            "The voice. Leave out for the default voice of the language (English: aai-kyla). " +
              "Some library voices: aai-kyla, aai-sara, aai-peter, aai-titus (American English); aai-carrie, aai-buford (British English); " +
              "aai-steven (Australian English); aai-constanza, aai-antonioluis (Spanish); aai-magdalena, aai-jorg (German); " +
              "aai-giada (Italian); aai-donatien (French); aai-benicio, aai-nelson (Portuguese). " +
              `The full catalog, and the user's own cloned voices, are at ${VOICE_CATALOG}. ` +
              "Only use a voice ID from this list or one the user gave you; do not guess one."
          ),
        language: z
          .enum(SPEECH_LANGUAGES)
          .optional()
          .describe("The language of the text. Leave out for English, or for the voice's own language when voice_id is set."),
        format: z
          .enum(["mp3", "wav"])
          .optional()
          .describe('The audio file format with delivery "file": "mp3" (default, small) or "wav" (uncompressed). Inline audio is always MP3.'),
        delivery: z
          .enum(["file", "inline"])
          .optional()
          .describe(
            '"file" (default): get a curl command that saves the audio locally; needs shell access. ' +
              '"inline": get the audio in this response; for clients without a shell.'
          ),
      },
    },
    async (args, extra) => {
      const start = Date.now();
      const apiKey = requireApiKey(extra);

      const delivery = args.delivery ?? "file";
      const format = args.format ?? "mp3";
      const chars = countChars(args.text);
      // The text is customer content: log its size, never the text.
      const base = {
        tool: "create_speech",
        keyHash: keyHash(apiKey),
        delivery,
        format,
        chars,
        voice_id: args.voice_id ?? null,
        language: args.language ?? null,
      };
      const refuse = (reason: string, message: string): never => {
        log({ ...base, event: "tool_call", level: "warn", status: "rejected", reason, latencyMs: Date.now() - start });
        throw new Refusal(message);
      };

      if (args.text.trim() === "") refuse("blank_text", "text is blank. Pass the words to speak.");
      const limit = delivery === "inline" ? MAX_INLINE_SPEECH_CHARS : MAX_SPEECH_CHARS;
      if (chars > limit) {
        refuse(
          "text_too_long",
          `text is ${chars} characters; the limit with delivery "${delivery}" is ${limit}. ` +
            (delivery === "inline"
              ? `Split it at sentence ends into parts of at most ${limit} characters and call once per part` +
                `, or use delivery "file" (up to ${MAX_SPEECH_CHARS}) if you have shell access.`
              : `Split it at sentence ends into parts of at most ${limit} characters and call once per part.`)
        );
      }
      if (looksLikeSsml(args.text)) {
        refuse(
          "ssml",
          "text starts with <speak>: SSML is not supported, and the tags would be spoken and billed. " +
            "Remove all markup and pass only the words to speak. Nothing was billed."
        );
      }
      if (delivery === "inline" && format === "wav") {
        refuse("inline_wav", 'Inline audio is always MP3. Leave format out, or use delivery "file" for a WAV file.');
      }
      // The API still bills a known voice given another language, with the wrong accent.
      const voiceLanguage = args.voice_id !== undefined ? knownVoiceLanguage(args.voice_id) : undefined;
      if (voiceLanguage !== undefined && args.language !== undefined && voiceLanguage !== args.language) {
        refuse(
          "voice_language_mismatch",
          `voice_id "${args.voice_id}" speaks ${voiceLanguage}, but language is "${args.language}". ` +
            `For ${args.language} text, leave voice_id out for the default ${args.language} voice, or use one of: ` +
            `${voicesFor(args.language).join(", ")}. ` +
            `For ${voiceLanguage} text, set language to "${voiceLanguage}" or leave it out. Nothing was billed.`
        );
      }

      const budget = remainingMs() - RETURN_RESERVE_MS;
      const minimum = delivery === "inline" ? MIN_SPEECH_MS : MIN_TOKEN_MS;
      if (budget < minimum) {
        refuse(
          "no_time_left",
          "Sign-in took most of this request's time, so the speech was not started. Nothing was billed. Call again once."
        );
      }

      try {
        if (delivery === "inline") {
          const timeoutMs = Math.min(SPEECH_TIMEOUT_MS, budget);
          let speech;
          try {
            speech = await createSpeech(
              apiKey,
              { text: args.text, voice_id: args.voice_id, language: args.language, format: "mp3", bit_rate: INLINE_BIT_RATE },
              { timeoutMs, maxBytes: MAX_INLINE_AUDIO_BYTES }
            );
          } catch (err) {
            if (err instanceof AudioTooLargeError) {
              refuse(
                "inline_too_large",
                `${err.message} That is too large to return inline (it was billed). ` +
                  'Use shorter parts, or delivery "file".'
              );
            }
            if (err instanceof Error && err.name === "TimeoutError") {
              refuse(
                "speech_timeout",
                `The speech service did not finish within ${Math.round(timeoutMs / 1000)} seconds. ` +
                  "It may have been billed. Do not retry the same text; use shorter parts, or delivery \"file\"."
              );
            }
            throw err;
          }
          if (speech.audio.byteLength === 0) {
            refuse("no_speech", "The text has nothing to speak (for example only emoji or markup). Nothing was billed.");
          }
          const seconds = speech.durationMs !== undefined ? (speech.durationMs / 1000).toFixed(1) : undefined;
          log({
            ...base,
            event: "tool_call",
            status: "success",
            latencyMs: Date.now() - start,
            bytes: speech.audio.byteLength,
            billed_characters: speech.billedCharacters ?? null,
            duration_ms: speech.durationMs ?? null,
          });
          const inlineNextStep =
            "The audio is attached to this result as MP3. Do not call create_speech again for the same text: each call bills again. " +
            "If the user cannot play it, their app does not show audio from tools; tell them, and offer delivery \"file\" from a client with a shell.";
          return {
            content: [
              { type: "audio" as const, data: speech.audio.toString("base64"), mimeType: speech.mimeType },
              {
                type: "text" as const,
                text:
                  `Speech created${seconds ? `: ${seconds} seconds` : ""}, voice ${speech.voiceId ?? args.voice_id ?? "default"}, ` +
                  `${speech.billedCharacters ?? chars} characters billed. The audio is attached to this result as MP3. ` +
                  "If the user cannot play it, their app does not show audio from tools: do not call again " +
                  '(it bills again); tell them, and offer delivery "file" from a client with a shell.',
              },
            ],
            structuredContent: {
              delivery: "inline",
              mime_type: speech.mimeType,
              bytes: speech.audio.byteLength,
              voice_id: speech.voiceId ?? args.voice_id ?? null,
              language: speech.language ?? args.language ?? null,
              duration_ms: speech.durationMs ?? null,
              billed_characters: speech.billedCharacters ?? chars,
              next_step: inlineNextStep,
            },
          };
        }

        const token = await createTtsToken(apiKey, SPEECH_TOKEN_TTL_SECONDS, Math.min(TOKEN_DEADLINE_MS, budget));
        const outputFile = `speech-${randomBytes(4).toString("hex")}.${format}`;
        const body = JSON.stringify(
          speechRequestBody({ text: args.text, voice_id: args.voice_id, language: args.language, format })
        );
        // No --fail-with-body: it needs curl 7.76+.
        const command =
          `curl -sS -o ${shellQuote(outputFile)} -w '%{http_code}\\n' ` +
          `-H ${shellQuote(`Authorization: ${token}`)} -H 'Content-Type: application/json' ` +
          `-d ${shellQuote(body)} ${shellQuote(`${ttsBaseUrl()}/v1/speech`)}`;
        // PowerShell: curl aliases Invoke-WebRequest, and 5.1 strips double quotes from native-program args, so use curl.exe and a JSON file.
        const bodyFile = outputFile.replace(/\.\w+$/, ".json");
        const commandPowershell =
          `[IO.File]::WriteAllText((Join-Path $PWD ${powershellQuote(bodyFile)}), ${powershellQuote(body)}); ` +
          `curl.exe -sS -o ${powershellQuote(outputFile)} -w '%{http_code}\\n' ` +
          `-H ${powershellQuote(`Authorization: ${token}`)} -H 'Content-Type: application/json' ` +
          `--data-binary ${powershellQuote(`@${bodyFile}`)} ${powershellQuote(`${ttsBaseUrl()}/v1/speech`)}; ` +
          `Remove-Item ${powershellQuote(bodyFile)}`;
        const unknownVoice = args.voice_id !== undefined && voiceLanguage === undefined;
        const voiceWarning = unknownVoice
          ? `voice_id "${args.voice_id}" is not one of the voices this tool knows. Use it only if the user gave it to you; ` +
            "if not, call again without voice_id instead of running the command. "
          : "";
        // Claude Code shows the model only structuredContent, so the rules go here too.
        const nextStep =
          voiceWarning +
          "Each run bills again. Run it once: run `command` as it is (in Windows PowerShell, run `command_powershell` instead), " +
          "and do not run it again to retry or to check; it keeps working until it expires. " +
          `It prints the HTTP status. 200: ${outputFile} is the audio; tell the user where it is. ` +
          `Any other status: nothing is billed, and ${outputFile} holds a JSON error; read its \`message\`, delete the file, and follow the message. ` +
          "401 means the command expired: call create_speech again. " +
          `If curl cannot connect (e.g. "Could not resolve host"), your environment blocks ${new URL(ttsBaseUrl()).host}: ` +
          'tell the user to allow that host, or use delivery "inline". ' +
          "Do not show the command to the user or anyone else: it can create speech on the user's account until it expires.";
        const expiresAt = new Date(Date.now() + SPEECH_TOKEN_TTL_SECONDS * 1000).toISOString();
        log({ ...base, event: "tool_call", status: "success", latencyMs: Date.now() - start });
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Speech command created (valid for ${SPEECH_TOKEN_TTL_SECONDS / 60} minutes). Run it once, as it is. Each run bills again:\n\n${command}\n\n` +
                voiceWarning +
                `It saves the audio as ${outputFile} in the current directory (change the -o path if the user wants another place) ` +
                `and prints the HTTP status. 200: ${outputFile} is the audio, and ${chars} characters are billed to the user's ` +
                `AssemblyAI account; tell the user where the file is. Any other status: nothing is billed, and ${outputFile} ` +
                "holds a JSON error instead of audio; read its `message`, delete the file, and follow the message. " +
                "Do not run it again to retry or to check: it keeps working until it expires, and each run bills again. " +
                "401 means the command expired: call create_speech again. " +
                "In Windows PowerShell, run `command_powershell` from the structured result instead. " +
                `If curl cannot connect at all (e.g. "Could not resolve host"), your environment blocks ` +
                `${new URL(ttsBaseUrl()).host}: do not retry or work around it; tell the user to allow that host, ` +
                'or use delivery "inline". ' +
                "Do not show this command to anyone else: it can create speech on the user's account until it expires.",
            },
          ],
          structuredContent: {
            delivery: "file",
            command,
            command_powershell: commandPowershell,
            output_file: outputFile,
            expires_at: expiresAt,
            characters: chars,
            voice_id: args.voice_id ?? null,
            language: args.language ?? null,
            next_step: nextStep,
          },
        };
      } catch (err) {
        const payload = { ...base, status: "error", latencyMs: Date.now() - start };
        if (!(err instanceof AssemblyAIError)) {
          if (!(err instanceof Refusal)) logError({ ...payload, event: "create_speech_error" }, err);
          throw err;
        }
        // Only the speech API sees the text, so log its errors' status and code, never their message.
        const logFailure = (event: string) =>
          err instanceof TtsError
            ? log({ ...payload, event, level: "error", http_status: err.status, code: err.code ?? null })
            : logError({ ...payload, event, http_status: err.status }, err);
        if (err.status === 401) {
          logFailure("assemblyai_rejected_key");
          throw new Error(REJECTED_KEY_MESSAGE);
        }
        logFailure("create_speech_error");
        throw new Error(err.message + (err instanceof TtsError ? hintFor(err) : ""));
      }
    }
  );
}
