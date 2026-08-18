from __future__ import annotations

import unittest
from types import SimpleNamespace

from app.services.automation_service import (
    DEFAULT_CONTEXT_LENGTH,
    MAX_CONTEXT_LENGTH,
    _auto_send_allowed,
    _context_length,
    _history_with_latest,
    _message_history,
    _platform_context,
    _fallback_marks_human_required,
    _is_fallback_reply,
    _matched_sensitive_word,
    _sensitive_words,
    _should_create_send_task,
    _timeout_config,
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
