from __future__ import annotations

import logging
from typing import Any

import httpx
from fastapi import HTTPException, status
from sqlalchemy import desc, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models import (
    AiProviderConfig,
    AutomationReplyRun,
    Conversation,
    Message,
    Robot,
    RobotPlatformScope,
    RpaEvent,
    RpaTask,
    User,
    utcnow,
)
from app.schemas.automation import ReplyRunRequest, TestReplyRequest
from app.schemas.message import SendMessageRequest
from app.services.email_workflow_service import (
    active_workflow,
    enabled_templates,
    sandbox_email_result,
    start_or_resume_email_workflow,
    template_metadata,
)
from app.services.message_service import create_send_task
from app.services.robot_service import serialize_robot


logger = logging.getLogger(__name__)
DEFAULT_CONTEXT_LENGTH = 20
MIN_CONTEXT_LENGTH = 1
MAX_CONTEXT_LENGTH = 50


def _active_robot(db: Session, user: User, conversation: Conversation) -> Robot | None:
    robots = list(db.scalars(
        select(Robot)
        .where(Robot.user_id == user.id, Robot.enabled.is_(True), Robot.status == "online")
        .order_by(desc(Robot.updated_at))
    ).all())
    for robot in robots:
        scopes = list(db.scalars(
            select(RobotPlatformScope).where(RobotPlatformScope.robot_id == robot.id)
        ).all())
        if any(
            scope.platform_code == "all"
            or (
                scope.platform_code == conversation.platform_code
                and (scope.all_accounts or scope.platform_account_id == conversation.platform_account_id)
            )
            for scope in scopes
        ):
            return robot
    return None


def _robot_config(robot: Robot | None) -> dict[str, Any]:
    config = robot.config_json if robot and isinstance(robot.config_json, dict) else {}
    return config


def _context_length(robot: Robot | None) -> int:
    value = _robot_config(robot).get("context_length", DEFAULT_CONTEXT_LENGTH)
    if isinstance(value, bool):
        return DEFAULT_CONTEXT_LENGTH
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return DEFAULT_CONTEXT_LENGTH
    return max(MIN_CONTEXT_LENGTH, min(parsed, MAX_CONTEXT_LENGTH))


def _auto_send_allowed(robot: Robot | None, *, requested: bool) -> bool:
    return bool(requested and _robot_config(robot).get("allow_auto_send", False))


def _should_create_send_task(result: dict[str, Any], *, auto_send_allowed: bool) -> bool:
    return bool(
        auto_send_allowed
        and result.get("decision") == "auto_send"
        and str(result.get("text") or "").strip()
    )


def _message_history(rows: list[Message]) -> list[dict[str, str]]:
    return [
        {
            "role": "user" if item.sender_role == "customer" else "assistant",
            "content": item.content,
        }
        for item in reversed(rows)
        if item.content.strip()
    ]


def _history_with_latest(
    history: list[dict[str, Any]],
    latest_message: str,
    limit: int,
) -> list[dict[str, str]]:
    normalized = [
        {"role": str(item.get("role") or ""), "content": str(item.get("content") or "").strip()}
        for item in history
        if item.get("role") in {"user", "assistant"} and str(item.get("content") or "").strip()
    ]
    latest = {"role": "user", "content": latest_message.strip()}
    if normalized and normalized[-1] == latest:
        normalized.pop()
    return [*normalized[-limit:], latest]


