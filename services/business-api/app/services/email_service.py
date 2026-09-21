from __future__ import annotations

import base64
from email.message import EmailMessage
import hashlib
import logging
import re
import smtplib
import ssl
import time
import uuid

from cryptography.fernet import Fernet, InvalidToken
from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.security import utcnow
from app.models import EmailProviderConfig, EmailSendTask, EmailTemplate, PlatformAccount, User
from app.schemas.email import (
    EmailConfigRead,
    EmailConfigUpdate,
    EmailTemplateCreate,
    EmailTemplateRead,
    EmailTemplateUpdate,
    EmailTestResponse,
)


logger = logging.getLogger(__name__)
PROVIDER_DEFAULTS = {
    "qq": {"smtp_host": "smtp.qq.com", "smtp_port": 465, "security": "ssl"},
    "gmail": {"smtp_host": "smtp.gmail.com", "smtp_port": 587, "security": "starttls"},
    "custom": {"smtp_host": "", "smtp_port": 465, "security": "ssl"},
}
DEFAULT_ASK_EMAIL_TEXT = "亲，请发送一下完整邮箱号哦~"
DEFAULT_EMAIL_SUCCESS_TEXT = "亲，已发送到您的邮箱，陌生邮件可能存放垃圾邮件里，请注意查收哦~"
DEFAULT_MISSING_TEMPLATE_TEXT = "亲，这边先为您转接人工客服进一步处理，请稍等~"


def provider_defaults(provider: str) -> dict[str, object]:
    return dict(PROVIDER_DEFAULTS.get(provider, PROVIDER_DEFAULTS["custom"]))


def mask_email(value: str) -> str:
    local, separator, domain = value.strip().partition("@")
    if not separator:
        return ""
    visible = local[:2] if len(local) > 2 else local[:1]
    return f"{visible}***@{domain}"


def _fernet() -> Fernet:
    secret = get_settings().jwt_secret_key.encode("utf-8")
    key = base64.urlsafe_b64encode(hashlib.sha256(b"email-secret:" + secret).digest())
    return Fernet(key)


def encrypt_secret(value: str) -> str:
    return _fernet().encrypt(value.encode("utf-8")).decode("ascii") if value else ""


def decrypt_secret(value: str) -> str:
    if not value:
        return ""
    try:
        return _fernet().decrypt(value.encode("ascii")).decode("utf-8")
    except (InvalidToken, ValueError) as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="邮件授权码无法解密，请重新保存邮件配置",
        ) from exc


def encrypt_recipient(value: str) -> str:
    return encrypt_secret(value.strip().lower())


def decrypt_recipient(value: str) -> str:
    return decrypt_secret(value)


def _config(db: Session, user: User) -> EmailProviderConfig | None:
    return db.scalar(select(EmailProviderConfig).where(EmailProviderConfig.user_id == user.id))


def read_config(config: EmailProviderConfig | None) -> EmailConfigRead:
    if config is None:
        defaults = provider_defaults("qq")
        return EmailConfigRead(
            enabled=False,
            provider="qq",
            sender_email="",
            sender_email_masked="",
            smtp_host=str(defaults["smtp_host"]),
            smtp_port=int(defaults["smtp_port"]),
            security=str(defaults["security"]),
            auth_code_saved=False,
            trigger_scenarios="",
            ask_email_text=DEFAULT_ASK_EMAIL_TEXT,
            success_text=DEFAULT_EMAIL_SUCCESS_TEXT,
            missing_template_text=DEFAULT_MISSING_TEMPLATE_TEXT,
        )
    return EmailConfigRead(
        enabled=config.enabled,
        provider=config.provider,
        sender_email=config.sender_email,
        sender_email_masked=mask_email(config.sender_email),
        smtp_host=config.smtp_host,
        smtp_port=config.smtp_port,
        security=config.security,
        auth_code_saved=bool(config.auth_secret_encrypted),
        trigger_scenarios="",
        ask_email_text=config.ask_email_text or DEFAULT_ASK_EMAIL_TEXT,
        success_text=config.success_text or DEFAULT_EMAIL_SUCCESS_TEXT,
        missing_template_text=config.missing_template_text or DEFAULT_MISSING_TEMPLATE_TEXT,
        updated_at=config.updated_at,
    )


