/**
 * Offline retry-signal tests for fork issue #4:
 * requestWithRetry reused a single AbortSignal across retries.
 *
 * Run with: npx tsx src/retry-signal-test.ts
 *
 *   1. attempt 2 gets a fresh signal (not the instantly-aborted attempt-1 signal)
 *   2. a backoff overshoot skips the doomed request and preserves the 500
 */
const KEY = "test-key";

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

async function run() {
  console.log("Running retry signal tests…\n");
  const { requestWithRetry, AssemblyAIError } = await import("./assemblyai");
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;

  // 1. Fresh signal per attempt.
  {
    const seen: AbortSignal[] = [];
    const abortedAtEntry: boolean[] = [];
    let calls = 0;
    globalThis.fetch = (async (_url: unknown, init?: { signal?: AbortSignal }) => {
      calls++;
      const signal = init?.signal as AbortSignal;
      seen.push(signal);
      abortedAtEntry.push(signal?.aborted ?? true);
      if (calls === 1) {
        return new Response('{"error":"upstream failure"}', {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response('{"id":"x","status":"completed"}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const parsed = await requestWithRetry<{ id: string; status: string }>(
        KEY,
        "GET",
        "/v2/transcript/ok",
        undefined,
        3,
        "http://127.0.0.1",
        15_000
      );
      assert(
        "1. retry uses a fresh signal and succeeds",
        calls === 2 &&
          parsed.id === "x" &&
          seen[0] !== seen[1] &&
          abortedAtEntry[0] === false &&
          abortedAtEntry[1] === false,
        `${calls} fetch calls | same object: ${seen[0] === seen[1]} | aborted: ${JSON.stringify(abortedAtEntry)}`
      );
    } catch (err) {
      assert("1. retry uses a fresh signal and succeeds", false, String(err));
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  // 2. Backoff overshoot skips the doomed request, preserving the 500.
  {
    let calls = 0;
    globalThis.fetch = (async (_url: unknown, init?: { signal?: AbortSignal }) => {
      calls++;
      if (init?.signal?.aborted) throw new DOMException("This operation was aborted", "AbortError");
      return new Response('{"error":"upstream failure"}', {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    // Fake timers: every JS timer overshoots by 3 s, simulating an
    // event-loop stall during backoff. AbortSignal.timeout is native and
    // unaffected, so the post-wake recheck must catch the spent deadline.
    globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
      originalSetTimeout(fn, (ms ?? 0) + 3000, ...args)) as typeof setTimeout;
    try {
      const start = Date.now();
      let error: unknown;
      try {
        await requestWithRetry(KEY, "GET", "/v2/transcript/error500", undefined, 3, "http://127.0.0.1", 2500);
      } catch (err) {
        error = err;
      }
      const ms = Date.now() - start;
      assert(
        "2. overshot backoff skips doomed request and keeps the 500",
        calls === 1 &&
          error instanceof AssemblyAIError &&
          error.status === 500 &&
          error.message.includes("upstream failure"),
        `${calls} fetch calls | ${ms} ms | ${String(error)}`
      );
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.fetch = originalFetch;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
