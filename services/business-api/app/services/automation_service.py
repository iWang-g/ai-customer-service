from __future__ import annotations

import logging
import asyncio
from datetime import datetime
from time import monotonic
from typing import Any

import httpx
from fastapi import HTTPException, status
from sqlalchemy import desc, select
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
from app.schemas.message import MessageRead, SendMessageRequest
from app.services.email_workflow_service import (
    active_workflow,
    enabled_templates,
    sandbox_email_result,
    start_or_resume_email_workflow,
    template_metadata,
)
from app.services.email_service import get_config
from app.services.message_service import create_send_task
from app.services.order_service import order_prompt_context
from app.services.order_service import maybe_create_order_follow_up
from app.services.model_call_service import persist_model_calls
from app.services.outbound_safety import prohibited_outbound_reason
from app.services.robot_service import _knowledge_access_token, serialize_robot


logger = logging.getLogger(__name__)
DEFAULT_CONTEXT_LENGTH = 10
MIN_CONTEXT_LENGTH = 1
MAX_CONTEXT_LENGTH = 50
DEFAULT_TIMEOUT_SECONDS = 10
MIN_TIMEOUT_SECONDS = 1
MAX_TIMEOUT_SECONDS = 60
MAX_SENSITIVE_WORDS = 200
MAX_SENSITIVE_WORD_LENGTH = 64
DEFAULT_SENSITIVE_WORD_REPLY_TEXT = "亲亲，已收到您的消息，正在为您核实，请稍等~"


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
    enabled = config.get("timeout_enabled", False) is True
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


def _sensitive_word_reply_text(robot: Robot | None) -> str:
    text = str(_robot_config(robot).get("sensitive_word_reply_text") or "").strip()
    return text or DEFAULT_SENSITIVE_WORD_REPLY_TEXT


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


def _mark_reply_run_human_required(
    result: dict[str, Any],
    *,
    reason: str,
) -> None:
    result["human_required_marked"] = True
    result["human_required_reason"] = reason
    result["human_required_marked_at"] = utcnow().isoformat()


