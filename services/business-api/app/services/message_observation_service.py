from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
from collections import Counter
from dataclasses import dataclass
from threading import Lock
from typing import Any

from pydantic import ValidationError
from sqlalchemy import and_, select
from sqlalchemy.orm import Session

from app.core.security import utcnow
from app.models import Conversation, Message, MessageObservation, RpaNode, User
from app.schemas.rpa import MessageSnapshotPayload, RpaEventCreate
from app.services.message_sequence_service import (
    AlignmentResult,
    align_message_sequences,
    snapshot_payload_hash,
)
from app.services.message_queue_service import append_messages


class SnapshotProtocolError(ValueError):
    pass


@dataclass(frozen=True)
class SnapshotProcessResult:
    observation: MessageObservation
    appended_messages: list[Message]
    conversation: Conversation


_conversation_locks_guard = Lock()
_conversation_locks: dict[str, Lock] = {}


def _conversation_lock(conversation_id: str) -> Lock:
    with _conversation_locks_guard:
        return _conversation_locks.setdefault(conversation_id, Lock())


def _snapshot_payload(request: RpaEventCreate) -> MessageSnapshotPayload:
    try:
        return MessageSnapshotPayload.model_validate(request.payload_json)
    except ValidationError as exc:
        raise SnapshotProtocolError(str(exc)) from exc


def _conversation_for_snapshot(
    db: Session,
    user: User,
    request: RpaEventCreate,
) -> Conversation:
    if request.platform_code not in {"pinduoduo", "wechat"}:
        raise SnapshotProtocolError("unsupported platform for message_snapshot")
    if not request.platform_account_id:
        raise SnapshotProtocolError("platform_account_id is required")
    external_id = str(request.conversation_external_id or "").strip()
    if not external_id:
        raise SnapshotProtocolError("conversation_external_id is required")
    conversation = db.scalar(
        select(Conversation).where(
            and_(
                Conversation.user_id == user.id,
                Conversation.platform_account_id == request.platform_account_id,
                Conversation.platform_code == request.platform_code,
                Conversation.external_conversation_id == external_id,
            )
        )
    )
    if not conversation:
        raise SnapshotProtocolError("matching conversation not found")
    return conversation


def _serialized_batch(payload: MessageSnapshotPayload) -> dict[str, Any]:
    return {
        "batch_index": payload.batch_index,
        "message_offset": payload.message_offset,
        "messages": [message.model_dump(mode="json") for message in payload.messages],
    }


