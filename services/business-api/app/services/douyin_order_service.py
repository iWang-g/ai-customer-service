from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Literal
from uuid import uuid4
from urllib.parse import urlsplit

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator
from sqlalchemy import select

from app.models import Conversation, CustomerOrder, PlatformAccount, RpaTask, utcnow

SOURCE = 'douyin_orders_v1'
COVERAGE = 'first_page_only_unknown_total_and_sort'
FAILURE = '订单读取失败，请确认飞鸽已登录且已采集到该客户消息；可使用订单探测检查'


def _datetime(value):
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return parsed if parsed.tzinfo else None
    except (ValueError, TypeError, AttributeError):
        return None


class Record(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)


class Product(Record):
    product_id: str = Field(pattern=r'^\d{1,40}$')
    sku_order_id: str = Field(pattern=r'^\d{1,40}$')
    sku_id: str = Field(pattern=r'^(?:\d{1,40})?$')
    title: str = Field(max_length=1000)
    sku: str = Field(max_length=1000)
    quantity: int | None = Field(ge=1, le=1000000)
    image_url: str = Field(max_length=2048)

    @field_validator('image_url')
    @classmethod
    def valid_image(cls, value):
        if value:
            url = urlsplit(value)
            if url.scheme != 'https' or not url.hostname or url.username or url.password:
                raise ValueError('Invalid order image')
        return value


class Order(Record):
    platform_order_id: str = Field(pattern=r'^\d{1,40}$')
    shop_id: str = Field(pattern=r'^\d{1,40}$')
    buyer_id: str = Field(min_length=1, max_length=256)
    raw_status: str = Field(max_length=128)
    ordered_at: str | None
    after_sale_description: str = Field(max_length=512)
    products: list[Product] = Field(max_length=20)


class Snapshot(Record):
    source: Literal['douyin_orders_v1']
    shop_id: str = Field(pattern=r'^\d{1,40}$')
    buyer_id: str = Field(min_length=1, max_length=256)
    conversation_id: str = Field(max_length=350)
    request_association: Literal['matched']
    observed_at: str
    query_coverage: Literal['first_page_only_unknown_total_and_sort']
    orders: list[Order] = Field(max_length=5)


def identity(conversation, account):
    if (not account or account.user_id != conversation.user_id or account.platform_code != 'douyin'
            or conversation.platform_code != 'douyin' or account.id != conversation.platform_account_id):
        raise HTTPException(400, 'Douyin order account mismatch')
    shop = account.external_account_id
    cid = conversation.external_conversation_id or ''
    suffix = f':{shop}::2:1:pigeon'
    buyer = cid[:-len(suffix)] if cid.endswith(suffix) else ''
    if not re.fullmatch(r'\d{1,40}', shop or '') or not re.fullmatch(r'[^\s:\x00-\x1f\x7f]{1,256}', buyer):
        raise HTTPException(400, 'Douyin order conversation mismatch')
    return shop, buyer, cid


def queue_refresh(db, user, conversation_id):
    conversation = db.get(Conversation, conversation_id)
    if not conversation or conversation.user_id != user.id or conversation.deleted_at:
        raise HTTPException(404, 'Conversation not found')
    account = db.get(PlatformAccount, conversation.platform_account_id)
    shop, _, cid = identity(conversation, account)
    task = db.scalar(select(RpaTask).where(RpaTask.user_id == user.id,
        RpaTask.conversation_id == conversation.id, RpaTask.platform_account_id == account.id,
        RpaTask.platform_code == 'douyin', RpaTask.task_type == 'refresh_customer_orders',
        RpaTask.status.in_(['queued', 'dispatched', 'acknowledged']),
        RpaTask.requested_at > utcnow() - timedelta(seconds=30)).order_by(RpaTask.requested_at.desc()).limit(1))
    if task:
        return task
    task = RpaTask(user_id=user.id, platform_account_id=account.id, conversation_id=conversation.id,
        node_id=account.last_rpa_node_id, platform_code='douyin', task_type='refresh_customer_orders',
        idempotency_key=f'dy-orders:{uuid4()}', priority=30, status='queued', payload_json={
            'source': SOURCE, 'platform_account_id': account.id, 'shop_id': shop,
            'external_conversation_id': cid})
    db.add(task); db.commit(); db.refresh(task)
    return task


