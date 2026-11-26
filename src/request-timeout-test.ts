/**
 * Offline request deadline tests, using real fetch against a local HTTP server.
 *
 * Run with: npx tsx src/request-timeout-test.ts   (part of `npm test`)
 *
 *   1. a stalled header wait times out without retrying
 *   2. a stalled successful response body times out
 *   3. a stalled 5xx error body times out
 *   4. a timed-out POST warns it may have gone through
 *   5. no backoff follows the last failed attempt
 *   6. a backoff that leaves too little time is skipped
 *   7. too little time refuses the request before sending
 *   8. sign-in time counts against the default deadline
 *   9. LLM Gateway calls have their own longer deadline
 *  10. successful JSON, 4xx, invalid JSON and network errors retain their behavior
 *  11. a timed-out get_transcript reaches the MCP client as an error
 *  12. a redacted-audio timeout in get_transcript reads as pending, not as an expired link
 */
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { performance } from "node:perf_hooks";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

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
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
}

const KEY = "test-key";
const TOOL_ID = "5551722-f677-48a6-9287-39c0aafd9ac1";
const REDACTED_ID = "6662833-f677-48a6-9287-39c0aafd9ac2";

async function run() {
  console.log("Running request timeout tests…\n");
  const counts = new Map<string, number>();
  const sockets = new Set<Socket>();
  const server = createServer((req, res) => {
    const path = req.url ?? "";
    counts.set(path, (counts.get(path) ?? 0) + 1);
    if (path === "/v2/transcript/hang" || path === "/v2/transcript/hang-id" ||
        path === `/v2/transcript/${TOOL_ID}` || path === "/v2/transcript/post-hang" ||
        path === `/v2/transcript/${REDACTED_ID}/redacted-audio`) return;
    if (path === `/v2/transcript/${REDACTED_ID}`) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: REDACTED_ID, status: "completed", text: "hi", redact_pii_audio: true }));
      return;
    }
    if (path === "/v2/transcript/drip" || path === "/v2/transcript/error-drip") {
      res.writeHead(path.endsWith("error-drip") ? 500 : 200, { "Content-Type": "application/json" });
      res.write('{"id":"x",');
      return;
    }
    if (path === "/v2/transcript/error500") {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end('{"error":"upstream failure"}');
      return;
    }
    if (path === "/v2/transcript/missing") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end('{"error":"not found"}');
      return;
    }
    if (path === "/v2/transcript/invalid-json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{invalid");
      return;
    }
    if (path === "/v2/transcript/broken-body") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"id":"x",');
      setTimeout(() => res.destroy(), 20);
      return;
    }
    if (path === "/v1/chat/completions") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"choices":[{"message":{"content":"ok"}}]}');
      return;
    }
    if (path === "/v1/understanding") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"request_id":"ok"}');
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"id":"x","status":"completed"}');
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No HTTP server address");
  const base = `http://127.0.0.1:${address.port}`;
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    process.env.ASSEMBLYAI_BASE_URL = base;
    process.env.ASSEMBLYAI_LLM_GATEWAY_BASE_URL = base;
    const { AssemblyAIError, getTranscript, requestWithRetry } = await import("./assemblyai");
    const { LLM_GATEWAY_TIMEOUT_MS, summarizeViaLlmGateway, understandTranscript } = await import("./llm-gateway");
    const { registerTools } = await import("./server");
    const { withRequestClock } = await import("./deadline");

    const afterSignIn = <T>(usedMs: number, fn: () => Promise<T>): Promise<T> => {
      const realNow = Date.now;
      Date.now = () => realNow() - usedMs;
      try {
        return withRequestClock(async (_: void) => {
          await Promise.resolve();
          return fn();
        })(undefined);
      } finally {
        Date.now = realNow;
      }
    };
    const count = (path: string) => counts.get(path) ?? 0;
    const timedError = async (fn: () => Promise<unknown>) => {
      const start = performance.now();
      let error: unknown;
      try {
        await fn();
      } catch (err) {
        error = err;
      }
      return { error, ms: performance.now() - start };
    };
    const isError = (error: unknown, status: number, text?: string) =>
      error instanceof AssemblyAIError && error.status === status && (!text || error.message.includes(text));
    const detail = (error: unknown, ms: number, path: string) =>
      `${String(error)} | ${ms.toFixed(0)} ms | ${count(path)} requests`;
    const inRange = (ms: number, min: number, max: number) => ms >= min && ms < max;

    const hang = "/v2/transcript/hang";
    let result = await timedError(() => requestWithRetry(KEY, "GET", hang, undefined, 3, base, 1500));
    assert(`1. headers time out without retry (${result.ms.toFixed(0)} ms)`,
      isError(result.error, 504, "did not answer") && isError(result.error, 504, "try again") &&
        inRange(result.ms, 1400, 2500) && count(hang) === 1, detail(result.error, result.ms, hang));

    const drip = "/v2/transcript/drip";
    result = await timedError(() => requestWithRetry(KEY, "GET", drip, undefined, 3, base, 1500));
    assert(`2. stalled 200 body times out (${result.ms.toFixed(0)} ms)`,
      isError(result.error, 504, "did not answer") && inRange(result.ms, 1400, 2500) && count(drip) === 1,
      detail(result.error, result.ms, drip));

    const errorDrip = "/v2/transcript/error-drip";
    result = await timedError(() => requestWithRetry(KEY, "GET", errorDrip, undefined, 3, base, 1500));
    assert(`3. stalled 500 body times out (${result.ms.toFixed(0)} ms)`,
      isError(result.error, 504, "did not answer") && inRange(result.ms, 1400, 2500) && count(errorDrip) === 1,
      detail(result.error, result.ms, errorDrip));

    const postHang = "/v2/transcript/post-hang";
    result = await timedError(() => requestWithRetry(KEY, "POST", postHang, { x: 1 }, 1, base, 1500));
    assert(`4. timed-out POST warns of possible duplicate (${result.ms.toFixed(0)} ms)`,
      isError(result.error, 504, "may still have gone through") && inRange(result.ms, 1400, 2500) &&
        count(postHang) === 1, detail(result.error, result.ms, postHang));

    const error500 = "/v2/transcript/error500";
    result = await timedError(() => requestWithRetry(KEY, "GET", error500, undefined, 1, base));
    assert(`5. one 500 has no final backoff (${result.ms.toFixed(0)} ms)`,
      isError(result.error, 500) && result.ms < 500 && count(error500) === 1,
      detail(result.error, result.ms, error500));
    counts.delete(error500);
    result = await timedError(() => requestWithRetry(KEY, "GET", error500, undefined, 3, base));
    assert(`5. three 500s have only 1 s and 2 s backoffs (${result.ms.toFixed(0)} ms)`,
      isError(result.error, 500) && inRange(result.ms, 2900, 4000) && count(error500) === 3,
      detail(result.error, result.ms, error500));

    counts.delete(error500);
    result = await timedError(() => requestWithRetry(KEY, "GET", error500, undefined, 3, base, 2500));
    assert(`6. backoff that cannot fit is skipped (${result.ms.toFixed(0)} ms)`,
      isError(result.error, 500) && result.ms < 1800 && count(error500) === 2,
      detail(result.error, result.ms, error500));

    counts.delete(hang);
    result = await timedError(() => requestWithRetry(KEY, "GET", hang, undefined, 3, base, 500));
    assert("7. too little time sends nothing",
      isError(result.error, 504, "nothing was sent") && count(hang) === 0, detail(result.error, result.ms, hang));
    result = await timedError(() => requestWithRetry(KEY, "GET", hang, undefined, 3, base, NaN));
    assert("7. NaN deadline sends nothing",
      isError(result.error, 504, "nothing was sent") && count(hang) === 0, detail(result.error, result.ms, hang));

    const clockHang = "/v2/transcript/hang-id";
    result = await timedError(() => afterSignIn(57_000, () => getTranscript(KEY, "hang-id")));
    assert("8. sign-in with 3 s left sends nothing",
      isError(result.error, 504, "nothing was sent") && count(clockHang) === 0,
      detail(result.error, result.ms, clockHang));
    result = await timedError(() => afterSignIn(53_000, () => getTranscript(KEY, "hang-id")));
    assert(`8. sign-in with 7 s left allows a 2 s deadline (${result.ms.toFixed(0)} ms)`,
      isError(result.error, 504, "did not answer") && inRange(result.ms, 1500, 3000) && count(clockHang) === 1,
      detail(result.error, result.ms, clockHang));

    const summary = await afterSignIn(57_000, () =>
      summarizeViaLlmGateway(KEY, { transcript_id: "t", prompt: "p" }));
    assert("9. Gateway summary works after sign-in with 3 s left",
      summary === "ok" && count("/v1/chat/completions") === 1 && LLM_GATEWAY_TIMEOUT_MS > 60_000,
      `${summary} | ${count("/v1/chat/completions")} requests | timeout ${LLM_GATEWAY_TIMEOUT_MS}`);
    const understanding = await afterSignIn(57_000, () =>
      understandTranscript(KEY, { transcript_id: "t", speech_understanding: { request: {} } }));
    assert("9. Gateway understanding also uses its own deadline",
      understanding.request_id === "ok" && count("/v1/understanding") === 1);

    const parsed = await requestWithRetry<{ id: string; status: string }>(KEY, "GET", "/v2/transcript/ok");
    assert("10. successful JSON is parsed", parsed.id === "x" && parsed.status === "completed", JSON.stringify(parsed));
    const missing = "/v2/transcript/missing";
    result = await timedError(() => requestWithRetry(KEY, "GET", missing));
    assert("10. 404 is thrown without retry",
      isError(result.error, 404) && count(missing) === 1, detail(result.error, result.ms, missing));
    const invalid = "/v2/transcript/invalid-json";
    result = await timedError(() => requestWithRetry(KEY, "GET", invalid));
    assert("10. invalid successful JSON propagates SyntaxError",
      result.error instanceof SyntaxError && !(result.error instanceof AssemblyAIError) && count(invalid) === 1,
      detail(result.error, result.ms, invalid));
    const broken = "/v2/transcript/broken-body";
    result = await timedError(() => requestWithRetry(KEY, "GET", broken));
    assert("10. an interrupted GET body is retried, then fails as a 502 (#80)",
      isError(result.error, 502, "failed after 3 attempts") && count(broken) === 3,
      detail(result.error, result.ms, broken));
    const closed = createServer();
    await new Promise<void>((resolve, reject) => {
      closed.once("error", reject);
      closed.listen(0, "127.0.0.1", resolve);
    });
    const closedAddress = closed.address();
    if (!closedAddress || typeof closedAddress === "string") throw new Error("No closed server address");
    await new Promise<void>((resolve, reject) => closed.close((err) => err ? reject(err) : resolve()));
    result = await timedError(() =>
      requestWithRetry(KEY, "GET", "/closed", undefined, 3, `http://127.0.0.1:${closedAddress.port}`));
    assert(`10. network errors retry three times then return 502 (${result.ms.toFixed(0)} ms)`,
      isError(result.error, 502, "after 3 attempts"), String(result.error));

    async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
      const mcp = new McpServer({ name: "request-timeout-test", version: "0.0.0" });
      const originalRegister = mcp.registerTool.bind(mcp);
      mcp.registerTool = ((name: string, config: unknown, cb: unknown) => {
        const wrapped = async (args: unknown, extra: { _meta?: { bearer?: string }; authInfo?: { token: string } }) => {
          if (extra._meta?.bearer) extra.authInfo = { token: extra._meta.bearer };
          return (cb as (a: unknown, e: unknown) => Promise<unknown>)(args, extra);
        };
        return originalRegister(name, config as never, wrapped as never);
      }) as typeof mcp.registerTool;
      registerTools(mcp);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await mcp.connect(serverTransport);
      const client = new Client({ name: "request-timeout-test", version: "0.0.0" });
      await client.connect(clientTransport);
      try {
        return await fn(client);
      } finally {
        await client.close();
        await mcp.close();
      }
    }
    await withClient(async (client) => {
      const start = performance.now();
      const response = await afterSignIn(53_000, () => client.callTool({
        name: "get_transcript",
        arguments: { transcript_id: TOOL_ID },
        _meta: { bearer: KEY },
      })) as ToolResult;
      const ms = performance.now() - start;
      const text = response.content?.find((item) => item.type === "text")?.text ?? "";
      assert(`11. MCP get_transcript returns the timeout (${ms.toFixed(0)} ms)`,
        response.isError === true && text.includes("did not answer") && ms < 3000 &&
          count(`/v2/transcript/${TOOL_ID}`) === 1, `${text} | ${ms.toFixed(0)} ms`);

      const redactedPath = `/v2/transcript/${REDACTED_ID}`;
      const redactedStart = performance.now();
      const redacted = await afterSignIn(53_000, () => client.callTool({
        name: "get_transcript",
        arguments: { transcript_id: REDACTED_ID },
        _meta: { bearer: KEY },
      })) as ToolResult;
      const redactedMs = performance.now() - redactedStart;
      const redactedText = redacted.content?.find((item) => item.type === "text")?.text ?? "";
      assert(`12. redacted-audio timeout is pending, not expired (${redactedMs.toFixed(0)} ms)`,
        redacted.isError !== true && redacted.structuredContent?.redacted_audio_pending === true &&
          redacted.structuredContent?.redacted_audio_error === undefined &&
          redactedText.includes("redacted audio not ready yet") && !redactedText.includes("may have expired") &&
          count(redactedPath) === 1 && count(`${redactedPath}/redacted-audio`) === 1 && redactedMs < 3000,
        `${JSON.stringify(redacted)} | ${redactedMs.toFixed(0)} ms | ` +
          `${count(redactedPath)} transcript, ${count(`${redactedPath}/redacted-audio`)} audio requests`);
    });
  } finally {
    clearInterval(keepAlive);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
