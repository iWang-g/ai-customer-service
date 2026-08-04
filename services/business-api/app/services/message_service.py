from __future__ import annotations

from datetime import timedelta
import re

from fastapi import HTTPException, status
from sqlalchemy import and_, case, desc, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.core.security import utcnow
from app.models import Conversation, Message, RpaTask, User
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


PLATFORM_DISPLAY_NAMES = {
    "pinduoduo": "拼多多",
    "qianniu": "千牛",
    "douyin": "抖音",
    "kuaishou": "快手",
    "xiaohongshu": "小红书",
}
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
    stmt = (
        select(Message)
        .where(and_(Message.conversation_id == conversation_id, Message.user_id == user.id))
        .order_by(
            func.coalesce(
                Message.observed_at,
                Message.sent_at,
                Message.created_at,
            ).asc(),
            case((Message.snapshot_sequence.is_(None), 1), else_=0).asc(),
            Message.snapshot_sequence.asc(),
            Message.created_at.asc(),
            Message.id.asc(),
        )
        .offset(offset)
        .limit(limit)
    )
    count_stmt = (
        select(func.count())
        .select_from(Message)
        .where(and_(Message.conversation_id == conversation_id, Message.user_id == user.id))
    )
    total = db.scalar(count_stmt) or 0
    items = list(db.scalars(stmt).all())
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
    db.add(message)
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
    db.add(message)
    conversation.latest_message_text = request.content
    conversation.latest_message_at = now
    conversation.status = "active"
    db.add(conversation)
    db.commit()
    db.refresh(message)
    return RecordSentMessageResponse(message=MessageRead.model_validate(message))
