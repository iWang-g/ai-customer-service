from __future__ import annotations

from datetime import timedelta

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.security import create_token, hash_password, utcnow, verify_password
from app.models import User
from app.schemas.auth import TokenPairResponse, UserRead
from app.services.demo_data import seed_demo_conversations


def bootstrap_admin_user(db: Session, settings: Settings) -> None:
    existing = db.scalar(select(User).where(User.username == settings.default_admin_username))
    if existing is None:
        existing = User(
            username=settings.default_admin_username,
            display_name=settings.default_admin_display_name,
            password_hash=hash_password(settings.default_admin_password),
            role="admin",
            is_active=True,
        )
        db.add(existing)
        db.commit()
        db.refresh(existing)
    if settings.environment.lower() == "development" and settings.seed_demo_data:
        seed_demo_conversations(db, existing)


def _issue_token_pair(user: User, settings: Settings) -> TokenPairResponse:
    access_token = create_token(
        settings.jwt_secret_key,
        subject=user.id,
        token_type="access",
        expires_delta=timedelta(minutes=settings.access_token_expire_minutes),
        extra_claims={"username": user.username, "role": user.role},
    )
    refresh_token = create_token(
        settings.jwt_secret_key,
        subject=user.id,
        token_type="refresh",
        expires_delta=timedelta(days=settings.refresh_token_expire_days),
        extra_claims={"username": user.username, "role": user.role},
    )
    return TokenPairResponse(
        access_token=access_token,
        refresh_token=refresh_token,
        expires_in=settings.access_token_expire_minutes * 60,
        refresh_expires_in=settings.refresh_token_expire_days * 24 * 3600,
        user=UserRead.model_validate(user),
    )


def authenticate_user(db: Session, settings: Settings, username: str, password: str) -> TokenPairResponse:
    normalized_username = username.strip().lower()
    user = db.scalar(select(User).where(func.lower(User.username) == normalized_username))
    if not user or not user.is_active or not verify_password(password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="用户名或密码错误")
    user.last_login_at = utcnow()
    db.add(user)
    db.commit()
    db.refresh(user)
    return _issue_token_pair(user, settings)


def register_user(
    db: Session,
    settings: Settings,
    username: str,
    display_name: str,
    password: str,
) -> TokenPairResponse:
    normalized_username = username.strip().lower()
    existing = db.scalar(select(User).where(func.lower(User.username) == normalized_username))
    if existing:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="该账号已被注册")

    user = User(
        username=normalized_username,
        display_name=display_name.strip(),
        password_hash=hash_password(password),
        role="agent",
        is_active=True,
        last_login_at=utcnow(),
    )
    db.add(user)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="该账号已被注册") from exc
    db.refresh(user)

    if settings.environment.lower() == "development" and settings.seed_demo_data:
        seed_demo_conversations(db, user)
    return _issue_token_pair(user, settings)


def refresh_token_pair(db: Session, settings: Settings, user: User) -> TokenPairResponse:
    return _issue_token_pair(user, settings)


def user_to_read(user: User) -> UserRead:
    return UserRead.model_validate(user)
