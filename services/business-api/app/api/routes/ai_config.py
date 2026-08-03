from __future__ import annotations

import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, get_db_session
from app.models import AiProviderConfig, User
from app.schemas.ai_config import AiConfigRead, AiConfigTestRequest, AiConfigTestResponse, AiConfigUpdate

router = APIRouter(prefix="/ai-config", tags=["ai-config"])

DEFAULTS = {
    "provider": "deepseek",
    "base_url": "https://api.deepseek.com",
    "model": "deepseek-chat",
    "enabled": False,
    "temperature": 0.2,
}


def _masked(key: str) -> str:
    if not key:
        return ""
    if len(key) <= 8:
        return "****"
    return f"{key[:3]}****{key[-4:]}"


def _read(config: AiProviderConfig | None) -> AiConfigRead:
    if not config:
        return AiConfigRead(**DEFAULTS, api_key_masked="")
    return AiConfigRead(
        provider=config.provider,
        base_url=config.base_url,
        model=config.model,
        api_key_masked=_masked(config.api_key),
        enabled=config.enabled,
        temperature=config.temperature,
        updated_at=config.updated_at,
    )


def _get(db: Session, user: User) -> AiProviderConfig | None:
    return db.query(AiProviderConfig).filter(AiProviderConfig.user_id == user.id).first()


@router.get("", response_model=AiConfigRead)
def get_ai_config(user: User = Depends(get_current_user), db: Session = Depends(get_db_session)) -> AiConfigRead:
    return _read(_get(db, user))


@router.put("", response_model=AiConfigRead)
def save_ai_config(
    request: AiConfigUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db_session),
) -> AiConfigRead:
    config = _get(db, user)
    if not config:
        config = AiProviderConfig(user_id=user.id, api_key=request.api_key)
        db.add(config)
    elif request.api_key and not request.api_key.startswith("***"):
        config.api_key = request.api_key
    config.provider = request.provider
    config.base_url = request.base_url.rstrip("/")
    config.model = request.model
    config.enabled = request.enabled
    config.temperature = request.temperature
    db.commit()
    db.refresh(config)
    return _read(config)


async def _test(config: AiConfigUpdate) -> AiConfigTestResponse:
    if not config.api_key:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="请先填写 DeepSeek API Key")
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            test_payload = {
                "model": config.model,
                "messages": [{"role": "user", "content": "请只回复：连接成功"}],
                "max_tokens": 16,
                "stream": False,
            }
            if config.model != "deepseek-reasoner":
                test_payload["temperature"] = config.temperature
            response = await client.post(
                f"{config.base_url.rstrip('/')}/chat/completions",
                headers={"Authorization": f"Bearer {config.api_key}"},
                json=test_payload,
            )
            if response.status_code in (401, 403):
                raise HTTPException(status_code=400, detail="API Key 无效或没有权限")
            response.raise_for_status()
        return AiConfigTestResponse(ok=True, provider=config.provider, model=config.model, message="连接成功")
    except HTTPException:
        raise
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=400, detail=f"连接 DeepSeek 失败：{exc}") from exc


@router.post("/test", response_model=AiConfigTestResponse)
async def test_ai_config(
    request: AiConfigTestRequest,
    _user: User = Depends(get_current_user),
) -> AiConfigTestResponse:
    return await _test(request)


@router.post("/test-saved", response_model=AiConfigTestResponse)
async def test_saved_ai_config(user: User = Depends(get_current_user), db: Session = Depends(get_db_session)) -> AiConfigTestResponse:
    config = _get(db, user)
    if not config:
        raise HTTPException(status_code=400, detail="请先保存 API 配置")
    return await _test(AiConfigTestRequest(
        provider=config.provider, base_url=config.base_url, model=config.model,
        api_key=config.api_key, enabled=config.enabled, temperature=config.temperature,
    ))