async def _decide_reply(
    *,
    settings: Any,
    message: str,
    history: list[dict[str, Any]],
    platform: str,
    shop_name: str,
    customer_name: str,
    robot: Robot,
    robot_read: Any,
    ai_config: AiProviderConfig | None,
    auto_send_allowed: bool,
    email_templates: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    config = _robot_config(robot)
    payload = {
        "message": message,
        "conversation": history,
        "platform": platform,
        "shop_name": shop_name,
        "customer_name": customer_name,
        "qa_base_ids": robot_read.qa_knowledge_base_ids,
        "product_base_ids": robot_read.product_knowledge_base_ids,
        "tone_base_id": robot_read.tone_knowledge_base_id or "",
        "email_templates": email_templates or [],
        "allow_auto_send": auto_send_allowed,
        "reply_config": {
            "base_style": str(config.get("base_style") or "专业"),
            "answer_length": str(config.get("answer_length") or "适中"),
            "customer_address": str(config.get("customer_address") or "亲亲"),
            "self_address": str(config.get("self_address") or "客服"),
            "advanced_instruction": str(config.get("advanced_instruction") or ""),
        },
        "provider_config": {
            "provider": ai_config.provider,
            "base_url": ai_config.base_url,
            "model": str(config.get("model") or ai_config.model),
            "api_key": ai_config.api_key,
            # The auto-reply switch now belongs to the robot. A configured
            # provider key is sufficient to enable model calls.
            "enabled": bool(ai_config.api_key),
            "temperature": float(config.get("temperature", ai_config.temperature)),
        } if ai_config else None,
    }
    try:
        async with httpx.AsyncClient(
            base_url=settings.ai_reply_base_url.rstrip("/"),
            timeout=30,
            trust_env=False,
        ) as client:
            response = await client.post("/api/v1/replies/decide", json=payload)
            response.raise_for_status()
            return response.json()
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=f"AI reply service unavailable: {exc}") from exc


async def _execute_bound_reply(
    db: Session,
    user: User,
    request: ReplyRunRequest,
    conversation: Conversation,
    robot: Robot,
    source_message: Message,
) -> dict[str, Any]:
    robot_read = serialize_robot(db, robot)
    message = source_message.content
    if not message.strip():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No customer message available")

    context_length = _context_length(robot)
    source_timestamp = (
        source_message.platform_sent_at or source_message.observed_at or source_message.sent_at
    )
    history_rows = list(
        db.scalars(
            select(Message)
            .where(
                Message.conversation_id == conversation.id,
                Message.created_at <= source_message.created_at,
                func.coalesce(
                    Message.platform_sent_at,
                    Message.observed_at,
                    Message.sent_at,
                ) <= source_timestamp,
            )
            .order_by(
                desc(func.coalesce(Message.platform_sent_at, Message.observed_at, Message.sent_at)),
                desc(Message.snapshot_sequence),
                desc(Message.created_at),
                desc(Message.id),
            )
            # The source message is part of the query, while context_length
            # represents prior messages. Fetch one extra row for the source.
            .limit(context_length + 1)
        ).all()
    )
    history = _history_with_latest(_message_history(history_rows), message, context_length)
    settings = get_settings()
    auto_send_allowed = _auto_send_allowed(
        robot,
        requested=request.allow_auto_send,
    )
    ai_config = db.query(AiProviderConfig).filter(AiProviderConfig.user_id == user.id).first()
    email_template_rows = enabled_templates(db, user)
    workflow = active_workflow(db, user, conversation, robot)
    logger.info(
        "automation reply started conversation_id=%s robot_id=%s prompt_message_count=%d "
        "history_limit=%d auto_send_allowed=%s",
        conversation.id,
        robot.id,
        len(history),
        context_length,
        auto_send_allowed,
    )
    if workflow is not None:
        if auto_send_allowed:
            result = start_or_resume_email_workflow(
                db,
                user,
                conversation,
                robot,
                message=message,
                source_message=source_message,
                templates=email_template_rows,
                workflow=workflow,
            )
        else:
            result = sandbox_email_result(message=message, templates=email_template_rows)
    else:
        result = await _decide_reply(
            settings=settings, message=message, history=history,
            platform=conversation.platform_code,
            shop_name=str(conversation.metadata_json.get("shop_name") or ""),
            customer_name=conversation.customer_name or "", robot=robot,
            robot_read=robot_read, ai_config=ai_config,
            auto_send_allowed=auto_send_allowed,
            email_templates=template_metadata(email_template_rows),
        )
        intent = result.get("intent") if isinstance(result.get("intent"), dict) else {}
        action_plan = result.get("action_plan") if isinstance(result.get("action_plan"), dict) else {}
        if intent.get("intent") == "email_link_request" or action_plan.get("workflow") == "collect_email_for_link":
            suggested_template_id = str(intent.get("template_id") or intent.get("template_key") or "")
            if auto_send_allowed:
                result = start_or_resume_email_workflow(
                    db,
                    user,
                    conversation,
                    robot,
                    message=message,
                    source_message=source_message,
                    templates=email_template_rows,
                    suggested_template_id=suggested_template_id,
                )
            else:
                result = sandbox_email_result(
                    message=message,
                    templates=email_template_rows,
                    suggested_template_id=suggested_template_id,
                )

    task_ids: list[str] = []
    if _should_create_send_task(result, auto_send_allowed=auto_send_allowed):
        media = result.get("media") if isinstance(result.get("media"), list) else []
        image_media = next(
            (item for item in media if isinstance(item, dict) and item.get("type") == "image" and item.get("url")),
            None,
        )
        send_response = create_send_task(
            db,
            user,
            SendMessageRequest(
                conversation_id=conversation.id,
                content=str(result["text"]),
                platform_code=conversation.platform_code,
            ),
            follow_up=(
                {"type": "image", "url": str(image_media["url"])}
                if image_media
                else None
            ),
            idempotency_key=f"auto-reply:{robot.id}:{source_message.id}:text",
        )
        task_ids.append(send_response.task_id)
    result["task_ids"] = task_ids
    qa_match = result.get("qa_match") if isinstance(result.get("qa_match"), dict) else {}
    logger.info(
        "automation reply finished conversation_id=%s robot_id=%s trace_id=%s decision=%s "
        "qa_status=%s qa_match_type=%s intent=%s next_action=%s provider=%s task_count=%d",
        conversation.id,
        robot.id,
        result.get("trace_id", ""),
        result.get("decision", ""),
        qa_match.get("status", "unknown"),
        qa_match.get("match_type", ""),
        (result.get("intent") or {}).get("intent", ""),
        (result.get("action_plan") or {}).get("next_action", ""),
        result.get("provider", ""),
        len(task_ids),
    )
    return result


