from __future__ import annotations

import pytest
import respx
from httpx import Response

from assemblyai_mcp.assemblyai import (
    AssemblyAIClient,
    AssemblyAIError,
    TranscribeTimeoutError,
)
from assemblyai_mcp.auth import current_api_key


@pytest.fixture(autouse=True)
def _set_api_key():
    token = current_api_key.set("test-api-key")
    try:
        yield
    finally:
        current_api_key.reset(token)


@respx.mock
async def test_submit_sends_raw_key_no_bearer_prefix():
    route = respx.post("https://api.assemblyai.com/v2/transcript").mock(
        return_value=Response(200, json={"id": "abc"})
    )
    async with AssemblyAIClient.from_request_context() as client:
        await client.submit({"audio_url": "https://example.com/x.mp3"})

    sent = route.calls.last.request
    assert sent.headers["authorization"] == "test-api-key"
    assert "Bearer" not in sent.headers["authorization"]


@respx.mock
async def test_get_happy_path():
    respx.get("https://api.assemblyai.com/v2/transcript/abc").mock(
        return_value=Response(200, json={"id": "abc", "status": "completed", "text": "hello"})
    )
    async with AssemblyAIClient.from_request_context() as client:
        result = await client.get("abc")
    assert result["status"] == "completed"
    assert result["text"] == "hello"


@respx.mock
async def test_poll_completes_after_processing():
    route = respx.get("https://api.assemblyai.com/v2/transcript/abc")
    route.side_effect = [
        Response(200, json={"id": "abc", "status": "queued"}),
        Response(200, json={"id": "abc", "status": "processing"}),
        Response(200, json={"id": "abc", "status": "completed", "text": "done"}),
    ]
    async with AssemblyAIClient.from_request_context() as client:
        result = await client.poll_until_done("abc", interval_s=0.001, timeout_s=5)
    assert result["text"] == "done"
    assert route.call_count == 3


@respx.mock
async def test_poll_status_error_raises():
    respx.get("https://api.assemblyai.com/v2/transcript/abc").mock(
        return_value=Response(
            200, json={"id": "abc", "status": "error", "error": "bad audio file"}
        )
    )
    async with AssemblyAIClient.from_request_context() as client:
        with pytest.raises(AssemblyAIError) as exc_info:
            await client.poll_until_done("abc", interval_s=0.001, timeout_s=5)
    assert "bad audio file" in str(exc_info.value)
    assert exc_info.value.transcript_id == "abc"


@respx.mock
async def test_poll_timeout_includes_transcript_id():
    respx.get("https://api.assemblyai.com/v2/transcript/abc").mock(
        return_value=Response(200, json={"id": "abc", "status": "processing"})
    )
    async with AssemblyAIClient.from_request_context() as client:
        with pytest.raises(TranscribeTimeoutError) as exc_info:
            await client.poll_until_done("abc", interval_s=0.001, timeout_s=0.02)
    assert exc_info.value.transcript_id == "abc"
    assert "abc" in str(exc_info.value)


@respx.mock
async def test_5xx_retries_then_succeeds():
    route = respx.get("https://api.assemblyai.com/v2/transcript/abc")
    route.side_effect = [
        Response(500, text="server error"),
        Response(502, text="bad gateway"),
        Response(200, json={"id": "abc", "status": "completed"}),
    ]
    async with AssemblyAIClient.from_request_context() as client:
        result = await client.get("abc")
    assert result["status"] == "completed"
    assert route.call_count == 3


@respx.mock
async def test_4xx_does_not_retry():
    route = respx.get("https://api.assemblyai.com/v2/transcript/abc").mock(
        return_value=Response(404, json={"error": "not found"})
    )
    async with AssemblyAIClient.from_request_context() as client:
        with pytest.raises(AssemblyAIError) as exc_info:
            await client.get("abc")
    assert exc_info.value.status == 404
    assert "not found" in str(exc_info.value)
    assert route.call_count == 1


@respx.mock
async def test_error_message_extraction_from_various_shapes():
    cases = [
        ({"error": "key A"}, "key A"),
        ({"message": "key M"}, "key M"),
        ({"detail": "key D"}, "key D"),
    ]
    for body, expected in cases:
        route = respx.post("https://api.assemblyai.com/v2/transcript").mock(
            return_value=Response(400, json=body)
        )
        async with AssemblyAIClient.from_request_context() as client:
            with pytest.raises(AssemblyAIError) as exc_info:
                await client.submit({})
        assert expected in str(exc_info.value)
        route.reset()
