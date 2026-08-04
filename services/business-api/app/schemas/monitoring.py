from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class ModelMetrics(BaseModel):
    model: str
    period: Literal["today"] = "today"
    uptime: str | None = None
    request_count: int = 0
    success_rate: float = 0
    average_response_ms: int | None = None


class MonitoringOverview(BaseModel):
    current_model: str
    available_models: list[str] = Field(default_factory=list)
    metrics: ModelMetrics
    updated_at: datetime


class MonitoringLog(BaseModel):
    id: str
    timestamp: datetime
    type: Literal["reply", "token"]
    status: str
    message: str
    details: str = ""
    model: str = ""
    stage: str = ""
    input_tokens: int = 0
    output_tokens: int = 0
    duration_ms: int | None = None


class MonitoringLogList(BaseModel):
    items: list[MonitoringLog] = Field(default_factory=list)


class MonitoringEvent(BaseModel):
    id: str
    timestamp: datetime
    type: str
    level: Literal["info", "success", "warning", "error"] = "info"
    message: str


class MonitoringEventList(BaseModel):
    items: list[MonitoringEvent] = Field(default_factory=list)
