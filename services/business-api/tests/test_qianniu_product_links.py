import unittest
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from app.models import Message, PlatformAccount, RpaTask, StoreProduct, utcnow
from app.schemas.automation import ReplyRunRequest
from app.schemas.message import SendMessageRequest
from app.services.automation_service import run_reply
from app.services.message_service import create_send_task
from app.services.product_service import apply_store_products_snapshot
from app.services.qianniu_product_links import PREFIX, append_reply_links, outbound_reason, reply_candidates
from app.services.qianniu_send_guard import check_qianniu_send_guard
import test_qianniu_product_reply as fixture


class QianniuProductLinkTests(unittest.IsolatedAsyncioTestCase):
    setUp = fixture.QianniuProductReplyTests.setUp
    tearDown = fixture.QianniuProductReplyTests.tearDown
    ingest = fixture.QianniuProductReplyTests.ingest

    def prepare(self):
        titles = ['义乳配件', '义乳硅胶款', '义乳清洁用品', '义乳另一款', '抱枕套']
        apply_store_products_snapshot(self.db, self.account, {
            'source': 'qianniu_products_v1', 'shop_uid': '123', 'observed_at': utcnow().isoformat(),
            'collection_status': 'success', 'page_summary': {'total_count': 5, 'has_more': False},
            'products': [{'product_id': str(i), 'goods_id': str(i), 'title': title}
                         for i, title in enumerate(titles, 1)],
        }, None)
        self.db.commit()
        _, _, source = self.ingest('intro', [{'index': 0, 'kind': 'text', 'text': '义乳的相关介绍'}])
        return source, source.conversation

    def result(self):
        return {'decision': 'auto_send', 'text': '亲，资料中介绍了这些类型，请按需要选择。',
                'intent': {'intent': 'normal_question', 'reply_route': 'retrieve_product',
                           'attach_product_links': True, 'selected_product_ids': ['1', '2']},
                'action_plan': {'workflow': 'answer_question', 'next_action': 'send_platform_text'},
                'provider': 'fixture', 'confidence': 1, 'trace_id': 'fixture'}

    async def test_full_reply_keeps_body_and_appends_links_to_one_send_task(self):
        source, conversation = self.prepare()
        expected = self.result()
        with patch('app.services.automation_service._decide_reply', AsyncMock(return_value=expected)) as model, \
                patch('app.services.qianniu_product_detail_service.ensure_details', AsyncMock(
                    return_value={'attempted': False, 'product_ids': []})), \
                patch('app.services.automation_service._refresh_order_context_before_reply', AsyncMock(return_value={})):
            result = await run_reply(self.db, self.user, ReplyRunRequest(
                conversation_id=conversation.id, source_message_id=source.id, allow_auto_send=True))
        self.assertEqual(len(model.call_args.kwargs['product_link_candidates']), 4)
        self.assertEqual(len(result['task_ids']), 1)
        task = self.db.get(RpaTask, result['task_ids'][0])
        self.assertEqual(task.task_type, 'send_message')
        self.assertTrue(task.payload_json['content'].startswith('亲，资料中介绍了这些类型'))
        self.assertIn(PREFIX + '1', task.payload_json['content'])
        self.assertIn(PREFIX + '2', task.payload_json['content'])
        self.assertNotIn(PREFIX + '3', task.payload_json['content'])
        task.status = 'acknowledged'
        self.db.commit()
        self.assertFalse(check_qianniu_send_guard(self.db, self.user, self.account.id,
                         conversation.external_conversation_id, task.id)['blocked'])
        self.account.metadata_json = {**self.account.metadata_json,
            'store_products': {**self.account.metadata_json['store_products'], 'product_ids': ['5']}}
        self.db.commit()
        self.assertTrue(check_qianniu_send_guard(self.db, self.user, self.account.id,
                        conversation.external_conversation_id, task.id)['blocked'])

    async def test_scope_latest_snapshot_and_candidates_are_all_required(self):
        _, conversation = self.prepare()
        other_account = PlatformAccount(user_id=self.user.id, platform_code='qianniu', platform_name='Qianniu',
                                        account_name='Other', local_account_id='qianniu-999')
        self.db.add(other_account)
        self.db.flush()
        other = StoreProduct(user_id=self.user.id, platform_account_id=other_account.id,
                             goods_id='999', platform_product_id='999', title='义乳跨店')
        self.db.add(other)
        self.db.commit()
        candidates = reply_candidates(self.db, conversation, '义乳的相关介绍')
        self.assertEqual({x['product_id'] for x in candidates}, {'1', '2', '3', '4'})
        result = self.result()
        result['intent']['selected_product_ids'] = ['999', '5', '1', '1', '2', '3', '4']
        append_reply_links(self.db, conversation, result, candidates)
        self.assertEqual([x['product_id'] for x in result['qianniu_product_links']], ['1', '2', '3'])
        self.account.metadata_json = {**self.account.metadata_json,
            'store_products': {**self.account.metadata_json['store_products'], 'product_ids': []}}
        self.db.commit()
        self.assertEqual(reply_candidates(self.db, conversation, '义乳'), [])
        result = self.result()
        append_reply_links(self.db, conversation, result, candidates)
        self.assertNotIn('qianniu_product_links', result)

    async def test_unsafe_urls_and_contact_text_remain_blocked_at_creation(self):
        _, conversation = self.prepare()
        urls = [
            PREFIX + '999', 'http://item.taobao.com/item.htm?id=1',
            'https://item.taobao.com.evil.test/item.htm?id=1',
            'https://item.taobao.com@evil.test/item.htm?id=1',
            PREFIX + '1&redirect=https://evil.test', PREFIX + '1#evil',
            PREFIX + '1/path', 'https://s.click.taobao.com/abc',
            PREFIX + '1\nhttps://evil.test', PREFIX + '1\n3509932519@qq.com',
            PREFIX + '1\n微信',
        ]
        for value in urls:
            with self.subTest(value=value), self.assertRaises(HTTPException):
                create_send_task(self.db, self.user, SendMessageRequest(
                    conversation_id=conversation.id, content=value), source='automation')
        self.assertEqual(self.db.query(RpaTask).count(), 0)
        conversation.platform_code = 'pinduoduo'
        self.assertEqual(outbound_reason(self.db, conversation, PREFIX + '1'), 'external_link')

    async def test_no_links_for_ordinary_clarification_human_email_or_fallback(self):
        _, conversation = self.prepare()
        candidates = reply_candidates(self.db, conversation, '义乳')
        variants = [({'attach_product_links': False}, {}, {}),
                    ({'needs_clarification': True}, {}, {}),
                    ({'reply_route': 'human_handoff'}, {}, {'decision': 'needs_human'}),
                    ({'reply_route': 'email_workflow'}, {}, {}),
                    ({'image_request_intent': 'request'}, {}, {}),
                    ({'custom_order_intent': 'proceed'}, {}, {}),
                    ({}, {'workflow': 'fallback_reply'}, {}),
                    ({}, {'workflow': 'qa_answer'}, {})]
        for intent, plan, fields in variants:
            result = self.result()
            original = result['text']
            result['intent'].update(intent)
            result['action_plan'].update(plan)
            result.update(fields)
            append_reply_links(self.db, conversation, result, candidates)
            self.assertEqual(result['text'], original)
        self.assertEqual(reply_candidates(self.db, conversation, '你好'), [])

    async def test_recent_links_and_byte_limit_do_not_break_original_reply(self):
        _, conversation = self.prepare()
        candidates = reply_candidates(self.db, conversation, '义乳')
        self.db.add(Message(user_id=self.user.id, conversation_id=conversation.id, sender_role='agent', platform_code='qianniu',
                            content=PREFIX + '1', message_status='sent', conversation_sequence=2))
        self.db.commit()
        result = self.result()
        append_reply_links(self.db, conversation, result, candidates)
        self.assertEqual([x['product_id'] for x in result['qianniu_product_links']], ['2'])
        result = self.result()
        result['text'] = '好' * 1365
        append_reply_links(self.db, conversation, result, candidates)
        self.assertEqual(result['text'], '好' * 1365)
        self.assertNotIn('qianniu_product_links', result)
