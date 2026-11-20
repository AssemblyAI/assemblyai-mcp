/**
 * "Sign in with AssemblyAI" for MCP clients.
 *
 * A client that signed the member in through AssemblyAI's authorization server
 * sends its OAuth access token as the Bearer. AssemblyAI's API takes API keys,
 * not access tokens, so before the request reaches `withMcpAuth` the token is
 * exchanged for the API key of the member's connection to this client
 * (`POST /api/v2/oauth/api-key`), and the request continues with that key, as
 * if the client had sent it. A Bearer that isn't an access token is an API key
 * and passes through untouched, as before.
 *
 * The exchange authenticates this server too: the deployment's Vercel OIDC
 * token goes in `X-AAI-Service-Token`, so only this project's production
 * deployment (or, against a non-production AssemblyAI environment, its
 * previews) can exchange on a member's behalf.
 *
 * Keys are cached per access token for a few minutes (never past the key's
 * rotation or the token's expiry), so a busy session doesn't exchange on every
 * request, while a connection revoked meanwhile (signed out in the dashboard,
 * the member deleted) is noticed within minutes and the client sent back to
 * sign-in, instead of calling the API with a dead key.
 */

import { createHash } from "node:crypto";

import { getVercelOidcToken } from "@vercel/oidc";
import { getPublicOrigin } from "mcp-handler";

import { keyHash, log, scrubForLog } from "./log";

/** The authorization server MCP clients sign in with, advertised in the
 * protected resource metadata. */
export const OAUTH_ISSUER = (
  process.env.ASSEMBLYAI_OAUTH_ISSUER ?? "https://auth.assemblyai.com"
).replace(/\/+$/, "");

/** Where access tokens are exchanged for API keys. */
const EXCHANGE_ORIGIN = (
  process.env.ASSEMBLYAI_OAUTH_EXCHANGE_ORIGIN ?? "https://www.assemblyai.com"
).replace(/\/+$/, "");

/** Scopes a client asks for: the API itself, and a refresh token so the
 * member isn't sent back to the consent page every few hours. */
export const OAUTH_SCOPES = ["aai:api", "offline_access"];

export const RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";

/** Give up on an exchange after this long and answer 503, rather than let a
 * stalled AssemblyAI hold the request until the function times out. */
const EXCHANGE_TIMEOUT_MS = 10_000;

/** Re-exchange at least this often, to notice a revoked connection. */
const MAX_CACHE_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 1000;

/**
 * Guards on the exchange (issue #44). The exchange runs before any auth
 * check and is signed with this deployment's service identity, so without
 * these any client on the internet could make it POST to AssemblyAI once per
 * request with made-up JWT-shaped tokens.
 */
/** A refused token is answered from memory for this long, not re-exchanged. */
const REFUSED_CACHE_MS = 60 * 1000;
/** Failed upstream exchanges one client IP may make per minute. An exchange
 * that returns a key gives its count back, because hosted connectors
 * (Claude.ai, ChatGPT) send many members from one IP. A flood of made-up
 * tokens is all failures, so it is still capped. */
export const MAX_EXCHANGES_PER_IP_PER_MINUTE = 30;
const RATE_WINDOW_MS = 60 * 1000;
const MAX_TRACKED_IPS = 10_000;
/** Upstream exchanges in flight at once on this instance. Each one can hold
 * an invocation for up to EXCHANGE_TIMEOUT_MS. */
export const MAX_CONCURRENT_EXCHANGES = 25;
/** Clock skew allowed when a token's own `exp` is checked locally. */
const EXP_SKEW_MS = 60 * 1000;

/** A JWT: three base64url segments. API keys are opaque hex with no dots. */
export function looksLikeAccessToken(token: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);
}

export type ExchangeOutcome =
  | { kind: "key"; apiKey: string }
  /** The token, the member or their access was refused: sign in again. */
  | { kind: "rejected"; detail: string }
  /** The token lacks `aai:api` (a member whose role can't create keys). */
  | { kind: "insufficient_scope"; detail: string }
  /** AssemblyAI couldn't answer, or this server couldn't authenticate itself. */
  | { kind: "unavailable"; detail: string }
  /** Too many exchanges from this client, or in flight here: try again later. */
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

