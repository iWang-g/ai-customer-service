from fastapi import APIRouter, Depends, Header, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, get_db_session, get_settings_dep
from app.core.config import Settings
from app.core.security import decode_token
from app.models import User
from app.schemas.auth import LoginRequest, RefreshRequest, TokenPairResponse, UserRead
from app.services.auth_service import authenticate_user, bootstrap_admin_user, user_to_read

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/login", response_model=TokenPairResponse)
def login(
    request: LoginRequest,
    db: Session = Depends(get_db_session),
    settings: Settings = Depends(get_settings_dep),
) -> TokenPairResponse:
    bootstrap_admin_user(db, settings)
    return authenticate_user(db, settings, request.username, request.password)


@router.post("/refresh", response_model=TokenPairResponse)
def refresh(
    request: RefreshRequest,
    db: Session = Depends(get_db_session),
    settings: Settings = Depends(get_settings_dep),
) -> TokenPairResponse:
    try:
        payload = decode_token(settings.jwt_secret_key, request.refresh_token)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=401, detail="Invalid refresh token") from exc
    if payload.get("typ") != "refresh":
        raise HTTPException(status_code=401, detail="Invalid refresh token type")
    user_id = payload.get("sub")
    user = db.get(User, user_id)
    if not user or not user.is_active:
        raise HTTPException(status_code=401, detail="User not found")
    from app.services.auth_service import refresh_token_pair

    return refresh_token_pair(db, settings, user)


@router.post("/logout")
def logout() -> dict[str, str]:
    return {"message": "logged out"}


@router.get("/me", response_model=UserRead)
def me(user: User = Depends(get_current_user)) -> UserRead:
    return user_to_read(user)
