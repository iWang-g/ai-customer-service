from __future__ import annotations

import hashlib
import json
import re
import time
from typing import Any, Literal
from uuid import uuid4

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, get_db_session
from app.api.routes.ai_config import provider_credentials
from app.db.session import SessionLocal
from app.models import PlatformAccount, PlatformPhraseSnapshot, User, utcnow
from app.services.ai_model_catalog_service import DEFAULT_AI_MODEL

router = APIRouter(prefix="/platform-phrases", tags=["platform-phrases"])

NORMALIZE_BATCH_SIZE = 30
NORMALIZE_MODEL_TIMEOUT_SECONDS = 120
NORMALIZE_TASK_TTL_SECONDS = 60 * 60


class PlatformPhraseImage(BaseModel):
    url: str = ""
    width: int | None = None
    height: int | None = None
    image_size: int | None = None

    @field_validator("url", mode="before")
    @classmethod
    def normalize_nullable_string(cls, value: Any) -> str:
        return "" if value is None else str(value)


class PlatformPhraseRecord(BaseModel):
    source_id: str = ""
    category: str = ""
    quick_key: str = ""
    content: str = ""
    images: list[PlatformPhraseImage] = Field(default_factory=list)

    @field_validator("source_id", "category", "quick_key", "content", mode="before")
    @classmethod
    def normalize_nullable_string(cls, value: Any) -> str:
        return "" if value is None else str(value)


class PlatformPhraseNormalizeRequest(BaseModel):
    platform: Literal["pinduoduo"] = "pinduoduo"
    source: Literal["personal", "team"]
    existing_categories: list[str] = Field(default_factory=list, max_length=128)
    records: list[PlatformPhraseRecord]


class PlatformPhraseQaDraft(BaseModel):
    source_id: str
    category: str
    question: str
    keywords: list[str]
    answer: str
    image_url: str = ""
    weight: int = 10
    enabled: bool = True


class PlatformPhraseNormalizeResponse(BaseModel):
    items: list[PlatformPhraseQaDraft]
    provider: str
    used_fallback: bool = False
    error: str | None = None
    total_records: int = 0
    generated_count: int = 0
    failed_count: int = 0
    batch_count: int = 0
    completed_batches: int = 0


class PlatformPhraseSnapshotUpsertRequest(BaseModel):
    platform: Literal["pinduoduo"] = "pinduoduo"
    source: Literal["personal", "team"]
    platform_account_id: str | None = Field(default=None, max_length=64)
    local_account_id: str | None = Field(default=None, max_length=64)
    records: list[PlatformPhraseRecord]
    raw_count: int = 0
    status: Literal["collected", "failed"] = "collected"
    error: str | None = Field(default=None, max_length=500)


class PlatformPhraseSnapshotRead(BaseModel):
    id: str
    platform_account_id: str
    local_account_id: str | None = None
    platform: str
    source: Literal["personal", "team"]
    records: list[PlatformPhraseRecord]
    record_count: int
    raw_count: int
    content_hash: str
    status: str
    error: str | None = None
    collected_at: str
    updated_at: str


class PlatformPhraseSnapshotResponse(BaseModel):
    item: PlatformPhraseSnapshotRead | None = None


class PlatformPhraseNormalizeTaskCreate(BaseModel):
    platform: Literal["pinduoduo"] = "pinduoduo"
    source: Literal["personal", "team"]
    existing_categories: list[str] = Field(default_factory=list, max_length=128)
    records: list[PlatformPhraseRecord]


class PlatformPhraseNormalizeTaskRead(PlatformPhraseNormalizeResponse):
    task_id: str
    status: Literal["queued", "running", "completed", "failed", "cancelled"]
    cancel_requested: bool = False
    current_batch: int = 0
    message: str = ""


_normalize_tasks: dict[str, dict[str, Any]] = {}


def _clean_text(value: Any, limit: int = 4000) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()[:limit]


def _safe_records(records: list[PlatformPhraseRecord], limit: int = 500) -> list[PlatformPhraseRecord]:
    return [record for record in records[:limit] if _clean_text(record.content)]


def _records_hash(records: list[PlatformPhraseRecord]) -> str:
    payload = [
        {
            "source_id": record.source_id,
            "category": record.category,
            "quick_key": record.quick_key,
            "content": record.content,
            "images": [image.model_dump() for image in record.images],
        }
        for record in records
    ]
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _unique_clean_categories(categories: list[str]) -> list[str]:
    values = [_clean_text(category, 128) for category in categories]
    return [category for category in dict.fromkeys(values) if category]


