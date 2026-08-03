from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import User, UserSettings
from app.schemas.settings import UserSettingsRead, UserSettingsUpdate


def get_or_create_user_settings(db: Session, user: User) -> UserSettings:
    row = db.scalar(select(UserSettings).where(UserSettings.user_id == user.id))
    if row is not None:
        return row
    row = UserSettings(user_id=user.id, auto_reply_enabled=False)
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def read_user_settings(db: Session, user: User) -> UserSettingsRead:
    return UserSettingsRead.model_validate(get_or_create_user_settings(db, user))


def save_user_settings(db: Session, user: User, request: UserSettingsUpdate) -> UserSettingsRead:
    row = get_or_create_user_settings(db, user)
    row.auto_reply_enabled = request.auto_reply_enabled
    db.add(row)
    db.commit()
    db.refresh(row)
    return UserSettingsRead.model_validate(row)


def auto_reply_enabled(db: Session, user: User) -> bool:
    row = db.scalar(select(UserSettings).where(UserSettings.user_id == user.id))
    return bool(row and row.auto_reply_enabled)
