import { OAUTH_ISSUER, OAUTH_SCOPES } from "../../../src/oauth";
import { publicOrigin } from "../../../src/origin";

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
  const origin = publicOrigin(
    req.headers.get("x-forwarded-host"),
    req.headers.get("host") || url.host
  );
  const resource = `${origin}/mcp`;
  return Response.json(
    {
      resource,
      authorization_servers: [OAUTH_ISSUER],
      scopes_supported: OAUTH_SCOPES,
      bearer_methods_supported: ["header"],
      resource_documentation: "https://www.assemblyai.com/docs/mcp-server",
    },
    {
      headers: { "Cache-Control": "public, max-age=3600" },
    }
  );
}
