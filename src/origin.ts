const HOST = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(:\d{1,5})?$/;

/**
 * The public origin (`https://host`) for links we show or hand out, from the
 * request's x-forwarded-host / host headers. Behind more than one proxy,
 * x-forwarded-host is a comma-separated list; the first entry is the host the
 * client used. Only an exact local host gets http; "localhost.example.com"
 * must not match. A host that isn't a plain hostname[:port] falls back to
 * production: the origin ends up in links and in a shell command we hand out.
 */
export function publicOrigin(forwardedHost: string | null | undefined, host: string | null | undefined): string {
  const candidate = forwardedHost?.split(",")[0]?.trim() || host?.trim() || "";
  const h = HOST.test(candidate) ? candidate : "mcp.assemblyai.com";
  const hostname = h.split(":")[0];
  const proto = hostname === "localhost" || hostname === "127.0.0.1" ? "http" : "https";
  return `${proto}://${h}`;
}
