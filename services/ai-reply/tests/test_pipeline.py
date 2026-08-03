from __future__ import annotations

import json
import unittest
from unittest.mock import AsyncMock, patch

from app.pipeline import _tone_persona, build_reply, conversation_prompt
from app.schemas import ReplyRequest


def intent_json(intent: str = "normal_question", **overrides: object) -> str:
    payload = {
        "intent": intent,
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

    async def test_no_reply_intent_returns_without_second_model_call(self) -> None:
        request = ReplyRequest(message="好的，谢谢")
        provider = AsyncMock(
            return_value=(
                intent_json(
                    "no_reply_needed",
                    need_customer_reply=False,
                    need_doc_search=False,
                    next_action="finish_without_reply",
                ),
                "deepseek",
            )
        )
        with patch("app.pipeline.generate_with_provider", provider):
            result = await build_reply(request)

        self.assertEqual(result.decision, "no_reply")
        self.assertEqual(result.text, "")
        self.assertEqual(provider.await_count, 1)

    async def test_intent_parse_failure_uses_local_fallback_then_generates(self) -> None:
        request = ReplyRequest(message="普通咨询")
        provider = AsyncMock(side_effect=[("not-json", "deepseek"), ("生成回复", "deepseek")])
        with patch("app.pipeline.generate_with_provider", provider):
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
