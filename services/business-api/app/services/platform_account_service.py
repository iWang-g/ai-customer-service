from __future__ import annotations

import logging
import httpx
from datetime import datetime, timezone
from fastapi import HTTPException, status
from sqlalchemy import and_, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.security import utcnow
from app.models import (
    AiModelCall,
    AiProviderConfig,
    AutomationReplyRun,
    Conversation,
    ConversationWorkflow,
    CustomerOrder,
    CustomerProduct,
    CustomerOutreachRun,
    EmailSendTask,
    EmailTemplate,
    Message,
    MessageObservation,
    PlatformAccount,
    RobotPlatformScope,
    RpaEvent,
    RpaNode,
    RpaTask,
    StoreProduct,
    User,
)
from app.schemas.common import PageMeta
from app.schemas.platform_account import (
    PlatformAccountCreate,
    PlatformAccountListResponse,
    PlatformAccountRead,
    PlatformAccountUpdate,
    ShopSummaryUpdate,
)
from app.core.config import get_settings
from app.schemas.platform import platform_display_name
from app.schemas.rpa import PlatformAccountSyncItem
from app.services.avatar_cache_service import cache_shop_logo
from app.services.qianniu_shop_profile import merge_profile_metadata, profile_name, shop_name

logger = logging.getLogger(__name__)


def _metadata_text(metadata: dict, key: str) -> str | None:
    value = metadata.get(key)
    if not isinstance(value, str):
        return None
    cleaned = value.strip()
    return cleaned or None


def _with_cached_shop_logo(
    metadata: dict,
    existing_metadata: dict | None = None,
) -> dict:
    next_metadata = dict(metadata or {})
    existing = existing_metadata if isinstance(existing_metadata, dict) else {}
    existing_cached_url = _metadata_text(existing, "logo_cached_url")
    if existing_cached_url:
        next_metadata["logo_cached_url"] = existing_cached_url
        return next_metadata
    logo_url = _metadata_text(next_metadata, "logo_url")
    if not logo_url:
        return next_metadata
    cached_url = cache_shop_logo(logo_url)
    if cached_url:
        next_metadata["logo_cached_url"] = cached_url[:8192]
    return next_metadata


def list_platform_accounts(
    db: Session,
    user: User,
    *,
    platform_code: str | None = None,
    include_inactive: bool = False,
) -> PlatformAccountListResponse:
    stmt = select(PlatformAccount).where(PlatformAccount.user_id == user.id)
    if platform_code:
        stmt = stmt.where(PlatformAccount.platform_code == platform_code)
    if not include_inactive:
        stmt = stmt.where(PlatformAccount.is_active.is_(True))
    items = list(db.scalars(stmt.order_by(PlatformAccount.created_at)).all())
    return PlatformAccountListResponse(
        items=[PlatformAccountRead.model_validate(item) for item in items],
        meta=PageMeta(total=len(items), limit=len(items), offset=0),
    )


def get_platform_account(db: Session, user: User, account_id: str) -> PlatformAccount:
    account = db.get(PlatformAccount, account_id)
    if not account or account.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Platform account not found")
    return account


def _shop_summary_metadata(account: PlatformAccount) -> dict:
    metadata = account.metadata_json if isinstance(account.metadata_json, dict) else {}
    value = metadata.get("shop_summary")
    return value if isinstance(value, dict) else {}


