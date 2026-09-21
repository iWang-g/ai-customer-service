from __future__ import annotations

import asyncio
import copy
import json
import re
from datetime import datetime, timedelta, timezone
from time import monotonic

from fastapi import HTTPException
from pydantic import BaseModel, Field, ValidationError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.models import StoreProduct, RpaTask, Message, utcnow
from app.services.product_service import _datetime

SOURCE = 'qianniu_product_detail_v1'
OWNERSHIP_SOURCE = 'qianniu_material_item_v1'
FRESH_SECONDS = 300
STATIC_CONTEXT_MAX_AGE_SECONDS = 30 * 24 * 60 * 60
DETAIL_REFRESH_TIMEOUT_SECONDS = 15


class Attribute(BaseModel):
    raw: str = Field(max_length=4096)
    parsed: bool
    propertyId: str | None = Field(default=None, max_length=64)
    valueId: str | None = Field(default=None, max_length=64)
    name: str | None = Field(default=None, max_length=256)
    value: str | None = Field(default=None, max_length=2048)


class Sku(BaseModel):
    skuId: str = Field(pattern=r'^\d{1,30}$')
    price: str | None = Field(default=None, pattern=r'^\d{1,12}(?:\.\d{1,4})?$')
    quantity: int | None = Field(default=None, ge=0, strict=True)
    propertiesRaw: str | None = Field(default=None, max_length=8192)
    propertiesNameRaw: str | None = Field(default=None, max_length=8192)
    attributes: list[Attribute] = Field(default_factory=list, max_length=100)


class Service(BaseModel):
    name: str | None = Field(default=None, max_length=512)
    description: str | None = Field(default=None, max_length=4096)


class Detail(BaseModel):
    productId: str = Field(pattern=r'^\d{1,30}$')
    title: str = Field(min_length=1, max_length=1000)
    categoryId: str | None = Field(default=None, pattern=r'^\d{1,30}$')
    price: str | None = Field(default=None, pattern=r'^\d{1,12}(?:\.\d{1,4})?$')
    quantity: int | None = Field(default=None, ge=0, strict=True)
    approveStatus: str | None = Field(default=None, max_length=64)
    propertiesRaw: str | None = Field(default=None, max_length=65536)
    propertiesNameRaw: str | None = Field(default=None, max_length=65536)
    propertiesAliasRaw: str | None = Field(default=None, max_length=65536)
    attributes: list[Attribute] = Field(default_factory=list, max_length=200)
    skus: list[Sku] = Field(max_length=2000)
    services: list[Service] = Field(default_factory=list, max_length=100)
    servicesPresent: bool = False


class Ownership(BaseModel):
    source: str = Field(pattern=r'^qianniu_material_item_v1$')
    product_id: str = Field(pattern=r'^\d{1,30}$')
    seller_uid: str = Field(pattern=r'^\d{1,30}$')
    title: str = Field(min_length=1, max_length=1000)
    image_url: str | None = Field(default=None, max_length=8192)
    link_url: str | None = Field(default=None, max_length=8192)
    price: str | None = Field(default=None, pattern=r'^\d{1,12}(?:\.\d{1,4})?$')
    quantity: int | None = Field(default=None, ge=0, strict=True)
    has_sku: bool


def account_uid(account):
    local_uid = str(account.local_account_id or '').removeprefix('qianniu-')
    uid = str((account.metadata_json or {}).get('shop_uid') or local_uid)
    if account.platform_code != 'qianniu' or not uid.isdigit() or (local_uid.isdigit() and local_uid != uid):
        raise HTTPException(400, 'Invalid Qianniu product account')
    return uid


def product_row(db, account, product_id):
    if not isinstance(product_id, str) or not re.fullmatch(r'\d{1,30}', product_id):
        raise HTTPException(400, 'Invalid product ID')
    account_uid(account)
    row = db.scalar(select(StoreProduct).where(StoreProduct.user_id == account.user_id,
        StoreProduct.platform_account_id == account.id, StoreProduct.goods_id == product_id))
    # A complete shop-list snapshot or a targeted seller-ID check supplies ownership.
    ids = ((account.metadata_json or {}).get('store_products') or {}).get('product_ids', [])
    ownership = (row.raw_payload or {}).get('qianniu_ownership') if row is not None else None
    main_uid = str((account.metadata_json or {}).get('main_account_uid') or '')
    targeted = (isinstance(ownership, dict) and ownership.get('source') == OWNERSHIP_SOURCE
        and ownership.get('product_id') == product_id and ownership.get('seller_uid') == main_uid
        and main_uid.isdigit())
    if row is None or (product_id not in ids and not targeted):
        raise HTTPException(404, 'Product is not in the saved Qianniu shop list')
    return row


