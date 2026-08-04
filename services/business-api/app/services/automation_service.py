from __future__ import annotations

import logging
import asyncio
from time import monotonic
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
from app.services.model_call_service import persist_model_calls
from app.services.robot_service import serialize_robot


logger = logging.getLogger(__name__)
DEFAULT_CONTEXT_LENGTH = 20
MIN_CONTEXT_LENGTH = 1
MAX_CONTEXT_LENGTH = 50
DEFAULT_TIMEOUT_SECONDS = 10
MIN_TIMEOUT_SECONDS = 1
MAX_TIMEOUT_SECONDS = 60
MAX_SENSITIVE_WORDS = 200
MAX_SENSITIVE_WORD_LENGTH = 64


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


def _timeout_config(robot: Robot | None) -> tuple[bool, int, str]:
    config = _robot_config(robot)
    enabled = config.get("timeout_enabled", True) is True
    try:
        seconds = int(config.get("timeout_seconds", DEFAULT_TIMEOUT_SECONDS))
    except (TypeError, ValueError):
        seconds = DEFAULT_TIMEOUT_SECONDS
    seconds = max(MIN_TIMEOUT_SECONDS, min(seconds, MAX_TIMEOUT_SECONDS))
    text = str(config.get("timeout_reply_text") or "").strip() or "专项客服正在赶来的路上请稍等~~"
    return enabled, seconds, text


def _sensitive_words(robot: Robot | None) -> list[str]:
    value = _robot_config(robot).get("inbound_sensitive_words", [])
    if not isinstance(value, list):
        return []
    words: list[str] = []
    for item in value:
        word = str(item).strip() if isinstance(item, str) else ""
        if not word or len(word) > MAX_SENSITIVE_WORD_LENGTH or word in words:
            continue
        words.append(word)
        if len(words) >= MAX_SENSITIVE_WORDS:
            break
    return words


def _matched_sensitive_word(robot: Robot | None, message: str) -> str | None:
    normalized_message = message.casefold()
    return next(
        (word for word in _sensitive_words(robot) if word.casefold() in normalized_message),
        None,
    )


def _mark_human_required(
    conversation: Conversation,
    *,
    reason: str,
    word: str | None = None,
) -> None:
    conversation.human_required = True
    conversation.human_required_reason = reason
    conversation.human_required_word = word
    conversation.human_required_at = utcnow()


def _fallback_marks_human_required(robot: Robot | None) -> bool:
    config = _robot_config(robot)
    if "fallback_mark_human_required" in config:
        return config.get("fallback_mark_human_required") is True
    return config.get("fallback_transfer_to_human") is True


def _is_fallback_reply(result: dict[str, Any]) -> bool:
    action_plan = result.get("action_plan")
    return bool(isinstance(action_plan, dict) and action_plan.get("workflow") == "fallback_reply")


def _sensitive_word_result(source_message_id: str, matched_word: str | None = None) -> dict[str, Any]:
    matched = bool(matched_word)
    return {
        "decision": "auto_send",
        "text": "已收到您的消息，正在为您转接人工客服，请稍等～",
        "media": [],
        "intent": {
            "intent": "human_handoff",
            "confidence": 1.0,
            "need_customer_reply": True,
            "need_doc_search": False,
            "workflow": "sensitive_word_guard" if matched else "human_review",
            "next_action": "send_handoff_reply",
            "reply_route": "human_handoff",
            "direct_reply_text": "已收到您的消息，正在为您转接人工客服，请稍等～",
            "risk_flags": ["sensitive_word" if matched else "human_required"],
            "reason": "客户消息命中机器人敏感词策略" if matched else "会话处于待人工处理状态",
        },
        "action_plan": {
            "workflow": "human_review",
            "next_action": "send_handoff_reply",
            "need_doc_search": False,
            "email_service_required": False,
            "required_actions": ["send_platform_text", "mark_needs_human"],
            "blocked_actions": ["qa_match", "generate_reply"],
        },
        "confidence": 1.0,
        "risk_flags": ["sensitive_word" if matched else "human_required"],
        "qa_match": {
            "matched": False,
            "status": "skipped",
            "match_type": "sensitive_word" if matched else "human_required",
        },
        "retrieval": [],
        "model_calls": {
            "intent": "skipped-sensitive-word" if matched else "skipped-human-required",
            "generation": "skipped",
        },
        "provider": "sensitive-word-rule" if matched else "human-required-rule",
        "trace_id": f"{'sensitive' if matched else 'human-required'}-{source_message_id}",
        "task_ids": [],
    }


