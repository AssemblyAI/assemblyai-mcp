/** The MCP SDK's own body limit: it answers 413 above this. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

function rpcError(status: number, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", error: { code, message }, id: null }, { status });
}

const tooLarge = () =>
  rpcError(413, -32000, `Payload Too Large: Request body must not exceed ${MAX_BODY_BYTES} bytes`);

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
      // Don't await: cancel on a tee branch settles only once the other branch is cancelled too.
      reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** mcp-handler calls req.json() outside its try/catch, so invalid JSON hangs the request until the platform timeout. */
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