def _parse_iso_datetime(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def _fallback_marks_human_required(robot: Robot | None) -> bool:
    config = _robot_config(robot)
    if "fallback_mark_human_required" in config:
        return config.get("fallback_mark_human_required") is True
    return config.get("fallback_transfer_to_human") is True


def _is_fallback_reply(result: dict[str, Any]) -> bool:
    action_plan = result.get("action_plan")
    return bool(isinstance(action_plan, dict) and action_plan.get("workflow") == "fallback_reply")


def _sensitive_word_result(
    source_message_id: str,
    matched_word: str | None = None,
    reply_text: str | None = None,
) -> dict[str, Any]:
    matched = bool(matched_word)
    text = str(reply_text or "").strip() or DEFAULT_SENSITIVE_WORD_REPLY_TEXT
    return {
        "decision": "auto_send",
        "text": text,
        "media": [],
        "intent": {
            "intent": "human_handoff",
            "confidence": 1.0,
            "need_customer_reply": True,
            "need_doc_search": False,
            "workflow": "sensitive_word_guard" if matched else "human_review",
            "next_action": "send_handoff_reply",
            "reply_route": "human_handoff",
            "direct_reply_text": text,
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
    defer_for_timeout: bool = False,
) -> str | None:
    if not _should_create_send_task(result, auto_send_allowed=auto_send_allowed):
        return None
    prohibited_reason = prohibited_outbound_reason(str(result.get("text") or ""))
    if prohibited_reason:
        result["decision"] = "needs_human"
        result["text"] = ""
        result["media"] = []
        result["provider"] = "business-outbound-safety"
        result["risk_flags"] = list(dict.fromkeys([
            *(result.get("risk_flags") if isinstance(result.get("risk_flags"), list) else []),
            "prohibited_outbound_content",
            prohibited_reason,
        ]))
        result["action_plan"] = {
            "workflow": "human_review",
            "next_action": "mark_needs_human",
            "required_actions": ["mark_needs_human"],
            "blocked_actions": ["send_platform_text", "send_platform_image"],
        }
        _mark_human_required(conversation, reason="prohibited_outbound_content")
        _mark_reply_run_human_required(result, reason="prohibited_outbound_content")
        db.add(conversation)
        db.commit()
        logger.warning(
            "automatic reply blocked by final outbound safety conversation_id=%s reason=%s",
            conversation.id,
            prohibited_reason,
        )
        return None
    media = result.get("media") if isinstance(result.get("media"), list) else []
    image_media = next(
        (item for item in media if isinstance(item, dict) and item.get("type") == "image" and item.get("url")),
        None,
    )
    timeout_task = db.scalar(
        select(RpaTask).where(
            RpaTask.idempotency_key == f"auto-timeout:{robot.id}:{source_message.id}"
        )
    ) if defer_for_timeout else None
    should_wait_for_timeout = defer_for_timeout and (
        timeout_task is None
        or timeout_task.status in {"queued", "dispatched", "acknowledged"}
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
        source="automation",
        task_status="waiting_timeout" if should_wait_for_timeout else "queued",
    )
    task = db.get(RpaTask, response.task_id)
    if task is not None:
        task.payload_json = {
            **(task.payload_json or {}),
            "automation_source_message_id": source_message.id,
            "automation_trigger_sequence": source_message.conversation_sequence,
        }
        db.add(task)
        db.commit()
    return response.task_id


async def _queue_reply_task_ordered(
    db: Session,
    user: User,
    conversation: Conversation,
    robot: Robot,
    source_message: Message,
    result: dict[str, Any],
    *,
    auto_send_allowed: bool,
    timeout_deadline: asyncio.Event | None = None,
    ordering_lock: asyncio.Lock | None = None,
) -> str | None:
    if ordering_lock is None:
        return _queue_reply_task(
            db,
            user,
            conversation,
            robot,
            source_message,
            result,
            auto_send_allowed=auto_send_allowed,
        )
    async with ordering_lock:
        return _queue_reply_task(
            db,
            user,
            conversation,
            robot,
            source_message,
            result,
            auto_send_allowed=auto_send_allowed,
            defer_for_timeout=bool(timeout_deadline and timeout_deadline.is_set()),
        )


async def _send_timeout_notice_later(
    user_id: str,
    conversation_id: str,
    source_message_id: str,
    robot_id: str,
    seconds: int,
    text: str,
    db_override: Session | None = None,
    *,
    deadline_reached: asyncio.Event | None = None,
    ordering_lock: asyncio.Lock | None = None,
) -> str | None:
    await asyncio.sleep(seconds)
    if ordering_lock is not None:
        async with ordering_lock:
            if deadline_reached is not None:
                deadline_reached.set()
            task_id = _queue_timeout_notice(
                user_id, conversation_id, source_message_id, robot_id, text, db_override
            )
            if task_id is None and deadline_reached is not None:
                deadline_reached.clear()
            return task_id
    if deadline_reached is not None:
        deadline_reached.set()
    return _queue_timeout_notice(
        user_id, conversation_id, source_message_id, robot_id, text, db_override
    )


def _queue_timeout_notice(
    user_id: str,
    conversation_id: str,
    source_message_id: str,
    robot_id: str,
    text: str,
    db_override: Session | None = None,
) -> str | None:
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
            return None
        if conversation.human_required:
            return None
        reply_run = db.scalar(
            select(AutomationReplyRun).where(
                AutomationReplyRun.robot_id == robot.id,
                AutomationReplyRun.source_message_id == source_message_id,
            )
        )
        formal_task = db.scalar(
            select(RpaTask).where(
                RpaTask.idempotency_key == f"auto-reply:{robot.id}:{source_message_id}:text"
            )
        )
        if formal_task is None and reply_run and reply_run.send_task_id:
            formal_task = db.get(RpaTask, reply_run.send_task_id)
        if formal_task is not None and formal_task.status != "waiting_timeout":
            return None
        if reply_run and reply_run.decision == "needs_human":
            return None
        if reply_run is None:
            return None
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
            return response.task_id
        except Exception:  # noqa: BLE001
            logger.exception(
                "timeout notice queue failed conversation_id=%s robot_id=%s source_message_id=%s",
                conversation.id,
                robot.id,
                source_message_id,
            )
            _release_timeout_gated_reply(db, robot.id, source_message_id)
            return None
    finally:
        if db_context is not None:
            db_context.close()


def _release_timeout_gated_reply(db: Session, robot_id: str, source_message_id: str) -> RpaTask | None:
    formal_task = db.scalar(
        select(RpaTask).where(
            RpaTask.idempotency_key == f"auto-reply:{robot_id}:{source_message_id}:text",
            RpaTask.status == "waiting_timeout",
        )
    )
    if formal_task is None:
        return None
    formal_task.status = "queued"
    db.add(formal_task)
    db.commit()
    return formal_task


def _message_history(rows: list[Message]) -> list[dict[str, str]]:
    return [
        {
            "role": "user" if item.sender_role == "customer" else "assistant",
            "content": item.content,
        }
        for item in reversed(rows)
        if (
            getattr(item, "message_status", "sent") != "failed"
            and item.sender_role in {"customer", "agent", "assistant", "bot"}
            and (getattr(item, "raw_payload", {}) or {}).get("automation_mode", "trigger") == "trigger"
            and item.content.strip()
        )
    ]


def _snapshot_customer_batch_size(db: Session, source_message: Message) -> int:
    if source_message.collection_kind != "incremental" or not source_message.first_observation_id:
        return 1
    batch_tail = db.scalars(
        select(Message).where(
            Message.conversation_id == source_message.conversation_id,
            Message.first_observation_id == source_message.first_observation_id,
            Message.conversation_sequence <= source_message.conversation_sequence,
            Message.message_status != "failed",
        ).order_by(desc(Message.conversation_sequence))
    ).all()
    count = 0
    for item in batch_tail:
        automation_mode = (item.raw_payload or {}).get("automation_mode", "trigger")
        if automation_mode != "trigger":
            continue
        if item.sender_role != "customer":
            break
        count += 1
    return max(1, count)


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


def _platform_context(rows: list[Message], limit: int = 10) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for item in reversed(rows):
        raw_payload = item.raw_payload if isinstance(item.raw_payload, dict) else {}
        automation_mode = raw_payload.get("automation_mode")
        message_type = raw_payload.get("message_type") or "context"
        is_triggering_customer_card = (
            automation_mode == "trigger"
            and item.sender_role == "customer"
            and message_type in {"product", "order"}
        )
        if automation_mode != "context" and not is_triggering_customer_card:
            continue
        items.append({
            "type": message_type,
            "content": item.content,
            "data": raw_payload.get("structured_payload") or {},
        })
    return items[-limit:]


async def _decide_reply(
    *,
    settings: Any,
    user: User,
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
    email_config: Any | None = None,
    customer_orders: dict[str, Any] | None = None,
    platform_context: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    config = _robot_config(robot)
    payload = {
        "knowledge_access_token": _knowledge_access_token(user),
        "message": message,
        "conversation": history,
        "platform": platform,
        "shop_name": shop_name,
        "customer_name": customer_name,
        "customer_orders": customer_orders or {"collection_status": "not_collected"},
        "platform_context": platform_context or [],
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
            "prohibited_content_instruction": str(config.get("prohibited_content_instruction") or ""),
            "fallback_reply_text": str(config.get("fallback_reply_text") or ""),
            "email_trigger_scenarios": str(getattr(email_config, "trigger_scenarios", "") or ""),
        },
        "provider_config": {
            "provider": settings.ai_provider if settings.ai_provider_api_key else ai_config.provider,
            "base_url": settings.ai_provider_base_url if settings.ai_provider_api_key else ai_config.base_url,
            "model": str(config.get("model") or getattr(ai_config, "model", "deepseek-v4-flash")),
            "api_key": settings.ai_provider_api_key or ai_config.api_key,
            # The auto-reply switch now belongs to the robot. A configured
            # provider key is sufficient to enable model calls.
            "enabled": bool(settings.ai_provider_api_key or ai_config.api_key),
            "temperature": float(config.get("temperature", getattr(ai_config, "temperature", 0.2))),
        } if ai_config or settings.ai_provider_api_key else None,
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
    *,
    timeout_deadline: asyncio.Event | None = None,
    timeout_ordering_lock: asyncio.Lock | None = None,
) -> dict[str, Any]:
    robot_read = serialize_robot(db, robot)
    message = source_message.content
    if not message.strip():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No customer message available")

    matched_sensitive_word = _matched_sensitive_word(robot, message)
    if matched_sensitive_word:
        result = _sensitive_word_result(
            source_message.id,
            matched_sensitive_word,
            _sensitive_word_reply_text(robot),
        )
        task_id = await _queue_reply_task_ordered(
            db,
            user,
            conversation,
            robot,
            source_message,
            result,
            auto_send_allowed=_auto_send_allowed(robot, requested=request.allow_auto_send),
            timeout_deadline=timeout_deadline,
            ordering_lock=timeout_ordering_lock,
        )
        _mark_human_required(
            conversation,
            reason="sensitive_word",
            word=matched_sensitive_word,
        )
        _mark_reply_run_human_required(result, reason="sensitive_word")
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

    context_length = max(
        _context_length(robot),
        _snapshot_customer_batch_size(db, source_message) - 1,
    )
    history_rows = list(
        db.scalars(
            select(Message)
            .where(
                Message.conversation_id == conversation.id,
                Message.conversation_sequence <= source_message.conversation_sequence,
                Message.message_status != "failed",
            )
            .order_by(desc(Message.conversation_sequence))
            # The source message is part of the query, while context_length
            # represents prior messages. Fetch one extra row for the source.
            .limit(max(context_length * 3 + 10, context_length + 1))
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
    email_config = get_config(db, user)
    customer_orders = order_prompt_context(db, conversation)
    platform_context = _platform_context(history_rows)
    email_workflow_config = {
        "ask_email_text": email_config.ask_email_text,
        "success_text": email_config.success_text,
        "missing_template_text": email_config.missing_template_text,
    }
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
                config=email_workflow_config,
            )
        else:
            result = sandbox_email_result(
                message=message,
                templates=email_template_rows,
                platform_account_id=conversation.platform_account_id,
                config=email_workflow_config,
            )
    else:
        generation_started = monotonic()
        result = await _decide_reply(
            settings=settings, user=user, message=message, history=history,
            platform=conversation.platform_code,
            shop_name=str(conversation.metadata_json.get("shop_name") or ""),
            customer_name=conversation.customer_name or "", robot=robot,
            robot_read=robot_read, ai_config=ai_config,
            auto_send_allowed=auto_send_allowed,
            email_templates=template_metadata(email_template_rows),
            email_config=email_config,
            customer_orders=customer_orders,
            platform_context=platform_context,
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
                    config=email_workflow_config,
                )
            else:
                result = sandbox_email_result(
                    message=message,
                    templates=email_template_rows,
                    suggested_template_id=suggested_template_id,
                    platform_account_id=conversation.platform_account_id,
                    config=email_workflow_config,
                )

    task_ids: list[str] = []
    task_id = await _queue_reply_task_ordered(
        db,
        user,
        conversation,
        robot,
        source_message,
        result,
        auto_send_allowed=auto_send_allowed,
        timeout_deadline=timeout_deadline,
        ordering_lock=timeout_ordering_lock,
    )
    if task_id:
        task_ids.append(task_id)
        action_plan = result.get("action_plan") if isinstance(result.get("action_plan"), dict) else {}
        if action_plan.get("workflow") == "human_review":
            result_risks = result.get("risk_flags") if isinstance(result.get("risk_flags"), list) else []
            reason = "missing_email_template" if "missing_bound_email_template" in result_risks else "human_handoff"
            _mark_human_required(conversation, reason=reason)
            _mark_reply_run_human_required(result, reason=reason)
            db.add(conversation)
            db.commit()
        if _is_fallback_reply(result) and _fallback_marks_human_required(robot):
            _mark_human_required(conversation, reason="fallback_reply")
            _mark_reply_run_human_required(result, reason="fallback_reply")
            db.add(conversation)
            db.commit()
            logger.info(
                "conversation marked human required after fallback queued "
                "conversation_id=%s robot_id=%s task_id=%s",
                conversation.id,
                robot.id,
                task_id,
            )
    outreach = maybe_create_order_follow_up(db, conversation, robot, source_message, result)
    if outreach is not None:
        db.add(outreach)
        db.commit()
        result["outreach_run_id"] = outreach.id
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


async def run_reply(
    db: Session,
    user: User,
    request: ReplyRunRequest,
    *,
    timeout_deadline: asyncio.Event | None = None,
    timeout_ordering_lock: asyncio.Lock | None = None,
) -> dict[str, Any]:
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
        result = _sensitive_word_result(
            source_message.id,
            reply_text=_sensitive_word_reply_text(robot),
        )
        task_id = await _queue_reply_task_ordered(
            db,
            user,
            conversation,
            robot,
            source_message,
            result,
            auto_send_allowed=_auto_send_allowed(robot, requested=request.allow_auto_send),
            timeout_deadline=timeout_deadline,
            ordering_lock=timeout_ordering_lock,
        )
        result["task_ids"] = [task_id] if task_id else []
        return result

    reply_run = AutomationReplyRun(
        user_id=user.id,
        conversation_id=conversation.id,
        source_message_id=source_message.id,
        source_event_id=request.source_event_id,
        trigger_sequence=source_message.conversation_sequence,
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

    from app.services.realtime import realtime_manager
    await realtime_manager.broadcast(
        user.id,
        {
            "type": "automation.reply.started",
            "reply_run_id": reply_run.id,
            "conversation_id": conversation.id,
            "source_message_id": source_message.id,
        },
    )

    try:
        result = await _execute_bound_reply(
            db,
            user,
            request,
            conversation,
            robot,
            source_message,
            timeout_deadline=timeout_deadline,
            timeout_ordering_lock=timeout_ordering_lock,
        )
    except Exception as exc:
        db.rollback()
        persisted_run = db.get(AutomationReplyRun, reply_run.id)
        if persisted_run:
            persisted_run.status = "failed"
            persisted_run.error_message = str(exc)[:2000]
            persisted_run.completed_at = utcnow()
            db.commit()
        await realtime_manager.broadcast(
            user.id,
            {
                "type": "automation.reply.failed",
                "reply_run_id": reply_run.id,
                "conversation_id": conversation.id,
                "error": str(exc)[:500],
            },
        )
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
        persisted_run.trigger_sequence = source_message.conversation_sequence
        persisted_run.decision = str(result.get("decision") or "") or None
        persisted_run.intent = str(intent.get("intent") or "") or None
        persisted_run.qa_entry_id = str(qa_entry.get("id") or "") or None
        persisted_run.qa_category_id = str(qa_entry.get("category_id") or "") or None
        persisted_run.qa_category_name = str(qa_entry.get("category") or "") or None
        persisted_run.qa_match_type = str(qa_match.get("match_type") or "") or None
        persisted_run.document_retrieval_used = bool(retrieval)
        persisted_run.retrieval_count = len(retrieval)
        persisted_run.human_required_marked = result.get("human_required_marked") is True
        persisted_run.human_required_reason = str(result.get("human_required_reason") or "") or None
        persisted_run.human_required_marked_at = _parse_iso_datetime(
            result.get("human_required_marked_at")
        )
        persisted_run.trace_id = str(result.get("trace_id") or "") or None
        persist_model_calls(db, user, persisted_run, robot, conversation, result)
        persisted_run.send_task_id = task_id
        if task_id:
            send_task = db.get(RpaTask, task_id)
            persisted_run.reply_message_id = send_task.message_id if send_task else None
        persisted_run.completed_at = utcnow()
        db.commit()
        reply_message = (
            db.get(Message, persisted_run.reply_message_id)
            if persisted_run.reply_message_id
            else None
        )

        await realtime_manager.broadcast(
            user.id,
            {
                "type": "automation.reply.completed",
                "reply_run_id": persisted_run.id,
                "conversation_id": conversation.id,
                "message": MessageRead.model_validate(reply_message).model_dump(mode="json")
                if reply_message
                else None,
                "task_id": task_id,
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
        return _sensitive_word_result(
            "test",
            matched_sensitive_word,
            _sensitive_word_reply_text(robot),
        )
    robot_read = serialize_robot(db, robot)
    ai_config = db.query(AiProviderConfig).filter(AiProviderConfig.user_id == user.id).first()
    context_length = _context_length(robot)
    history = _history_with_latest(request.conversation, request.message, context_length)
    result = await _decide_reply(
        settings=get_settings(), user=user, message=request.message, history=history,
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
        if conversation.human_required_reason in {
            "order_follow_up_outreach",
            "post_receipt_care_outreach",
        }:
            return None
        robot = _active_robot(db, user, conversation)
        if not robot:
            return None
        timeout_task: asyncio.Task[str | None] | None = None
        timeout_deadline: asyncio.Event | None = None
        timeout_ordering_lock: asyncio.Lock | None = None
        timeout_enabled, timeout_seconds, timeout_text = _timeout_config(robot)
        if _auto_send_allowed(robot, requested=True) and timeout_enabled and timeout_text:
            timeout_deadline = asyncio.Event()
            timeout_ordering_lock = asyncio.Lock()
            timeout_task = asyncio.create_task(
                _send_timeout_notice_later(
                    user.id,
                    conversation.id,
                    source_message_id,
                    robot.id,
                    timeout_seconds,
                    timeout_text,
                    deadline_reached=timeout_deadline,
                    ordering_lock=timeout_ordering_lock,
                )
            )
        try:
            request = ReplyRunRequest(
                conversation_id=conversation_id,
                source_message_id=source_message_id,
                source_event_id=source_event_id,
                allow_auto_send=True,
            )
            result = await run_reply(
                db,
                user,
                request,
                timeout_deadline=timeout_deadline,
                timeout_ordering_lock=timeout_ordering_lock,
            )
            if timeout_task is not None:
                timeout_notice_task_id: str | None = None
                if not timeout_task.done():
                    timeout_task.cancel()
                    try:
                        await timeout_task
                    except asyncio.CancelledError:
                        pass
                else:
                    timeout_notice_task_id = timeout_task.result()
                if timeout_notice_task_id is None:
                    _release_timeout_gated_reply(db, robot.id, source_message_id)
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
