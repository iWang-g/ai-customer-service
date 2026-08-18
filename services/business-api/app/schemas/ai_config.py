from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict


class AiModelRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    provider: str
    model_id: str
    display_name: str
    available: bool
    fetched_at: datetime


class AiModelList(BaseModel):
    items: list[AiModelRead]
