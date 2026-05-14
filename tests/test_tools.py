from __future__ import annotations

import pytest

from assemblyai_mcp.tools import _shape_transcript, _to_tool_error, _validate_audio_url
from assemblyai_mcp.assemblyai import AssemblyAIError, TranscribeTimeoutError


def test_validate_audio_url_accepts_https():
    _validate_audio_url("https://example.com/x.mp3")
    _validate_audio_url("http://example.com/x.mp3")


@pytest.mark.parametrize(
    "bad_url",
    [
        "file:///etc/passwd",
        "ftp://example.com/x.mp3",
        "gopher://example.com",
        "not-a-url",
        "",
        "https://",
    ],
)
def test_validate_audio_url_rejects_non_http(bad_url):
    with pytest.raises(ValueError):
        _validate_audio_url(bad_url)


def test_shape_transcript_minimal():
    out = _shape_transcript({"id": "abc", "text": "hi", "audio_duration": 5}, include_status=False)
    assert out == {"transcript_id": "abc", "text": "hi", "audio_duration": 5}


def test_shape_transcript_with_status():
    out = _shape_transcript({"id": "abc", "status": "processing"}, include_status=True)
    assert out["status"] == "processing"
    assert out["transcript_id"] == "abc"


def test_shape_transcript_includes_speakers_when_utterances_present():
    raw = {
        "id": "abc",
        "text": "hi",
        "audio_duration": 5,
        "utterances": [
            {"speaker": "A", "text": "hello", "start": 0, "end": 1000},
            {"speaker": "B", "text": "hi", "start": 1100, "end": 1500},
        ],
    }
    out = _shape_transcript(raw, include_status=False)
    assert len(out["speakers"]) == 2
    assert out["speakers"][0] == {"speaker": "A", "text": "hello", "start": 0, "end": 1000}


def test_shape_transcript_includes_summary_when_present():
    out = _shape_transcript(
        {"id": "abc", "text": "hi", "audio_duration": 5, "summary": "key points"},
        include_status=False,
    )
    assert out["summary"] == "key points"


def test_to_tool_error_friendly_401_message():
    exc = AssemblyAIError(status=401, message="Unauthorized")
    out = _to_tool_error(exc)
    assert isinstance(out, RuntimeError)
    assert "AssemblyAI rejected the API key" in str(out)
    assert "Databricks HTTP connection" in str(out)


def test_to_tool_error_passes_through_other_statuses():
    exc = AssemblyAIError(status=404, message="HTTP 404: not found")
    assert "not found" in str(_to_tool_error(exc))


def test_to_tool_error_timeout_preserves_message():
    exc = TranscribeTimeoutError(status=408, message="timed out after 5s", transcript_id="abc")
    assert "timed out" in str(_to_tool_error(exc))
