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

/** Re-exchange at least this often, to notice a revoked connection. */
const MAX_CACHE_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 1000;

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
  | { kind: "unavailable"; detail: string };

export interface ExchangeDeps {
  fetch: typeof fetch;
  serviceToken: () => Promise<string>;
  now: () => number;
}

const defaultDeps: ExchangeDeps = {
  fetch: (...args) => fetch(...args),
  serviceToken: () => getVercelOidcToken(),
  now: () => Date.now(),
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

function cacheKey(accessToken: string): string {
  return createHash("sha256").update(accessToken).digest("hex");
}

/** Test hook: forget every cached key. */
export function clearExchangeCache(): void {
  cache.clear();
}

/** A JWT's claims, read without verifying it. */
function claimsOf(jwt: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

/** The access token's own expiry: it only bounds how long a key is cached for
 * it. AssemblyAI verifies the token. */
function tokenExpiry(accessToken: string): number | undefined {
  const exp = claimsOf(accessToken).exp;
  return typeof exp === "number" ? exp * 1000 : undefined;
}

async function detailOf(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: unknown; error?: unknown };
    const detail = body.detail ?? body.error;
    return typeof detail === "string" ? detail : `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

/** Exchange an access token for its connection's API key, from the cache when
 * the cached entry is still fresh. */
export async function exchangeAccessToken(
  accessToken: string,
  deps: ExchangeDeps = defaultDeps
): Promise<ExchangeOutcome> {
  const entry = cacheKey(accessToken);
  const now = deps.now();
  const cached = cache.get(entry);
  if (cached && cached.until > now) return { kind: "key", apiKey: cached.apiKey };
  cache.delete(entry);

  let serviceToken: string;
  try {
    serviceToken = await deps.serviceToken();
  } catch (error) {
    log({
      event: "oauth_exchange_unavailable",
      level: "error",
      reason: "no_service_token",
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
    });
  } catch (error) {
    log({
      event: "oauth_exchange_unavailable",
      level: "error",
      reason: "network",
      detail: scrubForLog(error instanceof Error ? error.message : String(error)),
    });
    return { kind: "unavailable", detail: "AssemblyAI could not be reached" };
  }

  const tokenId = keyHash(accessToken);
  if (response.ok) {
    // `?? {}` too: a body of JSON `null` parses fine but has no fields.
    const body = ((await response.json().catch(() => null)) ?? {}) as {
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
    if (cache.size >= MAX_CACHE_ENTRIES) {
      // Maps iterate in insertion order: drop the oldest.
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(entry, { apiKey: body.api_key, until });
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

  const detail = scrubForLog(await detailOf(response)) ?? `HTTP ${response.status}`;
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

function bearerOf(req: Request): string | undefined {
  const [type, token] = req.headers.get("Authorization")?.split(" ") ?? [];
  return type?.toLowerCase() === "bearer" && token ? token.trim() : undefined;
}

function challenge(req: Request, status: 401 | 403, error: string, description: string): Response {
  const metadata = `${getPublicOrigin(req)}${RESOURCE_METADATA_PATH}`;
  const quoted = description.replace(/["\\]/g, "");
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

    const outcome = await exchangeAccessToken(bearer, deps);
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
    }
  };
}
