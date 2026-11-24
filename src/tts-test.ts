import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { registerTools } from "./server";
import { AssemblyAIError } from "./assemblyai";
import { withRequestClock } from "./deadline";
import {
  createTtsToken,
  INLINE_BIT_RATE,
  MAX_INLINE_AUDIO_BYTES,
  MAX_INLINE_SPEECH_CHARS,
  MAX_SPEECH_CHARS,
  SPEECH_TOKEN_TTL_SECONDS,
} from "./tts";

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

let calls: FetchCall[] = [];
let nextResponses: Response[] = [];

function installMockFetch() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k.toLowerCase()] = v));
    calls.push({ url, method: init?.method ?? "GET", headers, body: init?.body ? String(init.body) : null });
    const next = nextResponses.shift();
    if (!next) throw new Error(`Mock fetch: no queued response for ${url}`);
    return next;
  }) as typeof fetch;
}

function resetMock(responses: Response[]) {
  calls = [];
  nextResponses = responses;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

const tokenOk = (token = "TMP-TOKEN-abc") => json(200, { token, expires_in_seconds: SPEECH_TOKEN_TTL_SECONDS });

const audioOk = (bytes: Uint8Array, headers: Record<string, string> = {}) =>
  new Response(bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "audio/mpeg",
      "X-TTS-Voice-Id": "aai-kyla",
      "X-TTS-Language": "english",
      "X-TTS-Billed-Characters": "12",
      "X-TTS-Audio-Duration-Ms": "1500",
      ...headers,
    },
  });

const ttsError = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) =>
  json(status, { code, message, error: message, retryable: false, retry_after_seconds: null, ...extra });

let passed = 0;
let failed = 0;
function assert(name: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

interface ToolResult {
  isError?: boolean;
  content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  structuredContent?: Record<string, unknown>;
}

async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const server = new McpServer({ name: "tts-test", version: "0.0.0" });
  const originalRegister = server.registerTool.bind(server);
  server.registerTool = ((name: string, config: unknown, cb: unknown) => {
    const wrapped = async (args: unknown, extra: { _meta?: { bearer?: string }; authInfo?: { token: string } }) => {
      if (extra._meta?.bearer) extra.authInfo = { token: extra._meta.bearer };
      return (cb as (a: unknown, e: unknown) => Promise<unknown>)(args, extra);
    };
    return originalRegister(name, config as never, wrapped as never);
  }) as typeof server.registerTool;
  registerTools(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "tts-test", version: "0.0.0" });
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

const KEY = "sk-REAL-KEY-do-not-leak";
const speak = async (client: Client, args: Record<string, unknown>) =>
  (await client.callTool({ name: "create_speech", arguments: args, _meta: { bearer: KEY } })) as ToolResult;
const textOf = (res: ToolResult) => res.content?.find((c) => c.type === "text")?.text ?? "";

async function captureLogs(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => lines.push(String(line));
  try {
    await fn();
  } finally {
    console.log = originalLog;
  }
  return lines.join("\n");
}

// A never-settling promise lets Node exit 0 with no summary.
let finished = false;
process.on("exit", (code) => {
  if (!finished && code === 0) {
    console.error("\nThe test run stopped before its summary (a hung promise?).");
    process.exitCode = 1;
  }
});

