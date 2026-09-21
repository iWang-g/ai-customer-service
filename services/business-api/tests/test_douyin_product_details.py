import copy
import unittest
from datetime import timedelta
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.models import Base, User, PlatformAccount, Conversation, StoreProduct, RpaTask, Message, utcnow
from app.schemas.rpa import TaskCompleteRequest
from app.services.rpa_service import acknowledge_task, complete_task
from app.services.product_service import apply_store_products_snapshot
from app.services.douyin_product_detail_service import (
    apply_detail, saved_detail, prompt_details, consultation_ids, queue_refresh, ensure_details,
)


def detail_payload(pid='1', observed=None):
    timestamp = (observed or utcnow()).isoformat()
    return {'source': 'douyin_product_detail_v1', 'shop_id': '123', 'product_id': pid,
        'observed_at': timestamp, 'title': '角色键帽', 'ownership': 'verified_in_current_first_page',
        'specifications': {'source': 'get_skuinfo_list', 'observed_at': timestamp,
            'response_identity': 'explicit_id_matches', 'dimensions': [
                {'name': '角色', 'options': [{'id': '21', 'name': '白厄'}]}],
            'skus': [{'sku_id': '31', 'attributes': [{'name': '角色', 'value': '白厄'}]}]},
        'attributes': {'source': 'promotion_pack_detail', 'observed_at': timestamp,
            'response_identity': 'not_returned', 'request_association': 'matched',
            'entries': [{'name': '材质', 'values': ['PBT']}]}}


class DouyinProductDetailTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.engine = create_engine('sqlite:///:memory:')
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.user = User(username='detail', display_name='Detail', password_hash='unused')
        self.db.add(self.user); self.db.flush()
        self.account = PlatformAccount(user_id=self.user.id, platform_code='douyin', platform_name='抖店',
            external_account_id='123', account_name='shop')
        self.db.add(self.account); self.db.flush()
        self.conversations = [Conversation(user_id=self.user.id, platform_account_id=self.account.id,
            platform_code='douyin', external_conversation_id=str(i)) for i in range(2)]
        self.db.add_all(self.conversations); self.db.commit()

    def tearDown(self):
        self.db.close(); self.engine.dispose()

    def message(self, sequence, pid=None, *, age=0):
        message = Message(user_id=self.user.id, conversation_id=self.conversations[0].id,
            platform_code='douyin', sender_role='customer',
            content='[商品]' if pid else '是什么材质', conversation_sequence=sequence, message_status='sent',
            platform_sent_at=utcnow() - timedelta(seconds=age), collected_at=utcnow(), raw_payload={
                'message_type': 'product' if pid else 'text',
                'structured_payload': {'product_id': pid, 'title': '买家标题'} if pid else {}})
        self.db.add(message); self.db.commit()
        return message

    def test_task_persists_without_manual_list_refresh_and_does_not_create_messages(self):
        task = queue_refresh(self.db, self.user, self.conversations[0], '1')
        acknowledge_task(self.db, task)
        self.assertEqual(task.status, 'acknowledged')
        payload = detail_payload(); payload['cookie'] = 'secret'
        payload['specifications']['skus'][0]['price'] = 99
        complete_task(self.db, task, TaskCompleteRequest(status='completed', result_json={'product_details': [payload]}))
        self.assertEqual(task.status, 'completed')
        self.assertNotIn('secret', str(task.result_json))
        self.assertEqual(self.db.query(Message).count(), 0)
        self.assertEqual(self.db.query(RpaTask).count(), 1)
        self.assertNotIn('store_products', self.account.metadata_json or {})
        with Session(self.engine) as reopened:
            value = saved_detail(reopened, reopened.get(PlatformAccount, self.account.id), '1')
            self.assertEqual(value['attributes']['response_identity'], 'not_returned')
            self.assertEqual(value['review_status'], 'unreviewed')
            self.assertNotIn('price', str(value)); self.assertNotIn('secret', str(value))
        self.assertEqual(prompt_details(self.db, self.conversations[0], ['1']),
                         prompt_details(self.db, self.conversations[1], ['1']))

    def test_invalid_or_wrong_task_shop_product_and_sku_cannot_write(self):
        for mutate in [lambda p: p.update(shop_id='456'), lambda p: p.update(ownership='unverified'),
                       lambda p: p['specifications'].update(response_identity='not_returned'),
                       lambda p: p['attributes'].update(response_identity='conflict'),
                       lambda p: p['specifications']['skus'][0]['attributes'][0].update(value='invented')]:
            payload = detail_payload(); mutate(payload)
            with self.assertRaises(HTTPException): apply_detail(self.db, self.account, payload)
            self.db.rollback()
        task = queue_refresh(self.db, self.user, self.conversations[0], '2')
        with self.assertRaises(HTTPException):
            complete_task(self.db, task, TaskCompleteRequest(status='completed', result_json={'product_details': [detail_payload()]}))
        self.db.rollback()
        self.assertEqual(self.db.query(StoreProduct).count(), 0)

    def test_partial_refresh_keeps_attribute_timestamp_and_stale_result_cannot_revert(self):
        old = detail_payload(observed=utcnow() - timedelta(minutes=6))
        apply_detail(self.db, self.account, old); self.db.commit()
        fresh = detail_payload(); fresh['attributes'] = None
        apply_detail(self.db, self.account, fresh); self.db.commit()
        self.assertFalse(apply_detail(self.db, self.account, old))
        saved = saved_detail(self.db, self.account, '1')
        self.assertEqual(saved['attributes']['observed_at'], old['observed_at'])
        self.assertEqual(saved['specifications']['observed_at'], fresh['observed_at'])
        prompt = prompt_details(self.db, self.conversations[0], ['1'])[0]
        self.assertEqual(prompt['attributes_observed_at'], old['observed_at'])
        self.assertFalse(prompt['dynamic_fields_fresh'])
        # A delayed successful attribute response may be newer than the old
        # attribute cache, even when a later specs-only response arrived first.
        middle = detail_payload(observed=utcnow() - timedelta(minutes=3))
        self.assertTrue(apply_detail(self.db, self.account, middle))
        self.db.commit()
        saved = saved_detail(self.db, self.account, '1')
        self.assertEqual(saved['attributes']['observed_at'], middle['observed_at'])
        self.assertEqual(saved['specifications']['observed_at'], fresh['observed_at'])

    def test_list_refresh_preserves_details_and_other_shop_cannot_reuse(self):
        apply_detail(self.db, self.account, detail_payload()); self.db.commit()
        original = saved_detail(self.db, self.account, '1')
        apply_store_products_snapshot(self.db, self.account, {
            'source': 'douyin_products_v1', 'shop_id': '123', 'observed_at': utcnow().isoformat(),
            'collection_status': 'success', 'products': [{'product_id': '1', 'goods_id': '1', 'title': 'list title'}],
            'page_summary': {'page_no': 0, 'page_size': 20, 'total_count': 1, 'has_more': False}}, None)
        self.db.commit()
        self.assertEqual(saved_detail(self.db, self.account, '1'), original)
        other = PlatformAccount(user_id=self.user.id, platform_code='douyin', platform_name='抖店', external_account_id='456', account_name='other')
        self.db.add(other); self.db.commit()
        self.assertEqual(saved_detail(self.db, other, '1'), {})
        self.account.external_account_id = '789'
        self.assertEqual(saved_detail(self.db, self.account, '1'), {})

    def test_newer_list_removal_invalidates_cached_ownership(self):
        apply_detail(self.db, self.account, detail_payload()); self.db.commit()
        self.account.metadata_json = {'store_products': {'source': 'douyin_products_v1',
            'observed_at': utcnow().isoformat(), 'product_ids': []}}
        self.db.commit()
        self.assertEqual(prompt_details(self.db, self.conversations[0], ['1']), [])

    def test_card_context_boundary_age_clear_and_late_history(self):
        first = self.message(1, '1', age=10)
        followup = self.message(2)
        self.assertEqual(consultation_ids(self.db, self.conversations[0], followup), ['1'])
        second = self.message(3, '2')
        self.assertEqual(consultation_ids(self.db, self.conversations[0], second), ['2'])
        late = self.message(4, '1', age=100)
        last = self.message(5)
        self.assertEqual(consultation_ids(self.db, self.conversations[0], last), ['2'])
        self.conversations[0].messages_cleared_sequence = 4
        self.assertEqual(consultation_ids(self.db, self.conversations[0], last), [])
        self.conversations[0].messages_cleared_sequence = 0
        for row in (first, second, late): row.platform_sent_at = utcnow() - timedelta(days=2)
        self.db.commit()
        self.assertEqual(consultation_ids(self.db, self.conversations[0], last), [])

    async def test_fresh_cache_no_task_stale_cache_nonblocking_expired_cache_timeout(self):
        card = self.message(1, '1')
        apply_detail(self.db, self.account, detail_payload()); self.db.commit()
        fresh = await ensure_details(self.db, self.user, self.conversations[0], card)
        self.assertFalse(fresh['attempted'])
        row = self.db.scalar(select(StoreProduct))
        raw = copy.deepcopy(row.raw_payload)
        for key in ('specifications', 'attributes'):
            raw['douyin_detail'][key]['observed_at'] = (utcnow() - timedelta(minutes=6)).isoformat()
        row.raw_payload = raw; self.db.commit()
        with patch('app.services.douyin_product_detail_service.asyncio.sleep', AsyncMock()) as sleep:
            stale = await ensure_details(self.db, self.user, self.conversations[0], card)
            sleep.assert_not_awaited()
        self.assertEqual(stale['status'], 'refresh_queued')
        same = queue_refresh(self.db, self.user, self.conversations[1], '1')
        self.assertEqual(stale['task_ids'], [same.id])
        raw = copy.deepcopy(row.raw_payload)
        raw['douyin_detail']['specifications']['observed_at'] = (utcnow() - timedelta(days=31)).isoformat()
        row.raw_payload = raw; self.db.commit()
        self.assertEqual(prompt_details(self.db, self.conversations[0], ['1']), [])
        timed = await ensure_details(self.db, self.user, self.conversations[0], card, timeout_seconds=0)
        self.assertEqual(timed['status'], 'timeout')
        complete_task(self.db, same, TaskCompleteRequest(status='completed', result_json={'product_details': [detail_payload()]}))
        self.assertEqual(self.db.query(Message).count(), 1, 'late detail only updates cache')

    async def test_disabled_never_queues_and_successful_wait_reads_persisted_data(self):
        card = self.message(1, '1')
        await ensure_details(self.db, self.user, self.conversations[0], card, enabled=False)
        self.assertEqual(self.db.query(RpaTask).count(), 0)
        async def collect(_):
            task = self.db.scalar(select(RpaTask))
            complete_task(self.db, task, TaskCompleteRequest(status='completed', result_json={'product_details': [detail_payload()]}))
        with patch('app.services.douyin_product_detail_service.asyncio.sleep', AsyncMock(side_effect=collect)):
            status = await ensure_details(self.db, self.user, self.conversations[0], card)
        self.assertEqual(status['status'], 'collected')

    def test_prompt_budget_and_expired_attributes(self):
        payload = detail_payload()
        payload['attributes']['entries'] = [{'name': str(i), 'values': ['长' * 2000]} for i in range(100)]
        # Whole cache also has a bound; oversized payload fails before storage.
        with self.assertRaises(HTTPException): apply_detail(self.db, self.account, payload)
        payload['attributes']['entries'] = payload['attributes']['entries'][:60]
        apply_detail(self.db, self.account, payload); self.db.commit()
        result = prompt_details(self.db, self.conversations[0], ['1'])
        import json
        self.assertLessEqual(len(json.dumps(result, ensure_ascii=False)), 24000)
        self.assertTrue(result[0]['attributes_truncated'])
