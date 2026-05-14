from __future__ import annotations

import asyncio
import os
from typing import Any

import httpx

from .auth import get_current_api_key

ASSEMBLYAI_BASE_URL = os.environ.get("ASSEMBLYAI_BASE_URL", "https://api.assemblyai.com")
POLL_INTERVAL_S = float(os.environ.get("TRANSCRIBE_POLL_INTERVAL_S", "3"))
POLL_TIMEOUT_S = float(os.environ.get("TRANSCRIBE_POLL_TIMEOUT_S", "300"))


class AssemblyAIError(RuntimeError):
    def __init__(self, status: int, message: str, transcript_id: str | None = None):
        super().__init__(message)
        self.status = status
        self.transcript_id = transcript_id


class TranscribeTimeoutError(AssemblyAIError):
    pass


class AssemblyAIClient:
    def __init__(self, api_key: str, base_url: str = ASSEMBLYAI_BASE_URL):
        self._client = httpx.AsyncClient(
            base_url=base_url,
            headers={"Authorization": api_key},
            timeout=httpx.Timeout(30.0, connect=10.0),
        )

    @classmethod
    def from_request_context(cls) -> AssemblyAIClient:
        return cls(api_key=get_current_api_key())

    async def __aenter__(self) -> AssemblyAIClient:
        return self

    async def __aexit__(self, *exc_info) -> None:
        await self._client.aclose()

    async def submit(self, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._request_with_retry("POST", "/v2/transcript", json=payload)

    async def get(self, transcript_id: str) -> dict[str, Any]:
        return await self._request_with_retry("GET", f"/v2/transcript/{transcript_id}")

    async def poll_until_done(
        self,
        transcript_id: str,
        *,
        interval_s: float = POLL_INTERVAL_S,
        timeout_s: float = POLL_TIMEOUT_S,
    ) -> dict[str, Any]:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout_s
        while True:
            data = await self.get(transcript_id)
            status = data.get("status")
            if status == "completed":
                return data
            if status == "error":
                raise AssemblyAIError(
                    status=502,
                    message=data.get("error", "AssemblyAI returned status=error"),
                    transcript_id=transcript_id,
                )
            if loop.time() >= deadline:
                raise TranscribeTimeoutError(
                    status=408,
                    message=(
                        f"Transcript {transcript_id} did not finish within "
                        f"{timeout_s:.0f}s (last status={status}). "
                        "Call get_transcript with this ID to retrieve it later."
                    ),
                    transcript_id=transcript_id,
                )
            await asyncio.sleep(interval_s)

    async def _request_with_retry(
        self,
        method: str,
        path: str,
        *,
        json: dict[str, Any] | None = None,
        retries: int = 3,
    ) -> dict[str, Any]:
        last_exc: Exception | None = None
        for attempt in range(retries):
            try:
                response = await self._client.request(method, path, json=json)
            except httpx.HTTPError as exc:
                last_exc = exc
                await asyncio.sleep(2**attempt)
                continue

            if response.status_code >= 500:
                last_exc = AssemblyAIError(
                    status=response.status_code,
                    message=_safe_error_message(response),
                )
                await asyncio.sleep(2**attempt)
                continue

            if response.status_code >= 400:
                raise AssemblyAIError(
                    status=response.status_code,
                    message=_safe_error_message(response),
                )

            return response.json()

        if isinstance(last_exc, AssemblyAIError):
            raise last_exc
        raise AssemblyAIError(
            status=502,
            message=f"AssemblyAI request failed after {retries} retries: {last_exc!r}",
        )


def _safe_error_message(response: httpx.Response) -> str:
    try:
        body = response.json()
    except ValueError:
        return f"HTTP {response.status_code}: {response.text[:500]}"
    if isinstance(body, dict):
        for key in ("error", "message", "detail"):
            if key in body and body[key]:
                return f"HTTP {response.status_code}: {body[key]}"
    return f"HTTP {response.status_code}: {body!r}"
