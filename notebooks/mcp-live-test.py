# Databricks notebook source
# MAGIC %md
# MAGIC # AssemblyAI MCP server — scripted connection test (no Playground)
# MAGIC
# MAGIC AI Playground is interactive; this notebook drives the same MCP server
# MAGIC **programmatically** with raw JSON-RPC, so the connection test is
# MAGIC repeatable (run it after every server change, or schedule it as a job).
# MAGIC
# MAGIC It exercises: `initialize` → `tools/list` → `submit_transcript` (with
# MAGIC feature flags) → `get_transcript` polling → `summarize_transcript` →
# MAGIC `understand_transcript` (post-hoc Speech Understanding via the LLM
# MAGIC Gateway) → `delete_transcript` (cleans up the transcript it created), and
# MAGIC asserts the response contract (including `speech_model_used`).
# MAGIC
# MAGIC **Two ways to point it at the server** (pick via widgets below):
# MAGIC
# MAGIC 1. **Through Databricks (recommended)** — set `MCP_URL` to the
# MAGIC    Unity AI Gateway endpoint for the registered MCP service:
# MAGIC    `https://<workspace-host>/ai-gateway/mcp-services/<catalog>.<schema>.<service>`
# MAGIC    with `AUTH_MODE = workspace`. Databricks authenticates you with your
# MAGIC    workspace identity and injects the connection's AssemblyAI credential —
# MAGIC    the exact path AI Playground uses. See
# MAGIC    https://docs.databricks.com/aws/en/ai-gateway/register-mcp-service
# MAGIC    if the connection isn't registered as an MCP service yet.
# MAGIC
# MAGIC 2. **Direct to the server** — set `MCP_URL` to the server's public URL
# MAGIC    (e.g. `https://<host>/mcp`) with `AUTH_MODE = secret`. The AssemblyAI
# MAGIC    API key is read from a Databricks secret (same `assemblyai` scope as
# MAGIC    the other notebooks) and sent as the Bearer token. This bypasses the
# MAGIC    UC connection, so use it to isolate server problems from connection
# MAGIC    problems.

# COMMAND ----------

dbutils.widgets.text("MCP_URL", "", "MCP endpoint URL")
dbutils.widgets.dropdown("AUTH_MODE", "workspace", ["workspace", "secret"], "Auth mode")
dbutils.widgets.text("SECRET_SCOPE", "assemblyai", "Secret scope (secret mode)")
dbutils.widgets.text("SECRET_KEY", "api_key", "Secret key (secret mode)")

MCP_URL = dbutils.widgets.get("MCP_URL").strip()
AUTH_MODE = dbutils.widgets.get("AUTH_MODE")

assert MCP_URL, "Set the MCP_URL widget (gateway URL or the server's public /mcp URL)."

if AUTH_MODE == "workspace":
    ctx = dbutils.notebook.entry_point.getDbutils().notebook().getContext()
    token = ctx.apiToken().get()
else:
    token = dbutils.secrets.get(dbutils.widgets.get("SECRET_SCOPE"), dbutils.widgets.get("SECRET_KEY"))

print(f"Target: {MCP_URL} (auth: {AUTH_MODE})")

# COMMAND ----------

# MAGIC %md
# MAGIC ## JSON-RPC helper
# MAGIC
# MAGIC Streamable HTTP servers may answer with plain JSON or with a one-event
# MAGIC SSE body (`data: {...}`); this helper handles both, and threads the
# MAGIC `Mcp-Session-Id` header once the server assigns one.

# COMMAND ----------

import json
import time

import requests

session_id = None
_rpc_id = 0


def rpc(method, params=None):
    global session_id, _rpc_id
    _rpc_id += 1
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json, text/event-stream",
        "Content-Type": "application/json",
    }
    if session_id:
        headers["Mcp-Session-Id"] = session_id
    resp = requests.post(
        MCP_URL,
        headers=headers,
        json={"jsonrpc": "2.0", "id": _rpc_id, "method": method, "params": params or {}},
        timeout=60,
    )
    resp.raise_for_status()
    if resp.headers.get("Mcp-Session-Id"):
        session_id = resp.headers["Mcp-Session-Id"]

    body = resp.text
    if "text/event-stream" in resp.headers.get("Content-Type", ""):
        payloads = [line[len("data:"):].strip() for line in body.splitlines() if line.startswith("data:")]
        body = payloads[-1] if payloads else "{}"
    parsed = json.loads(body) if body.strip() else {}
    if "error" in parsed:
        raise RuntimeError(f"MCP error from {method}: {parsed['error']}")
    return parsed.get("result", {})


