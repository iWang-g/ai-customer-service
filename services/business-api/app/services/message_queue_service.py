from __future__ import annotations

from datetime import datetime
from time import sleep

from sqlalchemy import update
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from app.core.security import utcnow
from app.models import Conversation, Message


def reserve_conversation_sequences(
    db: Session,
    conversation_id: str,
    count: int = 1,
) -> list[int]:
    """Atomically reserve permanent sequence numbers at a conversation tail."""
    if count < 1:
        raise ValueError("count must be at least 1")

    statement = (
        update(Conversation)
        .where(Conversation.id == conversation_id)
        .values(last_message_sequence=Conversation.last_message_sequence + count)
        .returning(Conversation.last_message_sequence)
    )
    for attempt in range(20):
        try:
            end_sequence = db.scalar(statement)
            break
        except OperationalError as exc:
            if "locked" not in str(exc).lower() or attempt == 19:
                raise
            sleep(0.01 * (attempt + 1))
    else:  # pragma: no cover - loop either succeeds or raises
        end_sequence = None
    if end_sequence is None:
        raise ValueError(f"conversation not found: {conversation_id}")
    start_sequence = end_sequence - count + 1
    return list(range(start_sequence, end_sequence + 1))


def append_message(
    db: Session,
    message: Message,
    *,
    collected_at: datetime | None = None,
    collection_kind: str | None = None,
) -> Message:
    """Prepare a new message for insertion with immutable queue metadata."""
    if message.conversation_sequence is None:
        message.conversation_sequence = reserve_conversation_sequences(
            db, message.conversation_id
        )[0]
    if message.collected_at is None:
        message.collected_at = collected_at or utcnow()
    if collection_kind:
        message.collection_kind = collection_kind
    db.add(message)
    return message


def append_messages(
    db: Session,
    messages: list[Message],
    *,
    collected_at: datetime | None = None,
    collection_kind: str | None = None,
) -> list[Message]:
    """Append a same-conversation batch with one contiguous reservation."""
    if not messages:
        return messages
    conversation_id = messages[0].conversation_id
    if any(message.conversation_id != conversation_id for message in messages):
        raise ValueError("all messages must belong to the same conversation")
    if any(message.conversation_sequence is not None for message in messages):
        raise ValueError("batch messages must not have preassigned sequences")

    sequences = reserve_conversation_sequences(db, conversation_id, len(messages))
    observation_time = collected_at or utcnow()
    for message, sequence in zip(messages, sequences, strict=True):
        message.conversation_sequence = sequence
        if message.collected_at is None:
            message.collected_at = observation_time
        if collection_kind:
            message.collection_kind = collection_kind
    db.add_all(messages)
    return messages