def _bootstrap_verified_product(db, account, payload, observed, product_id):
    try:
        ownership = Ownership.model_validate(payload.get('ownership'))
    except ValidationError as exc:
        raise HTTPException(400, 'Qianniu product ownership is not verified') from exc
    main_uid = str((account.metadata_json or {}).get('main_account_uid') or '')
    if (not main_uid.isdigit() or ownership.product_id != product_id or ownership.seller_uid != main_uid
            or str(payload.get('seller_uid') or '') != main_uid):
        raise HTTPException(400, 'Qianniu product ownership mismatch')
    row = db.scalar(select(StoreProduct).where(StoreProduct.user_id == account.user_id,
        StoreProduct.platform_account_id == account.id, StoreProduct.goods_id == product_id))
    if row is None:
        row = StoreProduct(user_id=account.user_id, platform_account_id=account.id,
            goods_id=product_id, platform_product_id=product_id, first_observed_at=observed)
    row.platform_product_id = product_id
    row.title = ownership.title
    row.image_url = ownership.image_url
    row.link_url = ownership.link_url
    row.price = float(ownership.price) if ownership.price is not None else None
    row.price_label = f'¥{ownership.price}' if ownership.price is not None else None
    row.quantity = ownership.quantity
    row.source = OWNERSHIP_SOURCE
    row.last_observed_at = observed
    row.raw_payload = {**(row.raw_payload or {}), 'qianniu_ownership': ownership.model_dump()}
    db.add(row)
    db.flush()
    return row


def apply_detail(db, account, payload):
    if payload.get('source') != SOURCE or payload.get('shop_uid') != account_uid(account):
        raise HTTPException(400, 'Qianniu product detail account mismatch')
    observed = _datetime(payload.get('observed_at'))
    if observed is None or observed > utcnow() + timedelta(minutes=1):
        raise HTTPException(400, 'Invalid detail collection time')
    try:
        detail = Detail.model_validate(payload.get('detail'))
    except ValidationError as exc:
        raise HTTPException(400, 'Invalid Qianniu product detail') from exc
    if detail.productId != payload.get('product_id') or len({s.skuId for s in detail.skus}) != len(detail.skus):
        raise HTTPException(400, 'Qianniu product or SKU identity mismatch')
    try:
        row = product_row(db, account, detail.productId)
    except HTTPException as exc:
        if exc.status_code != 404:
            raise
        row = _bootstrap_verified_product(db, account, payload, observed, detail.productId)
    previous = (row.raw_payload or {}).get('qianniu_detail') or {}
    previous_at = _datetime(previous.get('observed_at'))
    if previous_at and previous_at >= observed:
        return False
    # Keep details separate from list collection time and never store buyer tokens.
    row.raw_payload = {**(row.raw_payload or {}), 'qianniu_detail': {
        'source': SOURCE, 'observed_at': observed.astimezone(timezone.utc).isoformat(),
        'review_status': 'unreviewed', 'detail': detail.model_dump(),
    }}
    db.add(row)
    db.flush()
    return True


def saved_detail(db, account, product_id):
    return copy.deepcopy((product_row(db, account, product_id).raw_payload or {}).get('qianniu_detail') or {})


def queue_refresh(db, user, conversation, product_ids, *, structured_product_ids=()):
    account = conversation.platform_account
    if not account or account.user_id != user.id or conversation.user_id != user.id or conversation.platform_code != 'qianniu':
        raise HTTPException(404, 'Qianniu conversation not found')
    ids = list(dict.fromkeys(product_ids))
    if not ids or len(ids) > 3:
        raise HTTPException(400, 'Request one to three products')
    trusted = set(structured_product_ids)
    ownership_verified = []
    for pid in ids:
        try:
            product_row(db, account, pid)
            ownership_verified.append(pid)
        except HTTPException as exc:
            if exc.status_code != 404 or pid not in trusted:
                raise
    # Coalesce the same shop/product set within one minute, including failures.
    key = f'qn-detail:{account.id}:{",".join(sorted(ids))}:{int(utcnow().timestamp()) // 60}'
    task = db.scalar(select(RpaTask).where(RpaTask.idempotency_key == key))
    if task is None:
        task = RpaTask(user_id=user.id, platform_account_id=account.id, conversation_id=conversation.id,
            node_id=account.last_rpa_node_id,
            platform_code='qianniu', task_type='refresh_product_details', idempotency_key=key,
            payload_json={'platform_account_id': account.id, 'external_conversation_id': conversation.external_conversation_id,
                'product_ids': ids, 'ownership_verified_product_ids': ownership_verified}, status='queued', priority=30)
        try:
            db.add(task); db.commit()
        except IntegrityError:
            db.rollback()
            task = db.scalar(select(RpaTask).where(RpaTask.idempotency_key == key))
    return task


