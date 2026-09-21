from __future__ import annotations

from datetime import timedelta
import re

from fastapi import HTTPException, status
from sqlalchemy import and_, delete, desc, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.core.security import utcnow
from app.models import (
    AiModelCall,
    AutomationReplyRun,
    Conversation,
    ConversationWorkflow,
    CustomerOrder,
    CustomerProduct,
    CustomerOutreachRun,
    EmailSendTask,
    Message,
    MessageObservation,
    RpaEvent,
    RpaTask,
    User,
)
from app.schemas.common import PageMeta
from app.schemas.conversation import (
    ConversationListResponse,
    ConversationRead,
    ConversationSyncIssueDetailResponse,
    ConversationSyncIssueMessageRead,
    ConversationSyncIssueRead,
)
from app.schemas.message import (
    MessageListResponse,
    MessageRead,
    PlatformMessageExistsResponse,
    RecordSentMessageRequest,
    RecordSentMessageResponse,
    SendMessageRequest,
    SendMessageResponse,
)
from app.schemas.platform import PLATFORM_DISPLAY_NAMES
from app.services.message_observation_service import (
    SnapshotProtocolError,
    build_snapshot_messages,
    snapshot_messages_from_observation,
)
from app.services.message_queue_service import append_message, append_messages


PLACEHOLDER_SHOP_NAMES = {
    "\u5f85\u8bc6\u522b\u5e97\u94fa\u540d\u79f0",
    "\u62fc\u591a\u591a",
    "\u62fc\u591a\u591a\u5546\u5bb6\u540e\u53f0",
    "\u62fc\u591a\u591a\u5546\u5bb6\u7ba1\u7406\u540e\u53f0",
    "\u62fc\u591a\u591a\u5ba2\u670d\u5e73\u53f0",
    "\u5546\u5bb6\u540e\u53f0",
    "\u5ba2\u670d\u5e73\u53f0",
}
NUMBERED_PDD_SHOP_NAME = re.compile(r"^\u62fc\u591a\u591a\u5e97\u94fa\s*\d+$")


def _pdd_platform_message_order_key(message: Message) -> tuple[int, int | str, int]:
    platform_message_id = str(message.platform_message_id or "").strip()
    fallback_sequence = int(message.conversation_sequence or 0)
    if platform_message_id.isdigit():
        return (0, int(platform_message_id), fallback_sequence)
    if platform_message_id:
        return (1, platform_message_id, fallback_sequence)
    return (2, fallback_sequence, fallback_sequence)


def _valid_shop_name(value: str | None) -> str | None:
    name = (value or "").strip()
    if not name or name in PLACEHOLDER_SHOP_NAMES or NUMBERED_PDD_SHOP_NAME.fullmatch(name):
        return None
    return name


def _metadata_text(metadata: dict, key: str) -> str | None:
    value = metadata.get(key)
    if not isinstance(value, str):
        return None
    cleaned = value.strip()
    return cleaned or None


def _conversation_read(conversation: Conversation, db: Session | None = None) -> ConversationRead:
    from app.services.qianniu_transfer_service import current_operation
    from app.services.douyin_transfer_service import current_operation as douyin_operation
    from app.services.pdd_auto_transfer import state as pdd_operation
    from app.services.qianniu_shop_profile import shop_name as qianniu_shop_name
    account = conversation.platform_account
    platform_name = (
        account.platform_name
        if account and account.platform_name
        else PLATFORM_DISPLAY_NAMES.get(conversation.platform_code, conversation.platform_code)
    )
    shop_name = None
    if account:
        shop_name = _valid_shop_name(account.account_alias) or _valid_shop_name(account.account_name)
    account_metadata = account.metadata_json if account and isinstance(account.metadata_json, dict) else {}
    shop_logo_url = (
        _metadata_text(account_metadata, "logo_cached_url")
        or _metadata_text(account_metadata, "logo_url")
    )
    shop_service_username = _metadata_text(account_metadata, "cs_username")
    if conversation.platform_code == 'qianniu':
        shop_name = qianniu_shop_name(account) or '待识别店铺'
        shop_service_username = _metadata_text(account_metadata, 'service_account_name') or (account.account_name if account else None)
    shop_is_mall_owner = account_metadata.get("is_mall_owner") is True
    metadata = conversation.metadata_json or {}
    if not shop_name:
        metadata_shop_name = metadata.get("shop_name")
        shop_name = _valid_shop_name(metadata_shop_name if isinstance(metadata_shop_name, str) else None)
    raw_issue = metadata.get("message_sync_issue")
    message_sync_issue = None
    if isinstance(raw_issue, dict) and raw_issue.get("status") == "active":
        try:
            message_sync_issue = ConversationSyncIssueRead.model_validate(raw_issue)
        except ValueError:
            message_sync_issue = None
    latest_customer_message_at = None
    if db is not None:
        latest_customer_message_at = db.scalar(
            select(Message.platform_sent_at)
            .where(
                Message.conversation_id == conversation.id,
                Message.sender_role == "customer",
                Message.message_status == "sent",
            )
            .order_by(desc(Message.conversation_sequence))
            .limit(1)
        )
        if latest_customer_message_at is None:
            latest_customer_message_at = db.scalar(
                select(Message.sent_at)
                .where(
                    Message.conversation_id == conversation.id,
                    Message.sender_role == "customer",
                    Message.message_status == "sent",
                )
                .order_by(desc(Message.conversation_sequence))
                .limit(1)
            )
    return ConversationRead.model_validate(conversation).model_copy(update={
        "metadata_json": ({**metadata, "qianniu_transfer": current_operation(db, conversation)}
            if db is not None and conversation.platform_code == 'qianniu' else
            {**metadata, 'douyin_transfer': douyin_operation(db, conversation)}
            if db is not None and conversation.platform_code == 'douyin' else
            {**metadata, 'auto_transfer': pdd_operation(conversation)} if conversation.platform_code == 'pinduoduo' else metadata),
        "platform_name": platform_name,
        "shop_name": shop_name,
        "shop_logo_url": shop_logo_url,
        "shop_service_username": shop_service_username,
        "shop_is_mall_owner": shop_is_mall_owner,
        "latest_customer_message_at": latest_customer_message_at,
        "avatar_url": (
            _metadata_text(metadata, "customer_avatar_cached_url")
            or _metadata_text(metadata, "customer_avatar_url")
            or _metadata_text(metadata, "avatar_url")
        ),
        "message_sync_issue": message_sync_issue,
    })


