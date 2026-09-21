import copy
import unittest
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.models import Base, User, PlatformAccount, Conversation, StoreProduct, RpaNode, Message, RpaTask
from app.schemas.rpa import RpaEventCreate
from app.services.rpa_service import create_event
from app.services.product_service import apply_store_products_snapshot, customer_products_response, match_store_products


class DouyinProductsTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine('sqlite:///:memory:')
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.user = User(username='products', password_hash='unused', display_name='Products')
        self.db.add(self.user); self.db.flush()
        self.account = PlatformAccount(user_id=self.user.id, platform_code='douyin', platform_name='抖店',
                                       external_account_id='123', local_account_id='local', account_name='shop')
        self.db.add(self.account); self.db.flush()
        self.node = RpaNode(user_id=self.user.id, node_key='test', hostname='test')
        self.db.add(self.node)
        self.conversations = [Conversation(user_id=self.user.id, platform_account_id=self.account.id, platform_code='douyin',
            external_conversation_id=str(i), latest_message_text='original', unread_count=2) for i in range(2)]
        self.db.add_all(self.conversations); self.db.commit()
        self.time = datetime.now(timezone.utc)

    def tearDown(self):
        self.db.close(); self.engine.dispose()

    def payload(self, ids, delta=0, total=None):
        total = len(ids) if total is None else total
        return {'shop_id': '123', 'source': 'douyin_products_v1', 'observed_at': (self.time + timedelta(seconds=delta)).isoformat(),
            'collection_status': 'success' if ids else 'empty', 'products': [
                {'product_id': pid, 'goods_id': pid, 'title': 'Product ' + pid,
                 'image_url': 'https://example.test/product.png'} for pid in ids],
            'page_summary': {'page_no': 0, 'page_size': 20, 'total_count': total, 'has_more': total > len(ids)}}

    def apply(self, payload):
        value = apply_store_products_snapshot(self.db, self.account, payload, None)
        self.db.commit()
        return value

    def response(self, conversation=None):
        return customer_products_response(self.db, self.user, (conversation or self.conversations[0]).id)

    def test_rpa_persistence_shared_by_shop_without_messages_or_ai(self):
        pid = '3830227192483283126'
        event = RpaEventCreate(event_id='products', dedup_key='products', event_type='store_products_snapshot',
            platform_code='douyin', platform_account_id=self.account.id, payload_json=self.payload([pid]))
        _, messages, conversations = create_event(self.db, self.user, self.node, event)
        self.assertEqual((messages, conversations), ([], []))
        create_event(self.db, self.user, self.node, event)
        self.assertEqual(self.db.query(StoreProduct).count(), 1)
        with Session(self.engine) as reopened:
            response = customer_products_response(reopened, reopened.get(User, self.user.id), self.conversations[1].id)
            self.assertEqual(response.products[0].product_id, pid)
            self.assertEqual(response.method, 'douyin_product_list')
            self.assertIsNone(response.products[0].price)
        self.assertEqual(self.db.query(Message).count(), 0)
        self.assertEqual(self.db.query(RpaTask).count(), 0)
        self.assertEqual(self.conversations[0].unread_count, 2)
        self.assertEqual(match_store_products(self.db, self.conversations[0], '推荐商品'), [])

    def test_display_price_survives_event_persistence_refresh_and_missing_price(self):
        payload = self.payload(['1'])
        payload['products'][0].update(price_label='¥99.00–155.00起', price=999999)
        event = RpaEventCreate(event_id='priced-products', event_type='store_products_snapshot',
            platform_code='douyin', platform_account_id=self.account.id, payload_json=payload)
        saved, _, _ = create_event(self.db, self.user, self.node, event)
        self.assertEqual(saved.payload_json['products'][0]['price_label'], '¥99.00–155.00起')
        self.assertNotIn('price', saved.payload_json['products'][0])
        with Session(self.engine) as reopened:
            response = customer_products_response(reopened, reopened.get(User, self.user.id), self.conversations[1].id)
            self.assertEqual(response.products[0].price_label, '¥99.00–155.00起')
            self.assertIsNone(response.products[0].price)
        newer = self.payload(['1'], 1)
        newer['products'][0]['price_label'] = '¥0.00'
        self.apply(newer)
        self.apply(self.payload(['1'], -1))
        self.assertEqual(self.response().products[0].price_label, '¥0.00')
        self.apply(self.payload(['1'], 2))
        self.assertIsNone(self.response().products[0].price_label)

    def test_invalid_price_text_cannot_replace_saved_list(self):
        good = self.payload(['1'])
        good['products'][0]['price_label'] = '¥155.00'
        self.apply(good)
        for value in [155, {}, [], True, 'x' * 65, '155\n00', '\u202e155']:
            bad = self.payload(['1'], 1)
            bad['products'][0]['price_label'] = value
            with self.assertRaises(HTTPException): self.apply(bad)
            self.db.rollback()
            self.assertEqual(self.response().products[0].price_label, '¥155.00')

    def test_refresh_replaces_visible_ids_empty_clears_and_stale_cannot_revert(self):
        self.apply(self.payload(['1', '2']))
        self.apply(self.payload(['2', '3'], 1))
        self.apply(self.payload(['1'], -1))
        self.assertEqual([p.product_id for p in self.response().products], ['2', '3'])
        self.apply(self.payload([], 2))
        self.assertEqual(self.response().collection_status, 'empty')
        self.assertEqual(self.response(self.conversations[1]).products, [])
        self.assertEqual(self.db.query(StoreProduct).count(), 3)

    def test_first_page_only_is_explicit_and_missing_pages_never_delete_rows(self):
        self.apply(self.payload(['99']))
        self.apply(self.payload([str(i) for i in range(20)], 1, total=51))
        self.assertEqual(len(self.response().products), 20)
        self.assertTrue(self.response().has_more)
        self.assertEqual(self.response().total_count, 51)
        self.assertEqual(self.db.query(StoreProduct).count(), 21)

    def test_invalid_snapshots_preserve_previous_success(self):
        self.apply(self.payload(['1']))
        base = self.payload(['2'], 1)
        variants = []
        for key, value in [('shop_id', 'other'), ('source', 'wrong'), ('collection_status', 'unavailable'),
                           ('products', base['products'] * 2), ('page_summary', []), ('observed_at', 'bad')]:
            candidate = copy.deepcopy(base); candidate[key] = value; variants.append(candidate)
        for key, value in [('page_no', 1), ('page_size', 100), ('total_count', 21), ('has_more', True)]:
            candidate = copy.deepcopy(base); candidate['page_summary'][key] = value; variants.append(candidate)
        for key, value in [('product_id', 3830227192483283126), ('goods_id', 'other'), ('image_url', 'javascript:alert(1)'),
                           ('image_url', 'https://user:password@example.test/image')]:
            candidate = copy.deepcopy(base); candidate['products'][0][key] = value; variants.append(candidate)
        for candidate in variants:
            with self.assertRaises(HTTPException): self.apply(candidate)
            self.db.rollback()
            self.assertEqual([p.product_id for p in self.response().products], ['1'])

    def test_field_projection_and_cross_account_isolation(self):
        payload = self.payload(['1'])
        payload['products'][0].update(price=999, quantity=10, raw_payload={'cookie': 'secret'})
        payload['credentials'] = 'secret'
        self.apply(payload)
        self.assertNotIn('secret', str(payload))
        self.assertIsNone(self.response().products[0].quantity)
        self.assertEqual(self.response().products[0].raw_payload, {})
        other = PlatformAccount(user_id=self.user.id, platform_code='douyin', platform_name='抖店', external_account_id='456', account_name='other')
        self.db.add(other); self.db.flush()
        conversation = Conversation(user_id=self.user.id, platform_account_id=other.id, platform_code='douyin')
        outsider = User(username='other', password_hash='unused', display_name='Other')
        self.db.add_all([conversation, outsider]); self.db.commit()
        self.assertEqual(self.response(conversation).products, [])
        with self.assertRaises(HTTPException): customer_products_response(self.db, outsider, self.conversations[0].id)
