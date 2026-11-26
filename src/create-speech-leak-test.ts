import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { registerTools } from "./server";
import { SPEECH_TOKEN_TTL_SECONDS } from "./tts";

process.env.TTS_ENABLED = "1";

const TOKEN = "TMP-LEAK-PROBE-xyz-123";

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url.includes("/v1/token")) {
    return new Response(JSON.stringify({ token: TOKEN, expires_in_seconds: SPEECH_TOKEN_TTL_SECONDS }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  throw new Error(`Unexpected fetch to ${url} ${init?.method}`);
}) as typeof fetch;

interface ToolResult {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
}

let failed = 0;
function assert(name: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

let finished = false;
process.on("exit", (code) => {
  if (!finished && code === 0) {
    console.error("\nThe test run stopped before its summary (a hung promise?).");
    process.exitCode = 1;
  }
});

async function run() {
  console.log("Running create_speech bearer-leak test…\n");
  const server = new McpServer({ name: "leak-test", version: "0.0.0" });
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
  const client = new Client({ name: "leak-test", version: "0.0.0" });
  await client.connect(clientTransport);
  try {
    const res = (await client.callTool({
      name: "create_speech",
      arguments: { text: "Hello there." },
      _meta: { bearer: "sk-test-key" },
    })) as ToolResult;
    const text = res.content?.find((c) => c.type === "text")?.text ?? "";
    const command = String(res.structuredContent?.command ?? "");
    const commandPowershell = String(res.structuredContent?.command_powershell ?? "");
    const authToken = String(res.structuredContent?.authorization_token ?? "");

    assert("file delivery succeeds", res.isError !== true, JSON.stringify(res).slice(0, 300));
    assert("text does not leak the bearer verbatim", !text.includes(TOKEN), text.slice(0, 300));
    assert("text redacts the token placeholder", text.includes("<redacted>"), text.slice(0, 300));
    assert("text uses the $TTS_TOKEN env placeholder", text.includes("$TTS_TOKEN"), text.slice(0, 500));
    assert("structured command still carries the working token", command.includes(`Authorization: ${TOKEN}`), command.slice(0, 200));
    assert(
      "structured powershell command still carries the working token",
      commandPowershell.includes(`Authorization: ${TOKEN}`),
      commandPowershell.slice(0, 200)
    );
    assert("structured authorization_token equals the minted token", authToken === TOKEN, authToken);
  } finally {
    await client.close();
    await server.close();
  }

  console.log(failed === 0 ? "\n1 passed, 0 failed" : `\n0 passed, ${failed} failed`);
  finished = true;
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error(err);
  finished = true;
  process.exit(1);
});
