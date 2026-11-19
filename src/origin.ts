const HOST = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(:\d{1,5})?$/;

const PRODUCTION_HOST = "mcp.assemblyai.com";
const PRODUCTION_ORIGIN = `https://${PRODUCTION_HOST}`;
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Hostnames (no port) this deployment may put in the links it hands out:
 * production, the deployment's own Vercel hostnames (set by Vercel on every
 * deployment, previews included), and any listed in PUBLIC_HOSTS
 * (comma-separated, for a self-hosted domain). Read on each call, so a
 * deployment's settings apply without a code change.
 */
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

/**
 * The public origin (`https://host`) for links we show or hand out, from the
 * request's x-forwarded-host / host headers. Behind more than one proxy,
 * x-forwarded-host is a comma-separated list; the first entry is the host the
 * client used.
 *
 * The origin ends up in an upload link and in a shell command we hand out, so
 * a header can only pick among hosts we trust (issue #74): a local host (on
 * any port, over http), production, this deployment's own Vercel hostnames,
 * or one listed in PUBLIC_HOSTS. Anything else, and anything that is not a
 * valid URL host (port over 65535, IPv4 octet over 255, bad IPv6, shell or
 * URL syntax), falls back to production. The result always parses with
 * `new URL`.
 */
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
