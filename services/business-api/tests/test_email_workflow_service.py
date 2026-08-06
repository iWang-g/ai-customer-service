from __future__ import annotations

import smtplib
import unittest
from unittest.mock import patch

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.models import (
    Base,
    Conversation,
    ConversationWorkflow,
    EmailProviderConfig,
    EmailSendTask,
    EmailTemplate,
    Message,
    PlatformAccount,
    Robot,
    User,
)
from app.services.email_service import decrypt_recipient, encrypt_secret, send_template_email
from app.services.email_workflow_service import (
    ASK_EMAIL_TEXT,
    FAILURE_TEXT,
    MISSING_TEMPLATE_TEXT,
    SUCCESS_TEXT,
    active_workflow,
    extract_email,
    sandbox_email_result,
    start_or_resume_email_workflow,
    template_metadata,
)


class EmailWorkflowServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.user = User(username="workflow-user", display_name="Workflow User", password_hash="not-used")
        self.robot = Robot(user_id="", name="测试机器人", enabled=True, status="online")
        self.conversation = Conversation(
            user_id="",
            platform_code="pdd",
            customer_name="测试客户",
            latest_message_text="",
        )
        self.db.add(self.user)
        self.db.flush()
        self.robot.user_id = self.user.id
        self.conversation.user_id = self.user.id
        self.db.add_all([self.robot, self.conversation])
        self.db.flush()
        self.template = EmailTemplate(
            user_id=self.user.id,
            template_key="install-doc",
            name="安装资料",
            scene="document",
            aliases=["安装说明"],
            subject="安装资料",
            body="资料正文",
            enabled=True,
        )
        self.config = EmailProviderConfig(
            user_id=self.user.id,
            enabled=True,
            provider="qq",
            sender_email="sender@example.com",
            smtp_host="smtp.qq.com",
            smtp_port=465,
            security="ssl",
            auth_secret_encrypted=encrypt_secret("secret"),
        )
        self.db.add_all([self.template, self.config])
        self.db.commit()
        self.db.refresh(self.user)
        self.db.refresh(self.robot)
        self.db.refresh(self.conversation)
        self.db.refresh(self.template)

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

    def customer_message(self, content: str) -> Message:
        row = Message(
            conversation_id=self.conversation.id,
            user_id=self.user.id,
            platform_code="pdd",
            sender_role="customer",
            content=content,
        )
        self.db.add(row)
        self.db.commit()
        self.db.refresh(row)
        return row

    def test_extract_email_normalizes_address(self) -> None:
        self.assertEqual(extract_email("请发到 Customer.Name+1@Example.COM，谢谢"), "customer.name+1@example.com")

    def test_template_metadata_excludes_body_and_secret(self) -> None:
        metadata = template_metadata([self.template])
        self.assertEqual(metadata[0]["id"], self.template.id)
        self.assertEqual(metadata[0]["template_key"], "install-doc")
        self.assertNotIn("body", metadata[0])
        self.assertNotIn("subject", metadata[0])
        self.assertNotIn("auth_secret_encrypted", metadata[0])

    def test_first_email_request_saves_waiting_workflow(self) -> None:
        source = self.customer_message("把安装资料发我邮箱")
        result = start_or_resume_email_workflow(
            self.db,
            self.user,
            self.conversation,
            self.robot,
            message=source.content,
            source_message=source,
            templates=[self.template],
        )
        workflow = active_workflow(self.db, self.user, self.conversation, self.robot)

        self.assertEqual(result["text"], ASK_EMAIL_TEXT)
        self.assertIsNotNone(workflow)
        self.assertEqual(workflow.status, "waiting_for_email")
        self.assertEqual(workflow.template_id, self.template.id)
        self.assertEqual(workflow.missing_slots_json, ["email"])

    def test_missing_bound_template_replies_and_marks_human_action(self) -> None:
        account = PlatformAccount(
            user_id=self.user.id,
            platform_code="pinduoduo",
            platform_name="拼多多",
            local_account_id="shop-1",
            account_name="测试店铺",
            account_alias="测试店铺",
            is_active=True,
        )
        self.db.add(account)
        self.db.commit()
        self.db.refresh(account)
        self.conversation.platform_account_id = account.id
        self.db.commit()
        source = self.customer_message("把店铺链接发我邮箱")

        result = start_or_resume_email_workflow(
            self.db,
            self.user,
            self.conversation,
            self.robot,
            message=source.content,
            source_message=source,
            templates=[self.template],
        )

        workflow = self.db.scalar(select(ConversationWorkflow).where(
            ConversationWorkflow.conversation_id == self.conversation.id,
        ))
        self.assertEqual(result["text"], MISSING_TEMPLATE_TEXT)
        self.assertEqual(result["action_plan"]["workflow"], "human_review")
        self.assertEqual(result["action_plan"]["next_action"], "mark_needs_human")
        self.assertIn("missing_bound_email_template", result["risk_flags"])
        self.assertEqual(workflow.status, "failed")

    def test_resume_with_email_sends_template_and_completes_workflow(self) -> None:
        first = self.customer_message("把安装资料发我邮箱")
        start_or_resume_email_workflow(
            self.db,
            self.user,
            self.conversation,
            self.robot,
            message=first.content,
            source_message=first,
            templates=[self.template],
        )
        workflow = active_workflow(self.db, self.user, self.conversation, self.robot)
        second = self.customer_message("customer@example.com")

        with patch("app.services.email_service._send_message") as send_mock:
            result = start_or_resume_email_workflow(
                self.db,
                self.user,
                self.conversation,
                self.robot,
                message=second.content,
                source_message=second,
                templates=[self.template],
                workflow=workflow,
            )

        task = self.db.scalar(select(EmailSendTask).where(EmailSendTask.workflow_id == workflow.id))
        self.db.refresh(workflow)
        self.assertEqual(result["text"], SUCCESS_TEXT)
        self.assertEqual(workflow.status, "completed")
        self.assertIsNotNone(task)
        self.assertEqual(task.status, "sent")
        self.assertEqual(task.recipient_email_masked, "cu***@example.com")
        self.assertEqual(decrypt_recipient(task.recipient_email_encrypted), "customer@example.com")
        send_mock.assert_called_once()

    def test_smtp_failure_does_not_report_success(self) -> None:
        first = self.customer_message("把安装资料发我邮箱")
        start_or_resume_email_workflow(
            self.db,
            self.user,
            self.conversation,
            self.robot,
            message=first.content,
            source_message=first,
            templates=[self.template],
        )
        workflow = active_workflow(self.db, self.user, self.conversation, self.robot)
        second = self.customer_message("customer@example.com")

        with patch("app.services.email_service._send_message", side_effect=smtplib.SMTPException("failed")):
            result = start_or_resume_email_workflow(
                self.db,
                self.user,
                self.conversation,
                self.robot,
                message=second.content,
                source_message=second,
                templates=[self.template],
                workflow=workflow,
            )

        self.db.refresh(workflow)
        self.assertEqual(result["text"], FAILURE_TEXT)
        self.assertNotEqual(result["text"], SUCCESS_TEXT)
        self.assertEqual(workflow.status, "failed")

    def test_idempotent_template_send_does_not_send_twice(self) -> None:
        with patch("app.services.email_service._send_message") as send_mock:
            first = send_template_email(
                self.db,
                self.user,
                recipient="customer@example.com",
                template=self.template,
                idempotency_key="same-business-key",
            )
            second = send_template_email(
                self.db,
                self.user,
                recipient="customer@example.com",
                template=self.template,
                idempotency_key="same-business-key",
            )

        self.assertEqual(first.id, second.id)
        send_mock.assert_called_once()

    def test_sandbox_email_result_does_not_send_or_persist(self) -> None:
        before = self.db.scalar(select(ConversationWorkflow))
        with patch("app.services.email_service._send_message") as send_mock:
            result = sandbox_email_result(message="发到 customer@example.com", templates=[self.template])
        after = self.db.scalar(select(ConversationWorkflow))

        self.assertEqual(result["action_plan"]["required_actions"], ["simulate_send_email"])
        self.assertIsNone(before)
        self.assertIsNone(after)
        send_mock.assert_not_called()


if __name__ == "__main__":
    unittest.main()
