import asyncio
import json
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from tests import test_douyin_automation as fixture
from tests import test_douyin_auto_transfer as transfer_fixture
from app.models import Message, RpaTask
from app.schemas.automation import ReplyRunRequest
from app.schemas.rpa import TaskCompleteRequest
from app.services.automation_service import run_reply, _platform_context, _message_history
from app.services.douyin_message_context import sanitize_core, prompt_context, order_hint
from app.services.douyin_automation import live_reply_source
from app.services.rpa_service import create_event, select_inbound_reply_source, acknowledge_task, complete_task


def structured(kind='unknown', fields=None):
    return {'sender_biz_role': 'Buyer', 'collection_source': 'live', 'raw_type': 1000,
            'platform_message_type': 'file_image' if kind == 'image' else 'template_card',
            'chat_context_eligible': True,
            **({'image_url': 'https://cdn.test/a?signature=secret'} if kind == 'image' else {
                'message_core': {'version': 1, 'fields': fields or [], 'truncated': False}})}


class CoreTests(unittest.TestCase):
    def test_sanitization_keeps_evidence_not_actions_or_private_fields(self):
        fields = [{'path': p, 'value': v} for p, v in [
            ('ext.static_data.order_id', '13800138000'), ('ext.static_data.status', 7),
            ('ext.static_data.buttons.0.text', '申请退款'), ('ext.static_data.token.content', 'secret'),
            ('ext.static_data.receiver_address', 'secret'), ('ext.static_data.image_url', 'secret'),
            ('ext.static_data.description', '电话13800138000 https://example.test/?token=secret'),
            ('ext.static_data.extra', 'secret')]]
        result = sanitize_core({'version': 1, 'fields': fields})
        encoded = json.dumps(result, ensure_ascii=False)
        self.assertNotIn('secret', encoded); self.assertNotIn('申请退款', encoded)
        self.assertEqual(result['fields'][0]['value'], '13800138000')
        self.assertEqual(result['fields'][1]['value'], 7)
        result = sanitize_core({'version': 1, 'fields': [{'path': 'content', 'value': 'x'*2000}]*50})
        self.assertTrue(result['truncated']); self.assertLessEqual(len(json.dumps(result, ensure_ascii=False)), 4096)
        result = sanitize_core({'version':1,'fields':[
            {'path':'ext.static_data.title','value':'修改地址申请'},
            {'path':'ext.static_data.details.0.label','value':'收货地址'},
            {'path':'ext.static_data.details.0.value','value':'private-home'}]})
        self.assertIn('修改地址申请',json.dumps(result,ensure_ascii=False))
        self.assertNotIn('private-home',json.dumps(result))

    def test_image_context_never_sends_image_url_or_claims_vision(self):
        msg = SimpleNamespace(platform_code='douyin', sender_role='customer', id='image',
            raw_payload={'message_type': 'image', 'sender_role': 'customer', 'structured_payload': structured('image')})
        context = prompt_context(msg)
        self.assertFalse(context['data']['vision_available'])
        self.assertNotIn('signature', json.dumps(context)); self.assertNotIn('cdn.test', json.dumps(context))


