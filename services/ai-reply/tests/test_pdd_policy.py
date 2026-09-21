import json
import unittest
from unittest.mock import AsyncMock, patch

from app.pipeline import build_reply
from app.schemas import ReplyRequest


def intent(kind='normal_question', **kwargs):
    return json.dumps({'intent': kind, 'reply_route': {'normal_question': 'retrieve_product',
        'direct_reply': 'direct', 'human_handoff': 'human_handoff'}[kind], 'confidence': 1, **kwargs})


class PddPolicyTests(unittest.IsolatedAsyncioTestCase):
    async def test_unread_image_clarifies_before_qa_and_without_vision(self):
        with patch('app.pipeline.generate_with_provider', AsyncMock(return_value=(intent('direct_reply',
                needs_clarification=True, direct_reply_text='您想咨询图片里的什么问题呢？'), 'mock'))) as model, \
                patch('app.pipeline.match_qa', AsyncMock()) as qa:
            result = await build_reply(ReplyRequest(platform='pinduoduo', message='[图片]', qa_base_ids=['qa'],
                platform_context=[{'type': 'pdd_unread_image', 'data': {'vision_available': False}}]))
        self.assertTrue(result.intent.needs_clarification)
        self.assertEqual(result.action_plan.workflow, 'clarify_request')
        qa.assert_not_awaited()
        self.assertIn('没有识图能力', model.call_args.kwargs['system'])

    async def test_same_unresolved_image_after_clarification_can_handoff(self):
        with patch('app.pipeline.generate_with_provider', AsyncMock(return_value=(intent('human_handoff'), 'mock'))) as model:
            result = await build_reply(ReplyRequest(platform='pinduoduo', message='[图片]',
                conversation=[{'role': 'assistant', 'content': '请用文字说明要处理的问题。'}]))
        self.assertEqual(result.decision, 'needs_human'); self.assertEqual(result.text, '')
        self.assertIn('请用文字说明', model.call_args.kwargs['user'])

    async def test_actual_operation_beats_qa(self):
        with patch('app.pipeline.match_qa', AsyncMock()) as qa:
            result = await build_reply(ReplyRequest(platform='pinduoduo', message='帮我申请退款', qa_base_ids=['qa']))
        qa.assert_not_awaited(); self.assertEqual(result.decision, 'needs_human')

    async def test_unknown_body_is_evidence_not_operation_or_raw_qa_answer(self):
        context = [{'type': 'pdd_unknown_message', 'data': {'core': {'fields': [
            {'path': 'info.description', 'value': '退款规则是什么'}]}}}]
        with patch('app.pipeline.generate_with_provider', AsyncMock(side_effect=[(intent(), 'mock'),
                (json.dumps({'answerable': True, 'text': '请问您想了解哪笔订单的规则？', 'needs_clarification': True}), 'mock')])) as model, \
                patch('app.pipeline.match_qa', AsyncMock(return_value={'matched': True, 'score': 1,
                    'entry': {'answer': '已为您退款'}})) as qa:
            result = await build_reply(ReplyRequest(platform='pinduoduo', message='[非文本消息，请在原平台查看]',
                qa_base_ids=['qa'], platform_context=context))
        self.assertTrue(result.intent.needs_clarification); self.assertNotIn('已为您退款', result.text)
        self.assertEqual(qa.call_args.args[0], '退款规则是什么')
        self.assertIn('最新客户问题：[非文本消息', model.call_args.kwargs['user'])

    async def test_plain_consultation_retains_qa_and_media_after_intent_check(self):
        with patch('app.pipeline.generate_with_provider', AsyncMock(return_value=(intent(), 'mock'))) as model, \
                patch('app.pipeline.match_qa', AsyncMock(return_value={'matched': True, 'score': 1,
                    'entry': {'answer': '这款有黄色。', 'image_url': 'https://example.test/yellow.png'}})):
            result = await build_reply(ReplyRequest(platform='pinduoduo', message='有黄色吗', qa_base_ids=['qa'],
                conversation=[{'role':'assistant','content':'您想了解哪方面？'}]))
        self.assertEqual(result.action_plan.workflow, 'qa_answer'); self.assertEqual(result.text, '这款有黄色。')
        model.assert_awaited_once()
        self.assertEqual(result.media, [{'type':'image','url':'https://example.test/yellow.png'}])

    async def test_insufficient_evidence_and_invalid_model_output_return_human(self):
        for answer in ['invalid', json.dumps({'answerable': False, 'text': ''})]:
            with patch('app.pipeline.generate_with_provider', AsyncMock(side_effect=[(intent(), 'mock'), (answer, 'mock')])):
                result = await build_reply(ReplyRequest(platform='pinduoduo', message='这款能承重多少'))
            self.assertEqual(result.decision, 'needs_human'); self.assertEqual(result.text, '')