def list_conversations(
    db: Session,
    user: User,
    *,
    platform_code: str | None = None,
    status_filter: str | None = None,
    limit: int = 20,
    offset: int = 0,
) -> ConversationListResponse:
    stmt = (
        select(Conversation)
        .options(selectinload(Conversation.platform_account))
        .where(Conversation.user_id == user.id, Conversation.deleted_at.is_(None))
    )
    count_stmt = select(func.count()).select_from(Conversation).where(
        Conversation.user_id == user.id,
        Conversation.deleted_at.is_(None),
    )
    if platform_code:
        stmt = stmt.where(Conversation.platform_code == platform_code)
        count_stmt = count_stmt.where(Conversation.platform_code == platform_code)
    if status_filter:
        stmt = stmt.where(Conversation.status == status_filter)
        count_stmt = count_stmt.where(Conversation.status == status_filter)
    total = db.scalar(count_stmt) or 0
    items = list(
        db.scalars(
            stmt.order_by(desc(Conversation.latest_message_at), desc(Conversation.updated_at))
            .offset(offset)
            .limit(limit)
        ).all()
    )
    return ConversationListResponse(
        items=[_conversation_read(item, db) for item in items],
        meta=PageMeta(total=total, limit=limit, offset=offset),
    )


def get_conversation(db: Session, user: User, conversation_id: str) -> ConversationRead:
    conversation = db.scalar(
        select(Conversation)
        .options(selectinload(Conversation.platform_account))
        .where(and_(Conversation.id == conversation_id, Conversation.user_id == user.id))
    )
    if not conversation:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found")
    return _conversation_read(conversation, db)


def clear_human_required(db: Session, user: User, conversation_id: str) -> ConversationRead:
    conversation = db.scalar(
        select(Conversation)
        .options(selectinload(Conversation.platform_account))
        .where(and_(Conversation.id == conversation_id, Conversation.user_id == user.id))
    )
    if not conversation:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found")
    conversation.human_required = False
    conversation.human_required_reason = None
    conversation.human_required_word = None
    conversation.human_required_at = None
    db.add(conversation)
    db.commit()
    db.refresh(conversation)
    return _conversation_read(conversation, db)


def clear_awaiting_reply(db: Session, user: User, conversation_id: str) -> ConversationRead:
    conversation = db.scalar(
        select(Conversation)
        .options(selectinload(Conversation.platform_account))
        .where(and_(Conversation.id == conversation_id, Conversation.user_id == user.id))
    )
    if not conversation:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found")
    metadata = dict(conversation.metadata_json or {})
    metadata["awaiting_reply_cleared_sequence"] = int(conversation.last_message_sequence or 0)
    metadata["awaiting_reply_cleared_at"] = utcnow().isoformat()
    conversation.metadata_json = metadata
    conversation.awaiting_reply = False
    conversation.unread_count = 0
    db.add(conversation)
    db.commit()
    db.refresh(conversation)
    return _conversation_read(conversation, db)


_ACTIVE_CONVERSATION_TASK_STATUSES = {
    "waiting_timeout", "queued", "dispatched", "acknowledged", "confirmation_pending"
}


