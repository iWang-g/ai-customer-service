from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
from collections import Counter
from typing import Any

from pydantic import ValidationError
from sqlalchemy import and_, select
from sqlalchemy.orm import Session

from app.core.security import utcnow
from app.models import Conversation, Message, MessageObservation, RpaNode, User
from app.schemas.rpa import MessageSnapshotPayload, RpaEventCreate
from app.services.message_sequence_service import (
    align_message_sequences,
    snapshot_payload_hash,
)


class SnapshotProtocolError(ValueError):
    pass


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


def process_message_snapshot_shadow(
    db: Session,
    user: User,
    node: RpaNode,
    request: RpaEventCreate,
) -> MessageObservation:
    """Store and align a snapshot without mutating the formal message queue."""
    payload = _snapshot_payload(request)
    conversation = _conversation_for_snapshot(db, user, request)
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
        return existing

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
            "legacy_projection": (
                payload.legacy_projection.model_dump(mode="json")
                if payload.legacy_projection
                else None
            ),
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
        return observation

    raw_payload = dict(observation.raw_payload or {})
    incoming_projection = (
        payload.legacy_projection.model_dump(mode="json")
        if payload.legacy_projection
        else None
    )
    if (
        raw_payload.get("source_snapshot_id") != payload.source_snapshot_id
        or raw_payload.get("legacy_projection") != incoming_projection
    ):
        observation.alignment_status = "failed"
        observation.error_message = "snapshot diagnostic metadata changed between batches"
        observation.processed_at = utcnow()
        db.add(observation)
        return observation
    batches = dict(raw_payload.get("batches") or {})
    batch_key = str(payload.batch_index)
    serialized_batch = _serialized_batch(payload)
    if batch_key in batches and batches[batch_key] != serialized_batch:
        observation.alignment_status = "failed"
        observation.error_message = "batch_index was reused with different content"
        observation.processed_at = utcnow()
        db.add(observation)
        return observation
    batches[batch_key] = serialized_batch
    raw_payload["batches"] = batches
    observation.raw_payload = raw_payload
    observation.received_batch_count = len(batches)
    db.add(observation)
    db.flush()

    try:
        messages = _assemble_batches(observation)
        if messages is None:
            return observation
        actual_hash = snapshot_payload_hash(messages)
        if actual_hash != observation.payload_hash:
            raise SnapshotProtocolError("assembled snapshot payload_hash does not match")
        result = align_message_sequences(_history_tail(db, conversation.id), messages)
        snapshot_metrics = _snapshot_metrics(messages)
        legacy_projection = raw_payload.get("legacy_projection")
        observation.alignment_status = result.status
        observation.alignment_method = result.method
        observation.overlap_size = result.overlap_size
        observation.projected_append_count = result.projected_append_count
        observation.appended_count = 0
        observation.diagnostics_json = {
            **result.diagnostics,
            "append_from": result.append_from,
            "shadow_only": True,
            "snapshot_metrics": snapshot_metrics,
            "legacy_projection": legacy_projection,
            "legacy_snapshot_comparison": (
                {
                    "message_count_matches": (
                        legacy_projection.get("message_count")
                        == snapshot_metrics["message_count"]
                    ),
                    "direction_counts_match": (
                        legacy_projection.get("direction_counts")
                        == snapshot_metrics["direction_counts"]
                    ),
                    "type_counts_match": (
                        legacy_projection.get("type_counts")
                        == snapshot_metrics["type_counts"]
                    ),
                    "page_sequence_matches": (
                        legacy_projection.get("sequence_hash")
                        == snapshot_metrics["sequence_hash"]
                    ),
                }
                if isinstance(legacy_projection, dict)
                else None
            ),
        }
        observation.processed_at = utcnow()
        observation.error_message = None
    except SnapshotProtocolError as exc:
        observation.alignment_status = "failed"
        observation.processed_at = utcnow()
        observation.error_message = str(exc)
    db.add(observation)
    return observation
