# Databricks notebook source
# MAGIC %md
# MAGIC # AssemblyAI on Databricks — transcribe a UC Volume file (no S3 required)
# MAGIC
# MAGIC The AssemblyAI MCP tools (`submit_transcript`, `get_transcript`) take an
# MAGIC `audio_url`. Databricks customers typically have audio in private Unity
# MAGIC Catalog Volumes. This notebook bridges the gap **without needing an S3
# MAGIC bucket** by using AssemblyAI's native upload endpoint:
# MAGIC
# MAGIC ```
# MAGIC UC Volume bytes
# MAGIC   → POST /v2/upload (AssemblyAI) → { upload_url }
# MAGIC   → submit_transcript(audio_url=upload_url) → { transcript_id }
# MAGIC   → get_transcript(transcript_id) → { status, text, ... }
# MAGIC ```
# MAGIC
# MAGIC The `upload_url` is **scoped to the API key that uploaded it** — only
# MAGIC that AssemblyAI account can transcribe it. The audio is never publicly
# MAGIC exposed.
# MAGIC
# MAGIC **Prerequisites**
# MAGIC 1. Premium workspace with Unity Catalog enabled.
# MAGIC 2. The `assemblyai_mcp_test` HTTP connection already set up (with your AssemblyAI API key as the Bearer token).
# MAGIC 3. A Databricks Secret Scope with the same AssemblyAI API key, so notebook code can call `/v2/upload` directly:
# MAGIC
# MAGIC ```bash
# MAGIC databricks secrets create-scope assemblyai
# MAGIC databricks secrets put-secret assemblyai api_key
# MAGIC ```

# COMMAND ----------

# MAGIC %md
# MAGIC ## 1. Configure paths

# COMMAND ----------

AUDIO_VOLUME_PATH = "/Volumes/main/audio_data/recordings/sample.mp3"
SECRET_SCOPE = "assemblyai"
SECRET_KEY = "api_key"

import os

assert os.path.exists(AUDIO_VOLUME_PATH), f"Audio file not found at {AUDIO_VOLUME_PATH}"
audio_size_mb = os.path.getsize(AUDIO_VOLUME_PATH) / (1024 * 1024)
print(f"Audio file: {AUDIO_VOLUME_PATH} ({audio_size_mb:.1f} MB)")

api_key = dbutils.secrets.get(scope=SECRET_SCOPE, key=SECRET_KEY)  # noqa: F821
assert api_key, f"Empty AssemblyAI API key from secret scope {SECRET_SCOPE}/{SECRET_KEY}"

# COMMAND ----------

# MAGIC %md
# MAGIC ## 2. Stream the file to AssemblyAI's upload endpoint
# MAGIC
# MAGIC `POST /v2/upload` accepts the raw bytes (no multipart, no base64). We
# MAGIC stream the file handle to keep memory flat for large recordings.
# MAGIC The endpoint returns `{ "upload_url": "https://cdn.assemblyai.com/upload/..." }`.

# COMMAND ----------

import requests

ASSEMBLYAI_BASE = "https://api.assemblyai.com"

with open(AUDIO_VOLUME_PATH, "rb") as f:
    upload_response = requests.post(
        f"{ASSEMBLYAI_BASE}/v2/upload",
        headers={
            # AssemblyAI uses the raw key — no `Bearer ` prefix on the REST API.
            "Authorization": api_key,
            "Content-Type": "application/octet-stream",
        },
        data=f,
        timeout=600,
    )
upload_response.raise_for_status()
upload_url = upload_response.json()["upload_url"]
print(f"Upload URL (private to your AssemblyAI account): {upload_url[:80]}…")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 3a. Use the upload URL via the MCP tools (recommended)
# MAGIC
# MAGIC Open **AI Playground** (or any Mosaic AI agent that has the
# MAGIC `assemblyai_mcp_test` connection attached as a tool), and prompt:
# MAGIC
# MAGIC ```
# MAGIC Transcribe this audio with speaker diarization: <PASTE upload_url>
# MAGIC Submit it, poll get_transcript until status=completed, then show me
# MAGIC the transcript and speaker timestamps.
# MAGIC ```
# MAGIC
# MAGIC The agent will call `submit_transcript` and `get_transcript` exactly
# MAGIC the way the connection-test validated.

# COMMAND ----------

# MAGIC %md
# MAGIC ## 3b. Or transcribe programmatically (no MCP, useful for batch jobs)
# MAGIC
# MAGIC For pipelines that run unattended, you can hit AssemblyAI's REST API
# MAGIC directly with the same key. Same two-step pattern the MCP tools wrap.

# COMMAND ----------

import time

submit_response = requests.post(
    f"{ASSEMBLYAI_BASE}/v2/transcript",
    headers={"Authorization": api_key, "Content-Type": "application/json"},
    json={
        "audio_url": upload_url,
        "speech_models": ["universal-3-pro", "universal-2"],
        "speaker_labels": True,
    },
    timeout=30,
)
submit_response.raise_for_status()
transcript_id = submit_response.json()["id"]
print(f"Submitted transcript_id={transcript_id}")

# Poll until completed or error. Cap at 10 minutes — adjust for your audio length.
POLL_INTERVAL_S = 3
POLL_TIMEOUT_S = 600
deadline = time.time() + POLL_TIMEOUT_S
while True:
    poll = requests.get(
        f"{ASSEMBLYAI_BASE}/v2/transcript/{transcript_id}",
        headers={"Authorization": api_key},
        timeout=30,
    )
    poll.raise_for_status()
    body = poll.json()
    status = body["status"]
    if status == "completed":
        print(f"Done in {body.get('audio_duration', '?')}s of audio")
        break
    if status == "error":
        raise RuntimeError(f"AssemblyAI reported error: {body.get('error')}")
    if time.time() >= deadline:
        raise TimeoutError(f"Transcript {transcript_id} did not finish within {POLL_TIMEOUT_S}s")
    print(f"  status={status}, polling again in {POLL_INTERVAL_S}s")
    time.sleep(POLL_INTERVAL_S)

transcript_text = body["text"]
utterances = body.get("utterances") or []
print(f"\nTranscript ({len(transcript_text)} chars):\n{transcript_text[:400]}…")
if utterances:
    print(f"\n{len(utterances)} speaker utterances")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 4. (Optional) Persist the transcript to a Delta table

# COMMAND ----------

from datetime import datetime, timezone
from pyspark.sql import Row

TARGET_TABLE = "main.audio_data.transcripts"

row = Row(
    source_path=AUDIO_VOLUME_PATH,
    transcript_id=transcript_id,
    transcript_text=transcript_text,
    audio_duration_seconds=body.get("audio_duration"),
    speaker_count=len({u["speaker"] for u in utterances}) if utterances else None,
    transcribed_at_utc=datetime.now(timezone.utc),
)
spark.createDataFrame([row]).write.mode("append").saveAsTable(TARGET_TABLE)  # noqa: F821
print(f"Wrote 1 row to {TARGET_TABLE}")
