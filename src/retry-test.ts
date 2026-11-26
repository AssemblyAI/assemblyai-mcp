/**
 * Offline transport regressions, including real HTTP bodies cut off after
 * headers. No API key or external service is used.
 */
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { test } from "node:test";

interface Reply {
  status: number;
  body: string;
  drop?: boolean;
}

const originalFetch = globalThis.fetch;
let replies: Reply[] = [];
let requests: Array<{ method: string; url: string }> = [];
let interruptedResponse: ServerResponse | undefined;
const server = createServer((req, res) => {
  requests.push({ method: req.method!, url: req.url! });
  const reply = replies.shift();
  if (!reply) {
    res.writeHead(500).end("Unexpected request");
    return;
  }
  res.writeHead(reply.status, { "Content-Type": "application/json" });
  if (reply.drop) {
    interruptedResponse = res;
    res.write(reply.body);
  } else {
    res.end(reply.body);
  }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address !== "string");
const baseUrl = `http://127.0.0.1:${address.port}`;
// Set before importing so the real public helper uses the loopback server.
const previousBaseUrl = process.env.ASSEMBLYAI_BASE_URL;
process.env.ASSEMBLYAI_BASE_URL = baseUrl;
const {
  AssemblyAIError, getTranscript, getRedactedAudio, deleteTranscript,
  submitTranscript,
} = await import("./assemblyai");
if (previousBaseUrl === undefined) delete process.env.ASSEMBLYAI_BASE_URL;
else process.env.ASSEMBLYAI_BASE_URL = previousBaseUrl;
const { summarizeViaLlmGateway, understandTranscript } = await import("./llm-gateway");

const success = '{"id":"txn-retry","status":"completed","text":"recovered"}';
const get = () => getTranscript("test-key", "txn-retry");
const isTransportError = (err: unknown) =>
  err instanceof AssemblyAIError && err.status === 502;

function failedBody(status: number): Response {
  let partialSent = false;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!partialSent) {
        partialSent = true;
        controller.enqueue(new TextEncoder().encode('{"partial":'));
      } else {
        controller.error(new TypeError("body connection reset"));
      }
    },
  }), { status });
}

function mock(responses: Array<() => Response>) {
  let count = 0;
  globalThis.fetch = (async () => {
    count++;
    assert(responses.length > 0, "unexpected retry");
    return responses.shift()!();
  }) as typeof fetch;
  return () => count;
}

function realHttp(responses: Reply[]) {
  replies = [...responses];
  requests = [];
  interruptedResponse = undefined;
  globalThis.fetch = (async (input, init) => {
    const response = await originalFetch(input, init);
    // Synchronize on real fetch resolving the headers, not a timing guess:
    // the next body read sees an actual socket drop, never a fetch rejection.
    const interrupted = interruptedResponse;
    interruptedResponse = undefined;
    interrupted?.destroy();
    return response;
  }) as typeof fetch;
}

