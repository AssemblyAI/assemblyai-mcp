/**
 * The MCP SDK's own body limit. Bodies over it get 413 there; we must refuse
 * them before we buffer them, so this check can't be used to allocate more.
 */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

function rpcError(status: number, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", error: { code, message }, id: null }, { status });
}

const tooLarge = () =>
  rpcError(413, -32000, `Payload Too Large: Request body must not exceed ${MAX_BODY_BYTES} bytes`);

/**
 * Read at most MAX_BODY_BYTES of the body. Returns undefined, and stops
 * reading, as soon as the body is larger: Content-Length can be missing or
 * wrong (chunked uploads), so count the bytes as they arrive.
 */
async function readCapped(req: Request): Promise<string | undefined> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return undefined;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      // Don't await: on a clone (a tee), cancel only settles once the other
      // branch is cancelled too, and that branch is never read.
      reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * mcp-handler reads a JSON POST body with `req.json()` outside its own
 * try/catch. A body that is not valid JSON then rejects with no response, and
 * the request hangs until the platform timeout. Check the body first: 413 when
 * it is too large (before parsing it), else the JSON-RPC parse error (-32700)
 * the MCP transport would send.
 */
export function withJsonBodyCheck(
  handler: (req: Request) => Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req) => {
    const contentType = req.headers.get("content-type") ?? "";
    if (req.method === "POST" && contentType.includes("application/json")) {
      const text = await readCapped(req.clone());
      if (text === undefined) return tooLarge();
      try {
        JSON.parse(text);
      } catch {
        return rpcError(400, -32700, "Parse error: the request body is not valid JSON.");
      }
    }
    return handler(req);
  };
}
