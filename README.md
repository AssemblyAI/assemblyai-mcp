# AssemblyAI MCP Server (Databricks connection-test MVP)

A minimal MCP server that wraps AssemblyAI's transcription API and exposes it
to Databricks via the Marketplace MCP integration. The server speaks
**Streamable HTTP** (the only transport Databricks supports for external MCP
servers) and does **pass-through Bearer auth** — each Databricks user pastes
their own AssemblyAI API key as the Bearer token in the HTTP connection. The
server stores no AssemblyAI credentials.

## Tools

- **`transcribe(audio_url, speaker_labels=False, summarization=False)`** —
  submits the URL to AssemblyAI and blocks until the transcript is finished or
  times out (5 min). Returns the transcript text plus optional speakers /
  summary.
- **`get_transcript(transcript_id)`** — re-fetches a previously submitted
  transcript. Useful when `transcribe` times out on a long file.

## Quickstart (local)

Requires Python 3.11+ and [uv](https://docs.astral.sh/uv/).

```bash
uv sync
uv run python -m assemblyai_mcp
```

The MCP endpoint is available at `http://localhost:8000/mcp`.

### Smoke test with curl

```bash
curl -i -X POST http://localhost:8000/mcp \
  -H "Authorization: Bearer YOUR_ASSEMBLYAI_API_KEY" \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
```

You should see a `mcp-session-id` response header and a JSON-RPC result. Calling
the same endpoint without an `Authorization: Bearer …` header should return
`401`.

### Smoke test with MCP Inspector

```bash
npx @modelcontextprotocol/inspector
```

Connect to `http://localhost:8000/mcp` with transport `Streamable HTTP`, and
under *Authentication* paste your AssemblyAI API key as the Bearer token.

## Connecting from Databricks

Prereqs (consumer side, per Databricks docs):

- Workspace on Premium plan or above with Unity Catalog enabled.
- `CREATE CONNECTION` on the metastore to create the connection.
- `USE CONNECTION` on the connection at runtime.

### 1. Expose the local server

For testing, tunnel localhost so Databricks can reach it over HTTPS:

```bash
ngrok http 8000
```

Use the `https://…ngrok-free.app` URL Databricks-side.

### 2. Create the HTTP connection

In the Databricks workspace UI:

1. Catalog → Connections → **Create connection**.
2. Connection type: **HTTP**.
3. Connection name: e.g. `assemblyai_mcp_test`.
4. Host / Base URL: `https://<your-ngrok-host>` (no trailing `/mcp`).
5. Authentication type: **Bearer token**. Paste your AssemblyAI API key — this
   is the value the server will pass straight through to AssemblyAI.
6. Check **Is mcp connection**.
7. Click **Test connection** → expect green. Click **Create**.

### 3. Use it in AI Playground

1. Open AI Playground.
2. Pick a model that supports tools.
3. Tools → **+ Add tool** → **MCP Servers** → External → select
   `assemblyai_mcp_test` → Add.
4. Prompt:

   > transcribe this audio file: https://storage.googleapis.com/aai-web-samples/news.mp4

5. The model should call `transcribe`; the response should include the
   transcript text.

## Auth model — why this works for Databricks

Databricks supports five HTTP-connection auth types and always prepends
`Bearer ` to the token configured for the *Bearer token* type. AssemblyAI's
REST API expects `Authorization: <api-key>` *without* the `Bearer ` prefix.
This server bridges the gap:

1. Inbound request: `Authorization: Bearer <api-key>` from Databricks.
2. `BearerToContextMiddleware` strips the prefix and stashes the raw key in a
   per-request `ContextVar`.
3. `AssemblyAIClient.from_request_context()` reads the ContextVar and sets
   `Authorization: <api-key>` on the outbound httpx client.

No keys are written to disk or shared between requests.

## Project layout

```
src/assemblyai_mcp/
├── __init__.py
├── __main__.py        # uvicorn entry
├── server.py          # FastMCP + Starlette app + lifespan
├── auth.py            # Bearer → ContextVar middleware
├── assemblyai.py      # httpx client: submit / poll / get
└── tools.py           # @mcp.tool definitions
```

## Configuration

Environment variables (see `.env.example`):

| Var | Default | Notes |
|---|---|---|
| `HOST` | `0.0.0.0` | uvicorn bind host |
| `PORT` | `8000` | uvicorn bind port |
| `LOG_LEVEL` | `info` | uvicorn log level |
| `TRANSCRIBE_POLL_INTERVAL_S` | `3` | seconds between poll attempts |
| `TRANSCRIBE_POLL_TIMEOUT_S` | `300` | hard cap before `transcribe` errors out |
| `ASSEMBLYAI_BASE_URL` | `https://api.assemblyai.com` | override for testing |

## Out of scope (Phase 1)

This MVP is sized for the Databricks connection test only. Deliberately
deferred: file upload (`/v2/upload`), audio-intelligence beyond
diarization/summarization (sentiment, entities, content moderation,
translation, LeMUR), streaming, OAuth M2M, production hosting, observability,
Marketplace listing assets.
