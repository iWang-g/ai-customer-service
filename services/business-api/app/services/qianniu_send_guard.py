from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Conversation, RpaTask, User
from app.services import qianniu_transfer_service as qn_transfer
from app.services.qianniu_product_links import outbound_reason
from app.services.qianniu_auto_transfer import ack_allowed


def check_qianniu_send_guard(
    db: Session,
    user: User,
    platform_account_id: str,
    cid: str,
    task_id: str | None = None,
) -> dict[str, bool]:
    rows = list(
        db.scalars(
            select(Conversation).where(
                Conversation.user_id == user.id,
                Conversation.platform_account_id == platform_account_id,
                Conversation.external_conversation_id == cid,
                Conversation.platform_code == "qianniu",
                Conversation.deleted_at.is_(None),
            )
        )
    )
    if len(rows) != 1:
        raise HTTPException(409, "千牛发送会话未唯一绑定")

    task = db.get(RpaTask, task_id) if task_id else None
    invalid = bool(
        task_id
        and (
            not task
            or task.user_id != user.id
            or task.conversation_id != rows[0].id
            or task.platform_code != "qianniu"
            or task.platform_account_id != rows[0].platform_account_id
            or task.status not in {"dispatched", "acknowledged"}
            or task.task_type != "send_message"
        )
    )
    if task and (task.payload_json or {}).get("source") != "desktop":
        content = str((task.payload_json or {}).get("content") or "")
        invalid = invalid or bool(
            outbound_reason(db, rows[0], content)
        )
    return {
        "blocked": invalid
        or (qn_transfer.transfer_blocked(rows[0]) and not ack_allowed(db, rows[0], task))
    }