def complete_orders(db, task, request):
    if task.status in {'completed', 'failed'}:
        return task
    if request.status not in {'completed', 'failed'}:
        raise HTTPException(400, 'Invalid order collection status')
    conversation = db.get(Conversation, task.conversation_id)
    account = db.get(PlatformAccount, task.platform_account_id)
    if not conversation or conversation.user_id != task.user_id or conversation.deleted_at:
        raise HTTPException(400, 'Order task conversation mismatch')
    shop, buyer, cid = identity(conversation, account)
    expected = task.payload_json or {}
    if (expected.get('source') != SOURCE or expected.get('shop_id') != shop
            or expected.get('platform_account_id') != account.id or expected.get('external_conversation_id') != cid):
        raise HTTPException(400, 'Order task identity mismatch')
    previous = (conversation.metadata_json or {}).get('customer_orders') or {}
    if previous.get('shop_id') != shop or previous.get('customer_key') != buyer or previous.get('source') != SOURCE:
        previous = {}
    started = _datetime(task.requested_at)
    last_started = _datetime(previous.get('last_attempt_started_at'))
    stale = bool(last_started and started < last_started)
    saved_count = 0
    snapshot = None
    rows = []
    if request.status == 'completed':
        try:
            snapshot = Snapshot.model_validate(request.result_json.get('orders_snapshot'))
        except ValidationError as exc:
            raise HTTPException(400, 'Invalid Douyin orders snapshot') from exc
        observed = _datetime(snapshot.observed_at)
        if (snapshot.shop_id != shop or snapshot.buyer_id != buyer or snapshot.conversation_id != cid
                or not observed or observed > utcnow() + timedelta(minutes=1)
                or observed < started - timedelta(minutes=1)):
            raise HTTPException(400, 'Order snapshot identity or time mismatch')
        ids = [order.platform_order_id for order in snapshot.orders]
        if len(set(ids)) != len(ids):
            raise HTTPException(400, 'Duplicate order ID')
        for order in snapshot.orders:
            if order.shop_id != shop or order.buyer_id != buyer:
                raise HTTPException(400, 'Returned order identity mismatch')
            sku_ids = [p.sku_order_id for p in order.products]
            ordered_at = _datetime(order.ordered_at)
            if len(sku_ids) != len(set(sku_ids)) or (order.ordered_at and (
                    not ordered_at or not 2000 <= ordered_at.year <= 2100)):
                raise HTTPException(400, 'Invalid order SKU or time')
            row = db.scalar(select(CustomerOrder).where(CustomerOrder.platform_account_id == account.id,
                CustomerOrder.platform_order_id == order.platform_order_id))
            if row and (row.user_id != task.user_id or row.conversation_id != conversation.id
                        or row.customer_key != buyer):
                raise HTTPException(400, 'Order already belongs to another customer')
            rows.append((order, row, ordered_at))
        # Validate every order before writing anything. An older task cannot
        # replace a newer attempt, including a successful empty result.
        if not stale:
            for order, row, ordered_at in rows:
                if row is None:
                    row = CustomerOrder(user_id=task.user_id, platform_account_id=account.id,
                        conversation_id=conversation.id, customer_key=buyer,
                        platform_order_id=order.platform_order_id, first_observed_at=observed)
                row.status = {'待支付': 'pending_payment', '已关闭': 'cancelled'}.get(order.raw_status, 'unknown')
                row.raw_status = order.raw_status
                row.goods_id = order.products[0].product_id if order.products else ''
                row.products_json = [{**p.model_dump(), 'goods_id': p.product_id,
                                      'sub_order_id': p.sku_order_id} for p in order.products]
                row.ordered_at = ordered_at
                row.paid_at = row.signed_at = None
                row.order_amount = row.paid_amount = row.discount_amount = None
                row.after_sale_json = {'text': order.after_sale_description}
                row.raw_payload = {'source': SOURCE, 'response_identity': 'explicit_shop_and_buyer_matches'}
                row.last_observed_at = observed
                db.add(row)
                saved_count += 1
    if not stale:
        summary = {**previous, 'source': SOURCE, 'shop_id': shop, 'query_coverage': COVERAGE,
            'last_attempt_task_id': task.id, 'last_attempt_started_at': started.isoformat(),
            'last_attempt_at': utcnow().isoformat(), 'customer_key': buyer,
            'collection_status': ('success' if snapshot.orders else 'empty') if snapshot else 'unavailable',
            'collection_error': None if snapshot else FAILURE}
        if snapshot:
            summary.update(observed_at=snapshot.observed_at, order_count=len(snapshot.orders), has_more=False,
                           visible_order_ids=[o.platform_order_id for o in snapshot.orders])
        conversation.metadata_json = {**(conversation.metadata_json or {}), 'customer_orders': summary}
        db.add(conversation)
    task.status = request.status
    task.result_json = {'orders_saved': saved_count, 'discarded_stale': stale}
    task.error_message = FAILURE if request.status == 'failed' else None
    task.completed_at = utcnow()
    db.add(task); db.commit(); db.refresh(task)
    return task