def consultation_ids(db, conversation, source_message):
    if conversation.platform_code != 'qianniu':
        return []
    from app.services.automation_service import _product_context_data
    clear_sequence = conversation.messages_cleared_sequence or 0
    rows = list(db.scalars(select(Message).where(Message.conversation_id == conversation.id,
        Message.sender_role == 'customer', Message.message_status != 'failed',
        Message.conversation_sequence > clear_sequence,
        Message.conversation_sequence <= source_message.conversation_sequence)
        .order_by(Message.conversation_sequence.desc()).limit(100)))
    # Late history imports must not replace a newer product card in the conversation.
    def message_time(message):
        value = message.platform_sent_at or message.collected_at
        # SQLite drops tzinfo; message timestamps in this table are stored in UTC.
        return value.replace(tzinfo=timezone.utc) if value is not None and value.tzinfo is None else value
    rows.sort(key=lambda m: (message_time(m) or datetime.min.replace(tzinfo=timezone.utc),
                            m.conversation_sequence), reverse=True)
    source_time = message_time(source_message)
    for row in rows:
        row_time = message_time(row)
        if source_time and row_time and (row_time > source_time or source_time - row_time > timedelta(days=1)):
            continue
        products = _product_context_data(row)
        if products:
            return list(dict.fromkeys(p['product_id'] for p in products if re.fullmatch(r'\d{1,30}', p.get('product_id', ''))))[:3]
    return []


def prompt_details(db, conversation, product_ids, message=''):
    if conversation.platform_code != 'qianniu':
        return []
    result = []
    for pid in product_ids[:3]:
        try:
            saved = saved_detail(db, conversation.platform_account, pid)
        except HTTPException:
            continue
        observed = _datetime(saved.get('observed_at'))
        if (not observed or (utcnow() - observed).total_seconds() > STATIC_CONTEXT_MAX_AGE_SECONDS
                or saved.get('source') != SOURCE):
            continue
        detail = saved.get('detail') or {}
        dynamic_fresh = (utcnow() - observed).total_seconds() <= FRESH_SECONDS
        skus = detail.get('skus', [])
        # Keep only relevant options when large, and always disclose truncation.
        terms = set(re.findall(r'[a-zA-Z0-9]+|[\u4e00-\u9fff]{2,}', message.lower()))
        ranked = sorted(enumerate(skus), key=lambda pair: (-sum(t in (pair[1].get('propertiesNameRaw') or '').lower() for t in terms), pair[0]))
        selected = [s for _, s in ranked[:60]]
        def project_sku(s):
            item = {'sku_id': s['skuId'], 'specification': s.get('propertiesNameRaw'),
                    'attributes': [{k: a.get(k) for k in ('name', 'value')} for a in s.get('attributes', []) if a.get('parsed')]}
            if dynamic_fresh:
                item.update(price=s.get('price'), quantity=s.get('quantity'))
            return item
        result.append({'product_id': pid, 'title': detail.get('title'), 'observed_at': saved['observed_at'],
            'source': SOURCE, 'review_status': 'unreviewed', 'dynamic_fields_fresh': dynamic_fresh,
            'attributes': [{k: a.get(k) for k in ('name', 'value')} for a in detail.get('attributes', []) if a.get('parsed')],
            'skus': [project_sku(s) for s in selected], 'sku_total': len(skus), 'skus_truncated': len(skus) > len(selected),
            'services': detail.get('services', []), 'services_present': detail.get('servicesPresent', False)})
    # Bound prompt size; remove whole SKU entries, never truncate a service condition.
    while len(json.dumps(result, ensure_ascii=False)) > 24000:
        largest = max(result, key=lambda x: len(x['skus']), default=None)
        if not largest or not largest['skus']:
            return []
        largest['skus'].pop(); largest['skus_truncated'] = True
    return result


async def ensure_details(db, user, conversation, source_message, *, enabled=True,
                         timeout_seconds=DETAIL_REFRESH_TIMEOUT_SECONDS):
    ids = consultation_ids(db, conversation, source_message)
    blocking = []
    refresh = []
    for pid in ids:
        try:
            saved = saved_detail(db, conversation.platform_account, pid)
        except HTTPException:
            blocking.append(pid)
            refresh.append(pid)
            continue
        observed = _datetime(saved.get('observed_at'))
        age = (utcnow() - observed).total_seconds() if observed else None
        if not observed or saved.get('source') != SOURCE or age > STATIC_CONTEXT_MAX_AGE_SECONDS:
            blocking.append(pid)
            refresh.append(pid)
        elif age > FRESH_SECONDS:
            refresh.append(pid)
    status = {'product_ids': ids, 'attempted': False}
    if not refresh or not enabled:
        return status
    task = queue_refresh(db, user, conversation, refresh, structured_product_ids=ids)
    status.update(attempted=True, task_id=task.id,
                  status='refresh_queued' if not blocking else 'timeout')
    if not blocking:
        return status
    deadline = monotonic() + max(0, timeout_seconds)
    while monotonic() < deadline:
        await asyncio.sleep(.25)
        db.expire_all()
        fresh = []
        for pid in blocking:
            try:
                value = _datetime(saved_detail(db, conversation.platform_account, pid).get('observed_at'))
            except HTTPException:
                value = None
            fresh.append((value or datetime.min.replace(tzinfo=timezone.utc))
                > utcnow() - timedelta(seconds=FRESH_SECONDS))
        if all(fresh):
            status['status'] = 'collected'; break
        if task.status == 'failed':
            status['status'] = 'failed'; break
    return status
