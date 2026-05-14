from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.responses import JSONResponse
from starlette.routing import Route

from assemblyai_mcp.auth import BearerToContextMiddleware, current_api_key


async def _echo(_request) -> JSONResponse:
    return JSONResponse({"key": current_api_key.get()})


def _build_app() -> Starlette:
    return Starlette(
        routes=[Route("/", _echo, methods=["POST"])],
        middleware=[Middleware(BearerToContextMiddleware)],
    )


async def _post(headers: dict[str, str]) -> tuple[int, dict]:
    transport = ASGITransport(app=_build_app())
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post("/", headers=headers)
    return response.status_code, response.json()


async def test_valid_bearer_sets_context_var():
    status, body = await _post({"Authorization": "Bearer my-secret-key"})
    assert status == 200
    assert body == {"key": "my-secret-key"}


async def test_bearer_prefix_is_case_insensitive():
    status, body = await _post({"Authorization": "bearer lowercase-key"})
    assert status == 200
    assert body == {"key": "lowercase-key"}


async def test_missing_authorization_returns_401():
    status, body = await _post({})
    assert status == 401
    assert body["error"] == "unauthorized"
    assert "Missing Authorization header" in body["detail"]


async def test_non_bearer_scheme_returns_401():
    status, body = await _post({"Authorization": "Basic dXNlcjpwYXNz"})
    assert status == 401
    assert "Bearer" in body["detail"]


async def test_empty_bearer_returns_401():
    status, body = await _post({"Authorization": "Bearer "})
    assert status == 401
    assert "Bearer" in body["detail"]


async def test_context_var_isolated_across_requests():
    # Issue two requests with different keys and make sure they don't bleed.
    s1, b1 = await _post({"Authorization": "Bearer key-1"})
    s2, b2 = await _post({"Authorization": "Bearer key-2"})
    assert (s1, b1["key"]) == (200, "key-1")
    assert (s2, b2["key"]) == (200, "key-2")

    # And outside any request, the contextvar must be unset.
    with pytest.raises(LookupError):
        current_api_key.get()