async function run() {
  installMockFetch();
  console.log("Running TTS tests…\n");

  for (const value of [undefined, "0", "true", ""]) {
    if (value === undefined) delete process.env.TTS_ENABLED;
    else process.env.TTS_ENABLED = value;
    await withClient(async (client) => {
      const { tools } = await client.listTools();
      assert(
        `1. create_speech is not offered with TTS_ENABLED=${JSON.stringify(value)}`,
        !tools.some((t) => t.name === "create_speech") && !JSON.stringify(tools).includes("create_speech"),
        tools.map((t) => t.name).join(", ")
      );
    });
  }

  process.env.TTS_ENABLED = "1";
  delete process.env.ASSEMBLYAI_TTS_BASE_URL;
  delete process.env.ASSEMBLYAI_TOKEN_BASE_URL;

  await withClient(async (client) => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "create_speech");
    assert(
      "2. create_speech is offered, titled, not read-only and not destructive",
      Boolean(tool?.title) && tool?.annotations?.readOnlyHint === false && tool?.annotations?.destructiveHint === false,
      JSON.stringify(tool?.annotations)
    );
    const description = tool?.description ?? "";
    assert(
      "2. the description states the cost and asks for an explicit request",
      description.includes("billed") && description.includes("explicitly asks"),
      description
    );
    assert(
      "2. the other tools are unchanged in count (5 without uploads)",
      tools.length === 6 || tools.length === 7,
      String(tools.length)
    );
  });

  await withClient(async (client) => {
    resetMock([tokenOk()]);
    const res = await speak(client, { text: "Hello there." });
    const text = textOf(res);
    const command = String(res.structuredContent?.command ?? "");
    assert("3. file delivery succeeds with one request", res.isError !== true && calls.length === 1, JSON.stringify(res));
    const call = calls[0];
    assert(
      "3. that request mints a TTS-only token with the raw key",
      call?.url === "https://token.us.assemblyai.com/v1/token" && call.method === "POST" &&
        call.headers.authorization === KEY &&
        JSON.stringify(JSON.parse(call.body ?? "{}")) ===
          JSON.stringify({ product: "tts", expires_in_seconds: SPEECH_TOKEN_TTL_SECONDS }),
      JSON.stringify(call)
    );
    assert(
      "3. the command carries the token, never the API key",
      command.includes("Authorization: TMP-TOKEN-abc") && !command.includes(KEY) && !text.includes(KEY),
      command
    );
    const outputFile = String(res.structuredContent?.output_file ?? "");
    assert(
      "3. the command posts a buffered MP3 JSON request to the TTS host and saves speech-<random>.mp3",
      /^speech-[0-9a-f]{8}\.mp3$/.test(outputFile) &&
        command.startsWith(`curl -sS -o '${outputFile}' `) && command.endsWith("'https://tts.us.assemblyai.com/v1/speech'") &&
        command.includes("-H 'Content-Type: application/json' -d '") &&
        command.includes('"encoding":"mp3"') && command.includes('"stream":false') &&
        text.includes(`saves the audio as ${outputFile}`) && res.structuredContent?.delivery === "file",
      command
    );
    assert(
      "3. the reply says what is billed, when, and what to do on errors",
      text.includes("12 characters are billed") && text.includes("nothing is billed") && text.includes("Run it once") &&
        text.includes("401") && text.includes("Could not resolve host"),
      text
    );
    const expires = Date.parse(String(res.structuredContent?.expires_at));
    assert(
      "3. expires_at is the token lifetime from now",
      Math.abs(expires - (Date.now() + SPEECH_TOKEN_TTL_SECONDS * 1000)) < 5000,
      String(res.structuredContent?.expires_at)
    );
  });

  await withClient(async (client) => {
    const dir = mkdtempSync(join(tmpdir(), "tts-test-"));
    const marker = join(dir, "injected");
    const hostile =
      `It's $(touch ${marker}) \`touch ${marker}\` "quoted" \\ back\nline two; touch ${marker} && echo 'x' | touch ${marker} é 😀`;
    resetMock([tokenOk("tok'en")]);
    const res = await speak(client, { text: hostile });
    const command = String(res.structuredContent?.command ?? "");
    let printed = "";
    try {
      printed = execFileSync("sh", ["-c", command.replace(/^curl /, "printf '%s\\n' ")], {
        encoding: "utf8",
        cwd: dir,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
    }
    const injected = existsSync(marker);
    rmSync(dir, { recursive: true, force: true });
    assert("4. nothing in the text runs as a shell command", !injected && printed !== "");
    const words = printed.split("\n");
    const bodyAt = words.indexOf("-d") + 1;
    let parsed: { text?: string } = {};
    try {
      parsed = JSON.parse(words[bodyAt] ?? "");
    } catch {
    }
    assert(
      "4. the shell hands curl the exact text, as one JSON argument on one line",
      !command.includes("\n") && parsed.text === hostile,
      JSON.stringify(words)
    );
    assert(
      "4. a quote in the token cannot end the header argument",
      words[words.indexOf("-H") + 1] === "Authorization: tok'en",
      JSON.stringify(words)
    );
    assert(
      "4. the words are exactly curl's arguments, nothing extra",
      words.filter((w) => w !== "").length === 12 && words[11] === "https://tts.us.assemblyai.com/v1/speech",
      JSON.stringify(words)
    );
    assert(
      "4. the command declares the JSON body, as one header argument",
      words[words.lastIndexOf("-H") + 1] === "Content-Type: application/json" &&
        words.indexOf("-d") > words.lastIndexOf("-H"),
      JSON.stringify(words)
    );
  });

  await withClient(async (client) => {
    resetMock([tokenOk()]);
    const res = await speak(client, { text: "Hola.", voice_id: "aai-constanza", language: "spanish", format: "wav" });
    const command = String(res.structuredContent?.command ?? "");
    const body = JSON.parse(command.match(/-d '(\{.*\})' /)?.[1] ?? "{}");
    assert(
      "5. wav sets pcm_s16le in a wav container and names speech-<random>.wav; voice and language pass through",
      body.encoding === "pcm_s16le" && body.container === "wav" && body.voice_id === "aai-constanza" &&
        body.language === "spanish" && body.bit_rate === undefined && /-o 'speech-[0-9a-f]{8}\.wav' /.test(command),
      command
    );
    resetMock([]);
    const bad = await speak(client, { text: "Hi.", voice_id: "aai-kyla'; rm -rf ~" });
    assert("5. a voice_id with shell characters is refused by the schema", bad.isError === true && calls.length === 0);
    const badLanguage = await speak(client, { text: "Hi.", language: "en" });
    assert("5. a language outside the six is refused by the schema", badLanguage.isError === true && calls.length === 0);
  });

  await withClient(async (client) => {
    resetMock([tokenOk()]);
    const emoji = "😀".repeat(MAX_SPEECH_CHARS);
    const ok = await speak(client, { text: emoji });
    assert(
      `6. ${MAX_SPEECH_CHARS} code points are accepted, though they are ${emoji.length} UTF-16 units`,
      ok.isError !== true && ok.structuredContent?.characters === MAX_SPEECH_CHARS,
      textOf(ok).slice(0, 200)
    );
    resetMock([]);
    const over = await speak(client, { text: "a".repeat(MAX_SPEECH_CHARS + 1) });
    assert(
      "6. one character over is refused with no request, and says to split",
      over.isError === true && calls.length === 0 && textOf(over).includes(String(MAX_SPEECH_CHARS)) &&
        textOf(over).includes("Split"),
      textOf(over)
    );
  });

  await withClient(async (client) => {
    const bytes = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 1, 2, 3, 4, 5]);
    resetMock([audioOk(bytes)]);
    const res = await speak(client, { text: "Hello there.", delivery: "inline", voice_id: "aai-kyla" });
    const call = calls[0];
    const body = JSON.parse(call?.body ?? "{}");
    assert(
      "7. inline makes one buffered MP3 request to the TTS host with the raw key, and mints no token",
      calls.length === 1 && call?.url === "https://tts.us.assemblyai.com/v1/speech" && call.headers.authorization === KEY &&
        body.text === "Hello there." && body.encoding === "mp3" && body.bit_rate === INLINE_BIT_RATE &&
        body.stream === false && body.voice_id === "aai-kyla",
      JSON.stringify(call)
    );
    const audio = res.content?.find((c) => c.type === "audio");
    assert(
      "7. the audio comes back as an MCP audio block, byte for byte",
      res.isError !== true && audio?.mimeType === "audio/mpeg" &&
        Buffer.from(audio?.data ?? "", "base64").equals(Buffer.from(bytes)),
      JSON.stringify(res).slice(0, 300)
    );
    assert(
      "7. the result reports what was billed and warns not to call again",
      res.structuredContent?.billed_characters === 12 && res.structuredContent?.duration_ms === 1500 &&
        res.structuredContent?.bytes === bytes.byteLength && textOf(res).includes("1.5 seconds") &&
        textOf(res).includes("do not call again"),
      JSON.stringify(res.structuredContent)
    );
    assert("7. the structured content does not repeat the audio", !JSON.stringify(res.structuredContent).includes(audio?.data ?? "x"));
  });

  await withClient(async (client) => {
    resetMock([]);
    const long = await speak(client, { text: "a".repeat(MAX_INLINE_SPEECH_CHARS + 1), delivery: "inline" });
    assert(
      "8. inline over its limit is refused with no request, and points at delivery file",
      long.isError === true && calls.length === 0 && textOf(long).includes('delivery "file"'),
      textOf(long)
    );
    const wav = await speak(client, { text: "Hi.", delivery: "inline", format: "wav" });
    assert("8. inline wav is refused with no request", wav.isError === true && calls.length === 0, textOf(wav));
    const blank = await speak(client, { text: "   \n ", delivery: "inline" });
    assert("8. blank text is refused with no request", blank.isError === true && calls.length === 0, textOf(blank));
    resetMock([audioOk(new Uint8Array(0), { "X-TTS-Billed-Characters": "0" })]);
    const empty = await speak(client, { text: "😀", delivery: "inline" });
    assert(
      "8. text with nothing to speak is an error that says nothing was billed",
      empty.isError === true && textOf(empty).includes("Nothing was billed"),
      textOf(empty)
    );
  });

  await withClient(async (client) => {
    const inline = { text: "Hi.", delivery: "inline" };
    resetMock([ttsError(422, "voice_not_found", "voice_id: no voice 'aai-nope'")]);
    const voice = await speak(client, { ...inline, voice_id: "aai-nope" });
    assert(
      "9. voice_not_found keeps the API message and points at the catalog",
      voice.isError === true && textOf(voice).includes("HTTP 422") && textOf(voice).includes("aai-nope") &&
        textOf(voice).includes("dashboard/text-to-speech/voices"),
      textOf(voice)
    );
    resetMock([ttsError(402, "insufficient_funds", "no funds")]);
    const funds = await speak(client, inline);
    assert("9. insufficient_funds says not to retry", funds.isError === true && textOf(funds).includes("do not retry"), textOf(funds));
    resetMock([ttsError(429, "rate_limited", "too many", { retry_after_seconds: 7 }, )]);
    const limited = await speak(client, inline);
    assert(
      "9. rate_limited says how long to wait, and is not retried here",
      limited.isError === true && textOf(limited).includes("Wait 7 seconds") && calls.length === 1,
      textOf(limited)
    );
    resetMock([new Response("<html>Bad Gateway</html>", { status: 502, headers: { "Retry-After": "3" } })]);
    const html = await speak(client, inline);
    assert(
      "9. a non-JSON 5xx is still a clear, temporary error",
      html.isError === true && textOf(html).includes("HTTP 502") && textOf(html).includes("temporary") && calls.length === 1,
      textOf(html)
    );
    resetMock([ttsError(401, "unauthorized", "unknown key")]);
    const key = await speak(client, inline);
    assert(
      "9. a rejected key gets the standard Bearer-token message, without the key",
      key.isError === true && textOf(key).includes("rejected the API key") && !textOf(key).includes(KEY) &&
        // OAuth (Claude.ai) users set no Bearer token, so they also get the re-authenticate hint (issue #101).
        textOf(key).includes("re-authenticate"),
      textOf(key)
    );
  });

  await withClient(async (client) => {
    resetMock([json(401, { detail: "Invalid API key" })]);
    const rejected = await speak(client, { text: "Hi." });
    assert(
      "10. a key the token service rejects gets the standard message, and no command",
      rejected.isError === true && textOf(rejected).includes("rejected the API key") && !textOf(rejected).includes("curl") &&
        textOf(rejected).includes("re-authenticate"),
      textOf(rejected)
    );
    // The real token host answers a bad key with 404 "Invalid API key".
    resetMock([json(404, { error: "Invalid API key" })]);
    const rejected404 = await speak(client, { text: "Hi." });
    assert(
      "10. the token host's 404 for a bad key gets the same 401 message as inline",
      rejected404.isError === true && textOf(rejected404).includes("rejected the API key (401)") &&
        !textOf(rejected404).includes("404") && !textOf(rejected404).includes("curl"),
      textOf(rejected404)
    );
    resetMock([json(404, { error: "Not found" })]);
    const other404 = await speak(client, { text: "Hi." });
    assert(
      "10. any other token 404 keeps its status and message",
      other404.isError === true && textOf(other404).includes("HTTP 404: Not found"),
      textOf(other404)
    );
    resetMock([json(200, {})]);
    const none = await speak(client, { text: "Hi." });
    assert("10. an answer with no token is an error, not a command without one", none.isError === true && !textOf(none).includes("curl"), textOf(none));
    resetMock([json(503, { error: "busy" }), tokenOk()]);
    const retried = await speak(client, { text: "Hi." });
    assert(
      "10. a token 5xx is tried once more (a token costs nothing), then succeeds",
      retried.isError !== true && calls.length === 2 && String(retried.structuredContent?.command ?? "").includes("TMP-TOKEN-abc"),
      textOf(retried)
    );
    resetMock([json(503, { error: "busy" }), json(503, { error: "still busy" })]);
    const busy = await speak(client, { text: "Hi." });
    assert(
      "10. two token 5xx answers stop after 2 attempts, with no command",
      busy.isError === true && calls.length === 2 && textOf(busy).includes("HTTP 503") && !textOf(busy).includes("curl"),
      textOf(busy)
    );
  });

  {
    const realFetch = globalThis.fetch;
    // AbortSignal.timeout's timer does not hold the process open.
    const keepAlive = setInterval(() => {}, 1_000);
    let attempts = 0;
    const stall = (signal: AbortSignal | null | undefined) =>
      new Promise<never>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
    try {
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        attempts++;
        return stall(init?.signal);
      }) as typeof fetch;
      let t0 = Date.now();
      let err: unknown;
      try {
        await createTtsToken(KEY, SPEECH_TOKEN_TTL_SECONDS, 300);
      } catch (e) {
        err = e;
      }
      assert(
        "10b. a token service that never answers ends at the deadline with a 504",
        err instanceof AssemblyAIError && err.status === 504 && Date.now() - t0 < 2_000 && attempts === 1,
        `${String(err)} after ${Date.now() - t0} ms, ${attempts} attempts`
      );

      attempts = 0;
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        attempts++;
        const signal = init?.signal;
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"tok'));
            signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
          },
        });
        return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
      }) as typeof fetch;
      t0 = Date.now();
      err = undefined;
      try {
        await createTtsToken(KEY, SPEECH_TOKEN_TTL_SECONDS, 300);
      } catch (e) {
        err = e;
      }
      assert(
        "10b. a body that stalls mid-read also ends at the deadline with a 504",
        err instanceof AssemblyAIError && err.status === 504 && Date.now() - t0 < 2_000,
        `${String(err)} after ${Date.now() - t0} ms`
      );

      attempts = 0;
      globalThis.fetch = (async () => {
        attempts++;
        return json(503, { error: "busy" });
      }) as typeof fetch;
      t0 = Date.now();
      err = undefined;
      try {
        await createTtsToken(KEY, SPEECH_TOKEN_TTL_SECONDS, 300);
      } catch (e) {
        err = e;
      }
      assert(
        "10b. the backoff counts against the deadline too",
        err instanceof AssemblyAIError && err.status === 504 && attempts === 1 && Date.now() - t0 < 2_000,
        `${String(err)} after ${Date.now() - t0} ms, ${attempts} attempts`
      );
    } finally {
      globalThis.fetch = realFetch;
      clearInterval(keepAlive);
    }
  }

  await withClient(async (client) => {
    const secretText = "The merger closes on Friday at noon.";
    const logs = await captureLogs(async () => {
      resetMock([tokenOk("TMP-TOKEN-zzz")]);
      await speak(client, { text: secretText });
      resetMock([audioOk(new Uint8Array([1, 2, 3]))]);
      await speak(client, { text: secretText, delivery: "inline" });
      resetMock([ttsError(422, "invalid_parameter", `text: cannot speak "${secretText}"`)]);
      await speak(client, { text: secretText, delivery: "inline" });
      resetMock([new Response(`<html>Bad Gateway for ${secretText}</html>`, { status: 502 })]);
      await speak(client, { text: secretText, delivery: "inline" });
      resetMock([ttsError(401, "unauthorized", `unknown key for "${secretText}"`)]);
      await speak(client, { text: secretText, delivery: "inline" });
      resetMock([]);
      await speak(client, { text: "a".repeat(MAX_SPEECH_CHARS + 1) });
    });
    const events = logs.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert(
      "11. logs never hold the text, the token or the key, even when an API error echoes the text",
      !logs.includes("merger") && !logs.includes("TMP-TOKEN-zzz") && !logs.includes(KEY) && !logs.includes("aaaaaaaa"),
      logs
    );
    assert(
      "11. each call logs one event with the size, delivery and outcome",
      events.length === 6 && events.every((e) => e.tool === "create_speech" && typeof e.chars === "number") &&
        events[0].status === "success" && events[0].delivery === "file" &&
        events[1].status === "success" && events[1].billed_characters === 12 &&
        events[2].status === "error" && events[2].code === "invalid_parameter" && events[2].http_status === 422 &&
        events[3].status === "error" && events[3].http_status === 502 &&
        events[4].event === "assemblyai_rejected_key" && events[4].http_status === 401 &&
        events[5].status === "rejected" && events[5].reason === "text_too_long",
      logs
    );
    const tokenLogs = await captureLogs(async () => {
      resetMock([json(403, { error: "account disabled" })]);
      await speak(client, { text: secretText });
    });
    assert(
      "11. a token service error (it never sees the text) keeps its message in the log",
      tokenLogs.includes("account disabled") && tokenLogs.includes('"http_status":403') && !tokenLogs.includes("merger"),
      tokenLogs
    );
  });

  await withClient(async (client) => {
    const names = new Set<string>();
    for (let i = 0; i < 20; i++) {
      resetMock([tokenOk()]);
      const res = await speak(client, { text: `Part ${i}.` });
      names.add(String(res.structuredContent?.output_file));
    }
    assert(
      "12. 20 calls give 20 different file names",
      names.size === 20 && [...names].every((n) => /^speech-[0-9a-f]{8}\.mp3$/.test(n)),
      [...names].join(" ")
    );
  });

  await withClient(async (client) => {
    const CHUNK = 256 * 1024;
    const endless = (limitChunks = Infinity) => {
      const stats = { pulled: 0, cancelled: false };
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (stats.pulled / CHUNK >= limitChunks) return controller.close();
          stats.pulled += CHUNK;
          controller.enqueue(new Uint8Array(CHUNK));
        },
        cancel() {
          stats.cancelled = true;
        },
      });
      return { body, stats };
    };

    let s = endless();
    resetMock([audioOk(s.body as unknown as Uint8Array, { "Content-Length": String(MAX_INLINE_AUDIO_BYTES + 1) })]);
    let res = await speak(client, { text: "Hello.", delivery: "inline" });
    assert(
      "13. a declared size over the cap is refused without reading the body, and says it was billed",
      res.isError === true && textOf(res).includes(`${MAX_INLINE_AUDIO_BYTES + 1} bytes`) &&
        textOf(res).includes("it was billed") && s.stats.pulled <= CHUNK && s.stats.cancelled,
      `${textOf(res)} | pulled ${s.stats.pulled}, cancelled ${s.stats.cancelled}`
    );

    s = endless();
    resetMock([audioOk(s.body as unknown as Uint8Array)]);
    res = await speak(client, { text: "Hello.", delivery: "inline" });
    assert(
      "13. an endless body is cut just past the cap and cancelled",
      res.isError === true && textOf(res).includes(`more than ${MAX_INLINE_AUDIO_BYTES} bytes`) &&
        textOf(res).includes("it was billed") && s.stats.pulled <= MAX_INLINE_AUDIO_BYTES + 2 * CHUNK && s.stats.cancelled,
      `${textOf(res)} | pulled ${s.stats.pulled}, cancelled ${s.stats.cancelled}`
    );

    s = endless(4);
    resetMock([audioOk(s.body as unknown as Uint8Array)]);
    res = await speak(client, { text: "Hello.", delivery: "inline" });
    const audio = res.content?.find((c) => c.type === "audio");
    assert(
      "13. a chunked body under the cap comes back whole",
      res.isError !== true && Buffer.from(audio?.data ?? "", "base64").byteLength === 4 * CHUNK,
      textOf(res)
    );
  });

  {
    const afterSignIn = <T>(usedMs: number, fn: () => Promise<T>): Promise<T> => {
      const realNow = Date.now;
      Date.now = () => realNow() - usedMs;
      try {
        return withRequestClock(async (_: void) => fn())(undefined);
      } finally {
        Date.now = realNow;
      }
    };
    const keepAlive = setInterval(() => {}, 1_000);
    try {
      await withClient(async (client) => {
        resetMock([]);
        let res = await afterSignIn(52_000, () => speak(client, { text: "Hello.", delivery: "inline" }));
        assert(
          "14. inline with 8 s left is refused before any request, and says nothing was billed",
          res.isError === true && calls.length === 0 && textOf(res).includes("Nothing was billed"),
          `${textOf(res)} | ${calls.length} calls`
        );
        res = await afterSignIn(56_000, () => speak(client, { text: "Hello." }));
        assert(
          "14. file delivery with 4 s left is refused before the token request",
          res.isError === true && calls.length === 0 && textOf(res).includes("Call again once"),
          `${textOf(res)} | ${calls.length} calls`
        );
        resetMock([tokenOk()]);
        res = await afterSignIn(40_000, () => speak(client, { text: "Hello." }));
        assert("14. file delivery with 20 s left still works", res.isError !== true && calls.length === 1, textOf(res));

        const realFetch = globalThis.fetch;
        globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<never>((_, reject) =>
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
          )) as typeof fetch;
        const t0 = Date.now();
        try {
          res = await afterSignIn(44_000, () => speak(client, { text: "Hello.", delivery: "inline" }));
        } finally {
          globalThis.fetch = realFetch;
        }
        const took = Date.now() - t0;
        assert(
          "14. a slow speech call gets only the time left (11 s here), then a clear error",
          res.isError === true && took >= 10_000 && took < 14_000 && textOf(res).includes("within 11 seconds") &&
            textOf(res).includes("may have been billed"),
          `${textOf(res)} | took ${took} ms`
        );
      });
    } finally {
      clearInterval(keepAlive);
    }
  }

  await withClient(async (client) => {
    resetMock([tokenOk()]);
    const res = await speak(client, { text: "Hello there." });
    const next = String(res.structuredContent?.next_step ?? "");
    assert(
      "15. file next_step says each run bills again, run it once, 401 = expired, do not show the command",
      next.includes("Each run bills again. Run it once") && next.includes("401 means the command expired") &&
        next.includes("Do not show the command") && next.includes("command_powershell") &&
        next.includes(String(res.structuredContent?.output_file)) && !next.includes("TMP-TOKEN-abc") && !next.includes(KEY),
      next
    );
    assert(
      "15. the text block also says each run bills again",
      textOf(res).includes("Each run bills again") && textOf(res).includes("each run bills again"),
      textOf(res)
    );
    assert("15. a known voice (none given) has no voice warning", !next.includes("not one of the voices"), next);

    resetMock([audioOk(new Uint8Array([1, 2, 3]))]);
    const inline = await speak(client, { text: "Hello there.", delivery: "inline" });
    const inlineNext = String(inline.structuredContent?.next_step ?? "");
    assert(
      "15. inline next_step says not to call again because each call bills again",
      inline.isError !== true && inlineNext.includes("each call bills again") && inlineNext.includes("Do not call create_speech again"),
      inlineNext
    );
  });

  await withClient(async (client) => {
    resetMock([tokenOk()]);
    let res = await speak(client, { text: "Hello.", voice_id: "aai-nobody" });
    let next = String(res.structuredContent?.next_step ?? "");
    assert(
      "16. an unknown voice still gets a command, with a warning first in next_step and in the text",
      res.isError !== true && calls.length === 1 && next.startsWith('voice_id "aai-nobody" is not one of the voices') &&
        textOf(res).includes('voice_id "aai-nobody" is not one of the voices'),
      next
    );
    resetMock([tokenOk()]);
    res = await speak(client, { text: "Hallo.", voice_id: "aai-magdalena", language: "german" });
    next = String(res.structuredContent?.next_step ?? "");
    assert("16. a known library voice has no warning", res.isError !== true && !next.includes("not one of the voices"), next);
  });

  await withClient(async (client) => {
    for (const text of ['<speak>Hello <break time="1s"/> world</speak>', '  \n<SPEAK version="1.1">Hi</SPEAK>', "<speak/>"]) {
      for (const delivery of ["file", "inline"]) {
        resetMock([tokenOk(), audioOk(new Uint8Array([1]))]);
        const res = await speak(client, { text, delivery });
        assert(
          `17. SSML ${JSON.stringify(text.slice(0, 12))} with ${delivery} is refused with no request`,
          res.isError === true && calls.length === 0 && textOf(res).includes("SSML is not supported") &&
            textOf(res).includes("Nothing was billed"),
          `${textOf(res)} | ${calls.length} calls`
        );
      }
    }
    resetMock([tokenOk()]);
    const res = await speak(client, { text: "<speaker notes> are not SSML." });
    assert("17. text that only starts like <speaker is not refused", res.isError !== true, textOf(res));
  });

  await withClient(async (client) => {
    resetMock([]);
    let res = await speak(client, { text: "a".repeat(MAX_SPEECH_CHARS * 2 + 1) });
    assert(
      "18. 10,001 characters: the error gives the 5,000 limit, not 10,000, and nothing is requested",
      res.isError === true && calls.length === 0 && textOf(res).includes(`the limit is ${MAX_SPEECH_CHARS} characters`) &&
        !textOf(res).includes(String(MAX_SPEECH_CHARS * 2)),
      textOf(res)
    );
    res = await speak(client, { text: "a".repeat(MAX_SPEECH_CHARS + 1) });
    assert(
      "18. 5,001 characters: the handler gives the 5,000 limit",
      res.isError === true && calls.length === 0 && textOf(res).includes(`the limit with delivery "file" is ${MAX_SPEECH_CHARS}`),
      textOf(res)
    );
    const { tools } = await client.listTools();
    const schema = tools.find((t) => t.name === "create_speech")?.inputSchema as
      | { properties?: Record<string, { maxLength?: number }> }
      | undefined;
    assert(
      "18. the published input schema is unchanged (text maxLength is still 10,000)",
      schema?.properties?.text?.maxLength === MAX_SPEECH_CHARS * 2,
      JSON.stringify(schema?.properties?.text)
    );
  });

  await withClient(async (client) => {
    const hostile = `It's ‘curly’ $(Get-Date) $env:PATH \`n "quoted" é 😀; Remove-Item -Recurse ~`;
    resetMock([tokenOk("tok'en")]);
    const res = await speak(client, { text: hostile });
    const ps = String(res.structuredContent?.command_powershell ?? "");
    const outputFile = String(res.structuredContent?.output_file ?? "");
    const bodyFile = outputFile.replace(/\.mp3$/, ".json");
    const words: string[] = [];
    const rest: string[] = [];
    const quote = /['‘’‚‛]/;
    for (let i = 0; i < ps.length; ) {
      if (quote.test(ps[i]!)) {
        let value = "";
        i++;
        for (;;) {
          if (i >= ps.length) throw new Error("unterminated PowerShell literal");
          if (quote.test(ps[i]!)) {
            if (i + 1 < ps.length && quote.test(ps[i + 1]!)) {
              value += ps[i];
              i += 2;
              continue;
            }
            i++;
            break;
          }
          value += ps[i++];
        }
        words.push(value);
      } else {
        rest.push(ps[i++]!);
      }
    }
    let body: { text?: string } = {};
    try {
      body = JSON.parse(words[1] ?? "");
    } catch {
    }
    assert(
      "19. the literals are: body file, JSON body (exact text), out file, -w, token header, content type, @body file, URL, body file",
      words.length === 9 && words[0] === bodyFile && body.text === hostile && words[2] === outputFile &&
        words[3] === "%{http_code}\\n" && words[4] === "Authorization: tok'en" &&
        words[5] === "Content-Type: application/json" && words[6] === `@${bodyFile}` &&
        words[7] === "https://tts.us.assemblyai.com/v1/speech" && words[8] === bodyFile,
      JSON.stringify(words)
    );
    const bare = rest.join("").replace(/\s+/g, " ").trim();
    assert(
      "19. outside the literals there is only fixed code: WriteAllText, curl.exe (not the curl alias), Remove-Item",
      bare === "[IO.File]::WriteAllText((Join-Path $PWD ), ); curl.exe -sS -o -w -H -H --data-binary ; Remove-Item",
      bare
    );
    assert("19. the PowerShell command never holds the API key", !ps.includes(KEY));
  });

  await withClient(async (client) => {
    for (const delivery of ["file", "inline"]) {
      resetMock([tokenOk(), audioOk(new Uint8Array([1]))]);
      const res = await speak(client, { text: "Hallo, wie geht es dir?", voice_id: "aai-carrie", language: "german", delivery });
      const text = textOf(res);
      assert(
        `20. aai-carrie (english) with language "german" and ${delivery} is refused with no request`,
        res.isError === true && calls.length === 0 && text.includes('voice_id "aai-carrie" speaks english, but language is "german"') &&
          text.includes("aai-magdalena") && text.includes("aai-jorg") && text.includes("Nothing was billed"),
        `${text} | ${calls.length} calls`
      );
    }
    resetMock([tokenOk()]);
    let res = await speak(client, { text: "Hallo.", voice_id: "aai-jorg", language: "german" });
    assert("20. a known voice with its own language is not refused", res.isError !== true && calls.length === 1, textOf(res));
    resetMock([tokenOk()]);
    res = await speak(client, { text: "Hello.", voice_id: "aai-carrie" });
    assert("20. a known voice with no language is not refused", res.isError !== true && calls.length === 1, textOf(res));
    resetMock([tokenOk()]);
    res = await speak(client, { text: "Hallo.", voice_id: "my-cloned-voice", language: "german" });
    const next = String(res.structuredContent?.next_step ?? "");
    assert(
      "20. an unknown voice with a language is not refused (it may speak any language), only warned",
      res.isError !== true && calls.length === 1 && next.includes("not one of the voices"),
      textOf(res)
    );
  });

  await withClient(async (client) => {
    for (const voice_id of ["constructor", "toString", "__proto__"]) {
      resetMock([tokenOk()]);
      const res = await speak(client, { text: "Hello.", voice_id, language: "german" });
      const next = String(res.structuredContent?.next_step ?? "");
      assert(
        `21. voice_id "${voice_id}" gets the unknown-voice warning, not a crash or a mismatch refusal`,
        res.isError !== true && next.startsWith(`voice_id "${voice_id}" is not one of the voices`),
        `${textOf(res)} | ${next.slice(0, 120)}`
      );
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  finished = true;
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error(err);
  finished = true;
  process.exit(1);
});
