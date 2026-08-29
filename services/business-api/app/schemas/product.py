from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


ProductCollectionStatus = Literal["not_collected", "success", "empty", "unavailable"]


class CustomerProductRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    goods_id: str = ""
    product_id: str
    platform_product_id: str
    title: str | None = None
    image_url: str | None = None
    link_url: str | None = None
    price: float | None = None
    price_label: str | None = None
    quantity: int | None = None
    sold_quantity: int | None = None
    sold_quantity_30d: int | None = None
    source: str | None = None
    raw_payload: dict[str, Any] = Field(default_factory=dict)
    last_observed_at: datetime


class CustomerProductsResponse(BaseModel):
    conversation_id: str
    status: Literal["collected", "failed"] = "collected"
    method: Literal["api_recommend_goods"] | None = "api_recommend_goods"
    conversation_key: str | None = None
    customer_name: str | None = None
    collection_status: ProductCollectionStatus = "not_collected"
    collection_error: str | None = None
    observed_at: datetime | None = None
    customer_key: str = ""
    total_count: int = 0
    has_more: bool = False
    products: list[CustomerProductRead] = Field(default_factory=list)
    error: str | None = None