def _ensure_conversation_can_be_cleared(db: Session, conversation: Conversation) -> None:
    active_task_count = db.scalar(
        select(func.count())
        .select_from(RpaTask)
        .where(
            RpaTask.conversation_id == conversation.id,
            RpaTask.status.in_(_ACTIVE_CONVERSATION_TASK_STATUSES),
        )
    ) or 0
    active_reply_count = db.scalar(
        select(func.count())
        .select_from(AutomationReplyRun)
        .where(
            AutomationReplyRun.conversation_id == conversation.id,
            AutomationReplyRun.status.in_(["pending", "running"]),
        )
    ) or 0
    if active_task_count or active_reply_count:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Conversation has active processing tasks. Please try again later.",
        )


def _delete_conversation_pipeline_rows(
    db: Session,
    user: User,
    conversation: Conversation,
    *,
    include_orders: bool,
) -> dict[str, int]:
    deleted_counts: dict[str, int] = {}

    def delete_conversation_rows(model: type, key: str) -> None:
        result = db.execute(delete(model).where(model.conversation_id == conversation.id))
        deleted_counts[key] = max(0, int(result.rowcount or 0))

    # Delete dependants before messages because SQLite foreign-key enforcement
    # differs between existing deployments and in-memory tests.
    delete_conversation_rows(AiModelCall, "ai_model_calls")
    delete_conversation_rows(AutomationReplyRun, "automation_reply_runs")
    delete_conversation_rows(EmailSendTask, "email_send_tasks")
    delete_conversation_rows(ConversationWorkflow, "conversation_workflows")
    delete_conversation_rows(CustomerOutreachRun, "customer_outreach_runs")
    if include_orders:
        delete_conversation_rows(CustomerOrder, "customer_orders")
        delete_conversation_rows(CustomerProduct, "customer_products")
    delete_conversation_rows(RpaTask, "rpa_tasks")
    delete_conversation_rows(MessageObservation, "message_observations")
    delete_conversation_rows(Message, "messages")

    event_conditions = [
        RpaEvent.user_id == user.id,
        RpaEvent.platform_account_id == conversation.platform_account_id,
        RpaEvent.platform_code == conversation.platform_code,
        RpaEvent.conversation_external_id == conversation.external_conversation_id,
    ]
    event_result = db.execute(delete(RpaEvent).where(and_(*event_conditions)))
    deleted_counts["rpa_events"] = max(0, int(event_result.rowcount or 0))
    return deleted_counts


def _active_message_sync_issue(conversation: Conversation) -> tuple[dict, ConversationSyncIssueRead]:
    raw_issue = (conversation.metadata_json or {}).get("message_sync_issue")
    if not isinstance(raw_issue, dict) or raw_issue.get("status") != "active":
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Conversation has no active message sync issue",
        )
    try:
        return raw_issue, ConversationSyncIssueRead.model_validate(raw_issue)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Conversation message sync issue is invalid",
        ) from exc


def _message_sync_issue_observation(
    db: Session,
    user: User,
    conversation: Conversation,
    issue: ConversationSyncIssueRead,
) -> MessageObservation:
    observation = db.scalar(select(MessageObservation).where(
        MessageObservation.observation_id == issue.observation_id,
        MessageObservation.user_id == user.id,
        MessageObservation.conversation_id == conversation.id,
        MessageObservation.alignment_status == "unaligned",
    ))
    if not observation:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="The failed snapshot is no longer available",
        )
    return observation


def get_conversation_message_sync_issue(
    db: Session,
    user: User,
    conversation_id: str,
) -> ConversationSyncIssueDetailResponse:
    conversation = db.get(Conversation, conversation_id)
    if not conversation or conversation.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found")
    _, issue = _active_message_sync_issue(conversation)
    observation = _message_sync_issue_observation(db, user, conversation, issue)
    try:
        messages = snapshot_messages_from_observation(observation)
    except SnapshotProtocolError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    return ConversationSyncIssueDetailResponse(
        conversation_id=conversation.id,
        issue=issue,
        messages=[ConversationSyncIssueMessageRead(
            dom_sequence=int(item.get("dom_sequence") or index),
            sender_role=str(item.get("sender_role") or "platform"),
            message_type=str(item.get("message_type") or item.get("media_type") or "text"),
            content=str(item.get("content") or ""),
            display_mode=str(item.get("display_mode") or "bubble"),
            automation_mode=str(item.get("automation_mode") or "trigger"),
            time_label=str(item.get("time_label")) if item.get("time_label") else None,
            structured_payload=(
                item.get("structured_payload")
                if isinstance(item.get("structured_payload"), dict)
                else None
            ),
        ) for index, item in enumerate(messages)],
    )


def dismiss_conversation_message_sync_issue(
    db: Session,
    user: User,
    conversation_id: str,
) -> ConversationRead:
    conversation = db.scalar(
        select(Conversation)
        .options(selectinload(Conversation.platform_account))
        .where(and_(Conversation.id == conversation_id, Conversation.user_id == user.id))
    )
    if not conversation:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found")
    raw_issue, _ = _active_message_sync_issue(conversation)
    metadata = dict(conversation.metadata_json or {})
    metadata["message_sync_issue"] = {
        **raw_issue,
        "requires_attention": False,
        "dismissed_at": utcnow().isoformat(),
    }
    conversation.metadata_json = metadata
    db.add(conversation)
    db.commit()
    db.refresh(conversation)
    return _conversation_read(conversation, db)


