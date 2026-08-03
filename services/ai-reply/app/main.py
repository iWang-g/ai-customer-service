from __future__ import annotations

import uvicorn
from fastapi import FastAPI

from app.core.config import get_settings
from app.pipeline import build_reply
from app.schemas import ReplyRequest, ReplyResponse


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title=settings.app_name, version="0.1.0")

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "ok", "service": "ai-reply"}

    @app.post("/api/v1/replies/preview", response_model=ReplyResponse)
    async def preview(request: ReplyRequest) -> ReplyResponse:
        return await build_reply(request)

    @app.post("/api/v1/replies/decide", response_model=ReplyResponse)
    async def decide(request: ReplyRequest) -> ReplyResponse:
        return await build_reply(request)

    return app


app = create_app()


def run() -> None:
    settings = get_settings()
    uvicorn.run("app.main:app", host=settings.host, port=settings.port)


if __name__ == "__main__":
    run()
