from __future__ import annotations

from datetime import timedelta
import re
from typing import Any

from fastapi import HTTPException
from sqlalchemy import desc, select
from sqlalchemy.orm import Session

from app.core.security import utcnow
from app.models import Conversation, ConversationWorkflow, EmailTemplate, Message, Robot, User
from app.services.email_service import send_template_email


EMAIL_PATTERN = re.compile(
    r"(?<![A-Za-z0-9.!#$%&'*+/=?^_`{|}~-])"
    r"([A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
    r"(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+)"
    r"(?![A-Za-z0-9-])",
    re.IGNORECASE,
)
ACTIVE_STATUSES = ("waiting_for_template", "waiting_for_email", "ready_to_send", "sending")
WORKFLOW_TTL = timedelta(hours=24)
ASK_EMAIL_TEXT = "亲，麻烦提供一下邮箱哦~"
ASK_TEMPLATE_TEXT = "亲，请问您需要哪一份资料呢？"
SUCCESS_TEXT = "亲，资料已发送到您的邮箱，请注意查收哦~"
FAILURE_TEXT = "亲，邮件发送暂时异常，我这边帮您进一步处理。"


def extract_email(value: str) -> str:
    match = EMAIL_PATTERN.search(value or "")
    return match.group(1).lower() if match else ""


def enabled_templates(db: Session, user: User) -> list[EmailTemplate]:
    return list(db.scalars(
        select(EmailTemplate)
        .where(EmailTemplate.user_id == user.id, EmailTemplate.enabled.is_(True))
        .order_by(desc(EmailTemplate.updated_at), EmailTemplate.id)
    ).all())


def template_metadata(templates: list[EmailTemplate]) -> list[dict[str, Any]]:
    return [
        {
            "id": item.id,
            "template_key": item.template_key,
            "name": item.name,
            "scene": item.scene,
            "aliases": list(item.aliases or []),
        }
        for item in templates
    ]


def _not_expired(expires_at: Any, now: Any) -> bool:
    if expires_at is None:
        return True
    if getattr(expires_at, "tzinfo", None) is None and getattr(now, "tzinfo", None) is not None:
        return expires_at > now.replace(tzinfo=None)
    return expires_at > now


def select_template(
    templates: list[EmailTemplate],
    message: str,
    suggested_id: str = "",
) -> EmailTemplate | None:
    suggestion = suggested_id.strip()
    if suggestion:
        for item in templates:
            if suggestion in {item.id, item.template_key}:
                return item
    normalized = message.strip().lower()
    candidates: list[tuple[int, EmailTemplate]] = []
    for item in templates:
        terms = [item.name, item.scene, item.template_key, *(item.aliases or [])]
        matched_lengths = [len(term.strip()) for term in terms if term.strip() and term.strip().lower() in normalized]
        if matched_lengths:
            candidates.append((max(matched_lengths), item))
    if candidates:
        return max(candidates, key=lambda pair: pair[0])[1]
    return templates[0] if len(templates) == 1 else None


def active_workflow(
    db: Session,
    user: User,
    conversation: Conversation,
    robot: Robot,
) -> ConversationWorkflow | None:
    now = utcnow()
    rows = list(db.scalars(
        select(ConversationWorkflow)
        .where(
            ConversationWorkflow.user_id == user.id,
            ConversationWorkflow.conversation_id == conversation.id,
            ConversationWorkflow.robot_id == robot.id,
            ConversationWorkflow.workflow_type == "collect_email_for_link",
            ConversationWorkflow.status.in_(ACTIVE_STATUSES),
        )
        .order_by(desc(ConversationWorkflow.updated_at))
    ).all())
    for row in rows:
        if _not_expired(row.expires_at, now):
            return row
        row.status = "expired"
        row.completed_at = now
    if rows:
        db.commit()
    return None


def _workflow_result(
    *,
    text: str,
    next_action: str,
    decision: str,
    workflow: ConversationWorkflow | None,
    email_action: str,
    email_task_id: str = "",
) -> dict[str, Any]:
    return {
        "decision": decision,
        "text": text,
        "media": [],
        "intent": {
            "intent": "email_link_request",
            "confidence": 1.0,
            "need_customer_reply": bool(text),
            "need_doc_search": False,
            "need_email": True,
            "workflow": "collect_email_for_link",
            "next_action": next_action,
            "missing_slots": list(workflow.missing_slots_json if workflow else []),
            "risk_flags": ["direct_external_link_blocked"],
            "reason": "会话邮件工作流由程序恢复和编排",
        },
        "action_plan": {
            "workflow": "collect_email_for_link",
            "next_action": next_action,
            "generate_reply": False,
            "need_doc_search": False,
            "email_service_required": email_action in {"send_email", "email_sent", "email_failed"},
            "required_actions": [email_action] if email_action else [],
            "blocked_actions": ["send_external_link_in_chat"],
        },
        "confidence": 1.0,
        "risk_flags": ["direct_external_link_blocked"],
        "qa_match": {"matched": False, "status": "skipped", "match_type": "workflow_resume"},
        "retrieval": [],
        "model_calls": {"intent": "skipped-workflow-resume", "generation": "skipped"},
        "provider": "email-workflow",
        "trace_id": f"workflow-{workflow.id if workflow else 'sandbox'}",
        "workflow_id": workflow.id if workflow else "",
        "email_task_id": email_task_id,
    }


