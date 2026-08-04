from __future__ import annotations

from datetime import datetime, time, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import desc, func, select
from sqlalchemy.orm import Session, aliased

from app.models import (
    AiModelCall,
    AiProviderConfig,
    AutomationReplyRun,
    Conversation,
    Message,
    PlatformAccount,
    Robot,
    RpaTask,
    User,
    utcnow,
)
from app.schemas.monitoring import (
    ModelMetrics,
    MonitoringEvent,
    MonitoringEventList,
    MonitoringLog,
    MonitoringLogList,
    MonitoringOverview,
)


def _today_start() -> datetime:
    zone = ZoneInfo("Asia/Shanghai")
    return datetime.combine(datetime.now(zone).date(), time.min, tzinfo=zone).astimezone(timezone.utc)


def _available_models(db: Session, user: User) -> tuple[list[str], str]:
    values: set[str] = set(
        db.scalars(select(AiModelCall.model).where(AiModelCall.user_id == user.id)).all()
    )
    config = db.scalar(select(AiProviderConfig).where(AiProviderConfig.user_id == user.id))
    preferred = ""
    if config and config.model:
        values.add(config.model)
        preferred = config.model
    for robot_config in db.scalars(select(Robot.config_json).where(Robot.user_id == user.id)).all():
        if isinstance(robot_config, dict) and robot_config.get("model"):
            values.add(str(robot_config["model"]))
    if not values:
        values.add("deepseek-chat")
    models = sorted(values, key=lambda value: (value != preferred, value))
    return models, preferred or models[0]


def get_overview(db: Session, user: User, model: str | None = None) -> MonitoringOverview:
    available_models, preferred_model = _available_models(db, user)
    current_model = model if model in available_models else preferred_model
    start_at = _today_start()
    call_count, success_count = db.execute(
        select(
            func.count(AiModelCall.id),
            func.count(AiModelCall.id).filter(AiModelCall.status == "success"),
        ).where(
            AiModelCall.user_id == user.id,
            AiModelCall.model == current_model,
            AiModelCall.created_at >= start_at,
        )
    ).one()
    average_response = db.scalar(
        select(func.avg(AutomationReplyRun.reply_generation_duration_ms))
        .join(AiModelCall, AiModelCall.automation_reply_run_id == AutomationReplyRun.id)
        .where(
            AutomationReplyRun.user_id == user.id,
            AutomationReplyRun.reply_generation_duration_ms.is_not(None),
            AiModelCall.model == current_model,
            AiModelCall.stage == "generation",
            AiModelCall.status == "success",
            AiModelCall.created_at >= start_at,
        )
    )
    total = int(call_count or 0)
    return MonitoringOverview(
        current_model=current_model,
        available_models=available_models,
        metrics=ModelMetrics(
            model=current_model,
            request_count=total,
            success_rate=round(int(success_count or 0) * 100 / total, 1) if total else 0,
            average_response_ms=round(float(average_response)) if average_response is not None else None,
        ),
        updated_at=utcnow(),
    )


def _reply_method(run: AutomationReplyRun) -> str:
    if run.qa_entry_id:
        return "QA 问答"
    if run.document_retrieval_used:
        return "文档检索与 AI 生成"
    if run.decision == "needs_human":
        return "待人工处理"
    if run.decision == "no_reply":
        return "无需回复"
    return "AI 生成"


