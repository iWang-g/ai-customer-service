import copy
import unittest
from datetime import timedelta
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from sqlalchemy import select

from app.models import Conversation, Message, RpaTask, StoreProduct, utcnow
from app.schemas.rpa import RpaEventCreate
from app.services.product_service import apply_store_products_snapshot, customer_products_response
from app.services.qianniu_product_detail_service import (
    apply_detail, saved_detail, prompt_details, consultation_ids, queue_refresh, ensure_details,
)
from app.services.rpa_service import create_event
from test_qianniu_products import QianniuProductsTests


def detail_payload(product_id='1', shop_uid='123', observed=None):
    return {'source': 'qianniu_product_detail_v1', 'shop_uid': shop_uid, 'product_id': product_id,
        'observed_at': (observed or utcnow()).isoformat(), 'detail': {'productId': product_id,
            'title': 'Pillow cover', 'price': '25.00', 'quantity': 8,
            'attributes': [{'raw': '1:2:Material:Cotton', 'parsed': True, 'name': 'Material', 'value': 'Cotton'}],
            'skus': [{'skuId': '1234567890123456789', 'price': '25.00', 'quantity': 8,
                'propertiesNameRaw': '-1:-2:Style:Cover only', 'attributes': [
                    {'raw': '-1:-2:Style:Cover only', 'parsed': True, 'name': 'Style', 'value': 'Cover only'}]}],
            'servicesPresent': True, 'services': [{'name': 'Return', 'description': 'Only if unused'}],
            'encryptId': 'must-not-persist', 'deliveryTimeData': {'ipInfo': 'private'}}}


def verified_detail_payload(product_id='999', seller_uid='789'):
    payload = detail_payload(product_id)
    payload['seller_uid'] = seller_uid
    payload['ownership'] = {'source': 'qianniu_material_item_v1', 'product_id': product_id,
        'seller_uid': seller_uid, 'title': 'Verified pillow', 'image_url': 'https://img.example/p.jpg',
        'link_url': f'https://item.taobao.com/item.htm?id={product_id}', 'price': '64',
        'quantity': 8, 'has_sku': True}
    return payload


class ProductDetailTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        QianniuProductsTests.setUp(self)
        payload = QianniuProductsTests.payload(self, ['1', '2', '3'])
        apply_store_products_snapshot(self.db, self.account, payload, None); self.db.commit()

    def tearDown(self):
        QianniuProductsTests.tearDown(self)

    def test_event_persistence_preserved_by_list_refresh_and_stale_rejection(self):
        payload = detail_payload()
        request = RpaEventCreate(event_id='detail', event_type='store_product_detail_snapshot',
            platform_code='qianniu', platform_account_id=self.account.id, payload_json=payload)
        event, messages, conversations = create_event(self.db, self.user, self.node, request)
        self.assertEqual((messages, conversations), ([], []))
        self.db.expire_all()
        original = saved_detail(self.db, self.account, '1')
        self.assertNotIn('must-not-persist', str(original)); self.assertNotIn('private', str(original))
        self.assertNotIn('detail', event.payload_json)
        self.assertEqual(original['detail']['skus'][0]['skuId'], '1234567890123456789')
        updated_list = QianniuProductsTests.payload(self, ['1', '2'], 1)
        updated_list['products'][0]['raw_payload'] = {'qianniu_detail': {'source': 'forged'}}
        apply_store_products_snapshot(self.db, self.account, updated_list, None); self.db.commit()
        self.assertEqual(saved_detail(self.db, self.account, '1'), original)
        self.assertNotIn('qianniu_detail', customer_products_response(self.db, self.user, self.conversations[0].id).products[0].raw_payload)
        self.assertFalse(apply_detail(self.db, self.account, detail_payload(observed=utcnow() - timedelta(hours=1))))
        self.assertEqual(self.db.query(Message).count(), 0)
        self.assertEqual(self.db.query(RpaTask).count(), 0)

    def test_identity_malformed_future_duplicate_rejection(self):
        apply_detail(self.db, self.account, detail_payload()); self.db.commit()
        original = saved_detail(self.db, self.account, '1')
        bad = [detail_payload(shop_uid='999'), detail_payload('99'), detail_payload(observed=utcnow()+timedelta(days=1))]
        duplicate = detail_payload(); duplicate['detail']['skus'] *= 2; bad.append(duplicate)
        mismatch = detail_payload(); mismatch['detail']['productId'] = '2'; bad.append(mismatch)
        for payload in bad:
            with self.assertRaises(HTTPException): apply_detail(self.db, self.account, payload)
            self.db.rollback()
            self.assertEqual(saved_detail(self.db, self.account, '1'), original)

    def test_prompt_freshness_account_isolation_and_service_conditions(self):
        apply_detail(self.db, self.account, detail_payload(observed=utcnow()-timedelta(minutes=6))); self.db.commit()
        prompt = prompt_details(self.db, self.conversations[0], ['1'])
        self.assertEqual(prompt[0]['services'][0]['description'], 'Only if unused')
        self.assertNotIn('price', prompt[0]['skus'][0]); self.assertNotIn('quantity', prompt[0]['skus'][0])
        self.assertEqual(prompt[0]['review_status'], 'unreviewed')
        self.assertEqual(prompt_details(self.db, self.conversations[1], ['1']), prompt)
        row = self.db.scalar(select(StoreProduct).where(StoreProduct.goods_id == '1'))
        value = copy.deepcopy(row.raw_payload); value['qianniu_detail']['observed_at'] = (utcnow()-timedelta(days=2)).isoformat()
        row.raw_payload = value; self.db.commit()
        stale = prompt_details(self.db, self.conversations[0], ['1'])
        self.assertEqual(stale[0]['title'], 'Pillow cover')
        self.assertNotIn('price', stale[0]['skus'][0]); self.assertNotIn('quantity', stale[0]['skus'][0])
        value = copy.deepcopy(row.raw_payload); value['qianniu_detail']['observed_at'] = (utcnow()-timedelta(days=31)).isoformat()
        row.raw_payload = value; self.db.commit()
        self.assertEqual(prompt_details(self.db, self.conversations[0], ['1']), [])
        other = Conversation(user_id=self.user.id, platform_code='pinduoduo', platform_account_id=self.account.id)
        self.assertEqual(prompt_details(self.db, other, ['1']), [])

    def message(self, sequence, product_id=None, age=0, role='customer'):
        m = Message(user_id=self.user.id, conversation_id=self.conversations[0].id, platform_code='qianniu',
            sender_role=role, content='Question', conversation_sequence=sequence, message_status='received',
            platform_sent_at=utcnow()-timedelta(minutes=age), collected_at=utcnow(),
            raw_payload={'message_type': 'product' if product_id else 'text', 'structured_payload': {
                'parts': [{'kind': 'product', 'product_id': product_id, 'title': 'Item'}] if product_id else []}})
        self.db.add(m); self.db.flush(); return m

    async def test_consultation_uses_latest_customer_product_clear_boundary_and_task_coalescing(self):
        self.account.last_rpa_node_id = self.node.id
        self.message(1, '1', age=10)
        self.message(2, '2', age=5)
        self.message(3, '1', age=60)  # Late import of an older product card.
        self.message(4, '3', role='agent')
        source = self.message(5)
        self.assertEqual(consultation_ids(self.db, self.conversations[0], source), ['2'])
        task = queue_refresh(self.db, self.user, self.conversations[0], ['2'])
        self.assertEqual(queue_refresh(self.db, self.user, self.conversations[1], ['2']).id, task.id)
        self.assertEqual(task.task_type, 'refresh_product_details')
        self.assertEqual(task.node_id, self.node.id)
        self.assertEqual(task.payload_json['ownership_verified_product_ids'], ['2'])
        with patch('app.services.qianniu_product_detail_service.asyncio.sleep', new_callable=AsyncMock) as sleep:
            async def collect(_):
                apply_detail(self.db, self.account, detail_payload('2')); self.db.commit()
            sleep.side_effect = collect
            result = await ensure_details(self.db, self.user, self.conversations[0], source)
        self.assertEqual(result['status'], 'collected')
        self.conversations[0].messages_cleared_sequence = 4
        self.assertEqual(consultation_ids(self.db, self.conversations[0], source), [])
        self.assertEqual(self.db.query(RpaTask).count(), 1)

    async def test_stale_static_detail_is_used_immediately_and_refreshed_in_background(self):
        self.account.last_rpa_node_id = self.node.id
        apply_detail(self.db, self.account, detail_payload(observed=utcnow()-timedelta(days=2)))
        source = self.message(1, '1')
        self.db.commit()
        with patch('app.services.qianniu_product_detail_service.asyncio.sleep', new_callable=AsyncMock) as sleep:
            result = await ensure_details(self.db, self.user, self.conversations[0], source)
        sleep.assert_not_awaited()
        self.assertEqual(result['status'], 'refresh_queued')
        self.assertTrue(result['attempted'])
        self.assertEqual(prompt_details(self.db, self.conversations[0], ['1'])[0]['title'], 'Pillow cover')
        task = self.db.scalar(select(RpaTask))
        self.assertEqual(task.payload_json['ownership_verified_product_ids'], ['1'])

    async def test_no_live_refresh_when_disabled_and_unknown_product_never_falls_back_to_old(self):
        self.message(1, '1', age=10)
        self.message(2, '999', age=1)
        source = self.message(3)
        self.assertEqual(consultation_ids(self.db, self.conversations[0], source), ['999'])
        result = await ensure_details(self.db, self.user, self.conversations[0], source, enabled=False)
        self.assertFalse(result['attempted'])
        self.assertEqual(prompt_details(self.db, self.conversations[0], result['product_ids']), [])
        self.assertEqual(self.db.query(RpaTask).count(), 0)

    async def test_structured_unknown_product_is_verified_collected_and_not_added_to_shop_list(self):
        self.account.last_rpa_node_id = self.node.id
        self.account.metadata_json = {'main_account_uid': '789'}
        source = self.message(1, '999')
        with patch('app.services.qianniu_product_detail_service.asyncio.sleep', new_callable=AsyncMock) as sleep:
            async def collect(_):
                apply_detail(self.db, self.account, verified_detail_payload()); self.db.commit()
            sleep.side_effect = collect
            result = await ensure_details(self.db, self.user, self.conversations[0], source)
        self.assertEqual(result['status'], 'collected')
        self.assertTrue(result['attempted'])
        self.assertEqual(self.db.query(RpaTask).count(), 1)
        self.assertEqual(saved_detail(self.db, self.account, '999')['detail']['skus'][0]['skuId'], '1234567890123456789')
        self.assertNotIn('999', (self.account.metadata_json.get('store_products') or {}).get('product_ids', []))

    def test_unknown_product_rejects_wrong_seller_ownership(self):
        self.account.metadata_json = {'main_account_uid': '789'}
        with self.assertRaises(HTTPException):
            apply_detail(self.db, self.account, verified_detail_payload(seller_uid='000'))
        self.db.rollback()
        self.assertIsNone(self.db.scalar(select(StoreProduct).where(StoreProduct.goods_id == '999')))
