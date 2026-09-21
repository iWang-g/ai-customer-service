import unittest
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.models import Base, User, UserSettings, PlatformAccount, Robot, RobotPlatformScope, Message, RpaTask, AutomationReplyRun, utcnow
from app.schemas.automation import ReplyRunRequest
from app.schemas.rpa import RpaEventCreate
from app.services.rpa_service import create_event, get_or_create_desktop_ingest_node, select_inbound_reply_source
from app.services.automation_service import run_reply


class QianniuProductReplyTests(unittest.IsolatedAsyncioTestCase):
    async def test_saved_details_bypass_card_ack_and_followup_reuses_same_product(self):
        from app.services.product_service import apply_store_products_snapshot
        from app.services.qianniu_product_detail_service import apply_detail
        from test_qianniu_product_details import detail_payload
        apply_store_products_snapshot(self.db, self.account, {'source': 'qianniu_products_v1', 'shop_uid': '123',
            'observed_at': utcnow().isoformat(), 'collection_status': 'success',
            'products': [{'product_id': '123', 'goods_id': '123', 'title': 'Pillow'}],
            'page_summary': {'total_count': 1, 'has_more': False}}, None)
        apply_detail(self.db, self.account, detail_payload('123')); self.db.commit()
        _, _, card = self.ingest('detail-card', [self.product()])
        result, provider = await self.reply(card, use_real_details=True)
        provider.assert_awaited_once()
        self.assertTrue(provider.call_args.kwargs['product_card_only'])
        self.assertEqual(provider.call_args.kwargs['product_details'][0]['product_id'], '123')
        self.assertEqual(len(result['task_ids']), 1)
        _, _, question = self.ingest('detail-question', [{'index': 0, 'kind': 'text', 'text': '包含枕芯吗'}])
        _, provider = await self.reply(question, use_real_details=True)
        self.assertIn('Cover only', str(provider.call_args.kwargs['product_details']))

    def setUp(self):
        self.engine = create_engine('sqlite:///:memory:')
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.user = User(username='qn-product', display_name='Test', password_hash='unused')
        self.db.add(self.user)
        self.db.flush()
        self.account = PlatformAccount(user_id=self.user.id, platform_code='qianniu', platform_name='千牛',
            local_account_id='qianniu-123', account_name='Test')
        self.robot = Robot(user_id=self.user.id, name='千牛机器人', enabled=True, status='online',
            config_json={'allow_auto_send': True, 'product_card_ack_text': '亲亲，这款想了解什么呢'})
        self.db.add_all([self.account, self.robot, UserSettings(user_id=self.user.id, auto_reply_enabled=True)])
        self.db.flush()
        self.db.add(RobotPlatformScope(robot_id=self.robot.id, platform_code='qianniu', platform_account_id=self.account.id))
        self.db.commit()
        self.node = get_or_create_desktop_ingest_node(self.db, self.user)

    def tearDown(self):
        self.db.close()
        self.engine.dispose()

    def product(self, index=0, product_id='123', **extra):
        return {'index': index, 'kind': 'product', 'product_id': product_id,
            'title': '角色主题键帽', 'price_label': '¥155.00',
            'url': f'https://item.taobao.com/item.htm?id={product_id}',
            'image_url': 'https://img.alicdn.com/a.jpg?signature=private', **extra}

    def ingest(self, key, parts, *, snapshot=False, role='customer', kind=None):
        now = utcnow().isoformat()
        kind = kind or (parts[0]['kind'] if len(parts) == 1 else 'text')
        request = RpaEventCreate(event_id=key + ('-snapshot' if snapshot else ''), platform_code='qianniu',
            event_type='qianniu_message_snapshot' if snapshot else 'customer_message',
            platform_account_id=self.account.id, conversation_external_id='456.1-789.1#11001@cntaobao',
            platform_message_id=key, payload_json={'content': '[商品]', 'message_type': kind,
                'sender_role': role, 'automation_mode': 'ignore' if snapshot else 'trigger',
                'qianniu_media_version': 1, 'platform_sent_at': now, 'observed_at': now,
                'structured_payload': {'parts': parts, 'buyer_id': 'private-buyer'}})
        _, triggers, _ = create_event(self.db, self.user, self.node, request)
        message = self.db.scalar(select(Message).where(Message.platform_message_id == key))
        return request, triggers, message

    async def reply(self, source, *, use_real_details=False):
        provider = AsyncMock(return_value={'decision': 'auto_send', 'text': '亲亲，您更喜欢哪种风格呢？',
            'confidence': 1, 'provider': 'fixture', 'trace_id': 'fixture', 'intent': {}, 'retrieval': []})
        details = patch('app.services.qianniu_product_detail_service.ensure_details', new=AsyncMock(
            return_value={'attempted': False, 'product_ids': []}))
        with patch('app.services.automation_service._decide_reply', provider), details if not use_real_details else patch(
                'app.services.qianniu_product_detail_service.FRESH_SECONDS', 300):
            result = await run_reply(self.db, self.user, ReplyRunRequest(conversation_id=source.conversation_id,
                source_message_id=source.id, allow_auto_send=True))
        return result, provider

    async def test_live_card_ack_and_completion_do_not_reply_twice(self):
        request, triggers, source = self.ingest('card', [self.product(title=None, price_label=None)])
        self.assertEqual(select_inbound_reply_source(self.db, request, triggers), source)
        result, provider = await self.reply(source)
        provider.assert_not_awaited()
        self.assertEqual(result['provider'], 'product-card-rule')
        self.assertEqual(result['text'], '亲亲，这款想了解什么呢')
        task = self.db.get(RpaTask, result['task_ids'][0])
        self.assertEqual(task.platform_code, 'qianniu')
        self.assertEqual(task.payload_json['content'], result['text'])
        _, triggers, _ = self.ingest('card', [self.product()], snapshot=True)
        self.assertEqual(triggers, [])
        self.db.expire_all()
        self.assertEqual(self.db.get(Message, source.id).raw_payload['structured_payload']['title'], '角色主题键帽')
        _, triggers, _ = create_event(self.db, self.user, self.node, request)
        self.assertEqual(triggers, [])
        with self.assertRaises(HTTPException) as error:
            await self.reply(source)
        self.assertEqual(error.exception.status_code, 409)
        self.assertEqual(self.db.query(RpaTask).count(), 1)
        self.assertEqual(self.db.query(AutomationReplyRun).count(), 1)

    async def test_multiple_products_only_use_one_ack(self):
        _, _, source = self.ingest('multi-card', [self.product(), self.product(1, '456')])
        self.assertEqual(source.raw_payload['message_type'], 'text', 'UI composite envelope stays unchanged')
        result, provider = await self.reply(source)
        provider.assert_not_awaited()
        self.assertEqual(result['provider'], 'product-card-rule')
        self.assertEqual(len(result['task_ids']), 1)

    async def test_product_and_question_use_model_with_every_product(self):
        _, _, source = self.ingest('mixed', [self.product(),
            {'index': 1, 'kind': 'text', 'text': '这两款哪种风格更合适'}, self.product(2, '456')])
        result, provider = await self.reply(source)
        provider.assert_awaited_once()
        self.assertEqual(len(result['task_ids']), 1)
        self.assertIn('这两款哪种风格更合适', provider.call_args.kwargs['message'])
        context = provider.call_args.kwargs['platform_context']
        self.assertEqual([item['data']['product_id'] for item in context], ['123', '456'])
        self.assertNotIn('private', str(context))
        self.assertNotIn('https:', str(context))

    async def test_history_and_seller_cards_are_context_only_and_latest_completion_is_used(self):
        for key, role in [('history-card', 'customer'), ('seller-card', 'agent')]:
            request, triggers, _ = self.ingest(key, [self.product()], snapshot=True, role=role)
            self.assertIsNone(select_inbound_reply_source(self.db, request, triggers))
        self.ingest('system', [self.product()], snapshot=True, role='platform', kind='system')
        self.assertEqual(self.db.query(RpaTask).count(), 0)
        _, _, source = self.ingest('question', [{'index': 0, 'kind': 'text', 'text': '你觉得这款怎么样'}])
        self.db.expire_all()
        _, provider = await self.reply(source)
        provider.assert_awaited_once()
        context = provider.call_args.kwargs['platform_context']
        self.assertEqual([item['sender_role'] for item in context], ['customer', 'agent'])
        self.assertTrue(all(item['data']['price_label'] == '¥155.00' for item in context))
        history = provider.call_args.kwargs['history']
        self.assertIn({'role': 'assistant', 'content': '[商品] 角色主题键帽'}, history)
        self.assertEqual(history[-1]['content'], '你觉得这款怎么样')
