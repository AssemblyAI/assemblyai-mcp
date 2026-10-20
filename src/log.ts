type LogEvent = Record<string, unknown> & {
  event: string;
  level?: "info" | "warn" | "error";
};

export function log(event: LogEvent) {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: event.level || "info",
      ...event,
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
      ...event,
      error: {
        name: err.name,
        message: scrubForLog(err.message),
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
