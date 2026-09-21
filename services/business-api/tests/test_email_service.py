from __future__ import annotations

import unittest
from unittest.mock import MagicMock, patch

from fastapi import HTTPException
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.models import Base, EmailProviderConfig, PlatformAccount, User
from app.schemas.email import EmailConfigUpdate, EmailTemplateCreate, EmailTemplateUpdate
from app.services.email_service import (
    create_template,
    delete_template,
    decrypt_secret,
    encrypt_secret,
    get_config,
    list_templates,
    mask_email,
    provider_defaults,
    save_config,
    test_send,
    update_template,
)


class EmailServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.user = User(
            username="email-test",
            display_name="Email Test",
            password_hash="not-used",
        )
        self.db.add(self.user)
        self.db.commit()
        self.db.refresh(self.user)

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

    def test_provider_defaults_cover_qq_gmail_and_custom(self) -> None:
        self.assertEqual(provider_defaults("qq")["smtp_host"], "smtp.qq.com")
        self.assertEqual(provider_defaults("gmail")["security"], "starttls")
        self.assertEqual(provider_defaults("custom")["smtp_host"], "")

    def test_secret_is_encrypted_and_round_trips(self) -> None:
        encrypted = encrypt_secret("smtp-app-password")
        self.assertNotIn("smtp-app-password", encrypted)
        self.assertEqual(decrypt_secret(encrypted), "smtp-app-password")

    def test_email_mask_does_not_log_full_local_part(self) -> None:
        self.assertEqual(mask_email("customer@example.com"), "cu***@example.com")

    def test_send_requires_enabled_saved_config(self) -> None:
        db = MagicMock()
        db.scalar.return_value = None
        with self.assertRaises(HTTPException) as context:
            test_send(db, MagicMock(id="user-1"), "recipient@example.com")
        self.assertEqual(context.exception.status_code, 400)

    def test_smtp_authentication_error_is_classified(self) -> None:
        config = MagicMock(enabled=True, auth_secret_encrypted="encrypted")
        config.provider = "qq"
        config.sender_email = "sender@example.com"
        db = MagicMock()
        db.scalar.return_value = config
        import smtplib

        with patch(
            "app.services.email_service._send_message",
            side_effect=smtplib.SMTPAuthenticationError(535, b"auth failed"),
        ):
            with self.assertRaises(HTTPException) as context:
                test_send(db, MagicMock(id="user-1"), "recipient@example.com")
        self.assertEqual(context.exception.status_code, 400)
        self.assertIn("认证失败", context.exception.detail)

    def test_template_test_send_uses_enabled_user_template(self) -> None:
        config = EmailProviderConfig(
            user_id=self.user.id,
            enabled=True,
            provider="qq",
            sender_email="sender@example.com",
            smtp_host="smtp.qq.com",
            smtp_port=465,
            security="ssl",
            auth_secret_encrypted=encrypt_secret("secret"),
        )
        self.db.add(config)
        self.db.commit()
        template = create_template(
            self.db,
            self.user,
            EmailTemplateCreate(
                template_key="test-template",
                name="测试模板",
                subject="模板主题",
                body="模板正文",
            ),
        )
        with patch("app.services.email_service._send_message") as send_mock:
            result = test_send(self.db, self.user, "recipient@example.com", template.id)
        self.assertTrue(result.ok)
        self.assertEqual(send_mock.call_args.kwargs["subject"], "模板主题")
        self.assertEqual(send_mock.call_args.kwargs["body"], "模板正文")

    def test_config_persists_encrypted_secret_and_keeps_it_when_blank(self) -> None:
        request = EmailConfigUpdate(
            enabled=True,
            provider="qq",
            sender_email="sender@example.com",
            smtp_host="smtp.qq.com",
            smtp_port=465,
            security="ssl",
            auth_code="smtp-secret",
            trigger_scenarios="客户想要定制",
            ask_email_text="亲，请提供邮箱",
            success_text="亲，邮件已发送",
            missing_template_text="亲，转人工处理",
        )
        saved = save_config(self.db, self.user, request)
        row = self.db.scalar(select(EmailProviderConfig).where(EmailProviderConfig.user_id == self.user.id))
        self.assertTrue(saved.auth_code_saved)
        self.assertEqual(saved.trigger_scenarios, "")
        self.assertEqual(saved.ask_email_text, "亲，请提供邮箱")
        self.assertEqual(saved.success_text, "亲，邮件已发送")
        self.assertEqual(saved.missing_template_text, "亲，转人工处理")
        self.assertIsNotNone(row)
        self.assertNotIn("smtp-secret", row.auth_secret_encrypted)
        encrypted = row.auth_secret_encrypted
        self.assertEqual(row.trigger_scenarios, "")

        request.auth_code = ""
        save_config(self.db, self.user, request)
        self.db.refresh(row)
        self.assertEqual(row.auth_secret_encrypted, encrypted)

    def test_legacy_trigger_scenarios_are_hidden_and_cleared_on_save(self) -> None:
        config = EmailProviderConfig(
            user_id=self.user.id,
            enabled=False,
            provider="qq",
            sender_email="sender@example.com",
            smtp_host="smtp.qq.com",
            smtp_port=465,
            security="ssl",
            trigger_scenarios="客户想要定制",
        )
        self.db.add(config)
        self.db.commit()

        self.assertEqual(get_config(self.db, self.user).trigger_scenarios, "")
        save_config(
            self.db,
            self.user,
            EmailConfigUpdate(
                enabled=False,
                provider="qq",
                sender_email="sender@example.com",
                smtp_host="smtp.qq.com",
                smtp_port=465,
                security="ssl",
                trigger_scenarios="仍然不应生效",
            ),
        )

        self.db.refresh(config)
        self.assertEqual(config.trigger_scenarios, "")

    def test_template_crud_is_scoped_to_user(self) -> None:
        created = create_template(
            self.db,
            self.user,
            EmailTemplateCreate(
                template_key="store-view-link",
                name="店铺看图地址",
                aliases=["看图地址", "看图地址"],
                subject="资料地址",
                body="请查收资料。",
            ),
        )
        self.assertEqual(created.aliases, ["看图地址"])
        updated = update_template(
            self.db,
            self.user,
            created.id,
            EmailTemplateUpdate(name="店铺资料地址", enabled=False),
        )
        self.assertEqual(updated.name, "店铺资料地址")
        self.assertFalse(updated.enabled)
        self.assertEqual(len(list_templates(self.db, self.user)), 1)
        delete_template(self.db, self.user, created.id)
        self.assertEqual(list_templates(self.db, self.user), [])

    def test_template_key_can_be_generated_and_platform_binding_is_unique(self) -> None:
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

        created = create_template(
            self.db,
            self.user,
            EmailTemplateCreate(
                name="店铺资料",
                subject="资料主题",
                body="资料正文",
                platform_account_id=account.id,
            ),
        )
        self.assertTrue(created.template_key)
        self.assertEqual(created.platform_account_id, account.id)
        with self.assertRaises(HTTPException) as context:
            create_template(
                self.db,
                self.user,
                EmailTemplateCreate(
                    name="另一个模板",
                    subject="资料主题",
                    body="资料正文",
                    platform_account_id=account.id,
                ),
            )
        self.assertEqual(context.exception.status_code, 409)


if __name__ == "__main__":
    unittest.main()
