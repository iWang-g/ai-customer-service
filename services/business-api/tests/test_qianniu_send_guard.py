import unittest

from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.api.routes.rpa import qianniu_task_send_guard
from app.models import Base, Conversation, PlatformAccount, RpaNode, RpaTask, User
from app.services.qianniu_send_guard import check_qianniu_send_guard


class QianniuSendGuardTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.user = User(username="send-guard", password_hash="unused", display_name="tester")
        self.db.add(self.user)
        self.db.flush()
        self.account = PlatformAccount(
            user_id=self.user.id,
            platform_code="qianniu",
            platform_name="Qianniu",
            local_account_id="qianniu-123",
            account_name="测试店铺",
        )
        self.node = RpaNode(user_id=self.user.id, node_key="send-guard-node", hostname="test")
        self.db.add_all([self.account, self.node])
        self.db.flush()
        self.conversation = Conversation(
            user_id=self.user.id,
            platform_account_id=self.account.id,
            platform_code="qianniu",
            external_conversation_id="1.1-2.1#11001@cntaobao",
            customer_name="测试买家",
        )
        self.db.add(self.conversation)
        self.db.flush()
        self.task = RpaTask(
            user_id=self.user.id,
            node_id=self.node.id,
            platform_account_id=self.account.id,
            conversation_id=self.conversation.id,
            platform_code="qianniu",
            task_type="send_message",
            status="acknowledged",
            payload_json={"source": "automation", "content": "正常回复"},
        )
        self.db.add(self.task)
        self.db.commit()

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

    def test_node_assigned_task_can_check_send_guard(self) -> None:
        result = qianniu_task_send_guard(
            self.task.id,
            self.account.id,
            self.conversation.external_conversation_id,
            self.node,
            self.db,
        )

        self.assertEqual(result, {"blocked": False})

    def test_other_node_cannot_check_task(self) -> None:
        other = RpaNode(user_id=self.user.id, node_key="other-node", hostname="other")
        self.db.add(other)
        self.db.commit()

        with self.assertRaises(HTTPException) as raised:
            qianniu_task_send_guard(
                self.task.id,
                self.account.id,
                self.conversation.external_conversation_id,
                other,
                self.db,
            )

        self.assertEqual(raised.exception.status_code, 403)

    def test_completed_task_is_blocked(self) -> None:
        self.task.status = "completed"
        self.db.commit()

        result = check_qianniu_send_guard(
            self.db,
            self.user,
            self.account.id,
            self.conversation.external_conversation_id,
            self.task.id,
        )

        self.assertEqual(result, {"blocked": True})


if __name__ == "__main__":
    unittest.main()
