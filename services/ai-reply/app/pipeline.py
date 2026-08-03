from __future__ import annotations

import json
import logging
import re
import uuid
from typing import Any

from pydantic import ValidationError

from app.core.config import get_settings
from app.knowledge_client import get_knowledge_base, match_qa, search_documents
from app.provider import generate_with_provider
from app.schemas import ActionPlan, IntentDecision, ReplyRequest, ReplyResponse


RISK_WORDS = ("退款", "退货", "投诉", "赔偿", "隐私", "地址", "手机号", "转人工")
EMAIL_WORDS = ("邮箱", "邮件", "链接", "地址", "网址", "看图", "下载", "资料")
NO_REPLY_WORDS = ("不用了", "不需要了", "谢谢", "好的", "知道了")
HUMAN_WORDS = ("转人工", "人工客服", "投诉", "举报")
logger = logging.getLogger(__name__)


def _email_template_prompt_items(request: ReplyRequest) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for item in request.email_templates:
        template_id = clean_reply(str(item.get("id") or ""))
        template_key = clean_reply(str(item.get("template_key") or ""))
        name = clean_reply(str(item.get("name") or ""))
        scene = clean_reply(str(item.get("scene") or ""))
        aliases = [
            clean_reply(str(alias))
            for alias in item.get("aliases", [])
            if clean_reply(str(alias))
        ][:10]
        if not template_id and not template_key:
            continue
        items.append(
            {
                "id": template_id,
                "template_key": template_key,
                "name": name,
                "scene": scene,
                "aliases": aliases,
            }
        )
    return items[:50]


