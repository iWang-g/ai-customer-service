from __future__ import annotations

from contextvars import ContextVar, Token
from functools import wraps
import time
from typing import Any, Awaitable, Callable, TypeVar

import httpx

from app.core.config import get_settings


_model_call_observations: ContextVar[list[dict[str, Any]] | None] = ContextVar(
    "model_call_observations",
    default=None,
)


def start_model_call_observations() -> Token:
    return _model_call_observations.set([])


def finish_model_call_observations(token: Token) -> list[dict[str, Any]]:
    observations = list(_model_call_observations.get() or [])
    _model_call_observations.reset(token)
    return observations


def current_model_call_observations() -> list[dict[str, Any]]:
    return list(_model_call_observations.get() or [])


def _record_observation(value: dict[str, Any]) -> None:
    observations = _model_call_observations.get()
    if observations is not None:
        observations.append(value)


ReplyResult = TypeVar("ReplyResult")


def observe_model_calls(
    function: Callable[..., Awaitable[ReplyResult]],
) -> Callable[..., Awaitable[ReplyResult]]:
    @wraps(function)
    async def wrapped(*args: Any, **kwargs: Any) -> ReplyResult:
        observation_token = start_model_call_observations()
        try:
            response = await function(*args, **kwargs)
            if hasattr(response, "model_call_details"):
                response.model_call_details = current_model_call_observations()
            return response
        finally:
            finish_model_call_observations(observation_token)

    return wrapped


async def generate_with_provider(
    *,
    system: str,
    user: str,
    provider_config: dict[str, Any] | None = None,
    temperature: float | None = None,
    json_mode: bool = False,
    stage: str = "generation",
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
    started = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=settings.request_timeout_seconds) as client:
            response = await client.post(url, headers=headers, json=payload)
            response.raise_for_status()
            data = response.json()
    except Exception as exc:
        _record_observation({
            "stage": stage,
            "provider": provider,
            "model": model,
            "status": "failed",
            "input_tokens": 0,
            "output_tokens": 0,
            "duration_ms": max(0, round((time.monotonic() - started) * 1000)),
            "error_message": str(exc)[:500],
        })
        raise
    usage = data.get("usage") if isinstance(data.get("usage"), dict) else {}
    _record_observation({
        "stage": stage,
        "provider": provider,
        "model": model,
        "status": "success",
        "input_tokens": int(usage.get("prompt_tokens") or 0),
        "output_tokens": int(usage.get("completion_tokens") or 0),
        "duration_ms": max(0, round((time.monotonic() - started) * 1000)),
        "error_message": "",
    })
    content = (((data.get("choices") or [{}])[0].get("message") or {}).get("content") or "").strip()
    return str(content), provider
