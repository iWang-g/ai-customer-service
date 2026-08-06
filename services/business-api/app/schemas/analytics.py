from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel


class DashboardMetrics(BaseModel):
    message_count: int
    independent_reception_rate: float
    average_response_seconds: float | None
    transfer_to_human_rate: float


class TrafficPoint(BaseModel):
    label: str
    count: int


class ConsultationCategory(BaseModel):
    type: Literal["qa_category", "document_retrieval"]
    category_id: str | None = None
    name: str
    count: int
    percentage: float


class DashboardAnalytics(BaseModel):
    start_date: date
    end_date: date
    metrics: DashboardMetrics
    traffic: list[TrafficPoint]
    categories: list[ConsultationCategory]
    updated_at: datetime
