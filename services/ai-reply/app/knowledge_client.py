from __future__ import annotations

from typing import Any

import httpx

from app.core.config import get_settings


async def post(path: str, payload: dict[str, Any]) -> dict[str, Any]:
    settings = get_settings()
    async with httpx.AsyncClient(
        base_url=settings.knowledge_base_url.rstrip("/"),
        timeout=settings.request_timeout_seconds,
        trust_env=False,
    ) as client:
        response = await client.post(f"/api/v1{path}", json=payload)
        response.raise_for_status()
        value = response.json()
        return value if isinstance(value, dict) else {}


async def match_qa(query: str, base_ids: list[str]) -> dict[str, Any]:
    return await post("/qa/match", {"query": query, "base_ids": base_ids})


async def search_documents(query: str, base_ids: list[str]) -> list[dict[str, Any]]:
    value = await post("/documents/search", {"query": query, "base_ids": base_ids, "top_k": 5})
    results = value.get("results")
    return results if isinstance(results, list) else []


async def get_knowledge_base(base_id: str) -> dict[str, Any]:
    settings = get_settings()
    async with httpx.AsyncClient(
        base_url=settings.knowledge_base_url.rstrip("/"),
        timeout=settings.request_timeout_seconds,
        trust_env=False,
    ) as client:
        response = await client.get(f"/api/v1/knowledge-bases/{base_id}")
        response.raise_for_status()
        value = response.json()
        return value if isinstance(value, dict) else {}
