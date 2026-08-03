from __future__ import annotations

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.core.config import get_settings
from app.core.security import decode_token
from app.db.session import SessionLocal
from app.models import User
from app.services.realtime import realtime_manager

router = APIRouter(tags=["websocket"])


@router.websocket("/ws/events")
async def ws_events(websocket: WebSocket) -> None:
    settings = get_settings()
    token = websocket.query_params.get("token")
    if not token:
        await websocket.close(code=1008)
        return
    try:
        payload = decode_token(settings.jwt_secret_key, token)
    except Exception:  # noqa: BLE001
        await websocket.close(code=1008)
        return
    if payload.get("typ") != "access" or not payload.get("sub"):
        await websocket.close(code=1008)
        return
    user_id = payload["sub"]
    with SessionLocal() as db:
        user = db.get(User, user_id)
        if not user or not user.is_active:
            await websocket.close(code=1008)
            return
    await realtime_manager.connect(user_id, websocket)
    try:
        await websocket.send_json({"type": "connected"})
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        await realtime_manager.disconnect(user_id, websocket)
