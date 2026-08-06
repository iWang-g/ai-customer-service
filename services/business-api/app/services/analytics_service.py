from __future__ import annotations

from collections import Counter
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import HTTPException, status
from sqlalchemy import and_, func, select
from sqlalchemy.orm import Session

from app.models import AutomationReplyRun, Conversation, Message, RpaTask, User
from app.models.base import utcnow
from app.schemas.analytics import (
    ConsultationCategory,
    DashboardAnalytics,
    DashboardMetrics,
    TrafficPoint,
)

MAX_DATE_RANGE_DAYS = 90


def _date_bounds(start_date: date, end_date: date, timezone_name: str) -> tuple[datetime, datetime, ZoneInfo]:
    if end_date < start_date:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="结束日期不能早于开始日期",
        )
    if (end_date - start_date).days + 1 > MAX_DATE_RANGE_DAYS:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=f"查询日期范围不能超过 {MAX_DATE_RANGE_DAYS} 天",
        )
    try:
        zone = ZoneInfo(timezone_name)
    except ZoneInfoNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="不支持的时区",
        ) from exc
    local_start = datetime.combine(start_date, time.min, tzinfo=zone)
    local_end = datetime.combine(end_date + timedelta(days=1), time.min, tzinfo=zone)
    return local_start.astimezone(timezone.utc), local_end.astimezone(timezone.utc), zone


def _message_time():
    return func.coalesce(Message.platform_sent_at, Message.observed_at, Message.sent_at)


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _traffic_points(
    messages: list[Message], start_date: date, end_date: date, zone: ZoneInfo
) -> list[TrafficPoint]:
    single_day = start_date == end_date
    if single_day:
        counts = Counter(
            _as_utc(message.platform_sent_at or message.observed_at or message.sent_at)
            .astimezone(zone)
            .hour
            for message in messages
        )
        return [TrafficPoint(label=f"{hour:02d}:00", count=counts[hour]) for hour in range(24)]

    counts = Counter(
        _as_utc(message.platform_sent_at or message.observed_at or message.sent_at)
        .astimezone(zone)
        .date()
        for message in messages
    )
    days = (end_date - start_date).days + 1
    return [
        TrafficPoint(
            label=(start_date + timedelta(days=offset)).strftime("%m-%d"),
            count=counts[start_date + timedelta(days=offset)],
        )
        for offset in range(days)
    ]


def _categories(runs: list[AutomationReplyRun]) -> list[ConsultationCategory]:
    counts: Counter[tuple[str, str | None, str]] = Counter()
    for run in runs:
        if run.qa_category_name:
            counts[("qa_category", run.qa_category_id, run.qa_category_name)] += 1
        elif run.document_retrieval_used:
            counts[("document_retrieval", None, "文档检索")] += 1
    total = sum(counts.values())
    if not total:
        return []
    return [
        ConsultationCategory(
            type=category_type,
            category_id=category_id,
            name=name,
            count=count,
            percentage=round(count * 100 / total, 1),
        )
        for (category_type, category_id, name), count in counts.most_common(5)
    ]


def _run_completion_time():
    return func.coalesce(AutomationReplyRun.completed_at, AutomationReplyRun.updated_at, AutomationReplyRun.created_at)


