import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch, AsyncMock

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from app.models import Base, User, PlatformAccount, Conversation, Message, RpaTask
from app.services.automation_service import _refresh_order_context_before_reply
from app.services.qianniu_order_context import freshness, needs_current_state


class QianniuOrderContextTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.engine = create_engine('sqlite:///:memory:')
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.user = User(username='orders', display_name='test', password_hash='unused')
        self.db.add(self.user); self.db.flush()
        self.account = PlatformAccount(user_id=self.user.id, platform_code='qianniu', platform_name='千牛',
                                      local_account_id='test', account_name='test')
        self.db.add(self.account); self.db.flush()
        self.c = Conversation(user_id=self.user.id, platform_account_id=self.account.id, platform_code='qianniu',
                              external_conversation_id='123.1-456.1#11001@cntaobao')
        self.db.add(self.c); self.db.flush()
        self.msg = Message(user_id=self.user.id, conversation_id=self.c.id, platform_code='qianniu',
                           sender_role='customer', content='这款什么材质')
        self.db.add(self.msg); self.db.commit()

    def tearDown(self):
        self.db.close(); self.engine.dispose()

    def summary(self, seconds=0, status='success'):
        self.c.metadata_json = {'customer_orders': {'collection_status': status,
            'observed_at': (datetime.now(timezone.utc) - timedelta(seconds=seconds)).isoformat()}}
        self.db.commit()

    async def refresh(self, **kwargs):
        return await _refresh_order_context_before_reply(self.db, self.user, self.c, self.msg, enabled=True, **kwargs)

    async def test_normal_missing_stale_and_failed_data_queue_without_wait_and_coalesce(self):
        for age, status in [(0, 'unavailable'), (700, 'success')]:
            self.summary(age, status)
            with patch('app.services.qianniu_order_context.asyncio.sleep', new_callable=AsyncMock) as sleep:
                first = await self.refresh()
                second = await self.refresh()
                sleep.assert_not_awaited()
            self.assertFalse(first['blocking'])
            self.assertEqual(first['task_id'], second['task_id'])
        self.assertEqual(self.db.query(RpaTask).count(), 1)
        task = self.db.scalar(select(RpaTask))
        self.assertEqual(task.priority, -20)
        task.status = 'failed'; self.db.commit()
        self.assertEqual((await self.refresh())['reason'], 'refresh_cooldown')

    async def test_fresh_empty_or_success_uses_cache(self):
        for status in ['success', 'empty']:
            self.summary(status=status)
            self.assertEqual((await self.refresh())['reason'], 'cached_order_context_fresh')
        self.assertEqual(self.db.query(RpaTask).count(), 0)

    async def test_urgent_uses_bounded_wait_even_with_fresh_cache(self):
        self.summary()
        result = await self.refresh(message_text='我的订单发货了吗', timeout_seconds=0)
        self.assertTrue(result['blocking']); self.assertEqual(result['status'], 'timeout')
        self.assertTrue(result['current_state_unverified'])
        self.assertEqual(self.db.scalar(select(RpaTask)).priority, 20)

    async def test_urgent_reads_saved_new_snapshot_not_task_completion_alone(self):
        self.summary(700)
        async def save(_delay):
            self.summary()
        with patch('app.services.qianniu_order_context.asyncio.sleep', side_effect=save):
            result = await self.refresh(message_text='我刚付款', timeout_seconds=1)
        self.assertEqual(result['status'], 'collected')

    async def test_preview_disabled_and_invalid_account_do_not_collect(self):
        result = await _refresh_order_context_before_reply(self.db, self.user, self.c, self.msg, enabled=False)
        self.assertFalse(result['attempted'])
        self.account.platform_code = 'pinduoduo'; self.db.commit()
        self.assertFalse((await self.refresh())['attempted'])
        self.assertEqual(self.db.query(RpaTask).count(), 0)

    def test_freshness_and_presale_vs_live_order_intent(self):
        for text in ['这个一般多久发货', '这款什么材质', '支持什么付款方式']:
            self.assertFalse(needs_current_state(text))
        for text in ['我刚下单', '我的订单退款进度', '发货了吗', '查一下物流']:
            self.assertTrue(needs_current_state(text))
        self.assertFalse(freshness({})['dynamic_fields_fresh'])
        self.assertFalse(freshness({'collection_status':'success', 'observed_at':
            (datetime.now(timezone.utc)+timedelta(days=1)).isoformat()})['dynamic_fields_fresh'])
