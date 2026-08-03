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
    _should_create_send_task,
)


class AutomationConfigTests(unittest.TestCase):
    def robot(self, **config: object) -> SimpleNamespace:
        return SimpleNamespace(config_json=config)

    def test_context_length_uses_robot_config_and_bounds(self) -> None:
        self.assertEqual(_context_length(self.robot(context_length=12)), 12)
        self.assertEqual(_context_length(self.robot(context_length=500)), MAX_CONTEXT_LENGTH)
        self.assertEqual(_context_length(self.robot(context_length=0)), 1)
        self.assertEqual(_context_length(self.robot(context_length="invalid")), DEFAULT_CONTEXT_LENGTH)

    def test_auto_send_requires_request_and_robot_switches(self) -> None:
        robot = self.robot(allow_auto_send=True)
        self.assertTrue(_auto_send_allowed(robot, requested=True))
        self.assertFalse(_auto_send_allowed(robot, requested=False))
        self.assertFalse(
            _auto_send_allowed(self.robot(allow_auto_send=False), requested=True)
        )

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
