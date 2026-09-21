from __future__ import annotations

from app.services.pdd_message_context import prompt_context as pdd_message_context

import logging
import asyncio
import re
from datetime import datetime
from time import monotonic
from typing import Any
import unicodedata

import httpx
from fastapi import HTTPException, status
from sqlalchemy import desc, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.services.qianniu_transfer_service import transfer_blocked
from app.services.qianniu_transfer_notice import is_transfer_reply_source, transfer_prompt
from app.services.qianniu_shop_profile import conversation_shop_name
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
    bind_email_prompt_task,
    cancel_email_workflow,
    email_unavailable,
    email_unavailable_result,
    enabled_templates,
    extract_email,
    sandbox_email_result,
    start_or_resume_email_workflow,
    template_metadata,
)
from app.services.email_service import get_config
from app.services.message_service import create_send_task
from app.services.order_service import order_prompt_context
from app.services.order_service import maybe_create_order_follow_up
from app.services.product_service import match_store_products
from app.services.qianniu_product_links import append_reply_links, reply_candidates, outbound_reason
from app.services.model_call_service import persist_model_calls
from app.services.outbound_safety import prohibited_outbound_reason, qianniu_outbound_reason
from app.services.robot_service import _knowledge_access_token, serialize_robot
from app.services.douyin_automation import robot_matches, reply_block_reason
from app.services.douyin_message_context import prompt_context as douyin_message_context


logger = logging.getLogger(__name__)
DEFAULT_CONTEXT_LENGTH = 10
MIN_CONTEXT_LENGTH = 1
MAX_CONTEXT_LENGTH = 50
DEFAULT_TIMEOUT_SECONDS = 10
MIN_TIMEOUT_SECONDS = 1
MAX_TIMEOUT_SECONDS = 60
INBOUND_REPLY_DEBOUNCE_SECONDS = 3.0
INBOUND_REPLY_FAST_DEBOUNCE_SECONDS = 1.2
INBOUND_REPLY_MEDIUM_DEBOUNCE_SECONDS = 1.5
ORDER_CONTEXT_REFRESH_TIMEOUT_SECONDS = 6.0
ORDER_CONTEXT_REFRESH_POLL_SECONDS = 0.4
MAX_SENSITIVE_WORDS = 200
MAX_SENSITIVE_WORD_LENGTH = 64
AUTO_REPLY_MESSAGE_TYPES = {"text", "product", "order"}
_pending_inbound_reply_tasks: dict[tuple[str, str], asyncio.Task[None]] = {}


def inbound_reply_debounce_seconds(message: Message) -> float:
    raw_payload = message.raw_payload if isinstance(message.raw_payload, dict) else {}
    message_type = str(raw_payload.get("message_type") or "text")
    if message_type in {"product", "image", "order"} or (getattr(message, 'platform_code', None) == 'douyin' and message_type == 'unknown'):
        return INBOUND_REPLY_FAST_DEBOUNCE_SECONDS
    text = re.sub(r"\s+", "", message.content or "").strip()
    if not text:
        return INBOUND_REPLY_DEBOUNCE_SECONDS
    normalized = re.sub(r"[，。！？、,.!?~～]+$", "", text).casefold()
    if normalized in {
        "你好", "您好", "嗨", "哈喽", "hello", "hi", "在吗", "在不在", "处吗",
        "好的", "好", "嗯", "行", "可以", "需要", "谢谢", "感谢", "收到", "明白了",
    }:
        return INBOUND_REPLY_FAST_DEBOUNCE_SECONDS
    if re.search(r"[。！？!?]$", text) or re.search(
        r"(?:吗|么|呢|什么|怎么|如何|为什么|多少|多久|哪(?:个|款|种|里)?|有没有|能否|是否)",
        normalized,
    ):
        return INBOUND_REPLY_FAST_DEBOUNCE_SECONDS
    if normalized.endswith(("我想", "想问", "请问", "就是", "然后", "还有", "但是", "不过", "这个", "那个", "帮我")):
        return INBOUND_REPLY_DEBOUNCE_SECONDS
    if len(normalized) >= 6:
        return INBOUND_REPLY_MEDIUM_DEBOUNCE_SECONDS
    return INBOUND_REPLY_DEBOUNCE_SECONDS
DEFAULT_HUMAN_REQUIRED_REPLY_TEXT = "亲，已收到这条消息，我这边先标记给人工客服查看。"
DEFAULT_SENSITIVE_WORD_REPLY_TEXT = "亲亲，已收到您的消息，正在为您核实，请稍等~"
DEFAULT_PRODUCT_CARD_ACK_TEXT = "亲亲，关于这款商品有什么想要了解的吗"
DEFAULT_TRANSFER_CONFIRM_TEXT = "亲亲，为及时给您解答，是否需要转接给其他客服"
DEFAULT_TRANSFER_ACK_TEXT = "亲亲，为给您解答，稍等一下，将为您转客服~"
DEFAULT_TRANSFER_CANCEL_TEXT = "好的亲亲，有需要随时告诉我"
TRANSFER_REASON_TEXT = "无原因直接转移"
AUTO_TRANSFER_METADATA_KEY = "auto_transfer"
HUMAN_HANDOFF_STRATEGY_TRANSFER = "transfer_conversation"
PDD_CUSTOM_ORDER_CONFIRMATION_PROMPT = "你刚刚拼单的商品为定制商品，需要确认定制方案哦~"
DEFAULT_PDD_CUSTOM_ORDER_SUPPLEMENT_TEXT = "亲亲，如果您不需要额外定制，默认是按您下单时选择的那款商品图安排制作发货~"
PDD_CUSTOM_ORDER_SCENE_METADATA_KEY = "pdd_custom_order_prompt_reply"
_INVISIBLE_CONTENT_RE = re.compile(r"[\u200b-\u200d\ufeff]")
_CONTENT_WHITESPACE_RE = re.compile(r"\s+")


def _active_robot(db: Session, user: User, conversation: Conversation) -> Robot | None:
    robots = list(db.scalars(
        select(Robot)
        .where(Robot.user_id == user.id, Robot.enabled.is_(True), Robot.status == "online")
        .order_by(desc(Robot.updated_at))
    ).all())
    for robot in robots:
        if conversation.platform_code == "douyin":
            if robot_matches(db, robot, conversation):
                return robot
            continue
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


def _product_recommendation_config(robot: Robot | None) -> tuple[bool, str]:
    config = _robot_config(robot)
    enabled = config.get("product_recommend_enabled") is True
    text = str(config.get("product_recommend_text") or "").strip()
    return enabled, text


def _product_card_ack_text(robot: Robot | None) -> str:
    text = str(_robot_config(robot).get("product_card_ack_text") or "").strip()
    return text or DEFAULT_PRODUCT_CARD_ACK_TEXT


def _pdd_custom_order_supplement_text(robot: Robot | None) -> str:
    text = str(_robot_config(robot).get("pdd_custom_order_supplement_text") or "").strip()
    return text or DEFAULT_PDD_CUSTOM_ORDER_SUPPLEMENT_TEXT


def _normalized_message_content(value: Any) -> str:
    content = unicodedata.normalize("NFKC", str(value or ""))
    content = _INVISIBLE_CONTENT_RE.sub("", content)
    return _CONTENT_WHITESPACE_RE.sub(" ", content).strip()


def _message_structured_payload(message: Message) -> dict[str, Any]:
    raw_payload = message.raw_payload if isinstance(message.raw_payload, dict) else {}
    structured = raw_payload.get("structured_payload")
    return structured if isinstance(structured, dict) else {}


def _is_pdd_main_account_custom_order_prompt(message: Message) -> bool:
    if message.platform_code != "pinduoduo" or message.sender_role != "agent":
        return False
    if _normalized_message_content(message.content) != _normalized_message_content(
        PDD_CUSTOM_ORDER_CONFIRMATION_PROMPT
    ):
        return False
    return _normalized_message_content(_message_structured_payload(message).get("from_csid")) == "主账号"


