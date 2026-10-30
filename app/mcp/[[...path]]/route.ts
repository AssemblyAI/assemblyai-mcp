import { createMcpHandler, withMcpAuth } from "mcp-handler";

import { RESOURCE_METADATA_PATH, withOAuthExchange } from "../../../src/oauth";
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
  // By here the Bearer is an API key: either the client pasted one, or the
  // client sent an OAuth access token and `withOAuthExchange` got back an API
  // key for it and put that in the Bearer instead. We do NOT validate the key
  // ourselves — AssemblyAI's 401 surfaces a bad key directly to the agent.
  // Returning an AuthInfo object means "Bearer is present, let the tool call
  // the upstream API and let AssemblyAI decide."
  return {
    token: bearer.trim(),
    scopes: [],
    clientId: "mcp-client",
  };
}

const authed = withOAuthExchange(
  withMcpAuth(handler, verifyToken, {
    required: true,
    resourceMetadataPath: RESOURCE_METADATA_PATH,
  })
);

export { authed as GET, authed as POST, authed as DELETE };
