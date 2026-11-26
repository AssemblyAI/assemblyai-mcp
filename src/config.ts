const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

export interface ResolveHttpsUrlOptions {
  allowHttpLocalhost?: boolean;
}

export function resolveHttpsUrl(envName: string, def: string, opts?: ResolveHttpsUrlOptions): string {
  const raw = (process.env[envName] ?? def).trim();
  if (!raw) {
    throw new Error(`Server misconfigured (BAD_ENV): ${envName} is empty; set it to an https: URL.`);
  }
  if (raw.includes("@")) {
    throw new Error(`Server misconfigured (BAD_ENV): ${envName} must not contain credentials.`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Server misconfigured (BAD_ENV): ${envName} must be an absolute https: URL.`);
  }
  if (url.username || url.password) {
    throw new Error(`Server misconfigured (BAD_ENV): ${envName} must not contain credentials.`);
  }
  if (url.protocol === "http:") {
    if (!opts?.allowHttpLocalhost || !LOCAL_HOSTNAMES.has(url.hostname)) {
      throw new Error(
        `Server misconfigured (BAD_ENV): ${envName} must use https: (http is only allowed for localhost).`
      );
    }
  } else if (url.protocol !== "https:") {
    throw new Error(`Server misconfigured (BAD_ENV): ${envName} must use https:.`);
  }
  return url.toString().replace(/\/+$/, "");
}
