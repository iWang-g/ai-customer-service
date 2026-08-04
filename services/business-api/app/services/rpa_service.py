from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import and_, desc, func, or_, select
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.security import create_token, utcnow
from app.models import Conversation, Message, PlatformAccount, RpaEvent, RpaNode, RpaTask, User
from app.schemas.rpa import (
    NodeHeartbeatRequest,
    NodeRegisterRequest,
    NodeRegisterResponse,
    RpaEventCreate,
    RpaEventRead,
    RpaTaskRead,
    TaskCompleteRequest,
)


def _node_token(settings: Settings, user: User, node: RpaNode) -> str:
    return create_token(
        settings.jwt_secret_key,
        subject=user.id,
        token_type="node",
        expires_delta=timedelta(days=3650),
        extra_claims={"node_id": node.id, "node_key": node.node_key},
    )


def register_node(
    db: Session,
    settings: Settings,
    user: User,
    request: NodeRegisterRequest,
) -> NodeRegisterResponse:
    node = db.scalar(
        select(RpaNode).where(and_(RpaNode.user_id == user.id, RpaNode.node_key == request.node_key))
    )
    now = utcnow()
    if node is None:
        node = RpaNode(
            user_id=user.id,
            node_key=request.node_key,
            hostname=request.hostname,
            machine_name=request.machine_name,
            supported_platforms=request.supported_platforms,
            app_version=request.app_version,
            status="online",
            last_heartbeat_at=now,
            last_seen_at=now,
        )
        db.add(node)
    else:
        node.hostname = request.hostname
        node.machine_name = request.machine_name
        node.supported_platforms = request.supported_platforms
        node.app_version = request.app_version
        node.status = "online"
        node.last_heartbeat_at = now
        node.last_seen_at = now
        db.add(node)
    db.commit()
    db.refresh(node)
    return NodeRegisterResponse(
        node=node,
        node_token=_node_token(settings, user, node),
        heartbeat_interval_seconds=settings.heartbeat_timeout_seconds,
    )


def heartbeat_node(db: Session, node: RpaNode, request: NodeHeartbeatRequest) -> RpaNode:
    now = utcnow()
    node.status = request.status
    node.supported_platforms = request.active_platforms or node.supported_platforms
    node.last_heartbeat_at = now
    node.last_seen_at = now
    db.add(node)
    db.commit()
    db.refresh(node)
    return node


def disconnect_node(db: Session, node: RpaNode) -> RpaNode:
    node.status = "offline"
    node.last_seen_at = utcnow()
    db.add(node)
    db.commit()
    db.refresh(node)
    return node


def create_event(db: Session, user: User, node: RpaNode, request: RpaEventCreate) -> tuple[RpaEvent, list[Message], list[Conversation]]:
    duplicate_conditions = [RpaEvent.event_id == request.event_id]
    if request.dedup_key:
        duplicate_conditions.append(RpaEvent.dedup_key == request.dedup_key)
    existing = db.scalar(
        select(RpaEvent).where(and_(RpaEvent.user_id == user.id, or_(*duplicate_conditions)))
    )
    if existing:
        return existing, [], []

    platform_account = None
    if request.platform_account_id:
        platform_account = db.get(PlatformAccount, request.platform_account_id)
        if not platform_account or platform_account.user_id != user.id:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Platform account not found"
            )

    event = RpaEvent(
        user_id=user.id,
        node_id=node.id,
        platform_account_id=request.platform_account_id,
        event_id=request.event_id,
        dedup_key=request.dedup_key or request.event_id,
        event_type=request.event_type,
        platform_code=request.platform_code,
        platform_message_id=request.platform_message_id,
        conversation_external_id=request.conversation_external_id,
        payload_json=request.payload_json,
        received_at=request.received_at or utcnow(),
        processed_at=utcnow(),
        status="processed",
    )
    db.add(event)
    messages: list[Message] = []
    conversations: list[Conversation] = []

    conversation = _upsert_conversation_from_event(db, user.id, request)
    if conversation:
        conversations.append(conversation)
    message, is_new_reply_source = _upsert_message_from_event(db, user.id, conversation, request)
    if conversation and message:
        _refresh_awaiting_reply(db, conversation)
    if message and is_new_reply_source:
        messages.append(message)

    db.commit()
    db.refresh(event)
    return event, messages, conversations


