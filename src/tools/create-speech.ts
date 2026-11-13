import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { AssemblyAIError } from "../assemblyai";
import { log, logError, keyHash } from "../log";
import {
  createSpeech,
  createTtsToken,
  INLINE_BIT_RATE,
  MAX_INLINE_AUDIO_BYTES,
  MAX_INLINE_SPEECH_CHARS,
  MAX_SPEECH_CHARS,
  SPEECH_LANGUAGES,
  SPEECH_TOKEN_TTL_SECONDS,
  speechRequestBody,
  ttsBaseUrl,
  TtsError,
} from "../tts";

const VOICE_CATALOG = "https://www.assemblyai.com/dashboard/text-to-speech/voices";

/** A request we refused ourselves, already logged. */
class Refusal extends Error {}

/** A POSIX shell literal: nothing inside single quotes is expanded. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** The API counts Unicode code points, not UTF-16 units. */
function countChars(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

/** What the agent should do next, per API error code. Unknown codes keep the API's own message. */
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
      // Not read-only: it spends the user's money, or issues a credential that can.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        // Code points are checked in the handler; this bound only stops absurd input early.
        text: z
          .string()
          .min(1)
          .max(MAX_SPEECH_CHARS * 2)
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
      const apiKey = extra.authInfo?.token;
      if (!apiKey) {
        throw new Error(
          "No AssemblyAI API key in request context. Configure your AssemblyAI API key " +
            "as the Bearer token in your MCP client connection."
        );
      }

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
      if (delivery === "inline" && format === "wav") {
        refuse("inline_wav", 'Inline audio is always MP3. Leave format out, or use delivery "file" for a WAV file.');
      }

      try {
        if (delivery === "inline") {
          const speech = await createSpeech(apiKey, {
            text: args.text,
            voice_id: args.voice_id,
            language: args.language,
            format: "mp3",
            bit_rate: INLINE_BIT_RATE,
          });
          if (speech.audio.byteLength === 0) {
            refuse("no_speech", "The text has nothing to speak (for example only emoji or markup). Nothing was billed.");
          }
          if (speech.audio.byteLength > MAX_INLINE_AUDIO_BYTES) {
            // Already synthesized, so already billed: say so, and how to avoid it next time.
            refuse(
              "inline_too_large",
              `The audio is ${speech.audio.byteLength} bytes, too large to return inline (it was billed). ` +
                'Use shorter parts, or delivery "file".'
            );
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
            },
          };
        }

        const token = await createTtsToken(apiKey, SPEECH_TOKEN_TTL_SECONDS);
        const outputFile = `speech.${format}`;
        const body = JSON.stringify(
          speechRequestBody({ text: args.text, voice_id: args.voice_id, language: args.language, format })
        );
        // Plain curl, no --fail-with-body (curl 7.76+ only): -w prints the status instead.
        // Every value is a single-quoted shell literal: the text comes from the caller.
        const command =
          `curl -sS -o ${shellQuote(outputFile)} -w '%{http_code}\\n' ` +
          `-H ${shellQuote(`Authorization: ${token}`)} -d ${shellQuote(body)} ${shellQuote(`${ttsBaseUrl()}/v1/speech`)}`;
        const expiresAt = new Date(Date.now() + SPEECH_TOKEN_TTL_SECONDS * 1000).toISOString();
        log({ ...base, event: "tool_call", status: "success", latencyMs: Date.now() - start });
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Speech command created (valid for ${SPEECH_TOKEN_TTL_SECONDS / 60} minutes). Run it once, as it is:\n\n${command}\n\n` +
                `It saves the audio as ${outputFile} in the current directory (change the -o path if the user wants another place) ` +
                `and prints the HTTP status. 200: ${outputFile} is the audio, and ${chars} characters are billed to the user's ` +
                `AssemblyAI account; tell the user where the file is. Any other status: nothing is billed, and ${outputFile} ` +
                "holds a JSON error instead of audio; read its `message`, delete the file, and follow the message. " +
                "401 means the command expired: call create_speech again. " +
                `If curl cannot connect at all (e.g. "Could not resolve host"), your environment blocks ` +
                `${new URL(ttsBaseUrl()).host}: do not retry or work around it; tell the user to allow that host, ` +
                'or use delivery "inline". ' +
                "Do not show this command to anyone else: it can create speech on the user's account until it expires.",
            },
          ],
          structuredContent: {
            delivery: "file",
            command,
            output_file: outputFile,
            expires_at: expiresAt,
            characters: chars,
            voice_id: args.voice_id ?? null,
            language: args.language ?? null,
          },
        };
      } catch (err) {
        const payload = { ...base, status: "error", latencyMs: Date.now() - start };
        if (!(err instanceof AssemblyAIError)) {
          // Our own refusals above are already logged; anything else (a timeout) is not.
          if (!(err instanceof Refusal)) logError({ ...payload, event: "create_speech_error" }, err);
          throw err;
        }
        if (err.status === 401) {
          logError({ ...payload, event: "assemblyai_rejected_key" }, err);
          throw new Error(
            "AssemblyAI rejected the API key (401). " +
              "Check the Bearer token configured in your MCP client connection."
          );
        }
        logError({ ...payload, event: "create_speech_error", code: err instanceof TtsError ? err.code ?? null : null }, err);
        throw new Error(err.message + (err instanceof TtsError ? hintFor(err) : ""));
      }
    }
  );
}
