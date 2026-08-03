from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class AiConfigUpdate(BaseModel):
    provider: Literal["deepseek"] = "deepseek"
    base_url: str = Field(default="https://api.deepseek.com", min_length=1, max_length=512)
    model: Literal["deepseek-chat", "deepseek-reasoner"] = "deepseek-chat"
    api_key: str = Field(default="", max_length=512)
    enabled: bool = False
    temperature: float = Field(default=0.2, ge=0, le=2)


class AiConfigRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    provider: str
    base_url: str
    model: str
    api_key_masked: str
    enabled: bool
    temperature: float
    updated_at: datetime | None = None


class AiConfigTestRequest(AiConfigUpdate):
    pass


class AiConfigTestResponse(BaseModel):
    ok: bool
    provider: str
    model: str
    message: str