def create_events_batch(
    db: Session,
    user: User,
    node: RpaNode,
    events: list[RpaEventCreate],
) -> tuple[list[RpaEventRead], list[tuple[RpaEventCreate, Message, str]]]:
    created: list[RpaEventRead] = []
    reply_sources: list[tuple[RpaEventCreate, Message, str]] = []
    for request in events:
        event, messages, _ = create_event(db, user, node, request)
        created.append(RpaEventRead.model_validate(event))
        if messages:
            reply_sources.append((request, messages[0], event.id))
    return created, reply_sources


def _upsert_conversation_from_event(
    db: Session,
    user_id: str,
    request: RpaEventCreate,
) -> Conversation | None:
    payload = request.payload_json
    external_id = (
        request.conversation_external_id
        or payload.get("conversation_external_id")
        or payload.get("customer_id")
        or payload.get("customer_name")
        or request.platform_message_id
    )
    if not external_id and request.event_type not in {"customer_message", "message_received", "agent_message", "message_sent"}:
        return None
    conversation = db.scalar(
        select(Conversation).where(
            and_(
                Conversation.user_id == user_id,
                Conversation.platform_account_id == request.platform_account_id,
                Conversation.platform_code == request.platform_code,
                Conversation.external_conversation_id == external_id,
            )
        )
    )
    payload_unread_count = _payload_unread_count(payload)
    if conversation is None:
        conversation = Conversation(
            user_id=user_id,
            platform_account_id=request.platform_account_id,
            platform_code=request.platform_code,
            external_conversation_id=external_id,
            customer_name=payload.get("customer_name"),
            title=payload.get("title") or payload.get("customer_name") or external_id,
            latest_message_text=payload.get("content"),
            latest_message_at=request.received_at or utcnow(),
            unread_count=(
                payload_unread_count
                if payload_unread_count is not None
                else (1 if request.event_type in {"customer_message", "message_received"} else 0)
            ),
            status="active",
            metadata_json=payload.get("conversation_metadata", {}),
        )
        db.add(conversation)
        db.flush()
        return conversation

    conversation.customer_name = payload.get("customer_name") or conversation.customer_name
    conversation.title = payload.get("title") or conversation.title
    conversation.latest_message_text = payload.get("content") or conversation.latest_message_text
    conversation.latest_message_at = request.received_at or utcnow()
    if request.event_type == "conversation_snapshot" and payload_unread_count is not None:
        conversation.unread_count = payload_unread_count
    elif request.event_type in {"customer_message", "message_received"} and payload_unread_count is not None:
        conversation.unread_count = payload_unread_count
    elif request.event_type in {"customer_message", "message_received"}:
        conversation.unread_count += 1
    if payload.get("conversation_metadata"):
        conversation.metadata_json = {
            **conversation.metadata_json,
            **payload["conversation_metadata"],
        }
    db.add(conversation)
    db.flush()
    return conversation


def _payload_unread_count(payload: dict[str, Any]) -> int | None:
    if "unread_count" not in payload:
        return None
    try:
        return max(0, min(int(payload.get("unread_count") or 0), 9999))
    except (TypeError, ValueError):
        return None


def _refresh_awaiting_reply(db: Session, conversation: Conversation) -> None:
    latest_sender = db.scalar(
        select(Message.sender_role)
        .where(
            Message.conversation_id == conversation.id,
            Message.message_status == "sent",
        )
        .order_by(
            desc(func.coalesce(
                Message.platform_sent_at,
                Message.observed_at,
                Message.sent_at,
                Message.created_at,
            )),
            desc(Message.created_at),
            desc(Message.id),
        )
        .limit(1)
    )
    conversation.awaiting_reply = latest_sender == "customer"
    db.add(conversation)


def _payload_datetime(payload: dict[str, Any], key: str) -> datetime | None:
    value = payload.get(key)
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _payload_non_negative_int(payload: dict[str, Any], key: str) -> int | None:
    value = payload.get(key)
    if isinstance(value, bool):
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed >= 0 else None


