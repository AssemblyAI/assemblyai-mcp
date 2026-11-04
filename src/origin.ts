/**
 * The public origin (`https://host`) for links we show or hand out, from the
 * request's x-forwarded-host / host headers. Behind more than one proxy,
 * x-forwarded-host is a comma-separated list; the first entry is the host the
 * client used. Only an exact local host gets http; "localhost.example.com"
 * must not match.
 */
export function publicOrigin(forwardedHost: string | null | undefined, host: string | null | undefined): string {
  const h = forwardedHost?.split(",")[0]?.trim() || host?.trim() || "mcp.assemblyai.com";
  const hostname = h.split(":")[0];
  const proto = hostname === "localhost" || hostname === "127.0.0.1" ? "http" : "https";
  return `${proto}://${h}`;
}
