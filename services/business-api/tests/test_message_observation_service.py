from __future__ import annotations

import unittest
from datetime import datetime, timezone
from unittest.mock import patch

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
    RpaTask,
    User,
)
from app.core.config import Settings
from app.schemas.rpa import MessageSnapshotPayload, RpaEventCreate
from app.services.message_observation_service import process_message_snapshot
from app.services.message_sequence_service import snapshot_payload_hash
from app.services.rpa_service import create_event, select_inbound_reply_source


def observe_message_snapshot(
    db: Session,
    user: User,
    node: RpaNode,
    request: RpaEventCreate,
) -> MessageObservation:
    return process_message_snapshot(
        db,
        user,
        node,
        request,
        write_messages=False,
    ).observation


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
                "source_snapshot_id": "desktop-snapshot-1",
            },
        )

    def test_complete_snapshot_saves_shadow_alignment_without_formal_mutation(self) -> None:
        message_count_before = self.db.scalar(select(func.count()).select_from(Message))
        tail_before = self.conversation.last_message_sequence
        observation = observe_message_snapshot(
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

    def test_formal_snapshot_appends_increment_with_contiguous_sequences(self) -> None:
        result = process_message_snapshot(
            self.db,
            self.user,
            self.node,
            self.request("formal-aligned"),
            write_messages=True,
        )
        self.db.commit()

        self.assertEqual(result.observation.alignment_status, "aligned")
        self.assertEqual(result.observation.appended_count, 1)
        self.assertEqual(len(result.appended_messages), 1)
        appended = result.appended_messages[0]
        self.assertEqual(appended.content, "有货吗")
        self.assertEqual(appended.conversation_sequence, 3)
        self.assertEqual(appended.first_observation_id, "formal-aligned")
        self.assertEqual(appended.first_dom_sequence, 2)
        self.assertEqual(appended.collection_kind, "incremental")
        self.assertTrue(appended.automation_eligible)
        self.db.refresh(self.conversation)
        self.assertEqual(self.conversation.last_message_sequence, 3)
        self.assertEqual(self.conversation.latest_message_text, "有货吗")
        self.assertTrue(self.conversation.awaiting_reply)
        self.assertNotIn("shadow_only", result.observation.diagnostics_json)

    def test_formal_bootstrap_appends_batch_without_automation_eligibility(self) -> None:
        self.db.query(Message).delete()
        self.conversation.last_message_sequence = 0
        self.db.commit()

        result = process_message_snapshot(
            self.db,
            self.user,
            self.node,
            self.request("formal-bootstrap"),
            write_messages=True,
        )
        self.db.commit()

        self.assertEqual(result.observation.alignment_status, "bootstrap")
        self.assertEqual(result.observation.appended_count, 3)
        self.assertEqual(
            [item.conversation_sequence for item in result.appended_messages],
            [1, 2, 3],
        )
        self.assertTrue(all(item.collection_kind == "bootstrap" for item in result.appended_messages))
        self.assertTrue(all(not item.automation_eligible for item in result.appended_messages))

    def test_unread_bootstrap_selects_only_customer_tail_as_reply_source(self) -> None:
        self.db.query(Message).delete()
        self.conversation.last_message_sequence = 0
        self.db.commit()

        request = self.request("unread-bootstrap-trigger")
        result = process_message_snapshot(
            self.db,
            self.user,
            self.node,
            request,
            write_messages=True,
        )
        self.db.commit()

        source = select_inbound_reply_source(self.db, request, result.appended_messages)
        self.assertIsNotNone(source)
        self.assertEqual(source.content, "有货吗")
        self.assertEqual(source.collection_kind, "bootstrap")
        self.assertFalse(source.automation_eligible)

    def test_read_bootstrap_never_selects_reply_source(self) -> None:
        self.db.query(Message).delete()
        self.conversation.last_message_sequence = 0
        self.db.commit()
        request = self.request("read-bootstrap")
        request.payload_json["unread"] = False

        result = process_message_snapshot(
            self.db,
            self.user,
            self.node,
            request,
            write_messages=True,
        )
        self.db.commit()

        self.assertIsNone(
            select_inbound_reply_source(self.db, request, result.appended_messages)
        )

    def test_unread_bootstrap_with_active_send_task_does_not_select_reply_source(self) -> None:
        self.db.query(Message).delete()
        self.conversation.last_message_sequence = 0
        self.db.add(RpaTask(
            user_id=self.user.id,
            platform_account_id=self.account.id,
            conversation_id=self.conversation.id,
            task_type="send_message",
            platform_code="pinduoduo",
            status="queued",
        ))
        self.db.commit()
        request = self.request("unread-bootstrap-active-task")

        result = process_message_snapshot(
            self.db,
            self.user,
            self.node,
            request,
            write_messages=True,
        )
        self.db.commit()

        self.assertIsNone(
            select_inbound_reply_source(self.db, request, result.appended_messages)
        )

    def test_incremental_batch_selects_only_last_customer_message(self) -> None:
        messages = [
            *self.messages()[:2],
            {
                "dom_sequence": 2,
                "sender_role": "customer",
                "message_type": "text",
                "content": "第一条新消息",
                "platform_message_id": "new-customer-1",
            },
            {
                "dom_sequence": 3,
                "sender_role": "customer",
                "message_type": "text",
                "content": "第二条新消息",
                "platform_message_id": "new-customer-2",
            },
        ]
        request = self.request(
            "incremental-customer-tail",
            messages=messages,
            message_count=len(messages),
            payload_hash=snapshot_payload_hash(messages),
        )
        result = process_message_snapshot(
            self.db,
            self.user,
            self.node,
            request,
            write_messages=True,
        )
        self.db.commit()

        source = select_inbound_reply_source(self.db, request, result.appended_messages)
        self.assertEqual([item.content for item in result.appended_messages], [
            "第一条新消息",
            "第二条新消息",
        ])
        self.assertIsNotNone(source)
        self.assertEqual(source.content, "第二条新消息")
        self.assertEqual(source.conversation_sequence, 4)

    def test_incremental_agent_tail_does_not_select_reply_source(self) -> None:
        messages = [
            *self.messages()[:2],
            {
                "dom_sequence": 2,
                "sender_role": "customer",
                "message_type": "text",
                "content": "客户追问",
                "platform_message_id": "new-customer",
            },
            {
                "dom_sequence": 3,
                "sender_role": "agent",
                "message_type": "text",
                "content": "平台人工已回复",
                "platform_message_id": "new-agent",
            },
        ]
        request = self.request(
            "incremental-agent-tail",
            messages=messages,
            message_count=len(messages),
            payload_hash=snapshot_payload_hash(messages),
        )
        result = process_message_snapshot(
            self.db,
            self.user,
            self.node,
            request,
            write_messages=True,
        )
        self.db.commit()

        self.assertIsNone(
            select_inbound_reply_source(self.db, request, result.appended_messages)
        )

    def test_duplicate_snapshot_and_retry_do_not_select_reply_source(self) -> None:
        request = self.request("single-trigger")
        first = process_message_snapshot(
            self.db,
            self.user,
            self.node,
            request,
            write_messages=True,
        )
        self.db.commit()
        retry = process_message_snapshot(
            self.db,
            self.user,
            self.node,
            request,
            write_messages=True,
        )
        duplicate_request = self.request("duplicate-trigger")
        duplicate = process_message_snapshot(
            self.db,
            self.user,
            self.node,
            duplicate_request,
            write_messages=True,
        )
        self.db.commit()

        self.assertIsNotNone(
            select_inbound_reply_source(self.db, request, first.appended_messages)
        )
        self.assertIsNone(
            select_inbound_reply_source(self.db, request, retry.appended_messages)
        )
        self.assertEqual(duplicate.observation.alignment_status, "duplicate")
        self.assertIsNone(
            select_inbound_reply_source(self.db, duplicate_request, duplicate.appended_messages)
        )

    def test_formal_snapshot_retry_does_not_append_twice(self) -> None:
        request = self.request("formal-retry")
        first = process_message_snapshot(
            self.db, self.user, self.node, request, write_messages=True
        )
        self.db.commit()
        count_after_first = self.db.scalar(select(func.count()).select_from(Message))
        second = process_message_snapshot(
            self.db, self.user, self.node, request, write_messages=True
        )
        self.db.commit()

        self.assertEqual(first.observation.id, second.observation.id)
        self.assertEqual(second.appended_messages, [])
        self.assertEqual(
            self.db.scalar(select(func.count()).select_from(Message)),
            count_after_first,
        )

    def test_formal_snapshot_preserves_repeated_occurrences(self) -> None:
        repeated = [
            *self.messages()[:2],
            {
                "dom_sequence": 2,
                "sender_role": "customer",
                "message_type": "text",
                "content": "哈喽",
                "platform_message_id": "repeat-1",
            },
            {
                "dom_sequence": 3,
                "sender_role": "customer",
                "message_type": "text",
                "content": "哈喽",
                "platform_message_id": "repeat-2",
            },
        ]
        result = process_message_snapshot(
            self.db,
            self.user,
            self.node,
            self.request(
                "formal-repeated",
                messages=repeated,
                message_count=len(repeated),
                payload_hash=snapshot_payload_hash(repeated),
            ),
            write_messages=True,
        )
        self.db.commit()

        self.assertEqual(result.observation.alignment_status, "aligned")
        self.assertEqual([item.content for item in result.appended_messages], ["哈喽", "哈喽"])
        self.assertEqual(
            [item.conversation_sequence for item in result.appended_messages],
            [3, 4],
        )

    def test_formal_unaligned_snapshot_never_mutates_queue(self) -> None:
        messages = [{
            "dom_sequence": 0,
            "sender_role": "customer",
            "message_type": "text",
            "content": "完全无关",
            "platform_message_id": None,
        }]
        before_count = self.db.scalar(select(func.count()).select_from(Message))
        before_tail = self.conversation.last_message_sequence
        result = process_message_snapshot(
            self.db,
            self.user,
            self.node,
            self.request(
                "formal-unaligned",
                messages=messages,
                message_count=1,
                payload_hash=snapshot_payload_hash(messages),
            ),
            write_messages=True,
        )
        self.db.commit()

        self.assertEqual(result.observation.alignment_status, "unaligned")
        self.assertEqual(result.observation.appended_count, 0)
        self.assertEqual(self.db.scalar(select(func.count()).select_from(Message)), before_count)
        self.db.refresh(self.conversation)
        self.assertEqual(self.conversation.last_message_sequence, before_tail)

    def test_formal_snapshot_attaches_platform_echo_to_local_outbound(self) -> None:
        outbound = self.db.scalar(
            select(Message).where(Message.conversation_id == self.conversation.id).order_by(
                Message.conversation_sequence.desc()
            )
        )
        self.assertIsNotNone(outbound)
        outbound.platform_message_id = None
        outbound.source = "desktop"
        self.db.commit()
        echoed = self.messages()[:2]
        echoed[1]["platform_message_id"] = "echo-agent"

        result = process_message_snapshot(
            self.db,
            self.user,
            self.node,
            self.request(
                "formal-echo",
                messages=echoed,
                message_count=2,
                payload_hash=snapshot_payload_hash(echoed),
            ),
            write_messages=True,
        )
        self.db.commit()

        self.assertEqual(result.observation.alignment_status, "duplicate")
        self.assertEqual(result.observation.appended_count, 0)
        self.db.refresh(outbound)
        self.assertEqual(outbound.platform_message_id, "echo-agent")
        self.assertEqual(outbound.raw_payload["platform_echo"]["observation_id"], "formal-echo")

    def test_formal_snapshot_aligns_dom_collapsed_outbound_then_appends_customer(self) -> None:
        customer = self.db.scalar(
            select(Message).where(
                Message.conversation_id == self.conversation.id,
                Message.sender_role == "customer",
            ).order_by(Message.conversation_sequence)
        )
        outbound = self.db.scalar(
            select(Message).where(
                Message.conversation_id == self.conversation.id,
                Message.sender_role == "agent",
            ).order_by(Message.conversation_sequence.desc())
        )
        self.assertIsNotNone(customer)
        self.assertIsNotNone(outbound)
        outbound.content = "您好\n\n请问需要什么帮助"
        outbound.platform_message_id = None
        outbound.source = "desktop"
        self.db.commit()
        messages = [
            {
                "dom_sequence": 0,
                "sender_role": "customer",
                "message_type": "text",
                "content": customer.content,
                "platform_message_id": customer.platform_message_id,
            },
            {
                "dom_sequence": 1,
                "sender_role": "agent",
                "message_type": "text",
                "content": "您好请问需要什么帮助",
                "platform_message_id": "collapsed-agent-echo",
            },
            {
                "dom_sequence": 2,
                "sender_role": "customer",
                "message_type": "text",
                "content": "怎么看键盘是否适配",
                "platform_message_id": "new-customer-question",
            },
        ]

        result = process_message_snapshot(
            self.db,
            self.user,
            self.node,
            self.request(
                "collapsed-outbound-echo",
                messages=messages,
                message_count=len(messages),
                payload_hash=snapshot_payload_hash(messages),
            ),
            write_messages=True,
        )
        self.db.commit()

        self.assertEqual(result.observation.alignment_status, "aligned")
        self.assertEqual(result.observation.alignment_method, "platform_id_anchor")
        self.assertEqual(result.observation.appended_count, 1)
        self.assertEqual(result.appended_messages[0].content, "怎么看键盘是否适配")
        self.db.refresh(outbound)
        self.assertEqual(outbound.platform_message_id, "collapsed-agent-echo")
        self.assertEqual(
            outbound.raw_payload["platform_echo"]["observation_id"],
            "collapsed-outbound-echo",
        )

    def test_formal_snapshot_aligns_qa_text_and_uploaded_image_then_appends_customer(self) -> None:
        customer = self.db.scalar(
            select(Message).where(
                Message.conversation_id == self.conversation.id,
                Message.sender_role == "customer",
            ).order_by(Message.conversation_sequence)
        )
        outbound_text = self.db.scalar(
            select(Message).where(
                Message.conversation_id == self.conversation.id,
                Message.sender_role == "agent",
            ).order_by(Message.conversation_sequence.desc())
        )
        self.assertIsNotNone(customer)
        self.assertIsNotNone(outbound_text)
        outbound_text.content = "第一行\n第二行"
        outbound_text.platform_message_id = None
        outbound_text.source = "desktop"
        outbound_image = Message(
            conversation_id=self.conversation.id,
            user_id=self.user.id,
            platform_code="pinduoduo",
            sender_role="agent",
            content="[图片]",
            source="ai",
            message_status="confirmation_pending",
            conversation_sequence=3,
            raw_payload={
                "media_type": "image",
                "image_url": "http://127.0.0.1:8010/api/v1/qa-assets/answer.png",
            },
        )
        self.conversation.last_message_sequence = 3
        self.db.add(outbound_image)
        self.db.commit()
        messages = [
            {
                "dom_sequence": 0,
                "sender_role": "customer",
                "message_type": "text",
                "content": customer.content,
                "platform_message_id": customer.platform_message_id,
            },
            {
                "dom_sequence": 1,
                "sender_role": "agent",
                "message_type": "text",
                "content": "第一行第二行",
                "platform_message_id": "qa-text-echo",
            },
            {
                "dom_sequence": 2,
                "sender_role": "agent",
                "message_type": "image",
                "content": "[图片]",
                "image_url": "https://chat-img.pddugc.com/uploaded-answer.png?token=temp",
                "platform_message_id": "qa-image-echo",
            },
            {
                "dom_sequence": 3,
                "sender_role": "customer",
                "message_type": "text",
                "content": "蓝牙怎么连接",
                "platform_message_id": "new-customer-question",
            },
        ]

        result = process_message_snapshot(
            self.db,
            self.user,
            self.node,
            self.request(
                "qa-text-image-echo",
                messages=messages,
                message_count=len(messages),
                payload_hash=snapshot_payload_hash(messages),
            ),
            write_messages=True,
        )
        self.db.commit()

        self.assertEqual(result.observation.alignment_status, "aligned")
        self.assertEqual(result.observation.alignment_method, "platform_id_anchor")
        self.assertEqual([item.content for item in result.appended_messages], ["蓝牙怎么连接"])
        self.db.refresh(outbound_text)
        self.db.refresh(outbound_image)
        self.assertEqual(outbound_text.platform_message_id, "qa-text-echo")
        self.assertEqual(outbound_image.platform_message_id, "qa-image-echo")
        self.assertEqual(outbound_image.message_status, "sent")

    def test_snapshot_diagnostics_describe_ordered_snapshot(self) -> None:
        messages = self.messages()
        request = self.request("diagnostics")
        observation = observe_message_snapshot(self.db, self.user, self.node, request)
        self.db.commit()

        metrics = observation.diagnostics_json["snapshot_metrics"]
        self.assertEqual(metrics["message_count"], len(messages))
        self.assertEqual(metrics["direction_counts"], {"customer": 2, "agent": 1})
        self.assertEqual(metrics["platform_id_missing_count"], 1)
        self.assertNotIn("legacy_snapshot_comparison", observation.diagnostics_json)

    def test_empty_formal_queue_is_classified_as_bootstrap_without_appending(self) -> None:
        self.db.query(Message).delete()
        self.conversation.last_message_sequence = 0
        self.db.commit()
        observation = observe_message_snapshot(
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
        observation = observe_message_snapshot(self.db, self.user, self.node, request)
        self.db.commit()
        self.assertEqual(observation.alignment_status, "duplicate")
        self.assertEqual(observation.overlap_size, 2)
        self.assertEqual(observation.projected_append_count, 0)

    def test_disabled_rpa_event_entrypoint_does_not_process_snapshot(self) -> None:
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
        self.assertIsNone(observation)

    def test_snapshot_shop_mode_writes_snapshot_and_suppresses_legacy_events(self) -> None:
        self.account.metadata_json = {"pdd_message_snapshot_write_enabled": True}
        self.db.commit()
        settings = Settings(
            _env_file=None,
            PDD_MESSAGE_SNAPSHOT_WRITE_ENABLED=True,
        )
        with patch("app.services.rpa_service.get_settings", return_value=settings):
            snapshot_event, appended, changed = create_event(
                self.db,
                self.user,
                self.node,
                self.request("formal-rpa-entrypoint"),
            )
            legacy_request = RpaEventCreate(
                event_id="legacy-suppressed",
                event_type="message_received",
                platform_code="pinduoduo",
                platform_account_id=self.account.id,
                platform_message_id="legacy-new",
                conversation_external_id="same-external-id",
                payload_json={
                    "customer_name": "Customer",
                    "sender_role": "customer",
                    "content": "旧事件不能再写入",
                },
            )
            legacy_event, legacy_messages, legacy_conversations = create_event(
                self.db,
                self.user,
                self.node,
                legacy_request,
            )

        self.assertEqual(snapshot_event.status, "processed")
        self.assertEqual([item.content for item in appended], ["有货吗"])
        self.assertEqual([item.id for item in changed], [self.conversation.id])
        self.assertEqual(legacy_messages, [])
        self.assertEqual(legacy_conversations, [])
        self.assertTrue(legacy_event.payload_json["legacy_write_suppressed"])
        self.assertEqual(legacy_event.payload_json["message_write_mode"], "snapshot")
        self.assertIsNone(
            self.db.scalar(
                select(Message).where(Message.platform_message_id == "legacy-new")
            )
        )

    def test_unaligned_first_snapshot_does_not_suppress_legacy_fallback(self) -> None:
        self.account.metadata_json = {"pdd_message_snapshot_write_enabled": True}
        self.db.commit()
        settings = Settings(
            _env_file=None,
            PDD_MESSAGE_SNAPSHOT_WRITE_ENABLED=True,
        )
        unrelated = [{
            "dom_sequence": 0,
            "sender_role": "customer",
            "message_type": "text",
            "content": "无法对齐",
            "platform_message_id": "unaligned-new",
        }]
        with patch("app.services.rpa_service.get_settings", return_value=settings):
            snapshot_event, appended, _ = create_event(
                self.db,
                self.user,
                self.node,
                self.request(
                    "unaligned-first-switch",
                    messages=unrelated,
                    message_count=1,
                    payload_hash=snapshot_payload_hash(unrelated),
                ),
            )
            legacy_request = RpaEventCreate(
                event_id="legacy-fallback",
                event_type="message_received",
                platform_code="pinduoduo",
                platform_account_id=self.account.id,
                platform_message_id="legacy-fallback-id",
                conversation_external_id="same-external-id",
                payload_json={
                    "sender_role": "customer",
                    "content": "旧链路继续兜底",
                },
            )
            legacy_event, legacy_messages, _ = create_event(
                self.db,
                self.user,
                self.node,
                legacy_request,
            )

        self.assertEqual(snapshot_event.status, "processed")
        self.assertEqual(appended, [])
        self.assertEqual(legacy_messages, [])
        self.assertTrue(legacy_event.payload_json["legacy_write_suppressed"])

    def test_same_observation_retry_returns_existing_result(self) -> None:
        first = observe_message_snapshot(self.db, self.user, self.node, self.request("retry"))
        self.db.commit()
        second = observe_message_snapshot(self.db, self.user, self.node, self.request("retry"))
        self.db.commit()
        self.assertEqual(second.id, first.id)
        self.assertEqual(self.db.scalar(select(func.count()).select_from(MessageObservation)), 1)

    def test_same_observation_with_different_hash_preserves_previous_result(self) -> None:
        first = observe_message_snapshot(self.db, self.user, self.node, self.request("conflict"))
        self.db.commit()
        settings = Settings(_env_file=None, PDD_MESSAGE_SNAPSHOT_WRITE_ENABLED=True)
        with patch("app.services.rpa_service.get_settings", return_value=settings):
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
        observation = observe_message_snapshot(
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
        observation = observe_message_snapshot(self.db, self.user, self.node, second_batch)
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
        observation = observe_message_snapshot(self.db, self.user, self.node, first_batch)
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
        observation = observe_message_snapshot(self.db, self.user, self.node, first_batch)
        self.db.commit()
        observation = observe_message_snapshot(self.db, self.user, self.node, first_batch)
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
        observation = observe_message_snapshot(self.db, self.user, self.node, changed)
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

        observation = observe_message_snapshot(
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
