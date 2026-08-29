from __future__ import annotations

import unittest
from types import SimpleNamespace

from app.services.automation_service import (
    DEFAULT_CONTEXT_LENGTH,
    MAX_CONTEXT_LENGTH,
    _auto_send_allowed,
    _context_length,
    _current_customer_message,
    _history_with_latest,
    _message_history,
    _platform_context,
    _fallback_marks_human_required,
    _human_handoff_strategy,
    _is_fallback_reply,
    _customer_confirms_transfer,
    _matched_sensitive_word,
    _sensitive_words,
    _should_create_send_task,
    _timeout_config,
    _transfer_conversation_enabled,
)


class AutomationConfigTests(unittest.TestCase):
    def robot(self, **config: object) -> SimpleNamespace:
        return SimpleNamespace(config_json=config)

    def test_context_length_uses_robot_config_and_bounds(self) -> None:
        self.assertEqual(_context_length(self.robot()), 10)
        self.assertEqual(_context_length(self.robot(context_length=12)), 12)
        self.assertEqual(_context_length(self.robot(context_length=500)), MAX_CONTEXT_LENGTH)
        self.assertEqual(_context_length(self.robot(context_length=0)), 1)
        self.assertEqual(_context_length(self.robot(context_length="invalid")), DEFAULT_CONTEXT_LENGTH)

    def test_timeout_notice_is_disabled_by_default(self) -> None:
        enabled, seconds, text = _timeout_config(self.robot())
        self.assertFalse(enabled)
        self.assertEqual(seconds, 10)
        self.assertTrue(text)

    def test_auto_send_requires_request_and_robot_switches(self) -> None:
        robot = self.robot(allow_auto_send=True)
        self.assertTrue(_auto_send_allowed(robot, requested=True))
        self.assertFalse(_auto_send_allowed(robot, requested=False))
        self.assertFalse(
            _auto_send_allowed(self.robot(allow_auto_send=False), requested=True)
        )

    def test_sensitive_words_are_normalized_and_matched_case_insensitively(self) -> None:
        robot = self.robot(inbound_sensitive_words=[" 投诉 ", "VIP", "投诉", "", 123])
        self.assertEqual(_sensitive_words(robot), ["投诉", "VIP"])
        self.assertEqual(_matched_sensitive_word(robot, "我要投诉"), "投诉")
        self.assertEqual(_matched_sensitive_word(robot, "vip 客户"), "VIP")
        self.assertIsNone(_matched_sensitive_word(robot, "普通咨询"))

    def test_send_task_requires_auto_send_decision_switch_and_text(self) -> None:
        result = {"decision": "auto_send", "text": "确定性回复"}
        self.assertTrue(_should_create_send_task(result, auto_send_allowed=True))
        self.assertFalse(_should_create_send_task(result, auto_send_allowed=False))
        self.assertFalse(
            _should_create_send_task({"decision": "suggest", "text": "建议回复"}, auto_send_allowed=True)
        )
        self.assertFalse(
            _should_create_send_task({"decision": "auto_send", "text": "  "}, auto_send_allowed=True)
        )

    def test_fallback_human_required_setting_prefers_new_key_and_supports_legacy(self) -> None:
        self.assertTrue(_fallback_marks_human_required(self.robot(fallback_mark_human_required=True)))
        self.assertFalse(_fallback_marks_human_required(self.robot(
            fallback_mark_human_required=False,
            fallback_transfer_to_human=True,
        )))
        self.assertTrue(_fallback_marks_human_required(self.robot(fallback_transfer_to_human=True)))
        self.assertFalse(_fallback_marks_human_required(self.robot()))

    def test_handoff_strategy_defaults_to_mark_only(self) -> None:
        self.assertEqual(_human_handoff_strategy(self.robot()), "mark_only")
        self.assertEqual(
            _human_handoff_strategy(self.robot(human_handoff_strategy="transfer_conversation")),
            "transfer_conversation",
        )
        self.assertEqual(_human_handoff_strategy(self.robot(human_handoff_strategy="unknown")), "mark_only")

    def test_transfer_requires_pdd_uid_and_auto_send(self) -> None:
        conversation = SimpleNamespace(
            platform_code="pinduoduo",
            platform_account_id="account-1",
            external_conversation_id="customer-1",
        )
        robot = self.robot(human_handoff_strategy="transfer_conversation")
        self.assertTrue(_transfer_conversation_enabled(robot, conversation, auto_send_allowed=True))
        self.assertFalse(_transfer_conversation_enabled(robot, conversation, auto_send_allowed=False))
        conversation.external_conversation_id = "name:customer"
        self.assertFalse(_transfer_conversation_enabled(robot, conversation, auto_send_allowed=True))
        conversation.external_conversation_id = "customer-1"
        conversation.platform_code = "wechat"
        self.assertFalse(_transfer_conversation_enabled(robot, conversation, auto_send_allowed=True))

    def test_transfer_confirmation_affirmative_phrases(self) -> None:
        self.assertTrue(_customer_confirms_transfer("是的，转吧"))
        self.assertTrue(_customer_confirms_transfer("OK"))
        self.assertTrue(_customer_confirms_transfer("麻烦转接一下"))
        self.assertFalse(_customer_confirms_transfer("不用了"))
        self.assertFalse(_customer_confirms_transfer("不是"))

    def test_fallback_result_is_identified_by_workflow(self) -> None:
        self.assertTrue(_is_fallback_reply({"action_plan": {"workflow": "fallback_reply"}}))
        self.assertFalse(_is_fallback_reply({"provider": "fallback-rule"}))

    def test_message_history_restores_chronological_order(self) -> None:
        newest = SimpleNamespace(sender_role="agent", content="第二条")
        oldest = SimpleNamespace(sender_role="customer", content="第一条")
        self.assertEqual(
            _message_history([newest, oldest]),
            [
                {"role": "user", "content": "第一条"},
                {"role": "assistant", "content": "第二条"},
            ],
        )

    def test_message_history_can_exclude_current_batch(self) -> None:
        latest = SimpleNamespace(id="m3", sender_role="customer", content="Any discount?")
        previous = SimpleNamespace(id="m2", sender_role="customer", content="Is it in stock?")
        agent = SimpleNamespace(id="m1", sender_role="agent", content="Hello")

        self.assertEqual(
            _message_history([latest, previous, agent], exclude_message_ids={"m2", "m3"}),
            [{"role": "assistant", "content": "Hello"}],
        )

    def test_current_customer_message_groups_contiguous_questions(self) -> None:
        message = _current_customer_message([
            SimpleNamespace(content="Is it in stock?"),
            SimpleNamespace(content="Any discount?"),
        ])

        self.assertIn("2", message)
        self.assertIn("Is it in stock?", message)
        self.assertIn("Any discount?", message)

    def test_triggering_customer_product_card_is_included_in_platform_context(self) -> None:
        product = SimpleNamespace(
            sender_role="customer",
            content="商品ID：970947366369 水杯古风 ￥10",
            raw_payload={
                "message_type": "product",
                "automation_mode": "trigger",
                "structured_payload": {
                    "product_id": "970947366369",
                    "title": "水杯古风",
                    "price": 10,
                },
            },
        )
        ordinary_message = SimpleNamespace(
            sender_role="customer",
            content="你好",
            raw_payload={"message_type": "text", "automation_mode": "trigger"},
        )

        self.assertEqual(_platform_context([product, ordinary_message]), [{
            "type": "product",
            "content": product.content,
            "data": product.raw_payload["structured_payload"],
        }])

    def test_triggering_customer_order_card_is_included_in_platform_context(self) -> None:
        order = SimpleNamespace(
            sender_role="customer",
            content="订单编号：260805-038084298363116\n已取消 无售后\nWater cup\n实收 ¥10.00",
            raw_payload={
                "message_type": "order",
                "automation_mode": "trigger",
                "structured_payload": {
                    "order_sequence_no": "260805-038084298363116",
                    "order_status_label": "已取消",
                    "after_sales_label": "无售后",
                    "title": "Water cup",
                    "amount": 10,
                    "amount_label": "¥10.00",
                },
            },
        )
        source = SimpleNamespace(
            sender_role="customer",
            content="Current user came from product detail page",
            raw_payload={"message_type": "context", "automation_mode": "context"},
        )

        self.assertEqual(_platform_context([order, source]), [
            {
                "type": "context",
                "content": source.content,
                "data": {},
            },
            {
                "type": "order",
                "content": order.content,
                "data": order.raw_payload["structured_payload"],
            },
        ])

    def test_history_with_latest_keeps_configured_history_plus_latest(self) -> None:
        history = [
            {"role": "user", "content": "第一条"},
            {"role": "assistant", "content": "第二条"},
        ]
        self.assertEqual(
            _history_with_latest(history, "第三条", 2),
            [
                {"role": "user", "content": "第一条"},
                {"role": "assistant", "content": "第二条"},
                {"role": "user", "content": "第三条"},
            ],
        )
        self.assertEqual(
            _history_with_latest([{"role": "user", "content": "第三条"}], "第三条", 2),
            [{"role": "user", "content": "第三条"}],
        )


if __name__ == "__main__":
    unittest.main()
