/**
 * mcp-handler reads a JSON POST body with `req.json()` outside its own
 * try/catch. A body that is not valid JSON then rejects with no response, and
 * the request hangs until the platform timeout. Check the body first and answer
 * with the JSON-RPC parse error (-32700) the MCP transport would send.
 */
export function withJsonBodyCheck(
  handler: (req: Request) => Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req) => {
    const contentType = req.headers.get("content-type") ?? "";
    if (req.method === "POST" && contentType.includes("application/json")) {
      const text = await req.clone().text();
      try {
        JSON.parse(text);
      } catch {
        return Response.json(
          {
            jsonrpc: "2.0",
            error: { code: -32700, message: "Parse error: the request body is not valid JSON." },
            id: null,
          },
          { status: 400 },
        );
      }
    }
    return handler(req);
  };
}