try {
  for (const status of [200, 503]) {
    await test(`body-stream ${status}: GET retries and recovers`, async () => {
      const count = mock([
        () => failedBody(status),
        () => new Response(success),
      ]);
      assert.equal((await get()).text, "recovered");
      assert.equal(count(), 2);
    });
    await test(`body-stream ${status}: GET exhausts three attempts as 502`, async () => {
      const count = mock(Array.from({ length: 3 }, () => () => failedBody(status)));
      await assert.rejects(get, isTransportError);
      assert.equal(count(), 3);
    });
  }

  for (const status of [401, 404, 429]) {
    await test(`body-stream ${status}: known 4xx never retries`, async () => {
      const count = mock([() => failedBody(status)]);
      await assert.rejects(get, isTransportError);
      assert.equal(count(), 1);
    });
  }

  const singleAttemptCalls = [
    ["submit", () => submitTranscript("test-key", { audio_url: "https://example.com/a.mp3" })],
    ["summary", () => summarizeViaLlmGateway("test-key", { transcript_id: "txn-retry", prompt: "Summarize" })],
    ["understanding", () => understandTranscript("test-key", { transcript_id: "txn-retry", speech_understanding: { request: {} } })],
    ["delete", () => deleteTranscript("test-key", "txn-retry")],
    ["redacted audio", () => getRedactedAudio("test-key", "txn-retry")],
  ] as const;
  for (const [name, call] of singleAttemptCalls) {
    for (const status of [200, 503]) {
      await test(`body-stream ${status}: ${name} remains single-attempt`, async () => {
        const count = mock([() => failedBody(status)]);
        await assert.rejects(call, isTransportError);
        assert.equal(count(), 1);
      });
    }
  }

  const mayHaveGoneThrough = (err: unknown) =>
    isTransportError(err) && /may still have gone through/.test((err as Error).message) &&
    /could run it twice/.test((err as Error).message);
  const claimsNothing = (err: unknown) =>
    isTransportError(err) && !/gone through/.test((err as Error).message);
  for (const [name, call] of singleAttemptCalls) {
    if (name === "redacted audio") continue;
    await test(`#149 body-stream 200: ${name} says the accepted request may have gone through`, async () => {
      const count = mock([() => failedBody(200)]);
      await assert.rejects(call, mayHaveGoneThrough);
      assert.equal(count(), 1);
    });
    await test(`#149 body-stream 503: ${name} does not claim the request went through`, async () => {
      mock([() => failedBody(503)]);
      await assert.rejects(call, claimsNothing);
    });
  }
  await test("#149 body-stream 200: a GET that exhausts its attempts does not claim anything went through", async () => {
    mock(Array.from({ length: 3 }, () => () => failedBody(200)));
    await assert.rejects(get, claimsNothing);
  });
  await test("#149 body-stream 200: single-attempt redacted-audio GET does not claim anything went through", async () => {
    mock([() => failedBody(200)]);
    await assert.rejects(() => getRedactedAudio("test-key", "txn-retry"), claimsNothing);
  });

  await test("complete malformed success JSON is not retried", async () => {
    const count = mock([() => new Response('{"incomplete":')]);
    await assert.rejects(get, SyntaxError);
    assert.equal(count(), 1);
  });
  await test("complete 4xx retains HTTP status, message and gateway details", async () => {
    const count = mock([() => new Response(JSON.stringify({
      message: "invalid request body", metadata: { errors: ["specific reason"] },
    }), { status: 400 })]);
    await assert.rejects(get, (err: unknown) =>
      err instanceof AssemblyAIError && err.status === 400 &&
      err.message === "HTTP 400: invalid request body" && err.detail === "specific reason");
    assert.equal(count(), 1);
  });
  await test("complete 503 exhaustion retains HTTP error details", async () => {
    const count = mock(Array.from({ length: 3 }, () => () => new Response(
      '{"error":"unavailable","metadata":{"errors":["try later"]}}', { status: 503 },
    )));
    await assert.rejects(get, (err: unknown) =>
      err instanceof AssemblyAIError && err.status === 503 &&
      err.message === "HTTP 503: unavailable" && err.detail === "try later");
    assert.equal(count(), 3);
  });

  for (const status of [200, 503]) {
    await test(`real HTTP ${status} socket drop: getTranscript recovers`, async () => {
      realHttp([{ status, body: '{"partial":', drop: true }, { status: 200, body: success }]);
      assert.equal((await get()).text, "recovered");
      assert.deepEqual(requests, Array.from({ length: 2 }, () =>
        ({ method: "GET", url: "/v2/transcript/txn-retry" })));
      assert.equal(replies.length, 0);
    });
    await test(`real HTTP ${status} socket drops: getTranscript exhausts as 502`, async () => {
      realHttp(Array.from({ length: 3 }, () => ({ status, body: '{"partial":', drop: true })));
      await assert.rejects(get, isTransportError);
      assert.equal(requests.length, 3);
      assert.equal(replies.length, 0);
    });
  }
  await test("real HTTP complete success: one request", async () => {
    realHttp([{ status: 200, body: success }]);
    assert.equal((await get()).text, "recovered");
    assert.equal(requests.length, 1);
  });
  await test("real HTTP complete malformed JSON: no replay", async () => {
    realHttp([{ status: 200, body: '{"partial":' }]);
    await assert.rejects(get, SyntaxError);
    assert.equal(requests.length, 1);
  });
  await test("real HTTP 404 socket drop: no replay", async () => {
    realHttp([{ status: 404, body: '{"error":', drop: true }]);
    await assert.rejects(get, isTransportError);
    assert.equal(requests.length, 1);
  });
  await test("real HTTP POST socket drop: no replay", async () => {
    realHttp([{ status: 200, body: '{"id":', drop: true }]);
    await assert.rejects(
      () => submitTranscript("test-key", { audio_url: "https://example.com/a.mp3" }),
      mayHaveGoneThrough,
    );
    assert.deepEqual(requests, [{ method: "POST", url: "/v2/transcript" }]);
  });
} finally {
  globalThis.fetch = originalFetch;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
}
