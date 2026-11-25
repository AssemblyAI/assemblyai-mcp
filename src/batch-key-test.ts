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
  return payload?.result.content?.[0]?.text ?? "";
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

  globalThis.fetch = originalFetch;
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
