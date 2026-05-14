from __future__ import annotations

import os

import uvicorn


def main() -> None:
    uvicorn.run(
        "assemblyai_mcp.server:app",
        host=os.environ.get("HOST", "0.0.0.0"),
        port=int(os.environ.get("PORT", "8000")),
        log_level=os.environ.get("LOG_LEVEL", "info"),
    )


if __name__ == "__main__":
    main()
