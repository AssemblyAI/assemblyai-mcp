import { createMcpHandler, withMcpAuth } from "mcp-handler";

import { withRequestClock } from "../../../src/deadline";
import { withJsonBodyCheck } from "../../../src/json-body";
import { RESOURCE_METADATA_PATH, withMissingCredentialsChallenge, withOAuthExchange } from "../../../src/oauth";
import { registerTools } from "../../../src/server";

// mcp-handler matches the req.url pathname exactly.
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
  return {
    token: bearer.trim(),
    scopes: [],
    clientId: "mcp-client",
  };
}

const authed = withRequestClock(
  withOAuthExchange(
    withMissingCredentialsChallenge(
      withMcpAuth(withJsonBodyCheck(handler), verifyToken, {
        required: true,
        resourceMetadataPath: RESOURCE_METADATA_PATH,
      })
    )
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
