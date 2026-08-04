from __future__ import annotations

import unittest

from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session

from app.models import Base, Conversation, Message, RpaTask, User
from app.schemas.rpa import TaskCompleteRequest
from app.services.rpa_service import complete_task


class RpaReplyBundleTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.user = User(
            username="reply-bundle",
            display_name="Reply Bundle Test",
            password_hash="not-used",
        )
        self.db.add(self.user)
        self.db.flush()
        self.conversation = Conversation(
            user_id=self.user.id,
            platform_code="pinduoduo",
            external_conversation_id="customer-1",
            awaiting_reply=True,
        )
        self.db.add(self.conversation)
        self.db.flush()
        self.message = Message(
            conversation_id=self.conversation.id,
            user_id=self.user.id,
            platform_code="pinduoduo",
            sender_role="agent",
            content="Text answer",
            message_status="queued",
        )
        self.db.add(self.message)
        self.db.flush()
        self.task = RpaTask(
            user_id=self.user.id,
            conversation_id=self.conversation.id,
            message_id=self.message.id,
            task_type="send_message",
            platform_code="pinduoduo",
            payload_json={
                "content": "Text answer",
                "follow_up": {"type": "image", "url": "http://127.0.0.1/image.png"},
            },
        )
        self.db.add(self.task)
        self.db.commit()

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

    def test_completed_bundle_does_not_create_separate_image_task(self) -> None:
        complete_task(
            self.db,
            self.task,
            TaskCompleteRequest(
                status="completed",
                result_json={"text_sent": True, "image_sent": True},
            ),
        )

        image_tasks = self.db.scalar(
            select(func.count()).select_from(RpaTask).where(RpaTask.task_type == "send_image")
        )
        self.db.refresh(self.message)
        self.assertEqual(image_tasks, 0)
        self.assertEqual(self.message.message_status, "sent")
        self.db.refresh(self.conversation)
        self.assertFalse(self.conversation.awaiting_reply)
        image_messages = list(self.db.scalars(
            select(Message).where(
                Message.conversation_id == self.conversation.id,
                Message.raw_payload["media_type"].as_string() == "image",
            )
        ).all())
        self.assertEqual(len(image_messages), 1)
        self.assertEqual(image_messages[0].message_status, "sent")
        self.assertEqual(image_messages[0].raw_payload["image_url"], "http://127.0.0.1/image.png")

        complete_task(
            self.db,
            self.task,
            TaskCompleteRequest(
                status="completed",
                result_json={"text_sent": True, "image_sent": True},
            ),
        )
        image_message_count = self.db.scalar(
            select(func.count()).select_from(Message).where(
                Message.conversation_id == self.conversation.id,
                Message.raw_payload["media_type"].as_string() == "image",
            )
        )
        self.assertEqual(image_message_count, 1)

    def test_partial_bundle_failure_keeps_successful_text_sent(self) -> None:
        complete_task(
            self.db,
            self.task,
            TaskCompleteRequest(
                status="failed",
                result_json={"text_sent": True, "image_sent": False},
                error_message="Image send failed",
            ),
        )

        self.db.refresh(self.message)
        self.assertEqual(self.task.status, "failed")
        self.assertEqual(self.message.message_status, "sent")
        image_message_count = self.db.scalar(
            select(func.count()).select_from(Message).where(
                Message.conversation_id == self.conversation.id,
                Message.raw_payload["media_type"].as_string() == "image",
            )
        )
        self.assertEqual(image_message_count, 0)
        self.db.refresh(self.conversation)
        self.assertFalse(self.conversation.awaiting_reply)

    def test_failed_reply_keeps_conversation_awaiting_reply(self) -> None:
        complete_task(
            self.db,
            self.task,
            TaskCompleteRequest(
                status="failed",
                result_json={"text_sent": False},
                error_message="Text send failed",
            ),
        )

        self.db.refresh(self.conversation)
        self.assertTrue(self.conversation.awaiting_reply)


if __name__ == "__main__":
    unittest.main()
