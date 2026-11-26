# AssemblyAI MCP Server

A remote [MCP](https://modelcontextprotocol.io) server for the
[AssemblyAI](https://www.assemblyai.com) API. It gives any MCP-capable agent
five tools covering async speech-to-text, Speech Understanding (translation,
speaker identification, custom formatting, chaptered summarization, action
items), and Guardrails (PII redaction, content moderation, profanity
filtering) — served over **Streamable HTTP** and authenticated per-request,
either by **signing in with AssemblyAI** (OAuth) or with the caller's own
AssemblyAI API key.

Works with any MCP client that supports MCP authorization (Claude Code,
Claude.ai, Cursor, MCP Inspector, and others) or can send a Bearer header.
Built with Next.js 16 + `mcp-handler` + the official
`@modelcontextprotocol/sdk`; deploys as a Vercel serverless function.

## Quickstart

AssemblyAI hosts it at **`https://mcp.assemblyai.com/mcp`**. It's listed in the
official [MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers?search=com.assemblyai/mcp)
as `com.assemblyai/mcp`. Setup for Claude, Cursor, VS Code and other clients:
[assemblyai.com/docs/mcp-server](https://www.assemblyai.com/docs/mcp-server).

**Sign in with AssemblyAI:** add the server's `/mcp` endpoint with no
headers. The client opens AssemblyAI's sign-in and consent page, and the
server uses an API key it gets for that connection; nothing to copy or
paste. (This works against AssemblyAI's hosted deployment; a self-hosted
copy uses API keys, see [Auth](#auth).)

```bash
claude mcp add --transport http assemblyai https://mcp.assemblyai.com/mcp
```

**With an API key:** point your MCP client at the `/mcp` endpoint with your
AssemblyAI API key as the Bearer token.

**Claude Code**

```bash
claude mcp add --transport http assemblyai https://mcp.assemblyai.com/mcp \
  --header "Authorization: Bearer $ASSEMBLYAI_API_KEY"
```

**Generic remote-MCP client config**

```json
{
  "mcpServers": {
    "assemblyai": {
      "url": "https://mcp.assemblyai.com/mcp",
      "headers": { "Authorization": "Bearer <ASSEMBLYAI_API_KEY>" }
    }
  }
}
```

Running your own copy? `npm install && npm run dev` serves it at
`http://localhost:3000/mcp` (see [Local dev](#local-dev)).

Then prompt the agent, e.g. *"transcribe this audio file and summarize it:
https://assembly.ai/wildfires.mp3"*.

## Tools

| Tool | Purpose |
|---|---|
| `submit_transcript(audio_url \| file, ...)` | Start an async transcription of a public audio/video URL (`audio_url`). In ChatGPT only, a file the user attached can go in `file` instead (ChatGPT fills it in through `_meta["openai/fileParams"]`; other clients ignore it). Returns `{ transcript_id, status }` immediately. |
| `get_transcript(transcript_id, include_words?)` | Fetch the current state; full results once `status` is `completed`. Agents poll this ~every 3s. Per-word timestamps only with `include_words: true`. |
| `understand_transcript(transcript_id, speech_understanding)` | Run Speech Understanding on an already-completed transcript — translation, speaker identification, custom formatting, chaptered summarization, action items — without re-submitting the audio (LLM Gateway `/v1/understanding`). |
| `summarize_transcript(transcript_id, style?, custom_prompt?)` | Freeform or custom-prompt summary of a completed transcript via the LLM Gateway. `style`: `bullets` (default), `paragraph`, `headline`, `action_items`, or `custom`. |
| `delete_transcript(transcript_id)` | Permanently delete a transcript and its data. Irreversible — only on explicit user request. |
| `create_upload_url()` | For a local file: returns a 10-minute link and a `curl` command. The agent uploads the file (up to 4.5 MB) and gets an `upload_url` to pass to `submit_transcript`. Only offered when `UPLOAD_TOKEN_SECRET` is set. |
| `create_speech(text, voice_id?, language?, format?, delivery?)` | Text to speech (Streaming TTS). `delivery: "file"` (default) returns a `curl` command with a 5-minute TTS-only token; the agent runs it and the audio is saved on the user's computer (up to 5,000 characters, billed when it runs). `delivery: "inline"` returns MP3 audio in the tool result (up to 1,000 characters). Billed per character. Only offered when `TTS_ENABLED=1`. |

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
  `["assemblyai-stt-3-7", "universal-2"]` priority list; `universal-3-5-pro` is
  deprecated but still accepted), `temperature`
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
some MCP clients surface only that to the model:
`--- text ---` and `--- utterances ---` always; sentiment, entities,
translations (whole-transcript and per-utterance), speaker identification,
custom formatting, chaptered summary, action items, content safety, topics,
highlights, unredacted text, the redacted-audio URL, and processing
warnings when requested/present. Raw fields are mirrored in
`structuredContent`.

## Auth

Every request carries a Bearer token, which is one of two things.

**An OAuth access token (Sign in with AssemblyAI).** A request with no token
gets a 401 whose `WWW-Authenticate` names
`/.well-known/oauth-protected-resource`, which names AssemblyAI's
authorization server. The client registers itself there, signs the member in
through the consent page (scope `aai:api`), and sends the access token it
gets back. AssemblyAI's API takes API keys, not access tokens, so
`src/oauth.ts` exchanges the token for the API key of the member's
connection to that client (`POST /api/v2/oauth/api-key`) before the request
reaches `withMcpAuth`, and the request continues with that key. The exchange
also proves which server is asking: the deployment's Vercel OIDC token goes
in `X-AAI-Service-Token`, and AssemblyAI only accepts its own production
deployment of this project, so a self-hosted copy can't exchange tokens and
uses API keys instead. Keys are cached per access token for at most five
minutes, so a connection revoked from the dashboard stops working within
minutes. A refused token answers 401 (403 for a missing scope) and sends the
client back to sign-in; an outage answers 503, which doesn't.

**An AssemblyAI API key (pass-through).** MCP clients send the API key as
`Authorization: Bearer <key>` (most client configs prepend `Bearer `
automatically). AssemblyAI's REST API expects the raw key, so `withMcpAuth`
extracts the token, strips the prefix, and threads it into every tool
callback via `extra.authInfo.token`. No keys are written to disk or shared
between requests — each request runs on the key it arrived with.

### Configuration

Every setting defaults to AssemblyAI's production endpoints, so a production
deployment needs none. A deployment that signs in against another
AssemblyAI environment sets all four together, since that environment's
keys only work against its own API.

| Variable | Default | What it is |
| --- | --- | --- |
| `ASSEMBLYAI_OAUTH_ISSUER` | `https://auth.assemblyai.com` | The authorization server advertised in the protected resource metadata |
| `ASSEMBLYAI_OAUTH_EXCHANGE_ORIGIN` | `https://www.assemblyai.com` | Where access tokens are exchanged for API keys |
| `ASSEMBLYAI_BASE_URL` | `https://api.assemblyai.com` | The AssemblyAI API |
| `ASSEMBLYAI_LLM_GATEWAY_BASE_URL` | `https://llm-gateway.assemblyai.com` | The LLM Gateway |
| `UPLOAD_TOKEN_SECRET` | unset | 32+ random characters. Encrypts the API key inside upload links; without it, `create_upload_url` is not offered. Rotating it invalidates open links. |
| `PUBLIC_HOSTS` | unset | Comma-separated hostnames (no scheme) this deployment may put in the links it hands out, for a self-hosted domain. `mcp.assemblyai.com`, local hosts and the deployment's own Vercel hostnames are always allowed. A request for any other host gets `https://mcp.assemblyai.com` in its links. |
| `TTS_ENABLED` | unset | `1` offers the `create_speech` tool (text to speech). Any other value, or unset: the tool is not listed. |
| `ASSEMBLYAI_TTS_BASE_URL` | `https://tts.us.assemblyai.com` | The Streaming TTS API (`https://tts.eu.assemblyai.com` for the EU data zone) |
| `ASSEMBLYAI_TOKEN_BASE_URL` | `https://token.us.assemblyai.com` | Where `create_speech` mints its short-lived TTS tokens |

The service token needs no setting: Vercel provides it to the deployment
(`VERCEL_OIDC_TOKEN`), and `@vercel/oidc` reads it.

## Extending the tool surface (additive-only contract)

MCP clients discover tools at runtime (`list_tools`); client configs store
only URL + auth, not a tool-schema snapshot. So new tools and new
**optional** parameters appear automatically — no client reconfiguration,
and for platforms with a connection-test step, **no re-test**. To keep that
guarantee, all changes here are additive:

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
   One exception: per-word timestamps (`speakers[].words`) were never part
   of the declared shape and made up ~85% of every response, so they now
   come back only with `include_words: true`.
5. **Avoid deprecated AssemblyAI transcript params** (`auto_chapters`,
   `summarization`, `summary_model`, `summary_type`); use LLM Gateway instead.
   Mirror AssemblyAI's official MCP tool shapes where they exist.

## Local dev

Requires Node 24.x.

```bash
npm install
npm test                # in-process smoke + OAuth exchange tests (no network)
npm run dev             # next dev on http://localhost:3000
```

MCP endpoint: `http://localhost:3000/mcp`. OAuth protected resource
metadata: `http://localhost:3000/.well-known/oauth-protected-resource`.
Sign-in needs a deployment AssemblyAI accepts (see [Auth](#auth)); locally,
use an API key.

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

### Sign-in test against a deployment

```bash
MCP_URL=https://<deployment>/mcp VERCEL_PROTECTION_BYPASS=<secret> npm run test:oauth
```

Signs in the way an MCP client does, discovering everything from the
deployment: the 401 challenge, the protected resource metadata, the
authorization server's metadata, client registration, then PKCE through the
consent page in your browser (click Allow). Then it lists tools and makes one
tool call with the access token, and checks a tampered token is refused.
`VERCEL_PROTECTION_BYPASS` is the deployment's Protection Bypass for
Automation secret, for preview deployments behind Vercel Authentication.
No API key needed and no transcription credit spent.

It registers as a public client, as Claude Code does: Stytch only lets a
client with a secret (as claude.ai's connectors register) use an `https`
redirect, so this test can't sign in as one. It also requires the redirect
to carry an `iss` naming the advertised authorization server (RFC 9207), as
stricter clients do.

## Feature map

One row per feature. A PR names the rows it changes (see `.github/pull_request_template.md`). Update this table in the same PR when a row's files, tests or flag change.

| Feature | Entry point | Code | Tests | Flag |
|---|---|---|---|---|
| Submit a transcript | `submit_transcript` | `src/tools/submit-transcript.ts`, `src/assemblyai.ts` | `smoke-test.ts` | |
| Read a transcript | `get_transcript` | `src/tools/get-transcript.ts`, `src/transcript-sections.ts` | `smoke-test.ts` | |
| Summarize | `summarize_transcript` | `src/tools/summarize-transcript.ts`, `src/llm-gateway.ts` | `smoke-test.ts` | |
| Speech Understanding | `understand_transcript` | `src/tools/understand-transcript.ts`, `src/llm-gateway.ts`, `src/speech-understanding-schema.ts` | `smoke-test.ts` | |
| Delete a transcript | `delete_transcript` | `src/tools/delete-transcript.ts` | `smoke-test.ts` | |
| Local file upload | `create_upload_url`, `POST /upload/<token>` | `src/tools/create-upload-url.ts`, `src/upload-token.ts`, `app/upload/[token]/route.ts` | `smoke-test.ts` | `UPLOAD_TOKEN_SECRET` |
| Text to speech | `create_speech` | `src/tools/create-speech.ts`, `src/tts.ts` | `tts-test.ts` | `TTS_ENABLED=1` |
| MCP endpoint | `/mcp`, `/mcp/sse`, `/mcp/message` | `app/mcp/[[...path]]/route.ts`, `src/server.ts`, `src/json-body.ts`, `src/deadline.ts` | `smoke-test.ts`, `mcp-route-test.ts`, `oauth-test.ts` (CORS and browser retry guidance) | `REDIS_URL` or `KV_URL` (SSE only) |
| Claude plugin bundle | `plugins/assemblyai/` | `.claude-plugin/plugin.json`, `.mcp.json`, `skills/assemblyai-workflows/SKILL.md` within the plugin folder | `claude plugin validate --strict --profile directory plugins/assemblyai` | |
| OpenAI domain verification | `GET /.well-known/openai-apps-challenge` | `public/.well-known/openai-apps-challenge` | Unauthenticated HTTP check: 200 and exact portal token | |
| Square submission logo | `GET /assemblyai-logo-square.png` | `public/assemblyai-logo-square.png` | Unauthenticated HTTP check: 200, PNG, 2048 × 2048, exact source bytes | |
| Upstream error body limits | AssemblyAI, OAuth and TTS response bodies | `src/assemblyai.ts`, `src/oauth.ts`, `src/tts.ts` | `error-cap-test.ts` | |
| Auth: API key and OAuth sign-in | `Authorization` header, `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp` | `src/oauth.ts`, `src/tool-errors.ts`, `app/.well-known/oauth-protected-resource/route.ts`, `app/.well-known/oauth-protected-resource/mcp/route.ts` | `oauth-test.ts`, `npm run test:oauth` | |
| Input safety | all transcript tools | `src/transcript-id.ts`, `src/origin.ts` | `smoke-test.ts` | `PUBLIC_HOSTS` |
| Logging | all tools | `src/log.ts` | `smoke-test.ts` | |
| Tool behavior annotations | `tools/list` | `src/tools/*.ts` | `smoke-test.ts` (explicit boolean hints and deletion classification) | |
| API request deadline and retry | every AssemblyAI and LLM Gateway call | `src/assemblyai.ts`, `src/deadline.ts` | `request-timeout-test.ts`, `retry-test.ts`, `error-cap-test.ts` | |
| Batch amplification guard | every tool call in one `/mcp` request | `src/assemblyai.ts`, `app/mcp/[[...path]]/route.ts` | `batch-key-test.ts` | |
| End-to-end | real API | | `npm run test:live` | `ASSEMBLYAI_API_KEY` |

Within a JSON-RPC batch, sibling calls share the first upstream status for their API key. A known 401 is reused immediately. A pending probe delays siblings for at most 250 ms, and less when their request budget is nearly spent. If authentication takes longer, siblings proceed independently, so slow 401 responses can still produce multiple outbound calls. Response bodies and retries never hold up siblings after the first status arrives.

Use `https://mcp.assemblyai.com/assemblyai-logo-square.png` for directory submission icon fields. This is the approved 2048 × 2048 square PNG, served without authentication.

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
at `https://<host>/mcp` and uses streamable HTTP only. The legacy HTTP+SSE
transport (`/mcp/sse`, `/mcp/message`) is turned off, so the server needs no
Redis.

## Reference: prior Python implementation

The Python `FastMCP`-based implementation that preceded this TypeScript
port is preserved in the **first commit** of this repo
(`git log --reverse --oneline | head -1`). It serves as the source of
truth for the design (auth bridge, error handling, response shapes); this
TypeScript port carries the design forward onto a serverless-friendly
platform.
