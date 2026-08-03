from __future__ import annotations

from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import get_settings
from app.models import Base
from app.db.migrations import apply_compatibility_migrations

settings = get_settings()


def _build_engine():
    connect_args = {}
    if settings.database_url.startswith("sqlite"):
        db_path = settings.database_url.replace("sqlite:///", "", 1)
        if db_path and db_path != ":memory:":
            Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        connect_args = {"check_same_thread": False}
    return create_engine(settings.database_url, future=True, echo=False, connect_args=connect_args)


engine = _build_engine()
SessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False, expire_on_commit=False)


def init_db() -> None:
    if settings.auto_create_tables:
        Base.metadata.create_all(bind=engine)
        apply_compatibility_migrations(engine)


def get_db() -> Session:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