def _pdd_custom_order_scene_used(conversation: Conversation) -> bool:
    metadata = conversation.metadata_json if isinstance(conversation.metadata_json, dict) else {}
    state = metadata.get(PDD_CUSTOM_ORDER_SCENE_METADATA_KEY)
    return isinstance(state, dict) and state.get("status") == "applied"


def _detect_pdd_custom_order_scene(
    db: Session,
    conversation: Conversation,
    robot: Robot,
    source_message: Message,
    history_rows: list[Message],
) -> dict[str, Any] | None:
    if conversation.platform_code != "pinduoduo" or source_message.sender_role != "customer":
        return None
    if _robot_config(robot).get("pdd_custom_order_supplement_enabled") is False:
        return None
    if _pdd_custom_order_scene_used(conversation):
        return None
    prompt = next(
        (
            item for item in sorted(
                history_rows,
                key=lambda row: int(row.conversation_sequence or 0),
                reverse=True,
            )
            if int(item.conversation_sequence or 0) < int(source_message.conversation_sequence or 0)
            and _is_pdd_main_account_custom_order_prompt(item)
        ),
        None,
    )
    if prompt is None:
        return None
    prompt_sequence = int(prompt.conversation_sequence or 0)
    source_sequence = int(source_message.conversation_sequence or 0)
    has_customer_between = db.scalar(
        select(Message.id).where(
            Message.conversation_id == conversation.id,
            Message.sender_role == "customer",
            Message.conversation_sequence > prompt_sequence,
            Message.conversation_sequence < source_sequence,
            Message.message_status != "failed",
        ).limit(1)
    )
    if has_customer_between is not None:
        return None
    return {
        "type": "pdd_custom_order_confirmation",
        "prompt_message_id": prompt.id,
        "prompt_platform_message_id": prompt.platform_message_id or "",
        "prompt_text": prompt.content,
        "supplement_text": _pdd_custom_order_supplement_text(robot),
    }


def _mark_pdd_custom_order_scene_applied(
    db: Session,
    conversation: Conversation,
    robot: Robot,
    source_message: Message,
    scene: dict[str, Any] | None,
    result: dict[str, Any],
) -> None:
    if not scene:
        return
    metadata = conversation.metadata_json if isinstance(conversation.metadata_json, dict) else {}
    conversation.metadata_json = {
        **metadata,
        PDD_CUSTOM_ORDER_SCENE_METADATA_KEY: {
            "status": "applied",
            "robot_id": robot.id,
            "source_message_id": source_message.id,
            "source_message_sequence": source_message.conversation_sequence,
            "prompt_message_id": scene.get("prompt_message_id"),
            "prompt_platform_message_id": scene.get("prompt_platform_message_id"),
            "reply_text": str(result.get("text") or "")[:1000],
            "updated_at": utcnow().isoformat(),
        },
    }
    db.add(conversation)
    db.commit()


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


def _human_required_reply_text(robot: Robot | None, reason: str) -> str:
    config = _robot_config(robot)
    reason_key = {
        "image_message": "image_message_reply_text",
        "unsupported_message": "unsupported_message_reply_text",
    }.get(reason)
    if reason_key:
        text = str(config.get(reason_key) or "").strip()
        if text:
            return text
    text = str(config.get("human_required_reply_text") or "").strip()
    return text or DEFAULT_HUMAN_REQUIRED_REPLY_TEXT


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


def _order_summary_observed_at(conversation: Conversation) -> str:
    summary = (conversation.metadata_json or {}).get("customer_orders")
    if not isinstance(summary, dict):
        return ""
    return str(summary.get("observed_at") or "")


def _can_refresh_order_context(conversation: Conversation) -> bool:
    external_id = str(conversation.external_conversation_id or "").strip()
    return bool(
        conversation.platform_code == "pinduoduo"
        and conversation.platform_account_id
        and external_id
        and not external_id.startswith("name:")
    )


async def _refresh_order_context_before_reply(
    db: Session,
    user: User,
    conversation: Conversation,
    source_message: Message,
    *,
    enabled: bool,
    timeout_seconds: float = ORDER_CONTEXT_REFRESH_TIMEOUT_SECONDS,
    message_text: str | None = None,
) -> dict[str, Any]:
    if not enabled:
        return {"attempted": False, "reason": "auto_send_disabled"}
    if conversation.platform_code == 'douyin':
        from app.services.douyin_order_context import refresh_before_reply
        return await refresh_before_reply(db, user, conversation, source_message,
                                          text=message_text, timeout_seconds=timeout_seconds)
    if conversation.platform_code == "qianniu":
        from app.services.qianniu_order_context import refresh_before_reply
        return await refresh_before_reply(db, user, conversation, source_message,
                                          text=message_text, timeout_seconds=timeout_seconds)
    if not _can_refresh_order_context(conversation):
        return {"attempted": False, "reason": "conversation_not_refreshable"}
    previous_observed_at = _order_summary_observed_at(conversation)
    idempotency_key = f"auto-reply-order-refresh:{conversation.id}:{source_message.id}"
    task = db.scalar(select(RpaTask).where(RpaTask.idempotency_key == idempotency_key))
    if task is None:
        task = RpaTask(
            user_id=user.id,
            platform_account_id=conversation.platform_account_id,
            conversation_id=conversation.id,
            task_type="refresh_customer_orders",
            idempotency_key=idempotency_key,
            platform_code=conversation.platform_code,
            payload_json={
                "platform_account_id": conversation.platform_account_id,
                "external_conversation_id": conversation.external_conversation_id,
                "customer_name": conversation.customer_name or "",
                "source": "auto_reply_pre_context",
                "source_message_id": source_message.id,
            },
            status="queued",
            priority=30,
        )
        try:
            db.add(task)
            db.commit()
        except IntegrityError:
            db.rollback()
            task = db.scalar(select(RpaTask).where(RpaTask.idempotency_key == idempotency_key))
    deadline = monotonic() + max(0.1, timeout_seconds)
    while monotonic() < deadline:
        await asyncio.sleep(ORDER_CONTEXT_REFRESH_POLL_SECONDS)
        db.expire_all()
        refreshed = db.get(Conversation, conversation.id)
        if refreshed is not None:
            conversation.metadata_json = refreshed.metadata_json
        observed_at = _order_summary_observed_at(conversation)
        if observed_at and observed_at != previous_observed_at:
            return {
                "attempted": True,
                "status": "collected",
                "task_id": task.id if task else None,
                "observed_at": observed_at,
            }
        if task is not None:
            current_task = db.get(RpaTask, task.id)
            if current_task and current_task.status == "failed":
                return {
                    "attempted": True,
                    "status": "failed",
                    "task_id": current_task.id,
                    "error": current_task.error_message,
                }
    return {
        "attempted": True,
        "status": "timeout",
        "task_id": task.id if task else None,
        "previous_observed_at": previous_observed_at or None,
    }


def _fallback_marks_human_required(robot: Robot | None) -> bool:
    config = _robot_config(robot)
    if "fallback_mark_human_required" in config:
        return config.get("fallback_mark_human_required") is True
    return config.get("fallback_transfer_to_human") is True


def _human_handoff_strategy(robot: Robot | None) -> str:
    value = str(_robot_config(robot).get("human_handoff_strategy") or "").strip()
    return HUMAN_HANDOFF_STRATEGY_TRANSFER if value == HUMAN_HANDOFF_STRATEGY_TRANSFER else "mark_only"


def _transfer_conversation_enabled(robot: Robot | None, conversation: Conversation, *, auto_send_allowed: bool) -> bool:
    external_id = str(conversation.external_conversation_id or "").strip()
    return bool(
        auto_send_allowed
        and _human_handoff_strategy(robot) == HUMAN_HANDOFF_STRATEGY_TRANSFER
        and conversation.platform_code in {"pinduoduo", "qianniu", "douyin"}
        and conversation.platform_account_id
        and external_id
        and not external_id.startswith("name:")
    )


