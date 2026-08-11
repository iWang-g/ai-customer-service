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
    CustomerOutreachRun,
    EmailSendTask,
    Message,
    MessageObservation,
    RpaEvent,
    RpaTask,
    User,
)
from app.schemas.common import PageMeta
from app.schemas.conversation import ConversationListResponse, ConversationRead
from app.schemas.message import (
    MessageListResponse,
    MessageRead,
    RecordSentMessageRequest,
    RecordSentMessageResponse,
    SendMessageRequest,
    SendMessageResponse,
)
from app.schemas.platform import PLATFORM_DISPLAY_NAMES
from app.services.message_queue_service import append_message


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
    return ConversationRead.model_validate(conversation).model_copy(
        update={"platform_name": platform_name, "shop_name": shop_name}
    )


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
        .where(Conversation.user_id == user.id)
    )
    count_stmt = select(func.count()).select_from(Conversation).where(Conversation.user_id == user.id)
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


def reset_pinduoduo_conversation_test_data(
    db: Session,
    user: User,
    conversation_id: str,
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

    conversation.latest_message_text = None
    conversation.latest_message_at = None
    conversation.unread_count = 0
    conversation.last_message_sequence = 0
    conversation.awaiting_reply = False
    conversation.human_required = False
    conversation.human_required_reason = None
    conversation.human_required_word = None
    conversation.human_required_at = None
    conversation.status = "active"
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
) -> SendMessageResponse:
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
        status="queued",
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