def _summary_products(db: Session, account: PlatformAccount) -> list[dict]:
    from app.services.product_service import _datetime
    snapshot = (account.metadata_json or {}).get('store_products') or {}
    stmt = select(StoreProduct).where(StoreProduct.platform_account_id == account.id, StoreProduct.user_id == account.user_id)
    if snapshot.get('collection_status') == 'empty':
        return []
    if isinstance(snapshot.get('product_ids'), list):
        stmt = stmt.where(StoreProduct.goods_id.in_(snapshot['product_ids']))
    else:
        observed = _datetime(snapshot.get('observed_at'))
        if snapshot.get('collection_status') not in (None, 'success'):
            return []
        if observed is None:
            observed = db.scalar(select(func.max(StoreProduct.last_observed_at)).where(
                StoreProduct.platform_account_id == account.id, StoreProduct.user_id == account.user_id))
        if observed is None:
            return []
        stmt = stmt.where(StoreProduct.last_observed_at == observed)
    products = list(db.scalars(stmt.order_by(StoreProduct.created_at, StoreProduct.id).limit(5001)).all())
    if len(products) > 5000:
        raise HTTPException(422, '本次摘要最多支持5000件已采集商品，原摘要未修改')
    return [
        {
            "title": str(product.title or "").strip(),
        }
        for product in products
        if str(product.title or "").strip()
    ]


async def generate_shop_summary(db: Session, user: User, account_id: str) -> PlatformAccount:
    account = get_platform_account(db, user, account_id)
    products = _summary_products(db, account)
    if not products:
        raise HTTPException(409, '暂无可用的在售商品资料，请先采集商品列表；原摘要未修改')
    previous_summary = dict(_shop_summary_metadata(account))
    settings = get_settings()
    ai_config = db.scalar(select(AiProviderConfig).where(AiProviderConfig.user_id == user.id))
    provider_config = {
        "provider": settings.ai_provider if settings.ai_provider_api_key else getattr(ai_config, "provider", ""),
        "base_url": settings.ai_provider_base_url if settings.ai_provider_api_key else getattr(ai_config, "base_url", ""),
        "model": getattr(ai_config, "model", "deepseek-v4-flash"),
        "api_key": settings.ai_provider_api_key or getattr(ai_config, "api_key", ""),
        "enabled": bool(settings.ai_provider_api_key or getattr(ai_config, "api_key", "")),
        "temperature": float(getattr(ai_config, "temperature", 0.2)),
    }
    if not provider_config['enabled']:
        raise HTTPException(503, '请先配置可用的AI模型；原摘要未修改')
    try:
        async with httpx.AsyncClient(base_url=settings.ai_reply_base_url.rstrip('/'), timeout=100, trust_env=False) as client:
            response = await client.post('/api/v1/shop-summaries/generate', json={
                'shop_name': shop_name(account), 'products': products, 'provider_config': provider_config})
            response.raise_for_status()
            payload = response.json()
        generated = {}
        for key, limit in [('shop_intro', 60), ('on_sale_products', 160)]:
            value = payload.get(key) if isinstance(payload, dict) else None
            if not isinstance(value, str) or not 0 < len(value.strip()) <= limit:
                raise ValueError('Invalid short summary')
            generated[key] = value.strip()
    except (httpx.HTTPError, ValueError) as exc:
        logger.warning('shop summary generation failed platform_account_id=%s error_type=%s', account.id, type(exc).__name__)
        raise HTTPException(502, '简短摘要生成失败或超时，请重试；原摘要未修改') from exc
    db.refresh(account)
    if _shop_summary_metadata(account) != previous_summary:
        raise HTTPException(409, '摘要在生成期间已被修改，请重新生成')
    metadata = dict(account.metadata_json or {})
    metadata["shop_summary"] = {
        **_shop_summary_metadata(account),
        **generated,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "edited_at": None,
    }
    account.metadata_json = metadata
    db.add(account)
    db.commit()
    db.refresh(account)
    return account


def update_shop_summary(
    db: Session,
    user: User,
    account_id: str,
    request: ShopSummaryUpdate,
) -> PlatformAccount:
    account = get_platform_account(db, user, account_id)
    metadata = dict(account.metadata_json or {})
    metadata["shop_summary"] = {
        **_shop_summary_metadata(account),
        "shop_intro": request.shop_intro.strip(),
        "on_sale_products": request.on_sale_products.strip(),
        "edited_at": datetime.now(timezone.utc).isoformat(),
    }
    account.metadata_json = metadata
    db.add(account)
    db.commit()
    db.refresh(account)
    return account