def get_config(db: Session, user: User) -> EmailConfigRead:
    return read_config(_config(db, user))


def save_config(db: Session, user: User, request: EmailConfigUpdate) -> EmailConfigRead:
    config = _config(db, user)
    if config is None:
        config = EmailProviderConfig(user_id=user.id)
        db.add(config)
    config.enabled = request.enabled
    config.provider = request.provider
    config.sender_email = request.sender_email.strip()
    config.smtp_host = request.smtp_host.strip()
    config.smtp_port = request.smtp_port
    config.security = request.security
    # Retain the column for API/database compatibility, but do not allow free-form
    # trigger text to influence email routing.
    config.trigger_scenarios = ""
    config.ask_email_text = request.ask_email_text.strip()
    config.success_text = request.success_text.strip()
    config.missing_template_text = request.missing_template_text.strip()
    if request.auth_code:
        config.auth_secret_encrypted = encrypt_secret(request.auth_code)
    if request.enabled and not config.auth_secret_encrypted:
        raise HTTPException(status_code=400, detail="启用邮件服务前请填写 SMTP 授权码或应用密码")
    db.commit()
    db.refresh(config)
    logger.info(
        "email config saved user_id=%s provider=%s sender=%s smtp_host=%s smtp_port=%d security=%s enabled=%s secret_saved=%s",
        user.id,
        config.provider,
        mask_email(config.sender_email),
        config.smtp_host,
        config.smtp_port,
        config.security,
        config.enabled,
        bool(config.auth_secret_encrypted),
    )
    return read_config(config)


def _template_key_from_name(name: str) -> str:
    base = re.sub(r"[^A-Za-z0-9_.:-]+", "-", name.strip().lower()).strip("-_.:")
    return (base or f"email-template-{uuid.uuid4().hex[:8]}")[:80]


def _unique_template_key(db: Session, user: User, name: str) -> str:
    base = _template_key_from_name(name)
    candidate = base
    suffix = 1
    while db.scalar(select(EmailTemplate.id).where(
        EmailTemplate.user_id == user.id,
        EmailTemplate.template_key == candidate,
    )):
        suffix += 1
        tail = f"-{suffix}"
        candidate = f"{base[:80 - len(tail)]}{tail}"
    return candidate


def _validate_platform_account(db: Session, user: User, platform_account_id: str | None) -> str | None:
    value = (platform_account_id or "").strip()
    if not value:
        return None
    account = db.scalar(select(PlatformAccount).where(
        PlatformAccount.id == value,
        PlatformAccount.user_id == user.id,
        PlatformAccount.is_active.is_(True),
    ))
    if account is None:
        raise HTTPException(status_code=404, detail="绑定店铺不存在或已停用")
    return value


def _send_message(
    config: EmailProviderConfig,
    recipient: str,
    message_id: str,
    *,
    subject: str,
    body: str,
) -> None:
    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = config.sender_email
    message["To"] = recipient
    message["X-AI-Customer-Service-Message-Id"] = message_id
    message.set_content(body, charset="utf-8")
    password = decrypt_secret(config.auth_secret_encrypted)
    if config.security == "ssl":
        with smtplib.SMTP_SSL(
            config.smtp_host,
            config.smtp_port,
            timeout=20,
            context=ssl.create_default_context(),
        ) as smtp:
            smtp.login(config.sender_email, password)
            smtp.send_message(message)
        return
    with smtplib.SMTP(config.smtp_host, config.smtp_port, timeout=20) as smtp:
        if config.security == "starttls":
            smtp.starttls(context=ssl.create_default_context())
        smtp.login(config.sender_email, password)
        smtp.send_message(message)


