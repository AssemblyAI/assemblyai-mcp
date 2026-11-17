/**
 * The time budget of one HTTP request to /mcp.
 *
 * The clock starts when the request arrives, before the OAuth key exchange,
 * so a tool can see how much of the route's maxDuration is left after sign-in
 * and never start billable work it has no time to return.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** Must match `maxDuration` of the MCP route (60 s). */
export const ROUTE_BUDGET_MS = 60_000;

const startedAt = new AsyncLocalStorage<number>();

/** Wrap the route handler: everything it awaits sees this request's start time. */
export function withRequestClock<Req, Res>(handler: (req: Req) => Promise<Res>): (req: Req) => Promise<Res> {
  return (req) => startedAt.run(Date.now(), () => handler(req));
}

/**
 * Milliseconds left in the current request's budget. Outside a request (tests,
 * scripts) the clock starts now, so the whole budget is left.
 */
export function remainingMs(now: number = Date.now()): number {
  return ROUTE_BUDGET_MS - (now - (startedAt.getStore() ?? now));
}
