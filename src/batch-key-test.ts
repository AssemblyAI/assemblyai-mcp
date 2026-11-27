/**
 * Regression test for issue #128: a JSON-RPC batch sharing one API key must
 * not make one outbound AssemblyAI call per tool call in the batch when that
 * key is rejected. Exercises the real /mcp route end to end (not the
 * in-memory transport smoke-test.ts uses for individual tools), since the
 * fix is in how the route shares one key-rejection outcome across every tool
 * call reached from the same incoming request.
 *
 * Run with: npx tsx src/batch-key-test.ts   (part of `npm test`)
 *
 *   1. a 100-message batch with one invalid key makes only one outbound
 *      call, and every message still gets its own matching response
 *   2. a batch with a valid key is unaffected: every call still makes its
 *      own outbound request and gets its own distinct, correct result
 *   3. a 404 on one call (not a rejected key) never poisons the others
 */
import { AssemblyAIError, requestWithRetry, withRequestKeyProbes } from "./assemblyai";
import { withRequestClock } from "./deadline";

import { POST } from "../app/mcp/[[...path]]/route";

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

const originalFetch = globalThis.fetch;

function batchRequest(bearer: string, messages: Array<Record<string, unknown>>): Request {
  return new Request("https://mcp.assemblyai.com/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(messages),
  });
}

function getTranscriptCall(id: number, transcriptId: string) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "get_transcript", arguments: { transcript_id: transcriptId } },
  };
}

interface JsonRpcResult {
  id: number;
  result: { content?: Array<{ text?: string }> };
}

/** The route answers a batch as one SSE body, one "event: message" chunk per JSON-RPC response. */
async function ssePayloads(res: Response): Promise<JsonRpcResult[]> {
  const text = await res.text();
  return text
    .split("event: message\ndata: ")
    .slice(1)
    .map((chunk) => JSON.parse(chunk.trim()) as JsonRpcResult);
}

function textOf(payload: JsonRpcResult | undefined): string {
  return payload?.result.content?.map((c) => c.text ?? "").join("\n") ?? "";
}

