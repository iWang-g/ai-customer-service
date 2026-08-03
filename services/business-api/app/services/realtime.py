from __future__ import annotations

import asyncio
from collections.abc import Iterable

from fastapi import WebSocket


class RealtimeManager:
    def __init__(self) -> None:
        self._connections: dict[str, set[WebSocket]] = {}
        self._lock = asyncio.Lock()

    async def connect(self, user_id: str, websocket: WebSocket) -> None:
        await websocket.accept()
        async with self._lock:
            self._connections.setdefault(user_id, set()).add(websocket)

    async def disconnect(self, user_id: str, websocket: WebSocket) -> None:
        async with self._lock:
            connections = self._connections.get(user_id)
            if connections is None:
                return
            connections.discard(websocket)
            if not connections:
                self._connections.pop(user_id, None)

    async def broadcast(self, user_id: str, payload: dict) -> None:
        async with self._lock:
            connections = list(self._connections.get(user_id, set()))
        stale: list[WebSocket] = []
        for websocket in connections:
            try:
                await websocket.send_json(payload)
            except Exception:  # noqa: BLE001
                stale.append(websocket)
        if stale:
            async with self._lock:
                user_connections = self._connections.get(user_id)
                if user_connections is None:
                    return
                for websocket in stale:
                    user_connections.discard(websocket)
                if not user_connections:
                    self._connections.pop(user_id, None)

    async def broadcast_many(self, user_id: str, payloads: Iterable[dict]) -> None:
        for payload in payloads:
            await self.broadcast(user_id, payload)


realtime_manager = RealtimeManager()
