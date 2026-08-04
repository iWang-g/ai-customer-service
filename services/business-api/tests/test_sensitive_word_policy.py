from __future__ import annotations

import unittest
from unittest.mock import AsyncMock, patch

from sqlalchemy import create_engine, select
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
from app.schemas.automation import ReplyRunRequest, TestReplyRequest
from app.services.automation_service import run_reply, run_test_reply
from app.services.message_service import clear_human_required


class SensitiveWordPolicyTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.user = User(
            username="sensitive-policy",
            display_name="Sensitive Policy Test",
            password_hash="not-used",
        )
        self.db.add(self.user)
        self.db.flush()
        self.conversation = Conversation(
            user_id=self.user.id,
            platform_code="pinduoduo",
            external_conversation_id="customer-sensitive",
        )
        self.robot = Robot(
            user_id=self.user.id,
            name="Sensitive Guard Robot",
            status="online",
            enabled=True,
            config_json={
                "allow_auto_send": True,
                "inbound_sensitive_words": ["投诉", "差评"],
                "sensitive_word_action": "mark_human",
            },
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
            content="我要投诉物流服务",
        )
        self.db.add(self.source_message)
        self.db.commit()

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

    async def test_sensitive_word_blocks_ai_and_marks_conversation(self) -> None:
        with patch(
            "app.services.automation_service._decide_reply",
            new=AsyncMock(),
        ) as decide_reply:
            result = await run_reply(
                self.db,
                self.user,
                ReplyRunRequest(
                    conversation_id=self.conversation.id,
                    source_message_id=self.source_message.id,
                    allow_auto_send=True,
                ),
            )

        decide_reply.assert_not_awaited()
        self.db.refresh(self.conversation)
        self.assertTrue(self.conversation.human_required)
        self.assertEqual(self.conversation.human_required_reason, "sensitive_word")
        self.assertEqual(self.conversation.human_required_word, "投诉")
        self.assertEqual(result["decision"], "auto_send")
        self.assertTrue(result["text"])
        self.assertEqual(result["qa_match"]["status"], "skipped")
        self.assertEqual(len(result["task_ids"]), 1)
        self.assertEqual(self.db.query(RpaTask).count(), 1)
        run = self.db.scalar(select(AutomationReplyRun))
        self.assertIsNotNone(run)
        self.assertEqual(run.intent, "human_handoff")
        self.assertEqual(run.qa_match_type, "sensitive_word")

    async def test_marked_conversation_skips_later_messages_until_cleared(self) -> None:
        self.conversation.human_required = True
        self.conversation.human_required_reason = "sensitive_word"
        self.db.add(self.conversation)
        later_message = Message(
            conversation_id=self.conversation.id,
            user_id=self.user.id,
            platform_code="pinduoduo",
            sender_role="customer",
            content="现在可以继续处理吗",
        )
        self.db.add(later_message)
        self.db.commit()

        with patch(
            "app.services.automation_service._execute_bound_reply",
            new=AsyncMock(),
        ) as execute_reply:
            result = await run_reply(
                self.db,
                self.user,
                ReplyRunRequest(
                    conversation_id=self.conversation.id,
                    source_message_id=later_message.id,
                    allow_auto_send=True,
                ),
            )

        execute_reply.assert_not_awaited()
        self.assertEqual(result["provider"], "human-required-rule")
        self.assertTrue(result["text"])
        self.assertEqual(len(result["task_ids"]), 1)
        self.assertEqual(self.db.query(RpaTask).count(), 1)
        self.assertEqual(self.db.query(AutomationReplyRun).count(), 0)

        cleared = clear_human_required(self.db, self.user, self.conversation.id)
        self.assertFalse(cleared.human_required)
        self.assertIsNone(cleared.human_required_reason)
        self.assertIsNone(cleared.human_required_word)

    async def test_robot_reply_preview_uses_the_same_sensitive_word_guard(self) -> None:
        with patch(
            "app.services.automation_service._decide_reply",
            new=AsyncMock(),
        ) as decide_reply:
            result = await run_test_reply(
                self.db,
                self.user,
                TestReplyRequest(robot_id=self.robot.id, message="我要给差评"),
            )

        decide_reply.assert_not_awaited()
        self.assertEqual(result["decision"], "auto_send")
        self.assertTrue(result["text"])
        self.assertEqual(result["provider"], "sensitive-word-rule")

    async def test_fallback_reply_is_queued_before_conversation_is_marked_human_required(self) -> None:
        self.robot.config_json = {
            "allow_auto_send": True,
            "fallback_mark_human_required": True,
        }
        self.source_message.content = "商品有什么规格"
        self.db.add_all([self.robot, self.source_message])
        self.db.commit()
        fallback_result = {
            "decision": "auto_send",
            "text": "您的问题我将为您接入专业产品客服，请稍后",
            "media": [],
            "intent": {"intent": "normal_question"},
            "action_plan": {
                "workflow": "fallback_reply",
                "next_action": "send_platform_text",
            },
            "confidence": 0.9,
            "risk_flags": [],
            "qa_match": {"matched": False, "status": "miss", "match_type": "none"},
            "retrieval": [],
            "model_calls": {"intent": "deepseek", "generation": "skipped-no-retrieval"},
            "provider": "fallback-rule",
            "trace_id": "fallback-mark-test",
        }

        with patch(
            "app.services.automation_service._decide_reply",
            new=AsyncMock(return_value=fallback_result),
        ):
            result = await run_reply(
                self.db,
                self.user,
                ReplyRunRequest(
                    conversation_id=self.conversation.id,
                    source_message_id=self.source_message.id,
                    allow_auto_send=True,
                ),
            )

        self.db.refresh(self.conversation)
        self.assertEqual(len(result["task_ids"]), 1)
        self.assertEqual(self.db.query(RpaTask).count(), 1)
        self.assertTrue(self.conversation.human_required)
        self.assertEqual(self.conversation.human_required_reason, "fallback_reply")
        self.assertIsNone(self.conversation.human_required_word)

    async def test_legacy_fallback_transfer_setting_still_marks_human_required(self) -> None:
        self.robot.config_json = {
            "allow_auto_send": True,
            "fallback_transfer_to_human": True,
        }
        self.source_message.content = "商品有什么规格"
        self.db.add_all([self.robot, self.source_message])
        self.db.commit()
        fallback_result = {
            "decision": "auto_send",
            "text": "请稍后",
            "media": [],
            "intent": {"intent": "normal_question"},
            "action_plan": {"workflow": "fallback_reply", "next_action": "send_platform_text"},
            "confidence": 0.9,
            "risk_flags": [],
            "qa_match": {"matched": False, "status": "miss", "match_type": "none"},
            "retrieval": [],
            "model_calls": {},
            "provider": "fallback-rule",
            "trace_id": "legacy-fallback-mark-test",
        }

        with patch(
            "app.services.automation_service._decide_reply",
            new=AsyncMock(return_value=fallback_result),
        ):
            await run_reply(
                self.db,
                self.user,
                ReplyRunRequest(
                    conversation_id=self.conversation.id,
                    source_message_id=self.source_message.id,
                    allow_auto_send=True,
                ),
            )

        self.db.refresh(self.conversation)
        self.assertTrue(self.conversation.human_required)
        self.assertEqual(self.conversation.human_required_reason, "fallback_reply")

    async def test_disabled_fallback_mark_does_not_mark_conversation(self) -> None:
        self.robot.config_json = {
            "allow_auto_send": True,
            "fallback_mark_human_required": False,
            "fallback_transfer_to_human": True,
        }
        self.source_message.content = "商品有什么规格"
        self.db.add_all([self.robot, self.source_message])
        self.db.commit()
        fallback_result = {
            "decision": "auto_send",
            "text": "请稍后",
            "media": [],
            "intent": {"intent": "normal_question"},
            "action_plan": {"workflow": "fallback_reply", "next_action": "send_platform_text"},
            "confidence": 0.9,
            "risk_flags": [],
            "qa_match": {"matched": False, "status": "miss", "match_type": "none"},
            "retrieval": [],
            "model_calls": {},
            "provider": "fallback-rule",
            "trace_id": "fallback-mark-disabled-test",
        }

        with patch(
            "app.services.automation_service._decide_reply",
            new=AsyncMock(return_value=fallback_result),
        ):
            result = await run_reply(
                self.db,
                self.user,
                ReplyRunRequest(
                    conversation_id=self.conversation.id,
                    source_message_id=self.source_message.id,
                    allow_auto_send=True,
                ),
            )

        self.db.refresh(self.conversation)
        self.assertEqual(len(result["task_ids"]), 1)
        self.assertFalse(self.conversation.human_required)


if __name__ == "__main__":
    unittest.main()
