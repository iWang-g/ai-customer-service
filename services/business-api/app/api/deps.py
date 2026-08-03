from __future__ import annotations

from collections.abc import Generator

from fastapi import Depends, Header, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.core.config import Settings, get_settings
from app.core.security import decode_token
from app.db.session import get_db
from app.models import RpaNode, User

bearer_scheme = HTTPBearer(auto_error=False)


def get_settings_dep() -> Settings:
    return get_settings()


def get_db_session() -> Generator[Session, None, None]:
    yield from get_db()


def _extract_token(
    credentials: HTTPAuthorizationCredentials | None,
    x_node_token: str | None = None,
) -> str | None:
    if credentials and credentials.scheme.lower() == "bearer":
        return credentials.credentials
    if x_node_token:
        return x_node_token
    return None


def get_current_user(
    db: Session = Depends(get_db_session),
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    settings: Settings = Depends(get_settings_dep),
) -> User:
    token = _extract_token(credentials)
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing access token")
    try:
        payload = decode_token(settings.jwt_secret_key, token)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token") from exc
    if payload.get("typ") != "access":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token type")
    user_id = payload.get("sub")
    user = db.get(User, user_id)
    if not user or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    return user


def get_current_rpa_node(
    db: Session = Depends(get_db_session),
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    x_node_token: str | None = Header(default=None, alias="X-RPA-Node-Token"),
    settings: Settings = Depends(get_settings_dep),
) -> RpaNode:
    token = _extract_token(credentials, x_node_token)
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing node token")
    try:
        payload = decode_token(settings.jwt_secret_key, token)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token") from exc
    if payload.get("typ") != "node":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token type")
    node_id = payload.get("node_id")
    node = db.get(RpaNode, node_id)
    if not node:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Node not found")
    return node