def _transfer_confirm_text(robot: Robot | None) -> str:
    text = str(_robot_config(robot).get("transfer_confirm_text") or "").strip()
    return text or DEFAULT_TRANSFER_CONFIRM_TEXT


def _transfer_ack_text(robot: Robot | None) -> str:
    text = str(_robot_config(robot).get("transfer_ack_text") or "").strip()
    return text or DEFAULT_TRANSFER_ACK_TEXT


def _transfer_cancel_text(robot: Robot | None) -> str:
    text = str(_robot_config(robot).get("transfer_cancel_text") or "").strip()
    return text or DEFAULT_TRANSFER_CANCEL_TEXT


def _auto_transfer_state(conversation: Conversation) -> dict[str, Any]:
    if conversation.platform_code == 'pinduoduo':
        from app.services.pdd_auto_transfer import state
        return state(conversation)
    metadata = conversation.metadata_json if isinstance(conversation.metadata_json, dict) else {}
    state = metadata.get(AUTO_TRANSFER_METADATA_KEY)
    return state if isinstance(state, dict) else {}


def _set_auto_transfer_state(conversation: Conversation, state: dict[str, Any]) -> None:
    metadata = dict(conversation.metadata_json or {})
    metadata[AUTO_TRANSFER_METADATA_KEY] = {
        **state,
        "updated_at": utcnow().isoformat(),
    }
    conversation.metadata_json = metadata


def _clear_auto_transfer_state(conversation: Conversation) -> None:
    metadata = dict(conversation.metadata_json or {})
    metadata.pop(AUTO_TRANSFER_METADATA_KEY, None)
    conversation.metadata_json = metadata


def _customer_confirms_transfer(message: str) -> bool:
    normalized = re.sub(r"[\s，。！？、,.!?~～]+", "", str(message or "")).casefold()
    if not normalized:
        return False
    if _customer_declines_transfer(message):
        return False
    return any(
        normalized == word
        or normalized.startswith(word)
        for word in (
            "是",
            "要",
            "需要",
            "可以",
            "好",
            "好的",
            "行",
            "嗯",
            "转",
            "转吧",
            "帮我转",
            "麻烦转",
            "ok",
            "yes",
        )
    )


def _customer_declines_transfer(message: str) -> bool:
    normalized = re.sub(r"[\s，。！？、,.!?~～]+", "", str(message or "")).casefold()
    if not normalized:
        return False
    return any(word in normalized for word in ("不用", "先不用", "不要", "不需要", "否", "算了"))


def _transfer_prompt_result(
    source_message_id: str,
    *,
    text: str,
    workflow: str,
    next_action: str,
    reason: str,
) -> dict[str, Any]:
    return {
        "decision": "auto_send",
        "text": text,
        "media": [],
        "intent": {
            "intent": "human_handoff",
            "confidence": 1.0,
            "need_customer_reply": workflow == "transfer_confirmation",
            "need_doc_search": False,
            "workflow": workflow,
            "next_action": next_action,
            "reply_route": "human_handoff",
            "direct_reply_text": text,
            "risk_flags": ["human_required", reason],
            "reason": reason,
        },
        "action_plan": {
            "workflow": workflow,
            "next_action": next_action,
            "need_doc_search": False,
            "email_service_required": False,
            "required_actions": ["send_platform_text"],
            "blocked_actions": ["qa_match", "generate_reply"],
        },
        "confidence": 1.0,
        "risk_flags": ["human_required", reason],
        "qa_match": {"matched": False, "status": "skipped", "match_type": workflow},
        "retrieval": [],
        "model_calls": {"intent": "business-rule", "generation": "skipped"},
        "provider": "business-rule",
        "trace_id": f"{workflow}-{source_message_id}",
        "task_ids": [],
    }


def _transfer_suppressed_result(source_message_id: str, status_value: str) -> dict[str, Any]:
    return {
        "decision": "no_reply",
        "text": "",
        "media": [],
        "confidence": 1.0,
        "intent": {
            "intent": "human_handoff",
            "confidence": 1.0,
            "need_customer_reply": False,
            "need_doc_search": False,
            "workflow": "transfer_conversation",
            "next_action": "wait_transfer_completion",
        },
        "action_plan": {
            "workflow": "transfer_conversation",
            "next_action": "wait_transfer_completion",
            "required_actions": [],
            "blocked_actions": ["qa_match", "generate_reply", "send_platform_text"],
        },
        "qa_match": {"matched": False, "status": "skipped", "match_type": "transfer_conversation"},
        "retrieval": [],
        "model_calls": {"intent": "skipped-transfer-state", "generation": "skipped"},
        "provider": "business-rule",
        "trace_id": f"transfer-suppressed-{source_message_id}",
        "transfer_status": status_value,
        "task_ids": [],
    }


def _is_fallback_reply(result: dict[str, Any]) -> bool:
    action_plan = result.get("action_plan")
    return bool(isinstance(action_plan, dict) and action_plan.get("workflow") == "fallback_reply")


def _wants_product_recommendation(result: dict[str, Any]) -> bool:
    intent = result.get("intent") if isinstance(result.get("intent"), dict) else {}
    action_plan = result.get("action_plan") if isinstance(result.get("action_plan"), dict) else {}
    return (
        intent.get("wants_product_recommendation") is True
        or action_plan.get("next_action") == "send_product_recommendation"
    )


def _product_recommendation_query(result: dict[str, Any], fallback: str) -> str:
    intent = result.get("intent") if isinstance(result.get("intent"), dict) else {}
    query = str(intent.get("product_recommendation_query") or "").strip()
    return query or fallback


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


def _product_card_ack_result(
    source_message_id: str,
    text: str,
) -> dict[str, Any]:
    return {
        "decision": "auto_send",
        "text": text,
        "media": [],
        "product_card_ack": True,
        "confidence": 1.0,
        "intent": {
            "intent": "product_card_ack",
            "confidence": 1.0,
            "need_customer_reply": True,
            "need_doc_search": False,
            "workflow": "product_card_ack",
            "next_action": "send_product_card_ack",
        },
        "action_plan": {
            "workflow": "product_card_ack",
            "next_action": "send_product_card_ack",
            "need_doc_search": False,
            "required_actions": ["send_platform_text"],
            "blocked_actions": ["qa_match", "generate_reply", "send_platform_product"],
        },
        "qa_match": {
            "matched": False,
            "status": "skipped",
            "match_type": "product_card_ack",
        },
        "retrieval": [],
        "model_calls": {
            "intent": "skipped-product-card",
            "generation": "skipped",
        },
        "provider": "product-card-rule",
        "trace_id": f"product-card-ack-{source_message_id}",
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
    if conversation.platform_code == 'qianniu':
        db.refresh(conversation)
        from app.services.qianniu_transfer_service import current_operation
        operation = current_operation(db, conversation) or {}
        if transfer_blocked(conversation) or (conversation.human_required
                and operation.get('source') == 'automation' and operation.get('status') == 'failed'):
            result.update(decision='no_reply', suppression_reason='qianniu_transfer')
            return None
    if conversation.platform_code == "douyin":
        db.refresh(conversation)
        db.refresh(robot)
        if conversation.platform_account:
            db.refresh(conversation.platform_account)
        reason = reply_block_reason(db, conversation, source_message, robot, sending=True)
        if reason:
            result.update(decision="no_reply", suppression_reason=reason)
            return None
    prohibited_reason = outbound_reason(db, conversation, str(result.get("text") or ""))
    if conversation.platform_code == 'qianniu':
        prohibited_reason = prohibited_reason or qianniu_outbound_reason(str(result.get('text') or ''))
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
    recommendation = result.get("product_recommendation")
    follow_up_products = (
        recommendation.get("products")
        if isinstance(recommendation, dict) and recommendation.get("enabled") is True
        else []
    )
    if not isinstance(follow_up_products, list):
        follow_up_products = []
    if conversation.platform_code == "douyin":
        image_media = None
        follow_up_products = []
        result["media"] = []
        result["product_recommendation"] = {"enabled": False, "products": []}
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
            quote_message_id=None,
        ),
        follow_up=(
            {"type": "image", "url": str(image_media["url"])}
            if image_media
            else None
        ),
        follow_up_products=follow_up_products,
        idempotency_key=f"auto-reply:{robot.id}:{source_message.id}:text",
        source="automation",
        automation_context={"automation_robot_id": robot.id, "automation_source_message_id": source_message.id}
        if conversation.platform_code == "douyin" else None,
        task_status="waiting_timeout" if should_wait_for_timeout else "queued",
    )
    task = db.get(RpaTask, response.task_id)
    if task is not None:
        task.payload_json = {
            **(task.payload_json or {}),
            "automation_source_message_id": source_message.id,
            "automation_trigger_sequence": source_message.conversation_sequence,
            "follow_up_product_count": len(follow_up_products),
        }
        db.add(task)
        db.commit()
    return response.task_id


