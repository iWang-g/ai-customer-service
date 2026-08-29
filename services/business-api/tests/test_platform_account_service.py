from __future__ import annotations

import unittest

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.models import Base, Conversation, Message, PlatformAccount, RpaEvent, RpaNode, User
from app.schemas.rpa import PlatformAccountSyncItem
from app.services.platform_account_service import sync_platform_accounts_for_node


class PlatformAccountServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.user = User(
            username="platform-sync",
            display_name="Platform Sync",
            password_hash="not-used",
        )
        self.db.add(self.user)
        self.db.flush()
        self.node = RpaNode(
            user_id=self.user.id,
            node_key="platform-sync-node",
            hostname="localhost",
        )
        self.db.add(self.node)
        self.db.flush()

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

    def test_sync_merges_rebound_local_account_into_existing_external_identity(self) -> None:
        stable = PlatformAccount(
            user_id=self.user.id,
            platform_code="pinduoduo",
            platform_name="拼多多",
            local_account_id="old-local",
            external_account_id="688523141",
            account_name="Old Shop",
            account_alias="Old Shop",
            is_active=False,
            login_status="offline",
        )
        rebound = PlatformAccount(
            user_id=self.user.id,
            platform_code="pinduoduo",
            platform_name="拼多多",
            local_account_id="new-local",
            account_name="待识别店铺名称",
            account_alias="待识别店铺名称",
            is_active=True,
            login_status="online",
        )
        self.db.add_all([stable, rebound])
        self.db.flush()
        stable_conversation = Conversation(
            user_id=self.user.id,
            platform_account_id=stable.id,
            platform_code="pinduoduo",
            external_conversation_id="8715744365612",
            customer_name="Old Customer",
        )
        self.db.add(stable_conversation)
        self.db.flush()
        self.db.add(
            Message(
                conversation_id=stable_conversation.id,
                user_id=self.user.id,
                platform_code="pinduoduo",
                platform_message_id="msg-1",
                sender_role="customer",
                content="old hello",
                conversation_sequence=1,
            )
        )
        conversation = Conversation(
            user_id=self.user.id,
            platform_account_id=rebound.id,
            platform_code="pinduoduo",
            external_conversation_id="8715744365612",
            customer_name="Customer",
        )
        self.db.add(conversation)
        self.db.flush()
        self.db.add_all([
            Message(
                conversation_id=conversation.id,
                user_id=self.user.id,
                platform_code="pinduoduo",
                platform_message_id="msg-1",
                sender_role="customer",
                content="old hello",
                conversation_sequence=1,
                collection_kind="bootstrap",
            ),
            Message(
                conversation_id=conversation.id,
                user_id=self.user.id,
                platform_code="pinduoduo",
                platform_message_id="msg-2",
                sender_role="customer",
                content="hello",
                conversation_sequence=2,
            ),
            RpaEvent(
                user_id=self.user.id,
                node_id=self.node.id,
                platform_account_id=rebound.id,
                event_id="rebound-event",
                event_type="message_snapshot",
                platform_code="pinduoduo",
                conversation_external_id="8715744365612",
                payload_json={},
            ),
        ])
        self.db.commit()

        synced = sync_platform_accounts_for_node(
            self.db,
            self.user,
            self.node,
            [
                PlatformAccountSyncItem(
                    platform_code="pinduoduo",
                    local_account_id="new-local",
                    account_name="小王小店9527",
                    account_alias="小王小店9527",
                    external_account_id="688523141",
                    login_status="online",
                    archived=False,
                    metadata_json={"workspace_partition": "persist:pdd-new-local"},
                )
            ],
            platform_code="pinduoduo",
        )

        self.assertEqual(len(synced), 1)
        self.assertEqual(synced[0].id, stable.id)
        self.assertEqual(synced[0].local_account_id, "new-local")
        self.assertEqual(synced[0].external_account_id, "688523141")
        self.assertEqual(synced[0].account_name, "小王小店9527")
        self.assertTrue(synced[0].is_active)
        self.assertEqual(synced[0].login_status, "online")

        merged = self.db.get(PlatformAccount, rebound.id)
        self.assertIsNotNone(merged)
        self.assertIsNone(merged.local_account_id)
        self.assertIsNone(merged.external_account_id)
        self.assertFalse(merged.is_active)
        self.assertEqual(merged.metadata_json["merged_into_platform_account_id"], stable.id)

        moved_conversation = self.db.get(Conversation, stable_conversation.id)
        self.assertEqual(moved_conversation.platform_account_id, stable.id)
        hidden_conversation = self.db.get(Conversation, conversation.id)
        self.assertEqual(hidden_conversation.status, "merged")
        self.assertIsNotNone(hidden_conversation.deleted_at)
        self.assertEqual(hidden_conversation.metadata_json["merged_into_conversation_id"], stable_conversation.id)
        messages = list(self.db.scalars(
            select(Message).where(Message.conversation_id == moved_conversation.id)
        ).all())
        contents = {message.content for message in messages}
        self.assertEqual(contents, {"old hello", "hello"})
        duplicate_matches = list(self.db.scalars(
            select(Message).where(
                Message.conversation_id == moved_conversation.id,
                Message.platform_message_id == "msg-1",
            )
        ).all())
        self.assertEqual(len(duplicate_matches), 1)
        moved_event = self.db.scalar(select(RpaEvent).where(RpaEvent.event_id == "rebound-event"))
        self.assertEqual(moved_event.platform_account_id, stable.id)


if __name__ == "__main__":
    unittest.main()
