from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict


class UserSettingsUpdate(BaseModel):
    auto_reply_enabled: bool = False


class UserSettingsRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    auto_reply_enabled: bool
    updated_at: datetime | None = None