def get_dashboard_analytics(
    db: Session,
    user: User,
    start_date: date,
    end_date: date,
    timezone_name: str = "Asia/Shanghai",
) -> DashboardAnalytics:
    start_at, end_at, zone = _date_bounds(start_date, end_date, timezone_name)
    timestamp = _message_time()
    valid_messages = list(
        db.scalars(
            select(Message).where(
                Message.user_id == user.id,
                Message.source != "demo",
                Message.message_status == "sent",
                timestamp >= start_at,
                timestamp < end_at,
            )
        ).all()
    )
    inbound_messages = [message for message in valid_messages if message.sender_role == "customer"]
    inbound_conversation_ids = {message.conversation_id for message in inbound_messages}

    completed_runs = list(
        db.scalars(
            select(AutomationReplyRun)
            .join(RpaTask, AutomationReplyRun.send_task_id == RpaTask.id)
            .where(
                AutomationReplyRun.user_id == user.id,
                AutomationReplyRun.status == "succeeded",
                AutomationReplyRun.decision == "auto_send",
                AutomationReplyRun.human_required_marked.is_(False),
                AutomationReplyRun.reply_message_id.is_not(None),
                AutomationReplyRun.send_task_id.is_not(None),
                RpaTask.status == "completed",
                RpaTask.completed_at >= start_at,
                RpaTask.completed_at < end_at,
            )
        ).all()
    )

    run_timestamp = _run_completion_time()
    handoff_run_rows = db.execute(
        select(AutomationReplyRun.conversation_id).where(
            AutomationReplyRun.user_id == user.id,
            AutomationReplyRun.human_required_marked.is_(True),
            run_timestamp >= start_at,
            run_timestamp < end_at,
        )
    ).all()
    handoff_conversation_ids = {conversation_id for (conversation_id,) in handoff_run_rows}

    # Compatibility for rows created before AutomationReplyRun stored handoff summaries.
    legacy_handoff_rows = db.execute(
        select(Message.conversation_id)
        .join(Conversation, Message.conversation_id == Conversation.id)
        .where(
            Message.user_id == user.id,
            Message.sender_role == "customer",
            Message.source != "demo",
            Message.message_status == "sent",
            timestamp >= start_at,
            timestamp < end_at,
            Conversation.human_required.is_(True),
            Conversation.human_required_at >= start_at,
            Conversation.human_required_at < end_at,
        )
    ).all()
    handoff_conversation_ids.update(conversation_id for (conversation_id,) in legacy_handoff_rows)

    robot_reply_count = len(completed_runs)
    handoff_count = len(handoff_conversation_ids)
    total_processing_count = robot_reply_count + handoff_count
    reception_rate = (
        round(robot_reply_count * 100 / total_processing_count, 1)
        if total_processing_count
        else 0.0
    )
    transfer_to_human_rate = (
        round(handoff_count * 100 / len(inbound_conversation_ids), 1)
        if inbound_conversation_ids
        else 0.0
    )

    response_rows = db.execute(
        select(Message.observed_at, RpaTask.completed_at)
        .select_from(AutomationReplyRun)
        .join(Message, AutomationReplyRun.source_message_id == Message.id)
        .join(RpaTask, AutomationReplyRun.send_task_id == RpaTask.id)
        .where(
            AutomationReplyRun.user_id == user.id,
            AutomationReplyRun.status == "succeeded",
            RpaTask.status == "completed",
            RpaTask.completed_at >= start_at,
            RpaTask.completed_at < end_at,
            Message.observed_at.is_not(None),
        )
    ).all()
    response_seconds = [
        (_as_utc(completed_at) - _as_utc(observed_at)).total_seconds()
        for observed_at, completed_at in response_rows
        if completed_at and observed_at and _as_utc(completed_at) >= _as_utc(observed_at)
    ]
    average_response = (
        round(sum(response_seconds) / len(response_seconds), 1) if response_seconds else None
    )

    category_runs = list(
        db.scalars(
            select(AutomationReplyRun).where(
                AutomationReplyRun.user_id == user.id,
                AutomationReplyRun.completed_at >= start_at,
                AutomationReplyRun.completed_at < end_at,
                AutomationReplyRun.status.in_(["succeeded", "no_reply"]),
                and_(
                    AutomationReplyRun.qa_category_name.is_not(None)
                    | AutomationReplyRun.document_retrieval_used.is_(True)
                ),
            )
        ).all()
    )

    return DashboardAnalytics(
        start_date=start_date,
        end_date=end_date,
        metrics=DashboardMetrics(
            message_count=len(valid_messages),
            independent_reception_rate=reception_rate,
            average_response_seconds=average_response,
            transfer_to_human_rate=transfer_to_human_rate,
        ),
        traffic=_traffic_points(inbound_messages, start_date, end_date, zone),
        categories=_categories(category_runs),
        updated_at=utcnow(),
    )