def sandbox_email_result(
    *,
    message: str,
    templates: list[EmailTemplate],
    suggested_template_id: str = "",
) -> dict[str, Any]:
    template = select_template(templates, message, suggested_template_id)
    recipient = extract_email(message)
    if template is None:
        return _workflow_result(
            text=ASK_TEMPLATE_TEXT,
            next_action="ask_template",
            decision="suggest",
            workflow=None,
            email_action="simulate_save_pending_workflow",
        )
    if not recipient:
        return _workflow_result(
            text=ASK_EMAIL_TEXT,
            next_action="ask_email",
            decision="suggest",
            workflow=None,
            email_action="simulate_save_pending_workflow",
        )
    return _workflow_result(
        text=SUCCESS_TEXT,
        next_action="simulate_send_email",
        decision="suggest",
        workflow=None,
        email_action="simulate_send_email",
    )


def start_or_resume_email_workflow(
    db: Session,
    user: User,
    conversation: Conversation,
    robot: Robot,
    *,
    message: str,
    source_message: Message | None,
    templates: list[EmailTemplate],
    suggested_template_id: str = "",
    workflow: ConversationWorkflow | None = None,
) -> dict[str, Any]:
    row = workflow
    if row is None:
        row = ConversationWorkflow(
            user_id=user.id,
            conversation_id=conversation.id,
            robot_id=robot.id,
            workflow_type="collect_email_for_link",
            status="waiting_for_template",
            intent="email_link_request",
            collected_slots_json={},
            missing_slots_json=["template", "email"],
            source_message_id=source_message.id if source_message else None,
            expires_at=utcnow() + WORKFLOW_TTL,
        )
        db.add(row)
        db.flush()

    slots = dict(row.collected_slots_json or {})
    template = None
    if row.template_id:
        template = next((item for item in templates if item.id == row.template_id), None)
    if template is None:
        template = select_template(templates, message, suggested_template_id)
    recipient = extract_email(message) or str(slots.get("email") or "")
    if template is not None:
        row.template_id = template.id
        slots["template_id"] = template.id
    if recipient:
        slots["email"] = recipient
    row.collected_slots_json = slots
    row.source_message_id = source_message.id if source_message else row.source_message_id
    row.expires_at = utcnow() + WORKFLOW_TTL

    missing = []
    if template is None:
        missing.append("template")
    if not recipient:
        missing.append("email")
    row.missing_slots_json = missing
    if "template" in missing:
        row.status = "waiting_for_template"
        db.commit()
        db.refresh(row)
        return _workflow_result(
            text=ASK_TEMPLATE_TEXT,
            next_action="ask_template",
            decision="auto_send",
            workflow=row,
            email_action="save_pending_workflow",
        )
    if "email" in missing:
        row.status = "waiting_for_email"
        db.commit()
        db.refresh(row)
        return _workflow_result(
            text=ASK_EMAIL_TEXT,
            next_action="ask_email",
            decision="auto_send",
            workflow=row,
            email_action="save_pending_workflow",
        )

    row.status = "sending"
    db.commit()
    db.refresh(row)
    source_key = source_message.id if source_message else row.source_message_id or row.id
    idempotency_key = f"email-workflow:{row.id}:{template.id}:{source_key}"
    try:
        task = send_template_email(
            db,
            user,
            recipient=recipient,
            template=template,
            idempotency_key=idempotency_key,
            conversation_id=conversation.id,
            workflow_id=row.id,
            source_message_id=source_message.id if source_message else None,
        )
    except HTTPException:
        row.status = "failed"
        row.completed_at = utcnow()
        db.commit()
        return _workflow_result(
            text=FAILURE_TEXT,
            next_action="email_failed",
            decision="auto_send",
            workflow=row,
            email_action="email_failed",
        )

    if task.status != "sent":
        row.status = "failed"
        row.completed_at = utcnow()
        db.commit()
        return _workflow_result(
            text=FAILURE_TEXT,
            next_action="email_failed",
            decision="auto_send",
            workflow=row,
            email_action="email_failed",
            email_task_id=task.id,
        )
    row.status = "completed"
    row.completed_at = utcnow()
    row.missing_slots_json = []
    db.commit()
    return _workflow_result(
        text=SUCCESS_TEXT,
        next_action="email_sent",
        decision="auto_send",
        workflow=row,
        email_action="email_sent",
        email_task_id=task.id,
    )
