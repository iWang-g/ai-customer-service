from __future__ import annotations

import unittest
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session

from app.models import (
    AutomationReplyRun,
    Base,
    Conversation,
    Message,
    Robot,
    RobotPlatformScope,
    RpaTask,
    User,
)
from app.schemas.automation import ReplyRunRequest
from app.schemas.message import SendMessageRequest
from app.services.automation_service import (
    _queue_reply_task,
    _snapshot_customer_batch_size,
    run_reply,
)
from app.services.message_service import create_send_task


class AutomationIdempotencyTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.user = User(
            username="automation-idempotency",
            display_name="Automation Test",
            password_hash="not-used",
        )
        self.db.add(self.user)
        self.db.flush()
        self.conversation = Conversation(
            user_id=self.user.id,
            platform_code="pinduoduo",
            external_conversation_id="customer-1",
            last_message_sequence=1,
        )
        self.robot = Robot(
            user_id=self.user.id,
            name="Auto Reply",
            status="online",
            enabled=True,
            config_json={"allow_auto_send": True},
        )
        self.db.add_all([self.conversation, self.robot])
        self.db.flush()
        self.db.add(
            RobotPlatformScope(
                robot_id=self.robot.id,
                platform_code="all",
                all_accounts=True,
            )
        )
        self.source_message = Message(
            conversation_id=self.conversation.id,
            user_id=self.user.id,
            platform_code="pinduoduo",
            sender_role="customer",
            content="Is this available?",
            conversation_sequence=1,
        )
        self.db.add(self.source_message)
        self.db.commit()

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

    async def test_source_message_can_create_only_one_reply_run(self) -> None:
        request = ReplyRunRequest(
            conversation_id=self.conversation.id,
            source_message_id=self.source_message.id,
        )
        result = {
            "decision": "auto_send",
            "trace_id": "trace-1",
            "intent": {"intent": "qa_match"},
            "qa_match": {
                "match_type": "exact",
                "entry": {
                    "id": "qa-1",
                    "category_id": "category-1",
                    "category": "物流问题",
                },
            },
            "retrieval": [],
            "task_ids": [],
        }
        with patch(
            "app.services.automation_service._execute_bound_reply",
            new=AsyncMock(return_value=result),
        ) as execute:
            self.assertEqual(await run_reply(self.db, self.user, request), result)
            with self.assertRaises(HTTPException) as context:
                await run_reply(self.db, self.user, request)

        self.assertEqual(context.exception.status_code, 409)
        execute.assert_awaited_once()
        count = self.db.scalar(select(func.count()).select_from(AutomationReplyRun))
        self.assertEqual(count, 1)
        reply_run = self.db.scalar(select(AutomationReplyRun))
        self.assertEqual(reply_run.intent, "qa_match")
        self.assertEqual(reply_run.qa_category_name, "物流问题")
        self.assertEqual(reply_run.qa_match_type, "exact")
        self.assertEqual(reply_run.trigger_sequence, 1)
        self.assertFalse(reply_run.document_retrieval_used)

    def test_auto_send_idempotency_key_reuses_message_and_task(self) -> None:
        request = SendMessageRequest(
            conversation_id=self.conversation.id,
            content="Yes, it is available.",
        )
        key = f"auto-reply:{self.robot.id}:{self.source_message.id}:text"

        first = create_send_task(self.db, self.user, request, idempotency_key=key)
        second = create_send_task(self.db, self.user, request, idempotency_key=key)

        self.assertEqual(second.task_id, first.task_id)
        self.assertEqual(second.message.id, first.message.id)
        task_count = self.db.scalar(select(func.count()).select_from(RpaTask))
        agent_message_count = self.db.scalar(
            select(func.count())
            .select_from(Message)
            .where(Message.sender_role == "agent")
        )
        self.assertEqual(task_count, 1)
        self.assertEqual(agent_message_count, 1)

    def test_auto_send_task_records_snapshot_trigger_sequence(self) -> None:
        task_id = _queue_reply_task(
            self.db,
            self.user,
            self.conversation,
            self.robot,
            self.source_message,
            {
                "decision": "auto_send",
                "text": "Yes, it is available.",
                "media": [],
            },
            auto_send_allowed=True,
        )

        self.assertIsNotNone(task_id)
        task = self.db.get(RpaTask, task_id)
        self.assertEqual(task.payload_json["automation_source_message_id"], self.source_message.id)
        self.assertEqual(task.payload_json["automation_trigger_sequence"], 1)

    def test_snapshot_batch_context_counts_only_contiguous_customer_tail(self) -> None:
        self.source_message.conversation_sequence = 4
        self.source_message.collection_kind = "incremental"
        self.source_message.first_observation_id = "snapshot-context"
        self.source_message.first_dom_sequence = 4
        self.conversation.last_message_sequence = 4
        self.db.add_all([
            Message(
                conversation_id=self.conversation.id,
                user_id=self.user.id,
                platform_code="pinduoduo",
                sender_role="agent",
                content="agent boundary",
                conversation_sequence=2,
                collection_kind="incremental",
                first_observation_id="snapshot-context",
                first_dom_sequence=2,
            ),
            Message(
                conversation_id=self.conversation.id,
                user_id=self.user.id,
                platform_code="pinduoduo",
                sender_role="customer",
                content="first customer in tail",
                conversation_sequence=3,
                collection_kind="incremental",
                first_observation_id="snapshot-context",
                first_dom_sequence=3,
            ),
        ])
        self.db.commit()

        self.assertEqual(_snapshot_customer_batch_size(self.db, self.source_message), 2)

if __name__ == "__main__":
    unittest.main()
