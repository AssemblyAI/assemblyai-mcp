/**
 * Error-body cap tests: error paths must not buffer an unbounded response body.
 *
 * Run with: npx tsx src/error-cap-test.ts
 *
 *   1. readErrorText truncates a 5MB error body to the cap
 *   2. readErrorText stops reading early instead of buffering the whole body
 *   3. readErrorText preserves small bodies exactly
 *   4. createSpeech keeps the `HTTP <status>: <first 500 chars>` format on a huge body
 */
import { MAX_ERROR_BODY_BYTES, readErrorText } from "./assemblyai";
import { createSpeech } from "./tts";

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

const FIVE_MB = 5 * 1024 * 1024;
const CHUNK = 64 * 1024;

function countingBody(totalBytes: number, onBytes: (n: number) => void): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      const n = Math.min(CHUNK, totalBytes - sent);
      sent += n;
      onBytes(n);
      controller.enqueue(new Uint8Array(n).fill(97));
    },
  });
}

async function run() {
  console.log("Running error body cap tests…\n");

  const big = new Response(countingBody(FIVE_MB, () => {}), { status: 400 });
  const text = await readErrorText(big);
  assert(
    "5MB error body is truncated to the cap",
    Buffer.byteLength(text, "utf8") <= MAX_ERROR_BODY_BYTES,
    `got ${Buffer.byteLength(text, "utf8")} bytes`
  );
  assert("truncated body keeps the `a` prefix", text.startsWith("a".repeat(100)));

  let streamed = 0;
  const counted = new Response(countingBody(FIVE_MB, (n) => (streamed += n)), { status: 500 });
  await readErrorText(counted);
  assert(
    "reader cancels early instead of buffering the whole body",
    streamed <= MAX_ERROR_BODY_BYTES + CHUNK,
    `streamed ${streamed} bytes`
  );

  const smallBody = JSON.stringify({ error: "bad voice" });
  assert(
    "small bodies are preserved exactly",
    (await readErrorText(new Response(smallBody, { status: 400 }))) === smallBody
  );

  const huge = "x".repeat(FIVE_MB);
  globalThis.fetch = (async () => new Response(huge, { status: 400 })) as typeof fetch;
  try {
    await createSpeech(process.env.ASSEMBLYAI_API_KEY ?? "test-key", { text: "hi", format: "mp3" });
    assert("huge TTS error body throws", false);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    assert(
      "TTS error keeps `HTTP <status>: <first 500 chars>` format",
      message === `HTTP 400: ${"x".repeat(500)}`,
      `got ${message.length} chars`
    );
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
