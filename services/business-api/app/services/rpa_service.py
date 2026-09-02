from __future__ import annotations

from datetime import datetime, timedelta, timezone
import re
from typing import Any
import unicodedata

from fastapi import HTTPException, status
from sqlalchemy import and_, desc, or_, select
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.core.config import Settings, get_settings
from app.core.security import create_token, utcnow
from app.models import (
    AutomationReplyRun,
    Conversation,
    Message,
    PlatformAccount,
    Robot,
    RobotPlatformScope,
    RpaEvent,
    RpaNode,
    RpaTask,
    User,
)
from app.schemas.message import SendMessageRequest
from app.schemas.rpa import (
    NodeHeartbeatRequest,
    NodeRegisterRequest,
    NodeRegisterResponse,
    RpaEventCreate,
    RpaEventRead,
    RpaTaskRead,
    TaskCompleteRequest,
)
from app.services.order_service import apply_orders_snapshot
from app.services.product_service import apply_products_snapshot, apply_store_products_snapshot
from app.services.avatar_cache_service import cache_customer_avatar
from app.services.message_queue_service import append_message
from app.services.message_service import create_send_task
from app.services.message_observation_service import (
    SnapshotProtocolError,
    process_message_snapshot,
)
from app.services.pdd_message_mode import pdd_message_write_mode
from app.services.platform_account_service import resolve_merged_platform_account_id
from app.services.settings_service import auto_reply_enabled


DEFAULT_ENTRY_WELCOME_TEXT = "亲亲，我是本店AI客服，有什么需要了解的可以咨询我。如果需要人工回复的话可以发送“转人工”~"
ENTRY_WELCOME_METADATA_KEY = "entry_welcome"
ENTRY_WELCOME_CANDIDATE_EVENTS = {"conversation_snapshot", "customer_message", "message_received"}
_OUTBOUND_MESSAGE_SOURCES = frozenset({
    "desktop",
    "ai",
    "automation_timeout",
    "customer_outreach",
})
_OUTBOUND_ECHO_CANDIDATE_LIMIT = 200
_INVISIBLE_CONTENT_RE = re.compile(r"[\u200b-\u200d\ufeff]")
_CONTENT_WHITESPACE_RE = re.compile(r"\s+")


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


def get_or_create_desktop_ingest_node(db: Session, user: User) -> RpaNode:
    now = utcnow()
    node_key = f"{user.id}:desktop-ingest"
    node = db.scalar(
        select(RpaNode).where(and_(RpaNode.user_id == user.id, RpaNode.node_key == node_key))
    )
    if node is None:
        node = RpaNode(
            user_id=user.id,
            node_key=node_key,
            hostname="desktop-electron",
            machine_name="desktop-electron",
            supported_platforms=["pinduoduo", "wechat"],
            app_version="desktop-ingest",
            status="online",
            last_heartbeat_at=now,
            last_seen_at=now,
        )
        db.add(node)
    else:
        node.status = "online"
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
    settings = get_settings()
    platform_account_id = resolve_merged_platform_account_id(db, user, request.platform_account_id)
    if platform_account_id != request.platform_account_id:
        request = request.model_copy(update={"platform_account_id": platform_account_id})
    duplicate_conditions = [RpaEvent.event_id == request.event_id]
    if request.dedup_key:
        duplicate_conditions.append(RpaEvent.dedup_key == request.dedup_key)
    existing = db.scalar(
        select(RpaEvent).where(and_(RpaEvent.user_id == user.id, or_(*duplicate_conditions)))
    )
    if existing:
        conversations: list[Conversation] = []
        if request.event_type == "conversation_snapshot":
            conversation, _ = _upsert_conversation_from_event(db, user.id, request)
            if conversation:
                conversations.append(conversation)
                db.commit()
                db.refresh(existing)
                db.refresh(conversation)
        return existing, [], conversations

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
    if request.event_type == "store_products_snapshot":
        if platform_account is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Store product snapshot requires a platform account",
            )
        saved_count = apply_store_products_snapshot(
            db,
            platform_account,
            request.payload_json,
            request.received_at,
        )
        event.payload_json = {
            **event.payload_json,
            "store_product_write_mode": "store",
            "saved_product_count": saved_count,
        }
        db.commit()
        db.refresh(event)
        return event, messages, conversations
    pdd_write_mode = (
        pdd_message_write_mode(settings)
        if request.platform_code == "pinduoduo"
        else "legacy"
    )

    if request.event_type == "message_snapshot":
        if pdd_write_mode == "snapshot":
            try:
                result = process_message_snapshot(
                    db,
                    user,
                    node,
                    request,
                    write_messages=pdd_write_mode == "snapshot",
                )
                observation = result.observation
                messages.extend(result.appended_messages)
                if result.appended_messages:
                    conversations.append(result.conversation)
                if observation.alignment_status == "failed":
                    event.status = "failed"
                    event.error_message = observation.error_message
            except SnapshotProtocolError as exc:
                event.status = "failed"
                event.error_message = str(exc)
        db.commit()
        db.refresh(event)
        return event, messages, conversations

    if (
        request.platform_code == "pinduoduo"
        and request.event_type in {
            "customer_message", "message_received", "agent_message", "message_sent"
        }
    ):
        event.payload_json = {
            **event.payload_json,
            "message_write_mode": pdd_write_mode,
            "legacy_write_suppressed": True,
        }
        db.commit()
        db.refresh(event)
        return event, messages, conversations

    conversation, _ = _upsert_conversation_from_event(db, user.id, request)
    if conversation:
        conversations.append(conversation)
        if request.event_type == "customer_orders_snapshot":
            apply_orders_snapshot(db, conversation, request.payload_json, request.received_at)
        if request.event_type == "customer_products_snapshot":
            apply_products_snapshot(db, conversation, request.payload_json, request.received_at)
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
) -> tuple[list[RpaEventRead], list[tuple[RpaEventCreate, Message, str]], list[dict[str, Any]]]:
    created: list[RpaEventRead] = []
    reply_sources: list[tuple[RpaEventCreate, Message, str]] = []
    affected_by_id: dict[str, dict[str, Any]] = {}
    for request in events:
        event, messages, conversations = create_event(db, user, node, request)
        created.append(RpaEventRead.model_validate(event))
        source_message = select_inbound_reply_source(db, request, messages)
        if source_message is not None:
            reply_sources.append((request, source_message, event.id))
        conversation_ids = {conversation.id for conversation in conversations}
        conversation_ids.update(message.conversation_id for message in messages)
        conversations_by_id = {conversation.id: conversation for conversation in conversations}
        for conversation_id in conversation_ids:
            conversation = conversations_by_id.get(conversation_id) or db.get(Conversation, conversation_id)
            if conversation is None:
                continue
            affected = affected_by_id.setdefault(
                conversation.id,
                {
                    "conversation_id": conversation.id,
                    "platform_account_id": conversation.platform_account_id,
                    "platform_code": conversation.platform_code,
                    "external_conversation_id": conversation.external_conversation_id,
                    "event_types": set(),
                    "appended_message_count": 0,
                    "latest_platform_message_id": None,
                },
            )
            affected["event_types"].add(request.event_type)
            conversation_messages = [
                message for message in messages if message.conversation_id == conversation.id
            ]
            affected["appended_message_count"] += len(conversation_messages)
            for message in conversation_messages:
                if message.platform_message_id:
                    affected["latest_platform_message_id"] = message.platform_message_id
    affected_conversations = []
    for item in affected_by_id.values():
        affected_conversations.append({
            **item,
            "event_types": sorted(item["event_types"]),
        })
    return created, reply_sources, affected_conversations


