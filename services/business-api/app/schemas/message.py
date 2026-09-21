from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.common import PageMeta


class MessageRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    conversation_id: str
    user_id: str
    platform_code: str
    platform_message_id: str | None = None
    sender_role: str
    sender_name: str | None = None
    content: str
    message_status: str
    source: str
    raw_payload: dict[str, Any] = Field(default_factory=dict)
    conversation_sequence: int
    collected_at: datetime
    first_observation_id: str | None = None
    first_dom_sequence: int | None = None
    collection_kind: str
    automation_eligible: bool
    platform_sent_at: datetime | None = None
    observed_at: datetime | None = None
    snapshot_id: str | None = None
    snapshot_sequence: int | None = None
    time_group_index: int | None = None
    has_explicit_time: bool | None = None
    time_label: str | None = None
    sent_at: datetime


class MessageListResponse(BaseModel):
    items: list[MessageRead]
    meta: PageMeta


class PlatformMessageExistsResponse(BaseModel):
    exists: bool
    conversation_id: str | None = None
    message_id: str | None = None


class SendMessageRequest(BaseModel):
    conversation_id: str = Field(min_length=1)
    content: str = Field(min_length=1)
    platform_code: str | None = None
    sender_name: str | None = None
    quote_message_id: str | None = Field(default=None, max_length=128)
    client_message_id: str | None = Field(default=None, min_length=1, max_length=128)


class SendMessageResponse(BaseModel):
    message: MessageRead
    task_id: str
    task_status: Literal[
        "waiting_timeout", "queued", "dispatched", "acknowledged", "completed", "failed", "confirmation_pending"
    ]
    follow_up_message: MessageRead | None = None
    follow_up_messages: list[MessageRead] = Field(default_factory=list)


class RecordSentMessageRequest(BaseModel):
    conversation_id: str = Field(min_length=1)
    content: str = Field(min_length=1)
    platform_message_id: str | None = Field(default=None, max_length=128)
    client_message_id: str | None = Field(default=None, max_length=128)
    platform_code: str | None = None
    sender_name: str | None = None
    media_type: Literal["text", "image"] = "text"
    platform_sent_at: datetime | None = None
    raw_payload: dict[str, Any] | None = None


class RecordSentMessageResponse(BaseModel):
    message: MessageRead
