from __future__ import annotations

import json
import unittest
from unittest.mock import AsyncMock, patch

from app.pipeline import _tone_persona, build_reply, conversation_prompt
from app.schemas import ReplyRequest


def intent_json(intent: str = "normal_question", **overrides: object) -> str:
    route = {
        "direct_reply": "direct",
        "email_link_request": "email_workflow",
        "human_handoff": "human_handoff",
    }.get(intent, "retrieve_product")
    payload = {
        "intent": intent,
        "reply_route": route,
        "direct_reply_text": "",
        "confidence": 0.9,
        "need_customer_reply": True,
        "need_doc_search": intent == "normal_question",
        "need_email": intent == "email_link_request",
        "workflow": "answer_question",
        "next_action": "generate_reply",
        "missing_slots": [],
        "risk_flags": [],
        "reason": "测试意图",
        **overrides,
    }
    return json.dumps(payload, ensure_ascii=False)


def combined_json(text: str, intent: str = "normal_question", **overrides: object) -> str:
    route = {
        "direct_reply": "direct",
        "email_link_request": "email_workflow",
        "human_handoff": "human_handoff",
    }.get(intent, "retrieve_product")
    return json.dumps({
        "answerable": bool(text),
        "text": text,
        "reason": "测试单次结构化回复",
        "intent": intent,
        "reply_route": route,
        "confidence": 0.9,
        "custom_order_intent": "none",
        "image_request_intent": "none",
        "image_delivery_intent": "none",
        "wants_product_recommendation": False,
        "product_recommendation_query": "",
        **overrides,
    }, ensure_ascii=False)


