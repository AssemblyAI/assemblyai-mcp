// Public proof of control for the existing Glama connector listing.
// This exact route takes precedence over the authenticated MCP catch-all.
export function GET() {
  return Response.json({
    $schema: "https://glama.ai/mcp/schemas/connector.json",
    claim: "glama_claim_fiZtw0WYRl14xXIF71bWkUDCEeDEYojh",
  });
}
