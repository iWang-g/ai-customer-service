from __future__ import annotations

import jwt
from dataclasses import dataclass
from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.core.config import get_settings


bearer = HTTPBearer(auto_error=False)


@dataclass(frozen=True)
class CurrentUser:
    id: str
    username: str
    display_name: str


def current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
) -> str:
    if credentials is None or credentials.scheme.casefold() != "bearer":
        raise HTTPException(status_code=401, detail="Missing access token")
    try:
        payload = jwt.decode(
            credentials.credentials,
            get_settings().jwt_secret_key,
            algorithms=["HS256"],
        )
    except jwt.PyJWTError as exc:
        raise HTTPException(status_code=401, detail="Invalid access token") from exc
    user_id = payload.get("sub")
    if payload.get("typ") != "access" or not isinstance(user_id, str) or not user_id:
        raise HTTPException(status_code=401, detail="Invalid access token")
    return CurrentUser(
        id=user_id,
        username=str(payload.get("username") or user_id),
        display_name=str(payload.get("display_name") or payload.get("username") or user_id),
    )


def current_user_id(user: CurrentUser = Depends(current_user)) -> str:
    return user.id
