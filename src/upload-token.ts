/**
 * Short-lived upload links for local files.
 *
 * The server can't read files on the user's computer, and an agent signed in
 * with OAuth never sees an API key it could upload with. So `create_upload_url`
 * hands the agent a link to `/upload/<token>`, where the token is the caller's
 * API key and an expiry, encrypted with AES-256-GCM under UPLOAD_TOKEN_SECRET.
 * The agent never sees the key, and the server stores nothing: the upload
 * route decrypts the token and forwards the file to AssemblyAI's /v2/upload.
 *
 * A leaked link lets someone upload files into the user's AssemblyAI account
 * until it expires. It does not let them read transcripts or start billable
 * work, which is why a ten-minute expiry, not single use, is the limit.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export const UPLOAD_TTL_MS = 10 * 60 * 1000;

// Vercel Functions reject request bodies over 4.5 MB (decimal) with a
// plain-text 413 before our code runs.
export const MAX_UPLOAD_BYTES = 4_500_000;

const AAD = Buffer.from("assemblyai-mcp-upload-v1");

function secretKey(): Buffer | undefined {
  const secret = process.env.UPLOAD_TOKEN_SECRET;
  if (!secret || secret.length < 32) return undefined;
  return createHash("sha256").update(secret).digest();
}

export function uploadsConfigured(): boolean {
  return secretKey() !== undefined;
}

export function createUploadToken(apiKey: string, now = Date.now()): { token: string; expiresAt: number } {
  const key = secretKey();
  if (!key) throw new Error("Local file uploads are not configured on this server (UPLOAD_TOKEN_SECRET is unset).");
  const expiresAt = now + UPLOAD_TTL_MS;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ k: apiKey, exp: expiresAt }), "utf8"), cipher.final()]);
  const token = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
  return { token, expiresAt };
}

/** Returns the API key inside a valid, unexpired token, or undefined. */
export function readUploadToken(token: string, now = Date.now()): string | undefined {
  const key = secretKey();
  if (!key) return undefined;
  try {
    const raw = Buffer.from(token, "base64url");
    if (raw.length < 29) return undefined;
    const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    decipher.setAAD(AAD);
    decipher.setAuthTag(raw.subarray(12, 28));
    const plain = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    const { k, exp } = JSON.parse(plain) as { k?: unknown; exp?: unknown };
    if (typeof k !== "string" || typeof exp !== "number" || exp <= now) return undefined;
    return k;
  } catch {
    // Tampered, truncated, or encrypted under another secret.
    return undefined;
  }
}
