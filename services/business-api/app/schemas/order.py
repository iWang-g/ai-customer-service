from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


OrderCollectionStatus = Literal["not_collected", "success", "empty", "unavailable"]


class CustomerOrderRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    platform_order_id: str
    goods_id: str = ""
    status: str
    raw_status: str
    products_json: list[dict[str, Any]] = Field(default_factory=list)
    order_amount: float | None = None
    discount_amount: float | None = None
    paid_amount: float | None = None
    ordered_at: datetime | None = None
    paid_at: datetime | None = None
    signed_at: datetime | None = None
    after_sale_json: dict[str, Any] = Field(default_factory=dict)
    last_observed_at: datetime


class OutreachStatusRead(BaseModel):
    strategy_type: str
    goods_id: str = ""
    status: str
    due_at: datetime
    cancel_reason: str | None = None
    completed_at: datetime | None = None


class CustomerOrdersResponse(BaseModel):
    conversation_id: str
    collection_status: OrderCollectionStatus = "not_collected"
    collection_error: str | None = None
    observed_at: datetime | None = None
    customer_key: str = ""
    total_count: int = 0
    has_more: bool = False
    orders: list[CustomerOrderRead] = Field(default_factory=list)
    outreach: list[OutreachStatusRead] = Field(default_factory=list)
