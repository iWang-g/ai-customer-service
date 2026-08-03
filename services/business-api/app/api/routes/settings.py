from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, get_db_session
from app.models import User
from app.schemas.settings import UserSettingsRead, UserSettingsUpdate
from app.services.settings_service import read_user_settings, save_user_settings

router = APIRouter(prefix="/settings", tags=["settings"])


@router.get("", response_model=UserSettingsRead)
def get_settings_route(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db_session),
) -> UserSettingsRead:
    return read_user_settings(db, user)


@router.put("", response_model=UserSettingsRead)
def save_settings_route(
    request: UserSettingsUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db_session),
) -> UserSettingsRead:
    return save_user_settings(db, user, request)
