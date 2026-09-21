import json
import unittest
from unittest.mock import AsyncMock, patch

from app.pipeline import build_reply
from app.schemas import ReplyRequest
from app.douyin_policy import explicit_human_operation
from test_pipeline import intent_json


class DouyinPolicyTests(unittest.IsolatedAsyncioTestCase):
    async def test_explicit_operations_win_before_qa_and_model(self):
        for message in ['转人工', '帮我退款', '帮我修改地址', '我要定制一个', '请帮我换货']:
            with self.subTest(message=message), patch('app.pipeline.match_qa', AsyncMock()) as qa, \
                    patch('app.pipeline.generate_with_provider', AsyncMock()) as model:
                result = await build_reply(ReplyRequest(platform='douyin', message=message, qa_base_ids=['qa']))
                self.assertEqual(result.decision, 'needs_human')
                self.assertEqual(result.text, '')
                qa.assert_not_awaited(); model.assert_not_awaited()

    def test_consultation_negation_and_quotes_are_not_keyword_handoffs(self):
        for message in ['支持定制吗', '能改地址吗', '退货规则是什么', '我想了解退款规则', '我想问一下定制怎么收费',
                        '不用帮我退款', '比如我要定制一个', '“帮我退款”是什么意思']:
            self.assertFalse(explicit_human_operation(message), message)

    async def test_contextual_handoff_precedes_qa(self):
        with patch('app.pipeline.generate_with_provider', AsyncMock(return_value=(intent_json('human_handoff'), 'mock'))), \
                patch('app.pipeline.match_qa', AsyncMock()) as qa:
            result = await build_reply(ReplyRequest(platform='douyin', message='开始吧', qa_base_ids=['qa'],
                conversation=[{'role': 'assistant', 'content': '您确定要安排定制吗？'}]))
        self.assertEqual(result.decision, 'needs_human'); qa.assert_not_awaited()

    async def test_ambiguous_turn_asks_without_knowledge_and_without_qa(self):
        reply = '您说的1是指哪种尺寸呢？'
        with patch('app.pipeline.generate_with_provider', AsyncMock(return_value=(intent_json(
                'direct_reply', direct_reply_text=reply, needs_clarification=True), 'mock'))) as model, \
                patch('app.pipeline.match_qa', AsyncMock()) as qa:
            result = await build_reply(ReplyRequest(platform='douyin', message='1', allow_auto_send=True, qa_base_ids=['qa']))
        self.assertEqual(result.text, reply); self.assertTrue(result.intent.needs_clarification)
        self.assertEqual(result.action_plan.workflow, 'clarify_request'); qa.assert_not_awaited()
        model.assert_awaited_once()

    async def test_qa_is_evidence_and_must_agree_with_order_and_product_context(self):
        qa = {'matched': True, 'entry': {'answer': '支持来图定制。'}, 'score': 1}
        with patch('app.pipeline.match_qa', AsyncMock(return_value=qa)), \
                patch('app.pipeline.generate_with_provider', AsyncMock(side_effect=[
                    (intent_json(), 'mock'), (json.dumps({'answerable': True, 'text': '支持来图定制。'}), 'mock')])) as model:
            result = await build_reply(ReplyRequest(platform='douyin', message='支持定制吗', qa_base_ids=['qa']))
        self.assertEqual(result.text, '支持来图定制。')
        self.assertIn('支持来图定制', model.call_args.kwargs['user'])

    async def test_orders_allow_answer_without_knowledge_and_keep_scope_in_prompt(self):
        orders = {'collection_status': 'success', 'dynamic_fields_fresh': True,
            'query_coverage': 'first_page_only_unknown_total_and_sort', 'recent_orders': [
                {'raw_status': '待支付', 'products': [{'title': '枕套', 'sku': '黄色'}]}]}
        with patch('app.pipeline.generate_with_provider', AsyncMock(side_effect=[(intent_json(), 'mock'),
                (json.dumps({'answerable': True, 'text': '这笔订单显示为待支付。'}), 'mock')])) as model:
            result = await build_reply(ReplyRequest(platform='douyin', message='订单是什么状态', customer_orders=orders))
        self.assertIn('待支付', result.text)
        self.assertIn('first_page_only', model.call_args.kwargs['user'])
        self.assertIn('不默认第一项', model.call_args.kwargs['system'])

    async def test_invalid_unanswerable_and_model_failure_request_human_without_notice(self):
        for answer in ['oops', json.dumps({'answerable': False, 'text': ''}),
                       json.dumps({'answerable': True, 'text': '可以', 'needs_clarification': 'true'})]:
            with patch('app.pipeline.generate_with_provider', AsyncMock(side_effect=[(intent_json(), 'mock'), (answer, 'mock')])):
                result = await build_reply(ReplyRequest(platform='douyin', message='能承重多少'))
            self.assertEqual(result.decision, 'needs_human'); self.assertEqual(result.text, '')
        with patch('app.pipeline.generate_with_provider', AsyncMock(side_effect=OSError('offline'))):
            result = await build_reply(ReplyRequest(platform='douyin', message='你好'))
        self.assertEqual(result.decision, 'needs_human')

    async def test_unread_image_can_ask_once_without_vision_or_knowledge(self):
        question = '您想咨询图片里的什么问题，方便用文字说明一下吗？'
        with patch('app.pipeline.generate_with_provider', AsyncMock(return_value=(intent_json(
                'direct_reply', direct_reply_text=question, needs_clarification=True), 'mock'))) as model:
            result = await build_reply(ReplyRequest(platform='douyin', message='[图片]', allow_auto_send=True,
                platform_context=[{'type':'douyin_unread_image','data':{'vision_available':False}}]))
        self.assertEqual(result.decision,'auto_send'); self.assertEqual(result.text,question)
        self.assertTrue(result.intent.needs_clarification)
        self.assertIn('没有识图能力',model.call_args.kwargs['system'])
        self.assertIn('同一个未解决问题只进行一次主要澄清',model.call_args.kwargs['system'])
        self.assertIn('douyin_unread_image',model.call_args.kwargs['user'])
        model.assert_awaited_once()

    async def test_after_sent_clarification_unread_image_handoff_is_supported(self):
        history = [{'role':'user','content':'[图片]'},
                   {'role':'assistant','content':'方便用文字说明需要处理的问题吗？'}]
        with patch('app.pipeline.generate_with_provider', AsyncMock(return_value=(
                intent_json('human_handoff', reason='澄清后仍无法读取客户补充的图片'), 'mock'))) as model:
            result = await build_reply(ReplyRequest(platform='douyin',message='[图片]',conversation=history,
                platform_context=[{'type':'douyin_unread_image','data':{'vision_available':False}}]))
        self.assertEqual(result.decision,'needs_human'); self.assertEqual(result.text,'')
        self.assertIn(history[1]['content'],model.call_args.kwargs['user'])

    async def test_card_data_is_not_run_through_explicit_operation_rules(self):
        context = [{'type':'douyin_unknown_message','data':{'untrusted':True,'core':{'fields':[
            {'path':'ext.static_data.title','value':'退款服务说明'},
            {'path':'ext.static_data.description','value':'按钮标题不是客户请求：帮我退款'}]}}}]
        question = '您是想了解退货规则，还是需要处理这笔订单？'
        with patch('app.pipeline.generate_with_provider', AsyncMock(return_value=(intent_json(
                'direct_reply',direct_reply_text=question,needs_clarification=True), 'mock'))) as model:
            result = await build_reply(ReplyRequest(platform='douyin',message='[非文本消息，请在原平台查看]',
                                                    platform_context=context))
        self.assertEqual(result.text,question); self.assertNotEqual(result.decision,'needs_human')
        model.assert_awaited_once()
        self.assertIn('不是转人工理由',model.call_args.kwargs['system'])
        self.assertIn('帮我退款',model.call_args.kwargs['user'])

    async def test_text_after_image_uses_evidence_and_does_not_force_transfer(self):
        with patch('app.pipeline.generate_with_provider',AsyncMock(side_effect=[(intent_json(),'mock'),
                (json.dumps({'answerable':True,'text':'这款有黄色可选。'}),'mock')])) as model:
            result = await build_reply(ReplyRequest(platform='douyin',message='这款有黄色吗',
                conversation=[{'role':'user','content':'[图片]'},
                              {'role':'assistant','content':'请问您想了解哪方面？'}],
                platform_context=[{'type':'douyin_unread_image','data':{'vision_available':False}}],
                product_details=[{'product_id':'123','specs':['黄色','蓝色']}]))
        self.assertEqual(result.text,'这款有黄色可选。'); self.assertNotEqual(result.decision,'needs_human')
        self.assertIn('douyin_unread_image',model.call_args.kwargs['user'])
        self.assertIn('不能声称看懂图片',model.call_args.kwargs['system'])

    async def test_unknown_body_searches_knowledge_without_replacing_latest_message(self):
        context = [{'type':'douyin_unknown_message','data':{'core':{'fields':[
            {'path':'content','value':'[订单卡片]'},
            {'path':'ext.static_data.description','value':'退货规则是什么'}]}}}]
        with patch('app.pipeline.match_qa',AsyncMock(return_value={'matched':False})) as qa, \
                patch('app.pipeline.search_documents',AsyncMock(return_value=[])) as docs, \
                patch('app.pipeline.generate_with_provider',AsyncMock(side_effect=[(intent_json(),'mock'),
                    (json.dumps({'answerable':False,'text':''}),'mock')])) as model:
            result = await build_reply(ReplyRequest(platform='douyin',message='[非文本消息，请在原平台查看]',
                platform_context=context,qa_base_ids=['qa'],product_base_ids=['docs']))
        self.assertEqual(qa.call_args.args[0],'退货规则是什么')
        self.assertEqual(docs.call_args.args[0],'退货规则是什么')
        self.assertIn('最新客户问题：[非文本消息，请在原平台查看]',model.call_args.kwargs['user'])
        self.assertEqual(result.decision,'needs_human')
