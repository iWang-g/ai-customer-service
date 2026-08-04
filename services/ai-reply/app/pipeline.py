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
DIRECT_REPLY_WORDS = (
    "你好", "您好", "嗨", "哈喽", "hello", "hi", "好", "好的", "嗯", "行", "可以",
    "知道了", "明白了", "收到", "谢谢", "感谢", "不用了", "不需要了", "再见",
)
HUMAN_WORDS = ("转人工", "人工客服", "投诉", "举报")
PRODUCT_KNOWLEDGE_WORDS = (
    "商品", "产品", "键盘", "键帽", "轴体", "规格", "尺寸", "型号", "适配", "兼容", "能装",
    "安装", "价格", "多少钱", "优惠", "库存", "现货", "发货", "物流", "快递", "订单", "售后",
    "退款", "退货", "换货", "保修", "质保", "故障", "坏了", "进水",
)
DEFAULT_FALLBACK_REPLY = "您的问题我将为您接入专业产品客服，请稍后"
DEFAULT_DIRECT_REPLY = "好的亲亲，有需要随时告诉我哦～"
DEFAULT_HUMAN_HANDOFF_REPLY = "好的亲亲，正在为您转接人工客服，请稍等～"
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


def _fallback_reply(request: ReplyRequest) -> str:
    return clean_reply(str(request.reply_config.get("fallback_reply_text") or DEFAULT_FALLBACK_REPLY))


def _normalized_short_message(message: str) -> str:
    return re.sub(r"[\s，。！？、,.!?~～]+", "", message).casefold()


def _is_direct_reply_message(message: str) -> bool:
    normalized = _normalized_short_message(message)
    return bool(
        normalized
        and len(normalized) <= 20
        and any(
            normalized == word.casefold()
            or normalized.startswith(word.casefold())
            for word in DIRECT_REPLY_WORDS
        )
    )


def _requires_product_knowledge(message: str) -> bool:
    normalized = _normalized_short_message(message)
    return any(word.casefold() in normalized for word in PRODUCT_KNOWLEDGE_WORDS)


