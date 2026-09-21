from __future__ import annotations

import asyncio
import copy
import json
import re
from datetime import datetime, timedelta, timezone
from time import monotonic
from typing import Literal

from fastapi import HTTPException
from pydantic import BaseModel, Field, ValidationError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.models import Message, RpaTask, StoreProduct, utcnow
from app.services.product_service import _datetime

SOURCE = 'douyin_product_detail_v1'
FRESH_SECONDS = 300
STATIC_MAX_SECONDS = 30 * 86400


class Option(BaseModel):
    id: str = Field(pattern=r'^\d{1,40}$')
    name: str = Field(min_length=1, max_length=512)


class Dimension(BaseModel):
    name: str = Field(min_length=1, max_length=512)
    options: list[Option] = Field(max_length=300)


class Pair(BaseModel):
    name: str = Field(min_length=1, max_length=512)
    value: str = Field(min_length=1, max_length=512)


class Sku(BaseModel):
    sku_id: str = Field(pattern=r'^\d{1,40}$')
    attributes: list[Pair] = Field(max_length=3)


class Specifications(BaseModel):
    source: Literal['get_skuinfo_list']
    observed_at: str
    response_identity: Literal['explicit_id_matches']
    dimensions: list[Dimension] = Field(max_length=3)
    skus: list[Sku] = Field(max_length=2000)


class Attribute(BaseModel):
    name: str = Field(min_length=1, max_length=512)
    values: list[str] = Field(max_length=20)


class Attributes(BaseModel):
    source: Literal['promotion_pack_detail']
    observed_at: str
    response_identity: Literal['explicit_id_matches', 'jump_url_id_matches', 'not_returned']
    request_association: Literal['matched']
    entries: list[Attribute] = Field(max_length=200)


class Detail(BaseModel):
    source: Literal['douyin_product_detail_v1']
    shop_id: str = Field(min_length=1, max_length=128)
    product_id: str = Field(pattern=r'^\d{1,40}$')
    observed_at: str
    title: str = Field(min_length=1, max_length=1000)
    ownership: Literal['verified_in_current_first_page']
    specifications: Specifications
    attributes: Attributes | None = None


def apply_detail(db, account, payload):
    try:
        detail = Detail.model_validate(payload)
    except ValidationError as exc:
        raise HTTPException(400, 'Invalid Douyin product detail') from exc
    observed = _datetime(detail.observed_at)
    if (account.platform_code != 'douyin' or detail.shop_id != account.external_account_id
            or not observed or observed > utcnow() + timedelta(minutes=1)
            or _datetime(detail.specifications.observed_at) != observed
            or (detail.attributes and _datetime(detail.attributes.observed_at) != observed)):
        raise HTTPException(400, 'Douyin detail account or collection time mismatch')
    specs = detail.specifications
    if (len({s.sku_id for s in specs.skus}) != len(specs.skus)
            or len({d.name for d in specs.dimensions}) != len(specs.dimensions)):
        raise HTTPException(400, 'Duplicate Douyin detail identity')
    for dimension in specs.dimensions:
        if len({o.id for o in dimension.options}) != len(dimension.options):
            raise HTTPException(400, 'Duplicate Douyin option identity')
    for sku in specs.skus:
        if len(sku.attributes) != len(specs.dimensions) or any(
            pair.name != dimension.name or pair.value not in {o.name for o in dimension.options}
            for pair, dimension in zip(sku.attributes, specs.dimensions)
        ):
            raise HTTPException(400, 'Douyin SKU specification mismatch')
    if detail.attributes and any(not value.strip() or len(value) > 2048
                                for item in detail.attributes.entries for value in item.values):
        raise HTTPException(400, 'Invalid Douyin attribute value')
    projected = detail.model_dump()
    if len(json.dumps(projected, ensure_ascii=False)) > 180000:
        raise HTTPException(400, 'Douyin detail too large')
    row = db.scalar(select(StoreProduct).where(StoreProduct.user_id == account.user_id,
        StoreProduct.platform_account_id == account.id, StoreProduct.goods_id == detail.product_id))
    if row is None:
        # This task freshly verified first-page ownership; no prior manual list
        # refresh is required and no full-list metadata is invented here.
        row = StoreProduct(user_id=account.user_id, platform_account_id=account.id,
            goods_id=detail.product_id, platform_product_id=detail.product_id,
            title=detail.title, source=SOURCE, first_observed_at=observed, last_observed_at=observed)
    previous = copy.deepcopy((row.raw_payload or {}).get('douyin_detail') or {})
    if previous.get('shop_id') != detail.shop_id or previous.get('source') != SOURCE:
        previous = {}
    previous_time = _datetime(previous.get('observed_at'))
    spec_newer = not previous_time or previous_time < observed
    previous_attr_time = _datetime((previous.get('attributes') or {}).get('observed_at'))
    attr_newer = detail.attributes is not None and (not previous_attr_time or previous_attr_time < observed)
    if not spec_newer and not attr_newer:
        return False
    new_attributes = projected['attributes']
    if not spec_newer:
        projected = previous
    projected['attributes'] = new_attributes if attr_newer else previous.get('attributes')
    projected['review_status'] = 'unreviewed'
    row.raw_payload = {**(row.raw_payload or {}), 'douyin_detail': projected}
    db.add(row)
    db.flush()
    return True


