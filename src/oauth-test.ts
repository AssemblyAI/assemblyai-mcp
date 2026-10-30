/**
 * Offline tests for the OAuth exchange (`src/oauth.ts`), with a stubbed
 * exchange endpoint and service token. Run with `npm test`.
 *
 * Coverage:
 *   1. looksLikeAccessToken tells a JWT from an API key
 *   2. an API key passes through untouched; no exchange
 *   3. an access token is exchanged (both credentials sent) and the handler sees the key
 *   3b. a request that isn't this runtime's own Request class (Next's, on Vercel) still works
 *   3c. the success log names the connection and hashes, never the token or key
 *   3d. extra whitespace after "Bearer" still exchanges the token
 *   4. the key is cached per token for at most 5 minutes, and never past its rotation
 *   5. the cache never outlives the access token
 *   6. AssemblyAI's 401 → 401 with a challenge pointing at the resource metadata
 *   7. a 403 for a missing scope → 403 insufficient_scope; other 403s → 401
 *   8. 5xx, network errors, a missing or refused service token → 503, never 401
 *   8b. a successful exchange with no usable key (no body, JSON null) → 503
 *   8c. a stalled exchange gives up after its deadline → 503
 *   8d. a 401 whose body can't be read is an outage (503), not a refused token
 *   6b. a refusal whose detail isn't printable ASCII still answers its challenge
 *   9. no Bearer at all reaches the handler (withMcpAuth answers it)
 *  10. the protected resource metadata names the authorization server and scopes
 */

import { GET as resourceMetadata } from "../app/.well-known/oauth-protected-resource/route";
import {
  clearExchangeCache,
  type ExchangeDeps,
  looksLikeAccessToken,
  OAUTH_ISSUER,
  withOAuthExchange,
} from "./oauth";

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

const NOW = Date.parse("2026-10-29T12:00:00Z");

