from contextvars import ContextVar

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

current_api_key: ContextVar[str] = ContextVar("current_api_key")


class MissingAPIKeyError(RuntimeError):
    pass


def get_current_api_key() -> str:
    try:
        return current_api_key.get()
    except LookupError as e:
        raise MissingAPIKeyError(
            "No AssemblyAI API key in request context. "
            "This tool must be called over an authenticated MCP request."
        ) from e


class BearerToContextMiddleware:
    """Extract `Authorization: Bearer <key>` and stash the raw key in a ContextVar.

    Databricks always prepends `Bearer ` to the token configured in the HTTP
    connection. AssemblyAI's REST API expects the bare key in `Authorization`,
    so we strip the prefix here and let `assemblyai.AssemblyAIClient` use it.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        request = Request(scope, receive)
        header = request.headers.get("authorization")
        if not header:
            await _unauthorized(scope, receive, send, "Missing Authorization header.")
            return

        prefix, _, token = header.partition(" ")
        if prefix.lower() != "bearer" or not token.strip():
            await _unauthorized(
                scope,
                receive,
                send,
                "Authorization header must be `Bearer <AssemblyAI API key>`.",
            )
            return

        reset = current_api_key.set(token.strip())
        try:
            await self.app(scope, receive, send)
        finally:
            current_api_key.reset(reset)


async def _unauthorized(scope: Scope, receive: Receive, send: Send, detail: str) -> None:
    response = JSONResponse(
        {
            "error": "unauthorized",
            "detail": detail,
            "hint": (
                "Configure your AssemblyAI API key as the Bearer token in the "
                "Databricks HTTP connection that targets this MCP server."
            ),
        },
        status_code=401,
    )
    await response(scope, receive, send)
