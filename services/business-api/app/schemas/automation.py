from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class ReplyRunRequest(BaseModel):
    conversation_id: str = Field(min_length=1)
    source_message_id: str = Field(min_length=1)
    source_event_id: str | None = Field(default=None, min_length=1)
    allow_auto_send: bool = False


class TestReplyRequest(BaseModel):
    robot_id: str = Field(min_length=1)
    message: str = Field(min_length=1, max_length=10000)
    conversation: list[dict[str, Any]] = Field(default_factory=list, max_length=100)
    platform_code: str = Field(default="", max_length=64)
    shop_name: str = Field(default="", max_length=128)
    customer_name: str = Field(default="测试客户", max_length=128)


class ReplyRunResponse(BaseModel):
    decision: str
    text: str
    media: list[dict[str, Any]] = Field(default_factory=list)
    intent: dict[str, Any] = Field(default_factory=dict)
    action_plan: dict[str, Any] = Field(default_factory=dict)
    confidence: float
    risk_flags: list[str] = Field(default_factory=list)
    qa_match: dict[str, Any] | None = None
    retrieval: list[dict[str, Any]] = Field(default_factory=list)
    model_calls: dict[str, str] = Field(default_factory=dict)
    model_call_details: list[dict[str, Any]] = Field(default_factory=list)
    provider: str
    trace_id: str
    task_ids: list[str] = Field(default_factory=list)