def select_inbound_reply_source(
    db: Session,
    request: RpaEventCreate,
    messages: list[Message],
) -> Message | None:
    """Choose at most one automation trigger from an ingested event.

    Snapshot appends are already in permanent DOM order, so the batch tail is
    the only valid trigger. Earlier customer rows remain available as context.
    """
    if not messages:
        return None
    if request.event_type in {"customer_message", "message_received"}:
        return messages[0]
    if request.event_type != "message_snapshot":
        return None

    tail = None
    for message in reversed(messages):
        if (message.raw_payload or {}).get("automation_mode", "trigger") != "trigger":
            continue
        tail = message
        break
    if tail is None or tail.sender_role != "customer":
        return None
    if tail.collection_kind == "incremental":
        return tail if tail.automation_eligible else None
    if tail.collection_kind == "bootstrap" and request.payload_json.get("unread") is True:
        has_active_reply = db.scalar(
            select(AutomationReplyRun.id).where(
                AutomationReplyRun.conversation_id == tail.conversation_id,
                AutomationReplyRun.status.in_(["pending", "running"]),
            ).limit(1)
        )
        has_active_task = db.scalar(
            select(RpaTask.id).where(
                RpaTask.conversation_id == tail.conversation_id,
                RpaTask.task_type == "send_message",
                RpaTask.status.in_(["queued", "dispatched", "acknowledged"]),
            ).limit(1)
        )
        return tail if not has_active_reply and not has_active_task else None
    return None


def _active_robot_for_conversation(db: Session, user: User, conversation: Conversation) -> Robot | None:
    robots = list(db.scalars(
        select(Robot)
        .where(Robot.user_id == user.id, Robot.enabled.is_(True), Robot.status == "online")
        .order_by(desc(Robot.updated_at))
    ).all())
    for robot in robots:
        scopes = list(db.scalars(
            select(RobotPlatformScope).where(RobotPlatformScope.robot_id == robot.id)
        ).all())
        if any(
            scope.platform_code == "all"
            or (
                scope.platform_code == conversation.platform_code
                and (scope.all_accounts or scope.platform_account_id == conversation.platform_account_id)
            )
            for scope in scopes
        ):
            return robot
    return None


def _entry_welcome_text(robot: Robot) -> str:
    config = robot.config_json if isinstance(robot.config_json, dict) else {}
    text = str(config.get("entry_welcome_text") or "").strip()
    return (text or DEFAULT_ENTRY_WELCOME_TEXT)[:1000]


def _skip_entry_welcome(
    db: Session,
    conversation: Conversation,
    state: dict[str, Any],
    reason: str,
) -> None:
    metadata = conversation.metadata_json if isinstance(conversation.metadata_json, dict) else {}
    conversation.metadata_json = {
        **metadata,
        ENTRY_WELCOME_METADATA_KEY: {
            **state,
            "status": "skipped",
            "reason": reason,
            "updated_at": utcnow().isoformat(),
        },
    }
    db.add(conversation)
    db.commit()


