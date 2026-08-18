# AssemblyAI MCP Server

A remote [MCP](https://modelcontextprotocol.io) server for the
[AssemblyAI](https://www.assemblyai.com) API. It gives any MCP-capable agent
five tools covering async speech-to-text, Speech Understanding (translation,
speaker identification, custom formatting, chaptered summarization, action
items), and Guardrails (PII redaction, content moderation, profanity
filtering) — served over **Streamable HTTP** and authenticated per-request
with the caller's own AssemblyAI API key.

Works with any MCP client that can send a Bearer header: Claude Code,
Claude.ai, Cursor, MCP Inspector, Databricks AI Playground, and others.
Built with Next.js 16 + `mcp-handler` + the official
`@modelcontextprotocol/sdk`; deploys as a Vercel serverless function.

## Quickstart

Point your MCP client at the server's `/mcp` endpoint with your AssemblyAI
API key as the Bearer token.

**Claude Code**

```bash
claude mcp add --transport http assemblyai https://<host>/mcp \
  --header "Authorization: Bearer $ASSEMBLYAI_API_KEY"
```

**Generic remote-MCP client config**

```json
{
  "mcpServers": {
    "assemblyai": {
      "url": "https://<host>/mcp",
      "headers": { "Authorization": "Bearer <ASSEMBLYAI_API_KEY>" }
    }
  }
}
```

No hosted instance handy? `npm install && npm run dev` serves it at
`http://localhost:3000/mcp` (see [Local dev](#local-dev)).

Then prompt the agent, e.g. *"transcribe this audio file and summarize it:
https://assembly.ai/wildfires.mp3"*.

## Tools

| Tool | Purpose |
|---|---|
| `submit_transcript(audio_url, ...)` | Start an async transcription of a public audio/video URL. Returns `{ transcript_id, status }` immediately. |
| `get_transcript(transcript_id)` | Fetch the current state; full results once `status` is `completed`. Agents poll this ~every 3s. |
| `understand_transcript(transcript_id, speech_understanding)` | Run Speech Understanding on an already-completed transcript — translation, speaker identification, custom formatting, chaptered summarization, action items — without re-submitting the audio (LLM Gateway `/v1/understanding`). |
| `summarize_transcript(transcript_id, style?, custom_prompt?)` | Freeform or custom-prompt summary of a completed transcript via the LLM Gateway. `style`: `bullets` (default), `paragraph`, `headline`, `action_items`, or `custom`. |
| `delete_transcript(transcript_id)` | Permanently delete a transcript and its data. Irreversible — only on explicit user request. |

**Typical agent flow:** `submit_transcript` → poll `get_transcript` until
`completed` → optionally `understand_transcript` / `summarize_transcript` →
`delete_transcript` when the user asks for cleanup. When the need is known
up front, request Speech Understanding features inline at submit time
instead of post-hoc.

### `submit_transcript` parameter surface

Accepts the full public async transcription param surface with API-native
names, grouped roughly as:

- **Prompting** — `prompt` (a contextual *description* of the audio, not
  instructions), `keyterms_prompt`
- **Language** — `language_code`, `language_codes`, `language_detection`,
  `language_detection_options`, `language_confidence_threshold`
- **Models** — `speech_models` (defaults to the pinned
  `["universal-3-5-pro", "universal-2"]` priority list), `temperature`
- **Diarization** — `speaker_labels`, `speaker_options`
- **Guardrails** — `redact_pii` (+ `redact_pii_policies`, `redact_pii_sub`,
  `redact_pii_audio`, `redact_pii_return_unredacted`,
  `redact_static_entities`), `filter_profanity`, `content_safety`
  (+ `content_safety_confidence`), `speech_threshold`
- **Speech Understanding, inline** — `speech_understanding.request.{translation,
  speaker_identification, custom_formatting, summarization, action_items}`,
  run during transcription
- **Other** — `sentiment_analysis` (English only), `entity_detection`,
  `iab_categories`, `auto_highlights`, `multichannel`, `disfluencies`,
  `custom_spelling`, `punctuate`, `format_text`, `audio_start_from`,
  `audio_end_at`, `domain` (`medical-v1` for Medical Mode), and
  `remove_audio_tags`, plus webhooks (`webhook_url`,
  `webhook_auth_header_name`/`_value`)

Omitted params are never sent — AssemblyAI's own defaults apply. See the
[submit endpoint docs](https://www.assemblyai.com/docs/api-reference/transcripts/submit)
for parameter semantics.

### `get_transcript` output

Everything renders into `content[].text` as labeled sections, because
text-only MCP clients (e.g. Databricks AI Playground) read only that:
`--- text ---` and `--- utterances ---` always; sentiment, entities,
translations (whole-transcript and per-utterance), speaker identification,
custom formatting, chaptered summary, action items, content safety, topics,
highlights, unredacted text, the redacted-audio URL, and processing
warnings when requested/present. Raw fields are mirrored in
`structuredContent`.

## Auth: pass-through Bearer

MCP clients send the API key as `Authorization: Bearer <key>` (most client
configs and platforms — including Databricks HTTP connections — prepend
`Bearer ` automatically). AssemblyAI's REST API expects the raw key, so
`withMcpAuth` extracts the token, strips the prefix, and threads it into
every tool callback via `extra.authInfo.token`. No keys are written to disk
or shared between requests — each request runs on the key it arrived with.

## Extending the tool surface (additive-only contract)

MCP clients discover tools at runtime (`list_tools`); client configs store
only URL + auth, not a tool-schema snapshot. So new tools and new
**optional** parameters appear automatically — no client reconfiguration,
and for platforms with a connection-test step (e.g. a Databricks Unity
Catalog connection) **no re-test**. To keep that guarantee, all changes
here are additive:

1. **Tool names are permanent** — only add tools, never rename or remove.
2. **New inputs are always optional**, with defaults that preserve current behavior.
3. **`get_transcript` text output only *gains* labeled sections** — existing
   sections (`--- text ---`, `--- utterances ---`, `--- sentiment ---`,
   `--- entities ---`) are never renamed or reshaped, because text-only MCP
   clients read `content[].text`. (A legacy `--- summary ---` section is
   still rendered if present, but summaries now come from the
   `summarize_transcript` tool, not `get_transcript`.) The same protection
   covers the newer sections added for Speech Understanding and guardrails:
   `--- translation:<lang> ---`, `--- translated_utterances ---`,
   `--- speaker_identification ---`, `--- custom_formatting ---`,
   `--- su_summary ---`, `--- action_items ---`, `--- content_safety ---`,
   `--- topics ---`, `--- highlights ---`, `--- unredacted_text ---`,
   `--- redacted_audio ---`, and `--- warnings ---`.
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
chaptered summary), guardrails (content safety), post-hoc Speech
Understanding via `understand_transcript`, graceful failure on a bad audio
URL, and teardown via `delete_transcript`. Every transcript id is recorded
as soon as `submit_transcript` returns it and deleted from a `finally`
block, so the suite tears down every transcript it successfully creates
even when the run fails midway. Costs a few cents of transcription credit
per run.

## Databricks

The server registers as a Unity Catalog HTTP connection and is used from AI
Playground or agents:

1. Tunnel (for local testing): `ngrok http 3000` → grab the
   `https://…ngrok-free.dev` URL.
2. Databricks workspace UI → Catalog → Connections → **Create connection**.
3. Connection type: **HTTP**, name `assemblyai_mcp`.
4. Host: hostname (no scheme, no path). Port: `443`. Base path: `/mcp`.
5. Authentication type: **Bearer token**. Paste your AssemblyAI API key.
6. Check **Is mcp connection** → **Test connection** → **Create**.
7. AI Playground → add MCP tool → prompt `transcribe this audio file: <url>`.

For the live e2e test **through Databricks** (workspace auth + UC connection
credential injection — the path AI Playground uses), run
`notebooks/mcp-live-test.py` as a notebook or scheduled job.

### Sample notebooks (audio in Unity Catalog Volumes)

Two Databricks notebooks in `notebooks/` demonstrate transcribing audio that
lives in a Unity Catalog Volume (not on a public URL):

| Notebook | Bridge to a usable `audio_url` | When to use |
|---|---|---|
| **`transcribe-uc-volume-direct-upload.py`** (default) | Streams bytes to AssemblyAI's `POST /v2/upload`, returns a private `upload_url` scoped to your AssemblyAI account. | Default for most users. No S3 bucket required, no presigning, works for any file size AssemblyAI accepts. |
| `transcribe-uc-volume.py` | Copies bytes from UC Volume to an S3 bucket you own, generates a short-lived presigned URL. | Compliance / data-residency cases where audio must stay in your own cloud account until AssemblyAI fetches it. |

Both notebooks then hand the resulting URL to the MCP tools
(`submit_transcript` → `get_transcript`) the same way AI Playground does.

## Project layout

```
assemblyai-mcp/
├── app/
│   ├── mcp/[transport]/route.ts             # mcp-handler entry, wrapped with withMcpAuth
│   └── .well-known/oauth-protected-resource/route.ts
├── src/
│   ├── server.ts                            # registerTools factory
│   ├── log.ts                               # JSON logging helpers + key hashing
│   ├── tool-errors.ts                       # shared 401/404/429 error mapper
│   ├── assemblyai.ts                        # fetch wrapper (submit, get, delete, retry)
│   ├── llm-gateway.ts                       # LLM Gateway client (summarize, understand)
│   ├── transcript-sections.ts               # section renderers for tool text output
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

JSON to stdout, same pattern as AssemblyAI's docs MCP server. Every tool
emits one event with `event`, `tool`, `keyHash`, `latencyMs`, `status`.
High-signal events worth alerting on: `bad_audio_url`,
`assemblyai_rejected_key`, `tool_error`, `understanding_error`,
`delete_error`. Never logs the raw API key — only `sha256(key).slice(0,12)`
— and never logs transcript content.

## Deployment

Deploys to Vercel (`vercel deploy` once the project is linked). Vercel
Firewall provides rate limiting and DDoS protection. The MCP endpoint lives
at `https://<host>/mcp` with `maxDuration: 60` per the handler config.

## Reference: prior Python implementation

The Python `FastMCP`-based implementation that passed the original
Databricks connection test is preserved in the **first commit** of this
repo (`git log --reverse --oneline | head -1`). It serves as the source of
truth for the design (auth bridge, error handling, response shapes); this
TypeScript port carries the design forward onto a serverless-friendly
platform.