def saved_detail(db, account, product_id):
    if not account or account.platform_code != 'douyin':
        return {}
    row = db.scalar(select(StoreProduct).where(StoreProduct.user_id == account.user_id,
        StoreProduct.platform_account_id == account.id, StoreProduct.goods_id == product_id))
    saved = copy.deepcopy((row.raw_payload or {}).get('douyin_detail') or {}) if row else {}
    snapshot = (account.metadata_json or {}).get('store_products') or {}
    snapshot_at, detail_at = _datetime(snapshot.get('observed_at')), _datetime(saved.get('observed_at'))
    if (snapshot.get('source') == 'douyin_products_v1' and snapshot_at and detail_at
            and snapshot_at > detail_at and product_id not in snapshot.get('product_ids', [])):
        return {}
    return saved if saved.get('source') == SOURCE and saved.get('shop_id') == account.external_account_id else {}


def consultation_ids(db, conversation, source_message):
    if conversation.platform_code != 'douyin':
        return []
    from app.services.automation_service import _product_context_data
    rows = list(db.scalars(select(Message).where(Message.conversation_id == conversation.id,
        Message.sender_role == 'customer', Message.message_status != 'failed',
        Message.conversation_sequence > (conversation.messages_cleared_sequence or 0),
        Message.conversation_sequence <= source_message.conversation_sequence)
        .order_by(Message.conversation_sequence.desc()).limit(100)))
    def sent_at(row):
        stamp = row.platform_sent_at or row.collected_at
        return stamp.replace(tzinfo=timezone.utc) if stamp and stamp.tzinfo is None else stamp
    rows.sort(key=lambda row: (sent_at(row) or datetime.min.replace(tzinfo=timezone.utc),
                              row.conversation_sequence), reverse=True)
    for row in rows:
        when, source_time = sent_at(row), sent_at(source_message)
        if source_time and when and (when > source_time or source_time - when > timedelta(days=1)):
            continue
        products = _product_context_data(row)
        if products:
            # A newer unrecognized card is still a boundary; do not reuse an old product.
            return list(dict.fromkeys(p['product_id'] for p in products
                if re.fullmatch(r'\d{1,40}', p.get('product_id', ''))))[:3]
    return []


def _usable(source):
    observed = _datetime((source or {}).get('observed_at'))
    return bool(observed and -60 <= (utcnow() - observed).total_seconds() <= STATIC_MAX_SECONDS)