def test_send(
    db: Session,
    user: User,
    recipient: str,
    template_id: str | None = None,
) -> EmailTestResponse:
    config = _config(db, user)
    if config is None or not config.enabled:
        raise HTTPException(status_code=400, detail="邮件服务未启用")
    if not config.auth_secret_encrypted:
        raise HTTPException(status_code=400, detail="SMTP 授权码尚未配置")
    template = None
    if template_id:
        template = db.scalar(select(EmailTemplate).where(
            EmailTemplate.id == template_id,
            EmailTemplate.user_id == user.id,
            EmailTemplate.enabled.is_(True),
        ))
        if template is None:
            raise HTTPException(status_code=404, detail="测试邮件模板不存在或未启用")
    subject = template.subject if template else "AI智能客服邮件服务测试"
    body = template.body if template else "这是一封来自 AI智能客服 的测试邮件。收到此邮件说明 SMTP 配置可用。"
    message_id = f"mail-test-{uuid.uuid4().hex}"
    started = time.monotonic()
    logger.info(
        "email test started user_id=%s message_id=%s provider=%s from=%s to=%s",
        user.id,
        message_id,
        config.provider,
        mask_email(config.sender_email),
        mask_email(recipient),
    )
    try:
        _send_message(config, recipient, message_id, subject=subject, body=body)
    except smtplib.SMTPAuthenticationError as exc:
        raise HTTPException(status_code=400, detail="邮箱认证失败，请检查授权码或应用密码") from exc
    except (TimeoutError, smtplib.SMTPServerDisconnected) as exc:
        raise HTTPException(status_code=504, detail="SMTP 连接或发送超时") from exc
    except (OSError, smtplib.SMTPConnectError) as exc:
        raise HTTPException(status_code=502, detail=f"SMTP 连接失败：{exc}") from exc
    except smtplib.SMTPException as exc:
        raise HTTPException(status_code=502, detail=f"SMTP 发送失败：{exc}") from exc
    elapsed_ms = int((time.monotonic() - started) * 1000)
    logger.info(
        "email test finished user_id=%s message_id=%s to=%s elapsed_ms=%d",
        user.id,
        message_id,
        mask_email(recipient),
        elapsed_ms,
    )
    return EmailTestResponse(ok=True, message="测试邮件发送成功", message_id=message_id, elapsed_ms=elapsed_ms)


def send_template_email(
    db: Session,
    user: User,
    *,
    recipient: str,
    template: EmailTemplate,
    idempotency_key: str,
    conversation_id: str | None = None,
    workflow_id: str | None = None,
    source_message_id: str | None = None,
) -> EmailSendTask:
    """Send one enabled template at most once for a deterministic business key."""
    existing = db.scalar(select(EmailSendTask).where(EmailSendTask.idempotency_key == idempotency_key))
    if existing is not None:
        return existing
    if template.user_id != user.id or not template.enabled:
        raise HTTPException(status_code=404, detail="邮件模板不存在或未启用")
    config = _config(db, user)
    if config is None or not config.enabled:
        raise HTTPException(status_code=400, detail="邮件服务未启用")
    if not config.auth_secret_encrypted:
        raise HTTPException(status_code=400, detail="SMTP 授权码尚未配置")

    message_id = f"mail-{uuid.uuid4().hex}"
    task = EmailSendTask(
        user_id=user.id,
        conversation_id=conversation_id,
        workflow_id=workflow_id,
        template_id=template.id,
        source_message_id=source_message_id,
        idempotency_key=idempotency_key,
        recipient_email_encrypted=encrypt_recipient(recipient),
        recipient_email_masked=mask_email(recipient),
        status="sending",
        provider_message_id=message_id,
    )
    db.add(task)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        existing = db.scalar(select(EmailSendTask).where(EmailSendTask.idempotency_key == idempotency_key))
        if existing is not None:
            return existing
        raise
    db.refresh(task)
    logger.info(
        "email workflow send started user_id=%s message_id=%s template_id=%s to=%s",
        user.id,
        message_id,
        template.id,
        mask_email(recipient),
    )
    try:
        _send_message(config, recipient, message_id, subject=template.subject, body=template.body)
    except smtplib.SMTPAuthenticationError as exc:
        error_code, error_message = "authentication_failed", "邮箱认证失败，请检查授权码或应用密码"
        task.status = "failed"
        task.error_code = error_code
        task.error_message = error_message
        db.commit()
        raise HTTPException(status_code=400, detail=error_message) from exc
    except (TimeoutError, smtplib.SMTPServerDisconnected) as exc:
        error_code, error_message = "timeout", "SMTP 连接或发送超时"
        task.status = "failed"
        task.error_code = error_code
        task.error_message = error_message
        db.commit()
        raise HTTPException(status_code=504, detail=error_message) from exc
    except (OSError, smtplib.SMTPConnectError) as exc:
        error_code, error_message = "connection_failed", "SMTP 连接失败"
        task.status = "failed"
        task.error_code = error_code
        task.error_message = error_message
        db.commit()
        raise HTTPException(status_code=502, detail=error_message) from exc
    except smtplib.SMTPException as exc:
        error_code, error_message = "smtp_failed", "SMTP 发送失败"
        task.status = "failed"
        task.error_code = error_code
        task.error_message = error_message
        db.commit()
        raise HTTPException(status_code=502, detail=error_message) from exc

    task.status = "sent"
    task.sent_at = utcnow()
    db.commit()
    db.refresh(task)
    logger.info(
        "email workflow send finished user_id=%s message_id=%s template_id=%s to=%s",
        user.id,
        message_id,
        template.id,
        mask_email(recipient),
    )
    return task


