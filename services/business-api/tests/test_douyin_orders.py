import copy
import unittest
from datetime import timedelta
from unittest.mock import patch

from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.models import Base, User, PlatformAccount, Conversation, CustomerOrder, CustomerOutreachRun, Message, RpaTask, utcnow
from app.schemas.rpa import TaskCompleteRequest
from app.services.douyin_order_service import queue_refresh
from app.services.rpa_service import acknowledge_task, complete_task
from app.services.order_service import customer_orders_response, order_prompt_context, apply_orders_snapshot, schedule_due_outreach_rechecks


class DouyinOrdersTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine('sqlite:///:memory:')
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.user = User(username='orders', display_name='Orders', password_hash='unused')
        self.db.add(self.user); self.db.flush()
        self.account = PlatformAccount(user_id=self.user.id, platform_code='douyin', platform_name='抖店',
            external_account_id='123', account_name='shop')
        self.db.add(self.account); self.db.flush()
        self.conversations = [Conversation(user_id=self.user.id, platform_account_id=self.account.id,
            platform_code='douyin', external_conversation_id=f'buyer{i}:123::2:1:pigeon') for i in range(2)]
        self.db.add_all(self.conversations); self.db.commit()

    def tearDown(self):
        self.db.close(); self.engine.dispose()

    def task(self, index=0):
        return queue_refresh(self.db, self.user, self.conversations[index].id)

    def payload(self, index=0):
        return {'source': 'douyin_orders_v1', 'shop_id': '123', 'buyer_id': f'buyer{index}',
            'conversation_id': self.conversations[index].external_conversation_id,
            'request_association': 'matched', 'observed_at': utcnow().isoformat(),
            'query_coverage': 'first_page_only_unknown_total_and_sort', 'orders': [{
                'platform_order_id': '9007199254740993999', 'shop_id': '123', 'buyer_id': f'buyer{index}',
                'raw_status': '待支付', 'ordered_at': '2026-09-19T03:09:02Z', 'after_sale_description': '',
                'products': [{'product_id': '11', 'sku_order_id': '21', 'sku_id': '31', 'title': '商品甲',
                    'sku': '规格甲', 'quantity': 2, 'image_url': 'https://cdn.example.test/a.png'},
                    {'product_id': '12', 'sku_order_id': '22', 'sku_id': '', 'title': '商品乙',
                    'sku': '规格乙', 'quantity': None, 'image_url': ''}]}]}

    def complete(self, task, payload=None, status='completed'):
        return complete_task(self.db, task, TaskCompleteRequest(status=status,
            result_json={'orders_snapshot': payload or self.payload()} if status == 'completed' else {}))

    def response(self, index=0):
        return customer_orders_response(self.db, self.user, self.conversations[index].id)

    def test_refresh_is_coalesced_persisted_and_available_as_order_facts(self):
        task = self.task()
        self.assertEqual(self.task().id, task.id)
        acknowledge_task(self.db, task)
        self.assertEqual(task.status, 'acknowledged')
        with patch('app.services.order_service._create_outreach', side_effect=AssertionError('unexpected outreach')):
            self.complete(task)
        response = self.response()
        self.assertEqual(response.collection_status, 'success')
        self.assertEqual(response.last_attempt_task_id, task.id)
        self.assertEqual(len(response.orders[0].products_json), 2)
        self.assertEqual(response.orders[0].products_json[0]['quantity'], 2)
        self.assertIsNone(response.orders[0].paid_amount)
        self.assertIsNone(response.orders[0].order_amount)
        self.assertIsNone(response.orders[0].paid_at)
        self.assertEqual(response.orders[0].platform_order_id, '9007199254740993999')
        self.assertEqual(self.db.query(Message).count(), 0)
        self.assertEqual(self.db.query(CustomerOutreachRun).count(), 0)
        context = order_prompt_context(self.db, self.conversations[0])
        self.assertEqual(context['recent_orders'][0]['products'][0]['title'], '商品甲')
        self.assertTrue(context['dynamic_fields_fresh'])
        self.assertFalse(context['complete_history'])
        self.assertNotIn('paid_amount', context['recent_orders'][0])
        self.assertNotIn('商品甲', str(task.result_json))
        with Session(self.engine) as db:
            saved = customer_orders_response(db, db.get(User, self.user.id), self.conversations[0].id)
            self.assertEqual(saved.orders[0].products_json[1]['sku'], '规格乙')
        self.complete(task)
        self.assertEqual(self.db.query(CustomerOrder).count(), 1)

    def test_failed_refresh_keeps_visible_snapshot_and_timestamp_empty_hides_history(self):
        self.complete(self.task())
        previous = self.response()
        failed = self.task(); self.complete(failed, status='failed')
        response = self.response()
        self.assertEqual(response.collection_status, 'unavailable')
        self.assertEqual(response.observed_at, previous.observed_at)
        self.assertEqual(len(response.orders), 1)
        self.assertEqual(response.last_attempt_task_id, failed.id)
        empty = self.payload(); empty['orders'] = []
        self.complete(self.task(), empty)
        self.assertEqual(self.response().collection_status, 'empty')
        self.assertEqual(self.response().orders, [])
        self.assertEqual(self.db.query(CustomerOrder).count(), 1)
        self.complete(self.task(), status='failed')
        self.assertEqual(self.response().orders, [])

    def test_wrong_scope_identity_duplicate_ids_or_unapproved_fields_cannot_write(self):
        task = self.task()
        changes = [lambda p: p.update(shop_id='456'), lambda p: p.update(buyer_id='other'),
            lambda p: p.update(conversation_id=self.conversations[1].external_conversation_id),
            lambda p: p['orders'][0].update(buyer_id='other'),
            lambda p: p['orders'].append(copy.deepcopy(p['orders'][0])),
            lambda p: p['orders'][0].update(paid_amount=165),
            lambda p: p['orders'][0]['products'][0].update(quantity=True),
            lambda p: p['orders'][0]['products'][0].update(image_url='javascript:alert(1)'),
            lambda p: p.update(observed_at='1999-01-01T00:00:00Z')]
        for change in changes:
            payload = self.payload(); change(payload)
            with self.assertRaises(HTTPException): self.complete(task, payload)
            self.db.rollback()
            self.assertEqual(self.db.query(CustomerOrder).count(), 0)
        with self.assertRaises(HTTPException):
            complete_task(self.db, task, TaskCompleteRequest(status='confirmation_pending'))

    def test_existing_order_cannot_move_to_another_buyer(self):
        self.complete(self.task())
        with self.assertRaises(HTTPException): self.complete(self.task(1), self.payload(1))
        self.db.rollback()
        self.assertEqual(self.response(1).orders, [])
        self.assertEqual(len(self.response().orders), 1)

    def test_late_success_or_failure_cannot_override_newer_empty_result(self):
        for status in ['completed', 'failed']:
            older = self.task()
            older.requested_at = utcnow() - timedelta(seconds=31)
            self.db.commit()
            newer = self.task()
            empty = self.payload(); empty['orders'] = []
            self.complete(newer, empty)
            self.complete(older, status=status)
            self.assertTrue(older.result_json['discarded_stale'])
            self.assertEqual(self.response().orders, [])
            self.assertEqual(self.response().last_attempt_task_id, newer.id)

    def test_shop_change_invalidates_cached_view_and_pending_task(self):
        self.complete(self.task())
        pending = self.task()
        self.account.external_account_id = '456'; self.db.commit()
        self.assertEqual(self.response().orders, [])
        with self.assertRaises(HTTPException): self.complete(pending)

    def test_changed_customer_failure_cannot_reveal_previous_customer_cache(self):
        self.complete(self.task())
        self.conversations[0].external_conversation_id = 'newbuyer:123::2:1:pigeon'
        self.db.commit()
        self.assertEqual(self.response().orders, [])
        self.complete(self.task(), status='failed')
        self.assertEqual(self.response().orders, [])
        self.assertIsNone(self.response().observed_at)

    def test_unbound_snapshot_and_proactive_rechecks_are_blocked(self):
        with self.assertRaises(HTTPException):
            apply_orders_snapshot(self.db, self.conversations[0], {}, utcnow())
        self.complete(self.task())
        order = self.db.query(CustomerOrder).one()
        order.last_observed_at = utcnow() - timedelta(hours=1); self.db.commit()
        self.assertEqual(schedule_due_outreach_rechecks(self.db), 0)
        self.assertEqual(self.db.query(RpaTask).count(), 1)

    def test_queue_rejects_another_user_and_deleted_conversation(self):
        other = User(username='other', display_name='Other', password_hash='unused')
        self.db.add(other); self.db.commit()
        with self.assertRaises(HTTPException): queue_refresh(self.db, other, self.conversations[0].id)
        self.conversations[0].deleted_at = utcnow(); self.db.commit()
        with self.assertRaises(HTTPException): self.task()