async def run_reply(db: Session, user: User, request: ReplyRunRequest) -> dict[str, Any]:
    conversation = db.scalar(
        select(Conversation).where(
            Conversation.id == request.conversation_id,
            Conversation.user_id == user.id,
        )
    )
    if not conversation:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found")

    source_message = db.scalar(
        select(Message).where(
            Message.id == request.source_message_id,
            Message.user_id == user.id,
        )
    )
    if not source_message:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Source message not found")
    if source_message.conversation_id != conversation.id:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Source message does not belong to the conversation",
        )
    if source_message.sender_role != "customer":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Source message is not a customer message",
        )
    if request.source_event_id:
        source_event = db.scalar(
            select(RpaEvent).where(
                RpaEvent.id == request.source_event_id,
                RpaEvent.user_id == user.id,
            )
        )
        if not source_event:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Source event not found")

    robot = _active_robot(db, user, conversation)
    if not robot:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="No online robot is assigned to this platform account",
        )

    reply_run = AutomationReplyRun(
        user_id=user.id,
        conversation_id=conversation.id,
        source_message_id=source_message.id,
        source_event_id=request.source_event_id,
        robot_id=robot.id,
        status="running",
    )
    db.add(reply_run)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Automation reply already exists for this source message",
        )
    db.refresh(reply_run)

    try:
        result = await _execute_bound_reply(
            db,
            user,
            request,
            conversation,
            robot,
            source_message,
        )
    except Exception as exc:
        db.rollback()
        persisted_run = db.get(AutomationReplyRun, reply_run.id)
        if persisted_run:
            persisted_run.status = "failed"
            persisted_run.error_message = str(exc)[:2000]
            persisted_run.completed_at = utcnow()
            db.commit()
        raise

    task_id = next(iter(result.get("task_ids") or []), None)
    persisted_run = db.get(AutomationReplyRun, reply_run.id)
    if persisted_run:
        intent = result.get("intent") if isinstance(result.get("intent"), dict) else {}
        qa_match = result.get("qa_match") if isinstance(result.get("qa_match"), dict) else {}
        qa_entry = qa_match.get("entry") if isinstance(qa_match.get("entry"), dict) else {}
        retrieval = result.get("retrieval") if isinstance(result.get("retrieval"), list) else []
        persisted_run.status = "no_reply" if result.get("decision") == "no_reply" else "succeeded"
        persisted_run.decision = str(result.get("decision") or "") or None
        persisted_run.intent = str(intent.get("intent") or "") or None
        persisted_run.qa_entry_id = str(qa_entry.get("id") or "") or None
        persisted_run.qa_category_id = str(qa_entry.get("category_id") or "") or None
        persisted_run.qa_category_name = str(qa_entry.get("category") or "") or None
        persisted_run.qa_match_type = str(qa_match.get("match_type") or "") or None
        persisted_run.document_retrieval_used = bool(retrieval)
        persisted_run.retrieval_count = len(retrieval)
        persisted_run.trace_id = str(result.get("trace_id") or "") or None
        persisted_run.send_task_id = task_id
        if task_id:
            send_task = db.get(RpaTask, task_id)
            persisted_run.reply_message_id = send_task.message_id if send_task else None
        persisted_run.completed_at = utcnow()
        db.commit()
    return result


