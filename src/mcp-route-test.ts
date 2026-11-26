/**
 * Offline route regression tests: keep the real mcp-handler and auth wrappers,
 * replacing only Redis's network client so any connection attempt is recorded.
 * The route serves streamable HTTP only; legacy SSE is off and must never reach
 * Redis, even when a Redis URL is present. Each environment gets a fresh process
 * because the route captures env at import.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { mock } from "node:test";

const cases = [
  { name: "no Redis", redis: undefined, kv: undefined },
  { name: "REDIS_URL set", redis: "redis://127.0.0.1:6379/1", kv: undefined },
  { name: "KV_URL set", redis: undefined, kv: "redis://127.0.0.1:6379/2" },
];

async function runCase() {
  const urls: string[] = [];
  const createClient = ({ url }: { url: string }) => {
    urls.push(url);
    return Object.assign(new EventEmitter(), {
      connect: async () => {},
      subscribe: async () => {},
      unsubscribe: async () => {},
      publish: async () => 0,
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

  const headers = { authorization: "Bearer route-test-api-key" };
  const unauthorized = await GET(new Request("http://localhost/mcp/sse"));
  assert.equal(unauthorized.status, 401, "auth still runs before routing");
  assert.match(unauthorized.headers.get("www-authenticate") ?? "", /oauth-protected-resource/);

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

  // Legacy SSE endpoints are gone: a clean 404, not a stream or a Redis error.
  const sse = await GET(new Request("http://localhost/mcp/sse", {
    headers: { ...headers, accept: "text/event-stream" },
  }));
  assert.equal(sse.status, 404, "GET /mcp/sse is not served");
  const message = await POST(new Request("http://localhost/mcp/message?sessionId=legacy", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  }));
  assert.equal(message.status, 404, "POST /mcp/message is not served");

  assert.deepEqual(urls, [], "no request path connects to Redis");
  redisMock.restore();
}

if (process.argv.includes("--case")) {
  await runCase();
  // mcp-handler 1.1.0 keeps a global cleanup interval with no disposal API.
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
    console.log(`  ✓ ${scenario.name}: real route auth, streamable HTTP, SSE 404, no Redis`);
  }
  console.log(`\n${cases.length} route environment cases passed`);
}
