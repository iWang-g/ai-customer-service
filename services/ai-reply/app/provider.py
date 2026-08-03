from __future__ import annotations

from typing import Any

import httpx

from app.core.config import get_settings


async def generate_with_provider(
    *,
    system: str,
    user: str,
    provider_config: dict[str, Any] | None = None,
    temperature: float | None = None,
    json_mode: bool = False,
) -> tuple[str, str]:
    settings = get_settings()
    config = provider_config or {}
    provider = str(config.get("provider") or settings.provider).lower()
    enabled = config.get("enabled", True)
    base_url = str(config.get("base_url") or settings.provider_base_url).strip()
    model = str(config.get("model") or settings.model).strip()
    api_key = str(config.get("api_key") or (settings.deepseek_api_key if provider == "deepseek" else settings.provider_api_key)).strip()
    request_temperature = float(
        temperature if temperature is not None else config.get("temperature", settings.temperature)
    )
    if not enabled or provider == "local" or not base_url or not api_key:
        return "", "local"
    url = base_url.rstrip("/") + "/chat/completions"
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    payload: dict[str, Any] = {
        "model": model,
        "stream": False,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
    }
    if model != "deepseek-reasoner":
        payload["temperature"] = request_temperature
    if json_mode:
        payload["response_format"] = {"type": "json_object"}
    async with httpx.AsyncClient(timeout=settings.request_timeout_seconds) as client:
        response = await client.post(url, headers=headers, json=payload)
        response.raise_for_status()
        data = response.json()
    content = (((data.get("choices") or [{}])[0].get("message") or {}).get("content") or "").strip()
    return str(content), provider
