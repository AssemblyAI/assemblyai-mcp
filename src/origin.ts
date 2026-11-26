const HOST = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(:\d{1,5})?$/;

const PRODUCTION_HOST = "mcp.assemblyai.com";
const PRODUCTION_ORIGIN = `https://${PRODUCTION_HOST}`;
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

function allowedHostnames(): Set<string> {
  const hosts = new Set([PRODUCTION_HOST]);
  const listed = [
    process.env.VERCEL_URL,
    process.env.VERCEL_BRANCH_URL,
    process.env.VERCEL_PROJECT_PRODUCTION_URL,
    ...(process.env.PUBLIC_HOSTS ?? "").split(","),
  ];
  for (const entry of listed) {
    const hostname = entry?.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/[:/].*$/, "");
    if (hostname) hosts.add(hostname);
  }
  return hosts;
}

/** Behind several proxies x-forwarded-host is a comma-separated list; the first entry is the client's host. */
export function publicOrigin(forwardedHost: string | null | undefined, host: string | null | undefined): string {
  const candidate = forwardedHost?.split(",")[0]?.trim() || host?.trim() || "";
  if (!HOST.test(candidate)) return PRODUCTION_ORIGIN;

  let parsed: URL;
  try {
    parsed = new URL(`https://${candidate}`);
  } catch {
    return PRODUCTION_ORIGIN;
  }
  // new URL normalizes (lowercase, IPv4 shorthand like "127.1"): use its
  // hostname for the checks and its host for the result.
  const hostname = parsed.hostname;
  if (LOCAL_HOSTNAMES.has(hostname)) return `http://${parsed.host}`;
  if (!allowedHostnames().has(hostname)) return PRODUCTION_ORIGIN;
  return `https://${parsed.host}`;
}
