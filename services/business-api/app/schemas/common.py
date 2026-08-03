from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class ApiMessage(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    message: str


class PageMeta(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    total: int
    limit: int
    offset: int