class PipelineTests(unittest.IsolatedAsyncioTestCase):
    async def test_qianniu_order_snapshot_and_freshness_rules_reach_intent_and_generation(self):
        orders = {'collection_status': 'success', 'dynamic_fields_fresh': False,
                  'observed_at': '2026-09-15T09:10:00Z', 'recent_orders': [
                      {'platform_order_id': '5127248019328012543', 'order_amount': 281, 'paid_amount': None,
                       'products': [{'title': '枕套', 'sku': '50x160', 'quantity': 1}]}]}
        provider = AsyncMock(return_value=(combined_json('亲亲，您选的是枕套。'), 'fixture'))
        with patch('app.pipeline.generate_with_provider', provider):
            await build_reply(ReplyRequest(message='我买的规格是什么', platform='qianniu', customer_orders=orders,
                allow_auto_send=False))
        self.assertEqual(provider.await_count, 1)
        for call in provider.call_args_list:
            self.assertIn('5127248019328012543', call.kwargs['user'])
            self.assertIn('50x160', call.kwargs['user'])
            self.assertIn('order_amount 不是 paid_amount', call.kwargs['user'])
            self.assertIn('dynamic_fields_fresh=false', call.kwargs['user'])
            self.assertIn('同时完成意图判断', call.kwargs['system'])

    async def test_qianniu_details_generate_without_document_base_and_preserve_conditions(self):
        details = [{'product_id': '123', 'title': 'Pillow', 'observed_at': '2026-09-14T03:06:45Z',
            'source': 'qianniu_product_detail_v1', 'dynamic_fields_fresh': False,
            'review_status': 'unreviewed', 'skus': [{'sku_id': '1', 'specification': 'Cover only'}],
            'services': [{'name': 'Return', 'description': 'Only if unused'}]}]
        for only_card in (False, True):
            response = (
                json.dumps({'answerable': True, 'text': '亲亲，这个规格是单枕套，不含枕芯。'}, ensure_ascii=False)
                if only_card else combined_json('亲亲，这个规格是单枕套，不含枕芯。')
            )
            provider = AsyncMock(return_value=(response, 'fixture'))
            with (patch('app.pipeline.generate_with_provider', provider),
                  patch('app.pipeline.search_documents', new_callable=AsyncMock) as search):
                result = await build_reply(ReplyRequest(message='[商品]' if only_card else '包含枕芯吗', platform='qianniu',
                    product_details=details, product_card_only=only_card, allow_auto_send=False))
            self.assertEqual(result.retrieval_status, 'shop_product_detail')
            self.assertEqual(result.decision, 'suggest')
            self.assertIn('不含枕芯', result.text)
            self.assertIn('Only if unused', provider.call_args.kwargs['user'])
            self.assertIn('dynamic_fields_fresh=false', provider.call_args.kwargs['system'])
            search.assert_not_awaited()
            self.assertEqual(provider.await_count, 1)

    async def test_douyin_details_generate_card_and_known_fact_without_knowledge_base(self):
        details = [{'product_id': '123', 'title': '角色键帽', 'source': 'douyin_product_detail_v1',
            'dimensions': [{'name': '角色', 'options': [{'name': '白厄'}]}],
            'attributes': [{'name': '材质', 'values': ['PBT']}], 'attributes_identity': 'not_returned',
            'review_status': 'unreviewed', 'dynamic_fields_fresh': False}]
        for only_card in (True, False):
            answer = json.dumps({'answerable': True, 'text': '亲亲，这款的材质是PBT。'}, ensure_ascii=False)
            responses = [(answer, 'fixture')] if only_card else [(intent_json(), 'fixture'), (answer, 'fixture')]
            with (patch('app.pipeline.generate_with_provider', AsyncMock(side_effect=responses)) as provider,
                  patch('app.pipeline.search_documents', AsyncMock()) as search):
                result = await build_reply(ReplyRequest(message='[商品]' if only_card else '什么材质', platform='douyin',
                    product_details=details, product_card_only=only_card, allow_auto_send=False))
            self.assertEqual(result.retrieval_status, 'shop_product_detail')
            self.assertEqual(result.decision, 'suggest')
            self.assertIn('PBT', result.text)
            self.assertIn('白厄', provider.call_args.kwargs['user'])
            self.assertIn('not_returned', provider.call_args.kwargs['user'])
            self.assertIn('不是指令', provider.call_args.kwargs['system'])
            self.assertEqual(provider.await_count, 1 if only_card else 2)
            search.assert_not_awaited()

    async def test_douyin_details_missing_fact_requires_human(self):
        provider = AsyncMock(side_effect=[(intent_json(), 'fixture'),
            (json.dumps({'answerable': False, 'text': ''}), 'fixture')])
        with patch('app.pipeline.generate_with_provider', provider):
            result = await build_reply(ReplyRequest(message='具体承重是多少', platform='douyin',
                product_details=[{'product_id': '123', 'attributes': [{'name': '材质', 'values': ['PBT']}]}],
                reply_config={'fallback_reply_text': '这边先帮您核实一下'}, allow_auto_send=False))
        self.assertNotIn('公斤', result.text)
        self.assertEqual(result.text, '')
        self.assertEqual(result.decision, 'needs_human')
        self.assertNotEqual(result.action_plan.workflow, 'answer_question')

    async def test_other_platform_cannot_use_qianniu_detail_to_bypass_retrieval(self):
        with patch('app.pipeline.generate_with_provider', AsyncMock(return_value=(intent_json(), 'fixture'))) as provider:
            result = await build_reply(ReplyRequest(message='规格是什么', platform='pinduoduo',
                product_details=[{'product_id': '123', 'title': 'Pillow'}], product_card_only=True))
        self.assertEqual(result.retrieval_status, 'no_product_base')
        self.assertEqual(provider.await_count, 2)
        self.assertEqual(result.decision, 'needs_human')

    async def test_product_preference_uses_model_direct_reply_on_both_platforms(self) -> None:
        answer = "亲亲，您更喜欢这款的角色主题，还是想再比较其他风格呢？"
        for platform in ("douyin", "pinduoduo"):
            for message in ("你觉得这款怎么样", "这款键帽好看吗"):
                with self.subTest(platform=platform, message=message):
                    request = ReplyRequest(message=message, platform=platform, allow_auto_send=True,
                        platform_context=[{"type": "product", "data": {"title": "角色主题键帽", "price_label": "¥155.00"}}])
                    provider = AsyncMock(return_value=(intent_json("direct_reply", direct_reply_text=answer), "deepseek"))
                    with (patch("app.pipeline.generate_with_provider", provider),
                          patch("app.pipeline.search_documents", new_callable=AsyncMock) as search):
                        result = await build_reply(request)
                    self.assertEqual(result.text, answer)
                    self.assertEqual(result.decision, "auto_send")
                    self.assertEqual(result.intent.reply_route, "direct")
                    self.assertEqual(result.retrieval_status, "not_needed")
                    provider.assert_awaited_once()
                    search.assert_not_awaited()
                    self.assertIn("泛评价", provider.call_args.kwargs["system"])
                    self.assertIn("不能从图片地址臆测外观", provider.call_args.kwargs["system"])
                    self.assertIn("角色主题键帽", provider.call_args.kwargs["user"])

    async def test_product_fact_or_mixed_question_rejects_model_direct_route(self) -> None:
        for platform in ("douyin", "pinduoduo"):
            for message in ("你觉得这款怎么样，有货吗", "这款键帽能装我的键盘吗", "手感怎么样", "这款耐用吗", "这款多少钱"):
                with self.subTest(platform=platform, message=message):
                    provider = AsyncMock(return_value=(intent_json("direct_reply", direct_reply_text="当然可以"), "deepseek"))
                    with patch("app.pipeline.generate_with_provider", provider):
                        result = await build_reply(ReplyRequest(message=message, platform=platform,
                            reply_config={"fallback_reply_text": "亲亲，这边帮您核实一下"}))
                    self.assertEqual(result.intent.reply_route, "retrieve_product")
                    self.assertEqual(result.retrieval_status, "no_product_base")
                    self.assertEqual(result.text, '')
                    if platform == 'douyin':
                        self.assertEqual(result.decision, 'needs_human')

    async def test_preference_is_not_a_keyword_override_for_model_decision(self) -> None:
        for reply in (intent_json(), intent_json("direct_reply", confidence=0.6, direct_reply_text="挺好的")):
            with patch("app.pipeline.generate_with_provider", AsyncMock(return_value=(reply, "deepseek"))):
                result = await build_reply(ReplyRequest(message="你觉得这款怎么样"))
            self.assertEqual(result.intent.reply_route, "retrieve_product")
        with patch("app.pipeline.generate_with_provider", AsyncMock(side_effect=OSError("offline"))):
            result = await build_reply(ReplyRequest(message="你好，这款键帽怎么样"))
        self.assertEqual(result.intent.reply_route, "retrieve_product", "local fallback stays conservative")

    async def test_pdd_custom_order_scene_confirms_default_photo_without_model(self) -> None:
        request = ReplyRequest(
            message="就直接我拍下的这款照片",
            allow_auto_send=True,
            reply_config={
                "platform_rule_scene": {
                    "type": "pdd_custom_order_confirmation",
                    "prompt_text": "你刚刚拼单的商品为定制商品，需要确认定制方案哦~",
                    "supplement_text": "亲亲，如果您不需要额外定制，默认是按您下单时选择的那款商品图安排制作发货~",
                },
            },
        )

        result = await build_reply(request)

        self.assertEqual(result.decision, "auto_send")
        self.assertEqual(result.provider, "pdd-custom-order-rule")
        self.assertEqual(result.action_plan.workflow, "pdd_custom_order_confirmation")
        self.assertEqual(
            result.text,
            "好的亲亲，如果您不需要额外定制，默认是按您下单时选择的那款商品图安排制作发货~",
        )
        self.assertEqual(result.model_calls["intent"], "skipped-pdd-custom-order")

    async def test_pdd_custom_order_scene_explains_confirmation_without_model(self) -> None:
        request = ReplyRequest(
            message="确认什么定制",
            allow_auto_send=True,
            reply_config={
                "platform_rule_scene": {
                    "type": "pdd_custom_order_confirmation",
                    "prompt_text": "你刚刚拼单的商品为定制商品，需要确认定制方案哦~",
                    "supplement_text": "亲亲，如果您不需要额外定制，默认是按您下单时选择的那款商品图安排制作发货~",
                },
            },
        )

        result = await build_reply(request)

        self.assertEqual(result.decision, "auto_send")
        self.assertEqual(result.provider, "pdd-custom-order-rule")
        self.assertEqual(
            result.text,
            "亲亲，如果您不需要额外定制，默认是按您下单时选择的那款商品图安排制作发货~",
        )

    async def test_tone_persona_uses_enabled_tone_base(self) -> None:
        with patch(
            "app.pipeline.get_knowledge_base",
            AsyncMock(return_value={"kind": "tone", "enabled": True, "persona": "  亲切、耐心  "}),
        ):
            self.assertEqual(await _tone_persona("tone-1", "token"), "亲切、耐心")

    async def test_tone_persona_ignores_disabled_or_wrong_kind_base(self) -> None:
        for value in (
            {"kind": "tone", "enabled": False, "persona": "不应使用"},
            {"kind": "product", "enabled": True, "persona": "不应使用"},
        ):
            with self.subTest(value=value), patch(
                "app.pipeline.get_knowledge_base",
                AsyncMock(return_value=value),
            ):
                    self.assertEqual(await _tone_persona("tone-1", "token"), "")

    async def test_generation_system_prompt_contains_bound_tone_persona(self) -> None:
        request = ReplyRequest(
            message="商品有现货吗",
            product_base_ids=["product-1"],
            tone_base_id="tone-1",
            reply_config={
                "base_style": "随和",
                "answer_length": "简要",
                "customer_address": "小伙伴",
                "self_address": "小助手",
                "advanced_instruction": "每次回复最多两句话",
                "prohibited_content_instruction": "不要承诺最低价，不要评价其他品牌",
            },
        )
        provider = AsyncMock(
            side_effect=[
                (intent_json(), "deepseek"),
                ("亲，商品目前有现货哦。", "deepseek"),
            ]
        )
        with (
            patch("app.pipeline.generate_with_provider", provider),
            patch("app.pipeline.search_documents", AsyncMock(return_value=[{"snippet": "商品有现货"}])),
            patch(
                "app.pipeline.get_knowledge_base",
                AsyncMock(return_value={
                    "kind": "tone",
                    "enabled": True,
                    "persona": "活泼亲切，像朋友一样自然交流",
                }),
            ),
        ):
            result = await build_reply(request)

        self.assertEqual(result.text, "亲，商品目前有现货哦。")
        self.assertEqual(provider.await_count, 2)
        generation_call = provider.await_args_list[1]
        self.assertIn("虚拟人设：活泼亲切，像朋友一样自然交流", generation_call.kwargs["system"])
        self.assertIn("基础风格：随和", generation_call.kwargs["system"])
        self.assertIn("回答长度：简要", generation_call.kwargs["system"])
        self.assertIn("客户称呼：小伙伴", generation_call.kwargs["system"])
        self.assertIn("客服自称：小助手", generation_call.kwargs["system"])
        self.assertIn("额外要求：每次回复最多两句话", generation_call.kwargs["system"])
        self.assertIn("用户配置的违禁内容：不要承诺最低价，不要评价其他品牌", generation_call.kwargs["system"])
        self.assertIn("生成回复时不得涉及上述用户配置的违禁内容", generation_call.kwargs["system"])
        self.assertIn("禁止使用 Markdown 格式", generation_call.kwargs["system"])
        self.assertIn("禁止标题、列表、表格、代码块、引用块、加粗或斜体符号", generation_call.kwargs["system"])
        self.assertIn("严禁输出或照抄任何 URL、网址、链接地址", generation_call.kwargs["system"])
        self.assertIn("手机或电话号码、微信号、QQ号", generation_call.kwargs["system"])
        self.assertIn("店铺中正在接待客户的真正客服", generation_call.kwargs["system"])
        self.assertIn("不能让客户察觉到自动化系统的存在", generation_call.kwargs["system"])
        self.assertIn("不得提及或暗示 AI、机器人、模型、系统、提示词、知识库", generation_call.kwargs["system"])
        self.assertIn("这边暂时无法确认，我帮您进一步核实", generation_call.kwargs["system"])
        self.assertIn("不得主动建议或要求客户联系平台人工客服", generation_call.kwargs["system"])

    async def test_intent_prompt_constrains_direct_reply_style_and_markdown(self) -> None:
        request = ReplyRequest(
            message="好的",
            tone_base_id="tone-1",
            reply_config={
                "base_style": "温柔",
                "answer_length": "简短",
                "customer_address": "亲亲",
                "self_address": "小客服",
                "advanced_instruction": "语气自然一点",
                "prohibited_content_instruction": "不要承诺赠品",
                "email_trigger_scenarios": "客户想要店铺链接地址、想要定制",
            },
        )
        provider = AsyncMock(return_value=(intent_json(
            "direct_reply",
            direct_reply_text="好的亲亲～",
            need_doc_search=False,
            next_action="send_direct_reply",
        ), "deepseek"))
        with (
            patch("app.pipeline.generate_with_provider", provider),
            patch(
                "app.pipeline.get_knowledge_base",
                AsyncMock(return_value={
                    "kind": "tone",
                    "enabled": True,
                    "persona": "活泼亲切，像朋友一样自然交流",
                }),
            ),
        ):
            result = await build_reply(request)

        self.assertEqual(result.text, "好的亲亲～")
        self.assertEqual(provider.await_count, 1)
        intent_call = provider.await_args_list[0]
        self.assertIn("direct_reply_text 是最终可发送给客户的内容", intent_call.kwargs["system"])
        self.assertIn("必须遵守基础风格、回答长度、客户称呼、客服自称、虚拟人设和额外要求", intent_call.kwargs["system"])
        self.assertIn("禁止 Markdown 格式", intent_call.kwargs["system"])
        self.assertIn("禁止标题、列表、表格、代码块、引用块、加粗或斜体符号", intent_call.kwargs["system"])
        self.assertIn("严禁输出或照抄任何 URL、网址、链接地址", intent_call.kwargs["system"])
        self.assertIn("虚拟人设：活泼亲切，像朋友一样自然交流", intent_call.kwargs["user"])
        self.assertIn("基础风格：温柔", intent_call.kwargs["user"])
        self.assertIn("客服自称：小客服", intent_call.kwargs["user"])
        self.assertIn("用户配置的违禁内容：不要承诺赠品", intent_call.kwargs["user"])
        self.assertIn("生成回复时不得涉及上述用户配置的违禁内容", intent_call.kwargs["user"])
        self.assertNotIn("邮件触发场景", intent_call.kwargs["user"])
        self.assertNotIn("客户想要店铺链接地址、想要定制", intent_call.kwargs["user"])
        self.assertIn("不能根据宽泛的业务关键词自行进入邮件流程", intent_call.kwargs["system"])
        self.assertIn("店铺中正在接待客户的真正客服", intent_call.kwargs["system"])
        self.assertIn("不能让客户察觉到自动化系统的存在", intent_call.kwargs["system"])
        self.assertIn("不得说“知识库中没有”“未检索到”“无法访问知识库”", intent_call.kwargs["system"])
        self.assertIn("不得主动建议或要求客户联系平台人工客服", intent_call.kwargs["system"])

    async def test_generation_prompt_includes_document_title_path(self) -> None:
        request = ReplyRequest(
            message="可以来图定制吗",
            product_base_ids=["product-1"],
        )
        provider = AsyncMock(
            side_effect=[
                (intent_json(), "deepseek"),
                ("可以的亲亲，支持来图定制，确认设计后会安排制作。", "deepseek"),
            ]
        )
        with (
            patch("app.pipeline.generate_with_provider", provider),
            patch(
                "app.pipeline.search_documents",
                AsyncMock(return_value=[{
                    "source_title": "小源抱枕知识-产品知识库导入版.docx",
                    "title_path": "商品介绍：高品质定制抱枕 / 枕套 > 专属定制",
                    "snippet": "支持来图定制，设计确认后安排加急制作。",
                }]),
            ),
            patch("app.pipeline.get_knowledge_base", AsyncMock(return_value={})),
        ):
            result = await build_reply(request)

        self.assertEqual(result.retrieval_status, "hit")
        generation_call = provider.await_args_list[1]
        self.assertIn(
            "[1] 小源抱枕知识-产品知识库导入版.docx / 商品介绍：高品质定制抱枕 / 枕套 > 专属定制：支持来图定制",
            generation_call.kwargs["user"],
        )

    def test_default_fallback_uses_store_agent_voice_without_internal_disclosure(self) -> None:
        request = ReplyRequest(message="这个活动有什么优惠")
        from app.pipeline import _fallback_reply

        fallback = _fallback_reply(request)
        self.assertIn("我帮您进一步核实", fallback)
        self.assertNotIn("知识库", fallback)
        self.assertNotIn("机器人", fallback)
        self.assertNotIn("平台人工客服", fallback)

    async def test_qa_hit_short_circuits_both_model_calls(self) -> None:
        request = ReplyRequest(
            message="怎么退款",
            qa_base_ids=["qa-1"],
            product_base_ids=["product-1"],
            allow_auto_send=True,
        )
        qa_result = {
            "matched": True,
            "match_type": "exact",
            "score": 1.0,
            "entry": {"id": "entry-1", "answer": "这是确定性答案", "image_url": ""},
        }
        with (
            patch("app.pipeline.match_qa", AsyncMock(return_value=qa_result)),
            patch("app.pipeline.search_documents", AsyncMock()) as search_mock,
            patch("app.pipeline.generate_with_provider", AsyncMock()) as provider_mock,
        ):
            result = await build_reply(request)

        self.assertEqual(result.decision, "auto_send")
        self.assertEqual(result.provider, "qa-rule")
        self.assertEqual(result.intent.intent, "qa_match")
        self.assertEqual(result.qa_match["status"], "hit")
        self.assertEqual(result.model_calls, {"intent": "skipped", "generation": "skipped"})
        search_mock.assert_not_awaited()
        provider_mock.assert_not_awaited()

    async def test_legacy_block_words_do_not_filter_qa_answers(self) -> None:
        request = ReplyRequest(
            message="多少钱",
            qa_base_ids=["qa-1"],
            allow_auto_send=True,
            reply_config={
                "outbound_block_words": ["绝对"],
                "fallback_reply_text": "我先帮您核实一下",
            },
        )
        with (
            patch("app.pipeline.match_qa", AsyncMock(return_value={
                "matched": True,
                "match_type": "exact",
                "score": 1.0,
                "entry": {"id": "entry-1", "answer": "这是绝对最低价", "image_url": ""},
            })),
            patch("app.pipeline.generate_with_provider", AsyncMock()) as provider_mock,
        ):
            result = await build_reply(request)

        self.assertEqual(result.text, "这是绝对最低价")
        self.assertEqual(result.provider, "qa-rule")
        self.assertNotIn("outbound_block_word", result.risk_flags)
        provider_mock.assert_not_awaited()

    async def test_qa_answer_with_link_uses_safe_fallback_and_drops_media(self) -> None:
        request = ReplyRequest(
            message="安装说明在哪里",
            qa_base_ids=["qa-1"],
            allow_auto_send=True,
            reply_config={"fallback_reply_text": "亲亲，我先为您核实一下"},
        )
        with patch("app.pipeline.match_qa", AsyncMock(return_value={
            "matched": True,
            "match_type": "exact",
            "score": 1.0,
            "entry": {
                "id": "entry-1",
                "answer": "请访问 https://outside.example.com/install 查看",
                "image_url": "https://example.com/product.png",
            },
        })):
            result = await build_reply(request)

        self.assertEqual(result.text, "亲亲，我先为您核实一下")
        self.assertEqual(result.media, [])
        self.assertIn("prohibited_outbound_content", result.risk_flags)
        self.assertIn("external_link", result.risk_flags)

    async def test_generated_personal_contact_uses_safe_fallback(self) -> None:
        request = ReplyRequest(
            message="怎么联系",
            product_base_ids=["product-1"],
            allow_auto_send=True,
            reply_config={"fallback_reply_text": "亲亲，我先为您核实一下"},
        )
        provider = AsyncMock(side_effect=[
            (intent_json(), "deepseek"),
            ("请加微信 service_123 咨询", "deepseek"),
        ])
        with (
            patch("app.pipeline.generate_with_provider", provider),
            patch("app.pipeline.search_documents", AsyncMock(return_value=[{"snippet": "联系售后"}])),
            patch("app.pipeline.get_knowledge_base", AsyncMock(return_value={})),
        ):
            result = await build_reply(request)

        self.assertEqual(result.text, "亲亲，我先为您核实一下")
        self.assertIn("wechat_id", result.risk_flags)

    async def test_generated_internal_disclosure_uses_store_agent_fallback(self) -> None:
        request = ReplyRequest(
            message="这个商品有什么优惠",
            product_base_ids=["product-1"],
            allow_auto_send=True,
        )
        provider = AsyncMock(side_effect=[
            (intent_json(), "deepseek"),
            ("知识库中暂时没有相关优惠信息，建议联系平台人工客服。", "deepseek"),
        ])
        with (
            patch("app.pipeline.generate_with_provider", provider),
            patch("app.pipeline.search_documents", AsyncMock(return_value=[{"snippet": "优惠以页面为准"}])),
            patch("app.pipeline.get_knowledge_base", AsyncMock(return_value={})),
        ):
            result = await build_reply(request)

        self.assertEqual(result.text, "亲亲，这个问题这边暂时无法确认，我帮您进一步核实，请稍等~")
        self.assertIn("identity_disclosure", result.risk_flags)
        self.assertIn("internal_knowledge", result.risk_flags)

    async def test_qa_internal_disclosure_is_not_sent(self) -> None:
        request = ReplyRequest(
            message="有优惠吗",
            qa_base_ids=["qa-1"],
            allow_auto_send=True,
        )
        with patch("app.pipeline.match_qa", AsyncMock(return_value={
            "matched": True,
            "match_type": "exact",
            "score": 1.0,
            "entry": {
                "id": "entry-1",
                "answer": "机器人暂时无法从知识库中查到优惠。",
                "image_url": "",
            },
        })):
            result = await build_reply(request)

        self.assertIn("我帮您进一步核实", result.text)
        self.assertIn("identity_disclosure", result.risk_flags)
        self.assertNotIn("知识库", result.text)
        self.assertNotIn("机器人", result.text)

    async def test_explicit_human_handoff_reply_remains_allowed(self) -> None:
        provider = AsyncMock(return_value=(intent_json(
            "human_handoff",
            direct_reply_text="好的亲亲，正在为您转接人工客服，请稍等～",
        ), "deepseek"))
        with patch("app.pipeline.generate_with_provider", provider):
            result = await build_reply(ReplyRequest(message="转人工", allow_auto_send=True))

        self.assertEqual(result.text, "好的亲亲，正在为您转接人工客服，请稍等～")
        self.assertNotIn("identity_disclosure", result.risk_flags)

    async def test_transfer_to_agent_uses_human_handoff_logic(self) -> None:
        result = await build_reply(ReplyRequest(message="转客服", allow_auto_send=True))

        self.assertEqual(result.text, "好的亲亲，正在为您转接人工客服，请稍等～")
        self.assertEqual(result.intent.reply_route, "human_handoff")
        self.assertEqual(result.action_plan.workflow, "human_review")
        self.assertIn("转客服", result.risk_flags)
        self.assertEqual(result.model_calls["intent"], "local-fallback")

    async def test_unsafe_fallback_escalates_instead_of_sending(self) -> None:
        request = ReplyRequest(
            message="联系方式",
            qa_base_ids=["qa-1"],
            allow_auto_send=True,
            reply_config={"fallback_reply_text": "电话：13800138000"},
        )
        with patch("app.pipeline.match_qa", AsyncMock(return_value={
            "matched": True,
            "match_type": "exact",
            "score": 1.0,
            "entry": {"id": "entry-1", "answer": "邮箱 service@example.com", "image_url": ""},
        })):
            result = await build_reply(request)

        self.assertEqual(result.decision, "needs_human")
        self.assertEqual(result.text, "")
        self.assertIn("fallback_blocked", result.risk_flags)

    async def test_legacy_replacement_rules_do_not_modify_qa_answers(self) -> None:
        request = ReplyRequest(
            message="什么时候发货",
            qa_base_ids=["qa-1"],
            allow_auto_send=True,
            reply_config={
                "outbound_block_rules": [
                    {"word": "你好", "replacement": "您好", "enabled": True},
                ],
            },
        )
        with (
            patch("app.pipeline.match_qa", AsyncMock(return_value={
                "matched": True,
                "match_type": "exact",
                "score": 1.0,
                "entry": {
                    "id": "entry-1",
                    "answer": "你好，你好，下单后三天内发货哦",
                    "image_url": "https://example.com/product.png",
                },
            })),
            patch("app.pipeline.generate_with_provider", AsyncMock()) as provider_mock,
        ):
            result = await build_reply(request)

        self.assertEqual(result.text, "你好，你好，下单后三天内发货哦")
        self.assertEqual(result.provider, "qa-rule")
        self.assertEqual(result.media, [{"type": "image", "url": "https://example.com/product.png"}])
        self.assertNotIn("outbound_block_replaced", result.risk_flags)
        provider_mock.assert_not_awaited()

    async def test_qa_relative_image_uses_public_knowledge_base_url(self) -> None:
        request = ReplyRequest(message="看图片", qa_base_ids=["qa-1"])
        with (
            patch("app.pipeline.match_qa", AsyncMock(return_value={
                "matched": True,
                "match_type": "exact",
                "score": 1.0,
                "entry": {
                    "id": "entry-1",
                    "answer": "请看图片",
                    "image_url": "/qa-assets/qa-example.png",
                },
            })),
            patch("app.pipeline.get_settings") as settings_mock,
        ):
            settings_mock.return_value.knowledge_base_url = "http://knowledge-base:8010"
            settings_mock.return_value.knowledge_base_public_url = (
                "http://43.139.142.142/kb-api"
            )
            result = await build_reply(request)

        self.assertEqual(result.media, [{
            "type": "image",
            "url": "http://43.139.142.142/kb-api/api/v1/qa-assets/qa-example.png",
        }])

    async def test_legacy_replacement_rules_do_not_force_human_review(self) -> None:
        request = ReplyRequest(
            message="什么时候发货",
            qa_base_ids=["qa-1"],
            allow_auto_send=True,
            reply_config={
                "outbound_block_rules": [
                    {"word": "你好", "replacement": "您好"},
                    {"word": "您好", "replacement": "尊敬的客户"},
                ],
            },
        )
        with patch("app.pipeline.match_qa", AsyncMock(return_value={
            "matched": True,
            "match_type": "exact",
            "score": 1.0,
            "entry": {"id": "entry-1", "answer": "你好", "image_url": ""},
        })):
            result = await build_reply(request)

        self.assertEqual(result.decision, "auto_send")
        self.assertEqual(result.text, "你好")
        self.assertNotIn("replacement_blocked", result.risk_flags)

    async def test_legacy_replacement_order_no_longer_changes_answers(self) -> None:
        request = ReplyRequest(
            message="什么时候发货",
            qa_base_ids=["qa-1"],
            allow_auto_send=True,
            reply_config={
                "outbound_block_rules": [
                    {"word": "你好", "replacement": "您好"},
                    {"word": "你好呀", "replacement": "您好呀"},
                ],
            },
        )
        with patch("app.pipeline.match_qa", AsyncMock(return_value={
            "matched": True,
            "match_type": "exact",
            "score": 1.0,
            "entry": {"id": "entry-1", "answer": "你好呀，请问需要什么", "image_url": ""},
        })):
            result = await build_reply(request)

        self.assertEqual(result.text, "你好呀，请问需要什么")
        self.assertEqual(result.decision, "auto_send")

    async def test_empty_product_retrieval_generates_from_context(self) -> None:
        request = ReplyRequest(
            message="商品有什么规格",
            product_base_ids=["product-1"],
            allow_auto_send=True,
            reply_config={"fallback_reply_text": "请稍等，客服正在核实"},
        )
        provider = AsyncMock(side_effect=[
            (intent_json(), "deepseek"),
            ("亲亲，这款商品规格我帮您看一下，具体以页面选项为准~", "deepseek"),
        ])
        with (
            patch("app.pipeline.search_documents", AsyncMock(return_value=[])),
            patch("app.pipeline.generate_with_provider", provider),
            patch("app.pipeline.get_knowledge_base", AsyncMock(return_value={})),
        ):
            result = await build_reply(request)

        self.assertEqual(result.text, "亲亲，这款商品规格我帮您看一下，具体以页面选项为准~")
        self.assertEqual(result.provider, "deepseek")
        self.assertEqual(result.retrieval_status, "empty")
        self.assertEqual(result.model_calls["generation"], "deepseek")
        self.assertEqual(provider.await_count, 2)

    async def test_qa_miss_runs_intent_search_and_generation_in_order(self) -> None:
        request = ReplyRequest(
            message="商品有什么规格",
            qa_base_ids=["qa-1"],
            product_base_ids=["product-1"],
            allow_auto_send=True,
        )
        provider = AsyncMock(
            side_effect=[
                (intent_json(), "deepseek"),
                ("这款商品有三种规格。", "deepseek"),
            ]
        )
        with (
            patch(
                "app.pipeline.match_qa",
                AsyncMock(return_value={"matched": False, "match_type": "none", "score": 0.0}),
            ),
            patch(
                "app.pipeline.search_documents",
                AsyncMock(return_value=[{"snippet": "商品提供大中小三种规格"}]),
            ) as search_mock,
            patch("app.pipeline.generate_with_provider", provider),
            patch("app.pipeline.get_knowledge_base", AsyncMock(return_value={})),
        ):
            result = await build_reply(request)

        self.assertEqual(result.qa_match["status"], "miss")
        self.assertEqual(result.intent.intent, "normal_question")
        self.assertEqual(result.action_plan.next_action, "search_product_documents")
        self.assertEqual(result.decision, "auto_send")
        self.assertEqual(result.text, "这款商品有三种规格。")
        search_mock.assert_awaited_once_with("商品有什么规格", ["product-1"], "")
        self.assertEqual(provider.await_count, 2)
        self.assertTrue(provider.await_args_list[0].kwargs["json_mode"])
        self.assertEqual(provider.await_args_list[0].kwargs["temperature"], 0)
        self.assertNotIn("json_mode", provider.await_args_list[1].kwargs)

    async def test_email_intent_does_not_search_or_generate_reply(self) -> None:
        request = ReplyRequest(message="把看图链接发我邮箱", product_base_ids=["product-1"])
        provider = AsyncMock(
            return_value=(
                intent_json(
                    "email_link_request",
                    need_doc_search=False,
                    need_email=True,
                    workflow="collect_email_for_link",
                    next_action="defer_email_workflow",
                    missing_slots=["email"],
                ),
                "deepseek",
            )
        )
        with (
            patch("app.pipeline.search_documents", AsyncMock()) as search_mock,
            patch("app.pipeline.generate_with_provider", provider),
        ):
            result = await build_reply(request)

        self.assertEqual(result.decision, "suggest")
        self.assertEqual(result.text, "")
        self.assertEqual(result.action_plan.next_action, "defer_email_workflow")
        self.assertNotIn("send_email_before_stage_d", result.action_plan.blocked_actions)
        self.assertIn("send_external_link_in_chat", result.action_plan.blocked_actions)
        search_mock.assert_not_awaited()
        self.assertEqual(provider.await_count, 1)

    async def test_email_intent_accepts_only_declared_template_suggestion(self) -> None:
        request = ReplyRequest(
            message="把安装资料发我邮箱",
            email_templates=[
                {
                    "id": "template-1",
                    "template_key": "install-doc",
                    "name": "安装资料",
                    "scene": "document",
                    "aliases": ["安装说明"],
                }
            ],
        )
        provider = AsyncMock(
            return_value=(
                intent_json(
                    "email_link_request",
                    need_doc_search=False,
                    need_email=True,
                    workflow="collect_email_for_link",
                    next_action="defer_email_workflow",
                    missing_slots=["email"],
                    template_id="template-1",
                    template_key="install-doc",
                ),
                "deepseek",
            )
        )
        with patch("app.pipeline.generate_with_provider", provider):
            result = await build_reply(request)

        self.assertEqual(result.intent.intent, "email_link_request")
        self.assertEqual(result.intent.template_id, "template-1")
        self.assertEqual(result.intent.template_key, "install-doc")
        self.assertIn("安装资料", provider.await_args.kwargs["user"])

    async def test_email_intent_drops_unknown_template_suggestion(self) -> None:
        request = ReplyRequest(
            message="把安装资料发我邮箱",
            email_templates=[{"id": "template-1", "template_key": "install-doc", "name": "安装资料"}],
        )
        provider = AsyncMock(
            return_value=(
                intent_json(
                    "email_link_request",
                    need_doc_search=False,
                    need_email=True,
                    workflow="collect_email_for_link",
                    next_action="defer_email_workflow",
                    template_id="fake-id",
                    template_key="fake-key",
                ),
                "deepseek",
            )
        )
        with patch("app.pipeline.generate_with_provider", provider):
            result = await build_reply(request)

        self.assertEqual(result.intent.template_id, "")
        self.assertEqual(result.intent.template_key, "")

    async def test_local_fallback_ignores_legacy_email_trigger_scenarios(self) -> None:
        request = ReplyRequest(
            message="客户想要定制",
            reply_config={"email_trigger_scenarios": "客户想要定制"},
        )
        provider = AsyncMock(side_effect=RuntimeError("model unavailable"))

        with patch("app.pipeline.generate_with_provider", provider):
            result = await build_reply(request)

        self.assertEqual(result.intent.intent, "normal_question")
        self.assertNotEqual(result.action_plan.workflow, "collect_email_for_link")
        self.assertEqual(result.model_calls["intent"], "local-fallback")

    async def test_direct_reply_intent_returns_first_model_text_without_second_model_call(self) -> None:
        request = ReplyRequest(message="好的，谢谢")
        provider = AsyncMock(
            return_value=(
                intent_json(
                    "direct_reply",
                    direct_reply_text="不客气亲亲，很高兴能帮到您～",
                    need_doc_search=False,
                    next_action="send_direct_reply",
                ),
                "deepseek",
            )
        )
        with patch("app.pipeline.generate_with_provider", provider):
            result = await build_reply(request)

        self.assertEqual(result.decision, "suggest")
        self.assertEqual(result.text, "不客气亲亲，很高兴能帮到您～")
        self.assertEqual(result.retrieval_status, "not_needed")
        self.assertEqual(provider.await_count, 1)

    async def test_product_question_cannot_use_direct_route(self) -> None:
        request = ReplyRequest(message="这个键帽能装我的键盘吗", product_base_ids=["product-1"])
        provider = AsyncMock(side_effect=[
            (intent_json(
                "direct_reply",
                direct_reply_text="可以安装",
                confidence=0.99,
            ), "deepseek"),
            ("亲亲，这个需要看您的键盘规格，我帮您按页面信息核实一下~", "deepseek"),
        ])
        with (
            patch("app.pipeline.generate_with_provider", provider),
            patch("app.pipeline.search_documents", AsyncMock(return_value=[])) as search_mock,
        ):
            result = await build_reply(request)

        self.assertEqual(result.intent.intent, "normal_question")
        self.assertEqual(result.retrieval_status, "empty")
        self.assertEqual(result.model_calls["generation"], "deepseek")
        search_mock.assert_awaited_once()

    async def test_low_confidence_direct_route_uses_conservative_retrieval(self) -> None:
        request = ReplyRequest(message="能用吗", product_base_ids=["product-1"])
        provider = AsyncMock(side_effect=[
            (intent_json(
                "direct_reply",
                direct_reply_text="可以",
                confidence=0.6,
            ), "deepseek"),
            ("亲亲，这个要结合具体型号确认，我帮您看一下~", "deepseek"),
        ])
        with (
            patch("app.pipeline.generate_with_provider", provider),
            patch("app.pipeline.search_documents", AsyncMock(return_value=[])) as search_mock,
        ):
            result = await build_reply(request)

        self.assertEqual(result.intent.reply_route, "retrieve_product")
        self.assertEqual(result.retrieval_status, "empty")
        self.assertEqual(result.model_calls["generation"], "deepseek")
        search_mock.assert_awaited_once()

    async def test_product_route_without_bound_base_reports_configuration_gap(self) -> None:
        provider = AsyncMock(return_value=(intent_json(), "deepseek"))
        with patch("app.pipeline.generate_with_provider", provider):
            result = await build_reply(ReplyRequest(message="商品有什么规格"))

        self.assertEqual(result.retrieval_status, "no_product_base")
        self.assertEqual(result.model_calls["generation"], "skipped-no-retrieval")
        self.assertEqual(provider.await_count, 1)

    async def test_retrieval_failure_is_distinct_from_empty_result(self) -> None:
        provider = AsyncMock(return_value=(intent_json(), "deepseek"))
        with (
            patch("app.pipeline.generate_with_provider", provider),
            patch("app.pipeline.search_documents", AsyncMock(side_effect=RuntimeError("offline"))),
        ):
            result = await build_reply(ReplyRequest(
                message="商品有什么规格",
                product_base_ids=["product-1"],
            ))

        self.assertEqual(result.retrieval_status, "unavailable")
        self.assertEqual(result.model_calls["generation"], "skipped-no-retrieval")

    async def test_human_handoff_sends_acknowledgement_without_second_model_call(self) -> None:
        provider = AsyncMock(return_value=(intent_json(
            "human_handoff",
            direct_reply_text="好的亲亲，正在为您转接人工客服，请稍等～",
        ), "deepseek"))
        with patch("app.pipeline.generate_with_provider", provider):
            result = await build_reply(ReplyRequest(message="转人工", allow_auto_send=True))

        self.assertEqual(result.decision, "auto_send")
        self.assertEqual(result.intent.reply_route, "human_handoff")
        self.assertTrue(result.text)
        self.assertIn("mark_needs_human", result.action_plan.required_actions)
        self.assertEqual(provider.await_count, 1)

    async def test_intent_parse_failure_uses_local_fallback_then_generates(self) -> None:
        request = ReplyRequest(message="普通咨询", product_base_ids=["product-1"])
        provider = AsyncMock(side_effect=[("not-json", "deepseek"), ("生成回复", "deepseek")])
        with (
            patch("app.pipeline.generate_with_provider", provider),
            patch("app.pipeline.search_documents", AsyncMock(return_value=[{"snippet": "知识片段"}])),
        ):
            result = await build_reply(request)

        self.assertEqual(result.intent.intent, "normal_question")
        self.assertEqual(result.model_calls["intent"], "local-fallback")
        self.assertEqual(result.text, "生成回复")
        self.assertEqual(provider.await_count, 2)

    async def test_qa_unavailable_is_distinct_from_miss(self) -> None:
        request = ReplyRequest(message="普通咨询", qa_base_ids=["qa-1"])
        provider = AsyncMock(side_effect=[(intent_json(), "deepseek"), ("生成回复", "deepseek")])
        with (
            patch("app.pipeline.match_qa", AsyncMock(side_effect=RuntimeError("offline"))),
            patch("app.pipeline.generate_with_provider", provider),
        ):
            result = await build_reply(request)

        self.assertEqual(result.qa_match["status"], "unavailable")
        self.assertEqual(result.qa_match["match_type"], "unavailable")

    def test_conversation_prompt_uses_history_without_duplicating_latest_message(self) -> None:
        request = ReplyRequest(
            message="现在有货吗",
            conversation=[
                {"role": "user", "content": "你好"},
                {"role": "assistant", "content": "您好"},
                {"role": "user", "content": "现在有货吗"},
            ],
        )
        prompt = conversation_prompt(request)
        self.assertEqual(prompt.count("客户：现在有货吗"), 1)
        self.assertIn("客服：您好", prompt)


if __name__ == "__main__":
    unittest.main()
