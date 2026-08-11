# AssemblyAI Databricks MCP Server

A minimal MCP server that wraps the AssemblyAI transcription API for the
Databricks Marketplace. Built with Next.js 16 + `mcp-handler` + the official
`@modelcontextprotocol/sdk`, deployed (eventually) as a Vercel serverless
function. Mirrors the structure of AssemblyAI's docs MCP server for
operational alignment.

## Tools

- **`submit_transcript(audio_url, ...)`** — submits a public URL to
  AssemblyAI and returns `{ transcript_id, status }` immediately. Accepts
  the full public async transcription param surface: speaker diarization,
  sentiment analysis (English only), entity detection, PII redaction,
  prompting (`prompt`, `keyterms_prompt`), language options (`language_code`,
  `language_codes`, `language_detection`, `language_detection_options`),
  guardrails (`filter_profanity`, `speech_threshold`, `content_safety`,
  `redact_pii_audio`, `redact_static_entities`, ...), diarization options
  (`speaker_options`), inline Speech Understanding (`speech_understanding`,
  for translation/speaker ID/formatting/summarization/action items run
  during transcription), and webhooks (`webhook_url`, ...). See
  AssemblyAI's [submit-transcript endpoint
  docs](https://www.assemblyai.com/docs/api-reference/transcripts/submit)
  for the full parameter reference.
- **`get_transcript(transcript_id)`** — single fetch of the current state. The
  agent polls this (~every 3s) until `status` is `completed` or `error`. When
  enabled, the response text includes `--- sentiment ---` and `--- entities ---`
  sections alongside `--- text ---` and `--- utterances ---`, plus any
  Speech Understanding / guardrail sections requested at submit time.
- **`summarize_transcript(transcript_id, style?, custom_prompt?)`** — generates a
  summary of a completed transcript via AssemblyAI's LLM Gateway. Call after
  `get_transcript` shows `completed`. `style` is one of `bullets` (default),
  `paragraph`, `headline`, `action_items`, or `custom` (with `custom_prompt`).
- **`understand_transcript(transcript_id, speech_understanding)`** — runs
  Speech Understanding features on an already-completed transcript,
  post-hoc, without re-submitting the audio: translation, speaker
  identification, custom formatting, chaptered summarization, and action
  items, via AssemblyAI's LLM Gateway `/v1/understanding` endpoint. Prefer
  passing `speech_understanding` to `submit_transcript` instead when the
  need is known before transcription.
- **`delete_transcript(transcript_id)`** — permanently and irreversibly
  deletes a transcript and its associated data from AssemblyAI. Only call
  when the user explicitly asks for deletion.

## Auth: pass-through Bearer

Databricks always prepends `Bearer ` to the token configured in the HTTP
connection. AssemblyAI's REST API expects the raw key (no `Bearer ` prefix).
`withMcpAuth` extracts the token, strips the prefix, and threads it into
every tool callback via `extra.authInfo.token`. The tool calls AssemblyAI
with `Authorization: <key>` (no prefix). No keys are written to disk or
shared between requests.

## Extending the tool surface (additive-only contract)

Databricks discovers MCP tools at runtime (`list_tools`); the Unity Catalog
connection stores only URL + auth, not a tool-schema snapshot. So new tools and
new **optional** parameters appear automatically and need **no connection
re-test**. To keep that guarantee, all changes here are additive:

1. **Tool names are permanent** — only add tools, never rename or remove.
2. **New inputs are always optional**, with defaults that preserve current behavior.
3. **`get_transcript` text output only *gains* labeled sections** — existing
   sections (`--- text ---`, `--- utterances ---`, `--- sentiment ---`,
   `--- entities ---`) are never renamed or reshaped, because Databricks AI
   Playground reads `content[].text`. (A legacy `--- summary ---` section is
   still rendered if present, but summaries now come from the
   `summarize_transcript` tool, not `get_transcript`.) The same protection
   covers the newer sections added for Speech Understanding and guardrails:
   `--- translation:<lang> ---`, `--- speaker_identification ---`,
   `--- custom_formatting ---`, `--- su_summary ---`, `--- action_items ---`,
   `--- content_safety ---`, `--- topics ---`, `--- highlights ---`,
   `--- unredacted_text ---`, `--- redacted_audio ---`, and `--- warnings ---`.
4. **`structuredContent` is additive only** — new fields, never removed/renamed.
5. **Avoid deprecated AssemblyAI transcript params** (`auto_chapters`,
   `summarization`, `summary_model`, `summary_type`); use LLM Gateway instead.
   Mirror AssemblyAI's official MCP tool shapes where they exist.

## Local dev

Requires Node 24.x.

```bash
npm install
npm test                # in-process smoke (no network, mocked AssemblyAI)
npm run dev             # next dev on http://localhost:3000
```

MCP endpoint: `http://localhost:3000/mcp`. OAuth metadata stub:
`http://localhost:3000/.well-known/oauth-protected-resource`.

### Smoke test with MCP Inspector

```bash
npx @modelcontextprotocol/inspector
```

Connect to `http://localhost:3000/mcp` via Streamable HTTP, paste your
AssemblyAI key as the Bearer token. Call `submit_transcript` with a public
mp3 URL, then `get_transcript` with the returned id until completed.

### Smoke test with curl

```bash
# No auth — expect 401
curl -i -X POST http://localhost:3000/mcp \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'

# With your AssemblyAI key as the Bearer token — expect 200 + Mcp-Session-Id
curl -i -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer $ASSEMBLYAI_API_KEY" \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
```

### Live end-to-end test (real AssemblyAI, real transcription)

```bash
ASSEMBLYAI_API_KEY=... npm run test:live                       # against localhost:3001
ASSEMBLYAI_API_KEY=... MCP_URL=https://<host>/mcp npm run test:live
```

Drives the running server with the MCP SDK client over Streamable HTTP:
tool discovery, all `submit_transcript` feature flags, `speech_model_used`
assertion, `summarize_transcript`, inline Speech Understanding (translation +
chaptered summary) and guardrails (content safety) submitted alongside the
other scenarios, post-hoc Speech Understanding via `understand_transcript`,
graceful failure on a bad audio URL, and teardown via `delete_transcript` for
the transcripts it successfully creates (the deliberate bad-URL scenario is
excluded). Costs a few cents of transcription credit per run.

For the same test **through Databricks** (workspace auth + UC connection
credential injection — the path AI Playground uses), run
`notebooks/mcp-live-test.py` as a notebook or scheduled job.

## Connecting from Databricks

Same flow as the Python version, with `/mcp` as the base path:

1. Tunnel: `ngrok http 3000` → grab the `https://…ngrok-free.dev` URL.
2. Databricks workspace UI → Catalog → Connections → **Create connection**.
3. Connection type: **HTTP**, name `assemblyai_mcp_test`.
4. Host: ngrok hostname (no scheme, no path). Port: `443`. Base path: `/mcp`.
5. Authentication type: **Bearer token**. Paste your AssemblyAI API key.
6. Check **Is mcp connection** → **Test connection** → **Create**.
7. AI Playground → add MCP tool → prompt `transcribe this audio file: <url>`.

## Sample notebooks

Two Databricks notebooks ship in `notebooks/` to demonstrate transcribing audio
that lives in a Unity Catalog Volume (not on a public URL):

| Notebook | Bridge to a usable `audio_url` | When to use |
|---|---|---|
| **`transcribe-uc-volume-direct-upload.py`** (default) | Streams bytes to AssemblyAI's `POST /v2/upload`, returns a private `upload_url` scoped to your AssemblyAI account. | Default for most users. No S3 bucket required, no presigning, works for any file size AssemblyAI accepts. |
| `transcribe-uc-volume.py` | Copies bytes from UC Volume to an S3 bucket you own, generates a short-lived presigned URL. | Compliance / data-residency cases where audio must stay in your own cloud account until AssemblyAI fetches it. |

Both notebooks then hand the resulting URL to the MCP tools (`submit_transcript`
→ `get_transcript`) the same way AI Playground does.

## Project layout

```
mcp-server/
├── app/
│   ├── mcp/[transport]/route.ts             # mcp-handler entry, wrapped with withMcpAuth
│   └── .well-known/oauth-protected-resource/route.ts
├── src/
│   ├── server.ts                            # registerTools factory
│   ├── log.ts                               # JSON logging helpers + key hashing
│   ├── assemblyai.ts                        # fetch wrapper (submit, get, retry)
│   ├── llm-gateway.ts                       # LLM Gateway client (summarize, understand)
│   ├── transcript-sections.ts               # get_transcript section renderers
│   ├── speech-understanding-schema.ts       # shared speech_understanding zod schema
│   ├── tools/
│   │   ├── submit-transcript.ts
│   │   ├── get-transcript.ts
│   │   ├── summarize-transcript.ts
│   │   ├── understand-transcript.ts
│   │   └── delete-transcript.ts
│   ├── smoke-test.ts                        # InMemoryTransport, mocked fetch
│   └── live-test.ts                         # real API, Streamable HTTP client
├── package.json
├── tsconfig.json
├── next.config.js
├── vercel.json
└── README.md
```

## Logging

Same JSON-to-stdout pattern as AssemblyAI's docs MCP. Every tool emits one
event with `event`, `tool`, `keyHash`, `latencyMs`, `status`. High-signal
events worth alerting on: `bad_audio_url`, `assemblyai_rejected_key`,
`tool_error`. Never logs the raw API key — only `sha256(key).slice(0,12)`.

## Deployment

Target is Vercel (`vercel deploy` once the project is linked). Vercel
Firewall provides rate limiting and DDoS protection. The MCP endpoint will
live at `https://<host>/mcp` with `maxDuration: 60` per the handler config.

Long-term hosting target, custom domain, and Marketplace listing assets are
out of scope here — this repo's goal is the connection-test MVP plus the
async tool redesign.

## Reference: prior Python implementation

The Python `FastMCP`-based implementation that passed the original
Databricks connection test is preserved in the **first commit** of this
repo (`git log --reverse --oneline | head -1`). It serves as the source of
truth for the design (auth bridge, error handling, response shapes); this
TypeScript port carries the design forward onto a serverless-friendly
platform.
