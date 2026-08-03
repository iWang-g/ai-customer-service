from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

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
    accounts: list[PlatformAccountSyncItem] = Field(default_factory=list, max_length=100)


class RpaEventCreate(BaseModel):
    event_id: str = Field(min_length=1)
    event_type: str = Field(min_length=1)
    platform_code: str = Field(min_length=1)
    platform_account_id: str | None = None
    platform_message_id: str | None = None
    conversation_external_id: str | None = None
    dedup_key: str | None = None
    payload_json: dict[str, Any] = Field(default_factory=dict)
    received_at: datetime | None = None


class RpaEventBatchCreate(BaseModel):
    events: list[RpaEventCreate] = Field(default_factory=list)


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
    status: Literal["completed", "failed"] = "completed"
    result_json: dict[str, Any] = Field(default_factory=dict)
    error_message: str | None = None
