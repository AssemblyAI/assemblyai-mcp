/** The MCP SDK's own body limit: it answers 413 above this. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

function rpcError(status: number, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", error: { code, message }, id: null }, { status });
}

const tooLarge = () =>
  rpcError(413, -32000, `Payload Too Large: Request body must not exceed ${MAX_BODY_BYTES} bytes`);

/**
 * Nesting past this is refused before the body ever reaches the MCP SDK.
 * Every shape this server's tools accept — including submit_transcript's
 * speech_understanding object — nests well under 20 levels; 64 leaves room
 * to spare without going anywhere near the depth that causes problems below.
 */
export const MAX_JSON_DEPTH = 64;

const tooDeep = () =>
  rpcError(400, -32700, `Parse error: the request body is nested more than ${MAX_JSON_DEPTH} levels deep.`);

/**
 * Whether `text`'s object/array nesting ever goes past `limit`, scanned as
 * raw characters rather than parsed. `JSON.parse` itself accepts arbitrarily
 * deep input (Node's parser isn't recursive), but the MCP SDK's own message
 * validation is: a small, well-formed body nested ~100,000 levels deep makes
 * it throw an uncaught RangeError (stack overflow) partway through, and the
 * request never gets a response. A linear scan can't itself recurse or
 * overflow. It stops at the first bracket past `limit`, but text before that
 * bracket is still read, so the worst case is one pass over the whole body,
 * which the 4 MB body cap bounds. Characters inside a JSON string don't
 * count, so ordinary text containing "[[[" isn't affected.
 */
function exceedsJsonDepth(text: string, limit: number): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{" || c === "[") {
      depth++;
      if (depth > limit) return true;
    } else if (c === "}" || c === "]") {
      depth--;
    }
  }
  return false;
}

/**
 * Reads a request body, stopping as soon as it's bigger than MAX_BODY_BYTES.
 * Returns the raw bytes: the body only needs UTF-8 decoding when it's
 * actually going to be parsed as JSON, which the caller decides.
 */
async function readCappedBytes(req: Request): Promise<Buffer | undefined> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return undefined;
  if (!req.body) return Buffer.alloc(0);
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
  return Buffer.concat(chunks);
}

/**
 * mcp-handler calls req.json() outside its try/catch, so invalid JSON hangs
 * the request until the platform timeout.
 *
 * The size cap below applies to every POST body, whatever Content-Type it
 * declares. mcp-handler itself enforces no cap of its own: a body declared
 * as, say, text/plain used to skip this check entirely and be read in full
 * by the handler, so an unbounded POST could grow server memory with no
 * valid credentials at all.
 */
export function withJsonBodyCheck(
  handler: (req: Request) => Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method !== "POST") return handler(req);
    const bytes = await readCappedBytes(req.clone());
    if (bytes === undefined) return tooLarge();
    const contentType = req.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      // req.json(), which mcp-handler reads the body with, ignores one leading UTF-8 BOM.
      const text = bytes.toString("utf8").replace(/^\uFEFF/, "");
      if (exceedsJsonDepth(text, MAX_JSON_DEPTH)) return tooDeep();
      try {
        JSON.parse(text);
      } catch {
        return rpcError(400, -32700, "Parse error: the request body is not valid JSON.");
      }
    }
    return handler(req);
  };
}