def maybe_queue_entry_welcome(
    db: Session,
    user: User,
    source_message: Message,
) -> str | None:
    if source_message.sender_role != "customer":
        return None
    conversation = db.get(Conversation, source_message.conversation_id)
    if conversation is None:
        return None
    metadata = conversation.metadata_json if isinstance(conversation.metadata_json, dict) else {}
    state = metadata.get(ENTRY_WELCOME_METADATA_KEY)
    if not isinstance(state, dict) or state.get("status") != "candidate":
        return None
    if not auto_reply_enabled(db, user):
        _skip_entry_welcome(db, conversation, state, "auto_reply_disabled")
        return None
    robot = _active_robot_for_conversation(db, user, conversation)
    if robot is None:
        _skip_entry_welcome(db, conversation, state, "robot_missing")
        return None
    config = robot.config_json if isinstance(robot.config_json, dict) else {}
    if config.get("entry_welcome_enabled") is not True or config.get("allow_auto_send") is not True:
        _skip_entry_welcome(db, conversation, state, "disabled")
        return None
    idempotency_key = f"entry-welcome:{robot.id}:{conversation.id}"
    existing = db.scalar(
        select(RpaTask).where(
            RpaTask.user_id == user.id,
            RpaTask.idempotency_key == idempotency_key,
        )
    )
    if existing is not None:
        conversation.metadata_json = {
            **metadata,
            ENTRY_WELCOME_METADATA_KEY: {
                **state,
                "status": "queued",
                "robot_id": robot.id,
                "task_id": existing.id,
                "source_message_id": source_message.id,
                "updated_at": utcnow().isoformat(),
            },
        }
        db.add(conversation)
        db.commit()
        return existing.id
    response = create_send_task(
        db,
        user,
        SendMessageRequest(
            conversation_id=conversation.id,
            content=_entry_welcome_text(robot),
            platform_code=conversation.platform_code,
        ),
        idempotency_key=idempotency_key,
        source="automation",
    )
    conversation = db.get(Conversation, conversation.id)
    if conversation is not None:
        current_metadata = conversation.metadata_json if isinstance(conversation.metadata_json, dict) else {}
        current_state = current_metadata.get(ENTRY_WELCOME_METADATA_KEY)
        conversation.metadata_json = {
            **current_metadata,
            ENTRY_WELCOME_METADATA_KEY: {
                **(current_state if isinstance(current_state, dict) else state),
                "status": "queued",
                "robot_id": robot.id,
                "task_id": response.task_id,
                "source_message_id": source_message.id,
                "text": _entry_welcome_text(robot),
                "updated_at": utcnow().isoformat(),
            },
        }
        db.add(conversation)
        db.commit()
    return response.task_id


def _upsert_conversation_from_event(
    db: Session,
    user_id: str,
    request: RpaEventCreate,
) -> tuple[Conversation | None, bool]:
    payload = request.payload_json
    external_id = (
        request.conversation_external_id
        or payload.get("conversation_external_id")
        or payload.get("customer_id")
        or payload.get("customer_name")
        or request.platform_message_id
    )
    if not external_id and request.event_type not in {
        "customer_message", "message_received", "agent_message", "message_sent",
        "customer_orders_snapshot",
        "customer_products_snapshot",
    }:
        return None, False
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
    conversation_metadata = dict(payload.get("conversation_metadata") or {})
    avatar_url = str(payload.get("avatar_url") or "").strip()
    if avatar_url:
        conversation_metadata["customer_avatar_url"] = avatar_url[:8192]
        cached_avatar_url = None
        existing_metadata = conversation.metadata_json if conversation is not None else {}
        if isinstance(existing_metadata, dict):
            cached_source_url = str(existing_metadata.get("customer_avatar_cached_source_url") or "")
            cached_url = str(existing_metadata.get("customer_avatar_cached_url") or "")
            if cached_source_url == avatar_url and cached_url:
                cached_avatar_url = cached_url
        if cached_avatar_url is None:
            cached_avatar_url = cache_customer_avatar(avatar_url)
        if cached_avatar_url:
            conversation_metadata["customer_avatar_cached_url"] = cached_avatar_url[:8192]
            conversation_metadata["customer_avatar_cached_source_url"] = avatar_url[:8192]
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
            metadata_json=conversation_metadata,
        )
        if request.event_type in ENTRY_WELCOME_CANDIDATE_EVENTS:
            conversation.metadata_json = {
                **(conversation.metadata_json or {}),
                ENTRY_WELCOME_METADATA_KEY: {
                    "status": "candidate",
                    "created_event_type": request.event_type,
                    "created_at": utcnow().isoformat(),
                },
            }
        db.add(conversation)
        db.flush()
        return conversation, True

    conversation.customer_name = payload.get("customer_name") or conversation.customer_name
    conversation.title = payload.get("title") or conversation.title
    history_is_cleared = (
        conversation.messages_cleared_sequence >= conversation.last_message_sequence
        and request.event_type == "conversation_snapshot"
    )
    if not history_is_cleared:
        conversation.latest_message_text = payload.get("content") or conversation.latest_message_text
        conversation.latest_message_at = request.received_at or utcnow()
    if (
        request.event_type in {"customer_message", "message_received"}
        and (
            conversation.deleted_at is None
            or _as_utc_naive(request.received_at or utcnow()) > _as_utc_naive(conversation.deleted_at)
        )
    ):
        conversation.deleted_at = None
    if request.event_type == "conversation_snapshot" and payload_unread_count is not None:
        conversation.unread_count = payload_unread_count
    elif request.event_type in {"customer_message", "message_received"} and payload_unread_count is not None:
        conversation.unread_count = payload_unread_count
    elif request.event_type in {"customer_message", "message_received"}:
        conversation.unread_count += 1
    if conversation_metadata:
        conversation.metadata_json = {
            **(conversation.metadata_json or {}),
            **conversation_metadata,
        }
    db.add(conversation)
    db.flush()
    return conversation, False


