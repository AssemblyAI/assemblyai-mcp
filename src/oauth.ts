/** AssemblyAI's API takes API keys, not OAuth access tokens: exchange the token for its connection's key before withMcpAuth. */

import { createHash } from "node:crypto";

import { getVercelOidcToken } from "@vercel/oidc";
import { getPublicOrigin } from "mcp-handler";

import { keyHash, log, scrubForLog } from "./log";

export const OAUTH_ISSUER = (
  process.env.ASSEMBLYAI_OAUTH_ISSUER ?? "https://auth.assemblyai.com"
).replace(/\/+$/, "");

const EXCHANGE_ORIGIN = (
  process.env.ASSEMBLYAI_OAUTH_EXCHANGE_ORIGIN ?? "https://www.assemblyai.com"
).replace(/\/+$/, "");

export const OAUTH_SCOPES = ["aai:api", "offline_access"];

export const RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";

const EXCHANGE_TIMEOUT_MS = 10_000;

const MAX_CACHE_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 1000;

const REFUSED_CACHE_MS = 60 * 1000;
/** Keys returned refund the count: hosted connectors (Claude.ai, ChatGPT) send many members from one IP. */
export const MAX_EXCHANGES_PER_IP_PER_MINUTE = 30;
const RATE_WINDOW_MS = 60 * 1000;
const MAX_TRACKED_IPS = 10_000;
export const MAX_CONCURRENT_EXCHANGES = 25;
const EXP_SKEW_MS = 60 * 1000;

/** A JWT: three base64url segments. API keys are opaque hex with no dots. */
export function looksLikeAccessToken(token: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);
}

type ExchangeOutcome =
  | { kind: "key"; apiKey: string }
  | { kind: "rejected"; detail: string }
  | { kind: "insufficient_scope"; detail: string }
  | { kind: "unavailable"; detail: string }
  | { kind: "rate_limited"; detail: string; retryAfterSeconds: number };

export interface ExchangeDeps {
  fetch: typeof fetch;
  serviceToken: () => Promise<string>;
  now: () => number;
  timeoutMs: number;
}

const defaultDeps: ExchangeDeps = {
  fetch: (...args) => fetch(...args),
  serviceToken: () => getVercelOidcToken(),
  now: () => Date.now(),
  timeoutMs: EXCHANGE_TIMEOUT_MS,
};

interface CachedKey {
  apiKey: string;
  until: number;
}

const cache = new Map<string, CachedKey>();

type Refusal = Extract<ExchangeOutcome, { kind: "rejected" | "insufficient_scope" }>;
const refused = new Map<string, { outcome: Refusal; until: number }>();
const exchangesByIp = new Map<string, { windowStart: number; count: number }>();
const inProgress = new Map<string, Promise<ExchangeOutcome>>();
let inFlight = 0;

function cacheKey(accessToken: string): string {
  return createHash("sha256").update(accessToken).digest("hex");
}

export function clearExchangeCache(): void {
  cache.clear();
  refused.clear();
  exchangesByIp.clear();
  inProgress.clear();
  inFlight = 0;
}

function setBounded<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key);
  if (map.size >= max) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

function claimsOf(jwt: string): Record<string, unknown> {
  try {
    const claims = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8"));
    return claims && typeof claims === "object" ? claims : {};
  } catch {
    return {};
  }
}

function headerOf(jwt: string): Record<string, unknown> {
  try {
    const header = JSON.parse(Buffer.from(jwt.split(".")[0] ?? "", "base64url").toString("utf8"));
    return header && typeof header === "object" ? header : {};
  } catch {
    return {};
  }
}

export function localRejection(accessToken: string, now: number): string | undefined {
  const alg = headerOf(accessToken).alg;
  if (typeof alg !== "string" || alg.toLowerCase() === "none") return "The access token is not a signed JWT";
  const exp = claimsOf(accessToken).exp;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return "The access token has no expiry";
  if (exp * 1000 + EXP_SKEW_MS <= now) return "The access token has expired";
  return undefined;
}

function tokenExpiry(accessToken: string): number | undefined {
  const exp = claimsOf(accessToken).exp;
  return typeof exp === "number" ? exp * 1000 : undefined;
}

async function jsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function detailOf(body: unknown, status: number): string {
  const { detail, error } = (body ?? {}) as { detail?: unknown; error?: unknown };
  const text = detail ?? error;
  return typeof text === "string" ? text : `HTTP ${status}`;
}

