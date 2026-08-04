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


class PipelineTests(unittest.IsolatedAsyncioTestCase):
    async def test_tone_persona_uses_enabled_tone_base(self) -> None:
        with patch(
            "app.pipeline.get_knowledge_base",
            AsyncMock(return_value={"kind": "tone", "enabled": True, "persona": "  亲切、耐心  "}),
        ):
            self.assertEqual(await _tone_persona("tone-1"), "亲切、耐心")

    async def test_tone_persona_ignores_disabled_or_wrong_kind_base(self) -> None:
        for value in (
            {"kind": "tone", "enabled": False, "persona": "不应使用"},
            {"kind": "product", "enabled": True, "persona": "不应使用"},
        ):
            with self.subTest(value=value), patch(
                "app.pipeline.get_knowledge_base",
                AsyncMock(return_value=value),
            ):
                self.assertEqual(await _tone_persona("tone-1"), "")

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

    async def test_qa_answer_containing_block_word_uses_configured_fallback(self) -> None:
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

        self.assertEqual(result.text, "我先帮您核实一下")
        self.assertEqual(result.provider, "outbound-block-fallback")
        self.assertIn("outbound_block_word", result.risk_flags)
        provider_mock.assert_not_awaited()

    async def test_qa_answer_replaces_block_word_and_preserves_media(self) -> None:
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

        self.assertEqual(result.text, "您好，您好，下单后三天内发货哦")
        self.assertEqual(result.provider, "qa-rule")
        self.assertEqual(result.media, [{"type": "image", "url": "https://example.com/product.png"}])
        self.assertIn("outbound_block_replaced", result.risk_flags)
        provider_mock.assert_not_awaited()

    async def test_outbound_replacement_is_single_pass_and_residual_needs_human(self) -> None:
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

        self.assertEqual(result.decision, "needs_human")
        self.assertEqual(result.text, "")
        self.assertIn("replacement_blocked", result.risk_flags)

    async def test_longer_outbound_word_is_replaced_first(self) -> None:
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

        self.assertEqual(result.text, "您好呀，请问需要什么")
        self.assertEqual(result.decision, "auto_send")

    async def test_empty_product_retrieval_uses_fallback_without_generation(self) -> None:
        request = ReplyRequest(
            message="商品有什么规格",
            product_base_ids=["product-1"],
            allow_auto_send=True,
            reply_config={"fallback_reply_text": "请稍等，客服正在核实"},
        )
        provider = AsyncMock(return_value=(intent_json(), "deepseek"))
        with (
            patch("app.pipeline.search_documents", AsyncMock(return_value=[])),
            patch("app.pipeline.generate_with_provider", provider),
            patch("app.pipeline.get_knowledge_base", AsyncMock(return_value={})),
        ):
            result = await build_reply(request)

        self.assertEqual(result.text, "请稍等，客服正在核实")
        self.assertEqual(result.provider, "fallback-rule")
        self.assertEqual(result.model_calls["generation"], "skipped-no-retrieval")
        self.assertEqual(provider.await_count, 1)

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
        search_mock.assert_awaited_once_with("商品有什么规格", ["product-1"])
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

        self.assertEqual(result.decision, "needs_human")
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
        provider = AsyncMock(return_value=(intent_json(
            "direct_reply",
            direct_reply_text="可以安装",
            confidence=0.99,
        ), "deepseek"))
        with (
            patch("app.pipeline.generate_with_provider", provider),
            patch("app.pipeline.search_documents", AsyncMock(return_value=[])) as search_mock,
        ):
            result = await build_reply(request)

        self.assertEqual(result.intent.intent, "normal_question")
        self.assertEqual(result.retrieval_status, "empty")
        self.assertEqual(result.model_calls["generation"], "skipped-no-retrieval")
        search_mock.assert_awaited_once()

    async def test_low_confidence_direct_route_uses_conservative_retrieval(self) -> None:
        request = ReplyRequest(message="能用吗", product_base_ids=["product-1"])
        provider = AsyncMock(return_value=(intent_json(
            "direct_reply",
            direct_reply_text="可以",
            confidence=0.6,
        ), "deepseek"))
        with (
            patch("app.pipeline.generate_with_provider", provider),
            patch("app.pipeline.search_documents", AsyncMock(return_value=[])) as search_mock,
        ):
            result = await build_reply(request)

        self.assertEqual(result.intent.reply_route, "retrieve_product")
        self.assertEqual(result.retrieval_status, "empty")
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
