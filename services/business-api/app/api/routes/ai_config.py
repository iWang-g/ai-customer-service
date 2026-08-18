from __future__ import annotations

from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, get_db_session
from app.core.config import get_settings
from app.models import AiModelCatalog, AiProviderConfig, User
from app.schemas.ai_config import AiModelList, AiModelRead
from app.services.ai_model_catalog_service import (
    SUPPORTED_AI_MODEL_SET,
    remove_unsupported_models,
    supported_model_ids,
)

router = APIRouter(prefix="/ai-models", tags=["ai-models"])


def list_catalog(db: Session) -> AiModelList:
    remove_unsupported_models(db)
    db.commit()
    rows = list(db.scalars(
        select(AiModelCatalog)
        .where(AiModelCatalog.model_id.in_(SUPPORTED_AI_MODEL_SET))
        .order_by(AiModelCatalog.provider, AiModelCatalog.model_id)
    ).all())
    return AiModelList(items=[AiModelRead.model_validate(row) for row in rows])


def provider_credentials(db: Session) -> tuple[str, str, str]:
    settings = get_settings()
    if settings.ai_provider_api_key:
        return settings.ai_provider, settings.ai_provider_base_url.rstrip("/"), settings.ai_provider_api_key
    # Migration bridge for installations that still keep the key in the legacy server database.
    legacy = db.scalar(select(AiProviderConfig).where(AiProviderConfig.api_key != ""))
    if legacy:
        return legacy.provider, legacy.base_url.rstrip("/"), legacy.api_key
    raise HTTPException(status_code=503, detail="服务端尚未配置 AI 模型凭据")


@router.get("", response_model=AiModelList)
def get_models(_user: User = Depends(get_current_user), db: Session = Depends(get_db_session)) -> AiModelList:
    return list_catalog(db)


@router.post("/sync", response_model=AiModelList)
async def sync_models(_user: User = Depends(get_current_user), db: Session = Depends(get_db_session)) -> AiModelList:
    remove_unsupported_models(db)
    provider, base_url, api_key = provider_credentials(db)
    try:
        async with httpx.AsyncClient(timeout=20, trust_env=False) as client:
            response = await client.get(
                f"{base_url}/models",
                headers={"Authorization": f"Bearer {api_key}"},
            )
            if response.status_code in (401, 403):
                raise HTTPException(status_code=502, detail="服务端 AI 模型凭据无效")
            response.raise_for_status()
            payload = response.json()
    except HTTPException:
        raise
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(status_code=502, detail=f"获取模型列表失败：{exc}") from exc

    values = payload.get("data") if isinstance(payload, dict) else None
    model_ids = supported_model_ids(values)
    if not model_ids:
        raise HTTPException(status_code=502, detail="服务商未返回可用模型")
    now = datetime.now(timezone.utc)
    existing = {
        row.model_id: row
        for row in db.scalars(select(AiModelCatalog).where(AiModelCatalog.provider == provider)).all()
    }
    for row in existing.values():
        row.available = False
    for model_id in model_ids:
        row = existing.get(model_id)
        if row is None:
            row = AiModelCatalog(provider=provider, model_id=model_id, display_name=model_id)
            db.add(row)
        row.available = True
        row.fetched_at = now
    db.commit()
    return list_catalog(db)
