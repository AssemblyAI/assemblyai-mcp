from __future__ import annotations

from typing import Any
from urllib.parse import urlparse

from mcp.server.fastmcp import FastMCP

from .assemblyai import AssemblyAIClient, AssemblyAIError

_ALLOWED_AUDIO_SCHEMES = frozenset({"http", "https"})


def _validate_audio_url(audio_url: str) -> None:
    parsed = urlparse(audio_url)
    if parsed.scheme not in _ALLOWED_AUDIO_SCHEMES or not parsed.netloc:
        raise ValueError(
            f"audio_url must be an http:// or https:// URL, got {audio_url!r}"
        )


def register_tools(mcp: FastMCP) -> None:
    @mcp.tool(
        name="transcribe",
        description=(
            "Transcribe an audio or video file from a public URL using AssemblyAI. "
            "Optionally enables speaker diarization and an auto-generated summary. "
            "Blocks until the transcript is finished or times out (5 min default)."
        ),
    )
    async def transcribe(
        audio_url: str,
        speaker_labels: bool = False,
        summarization: bool = False,
    ) -> dict[str, Any]:
        _validate_audio_url(audio_url)
        payload: dict[str, Any] = {"audio_url": audio_url}
        if speaker_labels:
            payload["speaker_labels"] = True
        if summarization:
            payload["summarization"] = True
            payload["summary_model"] = "informative"
            payload["summary_type"] = "bullets"

        async with AssemblyAIClient.from_request_context() as client:
            try:
                created = await client.submit(payload)
                transcript_id = created["id"]
                result = await client.poll_until_done(transcript_id)
            except AssemblyAIError as exc:
                raise _to_tool_error(exc) from exc

        return _shape_transcript(result, include_status=False)

    @mcp.tool(
        name="get_transcript",
        description=(
            "Fetch a previously submitted AssemblyAI transcript by ID. "
            "Use this when `transcribe` timed out, or to re-fetch an existing transcript."
        ),
    )
    async def get_transcript(transcript_id: str) -> dict[str, Any]:
        async with AssemblyAIClient.from_request_context() as client:
            try:
                result = await client.get(transcript_id)
            except AssemblyAIError as exc:
                raise _to_tool_error(exc) from exc
        return _shape_transcript(result, include_status=True)


def _shape_transcript(result: dict[str, Any], *, include_status: bool) -> dict[str, Any]:
    out: dict[str, Any] = {
        "transcript_id": result.get("id"),
        "text": result.get("text"),
        "audio_duration": result.get("audio_duration"),
    }
    if include_status:
        out["status"] = result.get("status")
    utterances = result.get("utterances")
    if utterances:
        out["speakers"] = [
            {
                "speaker": u.get("speaker"),
                "text": u.get("text"),
                "start": u.get("start"),
                "end": u.get("end"),
            }
            for u in utterances
        ]
    summary = result.get("summary")
    if summary:
        out["summary"] = summary
    return out


def _to_tool_error(exc: AssemblyAIError) -> RuntimeError:
    if exc.status == 401:
        return RuntimeError(
            "AssemblyAI rejected the API key (401). "
            "Check the Bearer token configured in the Databricks HTTP connection."
        )
    return RuntimeError(str(exc))
