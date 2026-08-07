from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.common import PageMeta


class ConversationRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    user_id: str
    platform_account_id: str | None = None
    platform_code: str
    platform_name: str | None = None
    shop_name: str | None = None
    external_conversation_id: str | None = None
    customer_name: str | None = None
    title: str | None = None
    latest_message_text: str | None = None
    latest_message_at: datetime | None = None
    unread_count: int
    status: str
    awaiting_reply: bool = False
    human_required: bool = False
    human_required_reason: str | None = None
    human_required_word: str | None = None
    human_required_at: datetime | None = None
    metadata_json: dict[str, Any] = Field(default_factory=dict)


class ConversationListResponse(BaseModel):
    items: list[ConversationRead]
    meta: PageMeta


class ConversationDetailResponse(BaseModel):
    conversation: ConversationRead


class ConversationTestResetResponse(BaseModel):
    conversation: ConversationRead
    deleted_counts: dict[str, int] = Field(default_factory=dict)
