from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator
from app.schemas.platform import PlatformCode

class RpaNodeRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    user_id: str
    node_key: str
    hostname: str
    machine_name: str | None = None
    supported_platforms: list[str] = Field(default_factory=list)
    app_version: str | None = None
    status: str
    last_heartbeat_at: datetime | None = None
    last_seen_at: datetime | None = None
    node_token_version: int


class NodeRegisterRequest(BaseModel):
    node_key: str = Field(min_length=1)
    hostname: str = Field(min_length=1)
    machine_name: str | None = None
    supported_platforms: list[str] = Field(default_factory=list)
    app_version: str | None = None


class NodeHeartbeatRequest(BaseModel):
    status: Literal["online", "idle", "busy"] = "online"
    active_platforms: list[str] = Field(default_factory=list)


class NodeRegisterResponse(BaseModel):
    node: RpaNodeRead
    node_token: str
    heartbeat_interval_seconds: int


class PlatformAccountSyncItem(BaseModel):
    platform_code: PlatformCode = "pinduoduo"
    local_account_id: str = Field(min_length=1, max_length=64)
    account_name: str = Field(min_length=1, max_length=128)
    account_alias: str | None = Field(default=None, max_length=128)
    external_account_id: str | None = Field(default=None, max_length=128)
    login_status: Literal[
        "unknown", "login_required", "online", "offline", "risk_control", "error", "paused"
    ] = "unknown"
    archived: bool = False
    metadata_json: dict[str, Any] = Field(default_factory=dict)


class PlatformAccountSyncRequest(BaseModel):
    platform_code: PlatformCode = "pinduoduo"
    accounts: list[PlatformAccountSyncItem] = Field(default_factory=list, max_length=100)


class RpaEventCreate(BaseModel):
    event_id: str = Field(min_length=1)
    event_type: str = Field(min_length=1)
    platform_code: PlatformCode
    platform_account_id: str | None = None
    platform_message_id: str | None = None
    conversation_external_id: str | None = None
    dedup_key: str | None = None
    payload_json: dict[str, Any] = Field(default_factory=dict)
    received_at: datetime | None = None


class RpaEventBatchCreate(BaseModel):
    events: list[RpaEventCreate] = Field(default_factory=list)


class SnapshotMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    dom_sequence: int = Field(ge=0, le=9999)
    sender_role: Literal["customer", "agent"]
    message_type: Literal["text", "image", "emoji", "file", "video", "product", "order"]
    content: str = Field(default="", max_length=100_000)
    image_url: str | None = Field(default=None, max_length=8192)
    image_sha256: str | None = Field(default=None, pattern=r"^[0-9a-fA-F]{64}$")
    media_resource_id: str | None = Field(default=None, max_length=512)
    platform_message_id: str | None = Field(default=None, max_length=128)


class MessageSnapshotPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    observation_id: str = Field(min_length=1, max_length=128)
    collected_at: datetime
    unread: bool = False
    payload_hash: str = Field(pattern=r"^[0-9a-fA-F]{64}$")
    message_count: int | None = Field(default=None, ge=0, le=200)
    batch_index: int = Field(default=0, ge=0, le=99)
    batch_count: int = Field(default=1, ge=1, le=100)
    message_offset: int = Field(default=0, ge=0, le=200)
    messages: list[SnapshotMessage] = Field(default_factory=list, max_length=200)
    source_snapshot_id: str | None = Field(default=None, max_length=128)
    @model_validator(mode="after")
    def validate_batch_metadata(self) -> "MessageSnapshotPayload":
        if self.batch_index >= self.batch_count:
            raise ValueError("batch_index must be smaller than batch_count")
        if self.batch_count > 1 and self.message_count is None:
            raise ValueError("message_count is required for split snapshots")
        total = len(self.messages) if self.message_count is None else self.message_count
        if self.message_offset + len(self.messages) > total:
            raise ValueError("batch messages exceed message_count")
        expected = list(range(self.message_offset, self.message_offset + len(self.messages)))
        actual = [message.dom_sequence for message in self.messages]
        if actual != expected:
            raise ValueError("dom_sequence must be continuous from message_offset")
        return self


class RpaEventRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    user_id: str
    node_id: str | None = None
    platform_account_id: str | None = None
    event_id: str
    dedup_key: str | None = None
    event_type: str
    platform_code: str
    platform_message_id: str | None = None
    conversation_external_id: str | None = None
    payload_json: dict[str, Any] = Field(default_factory=dict)
    received_at: datetime
    processed_at: datetime | None = None
    status: str
    error_message: str | None = None


class MessageObservationRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    observation_id: str
    platform_account_id: str
    conversation_id: str
    conversation_external_id: str
    collected_at: datetime
    unread: bool
    payload_hash: str
    message_count: int
    batch_count: int
    received_batch_count: int
    alignment_status: str
    alignment_method: str | None = None
    overlap_size: int
    projected_append_count: int
    appended_count: int
    diagnostics_json: dict[str, Any] = Field(default_factory=dict)
    processed_at: datetime | None = None
    error_message: str | None = None


class RpaTaskRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    user_id: str
    node_id: str | None = None
    platform_account_id: str | None = None
    conversation_id: str | None = None
    message_id: str | None = None
    task_type: str
    idempotency_key: str | None = None
    platform_code: str
    payload_json: dict[str, Any] = Field(default_factory=dict)
    status: str
    priority: int
    requested_at: datetime
    acked_at: datetime | None = None
    completed_at: datetime | None = None
    result_json: dict[str, Any] = Field(default_factory=dict)
    error_message: str | None = None


class TaskAckResponse(BaseModel):
    task: RpaTaskRead


class TaskCompleteRequest(BaseModel):
    status: Literal["completed", "failed", "confirmation_pending"] = "completed"
    result_json: dict[str, Any] = Field(default_factory=dict)
    error_message: str | None = None