def _direct_fallback_reply(message: str) -> str:
    normalized = _normalized_short_message(message)
    if any(word in normalized for word in ("谢谢", "感谢")):
        return "不客气亲亲，很高兴能帮到您～"
    if any(word in normalized for word in ("你好", "您好", "嗨", "哈喽", "hello", "hi")):
        return "您好亲亲，请问有什么可以帮您？"
    return DEFAULT_DIRECT_REPLY


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
        reply_route = "human_handoff"
        next_action = "send_handoff_reply"
        confidence = 0.9
    elif any(word in message for word in EMAIL_WORDS):
        intent = "email_link_request"
        reply_route = "email_workflow"
        next_action = "defer_email_workflow"
        confidence = 0.72
    elif _is_direct_reply_message(message) and not _requires_product_knowledge(message):
        intent = "direct_reply"
        reply_route = "direct"
        next_action = "send_direct_reply"
        confidence = 0.85
    else:
        intent = "normal_question"
        reply_route = "retrieve_product"
        next_action = "search_product_documents"
        confidence = 0.65
    return IntentDecision(
        intent=intent,
        reply_route=reply_route,
        direct_reply_text=(
            DEFAULT_HUMAN_HANDOFF_REPLY
            if intent == "human_handoff"
            else _direct_fallback_reply(message) if intent == "direct_reply" else ""
        ),
        confidence=confidence,
        need_customer_reply=True,
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
    persona: str = "",
) -> tuple[IntentDecision, str]:
    system = """你是电商客服意图路由器，并为无需产品知识的轻量场景生成最终回复。
必须只返回一个 JSON 对象，字段如下：
intent: direct_reply | normal_question | email_link_request | human_handoff | unknown
reply_route: direct | retrieve_product | email_workflow | human_handoff
direct_reply_text: 仅 direct 或 human_handoff 时填写可直接发给客户的简短回复，其他路由必须为空
confidence: 0 到 1
need_customer_reply: 必须为 true
need_doc_search: 仅 retrieve_product 为 true
need_email: boolean，仅 email_link_request 可为 true
workflow: 简短英文标识
next_action: send_direct_reply | search_product_documents | defer_email_workflow | send_handoff_reply
missing_slots: 字符串数组
template_id: 可选，仅可返回下方可用邮件模板中的 id，不能编造
template_key: 可选，仅可返回下方可用邮件模板中的 template_key，不能编造
risk_flags: 字符串数组
reason: 一句简短理由
只有问候、致谢、简单确认、结束语、情绪回应等不涉及业务事实的消息才允许 direct。
产品规格、价格、库存、适配、安装、物流、售后、退款、保修等事实问题必须 retrieve_product，禁止凭模型自身知识回答。
判断不确定时必须 retrieve_product。客户索要链接、地址、资料、下载内容或要求通过邮箱接收时使用 email_link_request。
每条客户入站消息都必须回复，禁止返回无需回复或空回复。"""
    email_templates = _email_template_prompt_items(request)
    templates_text = (
        json.dumps(email_templates, ensure_ascii=False)
        if email_templates
        else "[]"
    )
    user = (
        f"平台：{request.platform or '未知'}\n"
        f"店铺：{request.shop_name or '未知'}\n"
        f"基础风格：{request.reply_config.get('base_style') or '专业'}\n"
        f"回答长度：{request.reply_config.get('answer_length') or '适中'}\n"
        f"客户称呼：{request.reply_config.get('customer_address') or '亲亲'}\n"
        f"客服自称：{request.reply_config.get('self_address') or '客服'}\n"
        f"虚拟人设：{persona or '未配置'}\n"
        f"额外要求：{request.reply_config.get('advanced_instruction') or '无'}\n"
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
        decision.need_customer_reply = True
        if (
            decision.intent == "direct_reply"
            and decision.reply_route == "direct"
            and decision.confidence >= 0.75
            and not _requires_product_knowledge(request.message)
        ):
            decision.direct_reply_text = clean_reply(decision.direct_reply_text) or _direct_fallback_reply(request.message)
            decision.need_doc_search = False
            decision.need_email = False
        elif decision.intent == "email_link_request":
            decision.reply_route = "email_workflow"
            decision.direct_reply_text = ""
            decision.need_doc_search = False
            decision.need_email = True
            allowed_ids = {item["id"] for item in email_templates if item["id"]}
            allowed_keys = {item["template_key"] for item in email_templates if item["template_key"]}
            if decision.template_id and decision.template_id not in allowed_ids:
                decision.template_id = ""
            if decision.template_key and decision.template_key not in allowed_keys:
                decision.template_key = ""
        elif decision.intent == "human_handoff":
            decision.reply_route = "human_handoff"
            decision.direct_reply_text = clean_reply(decision.direct_reply_text) or DEFAULT_HUMAN_HANDOFF_REPLY
            decision.need_doc_search = False
            decision.need_email = False
            decision.template_id = ""
            decision.template_key = ""
        elif decision.intent == "normal_question" or decision.reply_route == "retrieve_product":
            decision.intent = "normal_question"
            decision.reply_route = "retrieve_product"
            decision.direct_reply_text = ""
            decision.need_doc_search = True
            decision.need_email = False
            decision.template_id = ""
            decision.template_key = ""
        else:
            decision = _local_intent(
                request.message,
                decision.risk_flags,
                "模型路由不明确，采用本地保守规则",
            )
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
    if intent.reply_route == "direct":
        return ActionPlan(
            workflow="direct_reply",
            next_action="send_platform_text",
            required_actions=["send_platform_text"],
        )
    if intent.reply_route == "retrieve_product":
        return ActionPlan(
            workflow="answer_question",
            next_action="search_product_documents",
            generate_reply=True,
            need_doc_search=True,
            required_actions=["search_product_documents", "generate_reply", "send_platform_text"],
        )
    if intent.intent == "email_link_request":
        return ActionPlan(
            workflow="collect_email_for_link",
            next_action="defer_email_workflow",
            email_service_required=True,
            required_actions=["save_pending_workflow"],
            blocked_actions=["send_external_link_in_chat"],
        )
    if intent.reply_route == "human_handoff":
        return ActionPlan(
            workflow="human_review",
            next_action="send_handoff_reply",
            required_actions=["send_platform_text", "mark_needs_human"],
        )
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
    persona = await _tone_persona(request.tone_base_id)
    intent, intent_provider = await classify_intent(request, trace_id, risk_flags, persona)
    action_plan = build_action_plan(intent, bool(request.product_base_ids))

    if intent.reply_route == "direct":
        return ReplyResponse(
            decision="auto_send" if request.allow_auto_send else "suggest",
            text=clean_reply(intent.direct_reply_text) or _direct_fallback_reply(request.message),
            intent=intent,
            action_plan=action_plan,
            confidence=intent.confidence,
            risk_flags=intent.risk_flags,
            qa_match=qa_result,
            retrieval_status="not_needed",
            model_calls={"intent": intent_provider, "generation": "skipped"},
            provider=intent_provider,
            trace_id=trace_id,
        )
    if intent.reply_route == "human_handoff":
        return ReplyResponse(
            decision="auto_send" if request.allow_auto_send else "suggest",
            text=clean_reply(intent.direct_reply_text) or DEFAULT_HUMAN_HANDOFF_REPLY,
            intent=intent,
            action_plan=action_plan,
            confidence=intent.confidence,
            risk_flags=intent.risk_flags,
            qa_match=qa_result,
            retrieval_status="not_needed",
            model_calls={"intent": intent_provider, "generation": "skipped"},
            provider=intent_provider,
            trace_id=trace_id,
        )

    if intent.reply_route != "retrieve_product":
        return ReplyResponse(
            decision="needs_human",
            text=DEFAULT_HUMAN_HANDOFF_REPLY,
            intent=intent,
            action_plan=action_plan,
            confidence=intent.confidence,
            risk_flags=intent.risk_flags,
            qa_match=qa_result,
            retrieval_status="not_needed",
            model_calls={"intent": intent_provider, "generation": "skipped"},
            provider=intent_provider,
            trace_id=trace_id,
        )

    retrieval: list[dict[str, Any]] = []
    retrieval_status = "no_product_base" if not request.product_base_ids else "empty"
    if action_plan.need_doc_search:
        if request.product_base_ids:
            try:
                retrieval = await search_documents(request.message, request.product_base_ids)
                retrieval_status = "hit" if retrieval else "empty"
            except Exception as exc:
                retrieval_status = "unavailable"
                logger.warning(
                    "document search unavailable trace_id=%s base_count=%d error_type=%s",
                    trace_id,
                    len(request.product_base_ids),
                    type(exc).__name__,
                )
    if action_plan.need_doc_search and not retrieval:
        return ReplyResponse(
            decision="auto_send" if request.allow_auto_send else "suggest",
            text=_fallback_reply(request),
            intent=intent,
            action_plan=ActionPlan(
                workflow="fallback_reply",
                next_action="send_platform_text",
                required_actions=["send_platform_text"],
                blocked_actions=["generate_reply"],
            ),
            confidence=intent.confidence,
            risk_flags=intent.risk_flags,
            qa_match=qa_result,
            retrieval=[],
            retrieval_status=retrieval_status,
            model_calls={"intent": intent_provider, "generation": "skipped-no-retrieval"},
            provider="fallback-rule",
            trace_id=trace_id,
        )
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
        retrieval_status=retrieval_status,
        model_calls={"intent": intent_provider, "generation": generation_provider},
        provider=generation_provider,
        trace_id=trace_id,
    )
