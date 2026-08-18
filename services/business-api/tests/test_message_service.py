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
    CustomerOrder,
    Message,
    MessageObservation,
    PlatformAccount,
    RpaEvent,
    RpaNode,
    RpaTask,
    Robot,
    User,
)
from app.services.message_service import (
    clear_conversation_history,
    dismiss_conversation_message_sync_issue,
    get_conversation_message_sync_issue,
    list_conversations,
    list_messages,
    rebuild_conversation_message_queue,
    reset_pinduoduo_conversation_test_data,
    soft_delete_conversation,
)


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

    def test_record_sent_message_preserves_client_message_id(self) -> None:
        from app.schemas.message import RecordSentMessageRequest
        from app.services.message_service import record_sent_message

        response = record_sent_message(
            self.db,
            self.user,
            RecordSentMessageRequest(
                conversation_id=self.conversation.id,
                content="optimistic message",
                client_message_id="optimistic:client-1",
            ),
        )

        self.assertEqual(
            response.message.raw_payload["client_message_id"],
            "optimistic:client-1",
        )

    def test_record_sent_image_preserves_media_type(self) -> None:
        from app.schemas.message import RecordSentMessageRequest
        from app.services.message_service import record_sent_message

        response = record_sent_message(
            self.db,
            self.user,
            RecordSentMessageRequest(
                conversation_id=self.conversation.id,
                content="[图片]",
                media_type="image",
            ),
        )

        self.assertEqual(response.message.raw_payload["media_type"], "image")

    def test_clear_history_resets_pinduoduo_pipeline_data(self) -> None:
        old_message = Message(
            conversation_id=self.conversation.id,
            user_id=self.user.id,
            platform_code="pinduoduo",
            sender_role="customer",
            content="old message",
        )
        self.db.add(old_message)
        self.db.commit()

        response = clear_conversation_history(self.db, self.user, self.conversation.id)

        self.assertEqual(response.messages_cleared_sequence, 0)
        self.db.refresh(self.conversation)
        self.assertEqual(self.conversation.last_message_sequence, 0)
        self.assertEqual(list_messages(self.db, self.user, self.conversation.id).items, [])
        self.assertEqual(self.db.scalar(select(func.count()).select_from(Message)), 0)
        new_message = Message(
            conversation_id=self.conversation.id,
            user_id=self.user.id,
            platform_code="pinduoduo",
            sender_role="customer",
            content="new message",
        )
        self.db.add(new_message)
        self.db.commit()
        self.assertEqual(
            [item.content for item in list_messages(self.db, self.user, self.conversation.id).items],
            ["new message"],
        )

    def test_clear_history_rejects_active_message_processing(self) -> None:
        self.db.add(RpaTask(
            user_id=self.user.id,
            conversation_id=self.conversation.id,
            task_type="send_message",
            platform_code="pinduoduo",
            status="queued",
        ))
        self.db.commit()

        with self.assertRaisesRegex(Exception, "消息正在处理"):
            clear_conversation_history(self.db, self.user, self.conversation.id)

    def test_soft_delete_resets_pinduoduo_pipeline_and_hides_conversation(self) -> None:
        self.db.add(Message(
            conversation_id=self.conversation.id,
            user_id=self.user.id,
            platform_code="pinduoduo",
            sender_role="customer",
            content="deleted message",
        ))
        self.db.commit()

        response = soft_delete_conversation(self.db, self.user, self.conversation.id)

        self.assertIsNotNone(response.deleted_at)
        self.assertEqual(response.messages_cleared_sequence, 0)
        self.db.refresh(self.conversation)
        self.assertEqual(self.conversation.last_message_sequence, 0)
        self.assertEqual(self.db.scalar(select(func.count()).select_from(Message)), 0)
        self.assertEqual(list_conversations(self.db, self.user).items, [])
        self.assertIsNotNone(self.db.get(Conversation, self.conversation.id))

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
        self.db.add(CustomerOrder(
            user_id=self.user.id,
            platform_account_id=self.platform_account.id,
            conversation_id=self.conversation.id,
            customer_key="customer-1",
            platform_order_id="order-reset-1",
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
        self.assertEqual(deleted["customer_orders"], 1)
        self.assertEqual(self.db.scalar(select(func.count()).select_from(Message)), 0)
        self.assertEqual(self.db.scalar(select(func.count()).select_from(RpaTask)), 0)
        self.assertEqual(self.db.scalar(select(func.count()).select_from(AutomationReplyRun)), 0)
        self.assertEqual(self.db.scalar(select(func.count()).select_from(AiModelCall)), 0)
        self.assertEqual(self.db.scalar(select(func.count()).select_from(CustomerOrder)), 0)
        self.assertIsNone(response.latest_message_text)
        self.assertEqual(response.unread_count, 0)
        self.assertFalse(response.awaiting_reply)
        self.db.refresh(self.conversation)
        self.assertEqual(self.conversation.last_message_sequence, 0)
        self.assertEqual(self.conversation.messages_cleared_sequence, 0)
        self.assertIsNone(self.conversation.deleted_at)

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

    def test_sync_issue_can_be_previewed_dismissed_and_rebuilt(self) -> None:
        collected_at = datetime(2026, 8, 17, 10, 30, tzinfo=timezone.utc)
        messages = [
            {
                "dom_sequence": 0,
                "sender_role": "customer",
                "message_type": "product",
                "content": "测试商品",
                "display_mode": "card",
                "automation_mode": "trigger",
                "structured_payload": {"title": "测试商品", "price": "19.90"},
            },
            {
                "dom_sequence": 1,
                "sender_role": "customer",
                "message_type": "text",
                "content": "现在有货吗",
                "automation_mode": "trigger",
            },
        ]
        observation = MessageObservation(
            observation_id="sync-issue-observation",
            user_id=self.user.id,
            platform_account_id=self.platform_account.id,
            conversation_id=self.conversation.id,
            platform_code="pinduoduo",
            conversation_external_id=self.conversation.external_conversation_id,
            collected_at=collected_at,
            unread=True,
            payload_hash="b" * 64,
            message_count=len(messages),
            batch_count=1,
            received_batch_count=1,
            alignment_status="unaligned",
            raw_payload={
                "source_snapshot_id": "sync-issue-snapshot",
                "batches": {
                    "0": {
                        "message_offset": 0,
                        "messages": messages,
                    },
                },
            },
        )
        self.conversation.metadata_json = {
            "message_sync_issue": {
                "status": "active",
                "observation_id": observation.observation_id,
                "first_detected_at": collected_at.isoformat(),
                "latest_detected_at": collected_at.isoformat(),
                "unread": True,
                "message_count": len(messages),
                "consecutive_failure_count": 1,
                "requires_attention": True,
                "dismissed_at": None,
            },
        }
        order = CustomerOrder(
            user_id=self.user.id,
            platform_account_id=self.platform_account.id,
            conversation_id=self.conversation.id,
            customer_key="customer-1",
            platform_order_id="preserved-order",
        )
        self.db.add_all([observation, order])
        self.db.commit()

        detail = get_conversation_message_sync_issue(
            self.db, self.user, self.conversation.id
        )
        self.assertEqual([item.content for item in detail.messages], ["测试商品", "现在有货吗"])

        dismissed = dismiss_conversation_message_sync_issue(
            self.db, self.user, self.conversation.id
        )
        self.assertIsNotNone(dismissed.message_sync_issue)
        self.assertFalse(dismissed.message_sync_issue.requires_attention)

        response, rebuilt, deleted = rebuild_conversation_message_queue(
            self.db, self.user, self.conversation.id
        )

        self.assertEqual(deleted["message_observations"], 1)
        self.assertEqual([item.content for item in rebuilt], ["测试商品", "现在有货吗"])
        self.assertTrue(all(item.collection_kind == "recovery" for item in rebuilt))
        self.assertTrue(all(not item.automation_eligible for item in rebuilt))
        self.assertTrue(response.awaiting_reply)
        self.assertIsNone(response.message_sync_issue)
        self.assertEqual(self.db.scalar(select(func.count()).select_from(CustomerOrder)), 1)


if __name__ == "__main__":
    unittest.main()
