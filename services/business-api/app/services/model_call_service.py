from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from app.models import AiModelCall, AutomationReplyRun, Conversation, Robot, User


def persist_model_calls(
    db: Session,
    user: User,
    reply_run: AutomationReplyRun,
    robot: Robot,
    conversation: Conversation,
    result: dict[str, Any],
) -> list[dict[str, Any]]:
    details = result.get("model_call_details")
    model_call_details = details if isinstance(details, list) else []
    if any(
        isinstance(item, dict)
        and item.get("stage") == "generation"
        and item.get("status") == "success"
        for item in model_call_details
    ):
        reply_run.reply_generation_duration_ms = max(
            0, int(result.get("reply_generation_duration_ms") or 0)
        )

    for item in model_call_details:
        if not isinstance(item, dict):
            continue
        model = str(item.get("model") or "").strip()
        provider = str(item.get("provider") or "").strip()
        if not model or not provider:
            continue
        db.add(AiModelCall(
            user_id=user.id,
            automation_reply_run_id=reply_run.id,
            robot_id=robot.id,
            conversation_id=conversation.id,
            trace_id=reply_run.trace_id,
            stage=str(item.get("stage") or "generation")[:32],
            provider=provider[:32],
            model=model[:128],
            status=("failed" if item.get("status") == "failed" else "success"),
            input_tokens=max(0, int(item.get("input_tokens") or 0)),
            output_tokens=max(0, int(item.get("output_tokens") or 0)),
            duration_ms=max(0, int(item.get("duration_ms") or 0)),
            error_message=(str(item.get("error_message") or "")[:2000] or None),
        ))
    return model_call_details