def _is_live_reply_source(payload: dict[str, Any], request: RpaEventCreate) -> bool:
    platform_sent_at = _payload_datetime(payload, "platform_sent_at")
    observed_at = _payload_datetime(payload, "observed_at") or request.received_at
    if not platform_sent_at or not observed_at:
        return True
    return abs((observed_at - platform_sent_at).total_seconds()) <= 300


def _apply_collection_metadata(
    message: Message,
    payload: dict[str, Any],
    request: RpaEventCreate,
    *,
    preserve_existing: bool = False,
) -> None:
    observed_at = _payload_datetime(payload, "observed_at") or request.received_at or utcnow()
    platform_sent_at = _payload_datetime(payload, "platform_sent_at")
    if not preserve_existing or "platform_sent_at" in payload:
        message.platform_sent_at = platform_sent_at
    if not preserve_existing or message.observed_at is None:
        message.observed_at = observed_at
    if not preserve_existing or "snapshot_id" in payload:
        message.snapshot_id = payload.get("snapshot_id") or None
    if not preserve_existing or "snapshot_sequence" in payload:
        message.snapshot_sequence = _payload_non_negative_int(payload, "snapshot_sequence")
    if not preserve_existing or "time_group_index" in payload:
        message.time_group_index = _payload_non_negative_int(payload, "time_group_index")
    if not preserve_existing or "has_explicit_time" in payload:
        explicit_time = payload.get("has_explicit_time")
        message.has_explicit_time = explicit_time if isinstance(explicit_time, bool) else None
    if not preserve_existing or "time_label" in payload:
        message.time_label = payload.get("time_label") or None
    if not preserve_existing or message.sent_at is None:
        # Chat chronology follows the local collection time; platform time remains metadata.
        message.sent_at = message.observed_at or observed_at