def _queue_human_required_notice_task(
    db: Session,
    user: User,
    conversation: Conversation,
    robot: Robot,
    source_message: Message,
    *,
    reason: str,
    idempotency_suffix: str,
    auto_send_allowed: bool,
) -> str | None:
    if not auto_send_allowed:
        return None
    text = _human_required_reply_text(robot, reason).strip()
    if not text:
        return None
    response = create_send_task(
        db,
        user,
        SendMessageRequest(
            conversation_id=conversation.id,
            content=text,
            platform_code=conversation.platform_code,
            quote_message_id=None,
        ),
        idempotency_key=f"auto-human-required:{robot.id}:{source_message.id}:{idempotency_suffix}",
        source="automation",
    )
    return response.task_id


def _queue_sensitive_word_notice_task(
    db: Session,
    user: User,
    conversation: Conversation,
    robot: Robot,
    source_message: Message,
    *,
    auto_send_allowed: bool,
) -> str | None:
    if not auto_send_allowed:
        return None
    text = _sensitive_word_reply_text(robot).strip()
    if not text:
        return None
    response = create_send_task(
        db,
        user,
        SendMessageRequest(
            conversation_id=conversation.id,
            content=text,
            platform_code=conversation.platform_code,
            quote_message_id=None,
        ),
        idempotency_key=f"auto-sensitive-word:{robot.id}:{source_message.id}:text",
        source="automation",
    )
    return response.task_id


def _attach_transfer_after_send(
    db: Session,
    conversation: Conversation,
    robot: Robot,
    source_message: Message,
    task_id: str,
    *,
    reason: str,
) -> None:
    task = db.get(RpaTask, task_id)
    if task is None:
        return
    transfer_payload = {
        "robot_id": robot.id,
        "source_message_id": source_message.id,
        "conversation_id": conversation.id,
        "platform_account_id": conversation.platform_account_id,
        "external_conversation_id": conversation.external_conversation_id,
        "customer_name": conversation.customer_name or "",
        "trans_reason": TRANSFER_REASON_TEXT,
        "trigger_reason": reason,
        "idempotency_key": f"auto-transfer:{robot.id}:{source_message.id}",
    }
    task.payload_json = {
        **(task.payload_json or {}),
        "after_send_transfer_conversation": transfer_payload,
    }
    _set_auto_transfer_state(conversation, {
        "status": "ack_queued",
        "reason": reason,
        "source_message_id": source_message.id,
        "robot_id": robot.id,
        "ack_task_id": task.id,
        "trans_reason": TRANSFER_REASON_TEXT,
    })
    db.add(task)
    db.add(conversation)
    db.commit()


def _queue_transfer_confirmation_task(
    db: Session,
    user: User,
    conversation: Conversation,
    robot: Robot,
    source_message: Message,
    *,
    reason: str,
    word: str | None = None,
) -> dict[str, Any]:
    text = _transfer_confirm_text(robot)
    result = _transfer_prompt_result(
        source_message.id,
        text=text,
        workflow="transfer_confirmation",
        next_action="ask_transfer_confirmation",
        reason=reason,
    )
    response = create_send_task(
        db,
        user,
        SendMessageRequest(
            conversation_id=conversation.id,
            content=text,
            platform_code=conversation.platform_code,
            quote_message_id=None,
        ),
        idempotency_key=f"auto-transfer-confirm:{robot.id}:{source_message.id}:{reason}",
        source="automation",
    )
    _set_auto_transfer_state(conversation, {
        "status": "confirming",
        "reason": reason,
        "word": word,
        "source_message_id": source_message.id,
        "robot_id": robot.id,
        "confirmation_task_id": response.task_id,
        "trans_reason": TRANSFER_REASON_TEXT,
    })
    db.add(conversation)
    db.commit()
    result["task_ids"] = [response.task_id]
    return result


def _queue_transfer_ack_task(
    db: Session,
    user: User,
    conversation: Conversation,
    robot: Robot,
    source_message: Message,
    *,
    reason: str,
) -> dict[str, Any]:
    if conversation.platform_code == 'pinduoduo':
        from app.services.pdd_auto_transfer import queue
        return queue(db, user, conversation, robot, source_message, reason)
    if conversation.platform_code == 'douyin':
        from app.services.douyin_auto_transfer import queue
        return queue(db, user, conversation, robot, source_message, reason)
    if conversation.platform_code == 'qianniu':
        from app.services.qianniu_auto_transfer import queue
        return queue(db, user, conversation, robot, source_message, reason)
    text = _transfer_ack_text(robot)
    result = _transfer_prompt_result(
        source_message.id,
        text=text,
        workflow="transfer_ack",
        next_action="send_transfer_ack",
        reason=reason,
    )
    response = create_send_task(
        db,
        user,
        SendMessageRequest(
            conversation_id=conversation.id,
            content=text,
            platform_code=conversation.platform_code,
            quote_message_id=None,
        ),
        idempotency_key=f"auto-transfer-ack:{robot.id}:{source_message.id}",
        source="automation",
    )
    _attach_transfer_after_send(
        db,
        conversation,
        robot,
        source_message,
        response.task_id,
        reason=reason,
    )
    result["task_ids"] = [response.task_id]
    return result


async def _queue_transfer_cancel_task(
    db: Session,
    user: User,
    conversation: Conversation,
    robot: Robot,
    source_message: Message,
    *,
    reason: str,
    auto_send_allowed: bool,
    timeout_deadline: asyncio.Event | None = None,
    ordering_lock: asyncio.Lock | None = None,
) -> dict[str, Any]:
    _clear_auto_transfer_state(conversation)
    db.add(conversation)
    db.commit()
    result = _transfer_prompt_result(
        source_message.id,
        text=_transfer_cancel_text(robot),
        workflow="transfer_cancel",
        next_action="cancel_transfer_confirmation",
        reason=reason,
    )
    task_id = await _queue_reply_task_ordered(
        db,
        user,
        conversation,
        robot,
        source_message,
        result,
        auto_send_allowed=auto_send_allowed,
        timeout_deadline=timeout_deadline,
        ordering_lock=ordering_lock,
    )
    result["task_ids"] = [task_id] if task_id else []
    return result


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
        if transfer_blocked(conversation):
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