def rebuild_conversation_message_queue(
    db: Session,
    user: User,
    conversation_id: str,
) -> tuple[ConversationRead, list[MessageRead], dict[str, int]]:
    conversation = db.scalar(
        select(Conversation)
        .options(selectinload(Conversation.platform_account))
        .where(and_(Conversation.id == conversation_id, Conversation.user_id == user.id))
    )
    if not conversation:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found")
    if conversation.platform_code != "pinduoduo":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only Pinduoduo conversations support message queue rebuild",
        )
    _ensure_conversation_can_be_cleared(db, conversation)
    raw_issue, issue = _active_message_sync_issue(conversation)
    observation = _message_sync_issue_observation(db, user, conversation, issue)
    try:
        snapshot_messages = snapshot_messages_from_observation(observation)
    except SnapshotProtocolError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    recovery_messages = build_snapshot_messages(
        user,
        conversation,
        observation,
        snapshot_messages,
        collection_kind="recovery",
    )

    deleted_counts = _delete_conversation_pipeline_rows(
        db,
        user,
        conversation,
        include_orders=False,
    )
    conversation.latest_message_text = None
    conversation.latest_message_at = None
    conversation.unread_count = 0
    conversation.last_message_sequence = 0
    conversation.messages_cleared_sequence = 0
    conversation.deleted_at = None
    conversation.awaiting_reply = False
    conversation.human_required = False
    conversation.human_required_reason = None
    conversation.human_required_word = None
    conversation.human_required_at = None
    conversation.status = "active"
    metadata = dict(conversation.metadata_json or {})
    metadata["message_sync_issue"] = {
        **raw_issue,
        "status": "resolved",
        "requires_attention": False,
        "resolved_at": utcnow().isoformat(),
        "resolution": "manual_rebuild",
    }
    conversation.metadata_json = metadata
    db.add(conversation)
    db.flush()
    append_messages(
        db,
        recovery_messages,
        collected_at=observation.collected_at,
        collection_kind="recovery",
    )
    if recovery_messages:
        conversational_tail = next((
            item for item in reversed(recovery_messages)
            if (item.raw_payload or {}).get("automation_mode") in {"trigger", "context"}
        ), None)
        trigger_tail = next((
            item for item in reversed(recovery_messages)
            if (item.raw_payload or {}).get("automation_mode", "trigger") == "trigger"
        ), None)
        if conversational_tail is not None:
            conversation.latest_message_text = conversational_tail.content
        conversation.latest_message_at = observation.collected_at
        conversation.unread_count = 1 if observation.unread else 0
        conversation.awaiting_reply = bool(
            trigger_tail is not None and trigger_tail.sender_role == "customer"
        )
    db.add(conversation)
    db.commit()
    db.refresh(conversation)
    return (
        _conversation_read(conversation, db),
        [MessageRead.model_validate(item) for item in recovery_messages],
        deleted_counts,
    )


def clear_conversation_history(db: Session, user: User, conversation_id: str) -> ConversationRead:
    conversation = db.scalar(
        select(Conversation)
        .options(selectinload(Conversation.platform_account))
        .where(and_(Conversation.id == conversation_id, Conversation.user_id == user.id))
    )
    if not conversation:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found")
    _ensure_conversation_can_be_cleared(db, conversation)
    if conversation.platform_code == "pinduoduo":
        response, _ = reset_pinduoduo_conversation_test_data(
            db,
            user,
            conversation_id,
            delete_after_reset=False,
        )
        return response
    conversation.messages_cleared_sequence = max(
        conversation.messages_cleared_sequence,
        conversation.last_message_sequence,
    )
    conversation.latest_message_text = None
    conversation.latest_message_at = None
    conversation.unread_count = 0
    conversation.awaiting_reply = False
    conversation.human_required = False
    conversation.human_required_reason = None
    conversation.human_required_word = None
    conversation.human_required_at = None
    db.add(conversation)
    db.commit()
    db.refresh(conversation)
    return _conversation_read(conversation, db)


def soft_delete_conversation(db: Session, user: User, conversation_id: str) -> ConversationRead:
    conversation = db.scalar(
        select(Conversation)
        .options(selectinload(Conversation.platform_account))
        .where(and_(Conversation.id == conversation_id, Conversation.user_id == user.id))
    )
    if not conversation:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found")
    _ensure_conversation_can_be_cleared(db, conversation)
    if conversation.platform_code == "pinduoduo":
        response, _ = reset_pinduoduo_conversation_test_data(
            db,
            user,
            conversation_id,
            delete_after_reset=True,
        )
        return response
    conversation.deleted_at = utcnow()
    conversation.unread_count = 0
    conversation.awaiting_reply = False
    db.add(conversation)
    db.commit()
    db.refresh(conversation)
    return _conversation_read(conversation, db)


