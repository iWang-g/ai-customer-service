import asyncio
import unittest
from datetime import timedelta

from tests import test_douyin_orders as fixture
from app.models import Message, RpaTask, utcnow
from app.services.douyin_order_context import prompt_context, refresh_before_reply
from app.services.order_service import order_prompt_context


class DouyinOrderContextTests(unittest.TestCase):
    setUp = fixture.DouyinOrdersTests.setUp
    tearDown = fixture.DouyinOrdersTests.tearDown
    task = fixture.DouyinOrdersTests.task
    payload = fixture.DouyinOrdersTests.payload
    complete = fixture.DouyinOrdersTests.complete

    def test_context_includes_only_bound_visible_orders_and_no_unverified_amount(self):
        self.complete(self.task())
        c = self.conversations[0]
        context = order_prompt_context(self.db, c)
        self.assertEqual(len(context['recent_orders']), 1)
        self.assertTrue(context['dynamic_fields_fresh'])
        self.assertNotIn('paid_amount', str(context)); self.assertNotIn('latest_order', context)
        self.assertEqual(context['query_coverage'], 'first_page_only_unknown_total_and_sort')
        self.assertEqual(prompt_context(self.db, self.conversations[1])['recent_orders'], [])
        original = c.metadata_json
        for overrides in [{'shop_id': 'other'}, {'customer_key': 'other'}, {'visible_order_ids': []}, {'source': 'other'}]:
            c.metadata_json = {**original, 'customer_orders': {**original['customer_orders'], **overrides}}
            self.db.commit()
            self.assertEqual(prompt_context(self.db, c)['recent_orders'], [])

    def test_failed_empty_and_stale_snapshots_do_not_prove_current_state(self):
        self.complete(self.task())
        c = self.conversations[0]
        summary = c.metadata_json['customer_orders']
        c.metadata_json = {**c.metadata_json, 'customer_orders': {**summary,
            'observed_at': (utcnow()-timedelta(minutes=11)).isoformat()}}
        self.db.commit()
        self.assertFalse(prompt_context(self.db, c)['dynamic_fields_fresh'])
        self.complete(self.task(), status='failed')
        ctx = prompt_context(self.db, c)
        self.assertFalse(ctx['orders_known']); self.assertFalse(ctx['dynamic_fields_fresh'])
        self.assertEqual(len(ctx['recent_orders']), 1)
        empty = self.payload(); empty['orders'] = []
        self.complete(self.task(), empty)
        ctx = prompt_context(self.db, c)
        self.assertEqual(ctx['recent_orders'], []); self.assertFalse(ctx['complete_history'])

    def refresh(self, text, timeout=0):
        c = self.conversations[0]
        self.account.login_status = 'online'
        # Read-only refresh does not dispatch in this isolated test.
        self.account.last_rpa_node_id = None
        from app.services.rpa_service import get_or_create_desktop_ingest_node
        self.account.last_rpa_node_id = get_or_create_desktop_ingest_node(self.db, self.user).id
        source = Message(user_id=self.user.id, conversation_id=c.id, platform_code='douyin',
            sender_role='customer', content=text, conversation_sequence=self.db.query(Message).count() + 1)
        self.db.add(source); self.db.commit()
        return asyncio.run(refresh_before_reply(self.db, self.user, c, source, text=text, timeout_seconds=timeout))

    def test_presale_and_explicit_human_do_not_wait_for_orders(self):
        for text in ['你好', '什么材质', '帮我退款']:
            self.assertFalse(self.refresh(text)['attempted'])
        self.assertEqual(self.db.query(RpaTask).count(), 0)

    def test_current_question_refreshes_then_timeout_does_not_claim_freshness(self):
        self.complete(self.task())
        old = self.db.query(RpaTask).first(); old.requested_at = utcnow()-timedelta(seconds=61); self.db.commit()
        result = self.refresh('我的订单发货了吗')
        self.assertTrue(result['attempted']); self.assertTrue(result['current_state_unverified'])
        pending = self.db.get(RpaTask, result['task_id'])
        self.assertEqual(pending.payload_json['source'], 'douyin_orders_v1')
        result2 = self.refresh('我的订单发货了吗')
        self.assertEqual(result2['task_id'], pending.id)

    def test_cooldown_does_not_turn_cache_into_current_state(self):
        self.complete(self.task())
        result = self.refresh('订单发货了吗')
        self.assertFalse(result['attempted']); self.assertTrue(result['current_state_unverified'])
        self.assertEqual(self.db.query(RpaTask).count(), 1)
