from __future__ import annotations

from sqlalchemy import event, update
from sqlalchemy.engine import Connection

from app.models.base import utcnow
from app.models.entities import Conversation, Message


@event.listens_for(Message, "before_insert")
def ensure_message_queue_metadata(
    _mapper: object,
    connection: Connection,
    message: Message,
) -> None:
    """Cover direct ORM inserts that do not use the message service layer."""
    if message.conversation_sequence is None:
        message.conversation_sequence = connection.scalar(
            update(Conversation)
            .where(Conversation.id == message.conversation_id)
            .values(last_message_sequence=Conversation.last_message_sequence + 1)
            .returning(Conversation.last_message_sequence)
        )
    if message.collected_at is None:
        message.collected_at = message.observed_at or message.sent_at or message.created_at or utcnow()