def list_logs(db: Session, user: User, log_type: str = "all", limit: int = 100) -> MonitoringLogList:
    items: list[MonitoringLog] = []
    if log_type in {"all", "reply"}:
        reply_message = aliased(Message)
        rows = db.execute(
            select(AutomationReplyRun, Conversation, Robot, RpaTask, reply_message)
            .join(Conversation, AutomationReplyRun.conversation_id == Conversation.id)
            .join(Robot, AutomationReplyRun.robot_id == Robot.id)
            .outerjoin(RpaTask, AutomationReplyRun.send_task_id == RpaTask.id)
            .outerjoin(reply_message, AutomationReplyRun.reply_message_id == reply_message.id)
            .where(AutomationReplyRun.user_id == user.id)
            .order_by(desc(AutomationReplyRun.created_at))
            .limit(limit)
        ).all()
        for run, conversation, robot, task, message in rows:
            status = "failed" if run.status == "failed" or (task and task.status == "failed") else run.status
            content = (message.content if message else "") or ""
            send_status = task.status if task else ("not_sent" if run.decision != "auto_send" else "unknown")
            items.append(MonitoringLog(
                id=f"reply:{run.id}",
                timestamp=run.completed_at or run.created_at,
                type="reply",
                status=status,
                message=f"{_reply_method(run)}：{content[:100] or '未生成回复内容'}",
                details=(
                    f"{conversation.platform_code} · {conversation.customer_name or '未知客户'} · "
                    f"{robot.name} · 发送状态 {send_status}"
                    + (f" · {run.error_message}" if run.error_message else "")
                ),
                duration_ms=run.reply_generation_duration_ms,
            ))
    if log_type in {"all", "token"}:
        calls = db.scalars(
            select(AiModelCall)
            .where(AiModelCall.user_id == user.id)
            .order_by(desc(AiModelCall.created_at))
            .limit(limit)
        ).all()
        for call in calls:
            stage_label = "意图识别" if call.stage == "intent" else "回复生成"
            items.append(MonitoringLog(
                id=f"token:{call.id}",
                timestamp=call.created_at,
                type="token",
                status=call.status,
                message=f"{call.model} · {stage_label}",
                details=(call.error_message or f"输入 {call.input_tokens}，输出 {call.output_tokens}"),
                model=call.model,
                stage=call.stage,
                input_tokens=call.input_tokens,
                output_tokens=call.output_tokens,
                duration_ms=call.duration_ms,
            ))
    items.sort(key=lambda item: item.timestamp, reverse=True)
    return MonitoringLogList(items=items[:limit])


def list_recent_events(db: Session, user: User, limit: int = 10) -> MonitoringEventList:
    candidates: list[MonitoringEvent] = []
    account_by_id = {
        account.id: account
        for account in db.scalars(
            select(PlatformAccount).where(PlatformAccount.user_id == user.id)
        ).all()
    }
    messages = db.execute(
        select(Message, Conversation)
        .join(Conversation, Message.conversation_id == Conversation.id)
        .where(Message.user_id == user.id, Message.sender_role == "customer", Message.source != "demo")
        .order_by(desc(Message.created_at))
        .limit(limit)
    ).all()
    for message, conversation in messages:
        account = account_by_id.get(conversation.platform_account_id)
        shop = account.account_alias or account.account_name if account else "未绑定店铺"
        candidates.append(MonitoringEvent(
            id=f"message:{message.id}",
            timestamp=message.observed_at or message.sent_at,
            type="message_received",
            message=(
                f"{conversation.platform_code}「{shop}」收到"
                f"「{conversation.customer_name or '未知客户'}」的新消息"
            ),
        ))
    runs = db.scalars(
        select(AutomationReplyRun)
        .where(AutomationReplyRun.user_id == user.id)
        .order_by(desc(AutomationReplyRun.created_at))
        .limit(limit)
    ).all()
    for run in runs:
        if run.status == "failed":
            text, level, event_type = "自动回复处理失败", "error", "reply_failed"
        elif run.qa_entry_id:
            text, level, event_type = "QA 问答匹配成功", "success", "qa_matched"
        elif run.document_retrieval_used:
            text, level, event_type = "文档知识库检索并生成回复完成", "success", "document_reply"
        elif run.decision == "needs_human":
            text, level, event_type = "会话已标记待人工处理", "warning", "human_required"
        elif run.decision == "no_reply":
            text, level, event_type = "机器人判断当前消息无需回复", "info", "no_reply"
        else:
            text, level, event_type = "自动回复内容已生成", "success", "reply_generated"
        candidates.append(MonitoringEvent(
            id=f"reply:{run.id}",
            timestamp=run.completed_at or run.created_at,
            type=event_type,
            level=level,
            message=text,
        ))
    tasks = db.scalars(
        select(RpaTask)
        .where(RpaTask.user_id == user.id)
        .order_by(desc(RpaTask.requested_at))
        .limit(limit)
    ).all()
    for task in tasks:
        if task.status not in {"queued", "completed", "failed"}:
            continue
        if task.status == "completed":
            text, level = "平台回复发送成功", "success"
        elif task.status == "failed":
            text, level = "平台回复发送失败", "error"
        else:
            text, level = "自动回复已提交发送", "info"
        if (task.idempotency_key or "").startswith("auto-timeout:"):
            text = "超时安抚话术" + ("已发送" if task.status == "completed" else "已提交发送")
        candidates.append(MonitoringEvent(
            id=f"task:{task.id}:{task.status}",
            timestamp=task.completed_at or task.requested_at,
            type=f"task_{task.status}",
            level=level,
            message=text,
        ))
    candidates.sort(key=lambda item: item.timestamp, reverse=True)
    return MonitoringEventList(items=candidates[:limit])
