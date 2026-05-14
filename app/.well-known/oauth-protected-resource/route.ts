/**
 * Minimal OAuth Protected Resource metadata. `withMcpAuth`'s 401 response
 * advertises this path; we return enough JSON to satisfy spec validators
 * without pretending to be an OAuth server. Our auth model is pass-through
 * Bearer where the token IS the AssemblyAI API key.
 *
 * Spec: https://datatracker.ietf.org/doc/html/rfc9728
 */
export function GET(req: Request) {
  const url = new URL(req.url);
  const resource = `${url.protocol}//${url.host}/mcp`;
  return Response.json(
    {
      resource,
      authorization_servers: [],
      bearer_methods_supported: ["header"],
      resource_documentation: "https://www.assemblyai.com/docs/api-reference/overview",
      // Pass-through model: the Bearer token must be a valid AssemblyAI API key.
      // Get one at https://www.assemblyai.com/dashboard/api-keys
    },
    {
      headers: { "Cache-Control": "public, max-age=3600" },
    }
  );
}
