from __future__ import annotations

import unittest
from unittest.mock import patch

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.models import (
    Base,
    Conversation,
    Message,
    PlatformAccount,
    Robot,
    RobotPlatformScope,
    RpaNode,
    RpaTask,
    StoreProduct,
    User,
    UserSettings,
)
from app.schemas.rpa import RpaEventCreate, TaskCompleteRequest
from app.services.message_sequence_service import snapshot_payload_hash
from app.services.rpa_service import get_or_create_desktop_ingest_node
from app.services.rpa_service import create_event, complete_task, maybe_queue_entry_welcome


class RpaServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.user = User(
            username="rpa-service",
            display_name="RPA Service",
            password_hash="not-used",
        )
        self.db.add(self.user)
        self.db.flush()
        self.account = PlatformAccount(
            user_id=self.user.id,
            platform_code="pinduoduo",
            platform_name="拼多多",
            local_account_id="rpa-product-account",
            account_name="测试店铺",
        )
        self.db.add(self.account)
        self.db.commit()

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

    def test_desktop_ingest_node_is_created_and_reused(self) -> None:
        node = get_or_create_desktop_ingest_node(self.db, self.user)

        self.assertEqual(node.node_key, f"{self.user.id}:desktop-ingest")
        self.assertEqual(node.hostname, "desktop-electron")
        self.assertEqual(node.machine_name, "desktop-electron")
        self.assertEqual(node.status, "online")
        self.assertIn("pinduoduo", node.supported_platforms)

        node.status = "offline"
        self.db.add(node)
        self.db.commit()

        reused = get_or_create_desktop_ingest_node(self.db, self.user)
        nodes = self.db.scalars(
            select(RpaNode).where(RpaNode.user_id == self.user.id)
        ).all()

        self.assertEqual(reused.id, node.id)
        self.assertEqual(reused.status, "online")
        self.assertEqual(len(nodes), 1)

    def test_store_products_event_does_not_create_customer_conversation(self) -> None:
        node = get_or_create_desktop_ingest_node(self.db, self.user)
        request = RpaEventCreate(
            event_id="store-products-event-1",
            dedup_key="store-products-dedup-1",
            event_type="store_products_snapshot",
            platform_code="pinduoduo",
            platform_account_id=self.account.id,
            payload_json={
                "collection_status": "success",
                "products": [
                    {
                        "goods_id": "2001",
                        "product_id": "2001",
                        "title": "店铺商品",
                    },
                ],
                "page_summary": {"total_count": 1, "has_more": False},
            },
        )

        event, messages, conversations = create_event(self.db, self.user, node, request)

        self.assertEqual(event.event_type, "store_products_snapshot")
        self.assertEqual(messages, [])
        self.assertEqual(conversations, [])
        self.assertEqual(self.db.query(StoreProduct).count(), 1)

    def test_new_customer_message_queues_entry_welcome_once(self) -> None:
        self.db.add(UserSettings(user_id=self.user.id, auto_reply_enabled=True))
        robot = Robot(
            user_id=self.user.id,
            name="Welcome Robot",
            status="online",
            enabled=True,
            config_json={
                "allow_auto_send": True,
                "entry_welcome_enabled": True,
                "entry_welcome_text": "欢迎光临，发送转人工可为您转接客服。",
            },
        )
        self.db.add(robot)
        self.db.flush()
        self.db.add(RobotPlatformScope(robot_id=robot.id, platform_code="all", all_accounts=True))
        self.db.commit()
        node = get_or_create_desktop_ingest_node(self.db, self.user)
        request = RpaEventCreate(
            event_id="welcome-customer-message-1",
            event_type="customer_message",
            platform_code="wechat",
            platform_account_id=self.account.id,
            platform_message_id="welcome-message-1",
            conversation_external_id="welcome-customer-1",
            payload_json={
                "customer_name": "新客户",
                "sender_role": "customer",
                "content": "你好",
            },
        )

        _, messages, conversations = create_event(self.db, self.user, node, request)
        task_id = maybe_queue_entry_welcome(self.db, self.user, messages[0])
        duplicate_task_id = maybe_queue_entry_welcome(self.db, self.user, messages[0])

        self.assertEqual(len(conversations), 1)
        self.assertIsNotNone(task_id)
        self.assertIsNone(duplicate_task_id)
        tasks = self.db.scalars(select(RpaTask).where(RpaTask.task_type == "send_message")).all()
        self.assertEqual(len(tasks), 1)
        self.assertEqual(tasks[0].payload_json["content"], "欢迎光临，发送转人工可为您转接客服。")
        self.assertEqual(tasks[0].payload_json["source"], "automation")
        self.db.refresh(conversations[0])
        self.assertEqual(conversations[0].metadata_json["entry_welcome"]["status"], "queued")

    def test_existing_conversation_does_not_queue_entry_welcome(self) -> None:
        self.db.add(UserSettings(user_id=self.user.id, auto_reply_enabled=True))
        robot = Robot(
            user_id=self.user.id,
            name="Welcome Robot",
            status="online",
            enabled=True,
            config_json={"allow_auto_send": True, "entry_welcome_enabled": True},
        )
        self.db.add(robot)
        self.db.flush()
        self.db.add(RobotPlatformScope(robot_id=robot.id, platform_code="all", all_accounts=True))
        conversation = Conversation(
            user_id=self.user.id,
            platform_code="wechat",
            platform_account_id=self.account.id,
            external_conversation_id="existing-customer-1",
            customer_name="老客户",
        )
        self.db.add(conversation)
        self.db.commit()
        node = get_or_create_desktop_ingest_node(self.db, self.user)
        request = RpaEventCreate(
            event_id="welcome-existing-message-1",
            event_type="customer_message",
            platform_code="wechat",
            platform_account_id=self.account.id,
            platform_message_id="existing-message-1",
            conversation_external_id="existing-customer-1",
            payload_json={
                "customer_name": "老客户",
                "sender_role": "customer",
                "content": "还在吗",
            },
        )

        _, messages, _ = create_event(self.db, self.user, node, request)
        task_id = maybe_queue_entry_welcome(self.db, self.user, messages[0])

        self.assertIsNone(task_id)
        self.assertEqual(self.db.query(RpaTask).count(), 0)

    def test_entry_welcome_is_skipped_when_global_auto_reply_is_disabled(self) -> None:
        self.db.add(UserSettings(user_id=self.user.id, auto_reply_enabled=False))
        robot = Robot(
            user_id=self.user.id,
            name="Welcome Robot",
            status="online",
            enabled=True,
            config_json={"allow_auto_send": True, "entry_welcome_enabled": True},
        )
        self.db.add(robot)
        self.db.flush()
        self.db.add(RobotPlatformScope(robot_id=robot.id, platform_code="all", all_accounts=True))
        self.db.commit()
        node = get_or_create_desktop_ingest_node(self.db, self.user)
        request = RpaEventCreate(
            event_id="welcome-disabled-message-1",
            event_type="customer_message",
            platform_code="wechat",
            platform_account_id=self.account.id,
            platform_message_id="welcome-disabled-message-1",
            conversation_external_id="welcome-disabled-customer-1",
            payload_json={
                "customer_name": "新客户",
                "sender_role": "customer",
                "content": "你好",
            },
        )

        _, messages, conversations = create_event(self.db, self.user, node, request)
        task_id = maybe_queue_entry_welcome(self.db, self.user, messages[0])

        self.assertIsNone(task_id)
        self.assertEqual(self.db.query(RpaTask).count(), 0)
        self.db.refresh(conversations[0])
        self.assertEqual(conversations[0].metadata_json["entry_welcome"]["status"], "skipped")
        self.assertEqual(conversations[0].metadata_json["entry_welcome"]["reason"], "auto_reply_disabled")

    def test_pdd_snapshot_new_conversation_queues_entry_welcome_after_first_customer_message(self) -> None:
        self.db.add(UserSettings(user_id=self.user.id, auto_reply_enabled=True))
        robot = Robot(
            user_id=self.user.id,
            name="PDD Welcome Robot",
            status="online",
            enabled=True,
            config_json={"allow_auto_send": True, "entry_welcome_enabled": True},
        )
        self.db.add(robot)
        self.db.flush()
        self.db.add(RobotPlatformScope(robot_id=robot.id, platform_code="pinduoduo", all_accounts=True))
        self.db.commit()
        node = get_or_create_desktop_ingest_node(self.db, self.user)
        conversation_request = RpaEventCreate(
            event_id="pdd-welcome-conversation-1",
            dedup_key="pdd-welcome-conversation-1",
            event_type="conversation_snapshot",
            platform_code="pinduoduo",
            platform_account_id=self.account.id,
            conversation_external_id="pdd-customer-1",
            payload_json={
                "customer_name": "拼多多新客",
                "title": "拼多多新客",
                "content": "你好",
                "unread_count": 1,
            },
        )
        snapshot_messages = [{
            "dom_sequence": 0,
            "sender_role": "customer",
            "message_type": "text",
            "content": "你好",
            "display_mode": "bubble",
            "automation_mode": "trigger",
        }]
        snapshot_request = RpaEventCreate(
            event_id="pdd-welcome-message-snapshot-1",
            event_type="message_snapshot",
            platform_code="pinduoduo",
            platform_account_id=self.account.id,
            conversation_external_id="pdd-customer-1",
            payload_json={
                "observation_id": "pdd-welcome-observation-1",
                "collected_at": "2026-08-28T10:00:00Z",
                "unread": True,
                "payload_hash": snapshot_payload_hash(snapshot_messages),
                "message_count": 1,
                "batch_index": 0,
                "batch_count": 1,
                "message_offset": 0,
                "messages": snapshot_messages,
            },
        )
        settings = Settings(_env_file=None, PDD_MESSAGE_SNAPSHOT_WRITE_ENABLED=True)

        with patch("app.services.rpa_service.get_settings", return_value=settings):
            _, _, conversations = create_event(self.db, self.user, node, conversation_request)
            _, messages, _ = create_event(self.db, self.user, node, snapshot_request)

        self.assertEqual(len(conversations), 1)
        self.assertEqual(conversations[0].metadata_json["entry_welcome"]["status"], "candidate")
        task_id = maybe_queue_entry_welcome(self.db, self.user, messages[0])

        self.assertIsNotNone(task_id)
        task = self.db.get(RpaTask, task_id)
        self.assertEqual(task.payload_json["content"], "亲亲，我是本店小助理，发送“转人工”可为您转接客服。")

    def test_send_ack_completion_creates_transfer_task(self) -> None:
        conversation = Conversation(
            user_id=self.user.id,
            platform_code="pinduoduo",
            platform_account_id=self.account.id,
            external_conversation_id="customer-1",
            customer_name="买家",
        )
        self.db.add(conversation)
        self.db.flush()
        message = Message(
            conversation_id=conversation.id,
            user_id=self.user.id,
            platform_code="pinduoduo",
            sender_role="agent",
            content="好的，稍等一下",
            message_status="queued",
        )
        self.db.add(message)
        self.db.flush()
        task = RpaTask(
            user_id=self.user.id,
            platform_account_id=self.account.id,
            conversation_id=conversation.id,
            message_id=message.id,
            task_type="send_message",
            platform_code="pinduoduo",
            payload_json={
                "after_send_transfer_conversation": {
                    "idempotency_key": "auto-transfer:robot-1:message-1",
                    "robot_id": "robot-1",
                    "source_message_id": "message-1",
                    "trigger_reason": "human_handoff",
                    "trans_reason": "无原因直接转移",
                }
            },
            status="acknowledged",
        )
        self.db.add(task)
        self.db.commit()

        complete_task(
            self.db,
            task,
            TaskCompleteRequest(status="completed", result_json={"text_sent": True}),
        )

        transfer_task = self.db.scalar(
            select(RpaTask).where(RpaTask.task_type == "transfer_conversation")
        )
        self.assertIsNotNone(transfer_task)
        self.assertEqual(transfer_task.payload_json["external_conversation_id"], "customer-1")
        self.assertEqual(transfer_task.payload_json["trans_reason"], "无原因直接转移")
        self.db.refresh(conversation)
        self.assertEqual(conversation.metadata_json["auto_transfer"]["status"], "transferring")


if __name__ == "__main__":
    unittest.main()