def _payload_unread_count(payload: dict[str, Any]) -> int | None:
    if "unread_count" not in payload:
        return None
    try:
        return max(0, min(int(payload.get("unread_count") or 0), 9999))
    except (TypeError, ValueError):
        return None


def _refresh_awaiting_reply(db: Session, conversation: Conversation) -> None:
    latest = db.scalar(
        select(Message)
        .where(
            Message.conversation_id == conversation.id,
            Message.message_status == "sent",
        )
        .order_by(desc(Message.conversation_sequence))
        .limit(1)
    )
    if latest is None:
        conversation.awaiting_reply = False
        db.add(conversation)
        return
    cleared_sequence = 0
    try:
        cleared_sequence = int((conversation.metadata_json or {}).get("awaiting_reply_cleared_sequence") or 0)
    except (TypeError, ValueError):
        cleared_sequence = 0
    conversation.awaiting_reply = (
        latest.sender_role == "customer"
        and int(latest.conversation_sequence or 0) > cleared_sequence
    )
    db.add(conversation)


def _refresh_conversation_summary(db: Session, conversation: Conversation) -> None:
    latest = db.scalar(
        select(Message)
        .where(
            Message.conversation_id == conversation.id,
            Message.message_status != "failed",
        )
        .order_by(desc(Message.conversation_sequence))
        .limit(1)
    )
    conversation.latest_message_text = latest.content if latest else None
    conversation.latest_message_at = latest.collected_at if latest else None
    db.add(conversation)


def _merge_task_message_with_platform_echo(
    db: Session,
    task: RpaTask,
    message: Message,
    request: TaskCompleteRequest,
) -> tuple[Message, str | None]:
    platform_message_id = str(request.result_json.get("platform_message_id") or "").strip()
    if not platform_message_id:
        return message, None
    existing = db.scalar(
        select(Message).where(
            and_(
                Message.conversation_id == message.conversation_id,
                Message.platform_message_id == platform_message_id,
                Message.id != message.id,
            )
        ).limit(1)
    )
    if existing is None:
        return message, None

    merged_from_message_id = message.id

    queued_payload = message.raw_payload if isinstance(message.raw_payload, dict) else {}
    echo_payload = existing.raw_payload if isinstance(existing.raw_payload, dict) else {}
    existing.sender_role = "agent"
    existing.sender_name = existing.sender_name or message.sender_name
    existing.content = existing.content or message.content
    existing.message_status = "sent"
    existing.sent_at = existing.sent_at or message.sent_at
    existing.platform_sent_at = existing.platform_sent_at or message.platform_sent_at
    existing.observed_at = existing.observed_at or message.observed_at
    existing.collected_at = existing.collected_at or message.collected_at
    existing.raw_payload = {
        **queued_payload,
        **echo_payload,
        "merged_outbound_task_message": {
            "message_id": message.id,
            "source": message.source,
            "message_status": message.message_status,
            "task_id": task.id,
            "task_status": request.status,
        },
    }

    db.query(RpaTask).filter(RpaTask.message_id == message.id).update(
        {RpaTask.message_id: existing.id},
        synchronize_session=False,
    )
    db.query(AutomationReplyRun).filter(AutomationReplyRun.reply_message_id == message.id).update(
        {AutomationReplyRun.reply_message_id: existing.id},
        synchronize_session=False,
    )
    task.message_id = existing.id
    db.add(task)
    db.add(existing)
    db.delete(message)
    db.flush()
    return existing, merged_from_message_id


