import { OAUTH_ISSUER, OAUTH_SCOPES } from "../../../src/oauth";

/** https://datatracker.ietf.org/doc/html/rfc9728 */
export function GET(req: Request) {
  const url = new URL(req.url);
  const resource = `${url.protocol}//${url.host}/mcp`;
  return Response.json(
    {
      resource,
      authorization_servers: [OAUTH_ISSUER],
      scopes_supported: OAUTH_SCOPES,
      bearer_methods_supported: ["header"],
      resource_documentation: "https://www.assemblyai.com/docs/mcp-server",
    },
    {
      headers: {
        "Cache-Control": "public, max-age=3600",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
      },
    }
  );
}

export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
    },
  });
}