async function exchangeAccessToken(
  accessToken: string,
  deps: ExchangeDeps = defaultDeps,
  clientIp = "unknown"
): Promise<ExchangeOutcome> {
  const entry = cacheKey(accessToken);
  const now = deps.now();
  const cached = cache.get(entry);
  if (cached && cached.until > now) return { kind: "key", apiKey: cached.apiKey };
  cache.delete(entry);

  const known = refused.get(entry);
  if (known && known.until > now) return known.outcome;
  refused.delete(entry);

  const local = localRejection(accessToken, now);
  if (local) {
    log({ event: "oauth_exchange_rejected", level: "warn", tokenHash: keyHash(accessToken), reason: "local", detail: local });
    return { kind: "rejected", detail: local };
  }

  const shared = inProgress.get(entry);
  if (shared) return shared;

  const window = exchangesByIp.get(clientIp);
  const count = window && now - window.windowStart < RATE_WINDOW_MS ? window.count : 0;
  if (count >= MAX_EXCHANGES_PER_IP_PER_MINUTE) {
    const retryAfterSeconds = Math.max(1, Math.ceil((window!.windowStart + RATE_WINDOW_MS - now) / 1000));
    log({ event: "oauth_exchange_rate_limited", level: "warn", reason: "per_ip", retryAfterSeconds });
    return { kind: "rate_limited", detail: "Too many sign-in exchanges from this client", retryAfterSeconds };
  }
  if (inFlight >= MAX_CONCURRENT_EXCHANGES) {
    log({ event: "oauth_exchange_rate_limited", level: "warn", reason: "concurrency" });
    return { kind: "rate_limited", detail: "Too many sign-in exchanges in progress", retryAfterSeconds: 1 };
  }
  const windowStart = count === 0 ? now : window!.windowStart;
  setBounded(exchangesByIp, clientIp, { windowStart, count: count + 1 }, MAX_TRACKED_IPS);

  inFlight++;
  const exchange = (async () => {
    try {
      const outcome = await exchangeUpstream(accessToken, entry, now, deps);
      if (outcome.kind === "rejected" || outcome.kind === "insufficient_scope") {
        setBounded(refused, entry, { outcome, until: now + REFUSED_CACHE_MS }, MAX_CACHE_ENTRIES);
      }
      if (outcome.kind === "key") {
        const current = exchangesByIp.get(clientIp);
        if (current && current.windowStart === windowStart && current.count > 0) current.count--;
      }
      return outcome;
    } finally {
      inFlight--;
      inProgress.delete(entry);
    }
  })();
  inProgress.set(entry, exchange);
  return exchange;
}

function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

async function exchangeUpstream(
  accessToken: string,
  entry: string,
  now: number,
  deps: ExchangeDeps
): Promise<ExchangeOutcome> {
  const deadline = AbortSignal.timeout(deps.timeoutMs);
  let serviceToken: string;
  try {
    serviceToken = await untilAborted(deps.serviceToken(), deadline);
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    log({
      event: "oauth_exchange_unavailable",
      level: "error",
      reason: timedOut ? "service_token_timeout" : "no_service_token",
      detail: scrubForLog(error instanceof Error ? error.message : String(error)),
    });
    return { kind: "unavailable", detail: "This server could not authenticate to AssemblyAI" };
  }

  let response: Response;
  try {
    response = await deps.fetch(`${EXCHANGE_ORIGIN}/api/v2/oauth/api-key`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "X-AAI-Service-Token": serviceToken,
        Accept: "application/json",
      },
      signal: deadline,
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    log({
      event: "oauth_exchange_unavailable",
      level: "error",
      reason: timedOut ? "timeout" : "network",
      detail: scrubForLog(error instanceof Error ? error.message : String(error)),
    });
    return { kind: "unavailable", detail: "AssemblyAI could not be reached" };
  }

  const tokenId = keyHash(accessToken);
  let parsed: unknown;
  try {
    parsed = await jsonBody(response);
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    log({
      event: "oauth_exchange_unavailable",
      level: "error",
      reason: timedOut ? "timeout" : "body_read",
      status: response.status,
      detail: scrubForLog(error instanceof Error ? error.message : String(error)),
    });
    return { kind: "unavailable", detail: "AssemblyAI could not be reached" };
  }

  if (response.ok) {
    const body = (parsed ?? {}) as {
      api_key?: unknown;
      api_key_rotates_at?: unknown;
      connection_id?: unknown;
    };
    if (typeof body.api_key !== "string" || body.api_key.length === 0) {
      log({ event: "oauth_exchange_unavailable", level: "error", reason: "no_key_in_response" });
      return { kind: "unavailable", detail: "AssemblyAI returned no API key" };
    }
    const rotatesAt =
      typeof body.api_key_rotates_at === "string" ? Date.parse(body.api_key_rotates_at) : NaN;
    const until = Math.min(
      now + MAX_CACHE_MS,
      Number.isNaN(rotatesAt) ? Infinity : rotatesAt,
      tokenExpiry(accessToken) ?? Infinity
    );
    setBounded(cache, entry, { apiKey: body.api_key, until }, MAX_CACHE_ENTRIES);
    log({
      event: "oauth_exchange_ok",
      connectionId: typeof body.connection_id === "string" ? body.connection_id : undefined,
      tokenHash: tokenId,
      keyHash: keyHash(body.api_key),
    });
    return { kind: "key", apiKey: body.api_key };
  }

  const detail = scrubForLog(detailOf(parsed, response.status)) ?? `HTTP ${response.status}`;
  if (response.status === 401 && detail === "Unknown client") {
    // "Unknown client": AssemblyAI refused this deployment's service token, which sign-in can't fix. Log its claims, never the token.
    const { iss, aud, project_id, environment } = claimsOf(serviceToken);
    log({
      event: "oauth_exchange_unavailable",
      level: "error",
      reason: "service_token_refused",
      status: 401,
      serviceToken: { iss, aud, project_id, environment },
    });
    return { kind: "unavailable", detail: "AssemblyAI did not accept this server; try again later" };
  }
  if (response.status === 401) {
    log({ event: "oauth_exchange_rejected", level: "warn", tokenHash: tokenId, status: 401, detail });
    return { kind: "rejected", detail };
  }
  if (response.status === 403) {
    log({ event: "oauth_exchange_rejected", level: "warn", tokenHash: tokenId, status: 403, detail });
    // Only a missing-scope 403 is fixed by a new consent; other AssemblyAI 403s need a fresh sign-in, which a 401 starts.
    return /scope/i.test(detail)
      ? { kind: "insufficient_scope", detail }
      : { kind: "rejected", detail };
  }
  log({
    event: "oauth_exchange_unavailable",
    level: "error",
    reason: "upstream",
    status: response.status,
    detail,
  });
  return { kind: "unavailable", detail: "AssemblyAI could not issue an API key; try again" };
}

