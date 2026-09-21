import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.models import Base, User, UserSettings, Robot, RobotPlatformScope, PlatformAccount, Message, RpaTask, AutomationReplyRun, utcnow
from app.schemas.automation import ReplyRunRequest, ReplyRunResponse
from app.schemas.rpa import RpaEventCreate, TaskCompleteRequest
from app.schemas.robot import RobotPlatformScope as ScopeInput, RobotUpdate
from app.services.automation_service import run_reply, _active_robot
from app.services.douyin_automation import live_reply_source
from app.services.rpa_service import create_event, select_inbound_reply_source, get_or_create_desktop_ingest_node, acknowledge_task, complete_task
from app.services.robot_service import _validate_platform_scopes, update_robot, serialize_robot
from app.api.routes.automation import validate_douyin_task
from app.services.message_service import clear_awaiting_reply


class DouyinAutomationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.engine = create_engine('sqlite:///:memory:')
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.user = User(username='douyin-auto', display_name='Test', password_hash='unused')
        self.db.add(self.user)
        self.db.commit()
        self.node = get_or_create_desktop_ingest_node(self.db, self.user)
        self.settings = UserSettings(user_id=self.user.id, auto_reply_enabled=True)
        self.db.add(self.settings)
        self.account = PlatformAccount(user_id=self.user.id, platform_code='douyin', platform_name='抖店',
            external_account_id='shop', account_name='测试店铺', login_status='online', last_rpa_node_id=self.node.id,
            metadata_json={'message_send_enabled': True, 'im_ready': True, 'ai_text_reply_enabled': True})
        self.robot = Robot(user_id=self.user.id, name='测试机器人', enabled=True, status='online',
            config_json={'allow_auto_send': True, 'product_recommend_enabled': True})
        self.db.add_all([self.account, self.robot])
        self.db.flush()
        self.scope = RobotPlatformScope(robot_id=self.robot.id, platform_code='douyin',
            platform_account_id=self.account.id, all_accounts=False)
        self.db.add(self.scope)
        self.db.commit()
        now = utcnow()
        self.payload = {'sender_role': 'customer', 'content': '什么时候发货', 'message_type': 'text',
            'automation_mode': 'trigger', 'platform_sent_at': now.isoformat(), 'observed_at': now.isoformat(),
            'collector_started_at': (now - timedelta(seconds=5)).isoformat(),
            'structured_payload': {'sender_biz_role': 'Buyer', 'collection_source': 'live'}}
        self.request = RpaEventCreate(event_id='new-customer', platform_code='douyin', event_type='customer_message',
            platform_account_id=self.account.id, conversation_external_id='buyer:shop::2:1:pigeon',
            platform_message_id='server-inbound-1', payload_json=self.payload)
        _, self.messages, conversations = create_event(self.db, self.user, self.node, self.request)
        self.conversation = conversations[0]
        self.source = self.messages[0]

    def tearDown(self):
        self.db.close()
        self.engine.dispose()

    async def generate(self, side_effect=None):
        result = {'decision': 'auto_send', 'text': '一般会在两天内发货', 'confidence': 1.0,
            'provider': 'test-ai', 'trace_id': 'douyin-test', 'intent': {}, 'risk_flags': [],
            'media': [{'type': 'image', 'url': 'https://example.test/image.png'}],
            'model_call_details': [], 'retrieval': [], 'qa_match': None}
        async def decide(**kwargs):
            self.assertEqual(kwargs['platform'], 'douyin')
            self.assertEqual(kwargs['message'], self.source.content)
            self.assertEqual(kwargs['robot_read'].id, self.robot.id)
            if side_effect:
                side_effect()
            return result
        with patch('app.services.automation_service._decide_reply', new=AsyncMock(side_effect=decide)) as mock:
            reply = await run_reply(self.db, self.user, ReplyRunRequest(conversation_id=self.conversation.id,
                source_message_id=self.source.id, allow_auto_send=True))
        ReplyRunResponse.model_validate(reply)
        return reply, mock

    async def test_order_read_task_does_not_block_automatic_text_reply(self):
        self.db.add(RpaTask(user_id=self.user.id, platform_account_id=self.account.id,
            conversation_id=self.conversation.id, platform_code='douyin',
            task_type='refresh_customer_orders', status='acknowledged', payload_json={}))
        self.db.commit()
        reply, _ = await self.generate()
        task = self.db.get(RpaTask, reply['task_ids'][0])
        self.assertEqual(task.task_type, 'send_message')
        acknowledge_task(self.db, task)
        self.assertTrue(validate_douyin_task(task.id, self.user, self.db)['allowed'])

    async def test_live_customer_reuses_ai_and_text_send_then_echo_merges(self):
        self.assertEqual(select_inbound_reply_source(self.db, self.request, self.messages), self.source)
        reply, mock = await self.generate()
        mock.assert_awaited_once()
        task = self.db.get(RpaTask, reply['task_ids'][0])
        self.assertEqual(task.node_id, self.node.id)
        self.assertEqual(task.payload_json['source'], 'automation')
        self.assertNotIn('follow_up', task.payload_json)
        self.assertNotIn('follow_up_products', task.payload_json)
        self.assertEqual(task.payload_json['automation_robot_id'], self.robot.id)
        acknowledge_task(self.db, task)
        self.assertTrue(validate_douyin_task(task.id, self.user, self.db)['allowed'])
        echo = self.request.model_copy(update={'event_id': 'echo', 'event_type': 'agent_message',
            'platform_message_id': 'server-outbound', 'payload_json': {**self.payload,
                'sender_role': 'agent', 'content': '一般会在两天内发货', 'automation_mode': 'ignore',
                'structured_payload': {'sender_biz_role': 'CurrentServer'}}})
        create_event(self.db, self.user, self.node, echo)
        complete_task(self.db, task, TaskCompleteRequest(status='completed', result_json={
            'platform_message_id': 'server-outbound', 'text_sent': True, 'response_status': '0', 'check_code': '0'}))
        self.assertEqual(len(self.db.scalars(select(Message).where(Message.sender_role == 'agent')).all()), 1)
        run = self.db.scalar(select(AutomationReplyRun))
        self.assertEqual(run.reply_message_id, task.message_id)
        self.assertFalse(self.conversation.awaiting_reply)
        self.assertFalse(validate_douyin_task(task.id, self.user, self.db)['allowed'])

    def test_only_new_live_reply_source_triggers_including_queue_replay_age(self):
        now = utcnow()
        self.assertTrue(live_reply_source(self.payload, 'id', now=now))
        changes = [ {'automation_mode': 'ignore'}, {'message_type': 'unknown'}, {'sender_role': 'agent'},
            {'platform_sent_at': None}, {'collector_started_at': (now + timedelta(seconds=1)).isoformat()},
            {'structured_payload': {'sender_biz_role': 'Buyer', 'collection_source': 'compensation'}},
            {'structured_payload': {'sender_biz_role': 'Robot', 'collection_source': 'live'}} ]
        for change in changes:
            with self.subTest(change=change):
                self.assertFalse(live_reply_source({**self.payload, **change}, 'id', now=now))
        self.assertFalse(live_reply_source(self.payload, '', now=now))
        self.assertFalse(live_reply_source(self.payload, 'id', now=now + timedelta(minutes=6)))
        _, duplicates, _ = create_event(self.db, self.user, self.node, self.request)
        self.assertEqual(duplicates, [])

    async def test_images_and_ignored_cards_survive_reload_without_reply(self):
        for role in ('customer', 'agent'):
            for kind in ('product', 'image'):
                with self.subTest(role=role, kind=kind):
                    key = f'{role}-{kind}'
                    structured = {**self.payload['structured_payload'],
                        'sender_biz_role': 'Buyer' if role == 'customer' else 'CurrentServer',
                        'image_url': 'https://cdn.example.test/image.jpg?signature=fixture'}
                    if kind == 'product':
                        structured.update(title='测试商品', product_id='9007199254740993001', price_label='¥155.00')
                    payload = {**self.payload, 'sender_role': role, 'message_type': kind,
                        'content': '[商品] 测试商品' if kind == 'product' else '[图片]',
                        'display_mode': 'card' if kind == 'product' else 'bubble',
                        'structured_payload': structured, 'platform_sent_at': utcnow().isoformat(),
                        'automation_mode': 'ignore' if kind == 'product' else 'trigger'}
                    # Even an erroneous client trigger must be rejected server-side.
                    request = self.request.model_copy(update={'event_id': key, 'platform_message_id': key,
                        'event_type': 'customer_message' if role == 'customer' else 'agent_message',
                        'payload_json': payload})
                    _, messages, _ = create_event(self.db, self.user, self.node, request)
                    self.assertEqual(len(messages), 1)
                    self.assertIsNone(select_inbound_reply_source(self.db, request, messages))
                    message_id = messages[0].id
                    self.db.commit()
                    self.db.expire_all()
                    self.source = self.db.get(Message, message_id)
                    self.assertEqual(self.source.raw_payload['structured_payload'],
                                     {**structured, **({'vision_available': False} if kind == 'image' else {})})
                    self.assertEqual(self.source.raw_payload['display_mode'], payload['display_mode'])
                    self.assertEqual(self.source.sender_role, role)
                    if role == 'customer':
                        reply, mock = await self.generate()
                        mock.assert_not_awaited()
                        self.assertEqual(reply['task_ids'], [])
                    else:
                        with patch('app.services.automation_service._decide_reply', new_callable=AsyncMock) as mock:
                            with self.assertRaises(HTTPException) as error:
                                await run_reply(self.db, self.user, ReplyRunRequest(conversation_id=self.conversation.id,
                                    source_message_id=self.source.id, allow_auto_send=True))
                            self.assertEqual(error.exception.status_code, 409)
                            mock.assert_not_awaited()
                    count = self.db.query(Message).count()
                    create_event(self.db, self.user, self.node, request.model_copy(update={'event_id': key + '-replay'}))
                    self.assertEqual(self.db.query(Message).count(), count)
        self.assertEqual(self.db.query(RpaTask).count(), 0)

    def ingest_product(self, key='product', role='customer', mode='trigger', collection_source='live'):
        payload = {**self.payload, 'message_type': 'product', 'content': '[商品] 测试水杯',
            'sender_role': role, 'automation_mode': mode, 'platform_sent_at': utcnow().isoformat(),
            'structured_payload': {'sender_biz_role': 'Buyer' if role == 'customer' else 'CurrentServer',
                'collection_source': collection_source, 'title': '测试水杯',
                'product_id': '9007199254740993001', 'price_label': '¥155.00',
                'image_url': 'https://cdn.example.test/photo?signature=private', 'buyer_id': 'private-buyer'}}
        request = self.request.model_copy(update={'event_id': key, 'platform_message_id': key,
            'event_type': 'customer_message' if role == 'customer' else 'agent_message', 'payload_json': payload})
        _, messages, _ = create_event(self.db, self.user, self.node, request)
        return request, messages

    async def test_product_card_uses_configured_ack_and_validates_send_once(self):
        self.robot.config_json = {'allow_auto_send': True, 'product_card_ack_text': '亲，这款想了解什么呢'}
        self.db.commit()
        request, messages = self.ingest_product()
        self.source = messages[0]
        self.assertEqual(select_inbound_reply_source(self.db, request, messages), self.source)
        reply, mock = await self.generate()
        mock.assert_not_awaited()
        self.assertEqual(reply['provider'], 'product-card-rule')
        self.assertEqual(reply['text'], '亲，这款想了解什么呢')
        self.assertEqual(len(reply['task_ids']), 1)
        task = self.db.get(RpaTask, reply['task_ids'][0])
        self.assertNotIn('follow_up_products', task.payload_json)
        acknowledge_task(self.db, task)
        self.assertTrue(validate_douyin_task(task.id, self.user, self.db)['allowed'])
        complete_task(self.db, task, TaskCompleteRequest(status='completed', result_json={
            'platform_message_id': 'ack-outbound', 'text_sent': True, 'response_status': '0', 'check_code': '0'}))
        _, duplicates, _ = create_event(self.db, self.user, self.node, request)
        self.assertEqual(duplicates, [])
        self.assertEqual(self.db.query(RpaTask).filter(RpaTask.task_type == 'send_message').count(), 1)
        self.assertEqual(self.db.query(AutomationReplyRun).count(), 1)

    async def test_product_context_reaches_model_for_following_text(self):
        # Old-version/compensation cards remain useful context, but never trigger.
        self.ingest_product('history-product', mode='ignore', collection_source='compensation')
        self.ingest_product('agent-product', role='agent', mode='ignore')
        self.ingest_product('live-product')
        request = self.request.model_copy(update={'event_id': 'question', 'platform_message_id': 'question',
            'payload_json': {**self.payload, 'content': '这个有货吗', 'platform_sent_at': utcnow().isoformat()}})
        _, messages, _ = create_event(self.db, self.user, self.node, request)
        self.source = messages[0]
        _, mock = await self.generate()
        mock.assert_awaited_once()
        context = mock.call_args.kwargs['platform_context']
        self.assertEqual(len(context), 3)
        self.assertEqual([item['sender_role'] for item in context], ['customer', 'agent', 'customer'])
        self.assertTrue(all(item['data'] == {'title': '测试水杯', 'product_id': '9007199254740993001',
            'price_label': '¥155.00'} for item in context))
        self.assertNotIn('private', str(context))
        history = mock.call_args.kwargs['history']
        self.assertTrue(any(item['content'] == '[商品] 测试水杯' for item in history))
        self.assertEqual(history[-1]['content'], '这个有货吗')

    async def test_product_detail_card_and_followup_reach_ai_and_send_once(self):
        from app.services.douyin_product_detail_service import apply_detail
        from tests.test_douyin_product_details import detail_payload
        payload = detail_payload('9007199254740993001'); payload['shop_id'] = 'shop'
        apply_detail(self.db, self.account, payload); self.db.commit()
        _, messages = self.ingest_product()
        self.source = messages[0]
        reply, mock = await self.generate()
        mock.assert_awaited_once()
        self.assertTrue(mock.call_args.kwargs['product_card_only'])
        self.assertEqual(mock.call_args.kwargs['product_details'][0]['attributes'][0]['values'], ['PBT'])
        self.assertEqual(len(reply['task_ids']), 1)
        task = self.db.get(RpaTask, reply['task_ids'][0])
        complete_task(self.db, task, TaskCompleteRequest(status='completed', result_json={
            'platform_message_id': 'detail-reply', 'text_sent': True, 'response_status': '0', 'check_code': '0'}))
        _, messages, _ = create_event(self.db, self.user, self.node, self.request.model_copy(update={
            'event_id': 'attribute-question', 'platform_message_id': 'attribute-question',
            'payload_json': {**self.payload, 'content': '是什么材质', 'platform_sent_at': utcnow().isoformat()}}))
        self.source = messages[0]
        followup, model = await self.generate()
        self.assertFalse(model.call_args.kwargs['product_card_only'])
        self.assertEqual(model.call_args.kwargs['product_details'][0]['product_id'], payload['product_id'])
        self.assertEqual(len(followup['task_ids']), 1)
        self.assertEqual(self.db.query(RpaTask).filter(RpaTask.task_type == 'refresh_product_details').count(), 0)

    async def test_newer_customer_during_detail_wait_blocks_outdated_reply(self):
        from app.services.douyin_product_detail_service import apply_detail
        from tests.test_douyin_product_details import detail_payload
        _, messages = self.ingest_product()
        self.source = messages[0]
        async def collect(_):
            payload = detail_payload('9007199254740993001'); payload['shop_id'] = 'shop'
            apply_detail(self.db, self.account, payload); self.db.commit()
            create_event(self.db, self.user, self.node, self.request.model_copy(update={
                'event_id': 'new-during-details', 'platform_message_id': 'new-during-details',
                'payload_json': {**self.payload, 'platform_sent_at': utcnow().isoformat()}}))
        with patch('app.services.douyin_product_detail_service.asyncio.sleep', AsyncMock(side_effect=collect)):
            reply, _ = await self.generate()
        self.assertEqual(reply['task_ids'], [])
        self.assertEqual(self.db.query(RpaTask).filter(RpaTask.task_type == 'send_message').count(), 0)

    async def test_product_replay_and_newer_message_still_block_send(self):
        request, messages = self.ingest_product()
        source = messages[0]
        for change in ({'automation_mode': 'ignore'},
            {'structured_payload': {**request.payload_json['structured_payload'], 'collection_source': 'compensation'}},
            {'platform_sent_at': (utcnow() - timedelta(minutes=6)).isoformat()}):
            self.assertFalse(live_reply_source({**request.payload_json, **change}, source.platform_message_id))
        self.source = source
        reply, _ = await self.generate()
        task = self.db.get(RpaTask, reply['task_ids'][0])
        acknowledge_task(self.db, task)
        create_event(self.db, self.user, self.node, self.request.model_copy(update={
            'event_id': 'new-question', 'platform_message_id': 'new-question',
            'payload_json': {**self.payload, 'platform_sent_at': utcnow().isoformat()}}))
        self.assertFalse(validate_douyin_task(task.id, self.user, self.db)['allowed'])

    def test_real_hello_clock_skew_triggers_at_ingestion(self):
        payload = {**self.payload,
            'collector_started_at': '2026-09-11T10:40:58.156Z',
            'observed_at': '2026-09-11T10:42:57.802Z',
            'platform_sent_at': '2026-09-11T10:42:57.942Z'}
        inserted_at = datetime(2026, 9, 11, 10, 42, 57, 831696, tzinfo=timezone.utc)
        self.source.raw_payload = payload
        with patch('app.services.douyin_automation.utcnow', return_value=inserted_at):
            self.assertEqual(select_inbound_reply_source(self.db, self.request, [self.source]), self.source)
        self.assertTrue(live_reply_source(payload, 'id', now=inserted_at + timedelta(seconds=3)))

    def test_clock_tolerance_boundaries_and_replay_expiry(self):
        observed = datetime(2026, 9, 11, 10, 42, 57, tzinfo=timezone.utc)
        payload = {**self.payload, 'observed_at': observed.isoformat(),
            'collector_started_at': (observed - timedelta(seconds=600)).isoformat()}
        for offset, allowed in [(5, True), (5.001, False), (-300, True), (-300.001, False)]:
            with self.subTest(offset=offset):
                candidate = {**payload, 'platform_sent_at': (observed + timedelta(seconds=offset)).isoformat()}
                self.assertEqual(live_reply_source(candidate, 'id', now=observed), allowed)
        for offset, allowed in [(-5, True), (-5.001, False)]:
            candidate = {**payload, 'collector_started_at': observed.isoformat(),
                'platform_sent_at': (observed + timedelta(seconds=offset)).isoformat()}
            self.assertEqual(live_reply_source(candidate, 'id', now=observed), allowed)
            compensation = {**candidate, 'structured_payload': {
                'sender_biz_role': 'Buyer', 'collection_source': 'compensation'}}
            self.assertFalse(live_reply_source(compensation, 'id', now=observed))
        candidate = {**payload, 'platform_sent_at': (observed + timedelta(seconds=5)).isoformat()}
        self.assertFalse(live_reply_source(candidate, 'id', now=observed + timedelta(seconds=301)),
            'platform clock tolerance must not extend the local queue replay window')
        self.assertFalse(live_reply_source({**candidate, 'observed_at': None}, 'id', now=observed))

    async def test_all_platform_scope_requires_explicit_douyin_assignment(self):
        self.scope.platform_code = 'all'
        self.scope.all_accounts = True
        self.db.commit()
        self.assertIsNone(_active_robot(self.db, self.user, self.conversation))
        self.scope.platform_code = 'douyin'
        self.db.commit()
        self.assertEqual(_active_robot(self.db, self.user, self.conversation), self.robot)

    async def test_auto_send_off_only_generates_suggestion(self):
        self.robot.config_json = {'allow_auto_send': False}
        self.db.commit()
        reply, mock = await self.generate()
        mock.assert_awaited_once()
        self.assertEqual(reply['task_ids'], [])
        self.assertEqual(self.db.scalars(select(RpaTask)).all(), [])

    async def test_pause_during_generation_prevents_queue(self):
        def pause():
            self.account.login_status = 'paused'
            self.db.commit()
        reply, _ = await self.generate(pause)
        self.assertEqual(reply['decision'], 'no_reply')
        self.assertEqual(reply['task_ids'], [])

    async def test_manual_reply_during_generation_prevents_queue(self):
        def reply_manually():
            echo = self.request.model_copy(update={'event_id': 'human', 'event_type': 'agent_message',
                'platform_message_id': 'human-1', 'payload_json': {**self.payload, 'sender_role': 'agent',
                    'automation_mode': 'ignore', 'content': '人工已回复', 'platform_sent_at': utcnow().isoformat()}})
            create_event(self.db, self.user, self.node, echo)
        reply, _ = await self.generate(reply_manually)
        self.assertEqual(reply['task_ids'], [])

    async def test_final_validation_blocks_disable_handoff_and_newer_customer(self):
        reply, _ = await self.generate()
        task = self.db.get(RpaTask, reply['task_ids'][0])
        acknowledge_task(self.db, task)
        self.assertTrue(validate_douyin_task(task.id, self.user, self.db)['allowed'])
        self.robot.enabled = False
        self.db.commit()
        self.assertFalse(validate_douyin_task(task.id, self.user, self.db)['allowed'])
        self.robot.enabled = True
        self.settings.auto_reply_enabled = False
        self.db.commit()
        self.assertFalse(validate_douyin_task(task.id, self.user, self.db)['allowed'])
        self.settings.auto_reply_enabled = True
        self.conversation.human_required = True
        self.db.commit()
        self.assertFalse(validate_douyin_task(task.id, self.user, self.db)['allowed'])
        self.conversation.human_required = False
        self.db.commit()
        create_event(self.db, self.user, self.node, self.request.model_copy(update={
            'event_id': 'newer', 'platform_message_id': 'newer',
            'payload_json': {**self.payload, 'platform_sent_at': utcnow().isoformat()}}))
        self.assertFalse(validate_douyin_task(task.id, self.user, self.db)['allowed'])

    async def test_pending_send_does_not_start_another_generation(self):
        reply, _ = await self.generate()
        acknowledge_task(self.db, self.db.get(RpaTask, reply['task_ids'][0]))
        again, mock = await self.generate()
        mock.assert_not_awaited()
        self.assertEqual(again['task_ids'], [])

    def test_shop_scope_checks_owner_and_platform(self):
        scope = ScopeInput(platform_code='douyin', platform_account_id=self.account.id, all_accounts=False)
        self.assertEqual(_validate_platform_scopes(self.db, self.user, [scope]), [scope])
        with self.assertRaises(HTTPException):
            _validate_platform_scopes(self.db, self.user, [scope.model_copy(update={'platform_code': 'pinduoduo'})])
        other = User(username='other', display_name='Other', password_hash='unused')
        self.db.add(other)
        self.db.commit()
        with self.assertRaises(HTTPException):
            _validate_platform_scopes(self.db, other, [scope])

    def test_robot_shop_scope_save_and_reload_uses_account_id(self):
        other_shop = PlatformAccount(user_id=self.user.id, platform_code='douyin', platform_name='抖店',
            external_account_id='other', account_name=self.account.account_name)
        self.db.add(other_shop)
        self.db.commit()
        update_robot(self.db, self.user, self.robot.id, RobotUpdate(platform_scopes=[
            ScopeInput(platform_code='douyin', platform_account_id=other_shop.id)]))
        saved = serialize_robot(self.db, self.robot)
        self.assertEqual(saved.platform_scopes[0].platform_account_id, other_shop.id)
        self.assertIsNone(_active_robot(self.db, self.user, self.conversation))
        update_robot(self.db, self.user, self.robot.id, RobotUpdate(platform_scopes=[
            ScopeInput(platform_code='douyin', all_accounts=True)]))
        self.assertEqual(_active_robot(self.db, self.user, self.conversation), self.robot)

    async def test_final_suppression_does_not_mark_send_failure(self):
        reply, _ = await self.generate()
        task = self.db.get(RpaTask, reply['task_ids'][0])
        acknowledge_task(self.db, task)
        self.robot.enabled = False
        self.db.commit()
        complete_task(self.db, task, TaskCompleteRequest(status='failed',
            result_json={'auto_send_suppressed': True}, error_message='机器人已暂停'))
        self.assertFalse(self.conversation.human_required)
        self.assertEqual(self.db.get(Message, task.message_id).message_status, 'failed')

    async def test_clearing_reminder_before_generation_and_dispatch_does_not_cancel(self):
        # Opening a conversation clears the same reminder as the old UI's
        # generation-completed handler; neither proves a human has replied.
        clear_awaiting_reply(self.db, self.user, self.conversation.id)
        self.assertFalse(self.conversation.awaiting_reply)
        reply, mock = await self.generate()
        mock.assert_awaited_once()
        task = self.db.get(RpaTask, reply['task_ids'][0])
        clear_awaiting_reply(self.db, self.user, self.conversation.id)
        self.assertEqual(self.conversation.metadata_json['awaiting_reply_cleared_sequence'],
            self.db.get(Message, task.message_id).conversation_sequence)
        # Use a fresh session just like the real desktop validation HTTP call.
        with Session(self.engine) as dispatch_db:
            dispatched_task = dispatch_db.get(RpaTask, task.id)
            acknowledge_task(dispatch_db, dispatched_task)
            self.assertTrue(validate_douyin_task(task.id, self.user, dispatch_db)['allowed'])
            complete_task(dispatch_db, dispatched_task, TaskCompleteRequest(status='completed', result_json={
                'platform_message_id': 'delivered-after-reminder-clear', 'text_sent': True,
                'response_status': '0', 'check_code': '0'}))
            self.assertEqual(dispatch_db.get(Message, dispatched_task.message_id).message_status, 'sent')

    async def test_real_human_reply_after_queue_still_cancels_with_reminder_cleared(self):
        reply, _ = await self.generate()
        task = self.db.get(RpaTask, reply['task_ids'][0])
        clear_awaiting_reply(self.db, self.user, self.conversation.id)
        echo = self.request.model_copy(update={'event_id': 'human-after-queue', 'event_type': 'agent_message',
            'platform_message_id': 'human-after-queue', 'payload_json': {**self.payload,
                'sender_role': 'agent', 'content': '人工已回复', 'automation_mode': 'ignore',
                'platform_sent_at': utcnow().isoformat()}})
        create_event(self.db, self.user, self.node, echo)
        acknowledge_task(self.db, task)
        result = validate_douyin_task(task.id, self.user, self.db)
        self.assertFalse(result['allowed'])
        self.assertEqual(result['reason'], '客户或人工客服已有更新消息')

    async def test_actual_send_failure_requires_human_review(self):
        reply, _ = await self.generate()
        task = self.db.get(RpaTask, reply['task_ids'][0])
        acknowledge_task(self.db, task)
        complete_task(self.db, task, TaskCompleteRequest(status='failed', error_message='平台拒绝'))
        self.assertTrue(self.conversation.human_required)
        self.assertEqual(self.conversation.human_required_reason, 'auto_reply_send_failed')

    async def test_sensitive_word_notice_can_send_before_handoff_blocks_later_replies(self):
        self.robot.config_json = {'allow_auto_send': True, 'inbound_sensitive_words': ['发货']}
        self.db.commit()
        reply, mock = await self.generate()
        mock.assert_not_awaited()
        self.assertTrue(self.conversation.human_required)
        task = self.db.get(RpaTask, reply['task_ids'][0])
        acknowledge_task(self.db, task)
        self.assertTrue(validate_douyin_task(task.id, self.user, self.db)['allowed'])
