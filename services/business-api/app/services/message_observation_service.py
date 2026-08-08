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
    if request.platform_code != "pinduoduo":
        raise SnapshotProtocolError("message_snapshot currently supports pinduoduo only")
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
            key: direction_counts[key] for key in ("customer", "agent")
        },
        "type_counts": {
            key: type_counts[key] for key in ("text", "image", "product", "order")
        },
        "sequence_hash": _sequence_evidence_hash(messages),
        "platform_id_missing_count": len(messages) - len(platform_ids),
        "platform_id_duplicate_count": len(platform_ids) - len(set(platform_ids)),
    }


def _as_utc_naive(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value
    return value.astimezone(timezone.utc).replace(tzinfo=None)


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


def _history_tail(db: Session, conversation_id: str, limit: int = 200) -> list[Message]:
    newest = list(
        db.scalars(
            select(Message)
            .where(Message.conversation_id == conversation_id)
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
        sent_at=observation.collected_at,
        observed_at=observation.collected_at,
        snapshot_id=(observation.raw_payload or {}).get("source_snapshot_id"),
        collected_at=observation.collected_at,
        first_observation_id=observation.observation_id,
        first_dom_sequence=item.get("dom_sequence"),
        collection_kind=collection_kind,
        automation_eligible=collection_kind == "incremental" and sender_role == "customer",
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
        conversation.latest_message_text = tail.content
        conversation.latest_message_at = observation.collected_at
        conversation.unread_count = 1 if observation.unread else 0
        conversation.awaiting_reply = tail.sender_role == "customer"
        conversation.status = "active"
        db.add(conversation)
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
        actual_hash = snapshot_payload_hash(messages)
        if actual_hash != observation.payload_hash:
            raise SnapshotProtocolError("assembled snapshot payload_hash does not match")
        history = _history_tail(db, conversation.id)
        result = align_message_sequences(history, messages)
        snapshot_metrics = _snapshot_metrics(messages)
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
    except SnapshotProtocolError as exc:
        appended_messages = []
        observation.alignment_status = "failed"
        observation.processed_at = utcnow()
        observation.error_message = str(exc)
    db.add(observation)
    return SnapshotProcessResult(observation, appended_messages, conversation)
