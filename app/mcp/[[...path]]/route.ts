import { createMcpHandler, withMcpAuth } from "mcp-handler";

import { registerTools } from "../../../src/server";

// Explicit endpoint paths so clients connect at /mcp directly.
// mcp-handler matches req.url pathname exactly — see the docs MCP's
// /docs route for the same pattern.
const handler = createMcpHandler(
  (server) => {
    registerTools(server);
  },
  {},
  {
    streamableHttpEndpoint: "/mcp",
    sseEndpoint: "/mcp/sse",
    sseMessageEndpoint: "/mcp/message",
    maxDuration: 60,
  }
);

async function verifyToken(_req: Request, bearer?: string) {
  if (!bearer || bearer.trim().length === 0) return undefined;
  // We do NOT validate the key ourselves — AssemblyAI's 401 surfaces a bad
  // key directly to the agent. Returning an AuthInfo object means "Bearer is
  // present, let the tool call the upstream API and let AssemblyAI decide."
  return {
    token: bearer.trim(),
    scopes: [],
    clientId: "databricks",
  };
}

const authed = withMcpAuth(handler, verifyToken, { required: true });

export { authed as GET, authed as POST, authed as DELETE };
