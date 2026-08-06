from __future__ import annotations

import logging
from hashlib import sha256
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import and_, desc, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import (
    Conversation,
    CustomerOrder,
    CustomerOutreachRun,
    Message,
    Robot,
    RobotPlatformScope,
    RpaTask,
    User,
    utcnow,
)
from app.schemas.message import SendMessageRequest
from app.schemas.order import CustomerOrderRead, CustomerOrdersResponse, OutreachStatusRead


ORDER_STATUSES = {
    "pending_payment",
    "paid_pending_shipment",
    "shipped_pending_receipt",
    "signed",
    "completed",
    "refunding",
    "refunded",
    "cancelled",
    "unknown",
}
COLLECTION_STATUSES = {"success", "empty", "unavailable"}
ACTIVE_OUTREACH_STATUSES = {"candidate", "scheduled", "rechecking", "queued"}
logger = logging.getLogger(__name__)
SHOP_TIMEZONE = timezone(timedelta(hours=8))


def _datetime(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=SHOP_TIMEZONE)
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=SHOP_TIMEZONE)


def _amount(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return round(float(value), 2)
    except (TypeError, ValueError):
        return None


def _customer_key(conversation: Conversation, payload: dict[str, Any]) -> str:
    explicit = str(payload.get("customer_key") or "").strip()
    if explicit:
        return explicit[:160]
    external = str(conversation.external_conversation_id or "").strip()
    if external:
        return f"conversation:{external}"[:160]
    return f"name:{conversation.customer_name or conversation.id}"[:160]


def _active_robot(db: Session, conversation: Conversation) -> Robot | None:
    return db.scalar(
        select(Robot)
        .join(RobotPlatformScope, RobotPlatformScope.robot_id == Robot.id)
        .where(
            Robot.user_id == conversation.user_id,
            Robot.enabled.is_(True),
            Robot.status == "online",
            or_(
                RobotPlatformScope.platform_code == "all",
                and_(
                    RobotPlatformScope.platform_code == conversation.platform_code,
                    or_(
                        RobotPlatformScope.all_accounts.is_(True),
                        RobotPlatformScope.platform_account_id == conversation.platform_account_id,
                    ),
                ),
            ),
        )
        .order_by(desc(Robot.updated_at))
        .limit(1)
    )


def _config_int(config: dict[str, Any], key: str, default: int, minimum: int, maximum: int) -> int:
    value = config.get(key, default)
    if isinstance(value, bool):
        return default
    try:
        return max(minimum, min(int(value), maximum))
    except (TypeError, ValueError):
        return default


def _create_outreach(
    db: Session,
    *,
    conversation: Conversation,
    robot: Robot,
    strategy_type: str,
    customer_key: str,
    due_at: datetime,
    message_text: str,
    decision: dict[str, Any],
    order_id: str | None = None,
    source_message_id: str | None = None,
) -> CustomerOutreachRun | None:
    existing = db.scalar(select(CustomerOutreachRun).where(
        CustomerOutreachRun.platform_account_id == conversation.platform_account_id,
        CustomerOutreachRun.customer_key == customer_key,
        CustomerOutreachRun.strategy_type == strategy_type,
    ))
    if existing is not None:
        return None
    outreach_key = sha256(
        f"{conversation.platform_account_id}:{customer_key}:{strategy_type}".encode("utf-8")
    ).hexdigest()[:48]
    run = CustomerOutreachRun(
        user_id=conversation.user_id,
        robot_id=robot.id,
        platform_account_id=conversation.platform_account_id,
        conversation_id=conversation.id,
        customer_key=customer_key,
        strategy_type=strategy_type,
        order_id=order_id,
        source_message_id=source_message_id,
        status="scheduled",
        due_at=due_at,
        decision_json=decision,
        message_text=message_text,
        idempotency_key=f"customer-outreach:{outreach_key}",
    )
    try:
        with db.begin_nested():
            db.add(run)
            db.flush()
    except IntegrityError:
        return None
    return run


def maybe_create_order_follow_up(
    db: Session,
    conversation: Conversation,
    robot: Robot,
    source_message: Message,
    result: dict[str, Any],
) -> CustomerOutreachRun | None:
    config = robot.config_json if isinstance(robot.config_json, dict) else {}
    if config.get("order_follow_up_enabled") is not True:
        return None
    text = str(config.get("order_follow_up_text") or "").strip()
    if not text or conversation.human_required:
        return None
    summary = (conversation.metadata_json or {}).get("customer_orders")
    if not isinstance(summary, dict) or summary.get("collection_status") != "empty":
        return None
    intent = result.get("intent") if isinstance(result.get("intent"), dict) else {}
    try:
        threshold = float(config.get("order_follow_up_confidence", 0.8) or 0.8)
    except (TypeError, ValueError):
        threshold = 0.8
    try:
        confidence = float(intent.get("outreach_confidence") or 0)
    except (TypeError, ValueError):
        confidence = 0
    if (
        intent.get("purchase_intent") != "strong"
        or intent.get("outreach_suggestion") != "create_order_follow_up_candidate"
        or confidence < threshold
    ):
        return None
    customer_key = str(summary.get("customer_key") or _customer_key(conversation, {}))
    delay_minutes = _config_int(config, "order_follow_up_delay_minutes", 60, 1, 4320)
    return _create_outreach(
        db,
        conversation=conversation,
        robot=robot,
        strategy_type="order_follow_up",
        customer_key=customer_key,
        due_at=utcnow() + timedelta(minutes=delay_minutes),
        message_text=text,
        source_message_id=source_message.id,
        decision={
            "purchase_intent": intent.get("purchase_intent"),
            "confidence": intent.get("outreach_confidence"),
            "reason": intent.get("outreach_reason"),
            "mark_human_required_after_send": config.get(
                "order_follow_up_mark_human_required"
            ) is True,
        },
    )


def _maybe_create_post_receipt(
    db: Session,
    conversation: Conversation,
    order: CustomerOrder,
) -> CustomerOutreachRun | None:
    robot = _active_robot(db, conversation)
    if robot is None:
        return None
    config = robot.config_json if isinstance(robot.config_json, dict) else {}
    if config.get("post_receipt_care_enabled") is not True:
        return None
    text = str(config.get("post_receipt_care_text") or "").strip()
    if not text or conversation.human_required:
        return None
    max_order_age_days = _config_int(config, "post_receipt_care_max_order_age_days", 30, 1, 90)
    if order.ordered_at and order.ordered_at < utcnow() - timedelta(days=max_order_age_days):
        return None
    delay_days = _config_int(config, "post_receipt_care_delay_days", 2, 0, 30)
    return _create_outreach(
        db,
        conversation=conversation,
        robot=robot,
        strategy_type="post_receipt_care",
        customer_key=order.customer_key,
        order_id=order.id,
        due_at=(order.signed_at or utcnow()) + timedelta(days=delay_days),
        message_text=text,
        decision={
            "trigger": "order_first_observed_signed",
            "platform_order_id": order.platform_order_id,
            "mark_human_required_after_send": config.get(
                "post_receipt_care_mark_human_required"
            ) is True,
        },
    )


def apply_orders_snapshot(
    db: Session,
    conversation: Conversation,
    payload: dict[str, Any],
    observed_at: datetime | None,
) -> None:
    collection_status = str(payload.get("collection_status") or "unavailable")
    if collection_status not in COLLECTION_STATUSES:
        collection_status = "unavailable"
    observed = observed_at or utcnow()
    customer_key = _customer_key(conversation, payload)
    orders = payload.get("orders") if isinstance(payload.get("orders"), list) else []
    saved_count = 0
    observed_order_ids: set[str] = set()

    if collection_status == "success":
        for item in orders[:100]:
            if not isinstance(item, dict):
                continue
            platform_order_id = str(item.get("platform_order_id") or "").strip()[:128]
            if not platform_order_id:
                continue
            order = db.scalar(select(CustomerOrder).where(
                CustomerOrder.platform_account_id == conversation.platform_account_id,
                CustomerOrder.platform_order_id == platform_order_id,
            ))
            normalized_status = str(item.get("status") or "unknown")
            if normalized_status not in ORDER_STATUSES:
                normalized_status = "unknown"
            if order is None:
                order = CustomerOrder(
                    user_id=conversation.user_id,
                    platform_account_id=conversation.platform_account_id,
                    conversation_id=conversation.id,
                    customer_key=customer_key,
                    platform_order_id=platform_order_id,
                    first_observed_at=observed,
                    last_observed_at=observed,
                )
            order.conversation_id = conversation.id
            order.customer_key = customer_key
            order.status = normalized_status
            order.raw_status = str(item.get("raw_status") or "").strip()[:128]
            order.products_json = item.get("products") if isinstance(item.get("products"), list) else []
            order.order_amount = _amount(item.get("order_amount"))
            order.discount_amount = _amount(item.get("discount_amount"))
            order.paid_amount = _amount(item.get("paid_amount"))
            order.ordered_at = _datetime(item.get("ordered_at"))
            order.paid_at = _datetime(item.get("paid_at"))
            first_signed_observation = normalized_status in {"signed", "completed"} and order.signed_at is None
            if first_signed_observation:
                order.signed_at = _datetime(item.get("signed_at")) or observed
            order.after_sale_json = (
                item.get("after_sale") if isinstance(item.get("after_sale"), dict) else {}
            )
            order.last_observed_at = observed
            order.raw_payload = item
            db.add(order)
            db.flush()
            if first_signed_observation:
                _maybe_create_post_receipt(db, conversation, order)
            observed_order_ids.add(platform_order_id)
            saved_count += 1

    # A successful collection must contain at least one valid order. Treat malformed
    # snapshots as unknown so they can never authorize an outreach message.
    if collection_status == "success" and saved_count == 0:
        collection_status = "unavailable"

    page_summary = payload.get("page_summary") if isinstance(payload.get("page_summary"), dict) else {}
    try:
        total_count = max(saved_count, int(page_summary.get("total_count") or saved_count))
    except (TypeError, ValueError):
        total_count = saved_count
    conversation.metadata_json = {
        **(conversation.metadata_json or {}),
        "customer_orders": {
            "collection_status": collection_status,
            "collection_error": str(payload.get("error") or "")[:128] or None,
            "observed_at": observed.isoformat(),
            "customer_key": customer_key,
            "order_count": total_count,
            "has_more": page_summary.get("has_more") is True,
        },
    }
    db.add(conversation)
    db.flush()
    logger.info(
        "customer orders snapshot applied conversation_id=%s platform_account_id=%s "
        "collection_status=%s received_order_count=%d saved_order_count=%d has_more=%s error=%s",
        conversation.id,
        conversation.platform_account_id,
        collection_status,
        len(orders),
        saved_count,
        page_summary.get("has_more") is True,
        str(payload.get("error") or "")[:128] or None,
    )
    _resolve_rechecking_outreach(
        db,
        conversation,
        collection_status,
        observed_order_ids=observed_order_ids,
        has_more=page_summary.get("has_more") is True,
    )


def _cancel(run: CustomerOutreachRun, reason: str) -> None:
    run.status = "cancelled"
    run.cancel_reason = reason


def _order_has_after_sale(order: CustomerOrder) -> bool:
    if order.status in {"refunding", "refunded", "cancelled"}:
        return True
    text = str((order.after_sale_json or {}).get("text") or "").strip()
    if not text:
        return False
    # “退货包运费” is a normal platform benefit, not an active after-sale case.
    text = text.replace("退货包运费", "")
    return any(
        marker in text
        for marker in ("退款中", "退款成功", "已退款", "退货中", "退货退款", "售后中", "申请售后")
    )


def _resolve_rechecking_outreach(
    db: Session,
    conversation: Conversation,
    collection_status: str,
    *,
    observed_order_ids: set[str],
    has_more: bool,
) -> None:
    runs = list(db.scalars(select(CustomerOutreachRun).where(
        CustomerOutreachRun.conversation_id == conversation.id,
        CustomerOutreachRun.status == "rechecking",
    )).all())
    for run in runs:
        robot = db.get(Robot, run.robot_id)
        config = robot.config_json if robot and isinstance(robot.config_json, dict) else {}
        enabled_key = (
            "order_follow_up_enabled" if run.strategy_type == "order_follow_up"
            else "post_receipt_care_enabled"
        )
        if not robot or config.get(enabled_key) is not True:
            _cancel(run, "strategy_disabled")
            continue
        if conversation.human_required:
            _cancel(run, "human_required")
            continue
        if conversation.awaiting_reply:
            run.status = "scheduled"
            run.due_at = utcnow() + timedelta(minutes=10)
            run.cancel_reason = "new_customer_message"
            continue
        if collection_status == "unavailable":
            run.status = "scheduled"
            run.due_at = utcnow() + timedelta(minutes=10)
            run.cancel_reason = "order_status_unknown"
            continue
        if run.strategy_type == "order_follow_up":
            if collection_status != "empty":
                _cancel(run, "order_created")
                continue
        else:
            order = db.get(CustomerOrder, run.order_id) if run.order_id else None
            if not order:
                _cancel(run, "order_status_unknown")
                continue
            if order.platform_order_id not in observed_order_ids:
                if has_more:
                    run.status = "scheduled"
                    run.due_at = utcnow() + timedelta(minutes=10)
                    run.cancel_reason = "order_not_on_current_page"
                else:
                    _cancel(run, "order_not_observed")
                continue
            if _order_has_after_sale(order):
                _cancel(run, "refund_or_after_sale")
                continue
            if order.status not in {"signed", "completed"}:
                _cancel(run, "order_status_unknown")
                continue
        _queue_outreach_send(db, conversation, run)
        db.add(run)


def _queue_outreach_send(
    db: Session,
    conversation: Conversation,
    run: CustomerOutreachRun,
) -> None:
    from app.services.message_service import create_send_task

    user = db.get(User, run.user_id)
    if user is None:
        _cancel(run, "user_not_found")
        return
    response = create_send_task(
        db,
        user,
        SendMessageRequest(
            conversation_id=conversation.id,
            content=run.message_text,
            platform_code=conversation.platform_code,
        ),
        idempotency_key=f"customer-outreach:{run.id}:text",
        source="customer_outreach",
    )
    run.status = "queued"
    run.message_id = response.message.id
    run.send_task_id = response.task_id
    run.cancel_reason = None
    db.add(run)
    db.commit()


def schedule_due_outreach_rechecks(db: Session, *, limit: int = 50) -> int:
    now = utcnow()
    stale_rechecks = list(db.scalars(select(CustomerOutreachRun).where(
        CustomerOutreachRun.status == "rechecking",
        CustomerOutreachRun.updated_at <= now - timedelta(minutes=15),
    )).all())
    for run in stale_rechecks:
        run.status = "scheduled"
        run.due_at = now
        run.cancel_reason = "recheck_timeout"
        db.add(run)
    if stale_rechecks:
        db.flush()
    runs = list(db.scalars(
        select(CustomerOutreachRun)
        .where(
            CustomerOutreachRun.status == "scheduled",
            CustomerOutreachRun.due_at <= now,
        )
        .order_by(CustomerOutreachRun.due_at)
        .limit(limit)
    ).all())
    created = 0
    for run in runs:
        conversation = db.get(Conversation, run.conversation_id)
        if not conversation or not conversation.platform_account_id:
            _cancel(run, "conversation_not_found")
            db.add(run)
            continue
        existing = db.scalar(select(RpaTask).where(
            RpaTask.idempotency_key == f"customer-outreach-recheck:{run.id}:{run.due_at.isoformat()}",
        ))
        if existing:
            continue
        task = RpaTask(
            user_id=run.user_id,
            platform_account_id=run.platform_account_id,
            conversation_id=run.conversation_id,
            task_type="refresh_customer_orders",
            idempotency_key=f"customer-outreach-recheck:{run.id}:{run.due_at.isoformat()}",
            platform_code=conversation.platform_code,
            payload_json={
                "outreach_run_id": run.id,
                "platform_account_id": run.platform_account_id,
                "external_conversation_id": conversation.external_conversation_id,
                "customer_name": conversation.customer_name or "",
            },
            status="queued",
            priority=-10,
        )
        db.add(task)
        run.status = "rechecking"
        run.cancel_reason = None
        db.add(run)
        created += 1
    created += _schedule_open_order_rechecks(db, now=now, limit=max(0, limit - created))
    db.commit()
    return created


def _schedule_open_order_rechecks(
    db: Session,
    *,
    now: datetime,
    limit: int,
) -> int:
    if limit <= 0:
        return 0
    cutoff = now - timedelta(minutes=30)
    orders = list(db.scalars(
        select(CustomerOrder)
        .where(
            CustomerOrder.status.in_([
                "pending_payment",
                "paid_pending_shipment",
                "shipped_pending_receipt",
            ]),
            CustomerOrder.last_observed_at <= cutoff,
        )
        .order_by(CustomerOrder.last_observed_at)
        .limit(limit * 3)
    ).all())
    created = 0
    seen_conversations: set[str] = set()
    for order in orders:
        if order.conversation_id in seen_conversations or created >= limit:
            continue
        seen_conversations.add(order.conversation_id)
        conversation = db.get(Conversation, order.conversation_id)
        if not conversation or not conversation.platform_account_id:
            continue
        refresh_bucket = int(now.timestamp() // 1800)
        idempotency_key = f"customer-order-refresh:{conversation.id}:{refresh_bucket}"
        if db.scalar(select(RpaTask).where(RpaTask.idempotency_key == idempotency_key)):
            continue
        db.add(RpaTask(
            user_id=conversation.user_id,
            platform_account_id=conversation.platform_account_id,
            conversation_id=conversation.id,
            task_type="refresh_customer_orders",
            idempotency_key=idempotency_key,
            platform_code=conversation.platform_code,
            payload_json={
                "platform_account_id": conversation.platform_account_id,
                "external_conversation_id": conversation.external_conversation_id,
                "customer_name": conversation.customer_name or "",
                "tracking_order_id": order.id,
            },
            status="queued",
            priority=-20,
        ))
        created += 1
    return created


def customer_orders_response(
    db: Session,
    user: User,
    conversation_id: str,
) -> CustomerOrdersResponse:
    conversation = db.get(Conversation, conversation_id)
    if not conversation or conversation.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found")
    summary = (conversation.metadata_json or {}).get("customer_orders")
    if not isinstance(summary, dict):
        summary = {}
    orders = list(db.scalars(
        select(CustomerOrder)
        .where(CustomerOrder.conversation_id == conversation.id)
        .order_by(desc(CustomerOrder.ordered_at), desc(CustomerOrder.last_observed_at))
    ).all())
    outreach = list(db.scalars(
        select(CustomerOutreachRun)
        .where(CustomerOutreachRun.conversation_id == conversation.id)
        .order_by(desc(CustomerOutreachRun.created_at))
    ).all())
    observed_at = _datetime(summary.get("observed_at"))
    collection_status = str(summary.get("collection_status") or "not_collected")
    if collection_status not in {*COLLECTION_STATUSES, "not_collected"}:
        collection_status = "not_collected"
    return CustomerOrdersResponse(
        conversation_id=conversation.id,
        collection_status=collection_status,
        collection_error=str(summary.get("collection_error") or "") or None,
        observed_at=observed_at,
        customer_key=str(summary.get("customer_key") or ""),
        total_count=max(int(summary.get("order_count") or 0), len(orders)),
        has_more=summary.get("has_more") is True,
        orders=[CustomerOrderRead.model_validate(item) for item in orders],
        outreach=[OutreachStatusRead.model_validate(item) for item in outreach],
    )


def order_prompt_context(db: Session, conversation: Conversation) -> dict[str, Any]:
    summary = (conversation.metadata_json or {}).get("customer_orders")
    if not isinstance(summary, dict):
        return {"collection_status": "not_collected", "has_orders": False, "recent_orders": []}
    orders = list(db.scalars(
        select(CustomerOrder)
        .where(CustomerOrder.conversation_id == conversation.id)
        .order_by(desc(CustomerOrder.ordered_at), desc(CustomerOrder.last_observed_at))
        .limit(5)
    ).all())
    normalized = [
        {
            "platform_order_id": item.platform_order_id,
            "status": item.status,
            "raw_status": item.raw_status,
            "ordered_at": item.ordered_at.isoformat() if item.ordered_at else None,
            "products": item.products_json,
            "paid_amount": item.paid_amount,
            "after_sale": item.after_sale_json,
        }
        for item in orders
    ]
    return {
        "collection_status": summary.get("collection_status") or "not_collected",
        "observed_at": summary.get("observed_at"),
        "has_orders": bool(normalized),
        "latest_order": normalized[0] if normalized else None,
        "recent_orders": normalized,
    }
