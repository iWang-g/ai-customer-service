from __future__ import annotations

import asyncio
import unittest
from unittest.mock import patch

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.models import AutomationReplyRun, Base, Conversation, Robot, RobotPlatformScope, RpaTask, User
from app.services.automation_service import _timeout_config, _send_timeout_notice_later


class TimeoutNoticeTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.user = User(username="timeout-test", display_name="Timeout Test", password_hash="not-used")
        self.conversation = Conversation(user_id=self.user.id, platform_code="pinduoduo", external_conversation_id="timeout-customer")
        self.robot = Robot(
            user_id=self.user.id,
            name="Timeout Robot",
            status="online",
            enabled=True,
            config_json={"allow_auto_send": True, "timeout_enabled": True, "timeout_seconds": 1, "timeout_reply_text": "请稍等"},
        )
        self.db.add(self.user)
        self.db.flush()
        self.robot.user_id = self.user.id
        self.db.add(self.robot)
        self.db.flush()
        self.conversation.user_id = self.user.id
        self.robot.user_id = self.user.id
        self.db.add(self.conversation)
        self.db.flush()
        self.db.add(RobotPlatformScope(robot_id=self.robot.id, platform_code="all", all_accounts=True))
        self.reply_run = AutomationReplyRun(
            user_id=self.user.id,
            conversation_id=self.conversation.id,
            source_message_id="source-message-1",
            robot_id=self.robot.id,
            status="running",
            decision=None,
        )
        self.db.add(self.reply_run)
        self.db.commit()

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

    def test_timeout_config_has_safe_bounds(self) -> None:
        enabled, seconds, text = _timeout_config(self.robot)
        self.assertTrue(enabled)
        self.assertEqual(seconds, 1)
        self.assertEqual(text, "请稍等")
        self.robot.config_json = {"timeout_enabled": False, "timeout_seconds": 1000, "timeout_reply_text": "  "}
        enabled, seconds, text = _timeout_config(self.robot)
        self.assertFalse(enabled)
        self.assertEqual(seconds, 60)
        self.assertEqual(text, "专项客服正在赶来的路上请稍等~~")

    async def test_notice_is_queued_once_when_formal_task_is_still_running(self) -> None:
        with patch("app.services.automation_service.asyncio.sleep", return_value=None), patch(
            "app.services.automation_service.create_send_task"
        ) as create_task:
            create_task.return_value.task_id = "timeout-task-1"
            await _send_timeout_notice_later(
                self.user.id, self.conversation.id, "source-message-1", self.robot.id, 1, "请稍等", self.db
            )

        create_task.assert_called_once()
        self.assertEqual(create_task.call_args.kwargs["idempotency_key"], f"auto-timeout:{self.robot.id}:source-message-1")
        self.assertEqual(create_task.call_args.kwargs["source"], "automation_timeout")

    async def test_notice_is_skipped_after_formal_task_completed(self) -> None:
        formal_task = RpaTask(
            user_id=self.user.id,
            conversation_id=self.conversation.id,
            task_type="send_message",
            platform_code="pinduoduo",
            status="completed",
        )
        self.db.add(formal_task)
        self.db.flush()
        self.reply_run.send_task_id = formal_task.id
        self.db.add(self.reply_run)
        self.db.commit()
        with patch("app.services.automation_service.asyncio.sleep", return_value=None), patch(
            "app.services.automation_service.create_send_task"
        ) as create_task:
            await _send_timeout_notice_later(
                self.user.id, self.conversation.id, "source-message-1", self.robot.id, 1, "请稍等", self.db
            )
        create_task.assert_not_called()


if __name__ == "__main__":
    unittest.main()
