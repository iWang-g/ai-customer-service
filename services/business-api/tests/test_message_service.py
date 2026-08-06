from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.models import Base, Conversation, Message, User
from app.services.message_service import list_messages


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
        self.conversation = Conversation(
            user_id=self.user.id,
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


if __name__ == "__main__":
    unittest.main()