def list_templates(db: Session, user: User) -> list[EmailTemplateRead]:
    rows = list(db.scalars(
        select(EmailTemplate)
        .where(EmailTemplate.user_id == user.id)
        .order_by(EmailTemplate.updated_at.desc())
    ).all())
    return [EmailTemplateRead.model_validate(row) for row in rows]


def create_template(db: Session, user: User, request: EmailTemplateCreate) -> EmailTemplateRead:
    values = request.model_dump()
    values["template_key"] = (values.get("template_key") or "").strip() or _unique_template_key(db, user, request.name)
    values["platform_account_id"] = _validate_platform_account(db, user, values.get("platform_account_id"))
    values["aliases"] = list(dict.fromkeys(value.strip() for value in values.get("aliases", []) if value.strip()))
    row = EmailTemplate(user_id=user.id, **values)
    db.add(row)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="模板 ID 已存在，或该店铺已绑定其他邮件模板") from exc
    db.refresh(row)
    return EmailTemplateRead.model_validate(row)


def update_template(
    db: Session,
    user: User,
    template_id: str,
    request: EmailTemplateUpdate,
) -> EmailTemplateRead:
    row = db.scalar(select(EmailTemplate).where(EmailTemplate.id == template_id, EmailTemplate.user_id == user.id))
    if row is None:
        raise HTTPException(status_code=404, detail="邮件模板不存在")
    values = request.model_dump(exclude_unset=True)
    if "aliases" in values and values["aliases"] is not None:
        values["aliases"] = list(dict.fromkeys(value.strip() for value in values["aliases"] if value.strip()))
    if "platform_account_id" in values:
        values["platform_account_id"] = _validate_platform_account(db, user, values.get("platform_account_id"))
    if "template_key" in values:
        if values["template_key"] is None:
            values.pop("template_key")
        else:
            values["template_key"] = values["template_key"].strip()
    for key, value in values.items():
        setattr(row, key, value)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="模板 ID 已存在，或该店铺已绑定其他邮件模板") from exc
    db.refresh(row)
    return EmailTemplateRead.model_validate(row)


def delete_template(db: Session, user: User, template_id: str) -> None:
    row = db.scalar(select(EmailTemplate).where(EmailTemplate.id == template_id, EmailTemplate.user_id == user.id))
    if row is None:
        raise HTTPException(status_code=404, detail="邮件模板不存在")
    db.delete(row)
    db.commit()
