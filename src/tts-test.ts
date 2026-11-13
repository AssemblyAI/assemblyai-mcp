/**
 * Offline tests for create_speech (text to speech), with a stubbed fetch.
 *
 * Run with: npx tsx src/tts-test.ts   (part of `npm test`)
 *
 *   1. create_speech is hidden unless TTS_ENABLED is exactly "1"
 *   2. when offered: titled, not read-only, and the description states the cost
 *   3. delivery "file": mints a TTS-only token, returns a curl command, calls no TTS
 *   4. the command is a safe shell literal for hostile text
 *   5. format, voice and language reach the command; wav sets the container
 *   6. text limits count Unicode code points; over the limit is refused with no request
 *   7. delivery "inline": one buffered MP3 request, the audio comes back as an audio block
 *   8. inline refusals: too long, wav, blank; an empty clip is an error
 *   9. API errors map to a next step (voice, funds, rate limit, key)
 *  10. token service failures
 *  11. logs never hold the text, the token or the key
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { registerTools } from "./server";
import { INLINE_BIT_RATE, MAX_INLINE_SPEECH_CHARS, MAX_SPEECH_CHARS, SPEECH_TOKEN_TTL_SECONDS } from "./tts";

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
  // Stand in for withMcpAuth: take the key from _meta and put it in extra.authInfo.
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

/** Run fn with console.log captured; returns the captured lines. */
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

// A promise that never settles lets the event loop drain and the process exit 0
// with no summary. Make that a failure.
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

  // 1. The flag
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

  // 2. The definition
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

  // 3. File delivery: a token, a command, no synthesis
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
    assert(
      "3. the command posts a buffered MP3 request to the TTS host and saves speech.mp3",
      command.startsWith("curl -sS -o 'speech.mp3' ") && command.endsWith("'https://tts.us.assemblyai.com/v1/speech'") &&
        command.includes('"encoding":"mp3"') && command.includes('"stream":false') &&
        res.structuredContent?.output_file === "speech.mp3" && res.structuredContent?.delivery === "file",
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

  // 4. The text is the caller's: it must stay a shell literal. The payload only
  // ever writes a marker file in a temp dir, so a quoting bug fails this test
  // and harms nothing.
  await withClient(async (client) => {
    const dir = mkdtempSync(join(tmpdir(), "tts-test-"));
    const marker = join(dir, "injected");
    const hostile =
      `It's $(touch ${marker}) \`touch ${marker}\` "quoted" \\ back\nline two; touch ${marker} && echo 'x' | touch ${marker} é 😀`;
    resetMock([tokenOk("tok'en")]);
    const res = await speak(client, { text: hostile });
    const command = String(res.structuredContent?.command ?? "");
    // Same words, but printed instead of sent: each shell word on its own line.
    let printed = "";
    try {
      printed = execFileSync("sh", ["-c", command.replace(/^curl /, "printf '%s\\n' ")], {
        encoding: "utf8",
        cwd: dir,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      // A shell error is a quoting failure; the assertions below report it.
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
      // leave parsed empty: the assertion below fails with the words
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
      words.filter((w) => w !== "").length === 10 && words[9] === "https://tts.us.assemblyai.com/v1/speech",
      JSON.stringify(words)
    );
  });

  // 5. Options reach the command
  await withClient(async (client) => {
    resetMock([tokenOk()]);
    const res = await speak(client, { text: "Hola.", voice_id: "aai-constanza", language: "spanish", format: "wav" });
    const command = String(res.structuredContent?.command ?? "");
    const body = JSON.parse(command.match(/-d '(\{.*\})' /)?.[1] ?? "{}");
    assert(
      "5. wav sets pcm_s16le in a wav container and names speech.wav; voice and language pass through",
      body.encoding === "pcm_s16le" && body.container === "wav" && body.voice_id === "aai-constanza" &&
        body.language === "spanish" && body.bit_rate === undefined && command.includes("-o 'speech.wav'"),
      command
    );
    resetMock([]);
    const bad = await speak(client, { text: "Hi.", voice_id: "aai-kyla'; rm -rf ~" });
    assert("5. a voice_id with shell characters is refused by the schema", bad.isError === true && calls.length === 0);
    const badLanguage = await speak(client, { text: "Hi.", language: "en" });
    assert("5. a language outside the six is refused by the schema", badLanguage.isError === true && calls.length === 0);
  });

  // 6. Limits are in code points
  await withClient(async (client) => {
    resetMock([tokenOk()]);
    const emoji = "😀".repeat(MAX_SPEECH_CHARS); // 2 UTF-16 units each
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

  // 7. Inline delivery
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

  // 8. Inline refusals
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

  // 9. API errors
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
      key.isError === true && textOf(key).includes("rejected the API key") && !textOf(key).includes(KEY),
      textOf(key)
    );
  });

  // 10. Token service
  await withClient(async (client) => {
    resetMock([json(401, { detail: "Invalid API key" })]);
    const rejected = await speak(client, { text: "Hi." });
    assert(
      "10. a key the token service rejects gets the standard message, and no command",
      rejected.isError === true && textOf(rejected).includes("rejected the API key") && !textOf(rejected).includes("curl"),
      textOf(rejected)
    );
    resetMock([json(200, {})]);
    const none = await speak(client, { text: "Hi." });
    assert("10. an answer with no token is an error, not a command without one", none.isError === true && !textOf(none).includes("curl"), textOf(none));
  });

  // 11. Logs
  await withClient(async (client) => {
    const secretText = "The merger closes on Friday at noon.";
    const logs = await captureLogs(async () => {
      resetMock([tokenOk("TMP-TOKEN-zzz")]);
      await speak(client, { text: secretText });
      resetMock([audioOk(new Uint8Array([1, 2, 3]))]);
      await speak(client, { text: secretText, delivery: "inline" });
      resetMock([ttsError(422, "invalid_parameter", "text: bad")]);
      await speak(client, { text: secretText, delivery: "inline" });
      resetMock([]);
      await speak(client, { text: "a".repeat(MAX_SPEECH_CHARS + 1) });
    });
    const events = logs.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert(
      "11. logs never hold the text, the token or the key",
      !logs.includes("merger") && !logs.includes("TMP-TOKEN-zzz") && !logs.includes(KEY) && !logs.includes("aaaaaaaa"),
      logs
    );
    assert(
      "11. each call logs one event with the size, delivery and outcome",
      events.length === 4 && events.every((e) => e.tool === "create_speech" && typeof e.chars === "number") &&
        events[0].status === "success" && events[0].delivery === "file" &&
        events[1].status === "success" && events[1].billed_characters === 12 &&
        events[2].status === "error" && events[2].code === "invalid_parameter" &&
        events[3].status === "rejected" && events[3].reason === "text_too_long",
      logs
    );
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