def _upsert_reply_bundle_image_message(
    db: Session,
    task: RpaTask,
    payload: dict[str, Any],
    follow_up: dict[str, Any],
    request: TaskCompleteRequest,
    *,
    image_confirmed: bool,
    image_confirmation_pending: bool,
) -> tuple[Message, str | None]:
    media_key = f"reply-bundle-image:{task.id}"
    platform_message_id = str(request.result_json.get("image_platform_message_id") or "").strip()
    image_url = str(request.result_json.get("image_url") or follow_up.get("url") or "")
    raw_payload = {
        "media_type": "image",
        "message_type": "image",
        "image_url": image_url,
        "parent_task_id": task.id,
        "idempotency_key": media_key,
        "platform_confirmation_pending": image_confirmation_pending,
        **({"pre_msg_id": str(request.result_json.get("image_pre_msg_id"))} if request.result_json.get("image_pre_msg_id") else {}),
        **({"platform_ts": str(request.result_json.get("image_ts"))} if request.result_json.get("image_ts") else {}),
    }
    message_status = "sent" if image_confirmed else "confirmation_pending"
    existing: Message | None = None
    if platform_message_id:
        existing = db.scalar(
            select(Message).where(
                and_(
                    Message.conversation_id == task.conversation_id,
                    Message.platform_message_id == platform_message_id,
                )
            ).limit(1)
        )
    payload_follow_up_message_id = ""
    if isinstance(task.payload_json, dict):
        payload_follow_up_message_id = str(task.payload_json.get("follow_up_message_id") or "").strip()
    duplicate_image = db.scalar(
        select(Message).where(
            Message.conversation_id == task.conversation_id,
            Message.raw_payload["idempotency_key"].as_string() == media_key,
        )
    )
    if duplicate_image is None and payload_follow_up_message_id:
        candidate = db.get(Message, payload_follow_up_message_id)
        if candidate and candidate.conversation_id == task.conversation_id:
            duplicate_image = candidate
    if existing is None:
        existing = duplicate_image
    if existing is not None:
        merged_from_message_id = (
            duplicate_image.id
            if duplicate_image is not None and existing.id != duplicate_image.id
            else None
        )
        previous_payload = existing.raw_payload if isinstance(existing.raw_payload, dict) else {}
        existing.sender_role = "agent"
        existing.sender_name = existing.sender_name or payload.get("sender_name")
        existing.content = existing.content or "[鍥剧墖]"
        existing.message_status = "sent" if image_confirmed else existing.message_status or message_status
        if platform_message_id and not existing.platform_message_id:
            existing.platform_message_id = platform_message_id
        existing.raw_payload = {**previous_payload, **raw_payload}
        if merged_from_message_id:
            db.delete(duplicate_image)
        db.add(existing)
        db.flush()
        return existing, merged_from_message_id

    now = utcnow()
    image_message = Message(
        conversation_id=task.conversation_id,
        user_id=task.user_id,
        platform_code=task.platform_code,
        platform_message_id=platform_message_id or None,
        sender_role="agent",
        sender_name=payload.get("sender_name"),
        content="[鍥剧墖]",
        message_status=message_status,
        source="ai",
        raw_payload=raw_payload,
        observed_at=now,
        sent_at=now,
    )
    append_message(db, image_message, collected_at=now)
    db.flush()
    return image_message, None


def _complete_reply_bundle_products(
    db: Session,
    task: RpaTask,
    request: TaskCompleteRequest,
) -> tuple[list[str], list[str]]:
    payload = task.payload_json if isinstance(task.payload_json, dict) else {}
    message_ids = payload.get("follow_up_product_message_ids")
    if not isinstance(message_ids, list):
        return [], []
    products = payload.get("follow_up_products")
    products = products if isinstance(products, list) else []
    results = request.result_json.get("product_results")
    results = results if isinstance(results, list) else []
    sent_ids: list[str] = []
    failed_ids: list[str] = []
    for index, message_id in enumerate(message_ids[:2]):
        message = db.get(Message, str(message_id))
        if not message or message.conversation_id != task.conversation_id:
            continue
        product = products[index] if index < len(products) and isinstance(products[index], dict) else {}
        result = results[index] if index < len(results) and isinstance(results[index], dict) else {}
        sent = request.status != "failed" and result.get("status") == "sent"
        raw_payload = message.raw_payload if isinstance(message.raw_payload, dict) else {}
        message.message_status = "sent" if sent else "failed"
        message.raw_payload = {
            **raw_payload,
            "product_send_pending": False,
            "product_send_status": "sent" if sent else "failed",
            "product_send_error": None if sent else str(
                result.get("error") or request.error_message or "商品发送失败"
            )[:500],
            "goods_id": str(result.get("goods_id") or product.get("goods_id") or raw_payload.get("goods_id") or ""),
            "platform_product_id": str(
                result.get("product_id")
                or product.get("product_id")
                or raw_payload.get("platform_product_id")
                or ""
            ),
        }
        db.add(message)
        (sent_ids if sent else failed_ids).append(message.id)
    if failed_ids:
        conversation = db.get(Conversation, task.conversation_id)
        if conversation and payload.get("source") == "automation":
            conversation.human_required = True
            conversation.human_required_reason = "auto_reply_product_send_failed"
            conversation.human_required_word = None
            conversation.human_required_at = utcnow()
            db.add(conversation)
    return sent_ids, failed_ids