def reset_pinduoduo_conversation_test_data(
    db: Session,
    user: User,
    conversation_id: str,
    *,
    delete_after_reset: bool = False,
) -> tuple[ConversationRead, dict[str, int]]:
    conversation = db.get(Conversation, conversation_id)
    if not conversation or conversation.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found")
    if conversation.platform_code != "pinduoduo":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only Pinduoduo conversations support test reset",
        )
    if not conversation.platform_account_id or not conversation.external_conversation_id:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Conversation must have a bound shop and external conversation ID before reset",
        )
    active_task_count = db.scalar(
        select(func.count())
        .select_from(RpaTask)
        .where(
            RpaTask.conversation_id == conversation.id,
            RpaTask.status.in_(["queued", "dispatched", "acknowledged"]),
        )
    ) or 0
    if active_task_count:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Conversation has active RPA tasks; wait for them to finish before resetting",
        )

    deleted_counts = _delete_conversation_pipeline_rows(
        db,
        user,
        conversation,
        include_orders=True,
    )

    conversation.latest_message_text = None
    conversation.latest_message_at = None
    conversation.unread_count = 0
    conversation.last_message_sequence = 0
    conversation.messages_cleared_sequence = 0
    conversation.deleted_at = utcnow() if delete_after_reset else None
    conversation.awaiting_reply = False
    conversation.human_required = False
    conversation.human_required_reason = None
    conversation.human_required_word = None
    conversation.human_required_at = None
    conversation.status = "active"
    metadata = dict(conversation.metadata_json or {})
    metadata.pop("message_sync_issue", None)
    metadata.pop("customer_orders", None)
    metadata.pop("customer_products", None)
    conversation.metadata_json = metadata
    db.add(conversation)
    db.commit()
    db.refresh(conversation)
    return _conversation_read(conversation, db), deleted_counts


def list_messages(
    db: Session,
    user: User,
    conversation_id: str,
    *,
    limit: int = 50,
    offset: int = 0,
) -> MessageListResponse:
    conversation = db.get(Conversation, conversation_id)
    if not conversation or conversation.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found")
    visible_conditions = [
        Message.conversation_id == conversation_id,
        Message.user_id == user.id,
        Message.conversation_sequence > conversation.messages_cleared_sequence,
    ]
    if conversation.platform_code == "pinduoduo":
        visible_conditions.append(Message.message_status != "failed")
    visible_messages = and_(*visible_conditions)
    count_stmt = (
        select(func.count())
        .select_from(Message)
        .where(visible_messages)
    )
    total = db.scalar(count_stmt) or 0
    if conversation.platform_code == "pinduoduo":
        ordered = sorted(
            db.scalars(select(Message).where(visible_messages)).all(),
            key=_pdd_platform_message_order_key,
        )
        end = max(total - offset, 0)
        start = max(end - limit, 0)
        return MessageListResponse(
            items=[MessageRead.model_validate(item) for item in ordered[start:end]],
            meta=PageMeta(total=total, limit=limit, offset=offset),
        )
    order = [desc(Message.conversation_sequence)]
    if conversation.platform_code in {"qianniu", "douyin"}:
        # Late history belongs at its platform time; permanent sequences still define clearing.
        order = [
            desc(func.coalesce(Message.platform_sent_at, Message.collected_at)),
            desc(Message.conversation_sequence),
            desc(Message.id),
        ]
    # Select the newest page in display order, then return it oldest first.
    stmt = (
        select(Message)
        .where(visible_messages)
        .order_by(*order)
        .offset(offset)
        .limit(limit)
    )
    items = list(reversed(db.scalars(stmt).all()))
    return MessageListResponse(
        items=[MessageRead.model_validate(item) for item in items],
        meta=PageMeta(total=total, limit=limit, offset=offset),
    )


def platform_message_exists(
    db: Session,
    user: User,
    *,
    platform_account_id: str,
    conversation_external_id: str,
    platform_message_id: str,
) -> PlatformMessageExistsResponse:
    conversation = db.scalar(
        select(Conversation).where(
            Conversation.user_id == user.id,
            Conversation.platform_account_id == platform_account_id,
            Conversation.external_conversation_id == conversation_external_id,
            Conversation.deleted_at.is_(None),
        )
    )
    if not conversation:
        return PlatformMessageExistsResponse(exists=False)
    message = db.scalar(
        select(Message).where(
            Message.user_id == user.id,
            Message.conversation_id == conversation.id,
            Message.platform_message_id == platform_message_id,
        )
    )
    return PlatformMessageExistsResponse(
        exists=message is not None,
        conversation_id=conversation.id,
        message_id=message.id if message else None,
    )