async function run() {
  console.log("Running batch key-rejection tests…\n");

  {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ error: "Authentication error" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const N = 100;
    const messages = Array.from({ length: N }, (_, i) => getTranscriptCall(i + 1, `txn-${i}`));
    const res = await POST(batchRequest("garbage", messages));
    const payloads = await ssePayloads(res);
    const ids = payloads.map((p) => p.id).sort((a, b) => a - b);
    const everyRejected = payloads.every((p) => textOf(p).includes("rejected the API key"));
    assert(
      // The dispatch for a batch fires every message before any of their network
      // calls can resolve, so in practice this is exactly 1 — allow a little
      // slack rather than pin an exact number sensitive to scheduling.
      "1. a 100-message batch with one invalid key makes at most 2 outbound calls, not 100",
      calls <= 2,
      `calls=${calls}`
    );
    assert(
      "1. every one of the 100 messages still gets its own matching, correct response",
      res.status === 200 &&
        payloads.length === N &&
        JSON.stringify(ids) === JSON.stringify(Array.from({ length: N }, (_, i) => i + 1)) &&
        everyRejected,
      `status=${res.status} payloads=${payloads.length} everyRejected=${everyRejected}`
    );
  }

  {
    let calls = 0;
    const seen = new Set<string>();
    globalThis.fetch = (async (url: string | URL | Request) => {
      calls++;
      const id = String(url).split("/").pop()!;
      seen.add(id);
      return new Response(JSON.stringify({ id, status: "completed", text: `text for ${id}` }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const N = 10;
    const messages = Array.from({ length: N }, (_, i) => getTranscriptCall(i + 1, `valid-${i}`));
    const res = await POST(batchRequest("a-real-looking-valid-key", messages));
    const payloads = await ssePayloads(res);
    assert(
      "2. a batch with a valid key is unaffected: every call still makes its own outbound request",
      calls === N && seen.size === N,
      `calls=${calls} distinct=${seen.size}`
    );
    const everyOwnResult = payloads.every((p, i) => textOf(p).includes(`text for valid-${i}`));
    assert(
      "2. every call still returns its own distinct, correct result",
      payloads.length === N && everyOwnResult,
      JSON.stringify(payloads).slice(0, 300)
    );
  }

  {
    let calls = 0;
    globalThis.fetch = (async (url: string | URL | Request) => {
      calls++;
      const id = String(url).split("/").pop()!;
      if (id === "missing") {
        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ id, status: "completed", text: `ok ${id}` }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const messages = [getTranscriptCall(1, "missing"), getTranscriptCall(2, "ok-one"), getTranscriptCall(3, "ok-two")];
    const res = await POST(batchRequest("a-real-looking-valid-key", messages));
    const payloads = await ssePayloads(res);
    const byId = new Map(payloads.map((p) => [p.id, textOf(p)]));
    assert(
      "3. a 404 on one call doesn't poison the others as a rejected key, and each call is still made",
      calls === 3 &&
        (byId.get(1) ?? "").includes("404") &&
        !(byId.get(1) ?? "").includes("rejected the API key") &&
        (byId.get(2) ?? "").includes("ok-one") &&
        (byId.get(3) ?? "").includes("ok-two"),
      JSON.stringify([...byId])
    );
  }

  for (const status of [200, 401]) {
    let finishBody!: () => void;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          finishBody = () => { controller.enqueue(new TextEncoder().encode('{}')); controller.close(); };
        },
      }), { status });
      return Response.json({ ok: true });
    }) as typeof fetch;
    await withRequestClock(withRequestKeyProbes(async () => {
      const first = requestWithRetry("shared-key", "POST", "/slow-body", {}, 1).catch(e => e);
      let siblingDone = false;
      const sibling = requestWithRetry("shared-key", "GET", "/fast").then(
        () => { siblingDone = true; },
        e => { siblingDone = e.status === 401; }
      );
      await new Promise(r => setTimeout(r, 50));
      assert(`4. status ${status} releases siblings before its body finishes`,
        siblingDone && calls === (status === 401 ? 1 : 2), `done=${siblingDone} calls=${calls}`);
      finishBody();
      await Promise.all([first, sibling]);
    }))(undefined);
  }

  for (const status of [200, 401]) {
    let releaseHeaders!: () => void;
    const headersReady = new Promise<void>(r => { releaseHeaders = r; });
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) await headersReady;
      return Response.json(status === 401 ? { error: "bad key" } : { ok: true }, { status });
    }) as typeof fetch;
    await withRequestClock(withRequestKeyProbes(async () => {
      const first = requestWithRetry("slow-key", "POST", "/slow-headers", {}, 1).catch(e => e);
      let siblingDone = false;
      const sibling = requestWithRetry("slow-key", "GET", "/fast").catch(e => e).then(() => { siblingDone = true; });
      await new Promise(r => setTimeout(r, 1000));
      assert(`5. delayed ${status} headers cannot starve a sibling`, siblingDone && calls === 2,
        `done=${siblingDone} calls=${calls}`);
      releaseHeaders();
      await Promise.all([first, sibling]);
      if (status === 401) {
        const later = await requestWithRetry("slow-key", "GET", "/later").catch(e => e);
        assert("5. a known delayed 401 is reused without another request", later instanceof AssemblyAIError && later.status === 401 && calls === 2);
      }
    }))(undefined);
  }

  {
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    let releaseHeaders!: () => void;
    const headersReady = new Promise<void>(r => { releaseHeaders = r; });
    let calls = 0;
    globalThis.fetch = (async () => { calls++; await headersReady; return Response.json({ ok: true }); }) as typeof fetch;
    try {
      await withRequestClock(withRequestKeyProbes(async () => {
        const first = requestWithRetry("budget-key", "POST", "/slow", {}, 1, undefined, 240_000);
        const sibling = requestWithRetry("budget-key", "GET", "/fast").catch(e => e);
        now += 60_001;
        await new Promise(r => setTimeout(r, 350));
        releaseHeaders(); await first;
        const outcome = await sibling;
        assert("6. an expired request budget prevents a sibling fetch", outcome instanceof AssemblyAIError && outcome.status === 504 && calls === 1);
      }))(undefined);
    } finally { Date.now = realNow; }
  }

  const prevTtsEnabled = process.env.TTS_ENABLED;
  process.env.TTS_ENABLED = "1";
  try {
    const createSpeechCall = (id: number, delivery: "file" | "inline") => ({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "create_speech", arguments: { text: `Line ${id}.`, delivery } },
    });

    for (const delivery of ["file", "inline"] as const) {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        return new Response(
          delivery === "file" ? JSON.stringify({ error: "Invalid API key" }) : JSON.stringify({ code: "unauthorized", message: "Invalid API key" }),
          {
            status: delivery === "file" ? 404 : 401,
            headers: { "content-type": "application/json" },
          }
        );
      }) as typeof fetch;

      const N = 20;
      const messages = Array.from({ length: N }, (_, i) => createSpeechCall(i + 1, delivery));
      const res = await POST(batchRequest("garbage-tts-key", messages));
      const payloads = await ssePayloads(res);
      const everyRejected = payloads.every((p) => textOf(p).includes("rejected the API key"));
      assert(
        `7. #162 20-call create_speech(${delivery}) batch with bad key makes at most 2 calls and rejects all`,
        res.status === 200 && calls <= 2 && payloads.length === N && everyRejected,
        `calls=${calls} payloads=${payloads.length} everyRejected=${everyRejected}`
      );
    }

    {
      const urls: string[] = [];
      globalThis.fetch = (async (url: string | URL | Request) => {
        urls.push(String(url));
        return new Response(JSON.stringify({ error: "Invalid API key" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;

      const messages = [
        getTranscriptCall(1, "00000000-0000-0000-0000-000000000000"),
        ...Array.from({ length: 5 }, (_, i) => createSpeechCall(i + 2, i % 2 === 0 ? "file" : "inline")),
      ];
      const res = await POST(batchRequest("garbage-mixed-key", messages));
      const payloads = await ssePayloads(res);
      assert(
        "7. #162 mixed get_transcript + create_speech batch shares key rejection outcome",
        res.status === 200 && urls.length <= 2 && payloads.length === messages.length &&
          payloads.every((p) => textOf(p).includes("rejected the API key")),
        `urls=${JSON.stringify(urls)}`
      );
    }

    {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        return new Response(new Uint8Array([0xff, 0xfb, 0x90, 0x00]), {
          status: 200,
          headers: { "content-type": "audio/mpeg", "x-tts-billed-characters": "8" },
        });
      }) as typeof fetch;

      const N = 5;
      const messages = Array.from({ length: N }, (_, i) => createSpeechCall(i + 1, "inline"));
      const res = await POST(batchRequest("valid-tts-key", messages));
      const payloads = await ssePayloads(res);
      assert(
        "7. #162 valid-key create_speech batch still executes every call",
        res.status === 200 && calls === N && payloads.length === N &&
          payloads.every((p) => textOf(p).includes("8 characters billed")),
        `calls=${calls} payloads=${payloads.length}`
      );
    }
  } finally {
    if (prevTtsEnabled === undefined) delete process.env.TTS_ENABLED;
    else process.env.TTS_ENABLED = prevTtsEnabled;
  }

  globalThis.fetch = originalFetch;
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