def call_tool(name, arguments):
    result = rpc("tools/call", {"name": name, "arguments": arguments})
    text = "\n".join(c.get("text", "") for c in result.get("content", []))
    return result.get("structuredContent") or {}, text, result

# COMMAND ----------

# MAGIC %md
# MAGIC ## Run the scenario

# COMMAND ----------

checks = []


def check(name, condition, detail=""):
    checks.append((name, bool(condition), detail))
    print(("✓ " if condition else "✗ ") + name + (f" — {detail}" if detail and not condition else ""))


init = rpc(
    "initialize",
    {
        "protocolVersion": "2025-03-26",
        "capabilities": {},
        "clientInfo": {"name": "databricks-notebook-live-test", "version": "0.1.0"},
    },
)
check("initialize succeeds", "serverInfo" in init, json.dumps(init)[:200])

tools = rpc("tools/list")
tool_names = sorted(t["name"] for t in tools.get("tools", []))
check(
    "tools/list exposes the 5 tools",
    tool_names
    == ["delete_transcript", "get_transcript", "submit_transcript", "summarize_transcript", "understand_transcript"],
    ", ".join(tool_names),
)

# Submit with feature flags on — exercises the speech_models pin, diarization
# and sentiment in one transcription.
submitted, _, _ = call_tool(
    "submit_transcript",
    {"audio_url": "https://assembly.ai/wildfires.mp3", "speaker_labels": True, "sentiment_analysis": True},
)
transcript_id = submitted.get("transcript_id")
check("submit_transcript returns transcript_id", bool(transcript_id), json.dumps(submitted))

# Everything from here through the last check runs in a try/finally so the
# transcript is torn down even if a check/call above raises mid-run — a
# mid-run failure used to skip the delete_transcript call entirely.
try:
    deadline = time.time() + 300
    structured, text = {}, ""
    while time.time() < deadline:
        structured, text, _ = call_tool("get_transcript", {"transcript_id": transcript_id})
        if structured.get("status") in ("completed", "error"):
            break
        time.sleep(3)

    check("transcription completes", structured.get("status") == "completed", str(structured.get("status")))
    check(
        "speech_model_used=universal-3-5-pro",
        structured.get("speech_model_used") == "universal-3-5-pro",
        str(structured.get("speech_model_used")),
    )
    # Section headers carry parentheticals ("--- utterances (per-speaker ...) ---"),
    # so match on the label prefix only.
    check("utterances section present", "--- utterances" in text)
    check("sentiment section present", "--- sentiment" in text)

    summary_struct, summary_text, summary_raw = call_tool(
        "summarize_transcript", {"transcript_id": transcript_id, "style": "bullets"}
    )
    check(
        "summarize_transcript returns a summary",
        not summary_raw.get("isError") and len(summary_text.strip()) > 0,
        summary_text[:200],
    )

    understood_struct, understood_text, understood_raw = call_tool(
        "understand_transcript",
        {"transcript_id": transcript_id, "speech_understanding": {"request": {"action_items": {}}}},
    )
    check(
        "understand_transcript returns action_items",
        not understood_raw.get("isError") and "--- action_items ---" in understood_text,
        understood_text[:200],
    )
finally:
    if transcript_id:
        deleted_struct, _, deleted_raw = call_tool("delete_transcript", {"transcript_id": transcript_id})
        check(
            "delete_transcript cleans up the test transcript",
            not deleted_raw.get("isError") and deleted_struct.get("deleted") is True,
            json.dumps(deleted_struct),
        )

# COMMAND ----------

# MAGIC %md
# MAGIC ## Result

# COMMAND ----------

failed = [name for name, ok, _ in checks if not ok]
print(f"\n{len(checks) - len(failed)}/{len(checks)} checks passed")
if failed:
    raise Exception(f"FAILED: {failed}")
print("All checks passed — connection and tool contract are healthy.")
