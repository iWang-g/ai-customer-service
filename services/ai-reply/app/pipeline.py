from __future__ import annotations

import json
import logging
import re
import uuid
from typing import Any

from pydantic import ValidationError

from app.core.config import get_settings
from app.knowledge_client import get_knowledge_base, match_qa, search_documents
from app.provider import (
    generate_with_provider,
    observe_model_calls,
)
from app.schemas import ActionPlan, IntentDecision, ReplyRequest, ReplyResponse


RISK_WORDS = ("退款", "退货", "投诉", "赔偿", "隐私", "地址", "手机号", "转人工", "转客服")
EMAIL_WORDS = ("邮箱", "邮件")
DIRECT_REPLY_WORDS = (
    "你好", "您好", "嗨", "哈喽", "hello", "hi", "好", "好的", "嗯", "行", "可以",
    "知道了", "明白了", "收到", "谢谢", "感谢", "不用了", "不需要了", "再见",
)
HUMAN_WORDS = ("转人工", "转客服", "人工客服", "投诉", "举报")
PRODUCT_KNOWLEDGE_WORDS = (
    "商品", "产品", "键盘", "键帽", "轴体", "规格", "尺寸", "型号", "适配", "兼容", "能装",
    "安装", "价格", "多少钱", "优惠", "库存", "现货", "发货", "物流", "快递", "订单", "售后",
    "退款", "退货", "换货", "保修", "质保", "故障", "坏了", "进水",
)
DEFAULT_FALLBACK_REPLY = "亲亲，这个问题这边暂时无法确认，我帮您进一步核实，请稍等~"
DEFAULT_DIRECT_REPLY = "好的亲亲，有需要随时告诉我哦～"
DEFAULT_HUMAN_HANDOFF_REPLY = "好的亲亲，正在为您转接人工客服，请稍等～"
PROHIBITED_OUTBOUND_PATTERNS = (
    ("external_link", re.compile(r"(?i)(?:https?://|ftp://|www\.)\S+")),
    ("external_link", re.compile(
        r"(?i)(?<![@\w])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+"
        r"(?:com|cn|net|org|top|shop|vip|link|xyz|cc|me|io|co)(?:[/?:#]\S*)?"
    )),
    ("email_address", re.compile(r"(?i)\b[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+\b")),
    ("phone_number", re.compile(r"(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)")),
    ("phone_number", re.compile(
        r"(?:联系电话|联系号码|手机号|手机|电话)\s*[:：]?\s*(?:0\d{2,3}[- ]?)?\d{7,8}"
    )),
    ("wechat_id", re.compile(
        r"(?i)(?:微信|微\s*信|v信|vx|wechat)(?:号)?\s*[:：]?\s*[a-z][-_a-z0-9]{5,19}"
    )),
    ("qq_id", re.compile(r"(?i)(?:qq|扣扣)(?:号)?\s*[:：]?\s*[1-9]\d{4,11}")),
)
INTERNAL_DISCLOSURE_PATTERNS = (
    ("internal_ai", re.compile(r"(?i)(?:\bAI\b|人工智能|机器人|语言模型|大模型|提示词)")),
    ("internal_knowledge", re.compile(r"(?:知识库|知识片段|文档检索|未检索到|无法访问知识库)")),
)
UNSOLICITED_HANDOFF_PATTERN = re.compile(
    r"(?:联系|咨询|转接|转至|找).{0,8}(?:平台人工客服|平台客服|其他客服|人工客服)"
)
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
                "platform_account_id": clean_reply(str(item.get("platform_account_id") or "")),
            }
        )
    return items[:50]


def _email_trigger_scenarios(request: ReplyRequest) -> str:
    return clean_reply(str(request.reply_config.get("email_trigger_scenarios") or ""))


def _matches_email_trigger_scenario(message: str, scenarios: str) -> bool:
    normalized_message = clean_reply(message).casefold()
    if not normalized_message:
        return False
    terms = [
        clean_reply(item).casefold()
        for item in re.split(r"[、,，;；\n]", scenarios or "")
        if len(clean_reply(item)) >= 2
    ]
    return any(term in normalized_message for term in terms)


