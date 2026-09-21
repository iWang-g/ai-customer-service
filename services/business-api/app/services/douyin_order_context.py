"""Identity-scoped first-page order evidence and bounded on-demand refresh."""
import asyncio
import re
from datetime import timedelta
from time import monotonic

from fastapi import HTTPException
from sqlalchemy import select

from app.models import CustomerOrder, RpaTask, utcnow
from app.services.douyin_order_service import identity, queue_refresh, SOURCE, COVERAGE
from app.services.qianniu_order_context import freshness, needs_current_state
from app.services.douyin_message_context import order_hint


def prompt_context(db, conversation):
    empty = {'collection_status': 'not_collected', 'has_orders': False, 'orders_known': False,
             'recent_orders': [], 'dynamic_fields_fresh': False, 'query_coverage': COVERAGE,
             'context_truncated': True, 'complete_history': False}
    try:
        shop, buyer, _ = identity(conversation, conversation.platform_account)
    except HTTPException:
        return empty
    summary = (conversation.metadata_json or {}).get('customer_orders') or {}
    if (summary.get('source') != SOURCE or summary.get('shop_id') != shop
            or summary.get('customer_key') != buyer or summary.get('query_coverage') != COVERAGE):
        return empty
    visible = summary.get('visible_order_ids') or []
    rows = db.scalars(select(CustomerOrder).where(CustomerOrder.user_id == conversation.user_id,
        CustomerOrder.platform_account_id == conversation.platform_account_id,
        CustomerOrder.conversation_id == conversation.id, CustomerOrder.customer_key == buyer,
        CustomerOrder.platform_order_id.in_(visible)).limit(5)).all()
    orders = [{'platform_order_id': row.platform_order_id, 'status': row.status,
        'raw_status': row.raw_status, 'ordered_at': row.ordered_at.isoformat() if row.ordered_at else None,
        'products': [{k: p.get(k) for k in ('product_id', 'goods_id', 'sku_order_id', 'sku_id', 'title', 'sku', 'quantity')}
                     for p in row.products_json or []],
        'after_sale': row.after_sale_json} for row in rows]
    return {**empty, **freshness(summary), 'collection_status': summary.get('collection_status'),
        'orders_known': summary.get('collection_status') in {'success', 'empty'},
        'observed_at': summary.get('observed_at'), 'has_orders': bool(orders), 'recent_orders': orders}


async def refresh_before_reply(db, user, conversation, source_message, *, text=None, timeout_seconds=6):
    from app.models import Message
    account = conversation.platform_account
    try:
        identity(conversation, account)
    except HTTPException:
        return {'attempted': False, 'reason': 'conversation_not_refreshable'}
    if conversation.user_id != user.id or account.login_status != 'online' or not account.last_rpa_node_id:
        return {'attempted': False, 'reason': 'conversation_not_refreshable'}
    message = text if text is not None else source_message.content
    if re.search(r'(?:帮我|给我|我要|请).{0,6}(?:退款|退货|改地址|修改地址|定制)|转人工|转客服', message):
        return {'attempted': False, 'reason': 'human_operation'}
    # Include recent customer text so a follow-up such as “现在呢” retains order context.
    history_rows = db.scalars(select(Message).where(Message.conversation_id == conversation.id,
        Message.sender_role == 'customer', Message.conversation_sequence < source_message.conversation_sequence)
        .order_by(Message.conversation_sequence.desc()).limit(2)).all()
    history = [row.content for row in history_rows]
    card_related = order_hint(source_message) or (
        len(message) <= 15 and bool(re.search(r'这单|这笔|现在|那|呢|查一下', message))
        and any(order_hint(row) for row in history_rows))
    related = card_related or needs_current_state(message) or bool(re.search(r'订单|下单|付款|支付|买的是|拍的是|退款进度', message))
    related = related or (len(message) <= 15 and any(needs_current_state(h) for h in history))
    if not related:
        return {'attempted': False, 'reason': 'not_order_question'}
    summary = (conversation.metadata_json or {}).get('customer_orders') or {}
    current = card_related or needs_current_state(message) or (len(message) <= 15 and any(needs_current_state(h) for h in history))
    if not current and prompt_context(db, conversation)['dynamic_fields_fresh']:
        return {'attempted': False, 'reason': 'cached_order_context_fresh'}
    recent = db.scalar(select(RpaTask).where(RpaTask.user_id == user.id,
        RpaTask.platform_account_id == account.id, RpaTask.conversation_id == conversation.id,
        RpaTask.platform_code == 'douyin', RpaTask.task_type == 'refresh_customer_orders',
        RpaTask.requested_at >= utcnow() - timedelta(seconds=60)).order_by(RpaTask.requested_at.desc()).limit(1))
    if recent and recent.status not in {'queued', 'dispatched', 'acknowledged'}:
        return {'attempted': False, 'reason': 'refresh_cooldown', 'current_state_unverified': current}
    previous = summary.get('observed_at')
    task = recent or queue_refresh(db, user, conversation.id)
    deadline = monotonic() + max(0, min(timeout_seconds, 6))
    while monotonic() < deadline:
        await asyncio.sleep(min(0.25, max(0, deadline - monotonic())))
        db.refresh(conversation); db.refresh(task)
        updated = prompt_context(db, conversation)
        if updated.get('observed_at') != previous and updated['dynamic_fields_fresh']:
            return {'attempted': True, 'status': 'collected', 'task_id': task.id}
        if task.status == 'failed':
            break
    return {'attempted': True, 'status': 'failed' if task.status == 'failed' else 'timeout',
            'task_id': task.id, 'current_state_unverified': True}