def create_or_sync_platform_account(
    db: Session,
    user: User,
    request: PlatformAccountCreate,
) -> PlatformAccount:
    _validate_node_ownership(db, user, request.last_rpa_node_id)
    account = _find_platform_account_by_local(db, user, request.platform_code, request.local_account_id)
    external_account = _find_platform_account_by_external(
        db,
        user,
        request.platform_code,
        request.external_account_id,
    )
    if external_account and account and external_account.id != account.id:
        account = _merge_platform_accounts_for_identity(
            db,
            primary=external_account,
            duplicate=account,
            request=request.model_copy(
                update={
                    "metadata_json": _with_cached_shop_logo(
                        request.metadata_json,
                        external_account.metadata_json,
                    )
                }
            ),
        )
    elif external_account and account is None:
        account = external_account
    metadata_json = _with_cached_shop_logo(
        request.metadata_json,
        account.metadata_json if account is not None else None,
    )
    account_alias = (request.account_alias or request.account_name).strip()
    if request.platform_code == 'qianniu':
        metadata_json = merge_profile_metadata(metadata_json, account.metadata_json if account else None, request.local_account_id)
        account_alias = profile_name(metadata_json, request.local_account_id) or '待识别店铺'
    if account is None:
        account = PlatformAccount(
            user_id=user.id,
            platform_code=request.platform_code,
            platform_name=platform_display_name(request.platform_code),
            local_account_id=request.local_account_id,
            account_name=request.account_name.strip(),
            account_alias=account_alias,
            external_account_id=request.external_account_id,
            name_source="workspace",
            is_active=True,
            login_status=request.login_status,
            last_seen_at=utcnow() if request.login_status == "online" else None,
            last_rpa_node_id=request.last_rpa_node_id,
            metadata_json=metadata_json,
        )
    else:
        account.local_account_id = request.local_account_id
        account.account_name = request.account_name.strip()
        account.account_alias = account_alias
        account.external_account_id = request.external_account_id or account.external_account_id
        account.login_status = request.login_status
        account.last_rpa_node_id = request.last_rpa_node_id or account.last_rpa_node_id
        account.is_active = True
        account.metadata_json = metadata_json if request.platform_code == 'qianniu' else {**account.metadata_json, **metadata_json}
        if request.login_status == "online":
            account.last_seen_at = utcnow()
    db.add(account)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="该拼多多店铺已绑定到当前账号",
        ) from exc
    db.refresh(account)
    return account


def _find_platform_account_by_local(
    db: Session,
    user: User,
    platform_code: str,
    local_account_id: str,
) -> PlatformAccount | None:
    return db.scalar(
        select(PlatformAccount).where(
            and_(
                PlatformAccount.user_id == user.id,
                PlatformAccount.platform_code == platform_code,
                PlatformAccount.local_account_id == local_account_id,
            )
        )
    )


def _find_platform_account_by_external(
    db: Session,
    user: User,
    platform_code: str,
    external_account_id: str | None,
) -> PlatformAccount | None:
    if not external_account_id:
        return None
    return db.scalar(
        select(PlatformAccount).where(
            and_(
                PlatformAccount.user_id == user.id,
                PlatformAccount.platform_code == platform_code,
                PlatformAccount.external_account_id == external_account_id,
            )
        )
    )


def resolve_merged_platform_account_id(
    db: Session,
    user: User,
    platform_account_id: str | None,
) -> str | None:
    if not platform_account_id:
        return None
    account = db.get(PlatformAccount, platform_account_id)
    if not account or account.user_id != user.id:
        return platform_account_id
    merged_into_id = (account.metadata_json or {}).get("merged_into_platform_account_id")
    if not isinstance(merged_into_id, str) or not merged_into_id:
        return platform_account_id
    merged_into = db.get(PlatformAccount, merged_into_id)
    if not merged_into or merged_into.user_id != user.id:
        return platform_account_id
    return merged_into.id


