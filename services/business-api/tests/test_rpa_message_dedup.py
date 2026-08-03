from __future__ import annotations

import unittest
from datetime import datetime, timezone

from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session

from app.models import Base, Message, RpaNode, User
from app.schemas.rpa import RpaEventCreate
from app.services.rpa_service import create_event


class RpaMessageDedupTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.user = User(
            username="rpa-message-dedup",
            display_name="RPA Message Dedup",
            password_hash="not-used",
        )
        self.db.add(self.user)
        self.db.flush()
        self.node = RpaNode(
            user_id=self.user.id,
            node_key="node-message-dedup",
            hostname="localhost",
        )
        self.db.add(self.node)
        self.db.commit()

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

    def event(
        self,
        event_id: str,
        sequence: int,
        *,
        platform_message_id: str | None = None,
        snapshot_id: str = "snapshot-1",
        platform_sent_at: str = "2026-07-30T10:00:34.000Z",
        observed_at: str = "2026-07-31T02:49:41.587Z",
    ) -> RpaEventCreate:
        return RpaEventCreate(
            event_id=event_id,
            dedup_key=f"dedup-{event_id}",
            event_type="message_received",
            platform_code="pinduoduo",
            platform_message_id=platform_message_id,
            conversation_external_id="customer-1",
            received_at=datetime(2026, 7, 31, 2, 49, 42, tzinfo=timezone.utc),
            payload_json={
                "content": "same customer message",
                "sender_role": "customer",
                "message_type": "text",
                "snapshot_id": snapshot_id,
                "snapshot_sequence": sequence,
                "time_group_index": 0,
                "platform_sent_at": platform_sent_at,
                "observed_at": observed_at,
            },
        )

    def test_duplicate_dom_candidates_create_one_reply_source(self) -> None:
        _, first_messages, _ = create_event(self.db, self.user, self.node, self.event("event-0", 0))
        _, second_messages, _ = create_event(self.db, self.user, self.node, self.event("event-1", 1))
        _, identified_messages, _ = create_event(
            self.db,
            self.user,
            self.node,
            self.event(
                "event-14",
                14,
                platform_message_id="middlePanel_list_100",
                platform_sent_at="2026-07-31T02:49:42.000Z",
            ),
        )

        self.assertEqual(first_messages, [])
        self.assertEqual(second_messages, [])
        self.assertEqual(len(identified_messages), 1)
        self.assertEqual(self.db.scalar(select(func.count()).select_from(Message)), 2)
        identified = self.db.scalar(
            select(Message).where(Message.platform_message_id == "middlePanel_list_100")
        )
        self.assertIsNotNone(identified)
        self.assertEqual(identified.snapshot_sequence, 14)

    def test_repeated_content_with_distinct_platform_ids_stays_distinct(self) -> None:
        create_event(
            self.db,
            self.user,
            self.node,
            self.event("event-first", 0, platform_message_id="message-1"),
        )
        _, messages, _ = create_event(
            self.db,
            self.user,
            self.node,
            self.event(
                "event-second",
                1,
                platform_message_id="message-2",
                snapshot_id="snapshot-2",
                platform_sent_at="2026-07-31T03:00:00.000Z",
                observed_at="2026-07-31T03:00:01.000Z",
            ),
        )

        self.assertEqual(len(messages), 1)
        self.assertEqual(self.db.scalar(select(func.count()).select_from(Message)), 2)

    def test_later_snapshot_attaches_platform_id_without_new_reply_source(self) -> None:
        first = self.event(
            "event-unidentified",
            3,
            snapshot_id="snapshot-before-id",
            platform_sent_at="2026-07-31T02:49:40.000Z",
            observed_at="2026-07-31T02:49:41.000Z",
        )
        _, first_messages, _ = create_event(self.db, self.user, self.node, first)
        identified = self.event(
            "event-identified",
            4,
            platform_message_id="message-later-id",
            snapshot_id="snapshot-after-id",
            platform_sent_at="2026-07-31T02:49:40.000Z",
            observed_at="2026-07-31T02:49:42.000Z",
        )
        _, identified_messages, _ = create_event(self.db, self.user, self.node, identified)

        self.assertEqual(len(first_messages), 1)
        self.assertEqual(identified_messages, [])
        self.assertEqual(self.db.scalar(select(func.count()).select_from(Message)), 1)
        message = self.db.scalar(select(Message))
        self.assertEqual(message.platform_message_id, "message-later-id")
        self.assertEqual(message.observed_at, datetime(2026, 7, 31, 2, 49, 41))
        self.assertEqual(message.sent_at, datetime(2026, 7, 31, 2, 49, 41))

    def test_chat_time_uses_local_observation_instead_of_platform_time(self) -> None:
        event = self.event(
            "event-local-time",
            0,
            platform_message_id="platform-local-time",
            platform_sent_at="2026-07-31T02:40:00.000Z",
            observed_at="2026-07-31T02:49:42.000Z",
        )

        create_event(self.db, self.user, self.node, event)

        message = self.db.scalar(
            select(Message).where(Message.platform_message_id == "platform-local-time")
        )
        self.assertIsNotNone(message)
        self.assertEqual(message.platform_sent_at, datetime(2026, 7, 31, 2, 40, 0))
        self.assertEqual(message.sent_at, datetime(2026, 7, 31, 2, 49, 42))


if __name__ == "__main__":
    unittest.main()
