from __future__ import annotations

import unittest

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.models import AiModelCall, AiModelCatalog, AutomationReplyRun, Base, Conversation, Message, Robot, User, utcnow
from app.services.monitoring_service import get_overview, list_logs, list_recent_events


class MonitoringServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.user = User(username="monitor-user", password_hash="hash", display_name="Monitor")
        self.db.add(self.user)
        self.db.flush()
        self.robot = Robot(user_id=self.user.id, name="测试机器人", enabled=True, status="online")
        self.db.add(self.robot)
        self.db.flush()
        self.db.add_all([
            AiModelCatalog(provider="deepseek", model_id="deepseek-v4-flash", display_name="deepseek-v4-flash"),
            AiModelCatalog(provider="deepseek", model_id="deepseek-v4-pro", display_name="deepseek-v4-pro"),
        ])
        self.conversation = Conversation(
            user_id=self.user.id,
            platform_code="pinduoduo",
            external_conversation_id="customer-1",
            customer_name="客户甲",
        )
        self.db.add(self.conversation)
        self.db.flush()
        self.message = Message(
            user_id=self.user.id,
            conversation_id=self.conversation.id,
            platform_code="pinduoduo",
            sender_role="customer",
            content="请问有货吗",
            message_status="sent",
            source="rpa",
            sent_at=utcnow(),
        )
        self.db.add(self.message)
        self.db.flush()
        self.run = AutomationReplyRun(
            user_id=self.user.id,
            conversation_id=self.conversation.id,
            source_message_id=self.message.id,
            robot_id=self.robot.id,
            status="succeeded",
            decision="auto_send",
            reply_generation_duration_ms=1250,
            completed_at=utcnow(),
        )
        self.db.add(self.run)
        self.db.flush()
        self.db.add_all([
            AiModelCall(
                user_id=self.user.id,
                automation_reply_run_id=self.run.id,
                robot_id=self.robot.id,
                conversation_id=self.conversation.id,
                stage="intent",
                provider="deepseek",
                model="deepseek-v4-flash",
                status="success",
                input_tokens=10,
                output_tokens=5,
                duration_ms=300,
            ),
            AiModelCall(
                user_id=self.user.id,
                automation_reply_run_id=self.run.id,
                robot_id=self.robot.id,
                conversation_id=self.conversation.id,
                stage="generation",
                provider="deepseek",
                model="deepseek-v4-flash",
                status="success",
                input_tokens=20,
                output_tokens=8,
                duration_ms=800,
            ),
        ])
        self.db.commit()

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

    def test_overview_uses_real_model_calls(self) -> None:
        value = get_overview(self.db, self.user, "deepseek-v4-flash")
        self.assertEqual(value.available_models, ["deepseek-v4-flash", "deepseek-v4-pro"])
        self.assertEqual(value.metrics.request_count, 2)
        self.assertEqual(value.metrics.success_rate, 100)
        self.assertEqual(value.metrics.average_response_ms, 1250)

    def test_logs_and_events_are_real_records(self) -> None:
        logs = list_logs(self.db, self.user)
        self.assertEqual(len(logs.items), 3)
        self.assertEqual(sum(item.type == "token" for item in logs.items), 2)
        events = list_recent_events(self.db, self.user)
        self.assertTrue(any("新消息" in item.message for item in events.items))
        self.assertTrue(any("自动回复内容已生成" in item.message for item in events.items))


if __name__ == "__main__":
    unittest.main()