def _merge_platform_accounts_for_identity(
    db: Session,
    *,
    primary: PlatformAccount,
    duplicate: PlatformAccount,
    request: PlatformAccountCreate,
) -> PlatformAccount:
    now = utcnow()
    _move_duplicate_conversations(db, primary=primary, duplicate=duplicate, merged_at=now)
    _move_duplicate_customer_products(db, primary=primary, duplicate=duplicate)
    _move_duplicate_store_products(db, primary=primary, duplicate=duplicate)
    _move_duplicate_customer_outreach_runs(db, primary=primary, duplicate=duplicate)
    for model in (MessageObservation, RpaEvent, RpaTask, CustomerOrder, CustomerOutreachRun):
        db.query(model).filter(model.platform_account_id == duplicate.id).update(
            {model.platform_account_id: primary.id},
            synchronize_session=False,
        )
    for model in (EmailTemplate, RobotPlatformScope):
        for item in db.scalars(
            select(model).where(model.platform_account_id == duplicate.id)
        ).all():
            item.platform_account_id = primary.id
            db.add(item)
    duplicate.local_account_id = None
    duplicate.external_account_id = None
    duplicate.is_active = False
    duplicate.login_status = "offline"
    duplicate.metadata_json = {
        **(duplicate.metadata_json or {}),
        "merged_into_platform_account_id": primary.id,
        "merged_at": now.isoformat(),
        "merge_reason": "external_account_id_rebound",
    }
    db.add(duplicate)
    db.flush()
    primary.local_account_id = request.local_account_id
    primary.external_account_id = request.external_account_id or primary.external_account_id
    primary.metadata_json = {
        **(primary.metadata_json or {}),
        **(request.metadata_json or {}),
        "merged_from_platform_account_id": duplicate.id,
        "merged_at": now.isoformat(),
        "merge_reason": "external_account_id_rebound",
    }
    db.add(primary)
    db.flush()
    return primary


def _move_duplicate_conversations(
    db: Session,
    *,
    primary: PlatformAccount,
    duplicate: PlatformAccount,
    merged_at,
) -> None:
    conversations = list(
        db.scalars(
            select(Conversation).where(Conversation.platform_account_id == duplicate.id)
        ).all()
    )
    for conversation in conversations:
        existing = None
        if conversation.external_conversation_id:
            existing = db.scalar(
                select(Conversation).where(
                    and_(
                        Conversation.user_id == conversation.user_id,
                        Conversation.platform_code == conversation.platform_code,
                        Conversation.platform_account_id == primary.id,
                        Conversation.external_conversation_id == conversation.external_conversation_id,
                        Conversation.id != conversation.id,
                    )
                )
            )
        if existing:
            _merge_conversation_records(
                db,
                source=conversation,
                target=existing,
            )
            conversation.status = "merged"
            conversation.deleted_at = merged_at
            conversation.external_conversation_id = f"merged:{conversation.id}"
            conversation.platform_account_id = primary.id
            conversation.metadata_json = {
                **(conversation.metadata_json or {}),
                "merged_into_conversation_id": existing.id,
                "merged_at": merged_at.isoformat(),
                "merge_reason": "platform_account_identity_rebound",
            }
            db.add(conversation)
            continue
        conversation.platform_account_id = primary.id
        conversation.metadata_json = {
            **(conversation.metadata_json or {}),
            "merged_from_platform_account_id": duplicate.id,
            "merged_at": merged_at.isoformat(),
        }
        db.add(conversation)


