from __future__ import annotations

import contextlib

from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.routing import Mount

from .auth import BearerToContextMiddleware
from .tools import register_tools


def create_app() -> Starlette:
    """Build a fresh MCP server app.

    The MCP session manager is single-use per instance, so production runs and
    each test get their own. uvicorn imports the module-level `app` below.
    """
    # DNS-rebinding protection at the MCP layer rejects any Host other than
    # localhost by default, which breaks deployment behind a proxy/tunnel
    # (e.g. ngrok, Databricks → MCP, ECS → ALB). Auth happens in
    # BearerToContextMiddleware, so the host check is redundant here.
    mcp = FastMCP(
        "assemblyai",
        instructions=(
            "AssemblyAI tools for audio transcription. The Bearer token in your "
            "Databricks HTTP connection must be your AssemblyAI API key."
        ),
        stateless_http=False,
        json_response=False,
        transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
    )
    register_tools(mcp)

    @contextlib.asynccontextmanager
    async def lifespan(_: Starlette):
        async with mcp.session_manager.run():
            yield

    return Starlette(
        routes=[Mount("/", app=mcp.streamable_http_app())],
        middleware=[Middleware(BearerToContextMiddleware)],
        lifespan=lifespan,
    )


app = create_app()