def _sequence_evidence_hash(messages: list[dict[str, Any]]) -> str:
    evidence = [
        {
            "sender_role": message.get("sender_role"),
            "message_type": message.get("message_type"),
            "content": message.get("content"),
            "image_url": message.get("image_url"),
        }
        for message in messages
    ]
    encoded = json.dumps(evidence, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _snapshot_metrics(messages: list[dict[str, Any]]) -> dict[str, Any]:
    direction_counts = Counter(str(message.get("sender_role") or "") for message in messages)
    type_counts = Counter(str(message.get("message_type") or "") for message in messages)
    platform_ids = [
        str(message.get("platform_message_id"))
        for message in messages
        if message.get("platform_message_id")
    ]
    return {
        "message_count": len(messages),
        "direction_counts": {
            key: direction_counts[key] for key in ("customer", "agent", "platform")
            if direction_counts[key] > 0 or key in {"customer", "agent"}
        },
        "type_counts": {
            key: type_counts[key] for key in (
                "text", "image", "product", "order", "system", "context", "time", "unknown"
            )
        },
        "sequence_hash": _sequence_evidence_hash(messages),
        "platform_id_missing_count": len(messages) - len(platform_ids),
        "platform_id_duplicate_count": len(platform_ids) - len(set(platform_ids)),
    }


def _platform_message_id(value: Any) -> str:
    return str(value or "").strip()


def _platform_message_id_sort_key(value: Any) -> tuple[int, int | str]:
    message_id = _platform_message_id(value)
    if message_id.isdigit():
        return (0, int(message_id))
    return (1, message_id)


def _is_pdd_api_chat_list_snapshot(
    observation: MessageObservation,
    messages: list[dict[str, Any]],
) -> bool:
    raw_payload = observation.raw_payload if isinstance(observation.raw_payload, dict) else {}
    source_snapshot_id = str(raw_payload.get("source_snapshot_id") or "")
    if observation.platform_code != "pinduoduo" or not source_snapshot_id.startswith("pdd-api-list-"):
        return False
    return bool(messages) and all(_platform_message_id(item.get("platform_message_id")) for item in messages)


def _as_utc_naive(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value
    return value.astimezone(timezone.utc).replace(tzinfo=None)


def _message_datetime(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return _as_utc_naive(value)
    if isinstance(value, int | float):
        timestamp = float(value)
        if timestamp > 10_000_000_000:
            timestamp /= 1000
        return datetime.fromtimestamp(timestamp, tz=timezone.utc).replace(tzinfo=None)
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        if text.isdigit():
            return _message_datetime(int(text))
        try:
            return _as_utc_naive(datetime.fromisoformat(text.replace("Z", "+00:00")))
        except ValueError:
            return None
    return None


def _message_sort_datetime(message: Message | dict[str, Any]) -> datetime | None:
    if isinstance(message, Message):
        return message.platform_sent_at or message.sent_at or message.observed_at or message.collected_at
    return (
        _message_datetime(message.get("platform_sent_at"))
        or _message_datetime(message.get("sent_at"))
        or _message_datetime(message.get("observed_at"))
        or _message_datetime(message.get("collected_at"))
    )


def _message_automation_mode(message: Message | dict[str, Any]) -> str:
    if isinstance(message, Message):
        raw_payload = message.raw_payload if isinstance(message.raw_payload, dict) else {}
        return str(raw_payload.get("automation_mode") or "trigger")
    return str(message.get("automation_mode") or "trigger")


def _refresh_conversation_latest_from_messages(
    conversation: Conversation,
    messages: list[Message | dict[str, Any]],
    fallback_at: datetime,
) -> None:
    conversational_messages = [
        item for item in messages
        if _message_automation_mode(item) in {"trigger", "context"}
    ]
    if not conversational_messages:
        return
    latest = max(
        conversational_messages,
        key=lambda item: (
            _message_sort_datetime(item) or fallback_at,
            _platform_message_id_sort_key(
                item.platform_message_id if isinstance(item, Message) else item.get("platform_message_id")
            ),
        ),
    )
    conversation.latest_message_text = (
        latest.content if isinstance(latest, Message) else str(latest.get("content") or "")
    )
    conversation.latest_message_at = _message_sort_datetime(latest) or fallback_at


def _assemble_batches(observation: MessageObservation) -> list[dict[str, Any]] | None:
    raw_payload = observation.raw_payload if isinstance(observation.raw_payload, dict) else {}
    batches = raw_payload.get("batches")
    if not isinstance(batches, dict) or len(batches) < observation.batch_count:
        return None
    assembled: list[dict[str, Any]] = []
    expected_offset = 0
    for batch_index in range(observation.batch_count):
        batch = batches.get(str(batch_index))
        if not isinstance(batch, dict) or batch.get("message_offset") != expected_offset:
            raise SnapshotProtocolError("snapshot batches have a gap or overlapping offset")
        messages = batch.get("messages")
        if not isinstance(messages, list):
            raise SnapshotProtocolError("snapshot batch messages are invalid")
        assembled.extend(messages)
        expected_offset += len(messages)
    if expected_offset != observation.message_count:
        raise SnapshotProtocolError("assembled message count does not match message_count")
    return assembled


def snapshot_messages_from_observation(
    observation: MessageObservation,
) -> list[dict[str, Any]]:
    messages = _assemble_batches(observation)
    if messages is None:
        raise SnapshotProtocolError("snapshot is incomplete")
    return messages


def build_snapshot_messages(
    user: User,
    conversation: Conversation,
    observation: MessageObservation,
    messages: list[dict[str, Any]],
    *,
    collection_kind: str,
) -> list[Message]:
    return [
        _snapshot_message(
            user,
            conversation,
            observation,
            item,
            collection_kind=collection_kind,
        )
        for item in messages
    ]


def _record_message_sync_issue(
    conversation: Conversation,
    observation: MessageObservation,
) -> None:
    metadata = dict(conversation.metadata_json or {})
    previous = metadata.get("message_sync_issue")
    previous_issue = previous if isinstance(previous, dict) else {}
    is_consecutive = previous_issue.get("status") == "active"
    failure_count = int(previous_issue.get("consecutive_failure_count") or 0) + 1 if is_consecutive else 1
    detected_at = observation.processed_at or utcnow()
    metadata["message_sync_issue"] = {
        "status": "active",
        "observation_id": observation.observation_id,
        "first_detected_at": (
            previous_issue.get("first_detected_at")
            if is_consecutive
            else detected_at.isoformat()
        ),
        "latest_detected_at": detected_at.isoformat(),
        "unread": bool(observation.unread),
        "message_count": observation.message_count,
        "consecutive_failure_count": failure_count,
        "requires_attention": bool(observation.unread or failure_count >= 2),
        "dismissed_at": None,
    }
    conversation.metadata_json = metadata


def _resolve_message_sync_issue(conversation: Conversation, resolved_at: datetime) -> None:
    metadata = dict(conversation.metadata_json or {})
    current = metadata.get("message_sync_issue")
    if not isinstance(current, dict) or current.get("status") != "active":
        return
    metadata["message_sync_issue"] = {
        **current,
        "status": "resolved",
        "requires_attention": False,
        "resolved_at": resolved_at.isoformat(),
        "resolution": "snapshot_aligned",
    }
    conversation.metadata_json = metadata


def _history_tail(db: Session, conversation_id: str, limit: int = 200) -> list[Message]:
    newest = list(
        db.scalars(
            select(Message)
            .where(
                Message.conversation_id == conversation_id,
                Message.message_status != "failed",
            )
            .order_by(Message.conversation_sequence.desc())
            .limit(limit)
        ).all()
    )
    return list(reversed(newest))


def _snapshot_message(
    user: User,
    conversation: Conversation,
    observation: MessageObservation,
    item: dict[str, Any],
    *,
    collection_kind: str,
) -> Message:
    sender_role = str(item.get("sender_role") or "").strip()
    content = str(item.get("content") or "")
    platform_sent_at = _message_datetime(item.get("platform_sent_at"))
    sent_at = platform_sent_at or observation.collected_at
    return Message(
        conversation_id=conversation.id,
        user_id=user.id,
        platform_code=conversation.platform_code,
        platform_message_id=item.get("platform_message_id") or None,
        sender_role=sender_role,
        content=content,
        message_status="sent",
        source="rpa",
        raw_payload={
            **item,
            "observation_id": observation.observation_id,
            "source_snapshot_id": (observation.raw_payload or {}).get("source_snapshot_id"),
        },
        sent_at=sent_at,
        platform_sent_at=platform_sent_at,
        observed_at=observation.collected_at,
        snapshot_id=(observation.raw_payload or {}).get("source_snapshot_id"),
        time_label=item.get("time_label") or None,
        has_explicit_time=bool(item.get("has_explicit_time")),
        collected_at=observation.collected_at,
        first_observation_id=observation.observation_id,
        first_dom_sequence=item.get("dom_sequence"),
        collection_kind=collection_kind,
        automation_eligible=(
            collection_kind == "incremental"
            and sender_role == "customer"
            and item.get("automation_mode", "trigger") == "trigger"
        ),
    )


def _overlap_pairs(
    history: list[Message],
    messages: list[dict[str, Any]],
    *,
    method: str,
    overlap_size: int,
    append_from: int | None,
    diagnostics: dict[str, Any],
) -> list[tuple[Message, dict[str, Any]]]:
    if method == "content_overlap" and overlap_size:
        start = len(history) - overlap_size
        return list(zip(history[start:], messages[:overlap_size], strict=True))
    if method == "platform_id_anchor" and append_from is not None:
        history_index = diagnostics.get("anchor_history_index")
        current_index = diagnostics.get("anchor_current_index")
        if isinstance(history_index, int) and isinstance(current_index, int):
            size = append_from - current_index
            return list(zip(
                history[history_index:history_index + size],
                messages[current_index:append_from],
                strict=True,
            ))
    return []


def _attach_snapshot_echo_evidence(
    db: Session,
    observation: MessageObservation,
    pairs: list[tuple[Message, dict[str, Any]]],
) -> None:
    for existing, item in pairs:
        platform_message_id = item.get("platform_message_id")
        if existing.sender_role != "agent" or existing.platform_message_id or not platform_message_id:
            continue
        previous_payload = existing.raw_payload if isinstance(existing.raw_payload, dict) else {}
        existing.platform_message_id = platform_message_id
        existing.message_status = "sent"
        existing.raw_payload = {
            **previous_payload,
            **({
                key: item[key]
                for key in (
                    "message_type", "media_type", "image_url", "image_sha256",
                    "media_resource_id", "structured_payload",
                )
                if item.get(key) is not None
            }),
            "platform_echo": {
                "observation_id": observation.observation_id,
                "platform_message_id": platform_message_id,
                "observed_at": observation.collected_at.isoformat(),
                "snapshot_sequence": item.get("dom_sequence"),
            },
        }
        db.add(existing)


def _apply_formal_snapshot(
    db: Session,
    user: User,
    conversation: Conversation,
    observation: MessageObservation,
    messages: list[dict[str, Any]],
    history: list[Message],
    result: AlignmentResult,
) -> list[Message]:
    pairs = _overlap_pairs(
        history,
        messages,
        method=result.method,
        overlap_size=result.overlap_size,
        append_from=result.append_from,
        diagnostics=result.diagnostics,
    )
    _attach_snapshot_echo_evidence(db, observation, pairs)
    if result.status not in {"bootstrap", "aligned"} or result.append_from is None:
        return []

    collection_kind = "bootstrap" if result.status == "bootstrap" else "incremental"
    new_messages = [
        _snapshot_message(
            user,
            conversation,
            observation,
            item,
            collection_kind=collection_kind,
        )
        for item in messages[result.append_from:]
    ]
    append_messages(
        db,
        new_messages,
        collected_at=observation.collected_at,
        collection_kind=collection_kind,
    )
    if new_messages:
        tail = new_messages[-1]
        _refresh_conversation_latest_from_messages(
            conversation,
            new_messages,
            observation.collected_at,
        )
        conversation.unread_count = 1 if observation.unread else 0
        trigger_tail = next((
            item for item in reversed(new_messages)
            if (item.raw_payload or {}).get("automation_mode", "trigger") == "trigger"
        ), None)
        conversation.awaiting_reply = bool(
            trigger_tail is not None and trigger_tail.sender_role == "customer"
        )
        if (
            collection_kind == "incremental"
            and trigger_tail is not None
            and trigger_tail.sender_role == "customer"
            and observation.collected_at
            and (
                conversation.deleted_at is None
                or _as_utc_naive(observation.collected_at) > _as_utc_naive(conversation.deleted_at)
            )
        ):
            conversation.deleted_at = None
        conversation.status = "active"
    db.add(conversation)
    return new_messages


def _update_existing_from_api_snapshot(
    db: Session,
    existing: Message,
    observation: MessageObservation,
    item: dict[str, Any],
) -> None:
    previous_payload = existing.raw_payload if isinstance(existing.raw_payload, dict) else {}
    had_platform_sent_at = existing.platform_sent_at is not None
    platform_sent_at = _message_datetime(item.get("platform_sent_at"))
    existing.sender_role = str(item.get("sender_role") or existing.sender_role)
    existing.content = str(item.get("content") or existing.content)
    existing.message_status = "sent"
    existing.source = "rpa"
    existing.raw_payload = {
        **previous_payload,
        **item,
        "latest_observation_id": observation.observation_id,
        "source_snapshot_id": (observation.raw_payload or {}).get("source_snapshot_id"),
    }
    if existing.first_observation_id is None:
        existing.first_observation_id = observation.observation_id
        existing.first_dom_sequence = item.get("dom_sequence")
    if existing.snapshot_id is None:
        existing.snapshot_id = (observation.raw_payload or {}).get("source_snapshot_id")
    if existing.snapshot_sequence is None:
        existing.snapshot_sequence = item.get("dom_sequence")
    if platform_sent_at is not None:
        existing.platform_sent_at = existing.platform_sent_at or platform_sent_at
        if not had_platform_sent_at:
            existing.sent_at = platform_sent_at
    if not existing.time_label and item.get("time_label"):
        existing.time_label = str(item.get("time_label"))
    if existing.has_explicit_time is None and item.get("has_explicit_time") is not None:
        existing.has_explicit_time = bool(item.get("has_explicit_time"))
    existing.collected_at = existing.collected_at or observation.collected_at
    existing.observed_at = observation.collected_at
    db.add(existing)


def _product_identity(message: Message | dict[str, Any]) -> str:
    raw_payload = (
        message.raw_payload
        if isinstance(message, Message)
        else message.get("structured_payload")
    )
    structured_payload = raw_payload if isinstance(raw_payload, dict) else {}
    direct_payload = (
        message.raw_payload
        if isinstance(message, Message)
        else message
    )
    return _platform_message_id(
        structured_payload.get("goods_id")
        or structured_payload.get("product_id")
        or direct_payload.get("goods_id")
        or direct_payload.get("product_id")
        or direct_payload.get("platform_product_id")
    )


def _is_provisional_product_message(message: Message) -> bool:
    if message.sender_role != "agent" or message.platform_message_id:
        return False
    raw_payload = message.raw_payload if isinstance(message.raw_payload, dict) else {}
    if raw_payload.get("message_type") != "product":
        return False
    if message.source not in {"automation", "ai"}:
        return False
    return bool(_product_identity(message))


def _reconcile_product_echo(
    db: Session,
    candidates_by_product: dict[str, list[Message]],
    observation: MessageObservation,
    item: dict[str, Any],
) -> Message | None:
    if (
        str(item.get("message_type") or "") != "product"
        or str(item.get("sender_role") or "") != "agent"
    ):
        return None
    product_id = _product_identity(item)
    if not product_id:
        return None
    candidates = candidates_by_product.get(product_id) or []
    if not candidates:
        return None
    existing = candidates.pop(0)
    previous_payload = existing.raw_payload if isinstance(existing.raw_payload, dict) else {}
    existing.platform_message_id = item.get("platform_message_id") or existing.platform_message_id
    existing.sender_role = str(item.get("sender_role") or existing.sender_role)
    existing.content = str(item.get("content") or existing.content)
    existing.message_status = "sent"
    existing.source = "rpa"
    existing.raw_payload = {
        **previous_payload,
        **item,
        "automation_origin": previous_payload.get("automation_origin") or "product_recommendation",
        "platform_echo": {
            "observation_id": observation.observation_id,
            "platform_message_id": item.get("platform_message_id"),
            "observed_at": observation.collected_at.isoformat(),
            "snapshot_sequence": item.get("dom_sequence"),
        },
    }
    platform_sent_at = _message_datetime(item.get("platform_sent_at"))
    if platform_sent_at is not None:
        existing.platform_sent_at = existing.platform_sent_at or platform_sent_at
        existing.sent_at = existing.sent_at or platform_sent_at
    existing.collected_at = existing.collected_at or observation.collected_at
    existing.observed_at = observation.collected_at
    db.add(existing)
    return existing


def _apply_platform_id_ordered_snapshot(
    db: Session,
    user: User,
    conversation: Conversation,
    observation: MessageObservation,
    messages: list[dict[str, Any]],
) -> list[Message]:
    ordered_messages = sorted(
        messages,
        key=lambda item: (
            _platform_message_id_sort_key(item.get("platform_message_id")),
            int(item.get("dom_sequence") or 0),
        ),
    )
    platform_ids = [_platform_message_id(item.get("platform_message_id")) for item in ordered_messages]
    existing_messages = list(db.scalars(
        select(Message).where(
            Message.conversation_id == conversation.id,
            Message.platform_message_id.in_(platform_ids),
        )
    ).all())
    existing_by_platform_id: dict[str, Message] = {}
    for message in existing_messages:
        platform_message_id = _platform_message_id(message.platform_message_id)
        if not platform_message_id or platform_message_id in existing_by_platform_id:
            continue
        existing_by_platform_id[platform_message_id] = message
    provisional_products: dict[str, list[Message]] = {}
    if ordered_messages:
        provisional_messages = db.scalars(
            select(Message).where(
                Message.conversation_id == conversation.id,
                Message.platform_message_id.is_(None),
                Message.sender_role == "agent",
                Message.source.in_(("automation", "ai")),
            ).order_by(Message.conversation_sequence.asc())
        ).all()
        for provisional in provisional_messages:
            if not _is_provisional_product_message(provisional):
                continue
            provisional_products.setdefault(_product_identity(provisional), []).append(provisional)
    has_platform_anchor = bool(existing_by_platform_id)
    collection_kind = "incremental" if has_platform_anchor else "bootstrap"
    new_messages: list[Message] = []
    updated_count = 0
    reconciled_product_count = 0
    for item in ordered_messages:
        platform_message_id = _platform_message_id(item.get("platform_message_id"))
        existing = existing_by_platform_id.get(platform_message_id)
        if existing:
            _update_existing_from_api_snapshot(db, existing, observation, item)
            updated_count += 1
            continue
        reconciled = _reconcile_product_echo(
            db,
            provisional_products,
            observation,
            item,
        )
        if reconciled is not None:
            reconciled_product_count += 1
            continue
        new_messages.append(_snapshot_message(
            user,
            conversation,
            observation,
            item,
            collection_kind=collection_kind,
        ))
    append_messages(
        db,
        new_messages,
        collected_at=observation.collected_at,
        collection_kind=collection_kind,
    )
    if ordered_messages:
        _refresh_conversation_latest_from_messages(
            conversation,
            ordered_messages,
            observation.collected_at,
        )
        trigger_tail = next((
            item for item in reversed(ordered_messages)
            if item.get("automation_mode", "trigger") == "trigger"
        ), None)
        conversation.awaiting_reply = bool(
            trigger_tail is not None and trigger_tail.get("sender_role") == "customer"
        )
        if (
            new_messages
            and collection_kind == "incremental"
            and any(message.sender_role == "customer" for message in new_messages)
            and observation.collected_at
            and (
                conversation.deleted_at is None
                or _as_utc_naive(observation.collected_at) > _as_utc_naive(conversation.deleted_at)
            )
        ):
            conversation.deleted_at = None
        conversation.unread_count = 1 if observation.unread else 0
        conversation.status = "active"
        db.add(conversation)
    observation.diagnostics_json = {
        **(observation.diagnostics_json or {}),
        "platform_id_ordered": True,
        "platform_id_updated_count": updated_count,
        "platform_id_new_count": len(new_messages),
        "platform_id_product_reconciled_count": reconciled_product_count,
        "platform_id_first": platform_ids[0] if platform_ids else None,
        "platform_id_last": platform_ids[-1] if platform_ids else None,
        "platform_id_anchor_found": has_platform_anchor,
        "collection_kind": collection_kind,
    }
    return new_messages


def process_message_snapshot(
    db: Session,
    user: User,
    node: RpaNode,
    request: RpaEventCreate,
    *,
    write_messages: bool,
) -> SnapshotProcessResult:
    """Store, align and optionally append one complete ordered snapshot."""
    payload = _snapshot_payload(request)
    conversation = _conversation_for_snapshot(db, user, request)
    with _conversation_lock(conversation.id):
        return _process_message_snapshot_locked(
            db,
            user,
            node,
            request,
            payload,
            conversation,
            write_messages=write_messages,
        )


def _process_message_snapshot_locked(
    db: Session,
    user: User,
    node: RpaNode,
    request: RpaEventCreate,
    payload: MessageSnapshotPayload,
    conversation: Conversation,
    *,
    write_messages: bool,
) -> SnapshotProcessResult:
    if write_messages:
        db.refresh(conversation, with_for_update=True)
    existing = db.scalar(
        select(MessageObservation).where(
            MessageObservation.observation_id == payload.observation_id
        )
    )
    if existing and (
        existing.user_id != user.id
        or existing.platform_account_id != request.platform_account_id
        or existing.conversation_id != conversation.id
    ):
        raise SnapshotProtocolError("observation_id belongs to another snapshot scope")
    if existing and existing.payload_hash.lower() != payload.payload_hash.lower():
        raise SnapshotProtocolError(
            "observation_id was reused with a different payload_hash"
        )
    if existing and existing.alignment_status != "pending":
        return SnapshotProcessResult(existing, [], conversation)

    message_count = payload.message_count
    if message_count is None:
        message_count = len(payload.messages)
    observation = existing or MessageObservation(
        observation_id=payload.observation_id,
        user_id=user.id,
        node_id=node.id,
        platform_account_id=request.platform_account_id,
        conversation_id=conversation.id,
        platform_code=request.platform_code,
        conversation_external_id=request.conversation_external_id or "",
        collected_at=payload.collected_at,
        unread=payload.unread,
        payload_hash=payload.payload_hash.lower(),
        message_count=message_count,
        batch_count=payload.batch_count,
        received_batch_count=0,
        raw_payload={
            "batches": {},
            "source_snapshot_id": payload.source_snapshot_id,
        },
    )
    if existing and (
        existing.batch_count != payload.batch_count
        or existing.message_count != message_count
        or _as_utc_naive(existing.collected_at) != _as_utc_naive(payload.collected_at)
    ):
        observation.alignment_status = "failed"
        observation.error_message = "snapshot metadata changed between batches"
        observation.processed_at = utcnow()
        db.add(observation)
        return SnapshotProcessResult(observation, [], conversation)

    raw_payload = dict(observation.raw_payload or {})
    if raw_payload.get("source_snapshot_id") != payload.source_snapshot_id:
        observation.alignment_status = "failed"
        observation.error_message = "snapshot diagnostic metadata changed between batches"
        observation.processed_at = utcnow()
        db.add(observation)
        return SnapshotProcessResult(observation, [], conversation)
    batches = dict(raw_payload.get("batches") or {})
    batch_key = str(payload.batch_index)
    serialized_batch = _serialized_batch(payload)
    if batch_key in batches and batches[batch_key] != serialized_batch:
        observation.alignment_status = "failed"
        observation.error_message = "batch_index was reused with different content"
        observation.processed_at = utcnow()
        db.add(observation)
        return SnapshotProcessResult(observation, [], conversation)
    batches[batch_key] = serialized_batch
    raw_payload["batches"] = batches
    observation.raw_payload = raw_payload
    observation.received_batch_count = len(batches)
    db.add(observation)
    db.flush()

    try:
        messages = _assemble_batches(observation)
        if messages is None:
            return SnapshotProcessResult(observation, [], conversation)
        current_hash = snapshot_payload_hash(messages)
        structured_hash = snapshot_payload_hash(messages, include_timeline_fields=False)
        legacy_hash = snapshot_payload_hash(
            messages,
            include_structured_fields=False,
            include_timeline_fields=False,
        )
        accepted_contracts = {
            current_hash: "timeline_v2",
            structured_hash: "timeline_v1",
            legacy_hash: "legacy_v1",
        }
        hash_contract = accepted_contracts.get(observation.payload_hash)
        if hash_contract is None:
            raise SnapshotProtocolError("assembled snapshot payload_hash does not match")
        snapshot_metrics = _snapshot_metrics(messages)
        if _is_pdd_api_chat_list_snapshot(observation, messages):
            appended_messages = (
                _apply_platform_id_ordered_snapshot(
                    db,
                    user,
                    conversation,
                    observation,
                    messages,
                )
                if write_messages
                else []
            )
            observation.alignment_status = "platform_id_ordered"
            observation.alignment_method = "platform_message_id"
            observation.overlap_size = 0
            observation.projected_append_count = len(appended_messages)
            observation.appended_count = len(appended_messages)
            observation.diagnostics_json = {
                **(observation.diagnostics_json or {}),
                "payload_hash_contract": hash_contract,
                "snapshot_metrics": snapshot_metrics,
                "message_order_source": "platform_message_id",
            }
            observation.processed_at = utcnow()
            observation.error_message = None
            _resolve_message_sync_issue(conversation, observation.processed_at)
            db.add(conversation)
            db.add(observation)
            return SnapshotProcessResult(observation, appended_messages, conversation)
        history = _history_tail(db, conversation.id)
        result = align_message_sequences(history, messages)
        observation.alignment_status = result.status
        observation.alignment_method = result.method
        observation.overlap_size = result.overlap_size
        observation.projected_append_count = result.projected_append_count
        appended_messages = (
            _apply_formal_snapshot(
                db,
                user,
                conversation,
                observation,
                messages,
                history,
                result,
            )
            if write_messages
            else []
        )
        if write_messages and result.status in {"bootstrap", "aligned", "duplicate"}:
            conversation.metadata_json = {
                **(conversation.metadata_json or {}),
                "pdd_message_write_mode": "snapshot",
                "pdd_message_snapshot_activated_at": utcnow().isoformat(),
            }
            db.add(conversation)
        observation.appended_count = len(appended_messages)
        observation.diagnostics_json = {
            **result.diagnostics,
            "payload_hash_contract": hash_contract,
            "append_from": result.append_from,
            "first_new_dom_sequence": (
                appended_messages[0].first_dom_sequence if appended_messages else None
            ),
            "last_assigned_conversation_sequence": (
                appended_messages[-1].conversation_sequence if appended_messages else None
            ),
            "snapshot_metrics": snapshot_metrics,
        }
        observation.processed_at = utcnow()
        observation.error_message = None
        if result.status == "unaligned":
            _record_message_sync_issue(conversation, observation)
            db.add(conversation)
        elif result.status in {"bootstrap", "aligned", "duplicate"}:
            _resolve_message_sync_issue(conversation, observation.processed_at)
            db.add(conversation)
    except SnapshotProtocolError as exc:
        appended_messages = []
        observation.alignment_status = "failed"
        observation.processed_at = utcnow()
        observation.error_message = str(exc)
    db.add(observation)
    return SnapshotProcessResult(observation, appended_messages, conversation)
