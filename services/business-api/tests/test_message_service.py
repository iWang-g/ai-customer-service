from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone

from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session

from app.models import (
    AiModelCall,
    AutomationReplyRun,
    Base,
    Conversation,
    Message,
    MessageObservation,
    PlatformAccount,
    RpaEvent,
    RpaNode,
    RpaTask,
    Robot,
    User,
)
from app.services.message_service import list_messages, reset_pinduoduo_conversation_test_data


class MessageServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.user = User(
            username="message-service",
            display_name="Message Service",
            password_hash="not-used",
        )
        self.db.add(self.user)
        self.db.flush()
        self.platform_account = PlatformAccount(
            user_id=self.user.id,
            platform_code="pinduoduo",
            platform_name="Pinduoduo",
            local_account_id="message-service-shop",
            account_name="Message Service Shop",
        )
        self.db.add(self.platform_account)
        self.db.flush()
        self.conversation = Conversation(
            user_id=self.user.id,
            platform_account_id=self.platform_account.id,
            platform_code="pinduoduo",
            external_conversation_id="customer-1",
        )
        self.db.add(self.conversation)
        self.db.flush()

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

    def test_initial_page_returns_latest_messages_in_chronological_order(self) -> None:
        start = datetime(2026, 8, 5, tzinfo=timezone.utc)
        self.db.add_all([
            Message(
                conversation_id=self.conversation.id,
                user_id=self.user.id,
                platform_code="pinduoduo",
                sender_role="customer",
                content=f"message-{index}",
                sent_at=start + timedelta(seconds=index),
                observed_at=start + timedelta(seconds=index),
            )
            for index in range(210)
        ])
        self.db.commit()

        response = list_messages(self.db, self.user, self.conversation.id, limit=200)

        self.assertEqual(response.meta.total, 210)
        self.assertEqual(len(response.items), 200)
        self.assertEqual(response.items[0].content, "message-10")
        self.assertEqual(response.items[-1].content, "message-209")

    def test_offset_loads_the_page_before_newer_messages(self) -> None:
        start = datetime(2026, 8, 5, tzinfo=timezone.utc)
        self.db.add_all([
            Message(
                conversation_id=self.conversation.id,
                user_id=self.user.id,
                platform_code="pinduoduo",
                sender_role="customer",
                content=f"message-{index}",
                sent_at=start + timedelta(seconds=index),
                observed_at=start + timedelta(seconds=index),
            )
            for index in range(12)
        ])
        self.db.commit()

        response = list_messages(self.db, self.user, self.conversation.id, limit=5, offset=5)

        self.assertEqual([item.content for item in response.items], [
            "message-2",
            "message-3",
            "message-4",
            "message-5",
            "message-6",
        ])

    def test_permanent_sequence_controls_order_instead_of_message_time(self) -> None:
        start = datetime(2026, 8, 5, tzinfo=timezone.utc)
        first_collected = Message(
            conversation_id=self.conversation.id,
            user_id=self.user.id,
            platform_code="pinduoduo",
            sender_role="customer",
            content="first-collected",
            sent_at=start + timedelta(hours=1),
            observed_at=start + timedelta(hours=1),
        )
        second_collected = Message(
            conversation_id=self.conversation.id,
            user_id=self.user.id,
            platform_code="pinduoduo",
            sender_role="agent",
            content="second-collected",
            sent_at=start,
            observed_at=start,
        )
        self.db.add_all([first_collected, second_collected])
        self.db.commit()

        response = list_messages(self.db, self.user, self.conversation.id)

        self.assertEqual(
            [item.content for item in response.items],
            ["first-collected", "second-collected"],
        )
        self.assertEqual(
            [item.conversation_sequence for item in response.items],
            [1, 2],
        )
        self.assertEqual(response.items[0].collected_at, first_collected.observed_at)

    def test_failed_messages_are_not_displayed_as_platform_chat_bubbles(self) -> None:
        failed = Message(
            conversation_id=self.conversation.id,
            user_id=self.user.id,
            platform_code="pinduoduo",
            sender_role="agent",
            content="not actually sent",
            message_status="failed",
            source="desktop",
        )
        queued = Message(
            conversation_id=self.conversation.id,
            user_id=self.user.id,
            platform_code="pinduoduo",
            sender_role="agent",
            content="sending now",
            message_status="queued",
            source="desktop",
        )
        self.db.add_all([failed, queued])
        self.db.commit()

        response = list_messages(self.db, self.user, self.conversation.id)

        self.assertNotIn("not actually sent", [item.content for item in response.items])
        self.assertIn("sending now", [item.content for item in response.items])
        self.assertEqual(response.meta.total, len(response.items))

    def test_reset_pinduoduo_conversation_removes_chat_pipeline_data(self) -> None:
        robot = Robot(user_id=self.user.id, name="Reset Robot")
        node = RpaNode(user_id=self.user.id, node_key="reset-node", hostname="localhost")
        self.db.add_all([robot, node])
        self.db.flush()
        message = Message(
            conversation_id=self.conversation.id,
            user_id=self.user.id,
            platform_code="pinduoduo",
            sender_role="customer",
            content="test reset message",
        )
        self.db.add(message)
        self.db.flush()
        task = RpaTask(
            user_id=self.user.id,
            conversation_id=self.conversation.id,
            message_id=message.id,
            task_type="send_message",
            platform_code="pinduoduo",
            status="completed",
        )
        event = RpaEvent(
            user_id=self.user.id,
            node_id=node.id,
            platform_account_id=self.platform_account.id,
            event_id="reset-event",
            dedup_key="reset-event-dedup",
            event_type="message_received",
            platform_code="pinduoduo",
            conversation_external_id=self.conversation.external_conversation_id,
        )
        reply_run = AutomationReplyRun(
            user_id=self.user.id,
            conversation_id=self.conversation.id,
            source_message_id=message.id,
            source_event_id=event.id,
            robot_id=robot.id,
            status="completed",
        )
        self.db.add_all([task, event, reply_run])
        self.db.flush()
        self.db.add(AiModelCall(
            user_id=self.user.id,
            automation_reply_run_id=reply_run.id,
            robot_id=robot.id,
            conversation_id=self.conversation.id,
            stage="reply",
            provider="test",
            model="test",
            status="completed",
        ))
        self.db.add(MessageObservation(
            observation_id="reset-observation",
            user_id=self.user.id,
            node_id=node.id,
            platform_account_id=self.platform_account.id,
            conversation_id=self.conversation.id,
            platform_code="pinduoduo",
            conversation_external_id=self.conversation.external_conversation_id,
            collected_at=datetime(2026, 8, 6, tzinfo=timezone.utc),
            payload_hash="a" * 64,
        ))
        self.conversation.latest_message_text = message.content
        self.conversation.latest_message_at = datetime(2026, 8, 6, tzinfo=timezone.utc)
        self.conversation.unread_count = 1
        self.conversation.awaiting_reply = True
        self.db.commit()

        response, deleted = reset_pinduoduo_conversation_test_data(
            self.db,
            self.user,
            self.conversation.id,
        )

        self.assertEqual(deleted["messages"], 1)
        self.assertEqual(deleted["rpa_events"], 1)
        self.assertEqual(deleted["message_observations"], 1)
        self.assertEqual(self.db.scalar(select(func.count()).select_from(Message)), 0)
        self.assertEqual(self.db.scalar(select(func.count()).select_from(RpaTask)), 0)
        self.assertEqual(self.db.scalar(select(func.count()).select_from(AutomationReplyRun)), 0)
        self.assertEqual(self.db.scalar(select(func.count()).select_from(AiModelCall)), 0)
        self.assertIsNone(response.latest_message_text)
        self.assertEqual(response.unread_count, 0)
        self.assertFalse(response.awaiting_reply)
        self.db.refresh(self.conversation)
        self.assertEqual(self.conversation.last_message_sequence, 0)

    def test_reset_rejects_active_rpa_tasks(self) -> None:
        self.db.add(RpaTask(
            user_id=self.user.id,
            conversation_id=self.conversation.id,
            task_type="send_message",
            platform_code="pinduoduo",
            status="queued",
        ))
        self.db.commit()

        with self.assertRaisesRegex(Exception, "active RPA tasks"):
            reset_pinduoduo_conversation_test_data(
                self.db,
                self.user,
                self.conversation.id,
            )


if __name__ == "__main__":
    unittest.main()
