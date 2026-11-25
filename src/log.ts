type LogEvent = Record<string, unknown> & {
  event: string;
  level?: "info" | "warn" | "error";
};

export const MAX_LOG_FIELD_CHARS = 256;

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

export const MAX_LOG_STACK_CHARS = 2048;

function capText(value: string | undefined, max: number): string | undefined {
  if (value === undefined || value.length <= max) return value;
  return `${value.slice(0, max)}…[+${value.length - max} chars]`;
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

/** Some API errors echo request values: strip URLs and long opaque tokens before they reach logs. */
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
        name: capText(err.name, MAX_LOG_FIELD_CHARS),
        message: capText(scrubForLog(err.message), MAX_LOG_FIELD_CHARS),
        stack: capText(scrubForLog(err.stack), MAX_LOG_STACK_CHARS),
      },
    })
  );
}

import { createHash } from "node:crypto";

export function keyHash(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 12);
}
