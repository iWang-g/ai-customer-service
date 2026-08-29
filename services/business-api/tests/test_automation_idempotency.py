from __future__ import annotations

import asyncio
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
    PlatformAccount,
    Robot,
    RobotPlatformScope,
    RpaTask,
    StoreProduct,
    User,
)
from app.schemas.automation import ReplyRunRequest
from app.schemas.message import SendMessageRequest
from app.services.automation_service import (
    _pending_inbound_reply_tasks,
    _can_refresh_order_context,
    _queue_reply_task,
    _refresh_order_context_before_reply,
    _snapshot_customer_batch_size,
    run_reply,
    schedule_debounced_inbound_reply,
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

    async def test_completed_auto_reply_broadcasts_queued_message_for_optimistic_ui(self) -> None:
        response = create_send_task(
            self.db,
            self.user,
            SendMessageRequest(
                conversation_id=self.conversation.id,
                content="Optimistic automatic reply",
            ),
            idempotency_key="auto-reply:optimistic",
            source="automation",
        )
        request = ReplyRunRequest(
            conversation_id=self.conversation.id,
            source_message_id=self.source_message.id,
        )
        result = {
            "decision": "auto_send",
            "text": "Optimistic automatic reply",
            "confidence": 1.0,
            "risk_flags": [],
            "provider": "test",
            "trace_id": "trace-optimistic",
            "intent": {},
            "qa_match": None,
            "retrieval": [],
            "model_call_details": [],
            "task_ids": [response.task_id],
        }
        with (
            patch(
                "app.services.automation_service._execute_bound_reply",
                new=AsyncMock(return_value=result),
            ),
            patch("app.services.realtime.realtime_manager.broadcast", new=AsyncMock()) as broadcast,
        ):
            await run_reply(self.db, self.user, request)

        payloads = [call.args[1] for call in broadcast.await_args_list]
        self.assertEqual(payloads[0]["type"], "automation.reply.started")
        self.assertEqual(payloads[0]["conversation_id"], self.conversation.id)
        payload = payloads[-1]
        self.assertEqual(payload["type"], "automation.reply.completed")
        self.assertEqual(payload["task_id"], response.task_id)
        self.assertEqual(payload["message"]["id"], response.message.id)
        self.assertEqual(payload["message"]["message_status"], "queued")

    async def test_human_required_flag_does_not_short_circuit_later_reply(self) -> None:
        self.conversation.human_required = True
        self.conversation.human_required_reason = "sensitive_word"
        self.db.add(self.conversation)
        self.db.commit()
        request = ReplyRunRequest(
            conversation_id=self.conversation.id,
            source_message_id=self.source_message.id,
        )
        result = {
            "decision": "auto_send",
            "text": "Yes, it is available.",
            "trace_id": "trace-human-required-open",
            "intent": {"intent": "qa_match"},
            "qa_match": None,
            "retrieval": [],
            "model_call_details": [],
            "task_ids": [],
        }
        with patch(
            "app.services.automation_service._execute_bound_reply",
            new=AsyncMock(return_value=result),
        ) as execute:
            self.assertEqual(await run_reply(self.db, self.user, request), result)

        execute.assert_awaited_once()
        reply_run = self.db.scalar(select(AutomationReplyRun))
        self.assertEqual(reply_run.trace_id, "trace-human-required-open")

    async def test_auto_reply_order_context_refresh_queues_pdd_order_task(self) -> None:
        account = PlatformAccount(
            user_id=self.user.id,
            platform_code="pinduoduo",
            platform_name="Pinduoduo",
            local_account_id="local-shop-1",
            external_account_id="688523141",
            account_name="Shop",
        )
        self.db.add(account)
        self.db.flush()
        self.conversation.platform_account_id = account.id
        self.conversation.external_conversation_id = "8715744365612"
        self.db.add(self.conversation)
        self.db.commit()

        with patch("app.services.automation_service.ORDER_CONTEXT_REFRESH_POLL_SECONDS", 0.001):
            result = await _refresh_order_context_before_reply(
                self.db,
                self.user,
                self.conversation,
                self.source_message,
                enabled=True,
                timeout_seconds=0.002,
            )

        self.assertTrue(result["attempted"])
        self.assertEqual(result["status"], "timeout")
        task = self.db.scalar(
            select(RpaTask).where(RpaTask.task_type == "refresh_customer_orders")
        )
        self.assertIsNotNone(task)
        self.assertEqual(task.platform_account_id, account.id)
        self.assertEqual(task.conversation_id, self.conversation.id)
        self.assertEqual(task.priority, 30)
        self.assertEqual(task.payload_json["external_conversation_id"], "8715744365612")
        self.assertEqual(task.payload_json["source"], "auto_reply_pre_context")
        self.assertEqual(task.payload_json["source_message_id"], self.source_message.id)

    async def test_auto_reply_order_context_refresh_skips_without_pdd_uid(self) -> None:
        self.assertFalse(_can_refresh_order_context(self.conversation))

        result = await _refresh_order_context_before_reply(
            self.db,
            self.user,
            self.conversation,
            self.source_message,
            enabled=True,
            timeout_seconds=0.001,
        )

        self.assertEqual(result, {"attempted": False, "reason": "conversation_not_refreshable"})
        task_count = self.db.scalar(
            select(func.count()).select_from(RpaTask).where(RpaTask.task_type == "refresh_customer_orders")
        )
        self.assertEqual(task_count, 0)

    async def test_image_only_customer_message_marks_human_required_without_reply_task(self) -> None:
        self.source_message.content = "[image]"
        self.source_message.raw_payload = {
            "message_type": "image",
            "media_type": "image",
            "image_url": "https://img.invalid/customer.png",
        }
        self.source_message.platform_message_id = "platform-image-1"
        self.db.add(self.source_message)
        self.db.commit()
        request = ReplyRunRequest(
            conversation_id=self.conversation.id,
            source_message_id=self.source_message.id,
            allow_auto_send=True,
        )

        result = await run_reply(self.db, self.user, request)

        self.assertEqual(result["decision"], "no_reply")
        self.db.refresh(self.conversation)
        self.assertTrue(self.conversation.human_required)
        self.assertEqual(self.conversation.human_required_reason, "image_message")
        task = self.db.scalar(select(RpaTask))
        self.assertIsNotNone(task)
        self.assertEqual(task.payload_json["quote_message_id"], self.source_message.platform_message_id)
        reply_run = self.db.scalar(select(AutomationReplyRun))
        self.assertTrue(reply_run.human_required_marked)
        self.assertEqual(reply_run.human_required_reason, "image_message")

    async def test_product_card_only_message_gets_ack_without_fallback_or_human_required(self) -> None:
        self.robot.config_json = {
            "allow_auto_send": True,
            "product_card_ack_text": "亲亲，这款商品想了解哪方面呢",
            "fallback_reply_text": "不应该发送的兜底话术",
        }
        self.source_message.content = ""
        self.source_message.platform_message_id = "platform-product-1"
        self.source_message.raw_payload = {
            "message_type": "product",
            "structured_payload": {
                "goods_id": "goods-1",
                "title": "水杯古风",
            },
        }
        self.db.add_all([self.robot, self.source_message])
        self.db.commit()

        result = await run_reply(
            self.db,
            self.user,
            ReplyRunRequest(
                conversation_id=self.conversation.id,
                source_message_id=self.source_message.id,
                allow_auto_send=True,
            ),
        )

        self.assertEqual(result["decision"], "auto_send")
        self.assertEqual(result["text"], "亲亲，这款商品想了解哪方面呢")
        self.assertEqual(result["provider"], "product-card-rule")
        self.assertEqual(result["action_plan"]["workflow"], "product_card_ack")
        self.assertEqual(len(result["task_ids"]), 1)
        self.db.refresh(self.conversation)
        self.assertFalse(self.conversation.human_required)
        task = self.db.scalar(select(RpaTask))
        self.assertIsNotNone(task)
        self.assertEqual(task.payload_json["content"], "亲亲，这款商品想了解哪方面呢")
        self.assertFalse(task.payload_json.get("follow_up_products"))

    async def test_product_title_match_does_not_send_cards_without_ai_recommendation_intent(self) -> None:
        account = PlatformAccount(
            user_id=self.user.id,
            platform_code="pinduoduo",
            platform_name="Pinduoduo",
            local_account_id="local-product-gate-1",
            account_name="枕梦次元",
        )
        self.db.add(account)
        self.db.flush()
        self.conversation.platform_account_id = account.id
        self.source_message.content = "抱枕双面图案一样吗"
        self.robot.config_json = {
            "allow_auto_send": True,
            "product_recommend_enabled": True,
            "product_recommend_text": "可以看下我们这些款式哦亲亲~",
        }
        self.db.add(StoreProduct(
            user_id=self.user.id,
            platform_account_id=account.id,
            goods_id="goods-double",
            platform_product_id="product-double",
            title="枕梦次元原创双面图案抱枕",
        ))
        self.db.add_all([self.conversation, self.source_message, self.robot])
        self.db.commit()
        result = {
            "decision": "auto_send",
            "text": "亲亲，这款抱枕双面图案信息这边帮您核实一下。",
            "media": [],
            "trace_id": "trace-product-gate-false",
            "provider": "test",
            "confidence": 0.9,
            "risk_flags": [],
            "intent": {
                "intent": "normal_question",
                "wants_product_recommendation": False,
                "product_recommendation_query": "",
            },
            "action_plan": {"workflow": "answer_question", "next_action": "send_platform_text"},
            "qa_match": None,
            "retrieval": [],
            "model_call_details": [],
        }

        with patch("app.services.automation_service._decide_reply", new=AsyncMock(return_value=result)):
            actual = await run_reply(
                self.db,
                self.user,
                ReplyRunRequest(
                    conversation_id=self.conversation.id,
                    source_message_id=self.source_message.id,
                    allow_auto_send=True,
                ),
            )

        self.assertEqual(actual["product_recommendation"]["enabled"], False)
        task = self.db.scalar(select(RpaTask).where(RpaTask.task_type == "send_message"))
        self.assertIsNotNone(task)
        self.assertFalse(task.payload_json.get("follow_up_products"))

    async def test_ai_recommendation_intent_sends_matched_store_products(self) -> None:
        account = PlatformAccount(
            user_id=self.user.id,
            platform_code="pinduoduo",
            platform_name="Pinduoduo",
            local_account_id="local-product-gate-2",
            account_name="枕梦次元",
        )
        self.db.add(account)
        self.db.flush()
        self.conversation.platform_account_id = account.id
        self.source_message.content = "有没有崩铁流萤抱枕"
        self.robot.config_json = {
            "allow_auto_send": True,
            "product_recommend_enabled": True,
            "product_recommend_text": "可以看下我们这些款式哦亲亲~",
        }
        for index, title in enumerate([
            "枕梦次元原创崩铁Q版流萤方形抱枕",
            "枕梦次元原创崩铁流萤双面抱枕",
            "枕梦次元原创明日方舟角色抱枕",
        ], start=1):
            self.db.add(StoreProduct(
                user_id=self.user.id,
                platform_account_id=account.id,
                goods_id=f"goods-{index}",
                platform_product_id=f"product-{index}",
                title=title,
            ))
        self.db.add_all([self.conversation, self.source_message, self.robot])
        self.db.commit()
        result = {
            "decision": "auto_send",
            "text": "有的亲亲。",
            "media": [],
            "trace_id": "trace-product-gate-true",
            "provider": "test",
            "confidence": 0.9,
            "risk_flags": [],
            "intent": {
                "intent": "normal_question",
                "wants_product_recommendation": True,
                "product_recommendation_query": "崩铁流萤抱枕",
            },
            "action_plan": {"workflow": "answer_question", "next_action": "send_platform_text"},
            "qa_match": None,
            "retrieval": [],
            "model_call_details": [],
        }

        with patch("app.services.automation_service._decide_reply", new=AsyncMock(return_value=result)):
            actual = await run_reply(
                self.db,
                self.user,
                ReplyRunRequest(
                    conversation_id=self.conversation.id,
                    source_message_id=self.source_message.id,
                    allow_auto_send=True,
                ),
            )

        self.assertEqual(actual["text"], "可以看下我们这些款式哦亲亲~")
        self.assertEqual(actual["action_plan"]["workflow"], "product_recommendation")
        self.assertEqual(actual["product_recommendation"]["enabled"], True)
        self.assertEqual(len(actual["product_recommendation"]["products"]), 2)
        task = self.db.scalar(select(RpaTask).where(RpaTask.task_type == "send_message"))
        self.assertIsNotNone(task)
        self.assertEqual(len(task.payload_json.get("follow_up_products") or []), 2)

    async def test_order_message_human_required_notice_does_not_quote(self) -> None:
        self.robot.config_json = {
            "allow_auto_send": True,
            "inbound_sensitive_words": ["refund"],
            "sensitive_word_reply_text": "Please wait for manual support.",
        }
        self.source_message.content = "refund order 260805-038084298363116"
        self.source_message.platform_message_id = "platform-order-1"
        self.source_message.raw_payload = {
            "message_type": "order",
            "structured_payload": {"order_sequence_no": "260805-038084298363116"},
        }
        self.db.add_all([self.robot, self.source_message])
        self.db.commit()
        request = ReplyRunRequest(
            conversation_id=self.conversation.id,
            source_message_id=self.source_message.id,
            allow_auto_send=True,
        )

        result = await run_reply(self.db, self.user, request)

        self.assertEqual(result["decision"], "auto_send")
        task = self.db.scalar(select(RpaTask))
        self.assertIsNotNone(task)
        self.assertNotIn("quote_message_id", task.payload_json)

    async def test_mixed_image_and_text_marks_human_required_but_replies_to_text(self) -> None:
        self.conversation.last_message_sequence = 2
        self.source_message.conversation_sequence = 2
        self.source_message.collection_kind = "incremental"
        self.source_message.first_observation_id = "mixed-image-text"
        self.source_message.first_dom_sequence = 2
        image_message = Message(
            conversation_id=self.conversation.id,
            user_id=self.user.id,
            platform_code="pinduoduo",
            sender_role="customer",
            content="[image]",
            raw_payload={
                "message_type": "image",
                "media_type": "image",
                "image_url": "https://img.invalid/customer.png",
            },
            conversation_sequence=1,
            collection_kind="incremental",
            first_observation_id="mixed-image-text",
            first_dom_sequence=1,
        )
        self.db.add_all([self.conversation, self.source_message, image_message])
        self.db.commit()
        request = ReplyRunRequest(
            conversation_id=self.conversation.id,
            source_message_id=self.source_message.id,
            allow_auto_send=True,
        )
        result = {
            "decision": "auto_send",
            "text": "Yes, it is available.",
            "trace_id": "trace-mixed-image-text",
            "intent": {},
            "qa_match": None,
            "retrieval": [],
            "model_call_details": [],
            "task_ids": [],
        }
        with patch(
            "app.services.automation_service._decide_reply",
            new=AsyncMock(return_value=result),
        ) as decide:
            self.assertEqual(await run_reply(self.db, self.user, request), result)

        decide.assert_awaited_once()
        self.assertEqual(decide.await_args.kwargs["message"], "Is this available?")
        self.db.refresh(self.conversation)
        self.assertTrue(self.conversation.human_required)
        self.assertEqual(self.conversation.human_required_reason, "image_message")
        reply_run = self.db.scalar(select(AutomationReplyRun))
        self.assertTrue(reply_run.human_required_marked)
        self.assertEqual(reply_run.human_required_reason, "image_message")

    async def test_debounced_inbound_reply_runs_only_latest_source(self) -> None:
        _pending_inbound_reply_tasks.clear()
        with patch(
            "app.services.automation_service.process_inbound_reply",
            new=AsyncMock(return_value=None),
        ) as process:
            schedule_debounced_inbound_reply(
                self.user.id,
                self.conversation.id,
                "message-old",
                "event-old",
                delay_seconds=0.01,
            )
            schedule_debounced_inbound_reply(
                self.user.id,
                self.conversation.id,
                "message-new",
                "event-new",
                delay_seconds=0.01,
            )
            await asyncio.sleep(0.05)

        process.assert_awaited_once_with(
            self.user.id,
            self.conversation.id,
            "message-new",
            "event-new",
        )
        self.assertNotIn((self.user.id, self.conversation.id), _pending_inbound_reply_tasks)

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
