const HOST = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(:\d{1,5})?$/;

/** Behind several proxies x-forwarded-host is a comma-separated list; the first entry is the client's host. */
export function publicOrigin(forwardedHost: string | null | undefined, host: string | null | undefined): string {
  const candidate = forwardedHost?.split(",")[0]?.trim() || host?.trim() || "";
  const h = HOST.test(candidate) ? candidate : "mcp.assemblyai.com";
  const hostname = h.split(":")[0];
  const proto = hostname === "localhost" || hostname === "127.0.0.1" ? "http" : "https";
  return `${proto}://${h}`;
}
