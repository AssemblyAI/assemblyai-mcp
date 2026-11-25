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

export { authed as GET, authed as POST, authed as DELETE };
