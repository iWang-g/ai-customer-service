from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class ReplyRequest(BaseModel):
    knowledge_access_token: str = Field(default="", max_length=8192)
    message: str = Field(min_length=1, max_length=10000)
    conversation: list[dict[str, Any]] = Field(default_factory=list, max_length=100)
    platform: str = Field(default="", max_length=64)
    shop_name: str = Field(default="", max_length=128)
    customer_name: str = Field(default="", max_length=128)
    customer_orders: dict[str, Any] = Field(default_factory=dict)
    platform_context: list[dict[str, Any]] = Field(default_factory=list, max_length=20)
    product_details: list[dict[str, Any]] = Field(default_factory=list, max_length=3)
    product_card_only: bool = False
    product_link_candidates: list[dict[str, str]] = Field(default_factory=list, max_length=12)
    qa_base_ids: list[str] = Field(default_factory=list, max_length=32)
    product_base_ids: list[str] = Field(default_factory=list, max_length=32)
    tone_base_id: str = Field(default="", max_length=128)
    email_templates: list[dict[str, Any]] = Field(default_factory=list, max_length=50)
    allow_auto_send: bool = False
    provider_config: dict[str, Any] | None = None
    reply_config: dict[str, Any] = Field(default_factory=dict)
    shop_product_summary: dict[str, str] = Field(default_factory=dict)


class ShopSummaryRequest(BaseModel):
    shop_name: str = Field(default="", max_length=128)
    products: list[dict[str, Any]] = Field(default_factory=list, max_length=5000)
    provider_config: dict[str, Any] | None = None


class ShopSummaryResponse(BaseModel):
    shop_intro: str = Field(min_length=1, max_length=60)
    on_sale_products: str = Field(min_length=1, max_length=160)
    provider: str


IntentName = Literal[
    "qa_match",
    "direct_reply",
    "normal_question",
    "email_link_request",
    "human_handoff",
    "unknown",
]

ReplyRoute = Literal["direct", "retrieve_product", "email_workflow", "human_handoff"]


class IntentDecision(BaseModel):
    attach_product_links: bool = False
    selected_product_ids: list[str] = Field(default_factory=list, max_length=3)
    needs_clarification: bool = Field(default=False, strict=True)
    custom_order_intent: Literal['none', 'consultation', 'proceed', 'unclear'] = 'none'
    image_request_intent: Literal['none', 'request', 'declined', 'unclear'] = 'none'
    image_delivery_intent: Literal['none', 'email_link_request', 'photo_request', 'unclear'] = 'none'
    intent: IntentName
    reply_route: ReplyRoute = "retrieve_product"
    direct_reply_text: str = ""
    confidence: float = Field(ge=0, le=1)
    need_customer_reply: bool = True
    need_doc_search: bool = False
    need_email: bool = False
    workflow: str = "answer_question"
    next_action: str = "generate_reply"
    wants_product_recommendation: bool = False
    product_recommendation_query: str = Field(default="", max_length=500)
    missing_slots: list[str] = Field(default_factory=list)
    template_id: str = ""
    template_key: str = ""
    risk_flags: list[str] = Field(default_factory=list)
    reason: str = ""


class ActionPlan(BaseModel):
    workflow: str
    next_action: str
    generate_reply: bool = False
    need_doc_search: bool = False
    email_service_required: bool = False
    required_actions: list[str] = Field(default_factory=list)
    blocked_actions: list[str] = Field(default_factory=list)


class ReplyResponse(BaseModel):
    decision: Literal["auto_send", "suggest", "needs_human"]
    text: str
    media: list[dict[str, Any]] = Field(default_factory=list)
    intent: IntentDecision
    action_plan: ActionPlan
    confidence: float = Field(ge=0, le=1)
    risk_flags: list[str] = Field(default_factory=list)
    qa_match: dict[str, Any] | None = None
    retrieval: list[dict[str, Any]] = Field(default_factory=list)
    retrieval_status: Literal[
        "shop_product_detail",
        "not_needed",
        "hit",
        "empty",
        "unavailable",
        "no_product_base",
    ] = "not_needed"
    model_calls: dict[str, str] = Field(default_factory=dict)
    model_call_details: list[dict[str, Any]] = Field(default_factory=list)
    provider: str
    trace_id: str
