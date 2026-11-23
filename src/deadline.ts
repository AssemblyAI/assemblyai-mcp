import { AsyncLocalStorage } from "node:async_hooks";

/** Not the platform limit: the route exports no maxDuration, so Vercel applies the project default (300 s with Fluid compute). */
export const ROUTE_BUDGET_MS = 60_000;

const startedAt = new AsyncLocalStorage<number>();

export function withRequestClock<Req, Res>(handler: (req: Req) => Promise<Res>): (req: Req) => Promise<Res> {
  return (req) => startedAt.run(Date.now(), () => handler(req));
}

export function remainingMs(now: number = Date.now()): number {
  return ROUTE_BUDGET_MS - (now - (startedAt.getStore() ?? now));
}
