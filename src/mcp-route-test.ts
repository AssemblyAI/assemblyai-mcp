/**
 * Offline route regression tests: keep the real mcp-handler and auth wrappers,
 * replacing only Redis's network client. Each environment gets a fresh process
 * because the route captures env at import and mcp-handler caches Redis clients.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { mock } from "node:test";

const cases = [
  { name: "REDIS_URL", redis: "redis://127.0.0.1:6379/1", kv: undefined },
  { name: "KV_URL fallback", redis: undefined, kv: "redis://127.0.0.1:6379/2" },
  { name: "REDIS_URL precedence", redis: "redis://127.0.0.1:6379/3", kv: "redis://127.0.0.1:6379/4" },
  { name: "empty REDIS_URL falls back to KV_URL", redis: "", kv: "redis://127.0.0.1:6379/5" },
  { name: "no Redis (streamable HTTP)", redis: undefined, kv: undefined },
];

async function runCase() {
  const urls: string[] = [];
  const subscriptions: string[] = [];
  // No socket is opened. The real handler must select the URL, connect its two
  // clients, subscribe to its session channel, and emit the real SSE endpoint.
  const createClient = ({ url }: { url: string }) => {
    urls.push(url);
    return Object.assign(new EventEmitter(), {
      connect: async () => {},
      subscribe: async (channel: string) => { subscriptions.push(channel); },
      unsubscribe: async () => {},
    });
  };
  const redisMock = mock.module("redis", {
    defaultExport: { createClient },
    namedExports: { createClient },
  });
  // Dynamic import is essential: Redis must be mocked and env set before the
  // exported route (and the dependency's singleton state) is initialized.
  const { GET, POST, DELETE } = await import("../app/mcp/[[...path]]/route");
  assert.equal(GET, POST);
  assert.equal(GET, DELETE);

  const headers = { authorization: "Bearer route-test-api-key", accept: "text/event-stream" };
  const unauthorized = await GET(new Request("http://localhost/mcp/sse"));
  assert.equal(unauthorized.status, 401);
  assert.match(unauthorized.headers.get("www-authenticate") ?? "", /oauth-protected-resource/);
  assert.equal(urls.length, 0, "auth rejects requests before Redis initialization");

  // Exercise the actual streamable HTTP POST endpoint, not a mocked handler.
  const response = await POST(new Request("http://localhost/mcp", {
    method: "POST",
    headers: { ...headers, accept: "application/json, text/event-stream", "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "route-test", version: "1" } },
    }),
  }));
  assert.equal(response.status, 200);
  const payload = await response.text();
  const data = payload.startsWith("event:") ? payload.split("\n").find((line) => line.startsWith("data:"))?.slice(5) : payload;
  assert.ok(data, payload);
  const initialized = JSON.parse(data);
  assert.equal(initialized.id, 1);
  assert.equal(initialized.result.protocolVersion, "2025-03-26");
  assert.ok(initialized.result.capabilities.tools);
  assert.equal(urls.length, 0, "streamable HTTP does not require Redis");

  const expectedUrl = process.env.REDIS_URL || process.env.KV_URL;
  if (expectedUrl !== undefined) {
    const abort = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const sse = await GET(new Request("http://localhost/mcp/sse", { headers, signal: abort.signal }));
      assert.equal(sse.status, 200);
      assert.match(sse.headers.get("content-type") ?? "", /text\/event-stream/);
      reader = sse.body!.getReader();
      const first = await reader.read();
      const event = new TextDecoder().decode(first.value);
      assert.match(event, /event: endpoint/);
      assert.match(event, /data: \/mcp\/message\?sessionId=/);
      assert.deepEqual(urls, [expectedUrl, expectedUrl]);
      assert.equal(subscriptions.length, 1);
      assert.match(subscriptions[0]!, /^requests:/);
    } finally {
      abort.abort();
      // Abort ends the dependency's SSE wait and cleans its timers/session.
      if (reader) {
        while (!(await reader.read()).done) { /* drain until cleanup closes */ }
        reader.releaseLock();
      }
    }
  }
  redisMock.restore();
}

if (process.argv.includes("--case")) {
  await runCase();
  // mcp-handler 1.1.0 keeps a global cleanup interval with no disposal API.
  // Exit only after every assertion and the SSE session cleanup has completed.
  process.exit(0);
} else {
  for (const scenario of cases) {
    const env = { ...process.env };
    delete env.REDIS_URL;
    delete env.KV_URL;
    if (scenario.redis !== undefined) env.REDIS_URL = scenario.redis;
    if (scenario.kv !== undefined) env.KV_URL = scenario.kv;
    const child = spawnSync(process.execPath, [
      "--import", "tsx", "--experimental-test-module-mocks", fileURLToPath(import.meta.url), "--case",
    ], { env, encoding: "utf8", timeout: 10_000 });
    assert.equal(child.status, 0, `${scenario.name}: ${child.error ?? ""}\n${child.stdout}\n${child.stderr}`);
    console.log(`  ✓ ${scenario.name}: real route auth, streamable HTTP${scenario.redis || scenario.kv ? ", and SSE" : ""}`);
  }
  console.log(`\n${cases.length} route environment cases passed`);
}
