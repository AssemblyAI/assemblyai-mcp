import { createMcpHandler, withMcpAuth } from "mcp-handler";

import { withRequestClock } from "../../../src/deadline";
import { withJsonBodyCheck } from "../../../src/json-body";
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
    // Bounds mcp-handler's SSE wait only; Vercel's limit is the project default.
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

// The clock starts before the OAuth exchange: tools get what is left of the
// 60 s budget after sign-in (see src/deadline.ts).
const authed = withRequestClock(
  withOAuthExchange(
    withMcpAuth(withJsonBodyCheck(handler), verifyToken, {
      required: true,
      resourceMetadataPath: RESOURCE_METADATA_PATH,
    })
  )
);

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, mcp-session-id, mcp-protocol-version, last-event-id",
  "Access-Control-Expose-Headers": "mcp-session-id, WWW-Authenticate",
};

export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}

async function wrapped(req: Request) {
  const res = await authed(req);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    res.headers.set(key, value);
  }
  return res;
}

export { wrapped as GET, wrapped as POST, wrapped as DELETE };
