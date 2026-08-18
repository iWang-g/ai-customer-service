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
from app.services.outbound_safety import prohibited_outbound_reason


PLACEHOLDER_SHOP_NAMES = {
    "待识别店铺名称",
    "拼多多",
    "拼多多商家后台",
    "拼多多商家管理后台",
    "拼多多客服平台",
    "商家后台",
    "客服平台",
}
NUMBERED_PDD_SHOP_NAME = re.compile(r"^拼多多店铺\s*\d+$")


def _valid_shop_name(value: str | None) -> str | None:
    name = (value or "").strip()
    if not name or name in PLACEHOLDER_SHOP_NAMES or NUMBERED_PDD_SHOP_NAME.fullmatch(name):
        return None
    return name


def _conversation_read(conversation: Conversation) -> ConversationRead:
    account = conversation.platform_account
    platform_name = (
        account.platform_name
        if account and account.platform_name
        else PLATFORM_DISPLAY_NAMES.get(conversation.platform_code, conversation.platform_code)
    )
    shop_name = None
    if account:
        shop_name = _valid_shop_name(account.account_alias) or _valid_shop_name(account.account_name)
    if not shop_name:
        metadata_shop_name = conversation.metadata_json.get("shop_name")
        shop_name = _valid_shop_name(metadata_shop_name if isinstance(metadata_shop_name, str) else None)
    raw_issue = (conversation.metadata_json or {}).get("message_sync_issue")
    message_sync_issue = None
    if isinstance(raw_issue, dict) and raw_issue.get("status") == "active":
        try:
            message_sync_issue = ConversationSyncIssueRead.model_validate(raw_issue)
        except ValueError:
            message_sync_issue = None
    return ConversationRead.model_validate(conversation).model_copy(update={
        "platform_name": platform_name,
        "shop_name": shop_name,
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
        items=[_conversation_read(item) for item in items],
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
    return _conversation_read(conversation)


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
    return _conversation_read(conversation)


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
            detail="当前会话有消息正在处理，请稍后操作",
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
    return _conversation_read(conversation)


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
        _conversation_read(conversation),
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
    return _conversation_read(conversation)


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
    return _conversation_read(conversation)


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
    conversation.metadata_json = metadata
    db.add(conversation)
    db.commit()
    db.refresh(conversation)
    return _conversation_read(conversation), deleted_counts


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
    # Page backwards from the permanent queue tail, then restore chat order.
    stmt = (
        select(Message)
        .where(visible_messages)
        .order_by(desc(Message.conversation_sequence))
        .offset(offset)
        .limit(limit)
    )
    items = list(reversed(db.scalars(stmt).all()))
    return MessageListResponse(
        items=[MessageRead.model_validate(item) for item in items],
        meta=PageMeta(total=total, limit=limit, offset=offset),
    )


def create_send_task(
    db: Session,
    user: User,
    request: SendMessageRequest,
    *,
    follow_up: dict[str, object] | None = None,
    idempotency_key: str | None = None,
    source: str = "desktop",
    task_status: str = "queued",
) -> SendMessageResponse:
    if source != "desktop":
        prohibited_reason = prohibited_outbound_reason(request.content)
        if prohibited_reason:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"自动发送内容包含平台禁止的链接或联系方式: {prohibited_reason}",
            )
    conversation = db.get(Conversation, request.conversation_id)
    if not conversation or conversation.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found")

    platform_code = request.platform_code or conversation.platform_code
    now = utcnow()
    message = Message(
        conversation_id=conversation.id,
        user_id=user.id,
        platform_code=platform_code,
        sender_role="agent",
        sender_name=request.sender_name or user.display_name,
        content=request.content,
        message_status="queued",
        source=source,
        observed_at=now,
        sent_at=now,
    )
    append_message(db, message, collected_at=now)
    db.flush()
    task = RpaTask(
        user_id=user.id,
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
            **({"follow_up": follow_up} if follow_up else {}),
        },
        status=task_status,
        priority=0,
    )
    db.add(task)

    conversation.latest_message_text = request.content
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
        )
    db.refresh(message)
    db.refresh(task)

    return SendMessageResponse(
        message=MessageRead.model_validate(message),
        task_id=task.id,
        task_status=task.status,
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
        raw_payload={
            **({"client_message_id": request.client_message_id} if request.client_message_id else {}),
            **({"media_type": "image", "message_type": "image"} if request.media_type == "image" else {}),
        },
        platform_sent_at=now,
        observed_at=now,
        sent_at=now,
    )
    append_message(db, message, collected_at=now)
    conversation.latest_message_text = request.content
    conversation.latest_message_at = now
    conversation.status = "active"
    conversation.awaiting_reply = False
    db.add(conversation)
    db.commit()
    db.refresh(message)
    return RecordSentMessageResponse(message=MessageRead.model_validate(message))
