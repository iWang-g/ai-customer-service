from __future__ import annotations

import asyncio
import unittest
from unittest.mock import patch

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.models import AutomationReplyRun, Base, Conversation, Message, Robot, RobotPlatformScope, RpaTask, User
from app.schemas.rpa import TaskCompleteRequest
from app.services.automation_service import (
    _queue_reply_task,
    _queue_reply_task_ordered,
    _timeout_config,
    _send_timeout_notice_later,
)
from app.services.rpa_service import complete_task


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
            task_id = await _send_timeout_notice_later(
                self.user.id, self.conversation.id, "source-message-1", self.robot.id, 1, "请稍等", self.db
            )

        create_task.assert_called_once()
        self.assertEqual(create_task.call_args.kwargs["idempotency_key"], f"auto-timeout:{self.robot.id}:source-message-1")
        self.assertEqual(create_task.call_args.kwargs["source"], "automation_timeout")
        self.assertEqual(task_id, "timeout-task-1")

    async def test_deadline_is_marked_before_timeout_notice_is_queued(self) -> None:
        deadline = asyncio.Event()
        lock = asyncio.Lock()
        observed_deadline_states: list[bool] = []

        def create_task(*args, **kwargs):
            observed_deadline_states.append(deadline.is_set())
            return type("Response", (), {"task_id": "timeout-task-1"})()

        with patch("app.services.automation_service.asyncio.sleep", return_value=None), patch(
            "app.services.automation_service.create_send_task", side_effect=create_task
        ):
            await _send_timeout_notice_later(
                self.user.id,
                self.conversation.id,
                "source-message-1",
                self.robot.id,
                1,
                "请稍等",
                self.db,
                deadline_reached=deadline,
                ordering_lock=lock,
            )

        self.assertEqual(observed_deadline_states, [True])

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

    def _source_message(self) -> Message:
        message = Message(
            id="source-message-1",
            user_id=self.user.id,
            conversation_id=self.conversation.id,
            platform_code="pinduoduo",
            sender_role="customer",
            content="在吗",
        )
        self.db.add(message)
        self.conversation.last_message_sequence = 1
        message.conversation_sequence = 1
        self.db.commit()
        return message

    def _queue_deferred_formal_reply(self) -> RpaTask:
        source_message = self._source_message()
        task_id = _queue_reply_task(
            self.db,
            self.user,
            self.conversation,
            self.robot,
            source_message,
            {"decision": "auto_send", "text": "正式回复"},
            auto_send_allowed=True,
            defer_for_timeout=True,
        )
        self.assertIsNotNone(task_id)
        return self.db.get(RpaTask, task_id)

    def test_formal_reply_waits_while_timeout_outcome_is_pending(self) -> None:
        formal_task = self._queue_deferred_formal_reply()
        self.assertEqual(formal_task.status, "waiting_timeout")

    def test_formal_reply_is_immediately_queued_before_deadline(self) -> None:
        source_message = self._source_message()
        task_id = _queue_reply_task(
            self.db,
            self.user,
            self.conversation,
            self.robot,
            source_message,
            {"decision": "auto_send", "text": "正式回复"},
            auto_send_allowed=True,
            defer_for_timeout=False,
        )
        self.assertEqual(self.db.get(RpaTask, task_id).status, "queued")

    async def test_ordering_lock_only_wraps_the_final_reply_queue_decision(self) -> None:
        source_message = self._source_message()
        deadline = asyncio.Event()
        lock = asyncio.Lock()

        await lock.acquire()
        queue_call = asyncio.create_task(
            _queue_reply_task_ordered(
                self.db,
                self.user,
                self.conversation,
                self.robot,
                source_message,
                {"decision": "auto_send", "text": "正式回复"},
                auto_send_allowed=True,
                timeout_deadline=deadline,
                ordering_lock=lock,
            )
        )
        await asyncio.sleep(0)
        self.assertFalse(queue_call.done())
        deadline.set()
        lock.release()

        task_id = await queue_call
        self.assertEqual(self.db.get(RpaTask, task_id).status, "waiting_timeout")

    async def test_timeout_queue_failure_clears_deadline_and_releases_formal_reply(self) -> None:
        source_message = self._source_message()
        deadline = asyncio.Event()
        lock = asyncio.Lock()
        with patch("app.services.automation_service.asyncio.sleep", return_value=None), patch(
            "app.services.automation_service.logger.exception"
        ), patch(
            "app.services.automation_service.create_send_task", side_effect=RuntimeError("queue failed")
        ):
            timeout_task_id = await _send_timeout_notice_later(
                self.user.id,
                self.conversation.id,
                "source-message-1",
                self.robot.id,
                1,
                "请稍等",
                self.db,
                deadline_reached=deadline,
                ordering_lock=lock,
            )
        self.assertIsNone(timeout_task_id)
        self.assertFalse(deadline.is_set())

        formal_task_id = await _queue_reply_task_ordered(
            self.db,
            self.user,
            self.conversation,
            self.robot,
            source_message,
            {"decision": "auto_send", "text": "正式回复"},
            auto_send_allowed=True,
            timeout_deadline=deadline,
            ordering_lock=lock,
        )
        self.assertEqual(self.db.get(RpaTask, formal_task_id).status, "queued")

    async def test_timeout_is_queued_before_a_waiting_formal_reply(self) -> None:
        formal_task = self._queue_deferred_formal_reply()
        with patch("app.services.automation_service.asyncio.sleep", return_value=None), patch(
            "app.services.automation_service.create_send_task"
        ) as create_task:
            create_task.return_value.task_id = "timeout-task-1"
            task_id = await _send_timeout_notice_later(
                self.user.id, self.conversation.id, "source-message-1", self.robot.id, 1, "请稍等", self.db
            )
        self.db.refresh(formal_task)
        self.assertEqual(task_id, "timeout-task-1")
        self.assertEqual(formal_task.status, "waiting_timeout")
        create_task.assert_called_once()

    def test_timeout_completion_releases_formal_reply_even_on_failure(self) -> None:
        formal_task = self._queue_deferred_formal_reply()
        timeout_task = RpaTask(
            user_id=self.user.id,
            conversation_id=self.conversation.id,
            task_type="send_message",
            idempotency_key=f"auto-timeout:{self.robot.id}:source-message-1",
            platform_code="pinduoduo",
            status="acknowledged",
        )
        self.db.add(timeout_task)
        self.db.commit()

        complete_task(
            self.db,
            timeout_task,
            TaskCompleteRequest(status="failed", result_json={}, error_message="send failed"),
        )

        self.db.refresh(formal_task)
        self.assertEqual(formal_task.status, "queued")


if __name__ == "__main__":
    unittest.main()
