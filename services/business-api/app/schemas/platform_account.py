from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.common import PageMeta
from app.schemas.platform import PlatformCode


LoginStatus = Literal[
    "unknown", "login_required", "online", "offline", "risk_control", "error", "paused"
]


class PlatformAccountCreate(BaseModel):
    platform_code: PlatformCode = "pinduoduo"
    local_account_id: str = Field(min_length=1, max_length=64)
    account_name: str = Field(min_length=1, max_length=128)
    account_alias: str | None = Field(default=None, max_length=128)
    external_account_id: str | None = Field(default=None, max_length=128)
    login_status: LoginStatus = "unknown"
    last_rpa_node_id: str | None = None
    metadata_json: dict[str, Any] = Field(default_factory=dict)


class PlatformAccountUpdate(BaseModel):
    account_name: str | None = Field(default=None, min_length=1, max_length=128)
    account_alias: str | None = Field(default=None, max_length=128)
    external_account_id: str | None = Field(default=None, max_length=128)
    login_status: LoginStatus | None = None
    last_rpa_node_id: str | None = None
    is_active: bool | None = None
    metadata_json: dict[str, Any] | None = None


class PlatformAccountRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    user_id: str
    platform_code: str
    platform_name: str
    local_account_id: str | None = None
    external_account_id: str | None = None
    account_name: str
    account_alias: str | None = None
    name_source: str
    is_active: bool
    login_status: str
    last_seen_at: datetime | None = None
    last_rpa_node_id: str | None = None
    metadata_json: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime


class PlatformAccountListResponse(BaseModel):
    items: list[PlatformAccountRead]
    meta: PageMeta