/** An unsigned JWT-shaped token; only its shape and `exp` matter here. */
function accessToken(expMs = NOW + 8 * 60 * 60 * 1000, nonce = "a"): string {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "RS256" })}.${part({ exp: Math.floor(expMs / 1000), nonce })}.c2ln`;
}

interface Exchange {
  authorization: string | null;
  serviceToken: string | null;
}

function stub(
  responses: Array<Response | Error | "stall">,
  opts: { serviceToken?: () => Promise<string>; timeoutMs?: number } = {}
) {
  const exchanges: Exchange[] = [];
  let now = NOW;
  const deps: ExchangeDeps = {
    fetch: async (_url, init) => {
      const headers = new Headers(init?.headers);
      exchanges.push({
        authorization: headers.get("Authorization"),
        serviceToken: headers.get("X-AAI-Service-Token"),
      });
      const next = responses.shift();
      if (!next) throw new Error("unexpected exchange");
      if (next === "stall") {
        // Never answers; only the request's abort signal ends it.
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        });
      }
      if (next instanceof Error) throw next;
      return next;
    },
    serviceToken: opts.serviceToken ?? (async () => "vercel-oidc-token"),
    now: () => now,
    timeoutMs: opts.timeoutMs ?? 10_000,
  };
  return { deps, exchanges, advance: (ms: number) => (now += ms) };
}

function keyResponse(apiKey: string, rotatesAt: string | null = "2026-11-10T12:00:00Z") {
  return Response.json({
    api_key: apiKey,
    api_key_rotates_at: rotatesAt,
    connection_id: "8f14e45f-ceea-467f-a8f5-0e1a4b2c3d4e",
  });
}

/** A handler that records the Bearer and body it was given. */
function recorder() {
  const seen: Array<string | null> = [];
  const bodies: string[] = [];
  const handler = async (req: Request) => {
    seen.push(req.headers.get("Authorization"));
    bodies.push(await req.text());
    return new Response("ok");
  };
  return { handler, seen, bodies };
}

function mcpRequest(bearer?: string): Request {
  return new Request("https://mcp.example.com/mcp", {
    method: "POST",
    headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
}

async function run() {
  console.log("oauth exchange");

  {
    assert("1. a JWT looks like an access token", looksLikeAccessToken(accessToken()));
    assert("1. an API key doesn't", !looksLikeAccessToken("0123456789abcdef0123456789abcdef"));
  }

  {
    clearExchangeCache();
    const { deps, exchanges } = stub([]);
    const { handler, seen } = recorder();
    await withOAuthExchange(handler, deps)(mcpRequest("0123456789abcdef0123456789abcdef"));
    assert("2. an API key reaches the handler as sent", seen[0] === "Bearer 0123456789abcdef0123456789abcdef");
    assert("2. and is never exchanged", exchanges.length === 0);
  }

  {
    clearExchangeCache();
    const token = accessToken();
    const { deps, exchanges } = stub([keyResponse("connection-key")]);
    const { handler, seen, bodies } = recorder();
    const req = mcpRequest(token);
    const res = await withOAuthExchange(handler, deps)(req);
    assert("3. the handler sees the connection's key", seen[0] === "Bearer connection-key", String(seen[0]));
    assert("3. and the request body, intact", bodies[0]?.includes('"tools/list"') === true, bodies[0]);
    assert("3. the response is the handler's", res.status === 200);
    assert(
      "3. the exchange carries the access token and the service token",
      exchanges[0]?.authorization === `Bearer ${token}` && exchanges[0]?.serviceToken === "vercel-oidc-token"
    );
  }

  {
    // On Vercel the incoming request is Next's Request subclass from another
    // copy of undici; `new Request(req, init)` throws on it. Stand in with an
    // object that only has Request's public members.
    clearExchangeCache();
    const { deps } = stub([keyResponse("connection-key")]);
    const { handler, seen, bodies } = recorder();
    const real = mcpRequest(accessToken(undefined, "foreign"));
    const foreign = {
      url: real.url,
      method: real.method,
      headers: real.headers,
      body: real.body,
      signal: real.signal,
    } as unknown as Request;
    const res = await withOAuthExchange(handler, deps)(foreign);
    assert(
      "3b. a request of a foreign Request class is passed on with the key and its body",
      res.status === 200 && seen[0] === "Bearer connection-key" && bodies[0]?.includes('"tools/list"') === true,
      `${res.status} ${seen[0]} ${bodies[0]}`
    );
  }

  {
    clearExchangeCache();
    const token = accessToken(undefined, "log");
    const { deps } = stub([keyResponse("connection-key-for-log")]);
    const { handler } = recorder();
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      await withOAuthExchange(handler, deps)(mcpRequest(token));
    } finally {
      console.log = originalLog;
    }
    const ok = lines.map((l) => JSON.parse(l)).find((l) => l.event === "oauth_exchange_ok") ?? {};
    assert(
      "3c. the success log names the connection and hashes, never the token or key",
      ok.connectionId === "8f14e45f-ceea-467f-a8f5-0e1a4b2c3d4e" &&
        typeof ok.tokenHash === "string" &&
        typeof ok.keyHash === "string" &&
        !lines.join("\n").includes(token) &&
        !lines.join("\n").includes("connection-key-for-log"),
      JSON.stringify(ok)
    );
  }

  {
    clearExchangeCache();
    const token = accessToken(undefined, "spaces");
    const { deps, exchanges } = stub([keyResponse("connection-key")]);
    const { handler, seen } = recorder();
    const req = new Request("https://mcp.example.com/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer   ${token} ` },
      body: "{}",
    });
    await withOAuthExchange(handler, deps)(req);
    assert(
      "3d. extra whitespace after \"Bearer\" still exchanges the token",
      exchanges.length === 1 && exchanges[0]?.authorization === `Bearer ${token}` && seen[0] === "Bearer connection-key",
      `${exchanges.length} ${seen[0]}`
    );
  }

  {
    clearExchangeCache();
    const token = accessToken();
    const { deps, exchanges, advance } = stub([
      keyResponse("first-key", "2026-10-29T12:02:00Z"),
      keyResponse("next-key", "2026-11-12T12:00:00Z"),
      keyResponse("next-key", "2026-11-12T12:00:00Z"),
    ]);
    const { handler, seen } = recorder();
    const wrapped = withOAuthExchange(handler, deps);
    await wrapped(mcpRequest(token));
    await wrapped(mcpRequest(token));
    assert("4. a second request uses the cached key", exchanges.length === 1 && seen[1] === "Bearer first-key");
    advance(2 * 60 * 1000);
    await wrapped(mcpRequest(token));
    assert("4. at the rotation time the key is exchanged again", exchanges.length === 2 && seen[2] === "Bearer next-key");
    advance(4 * 60 * 1000);
    await wrapped(mcpRequest(token));
    assert("4. a far-off rotation is still re-checked within 5 minutes", exchanges.length === 2);
    advance(60 * 1000);
    await wrapped(mcpRequest(token));
    assert("4. after 5 minutes the key is exchanged again", exchanges.length === 3);
  }

  {
    clearExchangeCache();
    const token = accessToken(NOW + 2 * 60 * 1000);
    const { deps, exchanges, advance } = stub([keyResponse("k1"), keyResponse("k2")]);
    const { handler } = recorder();
    const wrapped = withOAuthExchange(handler, deps);
    await wrapped(mcpRequest(token));
    advance(2 * 60 * 1000);
    await wrapped(mcpRequest(token));
    assert("5. the cached key goes when the access token expires", exchanges.length === 2);
  }

  {
    clearExchangeCache();
    const { deps } = stub([Response.json({ detail: "Invalid access token" }, { status: 401 })]);
    const { handler, seen } = recorder();
    const res = await withOAuthExchange(handler, deps)(mcpRequest(accessToken()));
    const challenge = res.headers.get("WWW-Authenticate") ?? "";
    assert("6. a refused token is a 401", res.status === 401);
    assert(
      "6. whose challenge points at the resource metadata",
      challenge.includes('error="invalid_token"') &&
        challenge.includes('resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"'),
      challenge
    );
    assert("6. and never reaches the handler", seen.length === 0);
  }

  {
    clearExchangeCache();
    const { deps } = stub([
      Response.json({ detail: "Access token is missing the required scope: aai:api" }, { status: 403 }),
      Response.json({ detail: "This app's access was revoked; authorize the app again" }, { status: 403 }),
    ]);
    const { handler } = recorder();
    const wrapped = withOAuthExchange(handler, deps);
    const scope = await wrapped(mcpRequest(accessToken(undefined, "s")));
    assert(
      "7. a missing scope is a 403 insufficient_scope naming the scopes",
      scope.status === 403 && (scope.headers.get("WWW-Authenticate") ?? "").includes('scope="aai:api offline_access"')
    );
    const revoked = await wrapped(mcpRequest(accessToken(undefined, "r")));
    assert("7. revoked access is a 401, so the client signs in again", revoked.status === 401);
  }

  {
    clearExchangeCache();
    const detail = "This app\u2019s access was revoked;\nauthorize the app again";
    const { deps } = stub([Response.json({ detail }, { status: 401 })]);
    const { handler } = recorder();
    const res = await withOAuthExchange(handler, deps)(mcpRequest(accessToken(undefined, "ascii")));
    const challenge = res.headers.get("WWW-Authenticate") ?? "";
    const body = (await res.json()) as { error_description?: string };
    assert(
      "6b. a non-ASCII refusal detail still answers 401 with an ASCII challenge",
      res.status === 401 && /^[\x20-\x7E]+$/.test(challenge) && challenge.includes("authorize the app again"),
      challenge
    );
    assert("6b. and the JSON body keeps the original wording", body.error_description === detail);
  }

  {
    clearExchangeCache();
    const { deps } = stub([
      Response.json({ detail: "Could not revoke" }, { status: 503 }),
      new TypeError("fetch failed"),
      Response.json({ detail: "Unknown client" }, { status: 401 }),
    ]);
    const { handler, seen } = recorder();
    const wrapped = withOAuthExchange(handler, deps);
    const upstream = await wrapped(mcpRequest(accessToken(undefined, "u")));
    const network = await wrapped(mcpRequest(accessToken(undefined, "n")));
    const refusedServer = await wrapped(mcpRequest(accessToken(undefined, "c")));
    const noOidc = await withOAuthExchange(
      handler,
      stub([], {
        serviceToken: async () => {
          throw new Error("The 'x-vercel-oidc-token' header is missing");
        },
      }).deps
    )(mcpRequest(accessToken(undefined, "o")));
    assert(
      "8. an outage is a 503, never a 401",
      upstream.status === 503 && network.status === 503 && noOidc.status === 503,
      `${upstream.status} ${network.status} ${noOidc.status}`
    );
    assert("8. a refused service token is a 503, not a sign-in loop", refusedServer.status === 503, String(refusedServer.status));
    assert("8. and never reaches the handler", seen.length === 0);
  }

  {
    clearExchangeCache();
    const { deps } = stub([
      new Response("null", { status: 200, headers: { "Content-Type": "application/json" } }),
      new Response("", { status: 200 }),
      Response.json({ api_key: "" }),
    ]);
    const { handler, seen } = recorder();
    const wrapped = withOAuthExchange(handler, deps);
    const statuses = [];
    for (const nonce of ["null", "empty", "blank"]) {
      statuses.push((await wrapped(mcpRequest(accessToken(undefined, nonce)))).status);
    }
    assert("8b. an exchange that returns no usable key is a 503", statuses.every((s) => s === 503), statuses.join(" "));
    assert("8b. and never reaches the handler", seen.length === 0);
  }

  {
    clearExchangeCache();
    const { deps } = stub(["stall"], { timeoutMs: 50 });
    const { handler, seen } = recorder();
    const started = Date.now();
    // AbortSignal.timeout's timer doesn't keep Node alive (a server's open
    // socket does), so the race's timer also holds the process open.
    // The 2s race is the test's own limit: without a deadline it fails
    // rather than hanging.
    let keepAlive: NodeJS.Timeout | undefined;
    const res = await Promise.race([
      withOAuthExchange(handler, deps)(mcpRequest(accessToken(undefined, "stall"))),
      new Promise<null>((resolve) => {
        keepAlive = setTimeout(() => resolve(null), 2000);
      }),
    ]);
    clearTimeout(keepAlive);
    assert(
      "8c. a stalled exchange gives up at its deadline with a 503",
      res?.status === 503 && seen.length === 0,
      `${res?.status ?? "no answer"} after ${Date.now() - started}ms`
    );
  }

  {
    // The deadline firing mid-body, or the connection dropping, after a 401
    // status line: the detail ("Unknown client"?) never arrived.
    clearExchangeCache();
    const brokenBody = new ReadableStream({
      start(controller) {
        controller.error(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
      },
    });
    const { deps } = stub([new Response(brokenBody, { status: 401 })]);
    const { handler, seen } = recorder();
    const res = await withOAuthExchange(handler, deps)(mcpRequest(accessToken(undefined, "body")));
    assert(
      "8d. a 401 whose body can't be read is a 503, not a sign-in challenge",
      res.status === 503 && !res.headers.get("WWW-Authenticate") && seen.length === 0,
      String(res.status)
    );
  }

  {
    clearExchangeCache();
    const { deps, exchanges } = stub([]);
    const { handler, seen } = recorder();
    await withOAuthExchange(handler, deps)(mcpRequest());
    assert("9. no Bearer goes on to withMcpAuth", seen.length === 1 && seen[0] === null && exchanges.length === 0);
  }

  {
    const res = resourceMetadata(new Request("https://mcp.example.com/.well-known/oauth-protected-resource"));
    const body = (await res.json()) as Record<string, unknown>;
    assert(
      "10. the metadata names the authorization server and scopes",
      JSON.stringify(body.authorization_servers) === JSON.stringify([OAUTH_ISSUER]) &&
        JSON.stringify(body.scopes_supported) === JSON.stringify(["aai:api", "offline_access"]) &&
        body.resource === "https://mcp.example.com/mcp",
      JSON.stringify(body)
    );
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