def _product_context_data(message: Message) -> list[dict[str, str]]:
    if (getattr(message, "platform_code", None) not in {"douyin", "qianniu"}
            or message.sender_role not in {"customer", "agent"}
            or getattr(message, "message_status", "sent") == "failed"):
        return []
    payload = message.raw_payload if isinstance(message.raw_payload, dict) else {}
    if payload.get("message_type") in {"system", "unknown"}:
        return []
    structured = payload.get("structured_payload")
    structured = structured if isinstance(structured, dict) else {}
    parts = structured.get("parts")
    if message.platform_code == "qianniu" and isinstance(parts, list):
        products = [part for part in parts[:32] if isinstance(part, dict) and part.get("kind") == "product"]
    else:
        products = [structured] if payload.get("message_type") == "product" else []
    # Only product background belongs in the prompt, never image signatures,
    # platform identities or executable card fields. Keep each mixed-message card.
    return [{key: value[:512] for key in ("title", "product_id", "price_label")
             if isinstance(value := product.get(key), str) and value.strip()} for product in products]


def _message_history(
    rows: list[Message],
    *,
    exclude_message_ids: set[str] | None = None,
) -> list[dict[str, str]]:
    excluded = exclude_message_ids or set()
    return [
        {
            "role": "user" if item.sender_role == "customer" else "assistant",
            "content": item.content,
        }
        for item in reversed(rows)
        if (
            getattr(item, "id", None) not in excluded
            and
            getattr(item, "message_status", "sent") != "failed"
            and not (getattr(item, 'platform_code', None) in {'douyin', 'qianniu', 'pinduoduo'}
                     and getattr(item, 'message_status', 'sent') in {'queued', 'cancelled', 'confirmation_pending'})
            and item.sender_role in {"customer", "agent", "assistant", "bot"}
            and not (
                getattr(item, "platform_code", None) == "qianniu"
                and isinstance(getattr(item, "raw_payload", None), dict)
                and (item.raw_payload or {}).get("message_type") == "unknown"
            )
            and ((getattr(item, "raw_payload", {}) or {}).get("automation_mode", "trigger") == "trigger"
                 or (getattr(item, 'platform_code', None) == 'douyin'
                     and (getattr(item, 'raw_payload', {}) or {}).get('message_type') == 'text')
                 or bool(_product_context_data(item)) or bool(douyin_message_context(item))
                 or bool(_qianniu_image_context(item)) or bool(pdd_message_context(item))
                 or (getattr(item, 'platform_code', None) in {'qianniu', 'pinduoduo'}
                     and item.sender_role in {'agent', 'assistant', 'bot'}
                     and (getattr(item, 'raw_payload', {}) or {}).get('message_type', 'text') == 'text'))
            and item.content.strip()
        )
    ]


def _bounded_untrusted_context(value: Any, budget: list[int], depth: int = 0) -> Any:
    if budget[0] <= 0 or depth > 9:
        return None
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, str):
        clipped = value[:min(256, budget[0])]
        budget[0] -= len(clipped)
        return clipped
    if isinstance(value, list):
        return [_bounded_untrusted_context(item, budget, depth + 1)
                for item in value[:12] if budget[0] > 0]
    if isinstance(value, dict):
        result: dict[str, Any] = {}
        for raw_key, item in list(value.items())[:24]:
            key = str(raw_key)[:64]
            if not key or budget[0] <= 0:
                break
            budget[0] -= len(key)
            result[key] = _bounded_untrusted_context(item, budget, depth + 1)
        return result
    return str(value)[:min(128, budget[0])]


def _qianniu_image_context(message: Message) -> dict[str, Any] | None:
    if getattr(message, 'platform_code', None) != 'qianniu' or message.sender_role != 'customer':
        return None
    payload = message.raw_payload if isinstance(message.raw_payload, dict) else {}
    structured = payload.get('structured_payload') or {}
    parts = structured.get('parts') if isinstance(structured, dict) else None
    if (payload.get('message_type') != 'image' and not payload.get('image_url')
            and not (isinstance(parts, list) and any(isinstance(p, dict) and p.get('kind') == 'image' for p in parts))):
        return None
    return {'type': 'qianniu_unread_image', 'sender_role': 'customer',
            'message_id': getattr(message, 'id', None), 'content': '[图片，未识图]',
            'data': {'vision_available': False, 'untrusted': True}}


def _unsupported_qianniu_context(message: Message) -> dict[str, Any] | None:
    if getattr(message, "platform_code", None) != "qianniu" or message.sender_role != "customer":
        return None
    raw_payload = message.raw_payload if isinstance(message.raw_payload, dict) else {}
    if raw_payload.get("context_eligible") is not True or raw_payload.get("message_type") != "unknown":
        return None
    raw = raw_payload.get("qianniu_raw")
    if not isinstance(raw, dict):
        return None
    return {
        "type": "unsupported_qianniu_message",
        "content": message.content,
        "sender_role": "customer",
        "data": {
            "untrusted": True,
            **(_bounded_untrusted_context(raw, [3072]) or {}),
        },
    }


def _customer_trigger_batch_tail(db: Session, source_message: Message) -> list[Message]:
    if source_message.collection_kind != "incremental" or not source_message.first_observation_id:
        return [source_message]
    batch_tail = db.scalars(
        select(Message).where(
            Message.conversation_id == source_message.conversation_id,
            Message.first_observation_id == source_message.first_observation_id,
            Message.conversation_sequence <= source_message.conversation_sequence,
            Message.message_status != "failed",
        ).order_by(desc(Message.conversation_sequence))
    ).all()
    messages: list[Message] = []
    for item in batch_tail:
        automation_mode = (item.raw_payload or {}).get("automation_mode", "trigger")
        if automation_mode != "trigger":
            continue
        if item.sender_role != "customer":
            break
        messages.append(item)
    return list(reversed(messages)) or [source_message]


def _message_type(message: Message) -> str:
    raw_payload = message.raw_payload if isinstance(message.raw_payload, dict) else {}
    message_type = str(raw_payload.get("message_type") or raw_payload.get("media_type") or "").strip()
    if getattr(message, "platform_code", None) == "qianniu" and message_type in {"text", "product"}:
        structured = raw_payload.get("structured_payload")
        parts = structured.get("parts") if isinstance(structured, dict) else None
        if (isinstance(parts, list) and parts
                and all(isinstance(part, dict) and part.get("kind") == "product" for part in parts)):
            return "product"
    if message_type == "image" or raw_payload.get("image_url"):
        return "image"
    return message_type or "text"


def _unsupported_reply_reason(message: Message) -> str | None:
    if pdd_message_context(message) or douyin_message_context(message):
        return None
    if is_transfer_reply_source(message):
        return None
    message_type = _message_type(message)
    if getattr(message, "platform_code", None) == "qianniu" and message_type in {"unknown", "image"}:
        return None
    if message_type in AUTO_REPLY_MESSAGE_TYPES:
        return None
    if message_type == "image":
        return "image_message"
    return "unsupported_message"


def _snapshot_customer_batch_size(db: Session, source_message: Message) -> int:
    return len(_customer_trigger_batch_tail(db, source_message))


