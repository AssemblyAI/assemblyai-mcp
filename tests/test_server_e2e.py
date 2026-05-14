"""End-to-end MCP protocol tests against the real Starlette app.

Exercises the full request path: BearerToContextMiddleware → FastMCP session
manager → tool dispatch → AssemblyAIClient (mocked via respx). Covers the
wiring that the unit tests can't see in isolation.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator

import pytest
import respx
from asgi_lifespan import LifespanManager
from httpx import ASGITransport, AsyncClient, Response

from assemblyai_mcp.server import create_app

MCP_HEADERS = {
    "Accept": "application/json, text/event-stream",
    "Content-Type": "application/json",
}


def _parse_sse(body: str) -> list[dict]:
    """Pull `data: {...}` JSON payloads out of an SSE response body."""
    out: list[dict] = []
    for line in body.splitlines():
        if line.startswith("data: "):
            out.append(json.loads(line[6:]))
    return out


@pytest.fixture
async def mcp_client() -> AsyncIterator[AsyncClient]:
    # Fresh app per test — FastMCP's session manager is single-use.
    async with LifespanManager(create_app()) as manager:
        async with AsyncClient(
            transport=ASGITransport(app=manager.app),
            base_url="http://test",
        ) as client:
            yield client


async def _init_session(client: AsyncClient, *, bearer: str = "Bearer fake-key") -> str:
    response = await client.post(
        "/mcp",
        headers={**MCP_HEADERS, "Authorization": bearer},
        json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": {"name": "test", "version": "1"},
            },
        },
    )
    assert response.status_code == 200, response.text
    session_id = response.headers["mcp-session-id"]
    # Acknowledge initialization.
    ack = await client.post(
        "/mcp",
        headers={**MCP_HEADERS, "Authorization": bearer, "Mcp-Session-Id": session_id},
        json={"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}},
    )
    assert ack.status_code == 202
    return session_id


async def test_initialize_requires_bearer(mcp_client: AsyncClient):
    response = await mcp_client.post(
        "/mcp",
        headers=MCP_HEADERS,
        json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": {"name": "test", "version": "1"},
            },
        },
    )
    assert response.status_code == 401
    assert response.json()["error"] == "unauthorized"


async def test_tools_list_returns_transcribe_and_get_transcript(mcp_client: AsyncClient):
    session_id = await _init_session(mcp_client)
    response = await mcp_client.post(
        "/mcp",
        headers={**MCP_HEADERS, "Authorization": "Bearer k", "Mcp-Session-Id": session_id},
        json={"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
    )
    assert response.status_code == 200
    payload = _parse_sse(response.text)[0]
    names = {t["name"] for t in payload["result"]["tools"]}
    assert names == {"transcribe", "get_transcript"}


@respx.mock
async def test_transcribe_end_to_end_with_mocked_assemblyai(mcp_client: AsyncClient):
    submit = respx.post("https://api.assemblyai.com/v2/transcript").mock(
        return_value=Response(200, json={"id": "txn-1"})
    )
    poll = respx.get("https://api.assemblyai.com/v2/transcript/txn-1").mock(
        return_value=Response(
            200,
            json={
                "id": "txn-1",
                "status": "completed",
                "text": "hello world",
                "audio_duration": 7,
            },
        )
    )

    session_id = await _init_session(mcp_client, bearer="Bearer aai-key-from-databricks")
    response = await mcp_client.post(
        "/mcp",
        headers={
            **MCP_HEADERS,
            "Authorization": "Bearer aai-key-from-databricks",
            "Mcp-Session-Id": session_id,
        },
        json={
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {
                "name": "transcribe",
                "arguments": {"audio_url": "https://example.com/x.mp3"},
            },
        },
    )
    assert response.status_code == 200
    payload = _parse_sse(response.text)[0]
    result = payload["result"]
    assert result.get("isError") is not True, result
    structured = result["structuredContent"]
    assert structured["transcript_id"] == "txn-1"
    assert structured["text"] == "hello world"
    assert structured["audio_duration"] == 7

    # The Bearer prefix must have been stripped on the way to AssemblyAI.
    assert submit.calls.last.request.headers["authorization"] == "aai-key-from-databricks"
    assert poll.called


@respx.mock
async def test_transcribe_surfaces_assemblyai_401_as_friendly_error(mcp_client: AsyncClient):
    respx.post("https://api.assemblyai.com/v2/transcript").mock(
        return_value=Response(401, json={"error": "Invalid API key"})
    )

    session_id = await _init_session(mcp_client)
    response = await mcp_client.post(
        "/mcp",
        headers={**MCP_HEADERS, "Authorization": "Bearer bogus", "Mcp-Session-Id": session_id},
        json={
            "jsonrpc": "2.0",
            "id": 4,
            "method": "tools/call",
            "params": {
                "name": "transcribe",
                "arguments": {"audio_url": "https://example.com/x.mp3"},
            },
        },
    )
    payload = _parse_sse(response.text)[0]
    assert payload["result"]["isError"] is True
    text = payload["result"]["content"][0]["text"]
    assert "AssemblyAI rejected the API key" in text


async def test_transcribe_rejects_bad_url_before_calling_assemblyai(mcp_client: AsyncClient):
    session_id = await _init_session(mcp_client)
    response = await mcp_client.post(
        "/mcp",
        headers={**MCP_HEADERS, "Authorization": "Bearer k", "Mcp-Session-Id": session_id},
        json={
            "jsonrpc": "2.0",
            "id": 5,
            "method": "tools/call",
            "params": {
                "name": "transcribe",
                "arguments": {"audio_url": "file:///etc/passwd"},
            },
        },
    )
    payload = _parse_sse(response.text)[0]
    assert payload["result"]["isError"] is True
    assert "http://" in payload["result"]["content"][0]["text"]