/** Not `new Request(req, init)`: on Vercel, the global Request copy constructor throws on Next's Request subclass. */
function withBearer(req: Request, token: string): Request {
  const headers = new Headers(req.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const init: RequestInit & { duplex?: "half" } = {
    method: req.method,
    headers,
    signal: req.signal,
    body: hasBody ? req.body : undefined,
    // Node's fetch needs this to send a streamed body.
    duplex: hasBody ? "half" : undefined,
  };
  return new Request(req.url, init);
}

/** On Vercel the platform sets x-forwarded-for and a client can't. */
function clientIpOf(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || req.headers.get("x-real-ip")?.trim() || "unknown";
}

function bearerOf(req: Request): string | undefined {
  const match = /^bearer\s+(\S+)\s*$/i.exec(req.headers.get("Authorization")?.trim() ?? "");
  return match?.[1];
}

function challenge(req: Request, status: 401 | 403, error: string, description: string): Response {
  const metadata = `${getPublicOrigin(req)}${RESOURCE_METADATA_PATH}`;
  // Header values take printable ASCII only; anything else makes `new Response` throw.
  const quoted = description.replace(/[^\x20-\x7E]|["\\]/g, "");
  const scope = status === 403 ? `, scope="${OAUTH_SCOPES.join(" ")}"` : "";
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: {
      "WWW-Authenticate": `Bearer error="${error}", error_description="${quoted}"${scope}, resource_metadata="${metadata}"`,
      "Content-Type": "application/json",
    },
  });
}

export function withOAuthExchange(
  handler: (req: Request) => Promise<Response>,
  deps: ExchangeDeps = defaultDeps
): (req: Request) => Promise<Response> {
  return async (req) => {
    const bearer = bearerOf(req);
    if (!bearer || !looksLikeAccessToken(bearer)) return handler(req);

    const outcome = await exchangeAccessToken(bearer, deps, clientIpOf(req));
    switch (outcome.kind) {
      case "key":
        return handler(withBearer(req, outcome.apiKey));
      case "rejected":
        return challenge(req, 401, "invalid_token", outcome.detail);
      case "insufficient_scope":
        return challenge(req, 403, "insufficient_scope", outcome.detail);
      case "unavailable":
        return new Response(JSON.stringify({ error: "temporarily_unavailable", error_description: outcome.detail }), {
          status: 503,
          headers: { "Content-Type": "application/json", "Retry-After": "5" },
        });
      case "rate_limited":
        return new Response(JSON.stringify({ error: "rate_limited", error_description: outcome.detail }), {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": String(outcome.retryAfterSeconds) },
        });
    }
  };
}

/**
 * `withMcpAuth` answers a request with no Bearer as `invalid_token`. RFC 6750
 * section 3.1: when the request lacks any authentication information, the
 * challenge should carry no error code. `invalid_token` says a token was sent
 * and refused, which can send a client down a refresh or re-register path
 * instead of plain discovery. So a 401 for a request with no Bearer is
 * rewritten to `Bearer resource_metadata="..."`. A 401 for a Bearer that was
 * sent keeps its error code.
 */
export function withMissingCredentialsChallenge(
  handler: (req: Request) => Promise<Response>
): (req: Request) => Promise<Response> {
  return async (req) => {
    const res = await handler(req);
    if (res.status !== 401 || bearerOf(req) !== undefined) return res;
    const metadata = /resource_metadata="[^"]*"/.exec(res.headers.get("WWW-Authenticate") ?? "")?.[0];
    if (!metadata) return res;
    const headers = new Headers(res.headers);
    headers.set("WWW-Authenticate", `Bearer ${metadata}`);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };
}