/**
 * Shared across requests on purpose: that's what spares a session an exchange
 * per request. Keyed by the full SHA-256 of the access token (never the token
 * itself), so only the exact token that was exchanged gets its key back; the
 * short `keyHash` is for logs only.
 */
const cache = new Map<string, CachedKey>();

type Refusal = Extract<ExchangeOutcome, { kind: "rejected" | "insufficient_scope" }>;
/** Tokens AssemblyAI refused, by the same hash, so a repeat is answered
 * without another upstream call. */
const refused = new Map<string, { outcome: Refusal; until: number }>();
/** Exchanges started per client IP in the current window. */
const exchangesByIp = new Map<string, { windowStart: number; count: number }>();
let inFlight = 0;

function cacheKey(accessToken: string): string {
  return createHash("sha256").update(accessToken).digest("hex");
}

/** Test hook: forget every cached key, refusal and rate-limit counter. */
export function clearExchangeCache(): void {
  cache.clear();
  refused.clear();
  exchangesByIp.clear();
  inFlight = 0;
}

/** Set `key` in a Map, dropping the oldest entry first when it is full. */
function setBounded<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key);
  if (map.size >= max) {
    // Maps iterate in insertion order: drop the oldest.
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

/** A JWT's claims, read without verifying it. */
function claimsOf(jwt: string): Record<string, unknown> {
  try {
    const claims = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8"));
    return claims && typeof claims === "object" ? claims : {};
  } catch {
    return {};
  }
}

/** A JWT's header, read without verifying it. */
function headerOf(jwt: string): Record<string, unknown> {
  try {
    const header = JSON.parse(Buffer.from(jwt.split(".")[0] ?? "", "base64url").toString("utf8"));
    return header && typeof header === "object" ? header : {};
  } catch {
    return {};
  }
}

/**
 * Why a token can't be a live access token, checked without the network, or
 * undefined when it might be. This does not verify the token (AssemblyAI
 * does); it only spares AssemblyAI the tokens that are plainly not real:
 * not JSON, unsigned, with no expiry, or expired.
 */
export function localRejection(accessToken: string, now: number): string | undefined {
  const alg = headerOf(accessToken).alg;
  if (typeof alg !== "string" || alg.toLowerCase() === "none") return "The access token is not a signed JWT";
  const exp = claimsOf(accessToken).exp;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return "The access token has no expiry";
  if (exp * 1000 + EXP_SKEW_MS <= now) return "The access token has expired";
  return undefined;
}

/** The access token's own expiry: it only bounds how long a key is cached for
 * it. AssemblyAI verifies the token. */
function tokenExpiry(accessToken: string): number | undefined {
  const exp = claimsOf(accessToken).exp;
  return typeof exp === "number" ? exp * 1000 : undefined;
}

/** The response body as JSON, or null when it isn't JSON. Throws when the
 * body can't be read at all (the deadline passed mid-body, the connection
 * dropped): that's an outage, not an answer, whatever the status said. */
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

/** Exchange an access token for its connection's API key, from the cache when
 * the cached entry is still fresh. `clientIp` keys the per-client rate limit
 * on upstream exchanges. */
export async function exchangeAccessToken(
  accessToken: string,
  deps: ExchangeDeps = defaultDeps,
  clientIp = "unknown"
): Promise<ExchangeOutcome> {
  const entry = cacheKey(accessToken);
  const now = deps.now();
  const cached = cache.get(entry);
  if (cached && cached.until > now) return { kind: "key", apiKey: cached.apiKey };
  cache.delete(entry);

  // Everything below can reach AssemblyAI; refuse what needs no call first.
  const known = refused.get(entry);
  if (known && known.until > now) return known.outcome;
  refused.delete(entry);

  const local = localRejection(accessToken, now);
  if (local) {
    log({ event: "oauth_exchange_rejected", level: "warn", tokenHash: keyHash(accessToken), reason: "local", detail: local });
    return { kind: "rejected", detail: local };
  }

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
  try {
    const outcome = await exchangeUpstream(accessToken, entry, now, deps);
    if (outcome.kind === "rejected" || outcome.kind === "insufficient_scope") {
      setBounded(refused, entry, { outcome, until: now + REFUSED_CACHE_MS }, MAX_CACHE_ENTRIES);
    }
    if (outcome.kind === "key") {
      // Only failures count against the IP. Refund in the window we charged:
      // if that window has ended, its count no longer matters.
      const current = exchangesByIp.get(clientIp);
      if (current && current.windowStart === windowStart && current.count > 0) current.count--;
    }
    return outcome;
  } finally {
    inFlight--;
  }
}

/** `promise`, or a rejection with the signal's reason once it aborts. */
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

/** The exchange itself: one POST to AssemblyAI. */
async function exchangeUpstream(
  accessToken: string,
  entry: string,
  now: number,
  deps: ExchangeDeps
): Promise<ExchangeOutcome> {
  // One deadline for the whole exchange, service token included: a stalled
  // OIDC lookup must not hold a concurrency slot past it.
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
      // Also aborts reading the body below: a stalled body parses as no key
      // (503), like a stalled connection.
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
    // `?? {}`: a body of JSON `null`, or none at all, has no fields.
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
      // Not a secret, and stable for the connection's life: joins these logs
      // to AssemblyAI's own, its audit log and the member's Connected apps.
      connectionId: typeof body.connection_id === "string" ? body.connection_id : undefined,
      tokenHash: tokenId,
      keyHash: keyHash(body.api_key),
    });
    return { kind: "key", apiKey: body.api_key };
  }

  const detail = scrubForLog(detailOf(parsed, response.status)) ?? `HTTP ${response.status}`;
  if (response.status === 401 && detail === "Unknown client") {
    // AssemblyAI didn't accept this deployment's service token (not the
    // deployment it trusts, or its OIDC settings aren't in place). Signing
    // in again can't fix that, so it must not read as a refused token.
    // The claims AssemblyAI matches against its settings, to compare with
    // them; the token itself is never logged.
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
    // A missing scope is the one 403 a new consent with the right role fixes
    // as asked; the others (revoked access, a disabled member) need a fresh
    // sign-in, which a 401 starts.
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

/**
 * The same request with another Bearer. Built from the request's public parts,
 * not `new Request(req, init)`: on Vercel the incoming request is Next's own
 * Request subclass, from a different copy of the fetch implementation than the
 * global `Request`, whose copy constructor reads private fields the subclass
 * doesn't have and throws.
 */
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

/** The client's IP: the first x-forwarded-for entry (on Vercel the platform
 * sets this header and a client can't), else x-real-ip. */
function clientIpOf(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || req.headers.get("x-real-ip")?.trim() || "unknown";
}

function bearerOf(req: Request): string | undefined {
  // Any run of whitespace after the scheme, not just one space: a split on
  // " " reads "Bearer  <token>" as an empty token and skips the exchange.
  const match = /^bearer\s+(\S+)\s*$/i.exec(req.headers.get("Authorization")?.trim() ?? "");
  return match?.[1];
}

function challenge(req: Request, status: 401 | 403, error: string, description: string): Response {
  const metadata = `${getPublicOrigin(req)}${RESOURCE_METADATA_PATH}`;
  // A header value takes printable ASCII only: an upstream detail with a
  // newline or a curly apostrophe would make `new Response` throw, turning the
  // challenge into a 500. The JSON body keeps the original wording.
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

/**
 * Wrap the MCP route: exchange an access token for its API key and hand the
 * request on with the key as the Bearer. A refused token is a 401 (or a 403
 * for a missing scope) that points the client back at sign-in; an outage is a
 * 503, not a 401, so a client doesn't send the member through sign-in again
 * for a problem sign-in can't fix.
 */
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
        // 429, not 401: signing in again would not help.
        return new Response(JSON.stringify({ error: "rate_limited", error_description: outcome.detail }), {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": String(outcome.retryAfterSeconds) },
        });
    }
  };
}
