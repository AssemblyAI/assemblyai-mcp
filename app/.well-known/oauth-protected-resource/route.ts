import { oauthIssuer, OAUTH_SCOPES } from "../../../src/oauth";

/** https://datatracker.ietf.org/doc/html/rfc9728 */
export function GET(req: Request) {
  const url = new URL(req.url);
  const resource = `${url.protocol}//${url.host}/mcp`;
  return Response.json(
    {
      resource,
      authorization_servers: [oauthIssuer()],
      scopes_supported: OAUTH_SCOPES,
      bearer_methods_supported: ["header"],
      resource_documentation: "https://www.assemblyai.com/docs/mcp-server",
    },
    {
      headers: { "Cache-Control": "public, max-age=3600" },
    }
  );
}