def create_send_task(
    db: Session,
    user: User,
    request: SendMessageRequest,
    *,
    follow_up: dict[str, object] | None = None,
    follow_up_products: list[dict[str, object]] | None = None,
    idempotency_key: str | None = None,
    source: str = "desktop",
    task_status: str = "queued",
    automation_context: dict[str, str] | None = None,
) -> SendMessageResponse:
    conversation = db.get(Conversation, request.conversation_id)
    if not conversation or conversation.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found")
    if source != "desktop":
        from app.services.qianniu_product_links import outbound_reason
        prohibited_reason = outbound_reason(db, conversation, request.content)
        if prohibited_reason:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Outbound content contains prohibited platform contact/link content: {prohibited_reason}",
            )
    if conversation.platform_code == 'qianniu' and source != 'desktop':
        from app.services.outbound_safety import qianniu_outbound_reason
        reason = qianniu_outbound_reason(request.content)
        if reason:
            raise HTTPException(422, reason)
    from app.services.qianniu_transfer_service import transfer_blocked
    from app.services.qianniu_transfer_service import current_operation
    op = (current_operation(db, conversation) or {}) if conversation.platform_code == 'qianniu' else {}
    if source != 'desktop' and conversation.human_required and op.get('source') == 'automation' and op.get('status') == 'failed':
        raise HTTPException(409, '千牛自动转接失败，该会话需要人工处理')
    ack_creation = (source == 'automation' and request.content == '为您转接中'
        and op.get('status') == 'ack_queued' and (automation_context or {}).get('qianniu_auto_operation_id') == op.get('id')
        and idempotency_key == 'qn-transfer-ack:' + str(op.get('id')))
    if transfer_blocked(conversation) and not ack_creation:
        raise HTTPException(409, '千牛会话正在转接、已转接或结果待确认，已阻止发送')
    if conversation.platform_code == "douyin" and request.client_message_id:
        idempotency_key = f"douyin-manual:{user.id}:{conversation.id}:{request.client_message_id}"
    if idempotency_key:
        existing_task = db.scalar(select(RpaTask).where(
            RpaTask.user_id == user.id,
            RpaTask.idempotency_key == idempotency_key,
        ))
        if existing_task and existing_task.message_id:
            existing_message = db.get(Message, existing_task.message_id)
            if existing_message:
                if conversation.platform_code == "douyin" and existing_message.content != request.content:
                    raise HTTPException(status_code=409, detail="发送请求标识已用于另一条文本")
                return SendMessageResponse(
                    message=MessageRead.model_validate(existing_message),
                    task_id=existing_task.id,
                    task_status=existing_task.status,
                    follow_up_message=None,
                    follow_up_messages=[],
                )

    if conversation.platform_code == 'pinduoduo':
        from app.services.pdd_auto_transfer import blocked as pdd_blocked, state as pdd_state
        pdd_op = pdd_state(conversation)
        pdd_ack = (source == 'automation' and request.content == '为您转接中'
            and pdd_op.get('status') == 'ack_queued'
            and idempotency_key == 'pdd-transfer-ack:' + str(pdd_op.get('id'))
            and (automation_context or {}).get('pdd_auto_operation_id') == pdd_op.get('id'))
        if pdd_blocked(conversation) and not pdd_ack:
            raise HTTPException(409, '会话正在转接、已转出或结果待核对，已暂停发送')
    platform_code = request.platform_code or conversation.platform_code
    if "douyin" in {conversation.platform_code, platform_code}:
        from app.services.douyin_transfer_service import transfer_blocked as douyin_transfer_blocked
        from app.services.douyin_auto_transfer import ack_creation_allowed
        douyin_ack = ack_creation_allowed(db, conversation, request.content, source,
                                         idempotency_key, automation_context or {})
        if douyin_transfer_blocked(conversation) and not douyin_ack:
            raise HTTPException(409, '会话正在转接、已转出或结果待核对，已暂停发送')
        account = conversation.platform_account
        metadata = (account.metadata_json or {}) if account else {}
        suffix = f":{account.external_account_id}::2:1:pigeon" if account else ""
        cid = conversation.external_conversation_id or ""
        if (conversation.platform_code != "douyin" or platform_code != "douyin" or source not in {"desktop", "automation"}
            or follow_up or follow_up_products or request.quote_message_id
            or conversation.deleted_at is not None or not account or account.user_id != user.id
            or account.platform_code != "douyin" or not account.is_active or not account.external_account_id
            or account.login_status != "online" or not account.last_rpa_node_id
            or metadata.get("message_send_enabled") is not True or metadata.get("im_ready") is not True
            or not cid.endswith(suffix) or not cid[:-len(suffix)] or ":" in cid[:-len(suffix)]):
            raise HTTPException(status_code=409, detail="抖店当前仅支持已登录店铺的纯文本发送，请检查飞鸽客服工作台")
        if source == "automation" and not douyin_ack:
            from app.models import Robot
            from app.services.douyin_automation import reply_block_reason
            context = automation_context or {}
            robot_id = context.get("automation_robot_id")
            source_id = context.get("automation_source_message_id")
            reason = reply_block_reason(db, conversation,
                db.get(Message, source_id) if source_id else None,
                db.get(Robot, robot_id) if robot_id else None, sending=True)
            if reason:
                raise HTTPException(status_code=409, detail=reason)
        if not request.content.strip() or len(request.content) > 4000:
            raise HTTPException(status_code=422, detail="文本不能为空且不能超过 4000 个字符")
        pending = db.scalar(select(RpaTask).where(
            RpaTask.conversation_id == conversation.id,
            RpaTask.task_type.notin_(['refresh_product_details', 'refresh_customer_orders', 'douyin_manual_transfer']),
            RpaTask.status.in_(["queued", "dispatched", "acknowledged", "confirmation_pending"]),
        ))
        if pending:
            raise HTTPException(status_code=409, detail="该会话仍有消息发送中或待确认，请先在原平台核对")
    now = utcnow()
    raw_payload = {
        **({"quote_msg_id": request.quote_message_id} if request.quote_message_id else {}),
        **({"structured_payload": {"quote_msg_id": request.quote_message_id}} if request.quote_message_id else {}),
    }
    message = Message(
        conversation_id=conversation.id,
        user_id=user.id,
        platform_code=platform_code,
        sender_role="agent",
        sender_name=request.sender_name or user.display_name,
        content=request.content,
        message_status="queued",
        source=source,
        raw_payload=raw_payload,
        observed_at=now,
        sent_at=now,
    )
    append_message(db, message, collected_at=now)
    db.flush()
    follow_up_message: Message | None = None
    follow_up_messages: list[Message] = []
    follow_up_product_messages: list[Message] = []
    follow_up_payload = follow_up if isinstance(follow_up, dict) else None
    if (
        source != "desktop"
        and follow_up_payload
        and follow_up_payload.get("type") == "image"
        and follow_up_payload.get("url")
    ):
        follow_up_message = Message(
            conversation_id=conversation.id,
            user_id=user.id,
            platform_code=platform_code,
            sender_role="agent",
            sender_name=request.sender_name or user.display_name,
            content="[å¾ç]",
            message_status="queued",
            source=source,
            raw_payload={
                "media_type": "image",
                "message_type": "image",
                "image_url": str(follow_up_payload["url"]),
                "idempotency_key": "pending",
                "parent_message_id": message.id,
                "platform_confirmation_pending": False,
            },
            observed_at=now,
            sent_at=now,
        )
        append_message(db, follow_up_message, collected_at=now)
        db.flush()
        follow_up_messages.append(follow_up_message)
    product_payloads = [
        item for item in (follow_up_products or [])[:2]
        if isinstance(item, dict)
        and str(item.get("goods_id") or "").strip()
        and str(item.get("product_id") or item.get("platform_product_id") or "").strip()
    ]
    for index, product in enumerate(product_payloads):
        goods_id = str(product.get("goods_id") or "").strip()[:128]
        product_id = str(product.get("product_id") or product.get("platform_product_id") or "").strip()[:128]
        product_message = Message(
            conversation_id=conversation.id,
            user_id=user.id,
            platform_code=platform_code,
            sender_role="agent",
            sender_name=request.sender_name or user.display_name,
            content=str(product.get("title") or "[商品]")[:1000],
            message_status="queued",
            source=source,
            raw_payload={
                "message_type": "product",
                "display_mode": "card",
                "goods_id": goods_id,
                "product_id": product_id,
                "platform_product_id": product_id,
                "title": product.get("title"),
                "image_url": product.get("image_url"),
                "link_url": product.get("link_url"),
                "price": product.get("price"),
                "price_label": product.get("price_label"),
                "structured_payload": {
                    "goods_id": goods_id,
                    "product_id": product_id,
                    "title": product.get("title"),
                    "image_url": product.get("image_url"),
                    "link_url": product.get("link_url"),
                    "price": product.get("price"),
                    "price_label": product.get("price_label"),
                },
                "parent_message_id": message.id,
                "product_index": index,
                "product_send_pending": True,
            },
            observed_at=now,
            sent_at=now,
        )
        append_message(db, product_message, collected_at=now)
        db.flush()
        follow_up_messages.append(product_message)
        follow_up_product_messages.append(product_message)
    task = RpaTask(
        user_id=user.id,
        node_id=conversation.platform_account.last_rpa_node_id if platform_code == "douyin" else None,
        platform_account_id=conversation.platform_account_id,
        conversation_id=conversation.id,
        message_id=message.id,
        task_type="send_message",
        idempotency_key=idempotency_key,
        platform_code=platform_code,
        payload_json={
            "conversation_id": conversation.id,
            "platform_account_id": conversation.platform_account_id,
            "external_conversation_id": conversation.external_conversation_id,
            "customer_name": conversation.customer_name or "",
            "message_id": message.id,
            "content": request.content,
            "sender_name": request.sender_name or user.display_name,
            "source": source,
            **(automation_context or {}),
            **({"follow_up_message_id": follow_up_message.id} if follow_up_message else {}),
            **({
                "follow_up_message_ids": [item.id for item in follow_up_messages]
            } if follow_up_messages else {}),
            **({
                "follow_up_product_message_ids": [item.id for item in follow_up_product_messages]
            } if follow_up_product_messages else {}),
            **({"quote_message_id": request.quote_message_id} if request.quote_message_id else {}),
            **({"follow_up": follow_up} if follow_up else {}),
            **({"follow_up_products": product_payloads} if product_payloads else {}),
        },
        status=task_status,
        priority=0,
    )
    db.add(task)
    db.flush()
    if follow_up_message is not None:
        follow_up_message.raw_payload = {
            **(follow_up_message.raw_payload or {}),
            "parent_task_id": task.id,
            "idempotency_key": f"reply-bundle-image:{task.id}",
        }
        db.add(follow_up_message)

    conversation.latest_message_text = (
        follow_up_messages[-1].content if follow_up_messages else request.content
    )
    conversation.latest_message_at = now
    conversation.status = "active"
    db.add(conversation)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        if not idempotency_key:
            raise
        existing_task = db.scalar(
            select(RpaTask).where(RpaTask.idempotency_key == idempotency_key)
        )
        if not existing_task or not existing_task.message_id:
            raise
        existing_message = db.get(Message, existing_task.message_id)
        if not existing_message or existing_message.user_id != user.id:
            raise
        return SendMessageResponse(
            message=MessageRead.model_validate(existing_message),
            task_id=existing_task.id,
            task_status=existing_task.status,
            follow_up_message=None,
            follow_up_messages=[],
        )
    db.refresh(message)
    db.refresh(task)
    if follow_up_message is not None:
        db.refresh(follow_up_message)
    for item in follow_up_messages:
        db.refresh(item)

    return SendMessageResponse(
        message=MessageRead.model_validate(message),
        task_id=task.id,
        task_status=task.status,
        follow_up_message=MessageRead.model_validate(follow_up_message) if follow_up_message else None,
        follow_up_messages=[MessageRead.model_validate(item) for item in follow_up_messages],
    )