def _merge_conversation_records(db: Session, *, source: Conversation, target: Conversation) -> None:
    target_messages_by_platform_id = {
        str(message.platform_message_id).strip(): message
        for message in db.scalars(
            select(Message).where(
                and_(
                    Message.conversation_id == target.id,
                    Message.platform_message_id.is_not(None),
                )
            )
        ).all()
        if str(message.platform_message_id or "").strip()
    }
    source_messages = list(
        db.scalars(
            select(Message)
            .where(Message.conversation_id == source.id)
            .order_by(Message.conversation_sequence, Message.created_at)
        ).all()
    )
    for message in source_messages:
        platform_message_id = str(message.platform_message_id or "").strip()
        existing = target_messages_by_platform_id.get(platform_message_id) if platform_message_id else None
        if existing:
            _merge_duplicate_message_record(db, source=message, target=existing)
            continue
        message.conversation_id = target.id
        message.conversation_sequence = None
        db.add(message)
        if platform_message_id:
            target_messages_by_platform_id[platform_message_id] = message
    for model in (
        MessageObservation,
        RpaTask,
        CustomerOrder,
        CustomerProduct,
        CustomerOutreachRun,
        ConversationWorkflow,
        EmailSendTask,
        AutomationReplyRun,
        AiModelCall,
    ):
        db.query(model).filter(model.conversation_id == source.id).update(
            {model.conversation_id: target.id},
            synchronize_session=False,
        )
    if source.latest_message_at and (
        not target.latest_message_at or source.latest_message_at > target.latest_message_at
    ):
        target.latest_message_at = source.latest_message_at
        target.latest_message_text = source.latest_message_text
    target.unread_count = max(target.unread_count or 0, source.unread_count or 0)
    target.awaiting_reply = bool(target.awaiting_reply or source.awaiting_reply)
    target.human_required = bool(target.human_required or source.human_required)
    if not target.customer_name and source.customer_name:
        target.customer_name = source.customer_name
    if not target.title and source.title:
        target.title = source.title
    target.metadata_json = {
        **(source.metadata_json or {}),
        **(target.metadata_json or {}),
        "merged_from_conversation_id": source.id,
    }
    db.add(target)


def _move_duplicate_customer_products(
    db: Session,
    *,
    primary: PlatformAccount,
    duplicate: PlatformAccount,
) -> None:
    products = list(db.scalars(
        select(CustomerProduct).where(CustomerProduct.platform_account_id == duplicate.id)
    ).all())
    for product in products:
        existing = db.scalar(select(CustomerProduct).where(
            CustomerProduct.platform_account_id == primary.id,
            CustomerProduct.customer_key == product.customer_key,
            CustomerProduct.platform_product_id == product.platform_product_id,
            CustomerProduct.id != product.id,
        ))
        if existing:
            if product.last_observed_at and (
                not existing.last_observed_at or product.last_observed_at > existing.last_observed_at
            ):
                existing.conversation_id = product.conversation_id
                existing.goods_id = product.goods_id or existing.goods_id
                existing.title = product.title or existing.title
                existing.image_url = product.image_url or existing.image_url
                existing.link_url = product.link_url or existing.link_url
                existing.price = product.price if product.price is not None else existing.price
                existing.price_label = product.price_label or existing.price_label
                existing.quantity = product.quantity if product.quantity is not None else existing.quantity
                existing.sold_quantity = (
                    product.sold_quantity if product.sold_quantity is not None else existing.sold_quantity
                )
                existing.sold_quantity_30d = (
                    product.sold_quantity_30d
                    if product.sold_quantity_30d is not None
                    else existing.sold_quantity_30d
                )
                existing.source = product.source or existing.source
                existing.last_observed_at = product.last_observed_at
                existing.raw_payload = product.raw_payload or existing.raw_payload
                db.add(existing)
            db.delete(product)
            continue
        product.platform_account_id = primary.id
        product.goods_id = product.goods_id or product.platform_product_id
        db.add(product)


