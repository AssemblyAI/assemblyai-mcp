import { uploadFile } from "../../../src/assemblyai";
import { log, logError, keyHash } from "../../../src/log";
import { readUploadToken } from "../../../src/upload-token";

// Receives a local file from an agent (via the link from create_upload_url)
// and forwards it to AssemblyAI's private /v2/upload. Nothing is stored here.
export const maxDuration = 60;

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

async function handle(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const start = Date.now();
  const { token } = await params;
  const apiKey = readUploadToken(token);
  if (!apiKey) {
    return json(401, {
      error: "This upload link is invalid or has expired. Call create_upload_url again for a new one.",
    });
  }

  const data = await req.arrayBuffer();
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
    const status = typeof (err as { status?: unknown }).status === "number" ? (err as { status: number }).status : 502;
    logError({ event: "upload", keyHash: keyHash(apiKey), bytes: data.byteLength, status: "error" }, err);
    return json(status === 401 ? 401 : status >= 500 ? 502 : status, {
      error: status === 401 ? "AssemblyAI rejected the API key (401)." : (err as Error).message,
    });
  }
}

export { handle as POST, handle as PUT };