def record_sent_message(
    db: Session,
    user: User,
    request: RecordSentMessageRequest,
) -> RecordSentMessageResponse:
    conversation = db.get(Conversation, request.conversation_id)
    if not conversation or conversation.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found")

    now = utcnow()
    platform_sent_at = request.platform_sent_at or now
    extra_payload = request.raw_payload if isinstance(request.raw_payload, dict) else {}
    raw_payload = {
        **({"client_message_id": request.client_message_id} if request.client_message_id else {}),
        **({"media_type": "image", "message_type": "image"} if request.media_type == "image" else {}),
        **extra_payload,
    }
    if request.platform_message_id:
        existing = db.scalar(
            select(Message).where(
                Message.conversation_id == conversation.id,
                Message.platform_message_id == request.platform_message_id,
            )
        )
        if existing:
            previous_payload = existing.raw_payload if isinstance(existing.raw_payload, dict) else {}
            existing.sender_role = "agent"
            existing.sender_name = request.sender_name or existing.sender_name or user.display_name
            existing.content = request.content
            existing.message_status = "sent"
            existing.source = "desktop"
            existing.raw_payload = {
                **previous_payload,
                **raw_payload,
            }
            existing.platform_sent_at = existing.platform_sent_at or platform_sent_at
            existing.observed_at = existing.observed_at or now
            existing.sent_at = existing.sent_at or platform_sent_at
            conversation.latest_message_text = request.content
            conversation.latest_message_at = platform_sent_at
            conversation.status = "active"
            conversation.awaiting_reply = False
            db.add(existing)
            db.add(conversation)
            db.commit()
            db.refresh(existing)
            return RecordSentMessageResponse(message=MessageRead.model_validate(existing))

    message = Message(
        conversation_id=conversation.id,
        user_id=user.id,
        platform_code=request.platform_code or conversation.platform_code,
        platform_message_id=request.platform_message_id,
        sender_role="agent",
        sender_name=request.sender_name or user.display_name,
        content=request.content,
        message_status="sent",
        source="desktop",
        raw_payload=raw_payload,
        platform_sent_at=platform_sent_at,
        observed_at=now,
        sent_at=platform_sent_at,
    )
    append_message(db, message, collected_at=now)
    conversation.latest_message_text = request.content
    conversation.latest_message_at = platform_sent_at
    conversation.status = "active"
    conversation.awaiting_reply = False
    db.add(conversation)
    db.commit()
    db.refresh(message)
    return RecordSentMessageResponse(message=MessageRead.model_validate(message))