def _move_duplicate_store_products(
    db: Session,
    *,
    primary: PlatformAccount,
    duplicate: PlatformAccount,
) -> None:
    products = list(db.scalars(
        select(StoreProduct).where(StoreProduct.platform_account_id == duplicate.id)
    ).all())
    for product in products:
        existing = db.scalar(select(StoreProduct).where(
            StoreProduct.platform_account_id == primary.id,
            StoreProduct.goods_id == product.goods_id,
            StoreProduct.id != product.id,
        ))
        if existing:
            if product.last_observed_at and (
                not existing.last_observed_at or product.last_observed_at > existing.last_observed_at
            ):
                existing.platform_product_id = product.platform_product_id or existing.platform_product_id
                existing.title = product.title or existing.title
                existing.image_url = product.image_url or existing.image_url
                existing.link_url = product.link_url or existing.link_url
                existing.price = product.price if product.price is not None else existing.price
                existing.price_label = product.price_label or existing.price_label
                existing.quantity = product.quantity if product.quantity is not None else existing.quantity
                existing.sold_quantity = (
                    product.sold_quantity
                    if product.sold_quantity is not None
                    else existing.sold_quantity
                )
                existing.sold_quantity_30d = (
                    product.sold_quantity_30d
                    if product.sold_quantity_30d is not None
                    else existing.sold_quantity_30d
                )
                existing.source = product.source or existing.source
                existing.last_observed_at = product.last_observed_at
                existing.raw_payload = product.raw_payload or existing.raw_payload
                db.add(existing)
            db.delete(product)
            continue
        product.platform_account_id = primary.id
        product.user_id = primary.user_id
        db.add(product)


def _move_duplicate_customer_outreach_runs(
    db: Session,
    *,
    primary: PlatformAccount,
    duplicate: PlatformAccount,
) -> None:
    runs = list(db.scalars(
        select(CustomerOutreachRun).where(CustomerOutreachRun.platform_account_id == duplicate.id)
    ).all())
    for run in runs:
        existing = db.scalar(select(CustomerOutreachRun).where(
            CustomerOutreachRun.platform_account_id == primary.id,
            CustomerOutreachRun.customer_key == run.customer_key,
            CustomerOutreachRun.strategy_type == run.strategy_type,
            CustomerOutreachRun.goods_id == run.goods_id,
            CustomerOutreachRun.id != run.id,
        ))
        if existing:
            if run.completed_at and not existing.completed_at:
                existing.robot_id = run.robot_id
                existing.conversation_id = run.conversation_id
                existing.order_id = run.order_id
                existing.source_message_id = run.source_message_id
                existing.status = run.status
                existing.due_at = run.due_at
                existing.decision_json = run.decision_json
                existing.message_text = run.message_text
                existing.message_id = run.message_id
                existing.send_task_id = run.send_task_id
                existing.cancel_reason = run.cancel_reason
                existing.completed_at = run.completed_at
                db.add(existing)
            db.delete(run)
            continue
        run.platform_account_id = primary.id
        run.goods_id = run.goods_id or ""
        db.add(run)


def _merge_duplicate_message_record(db: Session, *, source: Message, target: Message) -> None:
    if not target.platform_sent_at and source.platform_sent_at:
        target.platform_sent_at = source.platform_sent_at
        target.sent_at = source.platform_sent_at
    elif source.platform_sent_at and target.sent_at and source.platform_sent_at < target.sent_at:
        target.sent_at = source.platform_sent_at
    if not target.content and source.content:
        target.content = source.content
    if not target.sender_name and source.sender_name:
        target.sender_name = source.sender_name
    if not target.time_label and source.time_label:
        target.time_label = source.time_label
    if target.has_explicit_time is None and source.has_explicit_time is not None:
        target.has_explicit_time = source.has_explicit_time
    if not target.first_observation_id and source.first_observation_id:
        target.first_observation_id = source.first_observation_id
        target.first_dom_sequence = source.first_dom_sequence
    if not target.snapshot_id and source.snapshot_id:
        target.snapshot_id = source.snapshot_id
        target.snapshot_sequence = source.snapshot_sequence
    if source.collected_at and (not target.collected_at or source.collected_at < target.collected_at):
        target.collected_at = source.collected_at
    if source.observed_at and (not target.observed_at or source.observed_at > target.observed_at):
        target.observed_at = source.observed_at
    if target.collection_kind == "bootstrap" and source.collection_kind != "bootstrap":
        target.collection_kind = source.collection_kind
    target.automation_eligible = bool(target.automation_eligible or source.automation_eligible)
    target.raw_payload = {
        **(source.raw_payload if isinstance(source.raw_payload, dict) else {}),
        **(target.raw_payload if isinstance(target.raw_payload, dict) else {}),
        "merged_duplicate_message_id": source.id,
    }
    for run in db.scalars(
        select(AutomationReplyRun).where(AutomationReplyRun.source_message_id == source.id)
    ).all():
        existing_run = db.scalar(
            select(AutomationReplyRun).where(
                and_(
                    AutomationReplyRun.robot_id == run.robot_id,
                    AutomationReplyRun.source_message_id == target.id,
                    AutomationReplyRun.id != run.id,
                )
            )
        )
        if existing_run:
            if run.reply_message_id and not existing_run.reply_message_id:
                existing_run.reply_message_id = run.reply_message_id
            if run.send_task_id and not existing_run.send_task_id:
                existing_run.send_task_id = run.send_task_id
            db.add(existing_run)
            db.delete(run)
        else:
            run.source_message_id = target.id
            db.add(run)
    for model, column in (
        (CustomerOutreachRun, CustomerOutreachRun.source_message_id),
        (CustomerOutreachRun, CustomerOutreachRun.message_id),
        (ConversationWorkflow, ConversationWorkflow.source_message_id),
        (EmailSendTask, EmailSendTask.source_message_id),
        (RpaTask, RpaTask.message_id),
        (AutomationReplyRun, AutomationReplyRun.reply_message_id),
    ):
        db.query(model).filter(column == source.id).update(
            {column: target.id},
            synchronize_session=False,
        )
    db.add(target)
    db.delete(source)


