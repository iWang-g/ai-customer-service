"""Persisted order context and bounded read-only refreshes for Qianniu."""
from __future__ import annotations

import asyncio
import re
from datetime import datetime, timezone, timedelta
from time import monotonic

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.models import RpaTask, PlatformAccount

TTL_SECONDS = 600
RETRY_SECONDS = 60


def freshness(summary: dict) -> dict:
    age = None
    try:
        stamp = datetime.fromisoformat(str(summary.get("observed_at") or "").replace("Z", "+00:00"))
        if stamp.tzinfo is not None:
            age = (datetime.now(timezone.utc) - stamp).total_seconds()
    except (ValueError, TypeError):
        pass
    return {"age_seconds": max(0, int(age)) if age is not None else None,
            "dynamic_fields_fresh": summary.get("collection_status") in {"success", "empty"}
            and age is not None and 0 <= age < TTL_SECONDS}


def needs_current_state(text: str) -> bool:
    # Generic presale shipping/payment questions should not block on buyer orders.
    return bool(re.search(
        r"刚.{0,5}(下单|付款|支付|退款)|已经.{0,5}(下单|付款|支付|申请退款)|"
        r"(我的|这笔|这单|这个订单|订单).{0,15}(发货|付款|支付|退款|物流|状态|进度)|"
        r"(发货|退款|付款|支付).{0,5}(了吗|了没|成功|到账)|查.{0,8}(订单|物流)|"
        r"(查|更新|最新).{0,8}(发货|退款|订单状态)", text or ""))


async def refresh_before_reply(db, user, conversation, source_message, *, text=None, timeout_seconds=6):
    account = db.get(PlatformAccount, conversation.platform_account_id) if conversation.platform_account_id else None
    if (conversation.user_id != user.id or not account or account.user_id != user.id or account.platform_code != "qianniu"
            or not re.fullmatch(r"\d+\.1-\d+\.1#11001@cntaobao", conversation.external_conversation_id or "")):
        return {"attempted": False, "reason": "conversation_not_refreshable"}
    summary = (conversation.metadata_json or {}).get("customer_orders") or {}
    previous = summary.get("observed_at")
    blocking = needs_current_state(text if text is not None else source_message.content)
    if not blocking and freshness(summary)["dynamic_fields_fresh"]:
        return {"attempted": False, "reason": "cached_order_context_fresh", "blocking": False}
    now = datetime.now(timezone.utc)
    scope = (RpaTask.user_id == user.id, RpaTask.platform_code == "qianniu",
             RpaTask.conversation_id == conversation.id, RpaTask.platform_account_id == account.id,
             RpaTask.task_type == "refresh_customer_orders")
    # Share an in-flight refresh, and throttle repeated failures as well as successes.
    task = db.scalar(select(RpaTask).where(*scope,
        RpaTask.status.in_(["queued", "dispatched", "acknowledged"]),
        RpaTask.requested_at >= now - timedelta(seconds=120)).order_by(RpaTask.requested_at.desc()).limit(1))
    if task is None:
        recent = db.scalar(select(RpaTask).where(*scope,
            RpaTask.requested_at >= now - timedelta(seconds=RETRY_SECONDS)).order_by(RpaTask.requested_at.desc()).limit(1))
        if recent:
            return {"attempted": False, "reason": "refresh_cooldown", "task_id": recent.id, "blocking": False,
                    "current_state_unverified": blocking}
        key = f"qn-order-context:{conversation.id}:{int(now.timestamp()) // RETRY_SECONDS}"
        task = RpaTask(user_id=user.id, platform_account_id=account.id, conversation_id=conversation.id,
            platform_code="qianniu", task_type="refresh_customer_orders", idempotency_key=key,
            payload_json={"platform_account_id": account.id, "external_conversation_id": conversation.external_conversation_id,
                          "customer_name": conversation.customer_name or "", "source": "auto_reply_order_context",
                          "source_message_id": source_message.id}, status="queued", priority=20 if blocking else -20)
        try:
            db.add(task)
            db.commit()
        except IntegrityError:
            db.rollback()
            task = db.scalar(select(RpaTask).where(RpaTask.idempotency_key == key))
    result = {"attempted": True, "status": "queued", "task_id": task.id if task else None, "blocking": blocking}
    if not blocking:
        return result
    if task and task.status == 'queued' and task.priority < 20:
        task.priority = 20
        db.commit()
    deadline = monotonic() + max(0, min(timeout_seconds, 6))
    while monotonic() < deadline:
        await asyncio.sleep(min(0.25, max(0, deadline - monotonic())))
        db.refresh(conversation)
        current = (conversation.metadata_json or {}).get("customer_orders") or {}
        if current.get("observed_at") != previous and freshness(current)["dynamic_fields_fresh"]:
            return {**result, "status": "collected"}
        if task:
            db.refresh(task)
            if task.status in {"failed", "cancelled"}:
                return {**result, "status": task.status, "current_state_unverified": True}
    return {**result, "status": "timeout", "current_state_unverified": True}