def _resolve_platform_account(
    db: Session,
    user: User,
    *,
    platform_account_id: str | None,
    local_account_id: str | None,
) -> PlatformAccount:
    account: PlatformAccount | None = None
    if platform_account_id:
        account = db.scalar(select(PlatformAccount).where(
            PlatformAccount.id == platform_account_id,
            PlatformAccount.user_id == user.id,
            PlatformAccount.platform_code == "pinduoduo",
        ))
    if account is None and local_account_id:
        account = db.scalar(select(PlatformAccount).where(
            PlatformAccount.local_account_id == local_account_id,
            PlatformAccount.user_id == user.id,
            PlatformAccount.platform_code == "pinduoduo",
        ))
    if account is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="未找到匹配的拼多多店铺")
    return account


def _snapshot_to_read(snapshot: PlatformPhraseSnapshot) -> PlatformPhraseSnapshotRead:
    records = [
        PlatformPhraseRecord.model_validate(record)
        for record in (snapshot.records_json or [])
        if isinstance(record, dict)
    ]
    return PlatformPhraseSnapshotRead(
        id=snapshot.id,
        platform_account_id=snapshot.platform_account_id,
        local_account_id=snapshot.local_account_id,
        platform=snapshot.platform_code,
        source=snapshot.source if snapshot.source in ("personal", "team") else "personal",
        records=records,
        record_count=snapshot.record_count,
        raw_count=snapshot.raw_count,
        content_hash=snapshot.content_hash,
        status=snapshot.status,
        error=snapshot.error_message,
        collected_at=snapshot.collected_at.isoformat(),
        updated_at=snapshot.updated_at.isoformat(),
    )


def _task_response(task_id: str, task: dict[str, Any]) -> PlatformPhraseNormalizeTaskRead:
    total = int(task.get("total_records") or 0)
    generated = len(task.get("items") or [])
    completed_batches = int(task.get("completed_batches") or 0)
    batch_count = int(task.get("batch_count") or 0)
    failed_count = int(task.get("failed_count") or max(total - generated, 0))
    return PlatformPhraseNormalizeTaskRead(
        task_id=task_id,
        status=task.get("status", "queued"),
        cancel_requested=bool(task.get("cancel_requested")),
        current_batch=int(task.get("current_batch") or 0),
        message=str(task.get("message") or ""),
        items=task.get("items") or [],
        provider=str(task.get("provider") or ""),
        used_fallback=bool(task.get("used_fallback")),
        error=task.get("error"),
        total_records=total,
        generated_count=generated,
        failed_count=failed_count,
        batch_count=batch_count,
        completed_batches=completed_batches,
    )


def _prune_normalize_tasks() -> None:
    cutoff = time.monotonic() - NORMALIZE_TASK_TTL_SECONDS
    for task_id, task in list(_normalize_tasks.items()):
        if float(task.get("updated_monotonic") or 0) < cutoff:
            _normalize_tasks.pop(task_id, None)


def _failed_response(
    provider: str = "local-rule",
    error: str | None = None,
) -> PlatformPhraseNormalizeResponse:
    return PlatformPhraseNormalizeResponse(
        items=[],
        provider=provider,
        used_fallback=False,
        error=error,
        total_records=0,
        generated_count=0,
        failed_count=0,
    )


def _extract_json_object(value: str) -> dict[str, Any] | None:
    try:
        parsed = json.loads(value)
        return parsed if isinstance(parsed, dict) else None
    except ValueError:
        pass
    match = re.search(r"\{.*\}", value or "", re.S)
    if not match:
        return None
    try:
        parsed = json.loads(match.group(0))
        return parsed if isinstance(parsed, dict) else None
    except ValueError:
        return None


