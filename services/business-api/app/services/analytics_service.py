from __future__ import annotations

from collections import Counter
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import HTTPException, status
from sqlalchemy import and_, func, select
from sqlalchemy.orm import Session

from app.models import AutomationReplyRun, Message, RpaTask, User
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
    agent_messages = [message for message in valid_messages if message.sender_role == "agent"]

    reply_message_ids = {message.id for message in agent_messages}
    robot_reply_ids: set[str] = set()
    if reply_message_ids:
        robot_reply_ids = set(
            db.scalars(
                select(AutomationReplyRun.reply_message_id)
                .join(RpaTask, AutomationReplyRun.send_task_id == RpaTask.id)
                .where(
                    AutomationReplyRun.user_id == user.id,
                    AutomationReplyRun.reply_message_id.in_(reply_message_ids),
                    RpaTask.status == "completed",
                )
            ).all()
        )
        robot_reply_ids.discard(None)

    replied_conversations: dict[str, list[Message]] = {}
    for message in agent_messages:
        replied_conversations.setdefault(message.conversation_id, []).append(message)
    independent_count = sum(
        bool(messages) and all(message.id in robot_reply_ids for message in messages)
        for messages in replied_conversations.values()
    )
    reception_rate = (
        round(independent_count * 100 / len(replied_conversations), 1)
        if replied_conversations
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
        ),
        traffic=_traffic_points(inbound_messages, start_date, end_date, zone),
        categories=_categories(category_runs),
        updated_at=utcnow(),
    )
