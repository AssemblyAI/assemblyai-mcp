import { AudioTooLargeError, createSpeech, MAX_INLINE_AUDIO_BYTES } from "./tts";

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

const CHUNK = 256 * 1024;
function endless(limitChunks = Infinity) {
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
}

async function run() {
  console.log("Running audio cap tests…\n");

  // Default cap applies when limits.maxBytes is undefined: declared over-cap refuses without buffering.
  let s = endless();
  globalThis.fetch = (async () =>
    new Response(s.body as unknown as BodyInit, {
      status: 200,
      headers: { "Content-Type": "audio/mpeg", "Content-Length": String(MAX_INLINE_AUDIO_BYTES + 1) },
    })) as typeof fetch;
  try {
    await createSpeech("sk-test", { text: "Hello.", format: "mp3" });
    assert("declared over-cap with no maxBytes throws AudioTooLargeError", false);
  } catch (err) {
    assert(
      "declared over-cap with no maxBytes throws AudioTooLargeError",
      err instanceof AudioTooLargeError && err.bytes === MAX_INLINE_AUDIO_BYTES + 1 && err.exact === true,
      String(err)
    );
  }
  assert("declared over-cap body is cancelled without full read", s.stats.pulled <= CHUNK && s.stats.cancelled, `pulled ${s.stats.pulled}`);

  // No content-length + endless body: capped just past MAX_INLINE_AUDIO_BYTES, not OOM.
  s = endless();
  globalThis.fetch = (async () =>
    new Response(s.body as unknown as BodyInit, { status: 200, headers: { "Content-Type": "audio/mpeg" } })) as typeof fetch;
  try {
    await createSpeech("sk-test", { text: "Hello.", format: "mp3" });
    assert("endless body with no maxBytes throws AudioTooLargeError", false);
  } catch (err) {
    assert(
      "endless body with no maxBytes throws AudioTooLargeError",
      err instanceof AudioTooLargeError,
      String(err)
    );
  }
  assert(
    "endless body is cut just past the cap and cancelled",
    s.stats.pulled <= MAX_INLINE_AUDIO_BYTES + 2 * CHUNK && s.stats.cancelled,
    `pulled ${s.stats.pulled}`
  );

  // Under-cap body still succeeds through the default cap.
  s = endless(4);
  globalThis.fetch = (async () =>
    new Response(s.body as unknown as BodyInit, { status: 200, headers: { "Content-Type": "audio/mpeg" } })) as typeof fetch;
  const res = await createSpeech("sk-test", { text: "Hello.", format: "mp3" });
  assert("under-cap body with no maxBytes succeeds", res.audio.byteLength === 4 * CHUNK, String(res.audio.byteLength));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