class MessageContextTests(unittest.IsolatedAsyncioTestCase):
    setUp = fixture.DouyinAutomationTests.setUp
    tearDown = fixture.DouyinAutomationTests.tearDown

    def receive(self, kind='unknown', fields=None, changes=None):
        payload = {**self.payload, 'message_type': kind, 'content': '[图片]' if kind == 'image' else '[订单卡片]',
                   'structured_payload': structured(kind, fields)}
        payload.update(changes or {})
        request = self.request.model_copy(update={'event_id': 'core-'+kind,
            'platform_message_id': 'core-'+kind, 'payload_json': payload})
        _, rows, _ = create_event(self.db, self.user, self.node, request)
        self.source = rows[0]
        return request

    async def test_image_reaches_ai_sends_clarification_and_revalidates(self):
        request = self.receive('image')
        self.assertEqual(select_inbound_reply_source(self.db, request, [self.source]), self.source)
        with patch('app.services.automation_service._decide_reply', AsyncMock(return_value={
                'decision': 'auto_send', 'text': '您想咨询图片里的什么内容，可以文字说明一下吗？',
                'intent': {'needs_clarification': True}, 'confidence': 1, 'provider': 'mock', 'trace_id': 'image'})) as ai:
            result = await run_reply(self.db, self.user, ReplyRunRequest(conversation_id=self.conversation.id,
                source_message_id=self.source.id, allow_auto_send=True))
        context = ai.call_args.kwargs['platform_context'][-1]
        self.assertEqual(context['type'], 'douyin_unread_image')
        self.assertNotIn('signature', json.dumps(context))
        task = self.db.get(RpaTask, result['task_ids'][0]); acknowledge_task(self.db, task)
        self.assertTrue(fixture.validate_douyin_task(task.id, self.user, self.db)['allowed'])
        _, rows, _ = create_event(self.db, self.user, self.node, request)
        self.assertEqual(rows, [])

    async def test_unknown_core_persists_and_enters_latest_and_followup_context(self):
        request = self.receive(fields=[{'path':'ext.static_data.title','value':'测试卡片'},
                                      {'path':'ext.static_data.buttons.0.text','value':'帮我退款'}])
        self.db.expire_all()
        source = self.db.get(Message, self.source.id)
        self.assertEqual(source.content, '[非文本消息，请在原平台查看]')
        context = _platform_context([source])
        self.assertIn('测试卡片', json.dumps(context, ensure_ascii=False))
        self.assertNotIn('帮我退款', json.dumps(context, ensure_ascii=False))
        with patch('app.services.automation_service._decide_reply', AsyncMock(return_value={
                'decision':'auto_send','text':'您想了解哪方面？','intent':{'needs_clarification':True},
                'confidence':1,'provider':'mock','trace_id':'card'})) as ai:
            result = await run_reply(self.db, self.user, ReplyRunRequest(conversation_id=self.conversation.id,
                source_message_id=source.id, allow_auto_send=True))
        self.assertEqual(ai.call_args.kwargs['platform_context'], context)
        self.assertEqual(self.db.get(RpaTask,result['task_ids'][0]).task_type,'send_message')
        # Historical context is usable, but cannot become a fresh trigger.
        source.raw_payload = {**source.raw_payload,'automation_mode':'ignore',
            'structured_payload':{**source.raw_payload['structured_payload'],'collection_source':'compensation'}}
        self.assertFalse(live_reply_source(source.raw_payload,source.platform_message_id))
        self.assertTrue(_platform_context([source])); self.assertTrue(_message_history([source]))

    def test_control_unknown_identity_old_protocol_are_not_triggers(self):
        for change in [{'platform_message_type':'transfer_event'}, {'raw_type':2000},
                       {'sender_biz_role':'Robot'}, {'chat_context_eligible':False},
                       {'collection_source':'compensation'}]:
            payload = {**self.payload,'message_type':'unknown','structured_payload':{**structured(),**change}}
            self.assertFalse(live_reply_source(payload,'valid-id'), change)

    async def test_order_card_refresh_uses_existing_scope_not_unverified_order_id(self):
        self.receive(fields=[{'path':'ext.static_data.order_id','value':'1234567890123456789'}])
        self.assertTrue(order_hint(self.source))
        self.account.external_account_id = '123'
        self.conversation.external_conversation_id = 'buyer:123::2:1:pigeon'
        self.db.commit()
        from app.services.douyin_order_context import refresh_before_reply
        result = await refresh_before_reply(self.db,self.user,self.conversation,self.source,timeout_seconds=0)
        self.assertTrue(result['attempted']); self.assertTrue(result['current_state_unverified'])
        task = self.db.get(RpaTask,result['task_id'])
        self.assertEqual(task.task_type,'refresh_customer_orders')
        self.assertNotIn('1234567890123456789',json.dumps(task.payload_json))


class UnreadHandoffTests(unittest.TestCase):
    setUp = transfer_fixture.DouyinAutoTransferTests.setUp
    tearDown = transfer_fixture.DouyinAutoTransferTests.tearDown
    add_customer = transfer_fixture.DouyinAutoTransferTests.add_customer

    def test_after_clarification_unread_image_can_transfer_and_no_target_allows_next_text(self):
        self.source.content = '[图片]'
        self.source.raw_payload = {**self.source.raw_payload,'content':'[图片]',
            'message_type':'image','structured_payload':structured('image')}
        self.db.commit()
        async def reply(result, source):
            with patch('app.services.automation_service._decide_reply',AsyncMock(return_value=result)):
                return await run_reply(self.db,self.user,ReplyRunRequest(conversation_id=self.c.id,
                    source_message_id=source.id,allow_auto_send=True))
        common = {'confidence':1,'provider':'mock','trace_id':'unread','intent':{}}
        result = asyncio.run(reply({**common,'decision':'auto_send','text':'请用文字说明需要处理的问题。',
                                   'intent':{'needs_clarification':True}}, self.source))
        notice = self.db.get(RpaTask,result['task_ids'][0])
        acknowledge_task(self.db,notice)
        complete_task(self.db,notice,TaskCompleteRequest(status='completed',result_json={
            'platform_message_id':'clarification-sent','text_sent':True,'response_status':'0','check_code':'0'}))
        source = self.add_customer('[图片]')
        source.raw_payload = {**source.raw_payload,'message_type':'image','structured_payload':structured('image')}
        self.db.commit()
        result = asyncio.run(reply({**common,'decision':'needs_human','text':'',
            'intent':{'intent':'human_handoff','reason':'同一问题澄清后仍只有未识图图片'}},source))
        task = self.db.get(RpaTask,result['task_ids'][0])
        self.assertEqual(task.task_type,'douyin_transfer_prepare')
        acknowledge_task(self.db,task)
        complete_task(self.db,task,TaskCompleteRequest(status='completed',result_json={'status':'no_online_target'}))
        self.assertFalse(self.c.human_required)
        next_source = self.add_customer('你好')
        result = asyncio.run(reply({**common,'decision':'auto_send','text':'您好'},next_source))
        self.assertEqual(self.db.get(RpaTask,result['task_ids'][0]).task_type,'send_message')
