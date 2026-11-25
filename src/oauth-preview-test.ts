import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const MCP_URL = process.env.MCP_URL;
const BYPASS = process.env.VERCEL_PROTECTION_BYPASS;
const PORT = Number(process.env.PORT ?? 8977);
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;

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

function deploymentHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return BYPASS ? { "x-vercel-protection-bypass": BYPASS, ...extra } : extra;
}

function b64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

function openBrowser(url: string) {
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  spawn(command, [url], { stdio: "ignore", detached: true }).unref();
}

function catchRedirect(state: string): Promise<{ code: string; iss: string | null }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", REDIRECT_URI);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/plain" }).end("Signed in. You can close this tab.");
      server.close();
      if (url.searchParams.get("state") !== state) return reject(new Error("state mismatch"));
      const code = url.searchParams.get("code");
      if (!code) return reject(new Error(`no code: ${url.searchParams.get("error") ?? "unknown error"}`));
      resolve({ code, iss: url.searchParams.get("iss") });
    });
    server.listen(PORT, "127.0.0.1");
    setTimeout(() => {
      server.close();
      reject(new Error("no redirect within 5 minutes"));
    }, 5 * 60 * 1000).unref();
  });
}

async function run() {
  if (!MCP_URL) throw new Error("Set MCP_URL to the deployment's /mcp endpoint");
  console.log(`oauth preview test against ${MCP_URL}`);

  const unauthenticated = await fetch(MCP_URL, {
    method: "POST",
    headers: deploymentHeaders({ "Content-Type": "application/json", Accept: "application/json, text/event-stream" }),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const challenge = unauthenticated.headers.get("WWW-Authenticate") ?? "";
  const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
  assert("1. no token is a 401 naming the resource metadata", unauthenticated.status === 401 && !!metadataUrl, `${unauthenticated.status} ${challenge}`);
  if (!metadataUrl) throw new Error("no resource_metadata in the challenge (protection bypass missing?)");

  const resourceMetadata = await json(await fetch(metadataUrl, { headers: deploymentHeaders() }));
  const issuer = (resourceMetadata.authorization_servers as string[] | undefined)?.[0];
  const resource = resourceMetadata.resource as string | undefined;
  const scopes = ((resourceMetadata.scopes_supported as string[] | undefined) ?? []).join(" ");
  assert("2. the metadata names an authorization server and scopes", !!issuer && scopes.includes("aai:api"), JSON.stringify(resourceMetadata));
  if (!issuer || !resource) throw new Error("no authorization server advertised");
  console.log(`    authorization server: ${issuer}`);

  const asMetadata = await json(await fetch(`${issuer}/.well-known/oauth-authorization-server`));
  const registrationEndpoint = asMetadata.registration_endpoint as string | undefined;
  const authorizationEndpoint = asMetadata.authorization_endpoint as string | undefined;
  const tokenEndpoint = asMetadata.token_endpoint as string | undefined;
  assert("3. the authorization server supports registration", !!registrationEndpoint && !!authorizationEndpoint && !!tokenEndpoint);
  if (!registrationEndpoint || !authorizationEndpoint || !tokenEndpoint) throw new Error("incomplete authorization server metadata");

  const registration = await fetch(registrationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "assemblyai-mcp oauth preview test",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const clientId = (await json(registration)).client_id as string | undefined;
  assert("4. the client registers", registration.ok && !!clientId, String(registration.status));
  if (!clientId) throw new Error("registration failed");

  const verifier = b64url(randomBytes(32));
  const state = b64url(randomBytes(16));
  const authorize = new URL(authorizationEndpoint);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: scopes,
    state,
    code_challenge: b64url(createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
    resource,
  }).toString();
  const redirect = catchRedirect(state);
  console.log("    opening the consent page; click Allow");
  openBrowser(authorize.toString());
  const { code, iss } = await redirect;
  // RFC 9207: clients that check `iss` refuse a code from any other issuer.
  assert("5. the redirect names the advertised issuer", iss === issuer, `iss=${iss}`);

  const tokenResponse = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
      resource,
    }),
  });
  const tokens = await json(tokenResponse);
  const accessToken = tokens.access_token as string | undefined;
  assert(
    "5. sign-in returns an access token and a refresh token",
    tokenResponse.ok && !!accessToken && typeof tokens.refresh_token === "string",
    `${tokenResponse.status} ${tokens.error ?? ""}`
  );
  if (!accessToken) throw new Error("no access token");

  // AssemblyAI answers a made-up transcript id with 400 "transcript id not found" only for a key it accepted.
  const client = new Client({ name: "oauth-preview-test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: deploymentHeaders({ Authorization: `Bearer ${accessToken}` }) },
  });
  await client.connect(transport);
  const tools = await client.listTools();
  assert("6. tools/list works with the access token", tools.tools.length > 0, `${tools.tools.length} tools`);
  const probe = (await client.callTool({
    name: "get_transcript",
    arguments: { transcript_id: "00000000-0000-0000-0000-000000000000" },
  })) as { isError?: boolean; content?: Array<{ text?: string }> };
  const probeText = probe.content?.map((c) => c.text ?? "").join(" ") ?? "";
  assert(
    "6. the exchanged key is accepted by the AssemblyAI API",
    probe.isError === true && /transcript id not found/i.test(probeText),
    probeText.slice(0, 200)
  );
  await client.close();

  const tampered = `${accessToken.slice(0, -4)}AAAA`;
  const refused = await fetch(MCP_URL, {
    method: "POST",
    headers: deploymentHeaders({
      Authorization: `Bearer ${tampered}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    }),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert(
    "7. a tampered token is a 401 with a challenge",
    refused.status === 401 && (refused.headers.get("WWW-Authenticate") ?? "").includes("invalid_token"),
    String(refused.status)
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
