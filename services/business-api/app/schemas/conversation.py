from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.common import PageMeta
from app.schemas.message import MessageRead


class ConversationSyncIssueRead(BaseModel):
    observation_id: str
    first_detected_at: datetime
    latest_detected_at: datetime
    unread: bool = False
    message_count: int = 0
    consecutive_failure_count: int = 1
    requires_attention: bool = False
    dismissed_at: datetime | None = None


class ConversationRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    user_id: str
    platform_account_id: str | None = None
    platform_code: str
    platform_name: str | None = None
    shop_name: str | None = None
    shop_logo_url: str | None = None
    shop_service_username: str | None = None
    shop_is_mall_owner: bool = False
    latest_customer_message_at: datetime | None = None
    external_conversation_id: str | None = None
    customer_name: str | None = None
    avatar_url: str | None = None
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
    messages_cleared_sequence: int = 0
    deleted_at: datetime | None = None
    metadata_json: dict[str, Any] = Field(default_factory=dict)
    message_sync_issue: ConversationSyncIssueRead | None = None


class ConversationListResponse(BaseModel):
    items: list[ConversationRead]
    meta: PageMeta


class ConversationDetailResponse(BaseModel):
    conversation: ConversationRead


class ConversationTestResetResponse(BaseModel):
    conversation: ConversationRead
    deleted_counts: dict[str, int] = Field(default_factory=dict)


class ConversationHistoryClearResponse(BaseModel):
    conversation: ConversationRead


class ConversationSyncIssueMessageRead(BaseModel):
    dom_sequence: int
    sender_role: str
    message_type: str
    content: str
    display_mode: str = "bubble"
    automation_mode: str = "trigger"
    time_label: str | None = None
    structured_payload: dict[str, Any] | None = None


class ConversationSyncIssueDetailResponse(BaseModel):
    conversation_id: str
    issue: ConversationSyncIssueRead
    messages: list[ConversationSyncIssueMessageRead]


class ConversationSyncIssueRebuildResponse(BaseModel):
    conversation: ConversationRead
    messages: list[MessageRead] = Field(default_factory=list)
    deleted_counts: dict[str, int] = Field(default_factory=dict)
