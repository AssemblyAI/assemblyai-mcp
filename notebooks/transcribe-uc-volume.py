# Databricks notebook source
# MAGIC %md
# MAGIC # AssemblyAI on Databricks — transcribe a file from a Unity Catalog Volume
# MAGIC
# MAGIC The AssemblyAI MCP server accepts a public `audio_url`. Databricks customers
# MAGIC typically have audio inside private UC Volumes, so this notebook shows the
# MAGIC canonical bridge: **UC Volume → short-lived presigned URL → MCP tools**.
# MAGIC
# MAGIC Once you have the presigned URL, call the MCP tools either from
# MAGIC **AI Playground** with the `assemblyai_mcp_test` connection attached, or
# MAGIC from a **Mosaic AI agent** that has the connection registered as a tool.
# MAGIC
# MAGIC Tools the agent will use:
# MAGIC - `submit_transcript(audio_url, speaker_labels?, summarization?)` → returns a `transcript_id`
# MAGIC - `get_transcript(transcript_id)` → poll until `status: completed`
# MAGIC
# MAGIC **Prerequisites**
# MAGIC - Unity Catalog enabled, Premium workspace
# MAGIC - The `assemblyai_mcp_test` HTTP connection created with your AssemblyAI API key as the Bearer token
# MAGIC - A cloud bucket you can write to and presign from (AWS S3 used here; GCS / ADLS work with their respective SDKs)
# MAGIC - The AWS SDK is available on Databricks runtimes by default

# COMMAND ----------

# MAGIC %md
# MAGIC ## 1. Configure paths

# COMMAND ----------

# Customize these for your environment.
AUDIO_VOLUME_PATH = "/Volumes/main/audio_data/recordings/sample.mp3"
STAGING_S3_BUCKET = "your-staging-bucket"
STAGING_S3_PREFIX = "assemblyai-staging/"
PRESIGN_TTL_SECONDS = 60 * 60  # 1 hour — long enough for AssemblyAI to fetch and finish

import os

assert os.path.exists(AUDIO_VOLUME_PATH), f"Audio file not found at {AUDIO_VOLUME_PATH}"
audio_size_mb = os.path.getsize(AUDIO_VOLUME_PATH) / (1024 * 1024)
print(f"Audio file: {AUDIO_VOLUME_PATH} ({audio_size_mb:.1f} MB)")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 2. Copy the file to S3 and presign a URL
# MAGIC
# MAGIC The URL is short-lived and only AssemblyAI's fetch will use it. After the
# MAGIC transcript completes you can delete the staging object.

# COMMAND ----------

import boto3
from pathlib import Path

s3 = boto3.client("s3")
object_key = f"{STAGING_S3_PREFIX}{Path(AUDIO_VOLUME_PATH).name}"

with open(AUDIO_VOLUME_PATH, "rb") as f:
    s3.put_object(Bucket=STAGING_S3_BUCKET, Key=object_key, Body=f)

audio_url = s3.generate_presigned_url(
    "get_object",
    Params={"Bucket": STAGING_S3_BUCKET, "Key": object_key},
    ExpiresIn=PRESIGN_TTL_SECONDS,
)
print(f"Presigned URL (truncated): {audio_url[:80]}…")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 3. Sanity-check the URL is reachable

# COMMAND ----------

import requests

head = requests.head(audio_url, allow_redirects=True, timeout=10)
assert head.status_code == 200, f"presigned URL not reachable: HTTP {head.status_code}"
print(f"HTTP {head.status_code}, Content-Length: {head.headers.get('content-length')} bytes")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 4. Call the MCP tools
# MAGIC
# MAGIC ### Option A — from AI Playground (interactive)
# MAGIC
# MAGIC 1. Open **AI Playground**, pick a tool-capable model.
# MAGIC 2. Tools → **+ Add tool** → **MCP Servers** → `assemblyai_mcp_test`.
# MAGIC 3. Paste this prompt (substitute the URL printed above):
# MAGIC
# MAGIC ```
# MAGIC Use the AssemblyAI tools to transcribe this audio: <PRESIGNED_URL>
# MAGIC Submit it, then poll get_transcript until status=completed, then show me the text.
# MAGIC ```
# MAGIC
# MAGIC The agent will call `submit_transcript`, then `get_transcript` in a loop, then summarize.
# MAGIC
# MAGIC ### Option B — from a Mosaic AI agent (programmatic)
# MAGIC
# MAGIC Register the `assemblyai_mcp_test` connection as a tool when creating your
# MAGIC agent. The agent's planner will chain `submit_transcript` → `get_transcript`
# MAGIC automatically given a prompt like the one above. See the
# MAGIC [Mosaic AI Agent Framework docs](https://docs.databricks.com/aws/en/generative-ai/agent-framework)
# MAGIC for the current binding syntax.

# COMMAND ----------

# MAGIC %md
# MAGIC ## 5. Persist transcripts to a Delta table (optional)
# MAGIC
# MAGIC Once your agent returns the transcript text, you'll usually want it in a
# MAGIC governed Delta table for downstream analytics, RAG, fine-tuning, etc.

# COMMAND ----------

from pyspark.sql import Row

TARGET_TABLE = "main.audio_data.transcripts"

# Replace `transcript_text` with the actual text returned by get_transcript.
sample_row = Row(
    source_path=AUDIO_VOLUME_PATH,
    transcript_id="REPLACE_ME",
    transcript_text="REPLACE_ME",
    audio_duration_seconds=None,
    transcribed_at_utc=None,
)
df = spark.createDataFrame([sample_row])
df.write.mode("append").saveAsTable(TARGET_TABLE)
print(f"Wrote 1 row to {TARGET_TABLE}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 6. Clean up the staging object
# MAGIC
# MAGIC The presigned URL is single-purpose. Delete the S3 object once AssemblyAI is done.

# COMMAND ----------

s3.delete_object(Bucket=STAGING_S3_BUCKET, Key=object_key)
print(f"Deleted s3://{STAGING_S3_BUCKET}/{object_key}")