def _as_utc_naive(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value
    return value.astimezone(timezone.utc).replace(tzinfo=None)


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


def _normalized_message_content(value: Any) -> str:
    content = unicodedata.normalize("NFKC", str(value or ""))
    content = _INVISIBLE_CONTENT_RE.sub("", content)
    return _CONTENT_WHITESPACE_RE.sub(" ", content).strip()


def _message_type(payload: dict[str, Any]) -> str:
    message_type = str(payload.get("message_type") or payload.get("media_type") or "").strip()
    if message_type == "image" or payload.get("image_url"):
        return "image"
    return message_type or "text"


def _matches_outbound_echo(candidate: Message, payload: dict[str, Any], content: str) -> bool:
    incoming_type = _message_type(payload)
    candidate_payload = candidate.raw_payload if isinstance(candidate.raw_payload, dict) else {}
    candidate_type = _message_type(candidate_payload)
    if incoming_type != candidate_type:
        return False
    if incoming_type == "image":
        # Platform image URLs are rewritten after upload, so occurrence order is
        # stronger evidence than URL equality for an unbound local image send.
        return True
    return _normalized_message_content(candidate.content) == _normalized_message_content(content)


def _same_message_evidence(left: Message, right: Message) -> bool:
    if left.sender_role != right.sender_role:
        return False
    left_payload = left.raw_payload if isinstance(left.raw_payload, dict) else {}
    right_payload = right.raw_payload if isinstance(right.raw_payload, dict) else {}
    if _message_type(left_payload) != _message_type(right_payload):
        return False
    if _message_type(left_payload) == "image":
        return True
    return _normalized_message_content(left.content) == _normalized_message_content(right.content)


def _has_compatible_outbound_context(
    db: Session,
    conversation: Conversation,
    candidate: Message,
    payload: dict[str, Any],
) -> bool:
    snapshot_id = payload.get("snapshot_id")
    snapshot_sequence = _payload_non_negative_int(payload, "snapshot_sequence")
    if not snapshot_id or snapshot_sequence is None or candidate.conversation_sequence is None:
        return True
    dom_predecessor = db.scalar(
        select(Message)
        .where(
            and_(
                Message.conversation_id == conversation.id,
                Message.snapshot_id == snapshot_id,
                Message.snapshot_sequence < snapshot_sequence,
            )
        )
        .order_by(desc(Message.snapshot_sequence))
        .limit(1)
    )
    queue_predecessor = db.scalar(
        select(Message)
        .where(
            and_(
                Message.conversation_id == conversation.id,
                Message.conversation_sequence < candidate.conversation_sequence,
                Message.message_status != "failed",
            )
        )
        .order_by(desc(Message.conversation_sequence))
        .limit(1)
    )
    if dom_predecessor is None or queue_predecessor is None:
        return True
    return dom_predecessor.id == queue_predecessor.id or _same_message_evidence(
        dom_predecessor,
        queue_predecessor,
    )


def _find_outbound_echo_candidate(
    db: Session,
    conversation: Conversation,
    payload: dict[str, Any],
    content: str,
) -> Message | None:
    newest_candidates = list(db.scalars(
        select(Message)
        .where(
            and_(
                Message.conversation_id == conversation.id,
                Message.sender_role == "agent",
                Message.source.in_(_OUTBOUND_MESSAGE_SOURCES),
                Message.platform_message_id.is_(None),
            )
        )
        .order_by(desc(Message.conversation_sequence), desc(Message.created_at))
        .limit(_OUTBOUND_ECHO_CANDIDATE_LIMIT)
    ).all())
    for candidate in reversed(newest_candidates):
        candidate_payload = candidate.raw_payload if isinstance(candidate.raw_payload, dict) else {}
        if candidate_payload.get("platform_echo"):
            continue
        if (
            _matches_outbound_echo(candidate, payload, content)
            and _has_compatible_outbound_context(db, conversation, candidate, payload)
        ):
            return candidate
    return None


def _attach_outbound_echo(
    db: Session,
    message: Message,
    payload: dict[str, Any],
    request: RpaEventCreate,
) -> Message:
    previous_payload = message.raw_payload if isinstance(message.raw_payload, dict) else {}
    observed_at = _payload_datetime(payload, "observed_at") or request.received_at or utcnow()
    message.platform_message_id = request.platform_message_id or message.platform_message_id
    message.sender_name = payload.get("sender_name") or message.sender_name
    message.message_status = "sent"
    message.raw_payload = {
        **previous_payload,
        **payload,
        "platform_echo": {
            "event_id": request.event_id,
            "platform_message_id": request.platform_message_id,
            "observed_at": observed_at.isoformat(),
            "snapshot_id": payload.get("snapshot_id"),
            "snapshot_sequence": _payload_non_negative_int(payload, "snapshot_sequence"),
        },
    }
    _apply_collection_metadata(message, payload, request, preserve_existing=True)
    db.add(message)
    db.flush()
    return message


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
                    (
                        request.platform_message_id
                        and not candidate.platform_message_id
                    )
                    or
                    not platform_sent_at
                    or not candidate.platform_sent_at
                    or candidate.platform_sent_at == platform_sent_at
                )
            )
        ),
        None,
    )
    if snapshot_match:
        platform_time_corrected = bool(
            request.platform_message_id
            and not snapshot_match.platform_message_id
            and platform_sent_at
            and snapshot_match.platform_sent_at
            and snapshot_match.platform_sent_at != platform_sent_at
        )
        if request.platform_message_id and not snapshot_match.platform_message_id:
            snapshot_match.platform_message_id = request.platform_message_id
        snapshot_match.sender_name = payload.get("sender_name") or snapshot_match.sender_name
        snapshot_match.raw_payload = {**snapshot_match.raw_payload, **payload}
        _apply_collection_metadata(snapshot_match, payload, request, preserve_existing=True)
        db.add(snapshot_match)
        db.flush()
        return snapshot_match, platform_time_corrected and _is_live_reply_source(payload, request)

    if request.platform_message_id and platform_sent_at:
        recent_observation = (observed_at or utcnow()) - timedelta(seconds=10)
        unidentified_match = db.scalar(
            select(Message)
            .where(
                and_(
                    Message.conversation_id == conversation.id,
                    Message.platform_message_id.is_(None),
                    Message.source == "rpa",
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
                    Message.source == "rpa",
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
        outbound_echo = _find_outbound_echo_candidate(db, conversation, payload, content)
        if outbound_echo:
            return _attach_outbound_echo(
                db,
                outbound_echo,
                payload,
                request,
            ), False
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
    append_message(db, message, collected_at=message.observed_at)
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


def _set_auto_transfer_state(conversation: Conversation, state: dict[str, Any]) -> None:
    metadata = dict(conversation.metadata_json or {})
    metadata["auto_transfer"] = {
        **(metadata.get("auto_transfer") if isinstance(metadata.get("auto_transfer"), dict) else {}),
        **state,
        "updated_at": utcnow().isoformat(),
    }
    conversation.metadata_json = metadata


def _queue_transfer_task_after_send(db: Session, task: RpaTask) -> None:
    payload = task.payload_json if isinstance(task.payload_json, dict) else {}
    transfer = payload.get("after_send_transfer_conversation")
    if not isinstance(transfer, dict):
        return
    idempotency_key = str(transfer.get("idempotency_key") or "").strip()[:160]
    if not idempotency_key:
        return
    existing = db.scalar(
        select(RpaTask).where(
            RpaTask.user_id == task.user_id,
            RpaTask.idempotency_key == idempotency_key,
        )
    )
    if existing is not None:
        return
    conversation = db.get(Conversation, task.conversation_id) if task.conversation_id else None
    if conversation is None:
        return
    transfer_task = RpaTask(
        user_id=task.user_id,
        platform_account_id=conversation.platform_account_id,
        conversation_id=conversation.id,
        task_type="transfer_conversation",
        idempotency_key=idempotency_key,
        platform_code=conversation.platform_code,
        payload_json={
            "conversation_id": conversation.id,
            "platform_account_id": conversation.platform_account_id,
            "external_conversation_id": conversation.external_conversation_id,
            "customer_name": conversation.customer_name or "",
            "source": "automation_transfer",
            "source_message_id": str(transfer.get("source_message_id") or ""),
            "robot_id": str(transfer.get("robot_id") or ""),
            "trigger_reason": str(transfer.get("trigger_reason") or ""),
            "trans_reason": str(transfer.get("trans_reason") or "无原因直接转移"),
            "ack_task_id": task.id,
        },
        status="queued",
        priority=max(task.priority, 10),
    )
    db.add(transfer_task)
    db.flush()
    _set_auto_transfer_state(conversation, {
        "status": "transferring",
        "transfer_task_id": transfer_task.id,
        "ack_task_id": task.id,
        "source_message_id": str(transfer.get("source_message_id") or ""),
        "robot_id": str(transfer.get("robot_id") or ""),
        "reason": str(transfer.get("trigger_reason") or ""),
    })
    db.add(conversation)


def complete_task(db: Session, task: RpaTask, request: TaskCompleteRequest) -> RpaTask:
    was_completed = task.status == "completed"
    result_json = dict(request.result_json or {})
    task.status = request.status
    task.result_json = result_json
    task.error_message = request.error_message
    task.completed_at = utcnow()
    if task.idempotency_key and task.idempotency_key.startswith("auto-timeout:"):
        _, robot_id, source_message_id = task.idempotency_key.split(":", 2)
        deferred_reply = db.scalar(
            select(RpaTask).where(
                RpaTask.idempotency_key == f"auto-reply:{robot_id}:{source_message_id}:text",
                RpaTask.status == "waiting_timeout",
            )
        )
        if deferred_reply is not None:
            deferred_reply.status = "queued"
            db.add(deferred_reply)
    if task.task_type == "send_message" and task.idempotency_key and task.idempotency_key.startswith("customer-outreach:"):
        from app.models import CustomerOutreachRun

        outreach = db.scalar(select(CustomerOutreachRun).where(CustomerOutreachRun.send_task_id == task.id))
        if outreach:
            text_sent = request.result_json.get("text_sent") is True
            outreach_completed_now = (
                (request.status == "completed" or text_sent)
                and outreach.status != "completed"
            )
            if request.status == "completed" or text_sent:
                outreach.status = "completed"
                outreach.completed_at = utcnow()
                outreach.cancel_reason = None
                decision = outreach.decision_json if isinstance(outreach.decision_json, dict) else {}
                if (
                    outreach_completed_now
                    and text_sent
                    and decision.get("mark_human_required_after_send") is True
                ):
                    conversation = db.get(Conversation, outreach.conversation_id)
                    if conversation:
                        conversation.human_required = True
                        conversation.human_required_reason = f"{outreach.strategy_type}_outreach"
                        conversation.human_required_word = None
                        conversation.human_required_at = utcnow()
                        db.add(conversation)
            else:
                outreach.status = "failed"
                outreach.cancel_reason = "send_failed"
            db.add(outreach)
    if task.task_type == "refresh_customer_orders" and request.status == "failed":
        from app.models import CustomerOutreachRun

        outreach_id = str((task.payload_json or {}).get("outreach_run_id") or "")
        outreach = db.get(CustomerOutreachRun, outreach_id) if outreach_id else None
        if outreach and outreach.status == "rechecking":
            outreach.status = "scheduled"
            outreach.due_at = utcnow() + timedelta(minutes=10)
            outreach.cancel_reason = "order_status_unknown"
            db.add(outreach)
    if task.message_id:
        message = db.get(Message, task.message_id)
        if message:
            text_sent = bool(request.result_json.get("text_sent"))
            message, merged_from_message_id = _merge_task_message_with_platform_echo(
                db,
                task,
                message,
                request,
            )
            if merged_from_message_id:
                result_json["merged_from_message_id"] = merged_from_message_id
                task.result_json = result_json
            message.message_status = "sent" if request.status == "completed" or text_sent else "failed"
            if request.result_json.get("platform_message_id"):
                message.platform_message_id = request.result_json["platform_message_id"]
            db.add(message)
            db.flush()
            if message.message_status == "sent":
                conversation = db.get(Conversation, task.conversation_id)
                if conversation:
                    _refresh_awaiting_reply(db, conversation)
                    if not was_completed and task.task_type == "send_message":
                        _queue_transfer_task_after_send(db, task)
            else:
                conversation = db.get(Conversation, task.conversation_id)
                if conversation:
                    _refresh_conversation_summary(db, conversation)
    if task.task_type == "transfer_conversation":
        conversation = db.get(Conversation, task.conversation_id) if task.conversation_id else None
        if conversation:
            if request.status == "completed":
                _set_auto_transfer_state(conversation, {
                    "status": "transferred",
                    "transfer_task_id": task.id,
                    "completed_at": utcnow().isoformat(),
                    "target_cs_id": str(result_json.get("target_cs_id") or ""),
                    "target_cs_username": str(result_json.get("target_cs_username") or ""),
                })
                conversation.human_required = False
                conversation.human_required_reason = None
                conversation.human_required_word = None
                conversation.human_required_at = None
            else:
                _set_auto_transfer_state(conversation, {
                    "status": "failed",
                    "transfer_task_id": task.id,
                    "failed_at": utcnow().isoformat(),
                    "error": request.error_message or result_json.get("error") or "",
                })
                conversation.human_required = True
                conversation.human_required_reason = "transfer_conversation_failed"
                conversation.human_required_word = None
                conversation.human_required_at = utcnow()
            db.add(conversation)
    image_confirmed = (
        request.status == "completed"
        and request.result_json.get("image_sent") is True
    )
    image_confirmation_pending = (
        request.status == "confirmation_pending"
        and request.result_json.get("image_confirmation_pending") is True
    )
    if (
        (image_confirmed or image_confirmation_pending)
        and not was_completed
        and task.task_type == "send_message"
    ):
        payload = task.payload_json if isinstance(task.payload_json, dict) else {}
        follow_up = payload.get("follow_up")
        if isinstance(follow_up, dict) and follow_up.get("type") == "image" and follow_up.get("url"):
            image_message, image_merged_from_message_id = _upsert_reply_bundle_image_message(
                db,
                task,
                payload,
                follow_up,
                request,
                image_confirmed=image_confirmed,
                image_confirmation_pending=image_confirmation_pending,
            )
            result_json["image_message_id"] = image_message.id
            if image_merged_from_message_id:
                result_json["image_merged_from_message_id"] = image_merged_from_message_id
            task.result_json = result_json
            conversation = db.get(Conversation, task.conversation_id)
            if conversation:
                conversation.latest_message_text = image_message.content
                conversation.latest_message_at = image_message.sent_at
                db.add(conversation)
    if (
        request.status == "failed"
        and not was_completed
        and task.task_type == "send_message"
        and isinstance(task.payload_json, dict)
    ):
        if task.payload_json.get("source") == "automation" or task.idempotency_key and task.idempotency_key.startswith("auto-reply:"):
            conversation = db.get(Conversation, task.conversation_id) if task.conversation_id else None
            if conversation:
                conversation.human_required = True
                conversation.human_required_reason = "auto_reply_send_failed"
                conversation.human_required_word = None
                conversation.human_required_at = utcnow()
                db.add(conversation)
        follow_up_message_id = str(task.payload_json.get("follow_up_message_id") or "").strip()
        follow_up_message = db.get(Message, follow_up_message_id) if follow_up_message_id else None
        if follow_up_message and follow_up_message.conversation_id == task.conversation_id:
            follow_up_message.message_status = "failed"
            db.add(follow_up_message)
        _complete_reply_bundle_products(db, task, request)
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
                append_message(db, image_message, collected_at=now)
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
    if task.task_type == "send_message" and isinstance(task.payload_json, dict):
        product_sent_ids, product_failed_ids = _complete_reply_bundle_products(db, task, request)
        if product_sent_ids or product_failed_ids:
            result_json["product_message_ids"] = product_sent_ids
            result_json["product_failed_message_ids"] = product_failed_ids
            task.result_json = result_json
            conversation = db.get(Conversation, task.conversation_id)
            if conversation:
                _refresh_conversation_summary(db, conversation)
    task.result_json = dict(result_json)
    flag_modified(task, "result_json")
    db.add(task)
    db.commit()
    db.refresh(task)
    return task