def clean_reply(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def _matched_prohibited_outbound_content(text: str) -> str | None:
    return next((name for name, pattern in PROHIBITED_OUTBOUND_PATTERNS if pattern.search(text)), None)


def _matched_identity_disclosure(text: str, *, allow_human_handoff: bool) -> str | None:
    matched = next((name for name, pattern in INTERNAL_DISCLOSURE_PATTERNS if pattern.search(text)), None)
    if matched:
        return matched
    if not allow_human_handoff and UNSOLICITED_HANDOFF_PATTERN.search(text):
        return "unsolicited_handoff"
    return None


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


def _platform_rule_scene(request: ReplyRequest) -> dict[str, Any]:
    scene = request.reply_config.get("platform_rule_scene")
    if not isinstance(scene, dict):
        return {}
    if scene.get("type") != "pdd_custom_order_confirmation":
        return {}
    return scene


def _platform_rule_scene_prompt(request: ReplyRequest) -> str:
    scene = _platform_rule_scene(request)
    if not scene:
        return "无"
    return json.dumps({
        "type": scene.get("type"),
        "prompt_text": scene.get("prompt_text"),
        "reply_guidance": scene.get("supplement_text"),
        "instruction": (
            "客户正在回复拼多多主账号自动发出的定制商品确认提醒。"
            "如果客户表示不额外定制、按拍下图片或按默认款制作，直接确认会按下单时选择的商品图安排制作发货；"
            "如果客户询问确认什么定制，解释不需要额外定制时默认按下单时选择的商品图制作发货；"
            "如果客户提出改图、加字、换内容等定制诉求，按普通商品咨询继续回答。"
        ),
    }, ensure_ascii=False)


def _acknowledge_custom_order_text(text: str) -> str:
    cleaned = clean_reply(text)
    if cleaned.startswith("亲亲，"):
        return f"好的亲亲，{cleaned.removeprefix('亲亲，')}"
    if cleaned.startswith("亲，"):
        return f"好的亲亲，{cleaned.removeprefix('亲，')}"
    return f"好的亲亲，{cleaned}" if cleaned else "好的亲亲，那这边就按您下单时选择的那款商品图安排制作发货~"


def _pdd_custom_order_scene_reply(request: ReplyRequest) -> str:
    scene = _platform_rule_scene(request)
    if not scene:
        return ""
    message = _normalized_short_message(request.message)
    guidance = clean_reply(str(scene.get("supplement_text") or ""))
    default_or_original = (
        "不额外定制", "不需要额外定制", "不用额外定制", "不要额外定制",
        "按原图", "按图片", "按照片", "原图", "原样", "默认",
        "拍下的这款", "拍下这款", "下单的这款", "直接我拍下", "就直接",
    )
    asks_meaning = (
        "确认什么", "确认啥", "什么定制", "定制什么", "什么意思", "怎么确认",
    )
    if any(word in message for word in default_or_original):
        return _acknowledge_custom_order_text(guidance)
    if any(word in message for word in asks_meaning):
        return guidance
    return ""


def _pdd_custom_order_scene_result(
    request: ReplyRequest,
    text: str,
    trace_id: str,
    risk_flags: list[str],
    qa_result: dict[str, Any],
) -> ReplyResponse:
    intent = IntentDecision(
        intent="direct_reply",
        reply_route="direct",
        direct_reply_text=text,
        confidence=1.0,
        need_doc_search=False,
        workflow="pdd_custom_order_confirmation",
        next_action="send_direct_reply",
        risk_flags=risk_flags,
        reason="客户正在回复拼多多主账号定制商品确认提醒",
    )
    action_plan = ActionPlan(
        workflow="pdd_custom_order_confirmation",
        next_action="send_direct_reply",
        required_actions=["send_platform_text"],
        blocked_actions=["qa_match", "generate_reply"],
    )
    return _reply_with_outbound_guard(
        request,
        text=text,
        intent=intent,
        action_plan=action_plan,
        confidence=1.0,
        risk_flags=risk_flags,
        qa_match=qa_result,
        retrieval=[],
        model_calls={"intent": "skipped-pdd-custom-order", "generation": "skipped"},
        provider="pdd-custom-order-rule",
        trace_id=trace_id,
    )


def _reply_with_outbound_guard(
    request: ReplyRequest,
    *,
    text: str,
    intent: IntentDecision,
    action_plan: ActionPlan,
    confidence: float,
    risk_flags: list[str],
    qa_match: dict[str, Any],
    retrieval: list[dict[str, Any]],
    model_calls: dict[str, str],
    provider: str,
    trace_id: str,
    retrieval_status: str = "not_needed",
    media: list[dict[str, Any]] | None = None,
) -> ReplyResponse:
    guarded_flags = list(risk_flags)
    identity_disclosure = _matched_identity_disclosure(
        text,
        allow_human_handoff=intent.reply_route == "human_handoff",
    )
    prohibited_content = _matched_prohibited_outbound_content(text) or identity_disclosure
    if not prohibited_content:
        return ReplyResponse(
            decision="auto_send" if request.allow_auto_send else "suggest",
            text=text,
            media=media or [],
            intent=intent,
            action_plan=action_plan,
            confidence=confidence,
            risk_flags=guarded_flags,
            qa_match=qa_match,
            retrieval=retrieval,
            retrieval_status=retrieval_status,
            model_calls=model_calls,
            provider=provider,
            trace_id=trace_id,
        )

    fallback = _fallback_reply(request)
    fallback_prohibited_content = (
        _matched_prohibited_outbound_content(fallback)
        or _matched_identity_disclosure(
            fallback,
            allow_human_handoff=intent.reply_route == "human_handoff",
        )
    )
    guarded_flags = list(dict.fromkeys([
        *guarded_flags,
        "identity_disclosure" if identity_disclosure else "prohibited_outbound_content",
        prohibited_content,
    ]))
    if fallback_prohibited_content:
        logger.error(
            "outbound reply and fallback blocked trace_id=%s reply_reason=%s fallback_reason=%s",
            trace_id,
            prohibited_content,
            fallback_prohibited_content,
        )
        return ReplyResponse(
            decision="needs_human",
            text="",
            media=[],
            intent=intent,
            action_plan=ActionPlan(
                workflow="human_review",
                next_action="mark_needs_human",
                required_actions=["mark_needs_human"],
                blocked_actions=["send_platform_text", "send_platform_image"],
            ),
            confidence=confidence,
            risk_flags=[*guarded_flags, "fallback_blocked"],
            qa_match=qa_match,
            retrieval=retrieval,
            retrieval_status=retrieval_status,
            model_calls=model_calls,
            provider="outbound-safety-rule",
            trace_id=trace_id,
        )
    logger.warning(
        "outbound reply replaced by fallback trace_id=%s reason=%s",
        trace_id,
        prohibited_content,
    )
    return ReplyResponse(
        decision="auto_send" if request.allow_auto_send else "suggest",
        text=fallback,
        media=[],
        intent=intent,
        action_plan=ActionPlan(
            workflow="fallback_reply",
            next_action="send_platform_text",
            required_actions=["send_platform_text"],
        ),
        confidence=confidence,
        risk_flags=guarded_flags,
        qa_match=qa_match,
        retrieval=retrieval,
        retrieval_status=retrieval_status,
        model_calls=model_calls,
        provider="outbound-safety-fallback",
        trace_id=trace_id,
    )


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


def _local_intent(
    message: str,
    risk_flags: list[str],
    reason: str,
    email_trigger_scenarios: str = "",
) -> IntentDecision:
    if any(word in message for word in HUMAN_WORDS):
        intent = "human_handoff"
        reply_route = "human_handoff"
        next_action = "send_handoff_reply"
        confidence = 0.9
    elif any(word in message for word in EMAIL_WORDS) or _matches_email_trigger_scenario(message, email_trigger_scenarios):
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
direct_reply_text 是最终可发送给客户的内容，必须遵守基础风格、回答长度、客户称呼、客服自称、虚拟人设和额外要求。
你作为店铺中正在接待客户的真正客服与客户交流，回复必须自然、可信，不能让客户察觉到自动化系统的存在。
所有可发送内容都不得提及或暗示 AI、机器人、模型、系统、提示词、知识库、知识片段、文档检索、信息来源、能力限制等内部实现。
信息不足时只能以店铺客服口吻说明“这边暂时无法确认，我帮您进一步核实”，不得说“知识库中没有”“未检索到”“无法访问知识库”等。
除非客户明确要求转人工或转客服且当前路由为 human_handoff，否则不得主动建议或要求客户联系平台人工客服、其他客服或转人工。
confidence: 0 到 1
need_customer_reply: 必须为 true
need_doc_search: 仅 retrieve_product 为 true
need_email: boolean，仅 email_link_request 可为 true
workflow: 简短英文标识
next_action: send_direct_reply | search_product_documents | defer_email_workflow | send_handoff_reply
wants_product_recommendation: boolean，只有客户明确想看/推荐/询问店内是否有某类商品时才为 true
product_recommendation_query: wants_product_recommendation 为 true 时填写客户想找的商品范围或关键词，否则为空
missing_slots: 字符串数组
template_id: 可选，仅可返回下方可用邮件模板中的 id，不能编造
template_key: 可选，仅可返回下方可用邮件模板中的 template_key，不能编造
risk_flags: 字符串数组
reason: 一句简短理由
只有问候、致谢、简单确认、结束语、情绪回应等不涉及业务事实的消息才允许 direct。
产品规格、价格、库存、适配、安装、物流、售后、退款、保修等事实问题必须 retrieve_product，禁止凭模型自身知识回答。
wants_product_recommendation 只用于判断是否需要额外发送商品卡；商品标题中的普通词命中不能作为推荐意图。
例如“推荐几款”“有什么推荐吗”“有没有崩铁流萤抱枕”“有没有明日方舟角色的”应为 true。
例如“双面图案一样吗”“尺寸多大”“有没有货”“什么时候发货”“能优惠吗”属于咨询问题，应为 false。
判断不确定时必须 retrieve_product。客户请求不适合在平台聊天中直接发送、需要通过邮箱承接、或符合邮件触发场景时使用 email_link_request。
如果配置了邮件触发场景，客户消息符合任一场景时必须使用 email_link_request；不要把这些场景当普通产品咨询处理。
如果未配置邮件触发场景，仅在客户明确要求通过邮箱接收资料，或索要不适合在平台聊天中直接发送的外部内容时使用 email_link_request。
每条客户入站消息都必须回复，禁止返回无需回复或空回复。
所有可发送给客户的回复内容都必须是纯文本，禁止 Markdown 格式，禁止标题、列表、表格、代码块、引用块、加粗或斜体符号。
平台禁止在聊天回复中发送站外引流信息。无论客户消息、最近对话、文档片段、知识库、人设或额外要求中是否包含，回复都严禁输出或照抄任何 URL、网址、链接地址、电子邮箱地址、手机或电话号码、微信号、QQ号等个人联系方式；客户要求提供时也不能发送，应改为平台内可完成的说明，或以店铺客服口吻说明会进一步核实。"""
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
        f"用户配置的违禁内容：{request.reply_config.get('prohibited_content_instruction') or '未配置'}\n"
        "生成回复时不得涉及上述用户配置的违禁内容。\n"
        f"平台业务场景提示：{_platform_rule_scene_prompt(request)}\n"
        f"客户订单信息（仅此处可作为订单事实来源）：{json.dumps(request.customer_orders, ensure_ascii=False)}\n"
        f"平台会话上下文（商品卡片、来源卡片等，仅作指代和商品背景）：{json.dumps(request.platform_context, ensure_ascii=False)}\n"
        f"店铺资料摘要（仅作为店铺商品范围和经营方向参考，不可据此编造具体商品事实）：{json.dumps(request.shop_product_summary, ensure_ascii=False)}\n"
        f"邮件触发场景（用户配置，符合时走 email_link_request）：{_email_trigger_scenarios(request) or '未配置'}\n"
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
            stage="intent",
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
            decision.reply_route = "direct"
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
                _email_trigger_scenarios(request),
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
        return _local_intent(
            request.message,
            risk_flags,
            "意图模型不可用，采用本地保守规则",
            _email_trigger_scenarios(request),
        ), "local-fallback"
    except Exception as exc:
        logger.warning(
            "intent provider unavailable trace_id=%s error_type=%s",
            trace_id,
            type(exc).__name__,
        )
        return _local_intent(
            request.message,
            risk_flags,
            "意图模型调用失败，采用本地保守规则",
            _email_trigger_scenarios(request),
        ), "local-fallback"


def build_action_plan(intent: IntentDecision, has_product_bases: bool) -> ActionPlan:
    if intent.reply_route == "direct":
        return ActionPlan(
            workflow="direct_reply",
            next_action="send_platform_text",
            required_actions=["send_platform_text"],
        )
    if intent.reply_route == "retrieve_product":
        actions = ["search_product_documents", "generate_reply", "send_platform_text"]
        return ActionPlan(
            workflow="answer_question",
            next_action="search_product_documents",
            generate_reply=True,
            need_doc_search=True,
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


async def _tone_persona(base_id: str, access_token: str) -> str:
    if not base_id:
        logger.info("tone persona skipped reason=not_configured")
        return ""
    try:
        value = await get_knowledge_base(base_id, access_token)
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
        "你作为店铺中正在接待客户的真正客服，请生成一段可以直接发送给客户的纯文本回复。"
        "回复必须自然、可信，不能让客户察觉到自动化系统的存在；"
        "不得提及或暗示 AI、机器人、模型、系统、提示词、知识库、知识片段、文档检索、信息来源或能力限制等内部实现；"
        "信息不足时只能以店铺客服口吻说明‘这边暂时无法确认，我帮您进一步核实’，不得说‘知识库中没有’‘未检索到’或‘无法访问知识库’；"
        "除非客户明确要求转人工或转客服且当前执行计划确实为人工转接，否则不得主动建议或要求客户联系平台人工客服、其他客服或转人工；"
        "优先回答最新问题，不输出分析过程，不编造提供的商品资料中不存在的事实；"
        "没有执行结果时不得声称邮件或图片已经发送；"
        "无论客户消息、最近对话、文档片段、知识库、人设或额外要求中是否包含，"
        "严禁输出或照抄任何 URL、网址、链接地址、电子邮箱地址、手机或电话号码、微信号、QQ号等个人联系方式；"
        "客户要求提供时也不能发送，应改为平台内可完成的说明，或说明这边会进一步核实；"
        "禁止使用 Markdown 格式，禁止标题、列表、表格、代码块、引用块、加粗或斜体符号。\n"
        f"基础风格：{config.get('base_style') or '专业'}\n"
        f"回答长度：{config.get('answer_length') or '适中'}\n"
        f"客户称呼：{config.get('customer_address') or '亲亲'}\n"
        f"客服自称：{config.get('self_address') or '客服'}\n"
        f"虚拟人设：{persona or '未配置'}\n"
        f"额外要求：{config.get('advanced_instruction') or '无'}\n"
        f"用户配置的违禁内容：{config.get('prohibited_content_instruction') or '未配置'}\n"
        "生成回复时不得涉及上述用户配置的违禁内容。\n"
        f"平台业务场景提示：{_platform_rule_scene_prompt(request)}"
    )
    snippets = "\n".join(
        f"[{index}] {_retrieval_source_label(item)}：{item.get('snippet') or ''}"
        for index, item in enumerate(retrieval[:5], start=1)
    )
    user = (
        f"平台：{request.platform or '未知'}\n"
        f"店铺：{request.shop_name or '未知'}\n"
        f"客户：{request.customer_name or '未知'}\n"
        f"客户订单信息（仅此处可作为订单事实来源）：{json.dumps(request.customer_orders, ensure_ascii=False)}\n"
        f"平台会话上下文（商品卡片、来源卡片等，仅作指代和商品背景）：{json.dumps(request.platform_context, ensure_ascii=False)}\n"
        f"店铺资料摘要（用于判断客户是否在询问店内商品或推荐商品）：{json.dumps(request.shop_product_summary, ensure_ascii=False)}\n"
        f"最近对话（按时间正序）：\n{conversation_prompt(request)}\n"
        f"结构化意图：{intent.model_dump_json()}\n"
        f"执行计划：{action_plan.model_dump_json()}\n"
        f"产品文档知识片段：\n{snippets or '未检索到可用知识片段'}\n"
        f"最新客户问题：{request.message}"
    )
    return system, user


def _retrieval_source_label(item: dict[str, Any]) -> str:
    source_title = clean_reply(str(item.get("source_title") or item.get("document_title") or "文档"))
    title_path = clean_reply(str(item.get("title_path") or ""))
    if title_path and title_path != source_title:
        return f"{source_title} / {title_path}"
    return source_title


@observe_model_calls
async def build_reply(request: ReplyRequest) -> ReplyResponse:
    trace_id = f"reply-{uuid.uuid4().hex[:16]}"
    risk_flags = [word for word in RISK_WORDS if word in request.message]
    if request.qa_base_ids:
        try:
            qa_result = await match_qa(request.message, request.qa_base_ids, request.knowledge_access_token)
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

    scene_reply = _pdd_custom_order_scene_reply(request)
    if scene_reply:
        return _pdd_custom_order_scene_result(
            request,
            scene_reply,
            trace_id,
            risk_flags,
            qa_result,
        )

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
            settings = get_settings()
            public_base_url = (
                settings.knowledge_base_public_url or settings.knowledge_base_url
            ).rstrip("/")
            image_url = f"{public_base_url}/api/v1{image_url}"
        if image_url:
            action_plan.required_actions.append("send_platform_image_after_text")
        logger.info(
            "qa match hit trace_id=%s match_type=%s entry_id=%s base_count=%d model_short_circuit=true",
            trace_id,
            qa_result.get("match_type", ""),
            entry.get("id", ""),
            len(request.qa_base_ids),
        )
        return _reply_with_outbound_guard(
            request,
            text=str(entry.get("answer") or ""),
            media=([{"type": "image", "url": image_url}] if image_url else []),
            intent=intent,
            action_plan=action_plan,
            confidence=float(qa_result.get("score") or 0),
            risk_flags=risk_flags,
            qa_match=qa_result,
            retrieval=[],
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
    persona = await _tone_persona(request.tone_base_id, request.knowledge_access_token)
    intent, intent_provider = await classify_intent(request, trace_id, risk_flags, persona)
    action_plan = build_action_plan(intent, bool(request.product_base_ids))

    if intent.reply_route == "direct":
        return _reply_with_outbound_guard(
            request,
            text=clean_reply(intent.direct_reply_text) or _direct_fallback_reply(request.message),
            intent=intent,
            action_plan=action_plan,
            confidence=intent.confidence,
            risk_flags=intent.risk_flags,
            qa_match=qa_result,
            retrieval=[],
            model_calls={"intent": intent_provider, "generation": "skipped"},
            provider=intent_provider,
            trace_id=trace_id,
        )
    if intent.reply_route == "human_handoff":
        return _reply_with_outbound_guard(
            request,
            text=clean_reply(intent.direct_reply_text) or DEFAULT_HUMAN_HANDOFF_REPLY,
            intent=intent,
            action_plan=action_plan,
            confidence=intent.confidence,
            risk_flags=intent.risk_flags,
            qa_match=qa_result,
            retrieval=[],
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
            model_calls={"intent": intent_provider, "generation": "skipped"},
            provider=intent_provider,
            trace_id=trace_id,
        )

    retrieval: list[dict[str, Any]] = []
    retrieval_status = "no_product_base" if not request.product_base_ids else "empty"
    if action_plan.need_doc_search:
        if request.product_base_ids:
            try:
                retrieval = await search_documents(request.message, request.product_base_ids, request.knowledge_access_token)
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
        fallback_text = _fallback_reply(request)
        fallback_plan = ActionPlan(
            workflow="fallback_reply",
            next_action="send_platform_text",
            required_actions=["send_platform_text"],
            blocked_actions=["generate_reply"],
        )
        logger.info(
            "document retrieval empty trace_id=%s base_count=%d generation_skipped=true",
            trace_id,
            len(request.product_base_ids),
        )
        return _reply_with_outbound_guard(
            request,
            text=fallback_text,
            intent=intent,
            action_plan=fallback_plan,
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
            stage="generation",
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
    decision = "auto_send" if request.allow_auto_send and intent.confidence >= 0.6 else "suggest"
    logger.info(
        "reply generated trace_id=%s intent_provider=%s generation_provider=%s retrieval_count=%d decision=%s",
        trace_id,
        intent_provider,
        generation_provider,
        len(retrieval),
        decision,
    )
    response = _reply_with_outbound_guard(
        request,
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
    if decision == "suggest" and response.decision == "auto_send":
        response.decision = "suggest"
    return response
