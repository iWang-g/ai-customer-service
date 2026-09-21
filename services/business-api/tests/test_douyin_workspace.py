import unittest

from fastapi import HTTPException
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.models import Base, Conversation, Message, PlatformAccount, Robot, RobotPlatformScope, RpaTask, User
from app.schemas.message import SendMessageRequest
from app.schemas.platform import platform_display_name
from app.schemas.rpa import PlatformAccountSyncRequest, RpaEventCreate
from app.services.automation_service import _active_robot
from app.services.message_service import create_send_task
from app.services.rpa_service import _active_robot_for_conversation, create_event, get_or_create_desktop_ingest_node, select_inbound_reply_source


class DouyinWorkspaceTests(unittest.TestCase):
    def test_account_sync_accepts_workspace_metadata(self):
        request = PlatformAccountSyncRequest(platform_code="douyin", accounts=[{
            "platform_code": "douyin", "local_account_id": "local-1",
            "account_name": "测试店铺", "external_account_id": "12345678901234567890",
            "metadata_json": {"workspace_only": True, "message_send_enabled": False},
        }])
        self.assertEqual(request.accounts[0].external_account_id, "12345678901234567890")
        self.assertEqual(platform_display_name(request.platform_code), "抖店")

    def test_all_platform_robot_cannot_send_to_m0_store(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        try:
            with Session(engine) as db:
                user = User(username="douyin-test", display_name="Test", password_hash="unused")
                db.add(user)
                db.flush()
                conversation = Conversation(user_id=user.id, platform_code="douyin", external_conversation_id="c1")
                robot = Robot(user_id=user.id, name="All stores", status="online", enabled=True)
                db.add_all([conversation, robot])
                db.flush()
                db.add(RobotPlatformScope(robot_id=robot.id, platform_code="all", all_accounts=True))
                db.commit()
                self.assertIsNone(_active_robot(db, user, conversation))
                self.assertIsNone(_active_robot_for_conversation(db, user, conversation))
                for override in (None, "pinduoduo"):
                    with self.assertRaises(HTTPException) as error:
                        create_send_task(db, user, SendMessageRequest(
                            conversation_id=conversation.id, content="test", platform_code=override,
                        ))
                    self.assertEqual(error.exception.status_code, 409)
                self.assertEqual(db.scalars(select(RpaTask)).all(), [])
        finally:
            engine.dispose()

    def test_realtime_customer_and_agent_events_are_idempotent(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        try:
            with Session(engine) as db:
                user = User(username="douyin-events", display_name="Test", password_hash="unused")
                db.add(user)
                db.flush()
                account = PlatformAccount(
                    user_id=user.id, platform_code="douyin", platform_name="抖店",
                    local_account_id="local-1", account_name="测试店铺", external_account_id="shop",
                )
                db.add(account)
                db.commit()
                node = get_or_create_desktop_ingest_node(db, user)
                customer = {
                    "customer_name": "买家指纹",
                    "title": "买家指纹",
                    "sender_role": "customer",
                    "content": "你好",
                    "platform_sent_at": "2026-09-11T07:34:21.000Z",
                    "conversation_metadata": {"sub_conversation_short_id": "short-1"},
                }
                request = RpaEventCreate(
                    event_id="douyin-event-1", dedup_key="douyin-event-1", event_type="customer_message",
                    platform_code="douyin", platform_account_id=account.id,
                    platform_message_id="server-1", conversation_external_id="buyer:shop::2:1:pigeon",
                    payload_json=customer,
                )
                original_event, messages, conversations = create_event(db, user, node, request)
                self.assertEqual(len(messages), 1)
                self.assertEqual(len(conversations), 1)
                replay, replay_messages, _ = create_event(db, user, node, request)
                self.assertEqual(replay.id, original_event.id)
                self.assertEqual(replay_messages, [])
                conversation = conversations[0]
                self.assertEqual(conversation.unread_count, 1)
                self.assertIsNone(select_inbound_reply_source(db, request, messages))
                # A fresh envelope/source with the same server ID must not increase unread.
                create_event(db, user, node, request.model_copy(update={"event_id": "another-source", "dedup_key": "another-source"}))
                self.assertEqual(conversation.unread_count, 1)
                # Identical text with another server ID is a distinct message.
                create_event(db, user, node, request.model_copy(update={"event_id": "same-text", "dedup_key": "same-text", "platform_message_id": "server-3"}))
                self.assertEqual(conversation.unread_count, 2)
                agent_request = request.model_copy(update={
                    "event_id": "douyin-event-2", "dedup_key": "douyin-event-2",
                    "event_type": "agent_message", "platform_message_id": "server-2",
                    "payload_json": {**customer, "sender_role": "agent", "content": "您好", "platform_sent_at": "2026-09-11T07:34:24.000Z"},
                })
                _, agent_messages, _ = create_event(db, user, node, agent_request)
                self.assertEqual(len(agent_messages), 1)
                self.assertEqual(db.query(Message).count(), 3)
                self.assertFalse(conversation.awaiting_reply)
                create_event(db, user, node, request.model_copy(update={
                    "event_id": "late-history", "dedup_key": "late-history", "platform_message_id": "old-server-id",
                    "payload_json": {**customer, "content": "旧消息", "platform_sent_at": "2026-09-11T07:30:00.000Z"},
                }))
                self.assertEqual(conversation.latest_message_text, "您好")
                self.assertFalse(conversation.awaiting_reply)
                with self.assertRaises(HTTPException):
                    create_event(db, user, node, request.model_copy(update={
                        "event_id": "wrong-shop", "dedup_key": "wrong-shop",
                        "conversation_external_id": "buyer:other-shop::2:1:pigeon",
                    }))
        finally:
            engine.dispose()