def _sanitize_model_items(records: list[PlatformPhraseRecord], payload: dict[str, Any]) -> list[PlatformPhraseQaDraft]:
    records_by_source = {record.source_id: record for record in records}
    items = payload.get("items")
    if not isinstance(items, list):
        return []
    result: list[PlatformPhraseQaDraft] = []
    seen_sources: set[str] = set()
    for item in items[:500]:
        if not isinstance(item, dict):
            continue
        source_id = _clean_text(item.get("source_id"), 128)
        record = records_by_source.get(source_id)
        if not record or source_id in seen_sources:
            continue
        category = _clean_text(item.get("category"), 64)
        question = _clean_text(item.get("question"), 200)
        answer = _clean_text(item.get("answer"), 4000)
        keywords_value = item.get("keywords")
        if not category or not question or not answer or not isinstance(keywords_value, list):
            continue
        keywords = [
            _clean_text(keyword, 32)
            for keyword in keywords_value
        ]
        keywords = [keyword for keyword in dict.fromkeys(keywords) if keyword][:8]
        if not keywords:
            continue
        seen_sources.add(source_id)
        result.append(PlatformPhraseQaDraft(
            source_id=source_id,
            category=category,
            question=question,
            keywords=keywords,
            answer=answer,
            image_url=record.images[0].url if record.images else "",
            weight=10,
            enabled=True,
        ))
    return sorted(result, key=lambda item: next(
        index for index, record in enumerate(records) if record.source_id == item.source_id
    ))


def _build_model_messages(
    *,
    platform: str,
    source: str,
    existing_categories: list[str],
    records: list[PlatformPhraseRecord],
) -> list[dict[str, str]]:
    compact_records = [
        {
            "source_id": record.source_id,
            "category": record.category,
            "quick_key": record.quick_key,
            "content": record.content,
            "image_urls": [image.url for image in record.images if image.url],
        }
        for record in records
    ]
    system = (
        "你负责把电商平台客服话术整理成 QA 问答知识库草稿。"
        "请先整体理解本批次所有话术，再统一生成结果。"
        "只返回 JSON 对象，不要输出解释。"
        "每条输入话术都必须返回一条结果，必须保留 source_id。"
        "分类规则：优先复用 existing_categories；只有现有分类无法准确承载时才新增分类。"
        "新增分类必须简洁、稳定、可复用，不能按每条话术单独创建分类。"
        "同一批次中的相似话术必须使用相同分类；平台原始 category 只能作为参考。"
        "question 是客户真实可能提出的问题，必须口语化、自然，不能写成专业标题，"
        "不能使用“XX相关问题”“咨询”“需求分析”等知识库式表达。"
        "keywords 必须生成 2-5 个具体且有区分度的客户常用短语，"
        "不要使用“你好、请问、可以、问题、商品、图片、抱枕、怎么”等普通词，"
        "除非该词在当前话术中确实具有区分作用；不要只返回分类名称。"
        "answer 只能基于原始 content 改写，不改变原意，不增加事实、承诺、政策、价格、时效或处理方案。"
        "必须保留原文中的数字、尺寸、时间、条件、限制和禁止事项。"
        "可以修正标点、病句和表达顺序，使其更自然并保持客服语气。"
    )
    user_payload = {
        "output_schema": {
            "items": [{
                "source_id": "string",
                "category": "string",
                "question": "string",
                "keywords": ["string"],
                "answer": "string",
            }],
        },
        "platform": platform,
        "source": source,
        "existing_categories": existing_categories,
        "records": compact_records,
    }
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": json.dumps(user_payload, ensure_ascii=False)},
    ]


