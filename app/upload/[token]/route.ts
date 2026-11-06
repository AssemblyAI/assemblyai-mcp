import { AssemblyAIError, uploadFile } from "../../../src/assemblyai";
import { log, logError, keyHash } from "../../../src/log";
import { MAX_UPLOAD_BYTES, readUploadToken, uploadsConfigured } from "../../../src/upload-token";

// Receives a local file from an agent (via the link from create_upload_url)
// and forwards it to AssemblyAI's private /v2/upload. Nothing is stored here.
export const maxDuration = 60;

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

async function handle(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const start = Date.now();
  if (!uploadsConfigured()) return json(404, { error: "Local file uploads are not enabled on this server." });
  const { token } = await params;
  const apiKey = readUploadToken(token);
  if (!apiKey) {
    return json(401, {
      error: "This upload link is invalid or has expired. Call create_upload_url again for a new one.",
    });
  }

  // Vercel caps bodies at 4.5 MB, but other hosts don't: check the declared
  // size first, then stop reading once the body passes the limit.
  if (Number(req.headers.get("content-length")) > MAX_UPLOAD_BYTES) return tooLarge();
  const data = await readCapped(req, MAX_UPLOAD_BYTES);
  if (!data) return tooLarge();
  if (data.byteLength === 0) {
    return json(400, { error: 'The request body is empty. Send the file with curl --data-binary @"/path/to/file".' });
  }

  try {
    const { upload_url } = await uploadFile(apiKey, data);
    log({
      event: "upload",
      keyHash: keyHash(apiKey),
      bytes: data.byteLength,
      status: "success",
      latencyMs: Date.now() - start,
    });
    return json(200, { upload_url });
  } catch (err) {
    logError({ event: "upload", keyHash: keyHash(apiKey), bytes: data.byteLength, status: "error" }, err);
    return uploadError(err);
  }
}

function tooLarge(): Response {
  return json(413, {
    error:
      "The file is too large: uploads are limited to 4.5 MB. Compress it (e.g. ffmpeg -i in -ac 1 -b:a 32k out.mp3) " +
      "or use a public URL with submit_transcript.",
  });
}

/** The request body, or undefined once it passes `max` bytes. */
async function readCapped(req: Request, max: number): Promise<ArrayBuffer | undefined> {
  if (!req.body) return new ArrayBuffer(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

// AssemblyAI's 4xx passes through; network failures and its 5xx become 502.
function uploadError(err: unknown): Response {
  const status = err instanceof AssemblyAIError ? err.status : 502;
  if (status === 401) return json(401, { error: "AssemblyAI rejected the API key (401)." });
  if (status >= 500) return json(502, { error: "AssemblyAI upload failed. Try again shortly." });
  return json(status, { error: (err as Error).message });
}

export { handle as POST, handle as PUT };