def _upsert_message_from_event(
    db: Session,
    user_id: str,
    conversation: Conversation | None,
    request: RpaEventCreate,
) -> tuple[Message | None, bool]:
    payload = request.payload_json
    content = payload.get("content")
    message_event_types = {"customer_message", "message_received", "agent_message", "message_sent"}
    if not conversation or not content or request.event_type not in message_event_types:
        return None, False
    sender_role = payload.get("sender_role") or (
        "customer" if request.event_type in {"customer_message", "message_received"} else "agent"
    )
    if request.platform_message_id:
        existing = db.scalar(
            select(Message).where(
                and_(
                    Message.conversation_id == conversation.id,
                    Message.platform_message_id == request.platform_message_id,
                )
            )
        )
        if existing:
            existing.sender_role = payload.get("sender_role") or existing.sender_role
            existing.sender_name = payload.get("sender_name") or existing.sender_name
            existing.content = content
            existing.raw_payload = {**existing.raw_payload, **payload}
            _apply_collection_metadata(existing, payload, request, preserve_existing=True)
            db.add(existing)
            db.flush()
            return existing, False

    snapshot_id = payload.get("snapshot_id") or None
    platform_sent_at = _payload_datetime(payload, "platform_sent_at")
    observed_at = _payload_datetime(payload, "observed_at") or request.received_at
    same_snapshot = []
    if snapshot_id:
        same_snapshot = list(db.scalars(
            select(Message)
            .where(
                and_(
                    Message.conversation_id == conversation.id,
                    Message.sender_role == sender_role,
                    Message.content == content,
                    Message.snapshot_id == snapshot_id,
                )
            )
            .order_by(Message.created_at.desc())
        ).all())
    snapshot_match = next(
        (
            candidate
            for candidate in same_snapshot
            if (
                not (
                    request.platform_message_id
                    and candidate.platform_message_id
                    and candidate.platform_message_id != request.platform_message_id
                )
                and (
                    not platform_sent_at
                    or not candidate.platform_sent_at
                    or candidate.platform_sent_at == platform_sent_at
                )
            )
        ),
        None,
    )
    if snapshot_match:
        if request.platform_message_id and not snapshot_match.platform_message_id:
            snapshot_match.platform_message_id = request.platform_message_id
        snapshot_match.sender_name = payload.get("sender_name") or snapshot_match.sender_name
        snapshot_match.raw_payload = {**snapshot_match.raw_payload, **payload}
        _apply_collection_metadata(snapshot_match, payload, request, preserve_existing=True)
        db.add(snapshot_match)
        db.flush()
        return snapshot_match, False

    if request.platform_message_id and platform_sent_at:
        recent_observation = (observed_at or utcnow()) - timedelta(seconds=10)
        unidentified_match = db.scalar(
            select(Message)
            .where(
                and_(
                    Message.conversation_id == conversation.id,
                    Message.platform_message_id.is_(None),
                    Message.sender_role == sender_role,
                    Message.content == content,
                    Message.platform_sent_at == platform_sent_at,
                    Message.observed_at >= recent_observation,
                )
            )
            .order_by(Message.observed_at.desc())
            .limit(1)
        )
        if unidentified_match:
            unidentified_match.platform_message_id = request.platform_message_id
            unidentified_match.sender_name = payload.get("sender_name") or unidentified_match.sender_name
            unidentified_match.raw_payload = {**unidentified_match.raw_payload, **payload}
            _apply_collection_metadata(unidentified_match, payload, request, preserve_existing=True)
            db.add(unidentified_match)
            db.flush()
            return unidentified_match, False

    if not request.platform_message_id and platform_sent_at:
        recent_observation = (observed_at or utcnow()) - timedelta(seconds=10)
        fallback_match = db.scalar(
            select(Message)
            .where(
                and_(
                    Message.conversation_id == conversation.id,
                    Message.platform_message_id.is_(None),
                    Message.sender_role == sender_role,
                    Message.content == content,
                    Message.platform_sent_at == platform_sent_at,
                    Message.observed_at >= recent_observation,
                )
            )
            .order_by(Message.observed_at.desc())
            .limit(1)
        )
        if fallback_match:
            fallback_match.raw_payload = {**fallback_match.raw_payload, **payload}
            _apply_collection_metadata(fallback_match, payload, request, preserve_existing=True)
            db.add(fallback_match)
            db.flush()
            return fallback_match, False
    if request.event_type in {"agent_message", "message_sent"} and content:
        # A desktop send is recorded immediately after the platform confirms it;
        # attach the later RPA snapshot to that row instead of duplicating it.
        recent_desktop = db.scalar(
            select(Message)
            .where(
                and_(
                    Message.conversation_id == conversation.id,
                    Message.sender_role == "agent",
                    Message.source == "desktop",
                    Message.platform_message_id.is_(None),
                    Message.content == content,
                    Message.sent_at >= utcnow() - timedelta(seconds=60),
                )
            )
            .order_by(Message.sent_at.desc())
            .limit(1)
        )
        if recent_desktop:
            recent_desktop.platform_message_id = request.platform_message_id
            recent_desktop.source = "rpa"
            recent_desktop.raw_payload = {**recent_desktop.raw_payload, **payload}
            _apply_collection_metadata(recent_desktop, payload, request, preserve_existing=True)
            db.add(recent_desktop)
            db.flush()
            return recent_desktop, False
    message = Message(
        conversation_id=conversation.id,
        user_id=user_id,
        platform_code=request.platform_code,
        platform_message_id=request.platform_message_id,
        sender_role=sender_role,
        sender_name=payload.get("sender_name") or conversation.customer_name,
        content=content,
        message_status="sent",
        source="rpa",
        raw_payload=payload,
    )
    _apply_collection_metadata(message, payload, request)
    db.add(message)
    db.flush()
    return message, _is_live_reply_source(payload, request)


def get_pending_tasks(db: Session, node: RpaNode, limit: int = 50) -> list[RpaTask]:
    stmt = (
        select(RpaTask)
        .where(
            and_(
                RpaTask.user_id == node.user_id,
                or_(RpaTask.node_id.is_(None), RpaTask.node_id == node.id),
                RpaTask.status.in_(["queued", "dispatched"]),
            )
        )
        .order_by(desc(RpaTask.priority), RpaTask.requested_at)
        .limit(limit)
    )
    tasks = list(db.scalars(stmt).all())
    for task in tasks:
        if task.status == "queued":
            task.status = "dispatched"
            task.node_id = node.id
            db.add(task)
    if tasks:
        db.commit()
    return tasks


def acknowledge_task(db: Session, task: RpaTask) -> RpaTask:
    task.status = "acknowledged"
    task.acked_at = utcnow()
    db.add(task)
    db.commit()
    db.refresh(task)
    return task


