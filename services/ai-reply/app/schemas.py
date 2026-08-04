from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class ReplyRequest(BaseModel):
    message: str = Field(min_length=1, max_length=10000)
    conversation: list[dict[str, Any]] = Field(default_factory=list, max_length=100)
    platform: str = Field(default="", max_length=64)
    shop_name: str = Field(default="", max_length=128)
    customer_name: str = Field(default="", max_length=128)
    qa_base_ids: list[str] = Field(default_factory=list, max_length=32)
    product_base_ids: list[str] = Field(default_factory=list, max_length=32)
    tone_base_id: str = Field(default="", max_length=128)
    email_templates: list[dict[str, Any]] = Field(default_factory=list, max_length=50)
    allow_auto_send: bool = False
    provider_config: dict[str, Any] | None = None
    reply_config: dict[str, Any] = Field(default_factory=dict)


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
    intent: IntentName
    reply_route: ReplyRoute = "retrieve_product"
    direct_reply_text: str = ""
    confidence: float = Field(ge=0, le=1)
    need_customer_reply: bool = True
    need_doc_search: bool = False
    need_email: bool = False
    workflow: str = "answer_question"
    next_action: str = "generate_reply"
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
