"""Eligibility shared by ingestion, reply generation and final send validation."""
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Conversation, Message, Robot, RobotPlatformScope, RpaTask, User, utcnow
from app.services.settings_service import auto_reply_enabled
from app.services.douyin_message_context import eligible as context_message_eligible

DOUYIN_CLOCK_SKEW_SECONDS = 5
DOUYIN_REPLY_MAX_AGE_SECONDS = 300


def _time(value: Any) -> datetime | None:
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    if not isinstance(value, datetime):
        return None
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value


def live_reply_source(payload: dict[str, Any], platform_message_id: str | None, *, now: datetime | None = None) -> bool:
    structured = payload.get("structured_payload")
    structured = structured if isinstance(structured, dict) else {}
    sent = _time(payload.get("platform_sent_at"))
    started = _time(payload.get("collector_started_at"))
    observed = _time(payload.get("observed_at"))
    current = _time(now or utcnow())
    return bool(
        platform_message_id and platform_message_id != "0"
        and payload.get("automation_mode") == "trigger"
        and payload.get("sender_role") == "customer"
        and (payload.get("message_type") in {"text", "product"} or context_message_eligible(payload))
        and str(payload.get("content") or "").strip()
        and structured.get("sender_biz_role") == "Buyer"
        and structured.get("collection_source") == "live"
        # Source and identity establish live delivery. Cross-system timestamps
        # are only a bounded freshness check; platform clocks can run ahead.
        and sent and started and observed and started <= observed
        and (sent - started).total_seconds() >= -DOUYIN_CLOCK_SKEW_SECONDS
        and -DOUYIN_CLOCK_SKEW_SECONDS <= (observed - sent).total_seconds() <= DOUYIN_REPLY_MAX_AGE_SECONDS
        and -DOUYIN_CLOCK_SKEW_SECONDS <= (current - observed).total_seconds() <= DOUYIN_REPLY_MAX_AGE_SECONDS
        and -DOUYIN_CLOCK_SKEW_SECONDS <= (current - sent).total_seconds() <= DOUYIN_REPLY_MAX_AGE_SECONDS
    )


def robot_matches(db: Session, robot: Robot | None, conversation: Conversation) -> bool:
    return bool(robot and robot.user_id == conversation.user_id and robot.enabled
        and robot.status == "online" and db.scalar(select(RobotPlatformScope.id).where(
            RobotPlatformScope.robot_id == robot.id,
            RobotPlatformScope.platform_code == "douyin",
            (RobotPlatformScope.all_accounts.is_(True)
             | (RobotPlatformScope.platform_account_id == conversation.platform_account_id)),
        )))


def reply_block_reason(db: Session, conversation: Conversation | None, source: Message | None,
                       robot: Robot | None, *, sending: bool = False, task_id: str | None = None) -> str | None:
    if not conversation or conversation.deleted_at is not None:
        return "会话已删除"
    from app.services.douyin_transfer_service import transfer_blocked
    if transfer_blocked(conversation):
        return "会话正在转接、已转出或结果待核对"
    user = db.get(User, conversation.user_id)
    if not user or not auto_reply_enabled(db, user):
        return "AI 自动回复总开关已关闭"
    account = conversation.platform_account
    metadata = (account.metadata_json or {}) if account else {}
    if (not account or not account.is_active or account.login_status != "online"
        or metadata.get("im_ready") is not True or metadata.get("message_send_enabled") is not True
        or metadata.get("ai_text_reply_enabled") is not True or not account.last_rpa_node_id):
        return "抖店工作台未就绪或已暂停"
    if not robot_matches(db, robot, conversation):
        return "机器人已停用或未分配到该抖店店铺"
    if sending and (robot.config_json or {}).get("allow_auto_send") is not True:
        return "机器人未开启自动发送"
    task = db.get(RpaTask, task_id) if task_id else None
    own_handoff_notice = bool(task and conversation.human_required_at
        and _time((task.payload_json or {}).get("automation_human_required_at")) == _time(conversation.human_required_at))
    # awaiting_reply is a UI reminder that is also cleared when opening a
    # conversation. Actual takeover/replies must be checked independently.
    if conversation.human_required and not own_handoff_notice:
        return "会话已标记为需人工处理"
    if (not source or source.conversation_id != conversation.id or source.sender_role != "customer"
        or not live_reply_source(source.raw_payload or {}, source.platform_message_id)):
        return "仅支持接收窗口内且身份明确的新客户聊天消息"
    # Human replies and newer customer turns supersede an unfinished generation.
    newer = db.scalar(select(Message.id).where(
        Message.conversation_id == conversation.id,
        Message.id != source.id,
        Message.message_status != "failed",
        Message.sender_role.in_(["agent", "customer"]),
        Message.conversation_sequence > source.conversation_sequence,
        Message.id != (task.message_id if task else ""),
    ).limit(1))
    if newer:
        return "客户或人工客服已有更新消息"
    pending = db.scalar(select(RpaTask.id).where(
        RpaTask.conversation_id == conversation.id,
        RpaTask.task_type.notin_(['refresh_product_details', 'refresh_customer_orders']),
        RpaTask.status.in_(["queued", "dispatched", "acknowledged", "confirmation_pending"]),
        RpaTask.id != (task_id or ""),
    ).limit(1))
    return "该会话仍有发送中或待确认任务" if pending else None


def task_block_reason(db: Session, task: RpaTask) -> str | None:
    payload = task.payload_json or {}
    conversation = db.get(Conversation, task.conversation_id)
    if payload.get('douyin_auto_operation_id'):
        from app.services.douyin_auto_transfer import ack_allowed
        return None if conversation and ack_allowed(db, conversation, task) else '自动转接告知任务已失效'
    return reply_block_reason(db, conversation,
        db.get(Message, payload.get("automation_source_message_id")) if payload.get("automation_source_message_id") else None,
        db.get(Robot, payload.get("automation_robot_id")) if payload.get("automation_robot_id") else None,
        sending=True, task_id=task.id)