async def run_test_reply(db: Session, user: User, request: TestReplyRequest) -> dict[str, Any]:
    """Run the same decision pipeline without requiring a real conversation or sending tasks."""
    robot = db.scalar(select(Robot).where(Robot.id == request.robot_id, Robot.user_id == user.id))
    if not robot:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Robot not found")
    robot_read = serialize_robot(db, robot)
    ai_config = db.query(AiProviderConfig).filter(AiProviderConfig.user_id == user.id).first()
    context_length = _context_length(robot)
    history = _history_with_latest(request.conversation, request.message, context_length)
    result = await _decide_reply(
        settings=get_settings(), message=request.message, history=history,
        platform=request.platform_code, shop_name=request.shop_name,
        customer_name=request.customer_name, robot=robot,
        robot_read=robot_read, ai_config=ai_config, auto_send_allowed=False,
        email_templates=template_metadata(enabled_templates(db, user)),
    )
    intent = result.get("intent") if isinstance(result.get("intent"), dict) else {}
    action_plan = result.get("action_plan") if isinstance(result.get("action_plan"), dict) else {}
    if intent.get("intent") == "email_link_request" or action_plan.get("workflow") == "collect_email_for_link":
        result = sandbox_email_result(
            message=request.message,
            templates=enabled_templates(db, user),
            suggested_template_id=str(intent.get("template_id") or intent.get("template_key") or ""),
        )
    result["decision"] = "suggest" if result.get("decision") == "auto_send" else result.get("decision", "suggest")
    result["task_ids"] = []
    return result


async def process_inbound_reply(
    user_id: str,
    conversation_id: str,
    source_message_id: str,
    source_event_id: str | None = None,
) -> dict[str, Any] | None:
    """Run an enabled robot against a newly observed customer message."""
    from app.db.session import SessionLocal

    with SessionLocal() as db:
        user = db.get(User, user_id)
        if not user:
            return None
        conversation = db.scalar(
            select(Conversation).where(
                Conversation.id == conversation_id,
                Conversation.user_id == user.id,
            )
        )
        if not conversation:
            return None
        robot = _active_robot(db, user, conversation)
        if not robot:
            return None
        try:
            return await run_reply(
                db,
                user,
                ReplyRunRequest(
                    conversation_id=conversation_id,
                    source_message_id=source_message_id,
                    source_event_id=source_event_id,
                    allow_auto_send=True,
                ),
            )
        except HTTPException as exc:
            if exc.status_code == status.HTTP_409_CONFLICT and exc.detail == (
                "Automation reply already exists for this source message"
            ):
                return None
            raise
