import copy
import unittest
from datetime import datetime, timedelta, timezone

from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from fastapi import HTTPException

from app.models import Base, User, PlatformAccount, Conversation, StoreProduct, RpaNode, Message, RpaTask
from app.schemas.rpa import RpaEventCreate
from app.services.rpa_service import create_event
from app.services.product_service import apply_store_products_snapshot, customer_products_response, match_store_products


class QianniuProductsTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine('sqlite:///:memory:')
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.user = User(username='products', password_hash='unused', display_name='Products')
        self.db.add(self.user); self.db.flush()
        self.account = PlatformAccount(user_id=self.user.id, platform_code='qianniu', platform_name='Qianniu',
                                       local_account_id='qianniu-123', account_name='shop')
        self.db.add(self.account); self.db.flush()
        self.node = RpaNode(user_id=self.user.id, node_key='test', hostname='test')
        self.db.add(self.node)
        self.conversations = [Conversation(user_id=self.user.id, platform_account_id=self.account.id, platform_code='qianniu',
            external_conversation_id=str(i), latest_message_text='original', unread_count=2) for i in range(2)]
        self.db.add_all(self.conversations); self.db.commit()
        self.time = datetime.now(timezone.utc)

    def tearDown(self):
        self.db.close(); self.engine.dispose()

    def payload(self, ids, delta=0):
        return {'shop_uid': '123', 'source': 'qianniu_products_v1', 'observed_at': (self.time + timedelta(seconds=delta)).isoformat(),
            'collection_status': 'success' if ids else 'empty', 'products': [
                {'product_id': pid, 'goods_id': pid, 'title': 'Product ' + pid, 'price': '65.50', 'price_label': '¥65.50'} for pid in ids],
            'page_summary': {'total_count': len(ids), 'has_more': False}}

    def apply(self, value):
        result = apply_store_products_snapshot(self.db, self.account, value, None)
        self.db.commit(); return result

    def ids(self, conversation=None):
        value = customer_products_response(self.db, self.user, (conversation or self.conversations[0]).id)
        return [p.platform_product_id for p in value.products]

    def test_snapshot_shared_by_shop_persists_across_session_and_does_not_trigger_messages(self):
        payload = self.payload(['1', '2'])
        event = RpaEventCreate(event_id='products', dedup_key='products', event_type='store_products_snapshot',
            platform_code='qianniu', platform_account_id=self.account.id, payload_json=payload)
        _, messages, conversations = create_event(self.db, self.user, self.node, event)
        self.assertEqual(messages, []); self.assertEqual(conversations, [])
        user_id, cid = self.user.id, self.conversations[1].id
        with Session(self.engine) as reopened:
            self.assertEqual(len(customer_products_response(reopened, reopened.get(User, user_id), cid).products), 2)
        self.assertEqual(self.ids(), ['1', '2']); self.assertEqual(self.ids(self.conversations[1]), ['1', '2'])
        self.assertEqual(self.db.query(Message).count(), 0); self.assertEqual(self.db.query(RpaTask).count(), 0)
        self.assertEqual(self.conversations[0].latest_message_text, 'original'); self.assertEqual(self.conversations[0].unread_count, 2)
        self.assertEqual(match_store_products(self.db, self.conversations[0], '推荐商品'), [])

    def test_complete_replacement_stale_rejection_and_empty_snapshot(self):
        self.apply(self.payload(['1', '2']))
        self.apply(self.payload(['2', '3'], 1)); self.assertEqual(self.ids(), ['2', '3'])
        self.apply(self.payload(['1'], -1)); self.assertEqual(self.ids(), ['2', '3'])
        self.apply(self.payload([], 2)); self.assertEqual(self.ids(), [])
        self.assertEqual(customer_products_response(self.db, self.user, self.conversations[0].id).collection_status, 'empty')
        self.assertEqual(self.db.query(StoreProduct).count(), 3)

    def test_bad_and_partial_results_cannot_overwrite_saved_list(self):
        self.apply(self.payload(['1']))
        base = self.payload(['2'], 1)
        variants = []
        for key, value in [('shop_uid', '999'), ('collection_status', 'unavailable'),
                           ('products', base['products'] * 2), ('page_summary', {'total_count': 8, 'has_more': True}),
                           ('page_summary', ['invalid']), ('page_summary', 'invalid')]:
            payload = copy.deepcopy(base); payload[key] = value; variants.append(payload)
        for payload in variants:
            with self.assertRaises(HTTPException): self.apply(payload)
            self.db.rollback(); self.assertEqual(self.ids(), ['1'])

    def test_other_shop_and_other_user_cannot_read_products(self):
        self.apply(self.payload(['1']))
        other = PlatformAccount(user_id=self.user.id, platform_code='qianniu', platform_name='Qianniu', local_account_id='qianniu-999', account_name='other')
        self.db.add(other); self.db.flush()
        conversation = Conversation(user_id=self.user.id, platform_account_id=other.id, platform_code='qianniu')
        outsider = User(username='outsider', password_hash='unused', display_name='Outsider')
        self.db.add_all([conversation, outsider]); self.db.commit()
        self.assertEqual(self.ids(conversation), [])
        with self.assertRaises(HTTPException): customer_products_response(self.db, outsider, self.conversations[0].id)

    def test_more_than_100_products_persist_without_truncation_and_partial_refresh_preserves_them(self):
        ids = [str(i) for i in range(1, 108)]
        self.assertEqual(self.apply(self.payload(ids)), 107)
        self.assertEqual(self.ids(), ids)
        self.assertEqual(self.ids(self.conversations[1]), ids)
        partial = self.payload(ids[:100], 1)
        partial['page_summary'] = {'total_count': 107, 'has_more': True}
        with self.assertRaises(HTTPException): self.apply(partial)
        self.db.rollback()
        self.assertEqual(self.ids(), ids)
        with self.assertRaises(HTTPException): self.apply(self.payload([str(i) for i in range(5001)], 1))
        self.db.rollback()
        self.assertEqual(self.ids(), ids)
