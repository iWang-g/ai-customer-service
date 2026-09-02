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
                "sensitive_word_reply_text": "亲，已收到，马上帮您转人工处理。",
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
        self.assertEqual(result["text"], "亲，已收到，马上帮您转人工处理。")
        self.assertEqual(result["intent"]["direct_reply_text"], "亲，已收到，马上帮您转人工处理。")
        self.assertEqual(result["qa_match"]["status"], "skipped")
        self.assertEqual(len(result["task_ids"]), 1)
        self.assertEqual(self.db.query(RpaTask).count(), 1)
        task = self.db.scalar(select(RpaTask))
        self.assertIsNotNone(task)
        self.assertEqual(task.payload_json["content"], "亲，已收到，马上帮您转人工处理。")
        run = self.db.scalar(select(AutomationReplyRun))
        self.assertIsNotNone(run)
        self.assertEqual(run.intent, "human_handoff")
        self.assertEqual(run.qa_match_type, "sensitive_word")

    async def test_marked_conversation_allows_later_normal_auto_reply(self) -> None:
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
        expected = {
            "decision": "auto_send",
            "text": "normal reply",
            "trace_id": "trace-later-normal",
            "intent": {"intent": "qa_match"},
            "qa_match": None,
            "retrieval": [],
            "model_call_details": [],
            "task_ids": [],
        }

        with patch(
            "app.services.automation_service._execute_bound_reply",
            new=AsyncMock(return_value=expected),
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

        execute_reply.assert_awaited_once()
        self.assertEqual(result, expected)
        self.assertEqual(self.db.query(RpaTask).count(), 0)
        run = self.db.scalar(select(AutomationReplyRun))
        self.assertIsNotNone(run)
        self.assertEqual(run.trace_id, "trace-later-normal")

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
        self.assertEqual(result["text"], "亲，已收到，马上帮您转人工处理。")
        self.assertEqual(result["provider"], "sensitive-word-rule")

    async def test_sensitive_word_reply_uses_default_when_config_is_blank(self) -> None:
        self.robot.config_json = {
            **self.robot.config_json,
            "sensitive_word_reply_text": "   ",
        }
        self.db.add(self.robot)
        self.db.commit()

        result = await run_test_reply(
            self.db,
            self.user,
            TestReplyRequest(robot_id=self.robot.id, message="我要给差评"),
        )

        self.assertEqual(result["text"], "亲亲，已收到您的消息，正在为您核实，请稍等~")

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

    async def test_transfer_strategy_asks_for_confirmation_on_fallback(self) -> None:
        self.conversation.platform_account_id = "pdd-account-1"
        self.robot.config_json = {
            "allow_auto_send": True,
            "fallback_mark_human_required": True,
            "human_handoff_strategy": "transfer_conversation",
        }
        self.source_message.content = "商品有什么规格"
        self.db.add_all([self.conversation, self.robot, self.source_message])
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
            "trace_id": "fallback-transfer-confirm-test",
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
        self.assertFalse(self.conversation.human_required)
        self.assertEqual(result["text"], "亲亲，为及时给您解答，是否需要转接给其他客服")
        task = self.db.scalar(select(RpaTask).where(RpaTask.task_type == "send_message"))
        self.assertIsNotNone(task)
        self.assertEqual(task.payload_json["content"], result["text"])
        self.assertEqual(self.conversation.metadata_json["auto_transfer"]["status"], "confirming")
        self.assertEqual(self.conversation.metadata_json["auto_transfer"]["reason"], "fallback_reply")

    async def test_transfer_confirmation_yes_queues_ack_with_after_send_transfer(self) -> None:
        self.conversation.platform_account_id = "pdd-account-1"
        self.conversation.metadata_json = {
            "auto_transfer": {
                "status": "confirming",
                "reason": "fallback_reply",
                "source_message_id": self.source_message.id,
                "robot_id": self.robot.id,
            }
        }
        self.robot.config_json = {
            "allow_auto_send": True,
            "human_handoff_strategy": "transfer_conversation",
        }
        yes_message = Message(
            conversation_id=self.conversation.id,
            user_id=self.user.id,
            platform_code="pinduoduo",
            sender_role="customer",
            content="是的，转吧",
        )
        self.db.add_all([self.conversation, self.robot, yes_message])
        self.db.commit()

        result = await run_reply(
            self.db,
            self.user,
            ReplyRunRequest(
                conversation_id=self.conversation.id,
                source_message_id=yes_message.id,
                allow_auto_send=True,
            ),
        )

        self.db.refresh(self.conversation)
        self.assertEqual(result["text"], "好的，稍等一下")
        self.assertEqual(self.conversation.metadata_json["auto_transfer"]["status"], "ack_queued")
        ack_task = self.db.scalars(select(RpaTask).order_by(RpaTask.requested_at.desc())).first()
        self.assertIsNotNone(ack_task)
        self.assertIn("after_send_transfer_conversation", ack_task.payload_json)
        transfer_payload = ack_task.payload_json["after_send_transfer_conversation"]
        self.assertEqual(transfer_payload["trans_reason"], "无原因直接转移")
        self.assertEqual(transfer_payload["external_conversation_id"], "customer-sensitive")

    async def test_transfer_confirmation_no_clears_state_and_sends_cancel_reply(self) -> None:
        self.conversation.platform_account_id = "pdd-account-1"
        self.conversation.metadata_json = {
            "auto_transfer": {
                "status": "confirming",
                "reason": "fallback_reply",
                "source_message_id": self.source_message.id,
                "robot_id": self.robot.id,
            }
        }
        self.robot.config_json = {
            "allow_auto_send": True,
            "fallback_mark_human_required": True,
            "human_handoff_strategy": "transfer_conversation",
        }
        no_message = Message(
            conversation_id=self.conversation.id,
            user_id=self.user.id,
            platform_code="pinduoduo",
            sender_role="customer",
            content="先不用",
        )
        self.db.add_all([self.conversation, self.robot, no_message])
        self.db.commit()

        with patch(
            "app.services.automation_service._decide_reply",
            new=AsyncMock(),
        ) as decide_reply:
            result = await run_reply(
                self.db,
                self.user,
                ReplyRunRequest(
                    conversation_id=self.conversation.id,
                    source_message_id=no_message.id,
                    allow_auto_send=True,
                ),
            )

        decide_reply.assert_not_awaited()
        self.db.refresh(self.conversation)
        self.assertNotIn("auto_transfer", self.conversation.metadata_json)
        self.assertEqual(result["text"], "好的亲亲，有需要随时告诉我")
        self.assertEqual(result["qa_match"]["match_type"], "transfer_cancel")
        task = self.db.scalars(select(RpaTask).order_by(RpaTask.requested_at.desc())).first()
        self.assertIsNotNone(task)
        self.assertEqual(task.payload_json["content"], "好的亲亲，有需要随时告诉我")
        self.assertNotIn("after_send_transfer_conversation", task.payload_json)


if __name__ == "__main__":
    unittest.main()
