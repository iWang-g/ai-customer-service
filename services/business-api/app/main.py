from __future__ import annotations

import asyncio
import logging
from pathlib import Path

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes.auth import router as auth_router
from app.api.routes.analytics import router as analytics_router
from app.api.routes.automation import router as automation_router
from app.api.routes.conversations import router as conversations_router
from app.api.routes.email import router as email_router
from app.api.routes.health import router as health_router
from app.api.routes.messages import router as messages_router
from app.api.routes.monitoring import router as monitoring_router
from app.api.routes.platform_accounts import router as platform_accounts_router
from app.api.routes.rpa import router as rpa_router
from app.api.routes.robots import router as robots_router
from app.api.routes.settings import router as settings_router
from app.api.routes.ai_config import router as ai_config_router
from app.api.routes.ws import router as ws_router
from app.core.config import get_settings
from app.db.session import engine, init_db
from app.models import Base
from app.services.auth_service import bootstrap_admin_user
from app.services.order_service import schedule_due_outreach_rechecks
from app.db.session import SessionLocal
from sqlalchemy.orm import Session


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title=settings.app_name, version="0.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(health_router)
    app.include_router(auth_router, prefix=settings.api_prefix)
    app.include_router(analytics_router, prefix=settings.api_prefix)
    app.include_router(automation_router, prefix=settings.api_prefix)
    app.include_router(rpa_router, prefix=settings.api_prefix)
    app.include_router(conversations_router, prefix=settings.api_prefix)
    app.include_router(email_router, prefix=settings.api_prefix)
    app.include_router(messages_router, prefix=settings.api_prefix)
    app.include_router(monitoring_router, prefix=settings.api_prefix)
    app.include_router(platform_accounts_router, prefix=settings.api_prefix)
    app.include_router(robots_router, prefix=settings.api_prefix)
    app.include_router(settings_router, prefix=settings.api_prefix)
    app.include_router(ai_config_router, prefix=settings.api_prefix)
    app.include_router(ws_router)

    async def outreach_scheduler() -> None:
        while True:
            try:
                with SessionLocal() as db:
                    schedule_due_outreach_rechecks(db)
            except Exception:  # noqa: BLE001
                logging.exception("customer outreach scheduler failed")
            await asyncio.sleep(5)

    @app.on_event("startup")
    async def on_startup() -> None:
        logging.basicConfig(level=getattr(logging, settings.log_level.upper(), logging.INFO))
        if settings.database_url.startswith("sqlite"):
            db_path = settings.database_url.replace("sqlite:///", "", 1)
            if db_path and db_path != ":memory:":
                Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        init_db()
        with Session(engine) as db:
            bootstrap_admin_user(db, settings)
        app.state.outreach_scheduler = asyncio.create_task(outreach_scheduler())

    @app.on_event("shutdown")
    async def on_shutdown() -> None:
        scheduler = getattr(app.state, "outreach_scheduler", None)
        if scheduler is None:
            return
        scheduler.cancel()
        try:
            await scheduler
        except asyncio.CancelledError:
            pass

    return app


app = create_app()


def run() -> None:
    settings = get_settings()
    uvicorn.run(
        "app.main:app",
        host="127.0.0.1",
        port=8001,
        reload=settings.environment.lower() == "development",
    )


if __name__ == "__main__":
    run()
