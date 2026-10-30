import { AssemblyAIError, uploadFile } from "../../../src/assemblyai";
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
    logError({ event: "upload", keyHash: keyHash(apiKey), bytes: data.byteLength, status: "error" }, err);
    return uploadError(err);
  }
}

// AssemblyAI's 4xx passes through; network failures and its 5xx become 502.
function uploadError(err: unknown): Response {
  const status = err instanceof AssemblyAIError ? err.status : 502;
  if (status === 401) return json(401, { error: "AssemblyAI rejected the API key (401)." });
  if (status >= 500) return json(502, { error: "AssemblyAI upload failed. Try again shortly." });
  return json(status, { error: (err as Error).message });
}

export { handle as POST, handle as PUT };