def clean_reply(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def conversation_prompt(request: ReplyRequest) -> str:
    messages: list[tuple[str, str]] = []
    for item in request.conversation:
        role = str(item.get("role") or "")
        content = clean_reply(str(item.get("content") or ""))
        if role not in {"user", "assistant"} or not content:
            continue
        messages.append((role, content))
    latest = clean_reply(request.message)
    if not messages or messages[-1] != ("user", latest):
        messages.append(("user", latest))
    return "\n".join(
        f"{'客户' if role == 'user' else '客服'}：{content}"
        for role, content in messages
    )


def _extract_json(value: str) -> dict[str, Any]:
    text = value.strip()
    fenced = re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", text, flags=re.DOTALL | re.IGNORECASE)
    if fenced:
        text = fenced.group(1)
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        start, end = text.find("{"), text.rfind("}")
        if start < 0 or end <= start:
            raise
        parsed = json.loads(text[start : end + 1])
    if not isinstance(parsed, dict):
        raise ValueError("intent response must be a JSON object")
    return parsed


def _local_intent(message: str, risk_flags: list[str], reason: str) -> IntentDecision:
    if any(word in message for word in HUMAN_WORDS):
        intent = "human_handoff"
        next_action = "mark_needs_human"
        confidence = 0.9
    elif any(word in message for word in EMAIL_WORDS):
        intent = "email_link_request"
        next_action = "defer_email_workflow"
        confidence = 0.72
    elif any(word in message for word in NO_REPLY_WORDS) and len(message) <= 20:
        intent = "no_reply_needed"
        next_action = "finish_without_reply"
        confidence = 0.75
    else:
        intent = "normal_question"
        next_action = "generate_reply"
        confidence = 0.65
    return IntentDecision(
        intent=intent,
        confidence=confidence,
        need_customer_reply=intent not in {"no_reply_needed", "human_handoff"},
        need_doc_search=intent == "normal_question",
        need_email=intent == "email_link_request",
        workflow="collect_email_for_link" if intent == "email_link_request" else "answer_question",
        next_action=next_action,
        missing_slots=["email"] if intent == "email_link_request" else [],
        risk_flags=risk_flags,
        reason=reason,
    )


async def classify_intent(
    request: ReplyRequest,
    trace_id: str,
    risk_flags: list[str],
) -> tuple[IntentDecision, str]:
    system = """你是电商客服意图路由器，只判断意图，不生成客服回复。
必须只返回一个 JSON 对象，字段如下：
intent: normal_question | email_link_request | no_reply_needed | human_handoff | unknown
confidence: 0 到 1
need_customer_reply: boolean
need_doc_search: boolean，仅 normal_question 可为 true
need_email: boolean，仅 email_link_request 可为 true
workflow: 简短英文标识
next_action: generate_reply | defer_email_workflow | finish_without_reply | mark_needs_human
missing_slots: 字符串数组
template_id: 可选，仅可返回下方可用邮件模板中的 id，不能编造
template_key: 可选，仅可返回下方可用邮件模板中的 template_key，不能编造
risk_flags: 字符串数组
reason: 一句简短理由
客户索要链接、地址、资料、下载内容或要求通过邮箱接收时使用 email_link_request。"""
    email_templates = _email_template_prompt_items(request)
    templates_text = (
        json.dumps(email_templates, ensure_ascii=False)
        if email_templates
        else "[]"
    )
    user = (
        f"平台：{request.platform or '未知'}\n"
        f"店铺：{request.shop_name or '未知'}\n"
        f"可用邮件模板元数据（只可从中选择 template_id/template_key）：{templates_text}\n"
        f"最近对话（按时间正序）：\n{conversation_prompt(request)}\n"
        f"最新客户消息：{request.message}"
    )
    try:
        generated, provider = await generate_with_provider(
            system=system,
            user=user,
            provider_config=request.provider_config,
            temperature=0,
            json_mode=True,
        )
        if not generated:
            raise ValueError("intent provider is not configured")
        payload = _extract_json(generated)
        payload["risk_flags"] = list(dict.fromkeys([*risk_flags, *(payload.get("risk_flags") or [])]))
        decision = IntentDecision.model_validate(payload)
        if decision.intent == "normal_question":
            decision.need_doc_search = True
            decision.need_email = False
            decision.template_id = ""
            decision.template_key = ""
        elif decision.intent == "email_link_request":
            decision.need_doc_search = False
            decision.need_email = True
            allowed_ids = {item["id"] for item in email_templates if item["id"]}
            allowed_keys = {item["template_key"] for item in email_templates if item["template_key"]}
            if decision.template_id and decision.template_id not in allowed_ids:
                decision.template_id = ""
            if decision.template_key and decision.template_key not in allowed_keys:
                decision.template_key = ""
        else:
            decision.need_doc_search = False
            decision.need_email = False
            decision.template_id = ""
            decision.template_key = ""
        logger.info(
            "intent classified trace_id=%s intent=%s confidence=%.2f provider=%s",
            trace_id,
            decision.intent,
            decision.confidence,
            provider,
        )
        return decision, provider
    except (OSError, ValueError, ValidationError, json.JSONDecodeError) as exc:
        logger.warning(
            "intent fallback trace_id=%s error_type=%s",
            trace_id,
            type(exc).__name__,
        )
        return _local_intent(request.message, risk_flags, "意图模型不可用，采用本地保守规则"), "local-fallback"
    except Exception as exc:
        logger.warning(
            "intent provider unavailable trace_id=%s error_type=%s",
            trace_id,
            type(exc).__name__,
        )
        return _local_intent(request.message, risk_flags, "意图模型调用失败，采用本地保守规则"), "local-fallback"


def build_action_plan(intent: IntentDecision, has_product_bases: bool) -> ActionPlan:
    if intent.intent == "normal_question":
        need_search = bool(intent.need_doc_search and has_product_bases)
        actions = ["search_product_documents"] if need_search else []
        actions.extend(["generate_reply", "send_platform_text"])
        return ActionPlan(
            workflow="answer_question",
            next_action="search_product_documents" if need_search else "generate_reply",
            generate_reply=True,
            need_doc_search=need_search,
            required_actions=actions,
        )
    if intent.intent == "email_link_request":
        return ActionPlan(
            workflow="collect_email_for_link",
            next_action="defer_email_workflow",
            email_service_required=True,
            required_actions=["save_pending_workflow"],
            blocked_actions=["send_external_link_in_chat"],
        )
    if intent.intent == "no_reply_needed":
        return ActionPlan(workflow="finish", next_action="finish_without_reply")
    return ActionPlan(
        workflow="human_review",
        next_action="mark_needs_human",
        required_actions=["mark_needs_human"],
        blocked_actions=["auto_send"],
    )


async def _tone_persona(base_id: str) -> str:
    if not base_id:
        logger.info("tone persona skipped reason=not_configured")
        return ""
    try:
        value = await get_knowledge_base(base_id)
    except Exception as exc:
        logger.warning(
            "tone persona unavailable base_id=%s error_type=%s",
            base_id,
            type(exc).__name__,
        )
        return ""
    if value.get("kind") != "tone":
        logger.warning("tone persona ignored base_id=%s reason=kind_mismatch", base_id)
        return ""
    if not value.get("enabled", False):
        logger.warning("tone persona ignored base_id=%s reason=disabled", base_id)
        return ""
    persona = clean_reply(str(value.get("persona") or ""))
    logger.info(
        "tone persona resolved base_id=%s configured=%s length=%d",
        base_id,
        bool(persona),
        len(persona),
    )
    return persona


def _generation_prompts(
    request: ReplyRequest,
    intent: IntentDecision,
    action_plan: ActionPlan,
    retrieval: list[dict[str, Any]],
    persona: str,
) -> tuple[str, str]:
    config = request.reply_config
    system = (
        "你是电商客服，请生成一段可以直接发送给客户的纯文本回复。"
        "优先回答最新问题，不输出分析过程，不编造知识片段中不存在的事实；"
        "没有执行结果时不得声称邮件或图片已经发送。\n"
        f"基础风格：{config.get('base_style') or '专业'}\n"
        f"回答长度：{config.get('answer_length') or '适中'}\n"
        f"客户称呼：{config.get('customer_address') or '亲亲'}\n"
        f"客服自称：{config.get('self_address') or '客服'}\n"
        f"虚拟人设：{persona or '未配置'}\n"
        f"额外要求：{config.get('advanced_instruction') or '无'}"
    )
    snippets = "\n".join(
        f"[{index}] {item.get('source_title') or item.get('document_title') or '文档'}：{item.get('snippet') or ''}"
        for index, item in enumerate(retrieval[:5], start=1)
    )
    user = (
        f"平台：{request.platform or '未知'}\n"
        f"店铺：{request.shop_name or '未知'}\n"
        f"客户：{request.customer_name or '未知'}\n"
        f"最近对话（按时间正序）：\n{conversation_prompt(request)}\n"
        f"结构化意图：{intent.model_dump_json()}\n"
        f"执行计划：{action_plan.model_dump_json()}\n"
        f"产品文档知识片段：\n{snippets or '未检索到可用知识片段'}\n"
        f"最新客户问题：{request.message}"
    )
    return system, user


async def build_reply(request: ReplyRequest) -> ReplyResponse:
    trace_id = f"reply-{uuid.uuid4().hex[:16]}"
    risk_flags = [word for word in RISK_WORDS if word in request.message]
    if request.qa_base_ids:
        try:
            qa_result = await match_qa(request.message, request.qa_base_ids)
            qa_result["status"] = "hit" if qa_result.get("matched") else "miss"
        except Exception as exc:
            logger.warning(
                "qa match unavailable trace_id=%s base_count=%d error_type=%s",
                trace_id,
                len(request.qa_base_ids),
                type(exc).__name__,
            )
            qa_result = {
                "matched": False,
                "match_type": "unavailable",
                "score": 0.0,
                "entry": None,
                "status": "unavailable",
            }
    else:
        qa_result = {
            "matched": False,
            "match_type": "skipped",
            "score": 0.0,
            "entry": None,
            "status": "skipped",
        }

    if qa_result.get("matched") and isinstance(qa_result.get("entry"), dict):
        entry = qa_result["entry"]
        intent = IntentDecision(
            intent="qa_match",
            confidence=float(qa_result.get("score") or 0),
            need_doc_search=False,
            workflow="qa_answer",
            next_action="send_platform_text",
            risk_flags=risk_flags,
            reason="机器人关联的 QA 问答库已命中",
        )
        action_plan = ActionPlan(
            workflow="qa_answer",
            next_action="send_platform_text",
            required_actions=["send_platform_text"],
        )
        image_url = str(entry.get("image_url") or "")
        if image_url.startswith("/"):
            image_url = f"{get_settings().knowledge_base_url.rstrip('/')}/api/v1{image_url}"
        if image_url:
            action_plan.required_actions.append("send_platform_image_after_text")
        logger.info(
            "qa match hit trace_id=%s match_type=%s entry_id=%s base_count=%d model_short_circuit=true",
            trace_id,
            qa_result.get("match_type", ""),
            entry.get("id", ""),
            len(request.qa_base_ids),
        )
        return ReplyResponse(
            decision="auto_send" if request.allow_auto_send else "suggest",
            text=str(entry.get("answer") or ""),
            media=([{"type": "image", "url": image_url}] if image_url else []),
            intent=intent,
            action_plan=action_plan,
            confidence=float(qa_result.get("score") or 0),
            risk_flags=risk_flags,
            qa_match=qa_result,
            model_calls={"intent": "skipped", "generation": "skipped"},
            provider="qa-rule",
            trace_id=trace_id,
        )

    logger.info(
        "qa match %s trace_id=%s base_count=%d model_short_circuit=false",
        qa_result["status"],
        trace_id,
        len(request.qa_base_ids),
    )
    intent, intent_provider = await classify_intent(request, trace_id, risk_flags)
    action_plan = build_action_plan(intent, bool(request.product_base_ids))

    if intent.intent == "no_reply_needed":
        return ReplyResponse(
            decision="no_reply",
            text="",
            intent=intent,
            action_plan=action_plan,
            confidence=intent.confidence,
            risk_flags=intent.risk_flags,
            qa_match=qa_result,
            model_calls={"intent": intent_provider, "generation": "skipped"},
            provider=intent_provider,
            trace_id=trace_id,
        )
    if intent.intent != "normal_question":
        return ReplyResponse(
            decision="needs_human",
            text="",
            intent=intent,
            action_plan=action_plan,
            confidence=intent.confidence,
            risk_flags=intent.risk_flags,
            qa_match=qa_result,
            model_calls={"intent": intent_provider, "generation": "skipped"},
            provider=intent_provider,
            trace_id=trace_id,
        )

    retrieval: list[dict[str, Any]] = []
    if action_plan.need_doc_search:
        try:
            retrieval = await search_documents(request.message, request.product_base_ids)
        except Exception as exc:
            logger.warning(
                "document search unavailable trace_id=%s base_count=%d error_type=%s",
                trace_id,
                len(request.product_base_ids),
                type(exc).__name__,
            )
    persona = await _tone_persona(request.tone_base_id)
    system, user = _generation_prompts(request, intent, action_plan, retrieval, persona)
    try:
        generated, generation_provider = await generate_with_provider(
            system=system,
            user=user,
            provider_config=request.provider_config,
        )
    except Exception as exc:
        logger.warning(
            "reply generation unavailable trace_id=%s error_type=%s",
            trace_id,
            type(exc).__name__,
        )
        generated, generation_provider = "", "local-fallback"
    text = clean_reply(generated)
    if not text:
        text = "您好，我已经看到您的问题了。客服正在为您核实，请稍等一下。"
        if retrieval:
            text = f"您好，关于您咨询的问题，{retrieval[0].get('snippet', '')[:180]}"
    decision = "suggest"
    if request.allow_auto_send and intent.confidence >= 0.6:
        decision = "auto_send"
    logger.info(
        "reply generated trace_id=%s intent_provider=%s generation_provider=%s retrieval_count=%d decision=%s",
        trace_id,
        intent_provider,
        generation_provider,
        len(retrieval),
        decision,
    )
    return ReplyResponse(
        decision=decision,
        text=text,
        intent=intent,
        action_plan=action_plan,
        confidence=intent.confidence,
        risk_flags=intent.risk_flags,
        qa_match=qa_result,
        retrieval=retrieval,
        model_calls={"intent": intent_provider, "generation": generation_provider},
        provider=generation_provider,
        trace_id=trace_id,
    )