async def _normalize_records_with_ai(
    db: Session,
    *,
    platform: str,
    source: str,
    existing_categories: list[str],
    records: list[PlatformPhraseRecord],
    task_id: str | None = None,
) -> PlatformPhraseNormalizeResponse:
    records = _safe_records(records)
    total = len(records)
    if not records:
        return PlatformPhraseNormalizeResponse(
            items=[],
            provider="local-rule",
            used_fallback=True,
            total_records=0,
            generated_count=0,
            failed_count=0,
        )
    categories = _unique_clean_categories(existing_categories)
    provider, base_url, api_key = provider_credentials(db)
    chunks = [records[index:index + NORMALIZE_BATCH_SIZE] for index in range(0, len(records), NORMALIZE_BATCH_SIZE)]
    items: list[PlatformPhraseQaDraft] = []
    failed_count = 0
    errors: list[str] = []
    async with httpx.AsyncClient(timeout=NORMALIZE_MODEL_TIMEOUT_SECONDS, trust_env=False) as client:
        for index, chunk in enumerate(chunks, start=1):
            if task_id:
                task = _normalize_tasks.get(task_id)
                if not task or task.get("cancel_requested"):
                    return PlatformPhraseNormalizeResponse(
                        items=items,
                        provider=provider,
                        used_fallback=False,
                        error="用户已停止生成",
                        total_records=total,
                        generated_count=len(items),
                        failed_count=total - len(items),
                        batch_count=len(chunks),
                        completed_batches=max(index - 1, 0),
                    )
                task.update({
                    "status": "running",
                    "provider": provider,
                    "current_batch": index,
                    "message": f"正在生成第 {index}/{len(chunks)} 批话术草稿",
                    "updated_monotonic": time.monotonic(),
                })
            try:
                response = await client.post(
                    f"{base_url.rstrip('/')}/chat/completions",
                    headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                    json={
                        "model": DEFAULT_AI_MODEL,
                        "stream": False,
                        "temperature": 0.1,
                        "response_format": {"type": "json_object"},
                        "messages": _build_model_messages(
                            platform=platform,
                            source=source,
                            existing_categories=categories,
                            records=chunk,
                        ),
                    },
                )
                response.raise_for_status()
                data = response.json()
                content = (((data.get("choices") or [{}])[0].get("message") or {}).get("content") or "").strip()
                parsed = _extract_json_object(content)
                chunk_items = _sanitize_model_items(chunk, parsed or {})
                items.extend(chunk_items)
                failed_count += len(chunk) - len(chunk_items)
                if len(chunk_items) != len(chunk):
                    errors.append(f"第 {index} 批生成 {len(chunk_items)}/{len(chunk)} 条")
            except Exception as exc:  # noqa: BLE001
                failed_count += len(chunk)
                errors.append(f"第 {index} 批失败：{str(exc)[:200]}")
            if task_id:
                task = _normalize_tasks.get(task_id)
                if task:
                    task.update({
                        "items": items.copy(),
                        "failed_count": failed_count,
                        "completed_batches": index,
                        "message": f"已完成 {index}/{len(chunks)} 批，生成 {len(items)}/{total} 条",
                        "updated_monotonic": time.monotonic(),
                    })
    return PlatformPhraseNormalizeResponse(
        items=items,
        provider=provider,
        used_fallback=False,
        error="；".join(errors[:5]) if errors else None,
        total_records=total,
        generated_count=len(items),
        failed_count=failed_count,
        batch_count=len(chunks),
        completed_batches=len(chunks),
    )


@router.get("/cache", response_model=PlatformPhraseSnapshotResponse)
def get_platform_phrase_cache(
    source: Literal["personal", "team"],
    platform_account_id: str | None = None,
    local_account_id: str | None = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db_session),
) -> PlatformPhraseSnapshotResponse:
    try:
        account = _resolve_platform_account(
            db,
            user,
            platform_account_id=platform_account_id,
            local_account_id=local_account_id,
        )
    except HTTPException as exc:
        if exc.status_code == status.HTTP_404_NOT_FOUND:
            return PlatformPhraseSnapshotResponse(item=None)
        raise
    snapshot = db.scalar(select(PlatformPhraseSnapshot).where(
        PlatformPhraseSnapshot.user_id == user.id,
        PlatformPhraseSnapshot.platform_account_id == account.id,
        PlatformPhraseSnapshot.source == source,
    ))
    return PlatformPhraseSnapshotResponse(item=_snapshot_to_read(snapshot) if snapshot else None)


@router.put("/cache", response_model=PlatformPhraseSnapshotRead)
def upsert_platform_phrase_cache(
    request: PlatformPhraseSnapshotUpsertRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db_session),
) -> PlatformPhraseSnapshotRead:
    account = _resolve_platform_account(
        db,
        user,
        platform_account_id=request.platform_account_id,
        local_account_id=request.local_account_id,
    )
    records = _safe_records(request.records)
    snapshot = db.scalar(select(PlatformPhraseSnapshot).where(
        PlatformPhraseSnapshot.user_id == user.id,
        PlatformPhraseSnapshot.platform_account_id == account.id,
        PlatformPhraseSnapshot.source == request.source,
    ))
    if snapshot is None:
        snapshot = PlatformPhraseSnapshot(
            user_id=user.id,
            platform_account_id=account.id,
            source=request.source,
        )
        db.add(snapshot)
    snapshot.local_account_id = account.local_account_id or request.local_account_id
    snapshot.platform_code = request.platform
    snapshot.records_json = [record.model_dump() for record in records]
    snapshot.record_count = len(records)
    snapshot.raw_count = max(int(request.raw_count or 0), len(records))
    snapshot.content_hash = _records_hash(records)
    snapshot.status = request.status
    snapshot.error_message = request.error
    snapshot.collected_at = utcnow()
    db.commit()
    db.refresh(snapshot)
    return _snapshot_to_read(snapshot)


