from __future__ import annotations

import unittest
from datetime import date, datetime, timezone

from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.models import AutomationReplyRun, Base, Conversation, Message, Robot, RpaTask, User
from app.services.analytics_service import get_dashboard_analytics


class AnalyticsServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.user = User(username="analytics", display_name="Analytics", password_hash="unused")
        self.other_user = User(username="other", display_name="Other", password_hash="unused")
        self.db.add_all([self.user, self.other_user])
        self.db.flush()
        self.conversation = Conversation(
            user_id=self.user.id,
            platform_code="pinduoduo",
            external_conversation_id="customer-1",
        )
        self.robot = Robot(user_id=self.user.id, name="Robot", enabled=True, status="online")
        self.db.add_all([self.conversation, self.robot])
        self.db.flush()

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

    def add_message(
        self,
        role: str,
        local_hour: int,
        *,
        source: str = "rpa",
        status: str = "sent",
        platform_hour: int | None = None,
    ) -> Message:
        observed = datetime(2026, 8, 3, local_hour - 8, 0, tzinfo=timezone.utc)
        platform_at = (
            datetime(2026, 8, 3, platform_hour - 8, 0, tzinfo=timezone.utc)
            if platform_hour is not None
            else None
        )
        message = Message(
            conversation_id=self.conversation.id,
            user_id=self.user.id,
            platform_code="pinduoduo",
            sender_role=role,
            content=f"{role}-{local_hour}",
            source=source,
            message_status=status,
            platform_sent_at=platform_at,
            observed_at=observed,
            sent_at=observed,
        )
        self.db.add(message)
        self.db.flush()
        return message

    def test_dashboard_counts_real_messages_and_groups_inbound_by_hour(self) -> None:
        self.add_message("customer", 9)
        self.add_message("agent", 10, source="desktop")
        self.add_message("customer", 11, source="demo")
        self.add_message("agent", 12, status="failed")
        # Platform time wins, so this history snapshot belongs to the previous day.
        historical = self.add_message("customer", 13)
        historical.platform_sent_at = datetime(2026, 8, 2, 4, 0, tzinfo=timezone.utc)
        self.db.commit()

        result = get_dashboard_analytics(
            self.db, self.user, date(2026, 8, 3), date(2026, 8, 3), "Asia/Shanghai"
        )

        self.assertEqual(result.metrics.message_count, 2)
        self.assertEqual(result.traffic[9].count, 1)
        self.assertEqual(sum(point.count for point in result.traffic), 1)
        self.assertEqual(result.metrics.independent_reception_rate, 0.0)

    def test_robot_only_conversation_and_response_time_are_calculated(self) -> None:
        source = self.add_message("customer", 9)
        reply = self.add_message("agent", 9, source="ai")
        task = RpaTask(
            user_id=self.user.id,
            conversation_id=self.conversation.id,
            message_id=reply.id,
            task_type="send_message",
            platform_code="pinduoduo",
            status="completed",
            completed_at=datetime(2026, 8, 3, 1, 0, 3, tzinfo=timezone.utc),
        )
        self.db.add(task)
        self.db.flush()
        self.db.add(
            AutomationReplyRun(
                user_id=self.user.id,
                conversation_id=self.conversation.id,
                source_message_id=source.id,
                robot_id=self.robot.id,
                status="succeeded",
                reply_message_id=reply.id,
                send_task_id=task.id,
                completed_at=task.completed_at,
                qa_entry_id="qa-1",
                qa_category_id="category-1",
                qa_category_name="物流问题",
                qa_match_type="exact",
            )
        )
        self.db.commit()

        result = get_dashboard_analytics(
            self.db, self.user, date(2026, 8, 3), date(2026, 8, 3), "Asia/Shanghai"
        )

        self.assertEqual(result.metrics.independent_reception_rate, 100.0)
        self.assertEqual(result.metrics.average_response_seconds, 3.0)
        self.assertEqual(result.categories[0].name, "物流问题")
        self.assertEqual(result.categories[0].percentage, 100.0)

    def test_document_retrieval_category_and_date_validation(self) -> None:
        source = self.add_message("customer", 9)
        self.db.add(
            AutomationReplyRun(
                user_id=self.user.id,
                conversation_id=self.conversation.id,
                source_message_id=source.id,
                robot_id=self.robot.id,
                status="succeeded",
                completed_at=datetime(2026, 8, 3, 1, 0, tzinfo=timezone.utc),
                document_retrieval_used=True,
                retrieval_count=2,
            )
        )
        self.db.commit()
        result = get_dashboard_analytics(
            self.db, self.user, date(2026, 8, 3), date(2026, 8, 3), "Asia/Shanghai"
        )
        self.assertEqual(result.categories[0].type, "document_retrieval")
        self.assertEqual(result.categories[0].name, "文档检索")

        with self.assertRaises(HTTPException):
            get_dashboard_analytics(
                self.db, self.user, date(2026, 8, 3), date(2026, 8, 2), "Asia/Shanghai"
            )
        with self.assertRaises(HTTPException):
            get_dashboard_analytics(
                self.db, self.user, date(2026, 1, 1), date(2026, 4, 2), "Asia/Shanghai"
            )


if __name__ == "__main__":
    unittest.main()
