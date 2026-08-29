from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.models import (
    Base,
    Conversation,
    CustomerOrder,
    CustomerOutreachRun,
    PlatformAccount,
    Robot,
    RobotPlatformScope,
    RpaTask,
    User,
)
from app.schemas.rpa import TaskCompleteRequest
from app.services.order_service import (
    apply_orders_snapshot,
    maybe_create_order_follow_up,
    schedule_due_outreach_rechecks,
)
from app.services.rpa_service import complete_task


class OrderServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.user = User(username="order-test", display_name="Order Test", password_hash="unused")
        self.db.add(self.user)
        self.db.flush()
        self.account = PlatformAccount(
            user_id=self.user.id,
            platform_code="pinduoduo",
            platform_name="拼多多",
            local_account_id="local-1",
            account_name="测试店铺",
        )
        self.db.add(self.account)
        self.db.flush()
        self.conversation = Conversation(
            user_id=self.user.id,
            platform_account_id=self.account.id,
            platform_code="pinduoduo",
            external_conversation_id="customer-1",
            customer_name="客户一",
        )
        self.robot = Robot(
            user_id=self.user.id,
            name="订单机器人",
            enabled=True,
            status="online",
            config_json={
                "order_follow_up_enabled": True,
                "order_follow_up_text": "还需要帮助下单吗？",
                "order_follow_up_mark_human_required": True,
                "post_receipt_care_enabled": True,
                "post_receipt_care_text": "欢迎反馈真实体验",
                "post_receipt_care_mark_human_required": True,
            },
        )
        self.db.add_all([self.conversation, self.robot])
        self.db.flush()
        self.db.add(RobotPlatformScope(
            robot_id=self.robot.id,
            platform_code="pinduoduo",
            platform_account_id=self.account.id,
            all_accounts=False,
        ))
        self.db.commit()

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

    def test_empty_snapshot_is_distinct_from_unavailable(self) -> None:
        apply_orders_snapshot(
            self.db,
            self.conversation,
            {"collection_status": "empty", "orders": [], "customer_key": "customer:key"},
            datetime.now(timezone.utc),
        )
        self.db.commit()
        self.assertEqual(
            self.conversation.metadata_json["customer_orders"]["collection_status"],
            "empty",
        )
        self.assertEqual(self.db.query(CustomerOrder).count(), 0)

    def test_unavailable_snapshot_exposes_collection_error(self) -> None:
        apply_orders_snapshot(
            self.db,
            self.conversation,
            {
                "collection_status": "unavailable",
                "error": "latest_orders_tab_not_found",
                "orders": [],
            },
            datetime.now(timezone.utc),
        )
        self.db.commit()

        summary = self.conversation.metadata_json["customer_orders"]
        self.assertEqual(summary["collection_status"], "unavailable")
        self.assertEqual(summary["collection_error"], "latest_orders_tab_not_found")

    def test_signed_order_creates_one_post_receipt_run(self) -> None:
        payload = {
            "collection_status": "success",
            "customer_key": "customer:key",
            "orders": [{
                "platform_order_id": "order-1",
                "status": "signed",
                "raw_status": "已签收",
                "products": [{"title": "键盘", "quantity": 1}],
            }],
        }
        apply_orders_snapshot(self.db, self.conversation, payload, datetime.now(timezone.utc))
        self.db.commit()
        apply_orders_snapshot(self.db, self.conversation, payload, datetime.now(timezone.utc))
        self.db.commit()
        runs = self.db.scalars(select(CustomerOutreachRun)).all()
        self.assertEqual(len(runs), 1)
        self.assertEqual(runs[0].strategy_type, "post_receipt_care")
        self.assertTrue(runs[0].decision_json["mark_human_required_after_send"])

    def test_signed_order_uses_robot_scoped_to_all_platforms(self) -> None:
        scope = self.db.scalar(select(RobotPlatformScope))
        scope.platform_code = "all"
        scope.platform_account_id = None
        scope.all_accounts = False
        self.db.commit()

        apply_orders_snapshot(
            self.db,
            self.conversation,
            {
                "collection_status": "success",
                "customer_key": "customer:key",
                "orders": [{"platform_order_id": "order-all", "status": "signed", "raw_status": "已签收"}],
            },
            datetime.now(timezone.utc),
        )
        self.db.commit()

        run = self.db.scalar(select(CustomerOutreachRun))
        self.assertIsNotNone(run)
        self.assertEqual(run.strategy_type, "post_receipt_care")

    def test_post_receipt_is_distinct_per_goods_id(self) -> None:
        apply_orders_snapshot(
            self.db,
            self.conversation,
            {
                "collection_status": "success",
                "customer_key": "customer:key",
                "orders": [
                    {
                        "platform_order_id": "order-goods-1",
                        "status": "signed",
                        "raw_status": "已签收",
                        "products": [{"goods_id": "goods-1", "product_id": "goods-1"}],
                    },
                    {
                        "platform_order_id": "order-goods-2",
                        "status": "signed",
                        "raw_status": "已签收",
                        "products": [{"goods_id": "goods-2", "product_id": "goods-2"}],
                    },
                ],
            },
            datetime.now(timezone.utc),
        )
        self.db.commit()

        runs = self.db.scalars(select(CustomerOutreachRun)).all()
        self.assertEqual(len(runs), 2)
        self.assertEqual({run.goods_id for run in runs}, {"goods-1", "goods-2"})

    def test_follow_up_requires_only_explicitly_empty_orders(self) -> None:
        apply_orders_snapshot(
            self.db,
            self.conversation,
            {"collection_status": "empty", "orders": [], "customer_key": "customer:key"},
            datetime.now(timezone.utc),
        )
        source_message = type("Source", (), {"id": "message-1"})()
        run = maybe_create_order_follow_up(
            self.db,
            self.conversation,
            self.robot,
            source_message,
            {"intent": {}},
        )
        self.db.commit()
        self.assertIsNotNone(run)
        duplicate = maybe_create_order_follow_up(
            self.db,
            self.conversation,
            self.robot,
            source_message,
            {"intent": {}},
        )
        self.assertIsNone(duplicate)

    def test_follow_up_is_due_immediately(self) -> None:
        apply_orders_snapshot(
            self.db,
            self.conversation,
            {"collection_status": "empty", "orders": [], "customer_key": "customer:key"},
            datetime.now(timezone.utc),
        )
        before = datetime.now(timezone.utc)
        run = maybe_create_order_follow_up(
            self.db,
            self.conversation,
            self.robot,
            type("Source", (), {"id": "message-immediate"})(),
            {"intent": {}},
        )
        due_at = run.due_at.replace(tzinfo=timezone.utc) if run.due_at.tzinfo is None else run.due_at
        self.assertLessEqual(due_at, datetime.now(timezone.utc))
        self.assertGreaterEqual(due_at, before)

    def test_follow_up_waits_for_formal_reply_task_completion(self) -> None:
        run = self._rechecking_run()
        run.status = "scheduled"
        run.source_message_id = "message-pending"
        self.db.add(RpaTask(
            user_id=self.user.id,
            conversation_id=self.conversation.id,
            task_type="send_message",
            idempotency_key=f"auto-reply:{self.robot.id}:message-pending:text",
            platform_code="pinduoduo",
            status="queued",
        ))
        self.db.commit()

        self.assertEqual(schedule_due_outreach_rechecks(self.db), 0)
        self.assertEqual(run.status, "scheduled")
        self.assertEqual(run.cancel_reason, "formal_reply_pending")

    def test_failed_follow_up_can_be_reactivated_but_completed_cannot(self) -> None:
        apply_orders_snapshot(
            self.db,
            self.conversation,
            {"collection_status": "empty", "orders": [], "customer_key": "customer:key"},
            datetime.now(timezone.utc),
        )
        source = type("Source", (), {"id": "message-retry"})()
        first = maybe_create_order_follow_up(
            self.db, self.conversation, self.robot, source, {"intent": {}}
        )
        self.db.commit()
        first.status = "failed"
        self.db.commit()

        retried = maybe_create_order_follow_up(
            self.db, self.conversation, self.robot, source, {"intent": {}}
        )
        self.assertEqual(retried.id, first.id)
        self.assertEqual(retried.status, "scheduled")
        retried.status = "completed"
        self.db.commit()

        self.assertIsNone(maybe_create_order_follow_up(
            self.db, self.conversation, self.robot, source, {"intent": {}}
        ))

    def test_post_receipt_is_due_immediately(self) -> None:
        before = datetime.now(timezone.utc)
        apply_orders_snapshot(
            self.db,
            self.conversation,
            {
                "collection_status": "success",
                "customer_key": "customer:key",
                "orders": [{"platform_order_id": "order-immediate", "status": "signed", "raw_status": "已签收"}],
            },
            before,
        )
        run = self.db.scalar(select(CustomerOutreachRun))
        due_at = run.due_at.replace(tzinfo=timezone.utc) if run.due_at.tzinfo is None else run.due_at
        self.assertLessEqual(due_at, datetime.now(timezone.utc))
        self.assertGreaterEqual(due_at, before)

    def test_failed_post_receipt_can_be_reactivated_on_next_signed_snapshot(self) -> None:
        payload = {
            "collection_status": "success",
            "customer_key": "customer:key",
            "orders": [{"platform_order_id": "order-retry", "status": "signed", "raw_status": "已签收"}],
        }
        apply_orders_snapshot(self.db, self.conversation, payload, datetime.now(timezone.utc))
        self.db.commit()
        run = self.db.scalar(select(CustomerOutreachRun))
        run.status = "failed"
        self.db.commit()

        apply_orders_snapshot(
            self.db,
            self.conversation,
            payload,
            datetime.now(timezone.utc) + timedelta(seconds=1),
        )
        self.assertEqual(run.status, "scheduled")

    def test_legacy_delayed_run_is_made_due_immediately(self) -> None:
        run = CustomerOutreachRun(
            user_id=self.user.id,
            robot_id=self.robot.id,
            platform_account_id=self.account.id,
            conversation_id=self.conversation.id,
            customer_key="customer:key",
            strategy_type="order_follow_up",
            status="scheduled",
            due_at=datetime.now(timezone.utc) + timedelta(days=2),
            decision_json={},
            message_text="立即复查",
            idempotency_key="customer-outreach:legacy-delay",
        )
        self.db.add(run)
        self.db.commit()

        self.assertEqual(schedule_due_outreach_rechecks(self.db), 1)
        self.assertEqual(run.status, "rechecking")

    def test_due_outreach_creates_low_priority_order_refresh_task(self) -> None:
        run = CustomerOutreachRun(
            user_id=self.user.id,
            robot_id=self.robot.id,
            platform_account_id=self.account.id,
            conversation_id=self.conversation.id,
            customer_key="customer:key",
            strategy_type="order_follow_up",
            status="scheduled",
            due_at=datetime.now(timezone.utc) - timedelta(minutes=1),
            decision_json={},
            message_text="还需要帮助下单吗？",
            idempotency_key="customer-outreach:test",
        )
        self.db.add(run)
        self.db.commit()
        self.assertEqual(schedule_due_outreach_rechecks(self.db), 1)
        task = self.db.scalar(select(RpaTask))
        self.assertEqual(task.task_type, "refresh_customer_orders")
        self.assertEqual(run.status, "rechecking")

    def _rechecking_run(
        self,
        *,
        strategy_type: str = "order_follow_up",
        order_id: str | None = None,
    ) -> CustomerOutreachRun:
        run = CustomerOutreachRun(
            user_id=self.user.id,
            robot_id=self.robot.id,
            platform_account_id=self.account.id,
            conversation_id=self.conversation.id,
            customer_key="customer:key",
            strategy_type=strategy_type,
            order_id=order_id,
            status="rechecking",
            due_at=datetime.now(timezone.utc),
            decision_json={},
            message_text="主动话术",
            idempotency_key=f"customer-outreach:{strategy_type}:{order_id or 'none'}",
        )
        self.db.add(run)
        self.db.commit()
        return run

    def test_unavailable_snapshot_postpones_rechecking_outreach(self) -> None:
        run = self._rechecking_run()

        apply_orders_snapshot(
            self.db,
            self.conversation,
            {"collection_status": "unavailable", "orders": []},
            datetime.now(timezone.utc),
        )
        self.db.commit()

        self.assertEqual(run.status, "scheduled")
        self.assertEqual(run.cancel_reason, "order_status_unknown")
        self.assertEqual(self.db.query(RpaTask).count(), 0)

    def test_new_order_cancels_follow_up_recheck(self) -> None:
        run = self._rechecking_run()

        apply_orders_snapshot(
            self.db,
            self.conversation,
            {
                "collection_status": "success",
                "orders": [{"platform_order_id": "order-new", "status": "pending_payment"}],
            },
            datetime.now(timezone.utc),
        )
        self.db.commit()

        self.assertEqual(run.status, "cancelled")
        self.assertEqual(run.cancel_reason, "order_created")

    def test_return_shipping_benefit_does_not_cancel_post_receipt_care(self) -> None:
        observed = datetime.now(timezone.utc)
        apply_orders_snapshot(
            self.db,
            self.conversation,
            {
                "collection_status": "success",
                "customer_key": "customer:key",
                "orders": [{
                    "platform_order_id": "order-signed",
                    "status": "signed",
                    "raw_status": "已签收",
                    "after_sale": {"text": "退货包运费 未赠送"},
                }],
            },
            observed,
        )
        self.db.commit()
        run = self.db.scalar(select(CustomerOutreachRun))
        self.assertIsNotNone(run)
        run.status = "rechecking"
        self.db.commit()

        apply_orders_snapshot(
            self.db,
            self.conversation,
            {
                "collection_status": "success",
                "customer_key": "customer:key",
                "orders": [{
                    "platform_order_id": "order-signed",
                    "status": "signed",
                    "raw_status": "已签收",
                    "after_sale": {"text": "退货包运费 未赠送"},
                }],
            },
            observed + timedelta(minutes=1),
        )

        self.assertEqual(run.status, "queued")
        self.assertIsNotNone(run.send_task_id)

    def test_refund_cancels_post_receipt_care(self) -> None:
        observed = datetime.now(timezone.utc)
        apply_orders_snapshot(
            self.db,
            self.conversation,
            {
                "collection_status": "success",
                "customer_key": "customer:key",
                "orders": [{"platform_order_id": "order-refund", "status": "signed", "raw_status": "已签收"}],
            },
            observed,
        )
        self.db.commit()
        run = self.db.scalar(select(CustomerOutreachRun))
        self.assertIsNotNone(run)
        run.status = "rechecking"
        self.db.commit()

        apply_orders_snapshot(
            self.db,
            self.conversation,
            {
                "collection_status": "success",
                "customer_key": "customer:key",
                "orders": [{"platform_order_id": "order-refund", "status": "refunding", "raw_status": "退款中"}],
            },
            observed + timedelta(minutes=1),
        )
        self.db.commit()

        self.assertEqual(run.status, "cancelled")
        self.assertEqual(run.cancel_reason, "order_status_unknown")

    def test_missing_target_order_cannot_authorize_post_receipt_send(self) -> None:
        order = CustomerOrder(
            user_id=self.user.id,
            platform_account_id=self.account.id,
            conversation_id=self.conversation.id,
            customer_key="customer:key",
            platform_order_id="order-old",
            status="signed",
            signed_at=datetime.now(timezone.utc),
            first_observed_at=datetime.now(timezone.utc),
            last_observed_at=datetime.now(timezone.utc),
        )
        self.db.add(order)
        self.db.commit()
        run = self._rechecking_run(strategy_type="post_receipt_care", order_id=order.id)

        apply_orders_snapshot(
            self.db,
            self.conversation,
            {
                "collection_status": "success",
                "orders": [{"platform_order_id": "different-order", "status": "completed"}],
            },
            datetime.now(timezone.utc),
        )
        self.db.commit()

        self.assertEqual(run.status, "cancelled")
        self.assertEqual(run.cancel_reason, "order_not_observed")
        self.assertIsNone(run.send_task_id)

    def test_outreach_send_completion_updates_run(self) -> None:
        run = self._rechecking_run()
        run.decision_json = {"mark_human_required_after_send": True}
        apply_orders_snapshot(
            self.db,
            self.conversation,
            {"collection_status": "empty", "orders": []},
            datetime.now(timezone.utc),
        )
        self.assertEqual(run.status, "queued")
        task = self.db.get(RpaTask, run.send_task_id)

        complete_task(
            self.db,
            task,
            TaskCompleteRequest(status="completed", result_json={"text_sent": True}),
        )

        self.db.refresh(run)
        self.db.refresh(self.conversation)
        self.assertEqual(run.status, "completed")
        self.assertIsNotNone(run.completed_at)
        self.assertTrue(self.conversation.human_required)
        self.assertEqual(self.conversation.human_required_reason, "order_follow_up_outreach")

    def test_outreach_does_not_mark_human_when_send_fails(self) -> None:
        run = self._rechecking_run()
        run.decision_json = {"mark_human_required_after_send": True}
        apply_orders_snapshot(
            self.db,
            self.conversation,
            {"collection_status": "empty", "orders": []},
            datetime.now(timezone.utc),
        )
        task = self.db.get(RpaTask, run.send_task_id)

        complete_task(
            self.db,
            task,
            TaskCompleteRequest(status="failed", result_json={"text_sent": False}),
        )

        self.db.refresh(self.conversation)
        self.assertFalse(self.conversation.human_required)

    def test_outreach_does_not_mark_human_when_setting_is_disabled(self) -> None:
        run = self._rechecking_run()
        run.decision_json = {"mark_human_required_after_send": False}
        apply_orders_snapshot(
            self.db,
            self.conversation,
            {"collection_status": "empty", "orders": []},
            datetime.now(timezone.utc),
        )
        task = self.db.get(RpaTask, run.send_task_id)

        complete_task(
            self.db,
            task,
            TaskCompleteRequest(status="completed", result_json={"text_sent": True}),
        )

        self.db.refresh(self.conversation)
        self.assertFalse(self.conversation.human_required)

    def test_outreach_human_mark_setting_is_snapshotted_when_run_is_created(self) -> None:
        apply_orders_snapshot(
            self.db,
            self.conversation,
            {"collection_status": "empty", "orders": [], "customer_key": "customer:key"},
            datetime.now(timezone.utc),
        )
        source_message = type("Source", (), {"id": "message-snapshot"})()

        run = maybe_create_order_follow_up(
            self.db,
            self.conversation,
            self.robot,
            source_message,
            {"intent": {}},
        )

        self.assertIsNotNone(run)
        self.assertTrue(run.decision_json["mark_human_required_after_send"])

    def test_stale_rechecking_run_is_recovered(self) -> None:
        run = self._rechecking_run()
        run.updated_at = datetime.now(timezone.utc) - timedelta(minutes=20)
        self.db.commit()

        self.assertEqual(schedule_due_outreach_rechecks(self.db), 1)

        self.db.refresh(run)
        task = self.db.scalar(select(RpaTask))
        self.assertEqual(run.status, "rechecking")
        self.assertEqual(task.task_type, "refresh_customer_orders")


if __name__ == "__main__":
    unittest.main()
