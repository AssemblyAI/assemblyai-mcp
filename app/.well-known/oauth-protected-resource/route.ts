import { OAUTH_ISSUER, OAUTH_SCOPES } from "../../../src/oauth";

/**
 * OAuth Protected Resource metadata. `withMcpAuth`'s 401 response advertises
 * this path, and MCP clients follow it to AssemblyAI's authorization server to
 * sign the member in. A Bearer can be either the access token that sign-in
 * returns (exchanged for an API key, see `src/oauth.ts`) or an AssemblyAI API
 * key pasted into the client's config.
 *
 * Spec: https://datatracker.ietf.org/doc/html/rfc9728
 */
export function GET(req: Request) {
  const url = new URL(req.url);
  const resource = `${url.protocol}//${url.host}/mcp`;
  return Response.json(
    {
      resource,
      authorization_servers: [OAUTH_ISSUER],
      scopes_supported: OAUTH_SCOPES,
      bearer_methods_supported: ["header"],
      resource_documentation: "https://www.assemblyai.com/docs/api-reference/overview",
    },
    {
      headers: { "Cache-Control": "public, max-age=3600" },
    }
  );
}