def _should_create_send_task(result: dict[str, Any], *, auto_send_allowed: bool) -> bool:
    return bool(
        auto_send_allowed
        and result.get("decision") == "auto_send"
        and str(result.get("text") or "").strip()
    )


def _queue_reply_task(
    db: Session,
    user: User,
    conversation: Conversation,
    robot: Robot,
    source_message: Message,
    result: dict[str, Any],
    *,
    auto_send_allowed: bool,
) -> str | None:
    if not _should_create_send_task(result, auto_send_allowed=auto_send_allowed):
        return None
    media = result.get("media") if isinstance(result.get("media"), list) else []
    image_media = next(
        (item for item in media if isinstance(item, dict) and item.get("type") == "image" and item.get("url")),
        None,
    )
    response = create_send_task(
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
    return response.task_id


async def _send_timeout_notice_later(
    user_id: str,
    conversation_id: str,
    source_message_id: str,
    robot_id: str,
    seconds: int,
    text: str,
    db_override: Session | None = None,
) -> None:
    await asyncio.sleep(seconds)
    if not text:
        return
    from app.db.session import SessionLocal

    db_context = SessionLocal() if db_override is None else None
    db = db_override or db_context
    try:
        user = db.get(User, user_id)
        conversation = db.get(Conversation, conversation_id)
        robot = db.get(Robot, robot_id)
        if not user or not conversation or not robot or conversation.user_id != user.id:
            return
        if conversation.human_required:
            return
        reply_run = db.scalar(
            select(AutomationReplyRun).where(
                AutomationReplyRun.robot_id == robot.id,
                AutomationReplyRun.source_message_id == source_message_id,
            )
        )
        if reply_run and reply_run.send_task_id:
            formal_task = db.get(RpaTask, reply_run.send_task_id)
            if formal_task and formal_task.status == "completed":
                return
        if reply_run and reply_run.decision == "needs_human":
            return
        if reply_run is None:
            return
        try:
            response = create_send_task(
                db,
                user,
                SendMessageRequest(
                    conversation_id=conversation.id,
                    content=text,
                    platform_code=conversation.platform_code,
                ),
                idempotency_key=f"auto-timeout:{robot.id}:{source_message_id}",
                source="automation_timeout",
            )
            logger.info(
                "timeout notice queued conversation_id=%s robot_id=%s source_message_id=%s task_id=%s",
                conversation.id,
                robot.id,
                source_message_id,
                response.task_id,
            )
        except Exception:  # noqa: BLE001
            logger.exception(
                "timeout notice queue failed conversation_id=%s robot_id=%s source_message_id=%s",
                conversation.id,
                robot.id,
                source_message_id,
            )
    finally:
        if db_context is not None:
            db_context.close()


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
            "outbound_block_words": config.get("outbound_block_words", []),
            "outbound_block_rules": config.get("outbound_block_rules", []),
            "outbound_block_action": str(config.get("outbound_block_action") or "fallback"),
            "fallback_reply_text": str(config.get("fallback_reply_text") or ""),
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

    matched_sensitive_word = _matched_sensitive_word(robot, message)
    if matched_sensitive_word:
        result = _sensitive_word_result(source_message.id, matched_sensitive_word)
        task_id = _queue_reply_task(
            db,
            user,
            conversation,
            robot,
            source_message,
            result,
            auto_send_allowed=_auto_send_allowed(robot, requested=request.allow_auto_send),
        )
        _mark_human_required(
            conversation,
            reason="sensitive_word",
            word=matched_sensitive_word,
        )
        db.add(conversation)
        db.commit()
        logger.info(
            "automation reply blocked by sensitive word conversation_id=%s robot_id=%s word=%s",
            conversation.id,
            robot.id,
            matched_sensitive_word,
        )
        result["task_ids"] = [task_id] if task_id else []
        return result

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
        generation_started = monotonic()
        result = await _decide_reply(
            settings=settings, message=message, history=history,
            platform=conversation.platform_code,
            shop_name=str(conversation.metadata_json.get("shop_name") or ""),
            customer_name=conversation.customer_name or "", robot=robot,
            robot_read=robot_read, ai_config=ai_config,
            auto_send_allowed=auto_send_allowed,
            email_templates=template_metadata(email_template_rows),
        )
        result["reply_generation_duration_ms"] = max(
            0, round((monotonic() - generation_started) * 1000)
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
    task_id = _queue_reply_task(
        db,
        user,
        conversation,
        robot,
        source_message,
        result,
        auto_send_allowed=auto_send_allowed,
    )
    if task_id:
        task_ids.append(task_id)
        action_plan = result.get("action_plan") if isinstance(result.get("action_plan"), dict) else {}
        if action_plan.get("workflow") == "human_review":
            _mark_human_required(conversation, reason="human_handoff")
            db.add(conversation)
            db.commit()
        if _is_fallback_reply(result) and _fallback_marks_human_required(robot):
            _mark_human_required(conversation, reason="fallback_reply")
            db.add(conversation)
            db.commit()
            logger.info(
                "conversation marked human required after fallback queued "
                "conversation_id=%s robot_id=%s task_id=%s",
                conversation.id,
                robot.id,
                task_id,
            )
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
    if conversation.human_required:
        result = _sensitive_word_result(source_message.id)
        task_id = _queue_reply_task(
            db,
            user,
            conversation,
            robot,
            source_message,
            result,
            auto_send_allowed=_auto_send_allowed(robot, requested=request.allow_auto_send),
        )
        result["task_ids"] = [task_id] if task_id else []
        return result

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
        model_call_details = (
            result.get("model_call_details")
            if isinstance(result.get("model_call_details"), list)
            else []
        )
        retrieval = result.get("retrieval") if isinstance(result.get("retrieval"), list) else []
        persisted_run.status = "succeeded"
        persisted_run.decision = str(result.get("decision") or "") or None
        persisted_run.intent = str(intent.get("intent") or "") or None
        persisted_run.qa_entry_id = str(qa_entry.get("id") or "") or None
        persisted_run.qa_category_id = str(qa_entry.get("category_id") or "") or None
        persisted_run.qa_category_name = str(qa_entry.get("category") or "") or None
        persisted_run.qa_match_type = str(qa_match.get("match_type") or "") or None
        persisted_run.document_retrieval_used = bool(retrieval)
        persisted_run.retrieval_count = len(retrieval)
        persisted_run.trace_id = str(result.get("trace_id") or "") or None
        persist_model_calls(db, user, persisted_run, robot, conversation, result)
        persisted_run.send_task_id = task_id
        if task_id:
            send_task = db.get(RpaTask, task_id)
            persisted_run.reply_message_id = send_task.message_id if send_task else None
        persisted_run.completed_at = utcnow()
        db.commit()
        from app.services.realtime import realtime_manager

        await realtime_manager.broadcast(
            user.id,
            {
                "type": "automation.reply.completed",
                "reply_run_id": persisted_run.id,
                "conversation_id": conversation.id,
                "model": next(
                    (
                        str(item.get("model"))
                        for item in reversed(model_call_details)
                        if isinstance(item, dict) and item.get("model")
                    ),
                    "",
                ),
            },
        )
    return result


async def run_test_reply(db: Session, user: User, request: TestReplyRequest) -> dict[str, Any]:
    """Run the same decision pipeline without requiring a real conversation or sending tasks."""
    robot = db.scalar(select(Robot).where(Robot.id == request.robot_id, Robot.user_id == user.id))
    if not robot:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Robot not found")
    matched_sensitive_word = _matched_sensitive_word(robot, request.message)
    if matched_sensitive_word:
        return _sensitive_word_result("test", matched_sensitive_word)
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
        timeout_task: asyncio.Task[None] | None = None
        timeout_enabled, timeout_seconds, timeout_text = _timeout_config(robot)
        if _auto_send_allowed(robot, requested=True) and timeout_enabled and timeout_text:
            timeout_task = asyncio.create_task(
                _send_timeout_notice_later(
                    user.id,
                    conversation.id,
                    source_message_id,
                    robot.id,
                    timeout_seconds,
                    timeout_text,
                )
            )
        try:
            result = await run_reply(
                db,
                user,
                ReplyRunRequest(
                    conversation_id=conversation_id,
                    source_message_id=source_message_id,
                    source_event_id=source_event_id,
                    allow_auto_send=True,
                ),
            )
            if conversation.human_required:
                from app.services.realtime import realtime_manager

                await realtime_manager.broadcast(
                    user.id,
                    {"type": "conversation.updated", "conversation_id": conversation.id},
                )
            return result
        except HTTPException as exc:
            if exc.status_code == status.HTTP_409_CONFLICT and exc.detail == (
                "Automation reply already exists for this source message"
            ):
                return None
            raise
        finally:
            # The delayed task must survive normal reply generation so it can
            # inspect the eventual RPA task status at the configured deadline.
            if timeout_task is not None and timeout_task.done() and not timeout_task.cancelled():
                timeout_task.exception()