def _current_customer_message(batch_messages: list[Message]) -> str:
    if len(batch_messages) == 1 and is_transfer_reply_source(batch_messages[0]):
        return transfer_prompt(batch_messages[0])
    usable = [item.content.strip() for item in batch_messages if item.content.strip()]
    if len(usable) <= 1:
        return usable[0] if usable else ""
    lines = [
        f"客户本次连续发送了 {len(usable)} 条消息，请在一条回复中同时回答，不要遗漏：",
    ]
    lines.extend(f"{index}. {content}" for index, content in enumerate(usable, start=1))
    return "\n".join(lines)


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
        pdd_context = pdd_message_context(item)
        if pdd_context:
            items.append(pdd_context)
            continue
        image_context = _qianniu_image_context(item)
        if image_context:
            items.append(image_context)
            if _message_type(item) == 'image':
                continue
        douyin_context = douyin_message_context(item)
        if douyin_context:
            items.append(douyin_context)
            continue
        unsupported = _unsupported_qianniu_context(item)
        if unsupported:
            items.append(unsupported)
            continue
        products = _product_context_data(item)
        if products:
            for product in products:
                items.append({"type": "product", "content": item.content,
                              "sender_role": item.sender_role, "data": product})
            continue
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
    shop_product_summary: dict[str, str] | None = None,
    platform_rule_scene: dict[str, Any] | None = None,
    product_details: list[dict[str, Any]] | None = None,
    product_card_only: bool = False,
    product_link_candidates: list[dict[str, str]] | None = None,
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
        "product_details": product_details or [],
        "product_card_only": product_card_only,
        "product_link_candidates": product_link_candidates or [],
        "shop_product_summary": shop_product_summary or {},
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
            "platform_rule_scene": platform_rule_scene or {},
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
    batch_messages = _customer_trigger_batch_tail(db, source_message)
    unsupported_matches = [
        (item, reason)
        for item in batch_messages
        for reason in [_unsupported_reply_reason(item)]
        if reason
    ]
    unsupported_ids = {item.id for item, _ in unsupported_matches}
    sensitive_matches = [
        (item, matched)
        for item in batch_messages
        for matched in [_matched_sensitive_word(robot, item.content)]
        if item.id not in unsupported_ids and matched
    ]
    sensitive_ids = {item.id for item, _ in sensitive_matches}
    reply_batch_messages = [
        item for item in batch_messages
        if item.id not in unsupported_ids and item.id not in sensitive_ids
    ]
    is_product_card_only_batch = bool(reply_batch_messages) and all(
        _message_type(item) == "product" for item in reply_batch_messages
    ) and not unsupported_matches and not sensitive_matches
    pending_human_required: tuple[str, str | None] | None = None
    if sensitive_matches:
        pending_human_required = ("sensitive_word", sensitive_matches[0][1])
    elif unsupported_matches:
        pending_human_required = (unsupported_matches[0][1], None)

    detail_refresh = {"attempted": False, "product_ids": []}
    product_details = []
    if conversation.platform_code in {"qianniu", "douyin"} and reply_batch_messages and not pending_human_required:
        if conversation.platform_code == "douyin":
            from app.services.douyin_product_detail_service import ensure_details, prompt_details
        else:
            from app.services.qianniu_product_detail_service import ensure_details, prompt_details
        try:
            detail_refresh = await ensure_details(db, user, conversation, source_message,
                enabled=_auto_send_allowed(robot, requested=request.allow_auto_send))
            product_details = prompt_details(db, conversation, detail_refresh["product_ids"],
                _current_customer_message(reply_batch_messages))
        except Exception as exc:
            logger.warning("Product detail unavailable platform=%s error_type=%s", conversation.platform_code, type(exc).__name__)
            db.rollback()

    if is_product_card_only_batch and not product_details:
        result = _product_card_ack_result(
            source_message.id,
            _product_card_ack_text(robot),
        )
        result['product_detail_refresh'] = detail_refresh
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
        logger.info(
            "product card only message acknowledged conversation_id=%s robot_id=%s "
            "source_message_id=%s task_id=%s",
            conversation.id,
            robot.id,
            source_message.id,
            task_id,
        )
        return result

    message = _current_customer_message(reply_batch_messages)
    auto_send_allowed = _auto_send_allowed(robot, requested=request.allow_auto_send)
    pre_reply_task_ids: list[str] = []
    transfer_state = _auto_transfer_state(conversation)
    transfer_status = str(transfer_state.get("status") or "")
    if conversation.platform_code != 'qianniu' and transfer_status in {"preparing", "ack_queued", "ready", "transferring", "transferred", "confirmation_pending"}:
        return _transfer_suppressed_result(source_message.id, transfer_status)
    if (
        transfer_status == "confirming"
        and _transfer_conversation_enabled(robot, conversation, auto_send_allowed=auto_send_allowed)
    ):
        if _customer_confirms_transfer(source_message.content):
            return _queue_transfer_ack_task(
                db,
                user,
                conversation,
                robot,
                source_message,
                reason=str(transfer_state.get("reason") or "transfer_confirmation"),
            )
        if _customer_declines_transfer(source_message.content):
            return await _queue_transfer_cancel_task(
                db,
                user,
                conversation,
                robot,
                source_message,
                reason=str(transfer_state.get("reason") or "transfer_confirmation"),
                auto_send_allowed=auto_send_allowed,
                timeout_deadline=timeout_deadline,
                ordering_lock=timeout_ordering_lock,
            )
        _clear_auto_transfer_state(conversation)
        db.add(conversation)
        db.commit()

    if sensitive_matches and not reply_batch_messages:
        if _transfer_conversation_enabled(robot, conversation, auto_send_allowed=auto_send_allowed):
            return _queue_transfer_ack_task(
                db,
                user,
                conversation,
                robot,
                sensitive_matches[0][0],
                reason="sensitive_word",
            )
        result = _sensitive_word_result(
            source_message.id,
            sensitive_matches[0][1],
            _sensitive_word_reply_text(robot),
        )
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
        _mark_human_required(
            conversation,
            reason="sensitive_word",
            word=sensitive_matches[0][1],
        )
        _mark_reply_run_human_required(result, reason="sensitive_word")
        db.add(conversation)
        db.commit()
        logger.info(
            "automation reply blocked by sensitive word conversation_id=%s robot_id=%s word=%s",
            conversation.id,
            robot.id,
            sensitive_matches[0][1],
        )
        result["task_ids"] = [task_id] if task_id else []
        return result

    if not reply_batch_messages:
        reason, word = pending_human_required or ("unsupported_message", None)
        if _transfer_conversation_enabled(robot, conversation, auto_send_allowed=auto_send_allowed):
            return _queue_transfer_ack_task(
                db,
                user,
                conversation,
                robot,
                unsupported_matches[0][0] if unsupported_matches else source_message,
                reason=reason,
            )
        _mark_human_required(conversation, reason=reason, word=word)
        notice_task_id = _queue_human_required_notice_task(
            db,
            user,
            conversation,
            robot,
            unsupported_matches[0][0] if unsupported_matches else source_message,
            reason=reason,
            idempotency_suffix=reason,
            auto_send_allowed=auto_send_allowed,
        )
        result = {
            "decision": "no_reply",
            "text": "",
            "media": [],
            "confidence": 1.0,
            "intent": {
                "intent": "human_handoff",
                "confidence": 1.0,
                "need_customer_reply": False,
                "need_doc_search": False,
                "workflow": reason,
                "next_action": "mark_needs_human",
            },
            "qa_match": None,
            "retrieval": [],
            "model_calls": {
                "intent": "skipped-unsupported-message",
                "generation": "skipped",
            },
            "provider": "business-rule",
            "trace_id": f"{reason}-{source_message.id}",
            "task_ids": [notice_task_id] if notice_task_id else [],
        }
        _mark_reply_run_human_required(result, reason=reason)
        db.add(conversation)
        db.commit()
        return result

    if not message.strip():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No customer message available")

    if pending_human_required is not None:
        reason, word = pending_human_required
        if _transfer_conversation_enabled(robot, conversation, auto_send_allowed=auto_send_allowed):
            return _queue_transfer_ack_task(
                db,
                user,
                conversation,
                robot,
                sensitive_matches[0][0] if sensitive_matches else unsupported_matches[0][0],
                reason=reason,
            )
        _mark_human_required(conversation, reason=reason, word=word)
        db.add(conversation)
        db.commit()
        if sensitive_matches:
            notice_task_id = _queue_sensitive_word_notice_task(
                db,
                user,
                conversation,
                robot,
                sensitive_matches[0][0],
                auto_send_allowed=auto_send_allowed,
            )
            if notice_task_id:
                pre_reply_task_ids.append(notice_task_id)
        elif unsupported_matches:
            notice_task_id = _queue_human_required_notice_task(
                db,
                user,
                conversation,
                robot,
                unsupported_matches[0][0],
                reason=reason,
                idempotency_suffix=reason,
                auto_send_allowed=auto_send_allowed,
            )
            if notice_task_id:
                pre_reply_task_ids.append(notice_task_id)

    context_length = max(
        _context_length(robot),
        len(reply_batch_messages or batch_messages) - 1,
    )
    excluded_batch_ids = {item.id for item in batch_messages if item.id}
    history_rows = list(
        db.scalars(
            select(Message)
            .where(
                Message.conversation_id == conversation.id,
                Message.conversation_sequence <= source_message.conversation_sequence,
                (Message.message_status.notin_(["failed", "cancelled", "queued", "confirmation_pending"])
                 if conversation.platform_code in {'douyin', 'qianniu', 'pinduoduo'} else Message.message_status != 'failed'),
            )
            .order_by(desc(Message.conversation_sequence))
            # The source message is part of the query, while context_length
            # represents prior messages. Fetch one extra row for the source.
            .limit(max(context_length * 3 + 10, context_length + 1))
        ).all()
    )
    history = _history_with_latest(
        _message_history(history_rows, exclude_message_ids=excluded_batch_ids),
        message,
        context_length,
    )
    settings = get_settings()
    ai_config = db.query(AiProviderConfig).filter(AiProviderConfig.user_id == user.id).first()
    email_template_rows = enabled_templates(db, user) if conversation.platform_code != "douyin" else []
    email_config = get_config(db, user)
    order_context_refresh = await _refresh_order_context_before_reply(
        db,
        user,
        conversation,
        source_message,
        enabled=auto_send_allowed,
        message_text=message,
    )
    customer_orders = order_prompt_context(db, conversation)
    if conversation.platform_code in {"qianniu", "douyin"} and order_context_refresh.get("current_state_unverified"):
        customer_orders = {**customer_orders, "dynamic_fields_fresh": False, "current_state_unverified": True}
    platform_context = _platform_context(history_rows)
    account_metadata = (
        conversation.platform_account.metadata_json
        if conversation.platform_account is not None
        and isinstance(conversation.platform_account.metadata_json, dict)
        else {}
    )
    shop_summary = account_metadata.get("shop_summary") if isinstance(account_metadata, dict) else {}
    shop_product_summary = shop_summary if isinstance(shop_summary, dict) else {}
    email_workflow_config = {
        "ask_email_text": email_config.ask_email_text,
        "success_text": email_config.success_text,
        "missing_template_text": email_config.missing_template_text,
    }
    workflow = active_workflow(db, user, conversation, robot) if conversation.platform_code != "douyin" else None
    workflow_result = None
    if conversation.platform_code == "qianniu" and workflow is not None:
        if email_unavailable(message):
            workflow_result = email_unavailable_result(db, workflow)
        elif not extract_email(message):
            # A pending email collection must not capture later product questions or
            # image/custom-order intents. A new explicit request can start a new flow.
            cancel_email_workflow(db, workflow, status="cancelled_interrupted")
            workflow = None
    platform_rule_scene = (
        None
        if workflow is not None or not auto_send_allowed
        else _detect_pdd_custom_order_scene(
            db,
            conversation,
            robot,
            source_message,
            history_rows,
        )
    )
    logger.info(
        "automation reply started conversation_id=%s robot_id=%s prompt_message_count=%d "
        "history_limit=%d auto_send_allowed=%s",
        conversation.id,
        robot.id,
        len(history),
        context_length,
        auto_send_allowed,
    )
    if workflow_result is not None:
        result = workflow_result
    elif workflow is not None:
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
        link_candidates = reply_candidates(db, conversation, message) if (
            conversation.platform_code == 'qianniu' and not is_product_card_only_batch
            and not pending_human_required and source_message.sender_role == 'customer'
            and _message_type(source_message) == 'text'
        ) else []
        result = await _decide_reply(
            settings=settings, user=user, message=message, history=history,
            platform=conversation.platform_code,
            shop_name=conversation_shop_name(conversation),
            customer_name=conversation.customer_name or "", robot=robot,
            robot_read=robot_read, ai_config=ai_config,
            auto_send_allowed=auto_send_allowed,
            email_templates=template_metadata(email_template_rows),
            email_config=email_config,
            customer_orders=customer_orders,
            platform_context=platform_context,
            platform_rule_scene=platform_rule_scene,
            product_details=product_details,
            product_card_only=is_product_card_only_batch,
            product_link_candidates=link_candidates,
            shop_product_summary={
                "shop_intro": str(shop_product_summary.get("shop_intro") or ""),
                "on_sale_products": str(shop_product_summary.get("on_sale_products") or ""),
            },
        )
        result["reply_generation_duration_ms"] = max(
            0, round((monotonic() - generation_started) * 1000)
        )
        append_reply_links(db, conversation, result, link_candidates)
        intent = result.get("intent") if isinstance(result.get("intent"), dict) else {}
        action_plan = result.get("action_plan") if isinstance(result.get("action_plan"), dict) else {}
        if intent.get("intent") == "email_link_request" or action_plan.get("workflow") == "collect_email_for_link":
            suggested_template_id = str(intent.get("template_id") or intent.get("template_key") or "")
            if auto_send_allowed and conversation.platform_code != "douyin":
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

    result["order_context_refresh"] = order_context_refresh
    result["product_detail_refresh"] = detail_refresh
    if platform_rule_scene is not None:
        result["platform_rule_scene"] = platform_rule_scene
        _mark_pdd_custom_order_scene_applied(
            db,
            conversation,
            robot,
            source_message,
            platform_rule_scene,
            result,
        )
    if conversation.platform_code == 'pinduoduo':
        db.refresh(conversation)
        from app.services.pdd_auto_transfer import reply_blocked as pdd_blocked
        if pdd_blocked(conversation):
            return {'decision': 'no_reply', 'text': '', 'task_ids': [], 'suppression_reason': 'pdd_transfer_or_human'}
    product_recommend_enabled, product_recommend_text = _product_recommendation_config(robot)
    qa_match = result.get("qa_match") if isinstance(result.get("qa_match"), dict) else {}
    should_recommend_products = (
        auto_send_allowed
        and conversation.platform_code not in {"douyin", "qianniu"}
        and product_recommend_enabled
        and _wants_product_recommendation(result)
        and not bool(result.get("product_card_ack"))
        and not bool(qa_match.get("matched"))
        and result.get("decision") == "auto_send"
        and bool(str(result.get("text") or "").strip())
    )
    if should_recommend_products:
        matched_products = match_store_products(
            db,
            conversation,
            _product_recommendation_query(result, message),
            limit=2,
        )
        if matched_products:
            if product_recommend_text:
                result["text"] = product_recommend_text
            result["action_plan"] = {
                **(result.get("action_plan") if isinstance(result.get("action_plan"), dict) else {}),
                "workflow": "product_recommendation",
                "next_action": "send_product_recommendation",
            }
            result["product_recommendation"] = {
                "enabled": True,
                "text": product_recommend_text,
                "products": matched_products,
            }
    elif not isinstance(result.get("product_recommendation"), dict):
        result["product_recommendation"] = {
            "enabled": False,
            "text": product_recommend_text,
            "products": [],
        }
    if pending_human_required is not None:
        reason, _ = pending_human_required
        _mark_reply_run_human_required(result, reason=reason)

    result_risks = result.get("risk_flags") if isinstance(result.get("risk_flags"), list) else []
    if "email_send_failed" in result_risks:
        reason = "email_send_failed"
        if _transfer_conversation_enabled(robot, conversation, auto_send_allowed=auto_send_allowed):
            transfer_result = _queue_transfer_ack_task(
                db,
                user,
                conversation,
                robot,
                source_message,
                reason=reason,
            )
            transfer_result["order_context_refresh"] = order_context_refresh
            transfer_result["product_detail_refresh"] = detail_refresh
            return transfer_result
        result.update(decision="needs_human", text="", media=[])
        _mark_human_required(conversation, reason=reason)
        _mark_reply_run_human_required(result, reason=reason)
        db.add(conversation)
        db.commit()
        return result

    if (
        _is_fallback_reply(result)
        and _transfer_conversation_enabled(robot, conversation, auto_send_allowed=auto_send_allowed)
        and (
            conversation.platform_code in {"qianniu", "douyin", "pinduoduo"}
            or _fallback_marks_human_required(robot)
        )
    ):
        transfer_result = _queue_transfer_ack_task(
            db,
            user,
            conversation,
            robot,
            source_message,
            reason="fallback_reply",
        )
        transfer_result["order_context_refresh"] = order_context_refresh
        return transfer_result

    if conversation.platform_code in {'qianniu', 'douyin', 'pinduoduo'}:
        blocked = (qianniu_outbound_reason(str(result.get('text') or '')) if conversation.platform_code == 'qianniu'
                   else outbound_reason(db, conversation, str(result.get('text') or '')) if conversation.platform_code == 'douyin' else None)
        human = (result.get('action_plan') or {}).get('workflow') == 'human_review' or result.get('decision') == 'needs_human'
        if human or blocked:
            reason = blocked or (result.get('intent') or {}).get('reason') or 'human_handoff'
            if _transfer_conversation_enabled(robot, conversation, auto_send_allowed=auto_send_allowed):
                transfer_result = _queue_transfer_ack_task(db, user, conversation, robot, source_message, reason=reason)
                if conversation.platform_code == 'douyin':
                    return {**result, **transfer_result, 'order_context_refresh': order_context_refresh,
                            'product_detail_refresh': detail_refresh}
                return transfer_result
            result.update(decision='needs_human', text='', media=[])
            _mark_human_required(conversation, reason=reason)
            db.commit()
    task_ids: list[str] = [*pre_reply_task_ids]
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
        if action_plan.get("next_action") == "ask_email" and result.get("workflow_id"):
            prompt_task = db.get(RpaTask, task_id)
            if prompt_task is not None:
                bind_email_prompt_task(db, str(result["workflow_id"]), prompt_task)
        if action_plan.get("workflow") == "human_review":
            result_risks = result.get("risk_flags") if isinstance(result.get("risk_flags"), list) else []
            reason = "missing_email_template" if "missing_bound_email_template" in result_risks else "human_handoff"
            if (
                reason == "human_handoff"
                and _transfer_conversation_enabled(robot, conversation, auto_send_allowed=auto_send_allowed)
            ):
                _attach_transfer_after_send(
                    db,
                    conversation,
                    robot,
                    source_message,
                    task_id,
                    reason=reason,
                )
                result["transfer_conversation_after_send"] = True
            else:
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
    outreach = (
        maybe_create_order_follow_up(db, conversation, robot, source_message, result)
        if conversation.platform_code != "douyin" else None
    )
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
    if source_message.sender_role != "customer" and not is_transfer_reply_source(source_message):
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

    if conversation.platform_code == 'pinduoduo':
        from app.services.pdd_auto_transfer import reply_blocked as pdd_blocked
        if pdd_blocked(conversation):
            return {'decision': 'no_reply', 'text': '', 'task_ids': [], 'suppression_reason': 'pdd_transfer_or_human'}
    robot = _active_robot(db, user, conversation)
    if not robot:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="No online robot is assigned to this platform account",
        )
    if conversation.platform_code == 'qianniu':
        from app.services.qianniu_transfer_service import current_operation
        operation = current_operation(db, conversation) or {}
        if transfer_blocked(conversation) or (conversation.human_required
                and operation.get('source') == 'automation' and operation.get('status') in {'failed', 'unavailable'}):
            return {'decision': 'no_reply', 'text': '', 'task_ids': [], 'suppression_reason': 'qianniu_transfer'}
    if conversation.platform_code == "douyin":
        reason = reply_block_reason(db, conversation, source_message, robot)
        if reason:
            return {"decision": "no_reply", "text": "", "task_ids": [], "suppression_reason": reason,
                    "confidence": 1.0, "provider": "business-rule", "trace_id": f"douyin-skipped-{source_message.id}"}
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
        failed_conversation = db.get(Conversation, conversation.id)
        if failed_conversation:
            _mark_human_required(failed_conversation, reason="auto_reply_failed")
            db.add(failed_conversation)
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
            if send_task and conversation.platform_code == "douyin" and result.get("human_required_marked"):
                send_task.payload_json = {**(send_task.payload_json or {}),
                    "automation_human_required_at": conversation.human_required_at.isoformat()
                    if conversation.human_required_at else None}
        persisted_run.completed_at = utcnow()
        db.commit()
        reply_message = (
            db.get(Message, persisted_run.reply_message_id)
            if persisted_run.reply_message_id
            else None
        )
        follow_up_message = None
        follow_up_messages: list[Message] = []
        if task_id:
            send_task = db.get(RpaTask, task_id)
            task_payload = send_task.payload_json if send_task and isinstance(send_task.payload_json, dict) else {}
            follow_up_message_id = str(task_payload.get("follow_up_message_id") or "")
            follow_up_message = db.get(Message, follow_up_message_id) if follow_up_message_id else None
            follow_up_message_ids = task_payload.get("follow_up_message_ids")
            if isinstance(follow_up_message_ids, list):
                follow_up_messages = [
                    item for item in (db.get(Message, str(message_id)) for message_id in follow_up_message_ids)
                    if item is not None and item.conversation_id == conversation.id
                ]
            elif follow_up_message is not None:
                follow_up_messages = [follow_up_message]

        await realtime_manager.broadcast(
            user.id,
            {
                "type": "automation.reply.completed",
                "reply_run_id": persisted_run.id,
                "conversation_id": conversation.id,
                "message": MessageRead.model_validate(reply_message).model_dump(mode="json")
                if reply_message
                else None,
                "follow_up_message": MessageRead.model_validate(follow_up_message).model_dump(mode="json")
                if follow_up_message
                else None,
                "follow_up_messages": [
                    MessageRead.model_validate(item).model_dump(mode="json")
                    for item in follow_up_messages
                ],
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
        shop_product_summary={"shop_intro": "", "on_sale_products": ""},
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


def schedule_debounced_inbound_reply(
    user_id: str,
    conversation_id: str,
    source_message_id: str,
    source_event_id: str | None = None,
    *,
    delay_seconds: float = INBOUND_REPLY_DEBOUNCE_SECONDS,
) -> None:
    key = (user_id, conversation_id)
    previous = _pending_inbound_reply_tasks.get(key)
    if previous and not previous.done():
        previous.cancel()

    async def run_later() -> None:
        try:
            await asyncio.sleep(delay_seconds)
            if _pending_inbound_reply_tasks.get(key) is task:
                _pending_inbound_reply_tasks.pop(key, None)
            await process_inbound_reply(
                user_id,
                conversation_id,
                source_message_id,
                source_event_id,
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception(
                "debounced inbound reply failed user_id=%s conversation_id=%s source_message_id=%s",
                user_id,
                conversation_id,
                source_message_id,
            )
        finally:
            if _pending_inbound_reply_tasks.get(key) is task:
                _pending_inbound_reply_tasks.pop(key, None)

    task = asyncio.create_task(run_later())
    _pending_inbound_reply_tasks[key] = task


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
        if transfer_blocked(conversation):
            return None
        robot = _active_robot(db, user, conversation)
        if not robot:
            return None
        timeout_task: asyncio.Task[str | None] | None = None
        timeout_deadline: asyncio.Event | None = None
        timeout_ordering_lock: asyncio.Lock | None = None
        timeout_enabled, timeout_seconds, timeout_text = _timeout_config(robot)
        if conversation.platform_code != "douyin" and _auto_send_allowed(robot, requested=True) and timeout_enabled and timeout_text:
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
