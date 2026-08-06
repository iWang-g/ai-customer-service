from __future__ import annotations

import unittest
from datetime import datetime, timezone

from pydantic import ValidationError
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session

from app.models import (
    AutomationReplyRun,
    Base,
    Conversation,
    Message,
    MessageObservation,
    PlatformAccount,
    RpaNode,
    User,
)
from app.schemas.rpa import MessageSnapshotPayload, RpaEventCreate
from app.services.message_observation_service import process_message_snapshot_shadow
from app.services.message_sequence_service import snapshot_payload_hash
from app.services.rpa_service import create_event


class MessageObservationServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.user = User(username="snapshot", display_name="Snapshot", password_hash="unused")
        self.node = RpaNode(user_id="pending", node_key="snapshot-node", hostname="localhost")
        self.db.add(self.user)
        self.db.flush()
        self.node.user_id = self.user.id
        self.account = PlatformAccount(
            user_id=self.user.id,
            platform_code="pinduoduo",
            platform_name="拼多多",
            local_account_id="shop-local",
            account_name="Shop",
        )
        self.db.add_all([self.node, self.account])
        self.db.flush()
        self.conversation = Conversation(
            user_id=self.user.id,
            platform_account_id=self.account.id,
            platform_code="pinduoduo",
            external_conversation_id="same-external-id",
            latest_message_text="formal-summary",
            unread_count=1,
            awaiting_reply=True,
        )
        self.db.add(self.conversation)
        self.db.flush()
        self.db.add_all([
            Message(
                conversation_id=self.conversation.id,
                user_id=self.user.id,
                platform_code="pinduoduo",
                platform_message_id="old-1",
                sender_role="customer",
                content="你好",
            ),
            Message(
                conversation_id=self.conversation.id,
                user_id=self.user.id,
                platform_code="pinduoduo",
                platform_message_id="old-2",
                sender_role="agent",
                content="您好",
            ),
        ])
        self.db.commit()

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

    @staticmethod
    def messages() -> list[dict[str, object]]:
        return [
            {
                "dom_sequence": 0,
                "sender_role": "customer",
                "message_type": "text",
                "content": "你好",
                "platform_message_id": "changed-1",
            },
            {
                "dom_sequence": 1,
                "sender_role": "agent",
                "message_type": "text",
                "content": "您好",
                "platform_message_id": None,
            },
            {
                "dom_sequence": 2,
                "sender_role": "customer",
                "message_type": "text",
                "content": "有货吗",
                "platform_message_id": "new-3",
            },
        ]

    def request(
        self,
        observation_id: str,
        *,
        messages: list[dict[str, object]] | None = None,
        batch_index: int = 0,
        batch_count: int = 1,
        message_offset: int = 0,
        message_count: int | None = None,
        payload_hash: str | None = None,
        account_id: str | None = None,
    ) -> RpaEventCreate:
        batch_messages = self.messages() if messages is None else messages
        full_messages = self.messages()
        return RpaEventCreate(
            event_id=f"event-{observation_id}-{batch_index}-{payload_hash or 'normal'}",
            event_type="message_snapshot",
            platform_code="pinduoduo",
            platform_account_id=account_id or self.account.id,
            conversation_external_id="same-external-id",
            payload_json={
                "observation_id": observation_id,
                "collected_at": "2026-08-06T14:20:05.123Z",
                "unread": True,
                "payload_hash": payload_hash or snapshot_payload_hash(full_messages),
                "message_count": len(full_messages) if message_count is None else message_count,
                "batch_index": batch_index,
                "batch_count": batch_count,
                "message_offset": message_offset,
                "messages": batch_messages,
            },
        )

    def test_complete_snapshot_saves_shadow_alignment_without_formal_mutation(self) -> None:
        message_count_before = self.db.scalar(select(func.count()).select_from(Message))
        tail_before = self.conversation.last_message_sequence
        observation = process_message_snapshot_shadow(
            self.db, self.user, self.node, self.request("aligned")
        )
        self.db.commit()

        self.assertEqual(observation.alignment_status, "aligned")
        self.assertEqual(observation.overlap_size, 2)
        self.assertEqual(observation.projected_append_count, 1)
        self.assertEqual(observation.appended_count, 0)
        self.assertEqual(self.db.scalar(select(func.count()).select_from(Message)), message_count_before)
        self.db.refresh(self.conversation)
        self.assertEqual(self.conversation.last_message_sequence, tail_before)
        self.assertEqual(self.conversation.latest_message_text, "formal-summary")
        self.assertTrue(self.conversation.awaiting_reply)
        self.assertEqual(self.db.scalar(select(func.count()).select_from(AutomationReplyRun)), 0)

    def test_empty_formal_queue_is_classified_as_bootstrap_without_appending(self) -> None:
        self.db.query(Message).delete()
        self.conversation.last_message_sequence = 0
        self.db.commit()
        observation = process_message_snapshot_shadow(
            self.db, self.user, self.node, self.request("bootstrap")
        )
        self.db.commit()
        self.assertEqual(observation.alignment_status, "bootstrap")
        self.assertEqual(observation.projected_append_count, 3)
        self.assertEqual(observation.appended_count, 0)
        self.assertEqual(self.db.scalar(select(func.count()).select_from(Message)), 0)

    def test_complete_overlap_is_classified_as_duplicate(self) -> None:
        duplicate_messages = self.messages()[:2]
        request = self.request(
            "duplicate-snapshot",
            messages=duplicate_messages,
            message_count=2,
            payload_hash=snapshot_payload_hash(duplicate_messages),
        )
        observation = process_message_snapshot_shadow(self.db, self.user, self.node, request)
        self.db.commit()
        self.assertEqual(observation.alignment_status, "duplicate")
        self.assertEqual(observation.overlap_size, 2)
        self.assertEqual(observation.projected_append_count, 0)

    def test_rpa_event_entrypoint_returns_no_reply_source_or_formal_conversation_update(self) -> None:
        request = self.request("rpa-entrypoint")
        message_count_before = self.db.scalar(select(func.count()).select_from(Message))
        event, reply_sources, changed_conversations = create_event(
            self.db, self.user, self.node, request
        )

        self.assertEqual(event.status, "processed")
        self.assertEqual(reply_sources, [])
        self.assertEqual(changed_conversations, [])
        self.assertEqual(self.db.scalar(select(func.count()).select_from(Message)), message_count_before)
        observation = self.db.scalar(
            select(MessageObservation).where(
                MessageObservation.observation_id == "rpa-entrypoint"
            )
        )
        self.assertIsNotNone(observation)
        self.assertEqual(observation.alignment_status, "aligned")

    def test_same_observation_retry_returns_existing_result(self) -> None:
        first = process_message_snapshot_shadow(self.db, self.user, self.node, self.request("retry"))
        self.db.commit()
        second = process_message_snapshot_shadow(self.db, self.user, self.node, self.request("retry"))
        self.db.commit()
        self.assertEqual(second.id, first.id)
        self.assertEqual(self.db.scalar(select(func.count()).select_from(MessageObservation)), 1)

    def test_same_observation_with_different_hash_preserves_previous_result(self) -> None:
        first = process_message_snapshot_shadow(self.db, self.user, self.node, self.request("conflict"))
        self.db.commit()
        event, reply_sources, changed_conversations = create_event(
            self.db,
            self.user,
            self.node,
            self.request("conflict", payload_hash="f" * 64),
        )
        self.assertEqual(event.status, "failed")
        self.assertIn("different payload_hash", event.error_message or "")
        self.assertEqual(reply_sources, [])
        self.assertEqual(changed_conversations, [])
        self.db.refresh(first)
        self.assertEqual(first.alignment_status, "aligned")

    def test_initial_snapshot_with_wrong_hash_is_failed_without_formal_mutation(self) -> None:
        message_count_before = self.db.scalar(select(func.count()).select_from(Message))
        observation = process_message_snapshot_shadow(
            self.db,
            self.user,
            self.node,
            self.request("wrong-hash", payload_hash="e" * 64),
        )
        self.db.commit()
        self.assertEqual(observation.alignment_status, "failed")
        self.assertIn("payload_hash does not match", observation.error_message or "")
        self.assertEqual(self.db.scalar(select(func.count()).select_from(Message)), message_count_before)

    def test_schema_rejects_non_continuous_dom_sequence(self) -> None:
        payload = self.request("invalid-dom").payload_json
        payload["messages"][1]["dom_sequence"] = 3
        with self.assertRaises(ValidationError):
            MessageSnapshotPayload.model_validate(payload)

    def test_split_snapshot_waits_for_all_batches_and_accepts_out_of_order(self) -> None:
        full = self.messages()
        payload_hash = snapshot_payload_hash(full)
        second_batch = self.request(
            "split",
            messages=full[2:],
            batch_index=1,
            batch_count=2,
            message_offset=2,
            payload_hash=payload_hash,
        )
        observation = process_message_snapshot_shadow(self.db, self.user, self.node, second_batch)
        self.db.commit()
        self.assertEqual(observation.alignment_status, "pending")
        self.assertEqual(observation.received_batch_count, 1)

        first_batch = self.request(
            "split",
            messages=full[:2],
            batch_index=0,
            batch_count=2,
            message_offset=0,
            payload_hash=payload_hash,
        )
        observation = process_message_snapshot_shadow(self.db, self.user, self.node, first_batch)
        self.db.commit()
        self.assertEqual(observation.alignment_status, "aligned")
        self.assertEqual(observation.received_batch_count, 2)
        self.assertEqual(observation.projected_append_count, 1)

    def test_duplicate_batch_is_idempotent_but_changed_batch_fails(self) -> None:
        full = self.messages()
        payload_hash = snapshot_payload_hash(full)
        first_batch = self.request(
            "duplicate-batch",
            messages=full[:2],
            batch_count=2,
            message_count=3,
            payload_hash=payload_hash,
        )
        observation = process_message_snapshot_shadow(self.db, self.user, self.node, first_batch)
        self.db.commit()
        observation = process_message_snapshot_shadow(self.db, self.user, self.node, first_batch)
        self.db.commit()
        self.assertEqual(observation.received_batch_count, 1)
        self.assertEqual(observation.alignment_status, "pending")

        changed = self.request(
            "duplicate-batch",
            messages=[{**full[0], "content": "changed"}, full[1]],
            batch_count=2,
            message_count=3,
            payload_hash=payload_hash,
        )
        observation = process_message_snapshot_shadow(self.db, self.user, self.node, changed)
        self.db.commit()
        self.assertEqual(observation.alignment_status, "failed")

    def test_same_external_conversation_id_is_isolated_by_shop(self) -> None:
        other_account = PlatformAccount(
            user_id=self.user.id,
            platform_code="pinduoduo",
            platform_name="拼多多",
            local_account_id="shop-other",
            account_name="Other Shop",
        )
        self.db.add(other_account)
        self.db.flush()
        other_conversation = Conversation(
            user_id=self.user.id,
            platform_account_id=other_account.id,
            platform_code="pinduoduo",
            external_conversation_id="same-external-id",
        )
        self.db.add(other_conversation)
        self.db.flush()
        self.db.add(Message(
            conversation_id=other_conversation.id,
            user_id=self.user.id,
            platform_code="pinduoduo",
            sender_role="customer",
            content="另一个店铺的历史",
        ))
        self.db.commit()

        observation = process_message_snapshot_shadow(
            self.db,
            self.user,
            self.node,
            self.request("shop-isolation", account_id=other_account.id),
        )
        self.db.commit()
        self.assertEqual(observation.conversation_id, other_conversation.id)
        self.assertEqual(observation.alignment_status, "unaligned")


if __name__ == "__main__":
    unittest.main()
