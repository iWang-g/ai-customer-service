from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


RobotStatus = Literal["online", "offline"]


class RobotPlatformScope(BaseModel):
    platform_code: str = Field(min_length=1, max_length=64)
    platform_account_id: str | None = None
    all_accounts: bool = False


class RobotCreate(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    enabled: bool = False
    config_json: dict[str, Any] = Field(default_factory=dict)
    qa_knowledge_base_ids: list[str] = Field(default_factory=list, max_length=128)
    product_knowledge_base_ids: list[str] = Field(default_factory=list, max_length=128)
    tone_knowledge_base_id: str | None = None
    platform_scopes: list[RobotPlatformScope] = Field(default_factory=list, max_length=128)


class RobotUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=128)
    enabled: bool | None = None
    status: RobotStatus | None = None
    config_json: dict[str, Any] | None = None
    qa_knowledge_base_ids: list[str] | None = Field(default=None, max_length=128)
    product_knowledge_base_ids: list[str] | None = Field(default=None, max_length=128)
    tone_knowledge_base_id: str | None = None
    platform_scopes: list[RobotPlatformScope] | None = Field(default=None, max_length=128)


class RobotRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    user_id: str
    name: str
    status: str
    enabled: bool
    config_json: dict[str, Any] = Field(default_factory=dict)
    qa_knowledge_base_ids: list[str] = Field(default_factory=list)
    product_knowledge_base_ids: list[str] = Field(default_factory=list)
    tone_knowledge_base_id: str | None = None
    platform_scopes: list[RobotPlatformScope] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime
