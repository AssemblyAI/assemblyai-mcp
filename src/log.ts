type LogEvent = Record<string, unknown> & {
  event: string;
  level?: "info" | "warn" | "error";
};

/** Longest string kept per log field. A caller controls some values (a bad
 * transcript_id can be megabytes); one request must not make one huge log line. */
export const MAX_LOG_FIELD_CHARS = 256;

/** Strings over the limit are cut, with the number of dropped characters. */
export function capForLog(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length > MAX_LOG_FIELD_CHARS
      ? `${value.slice(0, MAX_LOG_FIELD_CHARS)}…[+${value.length - MAX_LOG_FIELD_CHARS} chars]`
      : value;
  }
  if (depth >= 3 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => capForLog(item, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, capForLog(v, depth + 1)]));
}

function capFields(event: Record<string, unknown>): Record<string, unknown> {
  return capForLog(event) as Record<string, unknown>;
}

export function log(event: LogEvent) {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: event.level || "info",
      ...capFields(event),
    })
  );
}

/**
 * Upstream error text is logged verbatim, and some API errors can echo request
 * values. Strip anything that could be customer data before it reaches logs:
 * URLs (audio links, webhook targets) and long opaque tokens (keys, secrets).
 */
export function scrubForLog(text: string | undefined): string | undefined {
  if (!text) return text;
  return text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)]+/gi, "[url]")
    .replace(/\b[A-Za-z0-9_\-]{24,}\b/g, "[redacted]");
}

export function logError(event: Record<string, unknown>, error: unknown) {
  const err = error instanceof Error ? error : new Error(String(error));
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "error",
      ...capFields(event),
      error: {
        name: err.name,
        message: capForLog(scrubForLog(err.message)),
        stack: scrubForLog(err.stack),
      },
    })
  );
}

import { createHash } from "node:crypto";

/** Short, non-reversible identifier for a Bearer token. Never logs the key. */
export function keyHash(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 12);
}
