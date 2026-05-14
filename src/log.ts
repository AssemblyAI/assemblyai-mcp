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

export function logError(event: Record<string, unknown>, error: unknown) {
  const err = error instanceof Error ? error : new Error(String(error));
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "error",
      ...event,
      error: {
        name: err.name,
        message: err.message,
        stack: err.stack,
      },
    })
  );
}

import { createHash } from "node:crypto";

/** Short, non-reversible identifier for a Bearer token. Never logs the key. */
export function keyHash(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 12);
}