def prompt_details(db, conversation, product_ids, message=''):
    if conversation.platform_code != 'douyin' or not conversation.platform_account \
            or conversation.platform_account.user_id != conversation.user_id:
        return []
    result = []
    for pid in product_ids[:3]:
        saved = saved_detail(db, conversation.platform_account, pid)
        specs, attrs = saved.get('specifications'), saved.get('attributes')
        if not _usable(specs):
            continue
        dimensions, skus = specs['dimensions'], specs['skus']
        entries = attrs['entries'] if _usable(attrs) else []
        if not dimensions and not skus and not entries:
            continue
        terms = set(re.findall(r'[a-zA-Z0-9]+|[\u4e00-\u9fff]{2,}', message.lower()))
        ranked = sorted(enumerate(skus), key=lambda pair: (
            -sum(term in str(pair[1]['attributes']).lower() for term in terms), pair[0]))
        selected = [s for _, s in ranked[:60]]
        result.append({'product_id': pid, 'title': saved['title'], 'source': SOURCE,
            'review_status': 'unreviewed', 'observed_at': specs['observed_at'],
            'specifications_source': specs['source'], 'specifications_identity': specs['response_identity'],
            'dimensions': dimensions, 'skus': selected, 'sku_total': len(skus),
            'skus_truncated': len(skus) > len(selected), 'dynamic_fields_fresh': False,
            'attributes': entries, 'attributes_observed_at': attrs['observed_at'] if _usable(attrs) else None,
            'attributes_source': attrs['source'] if _usable(attrs) else None,
            'attributes_identity': attrs['response_identity'] if _usable(attrs) else None})
    # Drop whole entries, never partial facts; disclose every omission.
    while len(json.dumps(result, ensure_ascii=False)) > 24000:
        largest = max(result, key=lambda item: len(json.dumps(item, ensure_ascii=False)))
        if largest['skus']:
            largest['skus'].pop(); largest['skus_truncated'] = True
        elif largest['attributes']:
            largest['attributes'].pop(); largest['attributes_truncated'] = True
        elif largest['dimensions']:
            largest['dimensions'].pop(); largest['dimensions_truncated'] = True
        else:
            result.remove(largest)
    return result


def queue_refresh(db, user, conversation, product_id):
    account = conversation.platform_account
    if (not account or account.user_id != user.id or conversation.user_id != user.id
            or account.platform_code != 'douyin' or conversation.platform_code != 'douyin'
            or not re.fullmatch(r'\d{1,40}', product_id)):
        raise HTTPException(400, 'Invalid Douyin detail request')
    # One product per task coalesces overlapping requests across conversations,
    # including minute boundaries. Failed requests also get a short cooldown.
    prefix = f'dy-detail:{account.id}:{product_id}:'
    task = db.scalar(select(RpaTask).where(RpaTask.user_id == user.id,
        RpaTask.idempotency_key.startswith(prefix),
        RpaTask.created_at > utcnow() - timedelta(seconds=60))
        .order_by(RpaTask.created_at.desc()).limit(1))
    if task:
        return task
    key = f'{prefix}{int(utcnow().timestamp()) // 60}'
    task = RpaTask(user_id=user.id, platform_account_id=account.id, conversation_id=conversation.id,
        node_id=account.last_rpa_node_id, platform_code='douyin', task_type='refresh_product_details',
        idempotency_key=key, payload_json={'platform_account_id': account.id, 'product_ids': [product_id]},
        status='queued', priority=30)
    try:
        db.add(task); db.commit()
    except IntegrityError:
        db.rollback()
        task = db.scalar(select(RpaTask).where(RpaTask.idempotency_key == key))
    return task


async def ensure_details(db, user, conversation, source_message, *, enabled=True, timeout_seconds=15):
    ids = consultation_ids(db, conversation, source_message)
    status = {'product_ids': ids, 'attempted': False, 'task_ids': []}
    blocking = []
    for pid in ids:
        saved = saved_detail(db, conversation.platform_account, pid)
        sources = [saved.get('specifications'), saved.get('attributes')]
        fresh = all(_datetime((source or {}).get('observed_at')) and
            (utcnow() - _datetime(source['observed_at'])).total_seconds() <= FRESH_SECONDS for source in sources)
        if enabled and not fresh:
            task = queue_refresh(db, user, conversation, pid)
            status['attempted'] = True
            status['task_ids'].append(task.id)
            if not prompt_details(db, conversation, [pid]):
                blocking.append((pid, task.id))
    if not blocking:
        if status['attempted']: status['status'] = 'refresh_queued'
        return status
    status['status'] = 'timeout'
    deadline = monotonic() + max(0, timeout_seconds)
    while monotonic() < deadline:
        await asyncio.sleep(.25)
        db.expire_all()
        if all(prompt_details(db, conversation, [pid]) for pid, _ in blocking):
            status['status'] = 'collected'; break
        if all(db.get(RpaTask, task_id).status in {'completed', 'failed'} for _, task_id in blocking):
            status['status'] = 'partial_or_unavailable'; break
    return status