def update_platform_account(
    db: Session,
    user: User,
    account_id: str,
    request: PlatformAccountUpdate,
) -> PlatformAccount:
    account = get_platform_account(db, user, account_id)
    _validate_node_ownership(db, user, request.last_rpa_node_id)
    updates = request.model_dump(exclude_unset=True)
    for field, value in updates.items():
        if field == "metadata_json" and value is not None:
            account.metadata_json = {**account.metadata_json, **value}
        else:
            setattr(account, field, value)
    if request.login_status == "online":
        account.last_seen_at = utcnow()
    db.add(account)
    db.commit()
    db.refresh(account)
    return account


def deactivate_platform_account(db: Session, user: User, account_id: str) -> None:
    account = get_platform_account(db, user, account_id)
    account.is_active = False
    account.login_status = "offline"
    db.add(account)
    db.commit()


def sync_platform_accounts_for_node(
    db: Session,
    user: User,
    node: RpaNode,
    items: list[PlatformAccountSyncItem],
    *,
    platform_code: str = "pinduoduo",
) -> list[PlatformAccount]:
    if any(item.platform_code != platform_code for item in items):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Mixed platform account sync is not supported",
        )
    local_ids = {item.local_account_id for item in items}
    existing = db.scalars(
        select(PlatformAccount).where(
            and_(
                PlatformAccount.user_id == user.id,
                PlatformAccount.platform_code == platform_code,
                PlatformAccount.local_account_id.is_not(None),
            )
        )
    ).all()
    for account in existing:
        if account.local_account_id not in local_ids:
            account.is_active = False
            account.login_status = "offline"
            db.add(account)
    db.commit()

    synced: list[PlatformAccount] = []
    for item in items:
        account = create_or_sync_platform_account(
            db,
            user,
            PlatformAccountCreate(
                platform_code=platform_code,
                local_account_id=item.local_account_id,
                account_name=item.account_name,
                account_alias=item.account_alias,
                external_account_id=item.external_account_id,
                login_status=item.login_status,
                last_rpa_node_id=node.id,
                metadata_json=item.metadata_json,
            ),
        )
        account.is_active = not item.archived
        if item.archived:
            account.login_status = "offline"
        db.add(account)
        db.commit()
        db.refresh(account)
        synced.append(account)
    return synced


def _validate_node_ownership(db: Session, user: User, node_id: str | None) -> None:
    if not node_id:
        return
    node = db.get(RpaNode, node_id)
    if not node or node.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="RPA node not found")