def complete_task(db: Session, task: RpaTask, request: TaskCompleteRequest) -> RpaTask:
    was_completed = task.status == "completed"
    task.status = request.status
    task.result_json = request.result_json
    task.error_message = request.error_message
    task.completed_at = utcnow()
    if task.message_id:
        message = db.get(Message, task.message_id)
        if message:
            text_sent = bool(request.result_json.get("text_sent"))
            message.message_status = "sent" if request.status == "completed" or text_sent else "failed"
            if request.result_json.get("platform_message_id"):
                message.platform_message_id = request.result_json["platform_message_id"]
            db.add(message)
            if message.message_status == "sent":
                conversation = db.get(Conversation, task.conversation_id)
                if conversation:
                    _refresh_awaiting_reply(db, conversation)
    if (
        request.status == "completed"
        and not was_completed
        and task.task_type == "send_message"
        and request.result_json.get("image_sent") is True
    ):
        payload = task.payload_json if isinstance(task.payload_json, dict) else {}
        follow_up = payload.get("follow_up")
        if isinstance(follow_up, dict) and follow_up.get("type") == "image" and follow_up.get("url"):
            media_key = f"reply-bundle-image:{task.id}"
            duplicate_image = db.scalar(
                select(Message).where(
                    Message.conversation_id == task.conversation_id,
                    Message.source == "ai",
                    Message.raw_payload["idempotency_key"].as_string() == media_key,
                )
            )
            if duplicate_image is None:
                now = utcnow()
                image_message = Message(
                    conversation_id=task.conversation_id,
                    user_id=task.user_id,
                    platform_code=task.platform_code,
                    sender_role="agent",
                    sender_name=payload.get("sender_name"),
                    content="[图片]",
                    message_status="sent",
                    source="ai",
                    raw_payload={
                        "media_type": "image",
                        "image_url": str(follow_up["url"]),
                        "parent_task_id": task.id,
                        "idempotency_key": media_key,
                    },
                    observed_at=now,
                    sent_at=now,
                )
                db.add(image_message)
                conversation = db.get(Conversation, task.conversation_id)
                if conversation:
                    conversation.latest_message_text = "[图片]"
                    conversation.latest_message_at = now
                    db.add(conversation)
    if (
        request.result_json.get("create_follow_up_task") is True
        and request.status == "completed"
        and not was_completed
        and task.task_type == "send_message"
    ):
        payload = task.payload_json if isinstance(task.payload_json, dict) else {}
        follow_up = payload.get("follow_up")
        if isinstance(follow_up, dict) and follow_up.get("type") == "image" and follow_up.get("url"):
            duplicate = next(
                (
                    candidate for candidate in db.scalars(
                        select(RpaTask).where(
                            RpaTask.user_id == task.user_id,
                            RpaTask.task_type == "send_image",
                        )
                    ).all()
                    if isinstance(candidate.payload_json, dict)
                    and candidate.payload_json.get("parent_task_id") == task.id
                ),
                None,
            )
            if duplicate is None:
                now = utcnow()
                image_message = Message(
                    conversation_id=task.conversation_id,
                    user_id=task.user_id,
                    platform_code=task.platform_code,
                    sender_role="agent",
                    sender_name=payload.get("sender_name"),
                    content="[图片]",
                    message_status="queued",
                    source="ai",
                    raw_payload={"media_type": "image", "image_url": str(follow_up["url"])},
                    observed_at=now,
                    sent_at=now,
                )
                db.add(image_message)
                db.flush()
                db.add(RpaTask(
                    user_id=task.user_id,
                    node_id=task.node_id,
                    platform_account_id=task.platform_account_id,
                    conversation_id=task.conversation_id,
                    message_id=image_message.id,
                    task_type="send_image",
                    platform_code=task.platform_code,
                    payload_json={
                        "parent_task_id": task.id,
                        "conversation_id": task.conversation_id,
                        "platform_account_id": task.platform_account_id,
                        "external_conversation_id": payload.get("external_conversation_id"),
                        "customer_name": payload.get("customer_name"),
                        "image_url": str(follow_up["url"]),
                    },
                    status="queued",
                    priority=task.priority,
                ))
    db.add(task)
    db.commit()
    db.refresh(task)
    return task
