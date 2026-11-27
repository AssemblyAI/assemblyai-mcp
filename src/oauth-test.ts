import { withMcpAuth } from "mcp-handler";

import * as pathAwareResourceRoute from "../app/.well-known/oauth-protected-resource/mcp/route";
import { GET as resourceMetadata, OPTIONS as resourceOptions } from "../app/.well-known/oauth-protected-resource/route";
import { OPTIONS as mcpOptions, POST as mcpPost } from "../app/mcp/[[...path]]/route";
import {
  clearExchangeCache,
  type ExchangeDeps,
  looksLikeAccessToken,
  MAX_CONCURRENT_EXCHANGES,
  MAX_EXCHANGES_PER_IP_PER_MINUTE,
  OAUTH_ISSUER,
  withMissingCredentialsChallenge,
  withOAuthExchange,
} from "./oauth";

const { GET: pathAwareResourceMetadata } = pathAwareResourceRoute;

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
    // On Vercel the request is Next's Request subclass, and `new Request(req, init)` throws on it.
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
    const scopeDetail = "missing_required_aai_api_scope";
    const urlDetail = "Re-authorize at https://www.assemblyai.com/app/connections";
    const { deps } = stub([
      Response.json({ detail: scopeDetail }, { status: 403 }),
      Response.json({ detail: urlDetail }, { status: 401 }),
    ]);
    const { handler } = recorder();
    const wrapped = withOAuthExchange(handler, deps);
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (line: string) => lines.push(line);
    let scopeRes: Response;
    let urlRes: Response;
    try {
      scopeRes = await wrapped(mcpRequest(accessToken(undefined, "scope24")));
      urlRes = await wrapped(mcpRequest(accessToken(undefined, "url401")));
    } finally {
      console.log = originalLog;
    }
    const scopeBody = (await scopeRes.json()) as { error_description?: string };
    const urlBody = (await urlRes.json()) as { error_description?: string };
    const joinedLogs = lines.join("\n");
    assert(
      "7b. a 24+ char scope refusal stays 403 insufficient_scope with unscrubbed error_description",
      scopeRes.status === 403 &&
        scopeBody.error_description === scopeDetail &&
        (scopeRes.headers.get("WWW-Authenticate") ?? "").includes(`error_description="${scopeDetail}"`),
      `status=${scopeRes.status} body=${JSON.stringify(scopeBody)}`
    );
    assert(
      "7b. a 401 detail preserves URLs for the client while logs remain scrubbed",
      urlRes.status === 401 &&
        urlBody.error_description === urlDetail &&
        !joinedLogs.includes(scopeDetail) &&
        !joinedLogs.includes("https://www.assemblyai.com/app/connections"),
      `body=${JSON.stringify(urlBody)} logs=${joinedLogs}`
    );
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
    // AbortSignal.timeout's timer doesn't keep Node alive.
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
    assert(
      "10. metadata response carries CORS headers",
      res.headers.get("access-control-allow-origin") === "*",
      res.headers.get("access-control-allow-origin") ?? undefined
    );
    const optRes = resourceOptions();
    assert(
      "10. metadata OPTIONS preflight answers 204 with CORS headers",
      optRes.status === 204 && optRes.headers.get("access-control-allow-origin") === "*",
      String(optRes.status)
    );
    const pathAwareOptions = pathAwareResourceRoute.OPTIONS;
    const pathAwarePreflight = typeof pathAwareOptions === "function" ? pathAwareOptions() : undefined;
    assert(
      "10. path-aware metadata OPTIONS answers 204 with CORS headers",
      pathAwarePreflight?.status === 204 &&
        pathAwarePreflight.headers.get("access-control-allow-origin") === "*" &&
        pathAwarePreflight.headers.get("access-control-allow-methods") === "GET, OPTIONS" &&
        pathAwarePreflight.headers.get("access-control-allow-headers") === "Authorization, Content-Type" &&
        (await pathAwarePreflight.text()) === "",
      pathAwarePreflight ? String(pathAwarePreflight.status) : "OPTIONS export missing"
    );
    const mcpOpt = mcpOptions();
    const allowHeaders = mcpOpt.headers.get("access-control-allow-headers") ?? "";
    assert(
      "10. /mcp OPTIONS preflight answers 204 with protocol and event headers",
      mcpOpt.status === 204 &&
        mcpOpt.headers.get("access-control-allow-origin") === "*" &&
        allowHeaders.includes("mcp-protocol-version") &&
        allowHeaders.includes("last-event-id"),
      allowHeaders
    );
    // A real /mcp response, not only the preflight, must carry CORS headers, or a
    // browser client can't read the 401 and its WWW-Authenticate to start OAuth.
    const mcpUnauthed = await mcpPost(
      new Request("https://mcp.example.com/mcp", {
        method: "POST",
        headers: {
          Origin: "https://browser-client.example",
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      })
    );
    const exposed = mcpUnauthed.headers.get("access-control-expose-headers") ?? "";
    assert(
      "10. /mcp 401 carries CORS headers and exposes WWW-Authenticate",
      mcpUnauthed.status === 401 &&
        mcpUnauthed.headers.get("access-control-allow-origin") === "*" &&
        exposed.toLowerCase().includes("www-authenticate") &&
        Boolean(mcpUnauthed.headers.get("www-authenticate")),
      `${mcpUnauthed.status} ${JSON.stringify(Object.fromEntries(mcpUnauthed.headers))}`
    );
  }


  {
    const originalFetch = globalThis.fetch;
    const originalOidcToken = process.env.VERCEL_OIDC_TOKEN;
    process.env.VERCEL_OIDC_TOKEN = "test-oidc-token";
    globalThis.fetch = async () => Response.json({ detail: "unavailable" }, { status: 503 });
    try {
      for (const status of [429, 503]) {
        clearExchangeCache();
        const now = Date.now();
        const ip = "203.0.113.61";
        if (status === 429) {
          const deps: ExchangeDeps = {
            fetch: async () => Response.json({ detail: "invalid token" }, { status: 401 }),
            serviceToken: async () => "test-oidc-token",
            now: () => now,
            timeoutMs: 1000,
          };
          const primeRateLimit = withOAuthExchange(async () => new Response("unexpected"), deps);
          for (let i = 0; i < MAX_EXCHANGES_PER_IP_PER_MINUTE; i++) {
            const req = mcpRequest(accessToken(now + 3600_000, `cors-prime-${i}`));
            req.headers.set("x-forwarded-for", ip);
            await primeRateLimit(req);
          }
        }
        const req = mcpRequest(accessToken(now + 3600_000, `cors-${status}`));
        req.headers.set("Origin", "https://browser-client.example");
        req.headers.set("x-forwarded-for", ip);
        const res = await mcpPost(req);
        const exposed = (res.headers.get("access-control-expose-headers") ?? "")
          .toLowerCase().split(",").map((header) => header.trim());
        assert(
          `10. /mcp ${status} exposes its Retry-After to browser clients`,
          res.status === status &&
            res.headers.get("access-control-allow-origin") === "*" &&
            exposed.includes("retry-after") &&
            Number(res.headers.get("retry-after")) > 0,
          `${res.status} exposed=${exposed.join(",")} retry-after=${res.headers.get("retry-after")}`
        );
      }
    } finally {
      globalThis.fetch = originalFetch;
      if (originalOidcToken === undefined) delete process.env.VERCEL_OIDC_TOKEN;
      else process.env.VERCEL_OIDC_TOKEN = originalOidcToken;
      clearExchangeCache();
    }
  }


  const fromIp = (bearer: string, ip: string) => {
    const req = mcpRequest(bearer);
    const headers = new Headers(req.headers);
    headers.set("x-forwarded-for", `${ip}, 10.0.0.1`);
    return new Request(req.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  };
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

  {
    clearExchangeCache();
    const { deps, exchanges } = stub([]);
    const { handler, seen } = recorder();
    const wrapped = withOAuthExchange(handler, deps);
    const fakes: Record<string, string> = {
      "aaa.bbb.ccc (not JSON)": "aaa.bbb.ccc",
      "alg none": `${b64({ alg: "none" })}.${b64({ exp: NOW / 1000 + 3600 })}.c2ln`,
      "no alg": `${b64({})}.${b64({ exp: NOW / 1000 + 3600 })}.c2ln`,
      "no exp": `${b64({ alg: "RS256" })}.${b64({ sub: "x" })}.c2ln`,
      "string exp": `${b64({ alg: "RS256" })}.${b64({ exp: "9999999999" })}.c2ln`,
      "claims are null": `${b64({ alg: "RS256" })}.${b64(null)}.c2ln`,
      expired: accessToken(NOW - 10 * 60 * 1000, "old"),
    };
    for (const [name, token] of Object.entries(fakes)) {
      const res = await wrapped(fromIp(token, "203.0.113.9"));
      assert(
        `11. ${name} → 401 challenge, no upstream call`,
        res.status === 401 && (res.headers.get("WWW-Authenticate") ?? "").includes('error="invalid_token"'),
        String(res.status)
      );
    }
    assert("11. none of them reached AssemblyAI or the handler", exchanges.length === 0 && seen.length === 0, String(exchanges.length));
  }

  {
    clearExchangeCache();
    const { deps, exchanges, advance } = stub([
      Response.json({ detail: "Invalid access token" }, { status: 401 }),
      Response.json({ detail: "Invalid access token" }, { status: 401 }),
    ]);
    const { handler } = recorder();
    const wrapped = withOAuthExchange(handler, deps);
    const token = accessToken(undefined, "revoked");
    const first = await wrapped(mcpRequest(token));
    const second = await wrapped(mcpRequest(token));
    assert("12. a refused token, sent twice, is exchanged once", first.status === 401 && second.status === 401 && exchanges.length === 1);
    advance(61 * 1000);
    await wrapped(mcpRequest(token));
    assert("12. after a minute it is exchanged again", exchanges.length === 2);
  }

  {
    clearExchangeCache();
    const n = MAX_EXCHANGES_PER_IP_PER_MINUTE;
    const refusal = () => Response.json({ detail: "Invalid access token" }, { status: 401 });
    const responses = [...Array.from({ length: n + 2 }, refusal), keyResponse("key-after-window"), ...Array.from({ length: n }, refusal)];
    const { deps, exchanges, advance } = stub(responses);
    const { handler } = recorder();
    const wrapped = withOAuthExchange(handler, deps);
    const statuses: number[] = [];
    for (let i = 0; i < n + 5; i++) statuses.push((await wrapped(fromIp(accessToken(undefined, `flood${i}`), "198.51.100.7"))).status);
    const limited = statuses.slice(n);
    assert(
      `13. ${n} unique tokens from one IP reach AssemblyAI; the rest get 429 with no call`,
      exchanges.length === n && statuses.slice(0, n).every((s) => s === 401) && limited.every((s) => s === 429),
      `exchanges=${exchanges.length} statuses=${statuses.join(",")}`
    );
    const blocked = await wrapped(fromIp(accessToken(undefined, "more"), "198.51.100.7"));
    const retryAfter = Number(blocked.headers.get("Retry-After"));
    assert("13. the 429 has a Retry-After within the minute and no sign-in challenge",
      blocked.status === 429 && retryAfter >= 1 && retryAfter <= 60 && !blocked.headers.get("WWW-Authenticate"), String(retryAfter));
    const other = await wrapped(fromIp(accessToken(undefined, "other-ip"), "192.0.2.1"));
    assert("13. another IP is not limited", other.status === 401 && exchanges.length === n + 1);
    advance(61 * 1000);
    const later = await wrapped(fromIp(accessToken(undefined, "later"), "198.51.100.7"));
    assert("13. the window resets after a minute", later.status === 401 && exchanges.length === n + 2);
    const good = accessToken(undefined, "good");
    const ok1 = await wrapped(fromIp(good, "198.51.100.8"));
    for (let i = 0; i < n; i++) await wrapped(fromIp(accessToken(undefined, `fill${i}`), "198.51.100.8")).catch(() => undefined);
    const ok2 = await wrapped(fromIp(good, "198.51.100.8"));
    assert("13. a cached key still works while its IP is limited", ok1.status === 200 && ok2.status === 200, `${ok1.status} ${ok2.status}`);
  }

  {
    clearExchangeCache();
    const n = MAX_EXCHANGES_PER_IP_PER_MINUTE;
    const members = 2 * n;
    const refusal = () => Response.json({ detail: "Invalid access token" }, { status: 401 });
    const responses = [
      ...Array.from({ length: members }, (_, i) => keyResponse(`member-key-${i}`)),
      ...Array.from({ length: n }, refusal),
    ];
    const { deps, exchanges } = stub(responses);
    const { handler } = recorder();
    const wrapped = withOAuthExchange(handler, deps);
    const ip = "198.51.100.20";
    const signIns: number[] = [];
    for (let i = 0; i < members; i++) signIns.push((await wrapped(fromIp(accessToken(undefined, `member${i}`), ip))).status);
    assert(
      `13b. ${members} members behind one IP all sign in within a minute`,
      signIns.every((s) => s === 200) && exchanges.length === members,
      signIns.join(",")
    );
    const flood: number[] = [];
    for (let i = 0; i < n + 1; i++) flood.push((await wrapped(fromIp(accessToken(undefined, `fake${i}`), ip))).status);
    assert(
      `13b. failed exchanges from that IP are still capped at ${n}`,
      flood.slice(0, n).every((s) => s === 401) && flood[n] === 429 && exchanges.length === members + n,
      `exchanges=${exchanges.length} statuses=${flood.join(",")}`
    );
  }

  {
    clearExchangeCache();
    const c = MAX_CONCURRENT_EXCHANGES;
    const stalls: Array<"stall"> = Array.from({ length: c }, () => "stall" as const);
    const { deps, exchanges } = stub(stalls, { timeoutMs: 200 });
    const { handler } = recorder();
    const wrapped = withOAuthExchange(handler, deps);
    const pending = Array.from({ length: c }, (_, i) => wrapped(fromIp(accessToken(undefined, `slow${i}`), `10.1.0.${i}`)));
    await new Promise((r) => setTimeout(r, 20));
    const extra = await wrapped(fromIp(accessToken(undefined, "one-more"), "10.2.0.1"));
    assert(`14. with ${c} exchanges in flight, one more gets 429 with no call`, extra.status === 429 && exchanges.length === c, `${extra.status} ${exchanges.length}`);
    // AbortSignal.timeout's timer doesn't keep Node alive: hold it open meanwhile.
    const keepAlive = setTimeout(() => undefined, 5_000);
    const done = await Promise.all(pending);
    clearTimeout(keepAlive);
    assert("14. the stalled exchanges end as 503", done.every((r) => r.status === 503));
  }

  {
    clearExchangeCache();
    const c = MAX_CONCURRENT_EXCHANGES;
    const responses: Array<Response | "stall"> = [...Array.from({ length: c }, () => "stall" as const), keyResponse("key-after-stall")];
    const { deps, exchanges } = stub(responses, { timeoutMs: 200 });
    const { handler } = recorder();
    const wrapped = withOAuthExchange(handler, deps);
    const keepAlive = setTimeout(() => undefined, 5_000);
    await Promise.all(Array.from({ length: c }, (_, i) => wrapped(fromIp(accessToken(undefined, `slot${i}`), `10.3.0.${i}`))));
    clearTimeout(keepAlive);
    const next = await wrapped(fromIp(accessToken(undefined, "after-stall"), "10.4.0.1"));
    assert("14b. after stalled exchanges time out, a new exchange reaches AssemblyAI", next.status === 200 && exchanges.length === c + 1, `${next.status} ${exchanges.length}`);
  }

  {
    clearExchangeCache();
    const c = MAX_CONCURRENT_EXCHANGES;
    let stall = true;
    const { deps, exchanges } = stub([keyResponse("key-after-oidc")], {
      timeoutMs: 200,
      serviceToken: () => (stall ? new Promise<string>(() => undefined) : Promise.resolve("vercel-oidc-token")),
    });
    const { handler } = recorder();
    const wrapped = withOAuthExchange(handler, deps);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hung = new Promise<"hung">((resolve) => (timer = setTimeout(() => resolve("hung"), 2_000)));
    const stalled = await Promise.race([
      Promise.all(Array.from({ length: c }, (_, i) => wrapped(fromIp(accessToken(undefined, `oidc${i}`), `10.5.0.${i}`)))),
      hung,
    ]);
    clearTimeout(timer);
    assert(
      "14c. a stalled service-token lookup ends as 503 at the deadline",
      stalled !== "hung" && stalled.every((r) => r.status === 503) && exchanges.length === 0,
      stalled === "hung" ? "still pending after 2 s" : undefined
    );
    stall = false;
    const next = await wrapped(fromIp(accessToken(undefined, "oidc-ok"), "10.6.0.1"));
    assert("14c. and frees its slot: the next exchange reaches AssemblyAI", next.status === 200 && exchanges.length === 1, `${next.status} ${exchanges.length}`);
  }

  // #117. Discovery follows RFC 9728 / RFC 6750.
  {
    const root = await resourceMetadata(new Request("https://mcp.example.com/.well-known/oauth-protected-resource")).text();
    const pathAware = pathAwareResourceMetadata(new Request("https://mcp.example.com/.well-known/oauth-protected-resource/mcp"));
    const pathAwareBody = await pathAware.text();
    assert(
      "15. the path-aware metadata URL serves the same document as the root URL",
      pathAware.status === 200 && pathAwareBody === root && JSON.parse(pathAwareBody).resource === "https://mcp.example.com/mcp",
      pathAwareBody
    );
  }

  {
    // Through the real withMcpAuth, as app/mcp/[[...path]]/route.ts wires it.
    const verifyToken = async (_req: Request, bearer?: string) =>
      bearer && bearer.trim() ? { token: bearer.trim(), scopes: [], clientId: "test" } : undefined;
    const { handler } = recorder();
    const authed = withMissingCredentialsChallenge(
      withMcpAuth(handler, verifyToken, { required: true, resourceMetadataPath: "/.well-known/oauth-protected-resource" })
    );
    const expected = 'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"';

    const noAuth = await authed(mcpRequest());
    assert(
      "15. no Authorization header → 401 with only resource_metadata, no error code",
      noAuth.status === 401 && noAuth.headers.get("WWW-Authenticate") === expected,
      String(noAuth.headers.get("WWW-Authenticate"))
    );
    assert(
      "15. the 401 keeps its JSON body and content type",
      noAuth.headers.get("Content-Type") === "application/json" && ((await noAuth.json()) as { error?: string }).error === "invalid_token"
    );
    for (const header of ["Bearer", "Bearer ", "Basic dXNlcjpwYXNz"]) {
      const res = await authed(new Request("https://mcp.example.com/mcp", { method: "POST", headers: { Authorization: header }, body: "{}" }));
      assert(
        `15. "${header}" (no Bearer token) is answered without an error code`,
        res.status === 401 && res.headers.get("WWW-Authenticate") === expected,
        String(res.headers.get("WWW-Authenticate"))
      );
    }

    const sent = await authed(mcpRequest("an-api-key"));
    assert("15. a Bearer that was sent still reaches the handler", sent.status === 200 && (await sent.text()) === "ok");

    const refused = withMissingCredentialsChallenge(
      withMcpAuth(
        handler,
        async () => {
          throw new Error("boom");
        },
        { required: true }
      )
    );
    const refusedRes = await refused(mcpRequest("bad-token"));
    assert(
      "15. a Bearer that was sent and refused keeps error=invalid_token",
      refusedRes.status === 401 && (refusedRes.headers.get("WWW-Authenticate") ?? "").includes('error="invalid_token"'),
      String(refusedRes.headers.get("WWW-Authenticate"))
    );

    const forbidden = await withMissingCredentialsChallenge(
      async () => new Response("no", { status: 403, headers: { "WWW-Authenticate": 'Bearer error="insufficient_scope"' } })
    )(mcpRequest());
    const bare = await withMissingCredentialsChallenge(
      async () => new Response("no", { status: 401, headers: { "WWW-Authenticate": "Bearer" } })
    )(mcpRequest());
    assert(
      "15. other statuses, and a 401 with no resource_metadata, are left alone",
      forbidden.status === 403 &&
        forbidden.headers.get("WWW-Authenticate") === 'Bearer error="insufficient_scope"' &&
        bare.headers.get("WWW-Authenticate") === "Bearer"
    );
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
