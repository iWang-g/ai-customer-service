from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


EMAIL_PATTERN = r"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$"


EmailProvider = Literal["qq", "gmail", "custom"]
EmailSecurity = Literal["ssl", "starttls", "none"]


class EmailConfigUpdate(BaseModel):
    enabled: bool = False
    provider: EmailProvider = "qq"
    sender_email: str = Field(min_length=3, max_length=320, pattern=EMAIL_PATTERN)
    smtp_host: str = Field(min_length=1, max_length=255)
    smtp_port: int = Field(ge=1, le=65535)
    security: EmailSecurity = "ssl"
    auth_code: str = Field(default="", max_length=1024)


class EmailConfigRead(BaseModel):
    enabled: bool
    provider: EmailProvider
    sender_email: str
    sender_email_masked: str
    smtp_host: str
    smtp_port: int
    security: EmailSecurity
    auth_code_saved: bool
    updated_at: datetime | None = None


class EmailTestRequest(BaseModel):
    to_email: str = Field(min_length=3, max_length=320, pattern=EMAIL_PATTERN)
    template_id: str | None = None


class EmailTestResponse(BaseModel):
    ok: bool
    message: str
    message_id: str
    elapsed_ms: int


class EmailTemplateCreate(BaseModel):
    template_key: str = Field(min_length=3, max_length=80, pattern=r"^[A-Za-z0-9_.:-]+$")
    name: str = Field(min_length=1, max_length=128)
    scene: str = Field(default="store_view_link", min_length=1, max_length=64)
    aliases: list[str] = Field(default_factory=list, max_length=32)
    subject: str = Field(min_length=1, max_length=256)
    body: str = Field(min_length=1, max_length=50000)
    enabled: bool = True

    @field_validator("aliases")
    @classmethod
    def normalize_aliases(cls, values: list[str]) -> list[str]:
        return list(dict.fromkeys(value.strip() for value in values if value.strip()))


class EmailTemplateUpdate(BaseModel):
    template_key: str | None = Field(default=None, min_length=3, max_length=80, pattern=r"^[A-Za-z0-9_.:-]+$")
    name: str | None = Field(default=None, min_length=1, max_length=128)
    scene: str | None = Field(default=None, min_length=1, max_length=64)
    aliases: list[str] | None = Field(default=None, max_length=32)
    subject: str | None = Field(default=None, min_length=1, max_length=256)
    body: str | None = Field(default=None, min_length=1, max_length=50000)
    enabled: bool | None = None


class EmailTemplateRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    template_key: str
    name: str
    scene: str
    aliases: list[str]
    subject: str
    body: str
    enabled: bool
    created_at: datetime
    updated_at: datetime
