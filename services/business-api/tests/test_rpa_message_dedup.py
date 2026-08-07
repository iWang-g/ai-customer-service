from __future__ import annotations

import unittest
from datetime import datetime, timezone

from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session

from app.models import Base, Conversation, Message, RpaNode, User
from app.schemas.rpa import RpaEventCreate
from app.services.message_queue_service import append_message
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

    def agent_event(
        self,
        event_id: str,
        content: str,
        sequence: int,
        *,
        platform_message_id: str | None = None,
        message_type: str = "text",
        image_url: str | None = None,
        observed_at: datetime | None = None,
        snapshot_id: str | None = None,
    ) -> RpaEventCreate:
        observed_at = observed_at or datetime(2026, 8, 6, 8, 15, 5, tzinfo=timezone.utc)
        return RpaEventCreate(
            event_id=event_id,
            dedup_key=f"dedup-{event_id}",
            event_type="agent_message",
            platform_code="pinduoduo",
            platform_message_id=platform_message_id,
            conversation_external_id="customer-1",
            received_at=observed_at,
            payload_json={
                "content": content,
                "sender_role": "agent",
                "message_type": message_type,
                **({"media_type": "image", "image_url": image_url} if image_url else {}),
                "snapshot_id": snapshot_id or f"snapshot-agent-{event_id}",
                "snapshot_sequence": sequence,
                "observed_at": observed_at.isoformat(),
            },
        )

    def add_outbound(
        self,
        content: str,
        *,
        source: str = "desktop",
        status: str = "sent",
        raw_payload: dict | None = None,
        collected_at: datetime | None = None,
    ) -> Message:
        conversation = self.db.scalar(select(Conversation))
        if conversation is None:
            create_event(
                self.db,
                self.user,
                self.node,
                self.event("conversation-seed", 0, platform_message_id="customer-seed"),
            )
            conversation = self.db.scalar(select(Conversation))
        self.assertIsNotNone(conversation)
        collected_at = collected_at or datetime(2026, 8, 6, 8, 12, 26, tzinfo=timezone.utc)
        message = Message(
            conversation_id=conversation.id,
            user_id=self.user.id,
            platform_code="pinduoduo",
            sender_role="agent",
            content=content,
            message_status=status,
            source=source,
            raw_payload=raw_payload or {},
            observed_at=collected_at,
            sent_at=collected_at,
        )
        append_message(self.db, message, collected_at=collected_at)
        self.db.commit()
        return message

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
        self.assertEqual(self.db.scalar(select(func.count()).select_from(Message)), 1)
        identified = self.db.scalar(
            select(Message).where(Message.platform_message_id == "middlePanel_list_100")
        )
        self.assertIsNotNone(identified)
        self.assertEqual(identified.snapshot_sequence, 14)
        self.assertEqual(identified.observed_at, datetime(2026, 7, 31, 2, 49, 41, 587000))

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
        self.assertEqual(message.collected_at, datetime(2026, 7, 31, 2, 49, 42))

    def test_latest_sender_controls_awaiting_reply(self) -> None:
        create_event(
            self.db,
            self.user,
            self.node,
            self.event("event-customer", 0, platform_message_id="customer-message"),
        )
        conversation = self.db.scalar(select(Conversation))
        self.assertIsNotNone(conversation)
        self.assertTrue(conversation.awaiting_reply)

        agent_event = self.event(
            "event-agent",
            1,
            platform_message_id="agent-message",
            snapshot_id="snapshot-agent",
            platform_sent_at="2026-07-31T03:00:00.000Z",
            observed_at="2026-07-31T03:00:01.000Z",
        ).model_copy(update={
            "event_type": "message_sent",
            "payload_json": {
                "content": "agent reply",
                "sender_role": "agent",
                "platform_sent_at": "2026-07-31T03:00:00.000Z",
                "observed_at": "2026-07-31T03:00:01.000Z",
            },
        })
        create_event(self.db, self.user, self.node, agent_event)

        self.db.refresh(conversation)
        self.assertFalse(conversation.awaiting_reply)

    def test_delayed_normalized_agent_echo_enriches_original_message(self) -> None:
        original = self.add_outbound(
            "包含增补键位\n  默认共有 108 键",
            status="failed",
            collected_at=datetime(2026, 8, 5, 4, 16, 51, tzinfo=timezone.utc),
        )
        original_sequence = original.conversation_sequence

        _, reply_sources, _ = create_event(
            self.db,
            self.user,
            self.node,
            self.agent_event(
                "delayed-platform-echo",
                "包含增补键位 默认共有 108 键",
                12,
                platform_message_id="middlePanel_list_1786003952754",
            ),
        )

        self.db.refresh(original)
        self.assertEqual(reply_sources, [])
        self.assertEqual(self.db.scalar(select(func.count()).select_from(Message)), 2)
        self.assertEqual(original.conversation_sequence, original_sequence)
        self.assertEqual(original.platform_message_id, "middlePanel_list_1786003952754")
        self.assertEqual(original.message_status, "sent")
        self.assertEqual(original.source, "desktop")
        self.assertEqual(original.raw_payload["platform_echo"]["snapshot_sequence"], 12)

    def test_all_local_outbound_sources_are_echo_candidates(self) -> None:
        sources = ("desktop", "ai", "automation_timeout", "customer_outreach")
        for index, source in enumerate(sources):
            content = f"outbound from {source}"
            original = self.add_outbound(content, source=source)
            create_event(
                self.db,
                self.user,
                self.node,
                self.agent_event(
                    f"source-echo-{index}",
                    content,
                    20 + index,
                    platform_message_id=f"source-platform-{index}",
                ),
            )
            self.db.refresh(original)
            self.assertEqual(original.platform_message_id, f"source-platform-{index}")
            self.assertEqual(original.source, source)

    def test_repeated_identical_outbound_echoes_match_fifo_occurrences(self) -> None:
        first = self.add_outbound("same agent reply")
        second = self.add_outbound(
            "same agent reply",
            collected_at=datetime(2026, 8, 6, 8, 12, 27, tzinfo=timezone.utc),
        )

        create_event(
            self.db,
            self.user,
            self.node,
            self.agent_event(
                "first-repeated-echo",
                "same agent reply",
                30,
                platform_message_id="echo-1",
            ),
        )
        create_event(
            self.db,
            self.user,
            self.node,
            self.agent_event(
                "second-repeated-echo",
                "same agent reply",
                31,
                platform_message_id="echo-2",
            ),
        )

        self.db.refresh(first)
        self.db.refresh(second)
        self.assertEqual(first.platform_message_id, "echo-1")
        self.assertEqual(second.platform_message_id, "echo-2")
        self.assertLess(first.conversation_sequence, second.conversation_sequence)

    def test_echo_without_platform_id_consumes_only_one_outbound_occurrence(self) -> None:
        first = self.add_outbound("same idless reply")
        second = self.add_outbound(
            "same idless reply",
            collected_at=datetime(2026, 8, 6, 8, 12, 27, tzinfo=timezone.utc),
        )

        create_event(
            self.db,
            self.user,
            self.node,
            self.agent_event("first-idless-echo", "same idless reply", 40),
        )
        create_event(
            self.db,
            self.user,
            self.node,
            self.agent_event("second-idless-echo", "same idless reply", 41),
        )

        self.db.refresh(first)
        self.db.refresh(second)
        self.assertEqual(first.raw_payload["platform_echo"]["snapshot_sequence"], 40)
        self.assertEqual(second.raw_payload["platform_echo"]["snapshot_sequence"], 41)

    def test_unmatched_platform_agent_message_is_kept(self) -> None:
        self.add_outbound("different local reply")

        _, reply_sources, _ = create_event(
            self.db,
            self.user,
            self.node,
            self.agent_event(
                "platform-human-reply",
                "盲盒是什么",
                50,
                platform_message_id="platform-human-message",
            ),
        )

        platform_message = self.db.scalar(
            select(Message).where(Message.platform_message_id == "platform-human-message")
        )
        self.assertIsNotNone(platform_message)
        self.assertEqual(platform_message.source, "rpa")
        self.assertEqual(len(reply_sources), 1)

    def test_mismatched_preceding_context_does_not_claim_stale_outbound(self) -> None:
        conversation = self.db.scalar(select(Conversation))
        if conversation is None:
            create_event(
                self.db,
                self.user,
                self.node,
                self.event("context-seed", 0, platform_message_id="context-customer-1"),
            )
            conversation = self.db.scalar(select(Conversation))
        self.assertIsNotNone(conversation)
        later_customer = Message(
            conversation_id=conversation.id,
            user_id=self.user.id,
            platform_code="pinduoduo",
            sender_role="customer",
            content="later customer context",
            message_status="sent",
            source="rpa",
        )
        append_message(self.db, later_customer)
        self.db.commit()
        stale_outbound = self.add_outbound("same agent reply")

        create_event(
            self.db,
            self.user,
            self.node,
            self.event(
                "context-predecessor-scan",
                0,
                platform_message_id="context-customer-1",
                snapshot_id="context-snapshot",
            ),
        )
        create_event(
            self.db,
            self.user,
            self.node,
            self.agent_event(
                "old-platform-agent-message",
                "same agent reply",
                1,
                platform_message_id="old-human-agent-message",
                snapshot_id="context-snapshot",
            ),
        )

        self.db.refresh(stale_outbound)
        self.assertIsNone(stale_outbound.platform_message_id)
        platform_message = self.db.scalar(
            select(Message).where(Message.platform_message_id == "old-human-agent-message")
        )
        self.assertIsNotNone(platform_message)
        self.assertEqual(platform_message.source, "rpa")

    def test_image_echoes_match_local_images_fifo(self) -> None:
        first = self.add_outbound(
            "[图片]",
            source="ai",
            raw_payload={"media_type": "image", "image_url": "http://local/first.png"},
        )
        second = self.add_outbound(
            "[图片]",
            source="ai",
            raw_payload={"media_type": "image", "image_url": "http://local/second.png"},
            collected_at=datetime(2026, 8, 6, 8, 12, 27, tzinfo=timezone.utc),
        )

        create_event(
            self.db,
            self.user,
            self.node,
            self.agent_event(
                "first-image-echo",
                "[图片]",
                60,
                platform_message_id="image-echo-1",
                message_type="image",
                image_url="https://platform/first.jpg",
            ),
        )
        create_event(
            self.db,
            self.user,
            self.node,
            self.agent_event(
                "second-image-echo",
                "[图片]",
                61,
                platform_message_id="image-echo-2",
                message_type="image",
                image_url="https://platform/second.jpg",
            ),
        )

        self.db.refresh(first)
        self.db.refresh(second)
        self.assertEqual(first.platform_message_id, "image-echo-1")
        self.assertEqual(second.platform_message_id, "image-echo-2")


if __name__ == "__main__":
    unittest.main()