async def _run_normalize_task(task_id: str, user_id: str, request: PlatformPhraseNormalizeTaskCreate) -> None:
    task = _normalize_tasks.get(task_id)
    if not task:
        return
    task.update({"status": "running", "message": "正在准备生成话术草稿", "updated_monotonic": time.monotonic()})
    with SessionLocal() as db:
        try:
            user = db.get(User, user_id)
            if not user:
                raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
            result = await _normalize_records_with_ai(
                db,
                platform=request.platform,
                source=request.source,
                existing_categories=request.existing_categories,
                records=request.records,
                task_id=task_id,
            )
            task.update({
                "items": result.items,
                "provider": result.provider,
                "used_fallback": result.used_fallback,
                "error": result.error,
                "total_records": result.total_records,
                "failed_count": result.failed_count,
                "batch_count": result.batch_count,
                "completed_batches": result.completed_batches,
                "status": "cancelled" if task.get("cancel_requested") else (
                    "completed" if result.items else "failed"
                ),
                "message": (
                    "已停止生成"
                    if task.get("cancel_requested")
                    else f"已生成 {len(result.items)}/{result.total_records} 条话术草稿"
                ),
                "updated_monotonic": time.monotonic(),
            })
        except Exception as exc:  # noqa: BLE001
            task.update({
                "status": "failed",
                "error": str(exc)[:500],
                "message": "话术草稿生成失败",
                "updated_monotonic": time.monotonic(),
            })


@router.post("/normalize-tasks", response_model=PlatformPhraseNormalizeTaskRead, status_code=status.HTTP_202_ACCEPTED)
async def create_platform_phrase_normalize_task(
    request: PlatformPhraseNormalizeTaskCreate,
    background_tasks: BackgroundTasks,
    user: User = Depends(get_current_user),
) -> PlatformPhraseNormalizeTaskRead:
    _prune_normalize_tasks()
    records = _safe_records(request.records)
    task_id = uuid4().hex
    batch_count = (len(records) + NORMALIZE_BATCH_SIZE - 1) // NORMALIZE_BATCH_SIZE if records else 0
    _normalize_tasks[task_id] = {
        "status": "queued",
        "items": [],
        "provider": "",
        "used_fallback": False,
        "error": None,
        "total_records": len(records),
        "failed_count": 0,
        "batch_count": batch_count,
        "completed_batches": 0,
        "current_batch": 0,
        "cancel_requested": False,
        "message": "已加入生成队列",
        "owner_user_id": user.id,
        "updated_monotonic": time.monotonic(),
    }
    background_tasks.add_task(_run_normalize_task, task_id, user.id, request)
    return _task_response(task_id, _normalize_tasks[task_id])


@router.get("/normalize-tasks/{task_id}", response_model=PlatformPhraseNormalizeTaskRead)
def get_platform_phrase_normalize_task(
    task_id: str,
    user: User = Depends(get_current_user),
) -> PlatformPhraseNormalizeTaskRead:
    _prune_normalize_tasks()
    task = _normalize_tasks.get(task_id)
    if not task or task.get("owner_user_id") != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="话术生成任务不存在")
    return _task_response(task_id, task)


@router.post("/normalize-tasks/{task_id}/cancel", response_model=PlatformPhraseNormalizeTaskRead)
def cancel_platform_phrase_normalize_task(
    task_id: str,
    user: User = Depends(get_current_user),
) -> PlatformPhraseNormalizeTaskRead:
    task = _normalize_tasks.get(task_id)
    if not task or task.get("owner_user_id") != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="话术生成任务不存在")
    task["cancel_requested"] = True
    task["message"] = "正在停止生成"
    task["updated_monotonic"] = time.monotonic()
    if task.get("status") == "queued":
        task["status"] = "cancelled"
    return _task_response(task_id, task)


@router.post("/normalize", response_model=PlatformPhraseNormalizeResponse)
async def normalize_platform_phrases(
    request: PlatformPhraseNormalizeRequest,
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db_session),
) -> PlatformPhraseNormalizeResponse:
    try:
        return await _normalize_records_with_ai(
            db,
            platform=request.platform,
            source=request.source,
            existing_categories=request.existing_categories,
            records=request.records,
        )
    except Exception as exc:  # noqa: BLE001
        return _failed_response(error=str(exc)[:500])
