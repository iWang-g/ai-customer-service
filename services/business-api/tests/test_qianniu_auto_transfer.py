import unittest
import asyncio
from datetime import timedelta
from unittest.mock import patch, AsyncMock

from fastapi import HTTPException
from sqlalchemy import select

import test_qianniu_transfer as fixture
from app.models import (ConversationWorkflow, Message, Robot, RobotPlatformScope, RpaTask,
                        UserSettings, utcnow)
from app.schemas.message import SendMessageRequest
from app.schemas.rpa import TaskCompleteRequest
from app.schemas.automation import ReplyRunRequest
from app.services import qianniu_auto_transfer as auto
from app.services import qianniu_transfer_service as transfer
from app.services.automation_service import run_reply
from app.services.rpa_service import complete_task, get_pending_tasks, acknowledge_task
from app.services.message_service import create_send_task
from app.services.outbound_safety import qianniu_outbound_reason


class QianniuAutoTransferTests(unittest.TestCase):
    tearDown = fixture.QianniuTransferTests.tearDown

    def setUp(self):
        fixture.QianniuTransferTests.setUp(self)
        self.c.last_message_sequence = 1
        self.robot = Robot(user_id=self.user.id, name='test', enabled=True, status='online',
            config_json={'allow_auto_send': True, 'human_handoff_strategy': 'transfer_conversation'})
        self.source = Message(user_id=self.user.id, conversation_id=self.c.id, platform_code='qianniu',
            sender_role='customer', content='我要定制一个', conversation_sequence=1)
        self.db.add_all([self.robot, self.source, UserSettings(user_id=self.user.id, auto_reply_enabled=True)])
        self.db.flush()
        self.db.add(RobotPlatformScope(robot_id=self.robot.id, platform_code='qianniu', platform_account_id=self.account.id))
        self.db.commit()

    def queue(self):
        result = auto.queue(self.db, self.user, self.c, self.robot, self.source, 'custom_order')
        return self.db.get(RpaTask, result['task_ids'][0])

    def complete(self, task, result=None, status='completed'):
        return complete_task(self.db, task, TaskCompleteRequest(status=status, result_json=result or {}))

    def prepare(self):
        task = self.queue()
        self.complete(task, {'target': {'uid': '2', 'nick': '店铺:乙'}})
        ack = self.db.scalar(select(RpaTask).where(RpaTask.task_type == 'send_message'))
        return task, ack

    def test_prepare_before_notice_and_only_confirmed_notice_unlocks_execute(self):
        task = self.queue()
        self.assertIsNone(self.db.scalar(select(RpaTask).where(RpaTask.task_type == 'send_message')))
        self.assertTrue(transfer.transfer_blocked(self.c))
        with self.assertRaises(HTTPException):
            create_send_task(self.db, self.user, SendMessageRequest(conversation_id=self.c.id, content='普通消息'))
        self.assertIn(task, get_pending_tasks(self.db, self.node))
        acknowledge_task(self.db, task)
        auto.check_task(self.db, self.user, self.c.id, task.id)
        self.complete(task, {'target': {'uid': '2', 'nick': '店铺:乙'}})
        ack = self.db.scalar(select(RpaTask).where(RpaTask.task_type == 'send_message'))
        self.assertEqual(ack.payload_json['content'], '为您转接中')
        self.assertTrue(auto.ack_allowed(self.db, self.c, ack))
        with self.assertRaises(HTTPException):
            transfer.begin(self.db, self.user, self.c.id, '2', '店铺:乙', 'test')
        self.assertIn(ack, get_pending_tasks(self.db, self.node))
        self.complete(ack, {'text_sent': True, 'platform_message_id': 'confirmed'})
        execute = self.db.scalar(select(RpaTask).where(RpaTask.task_type == 'qianniu_transfer_execute'))
        self.assertIsNotNone(execute)
        get_pending_tasks(self.db, self.node)
        op = transfer.begin(self.db, self.user, self.c.id, '2', '店铺:乙', '自动转接', execute.id)
        transfer.finish(self.db, self.user, self.c.id, op['id'], 'transferred', fixture.QianniuTransferTests.evidence(self), None)
        self.assertEqual(transfer.current_operation(self.db, self.c)['status'], 'transferred')
        self.complete(execute, {'status': 'transferred'})
        self.assertTrue(transfer.transfer_blocked(self.c))

    def test_query_failure_sends_nothing_and_requires_human(self):
        task = self.queue()
        self.complete(task, status='failed')
        self.assertIsNone(self.db.scalar(select(RpaTask).where(RpaTask.task_type == 'send_message')))
        self.assertTrue(self.c.human_required)
        self.assertFalse(transfer.transfer_blocked(self.c))

    def add_customer(self, text):
        self.c.last_message_sequence += 1
        source = Message(user_id=self.user.id,conversation_id=self.c.id,platform_code='qianniu',
            sender_role='customer',content=text,message_status='received',
            conversation_sequence=self.c.last_message_sequence,raw_payload={'message_type':'text','automation_mode':'trigger'})
        self.db.add(source); self.db.commit()
        return source

    def run_model_reply(self, source, result):
        with patch('app.services.automation_service._decide_reply',AsyncMock(return_value={
                'intent':{},'confidence':1,'provider':'mock','trace_id':'image-no-online',**result})) as model:
            reply = asyncio.run(run_reply(self.db,self.user,ReplyRunRequest(conversation_id=self.c.id,
                source_message_id=source.id,allow_auto_send=True)))
        return reply,model

    def test_empty_roster_next_question_replies_and_new_handoff_can_retry(self):
        task=self.queue()
        self.complete(task,{'status':'no_online_target','submitted':False})
        self.assertEqual(transfer.current_operation(self.db,self.c)['status'],'unavailable')
        self.assertFalse(self.c.human_required); self.assertFalse(transfer.transfer_blocked(self.c))
        self.assertEqual(self.db.query(RpaTask).filter_by(task_type='send_message').count(),0)
        self.assertEqual(auto.queue(self.db,self.user,self.c,self.robot,self.source,'again')['task_ids'],[])
        hello=self.add_customer('你好')
        reply,model=self.run_model_reply(hello,{'decision':'auto_send','text':'您好'})
        model.assert_awaited_once()
        send=self.db.get(RpaTask,reply['task_ids'][0])
        self.complete(send,{'text_sent':True,'platform_message_id':'hello-sent'})
        self.source=self.add_customer('转人工')
        self.assertNotEqual(self.queue().id,task.id)

    def test_empty_roster_preserves_independent_human_marker_and_cancels_old_queued_reply(self):
        task=self.queue()
        stale=RpaTask(user_id=self.user.id,platform_account_id=self.account.id,conversation_id=self.c.id,
            platform_code='qianniu',task_type='send_message',status='queued',payload_json={})
        self.c.human_required=True; self.c.human_required_reason='manual_takeover'
        self.db.add(stale); self.db.commit()
        self.complete(task,{'status':'no_online_target','submitted':False})
        self.assertTrue(self.c.human_required); self.assertEqual(self.c.human_required_reason,'manual_takeover')
        self.assertEqual(stale.status,'failed')
        reply,model=self.run_model_reply(self.add_customer('你好'),{'decision':'auto_send','text':'您好'})
        model.assert_not_awaited(); self.assertEqual(reply['task_ids'],[])

    def test_empty_roster_before_execute_allows_manual_transfer_later(self):
        _,ack=self.prepare()
        self.complete(ack,{'text_sent':True,'platform_message_id':'notice'})
        execute=self.db.scalar(select(RpaTask).where(RpaTask.task_type=='qianniu_transfer_execute'))
        self.complete(execute,{'status':'no_online_target','submitted':False})
        self.assertEqual(transfer.current_operation(self.db,self.c)['status'],'unavailable')
        self.assertFalse(self.c.human_required)
        self.assertIsNotNone(transfer.begin(self.db,self.user,self.c.id,'2','店铺:乙','manual later'))

    def test_empty_roster_does_not_release_uncertain_notice_or_submitted_transfer(self):
        _,ack=self.prepare()
        self.complete(ack,status='confirmation_pending')
        execute=self.db.scalar(select(RpaTask).where(RpaTask.task_type=='qianniu_transfer_execute'))
        self.complete(execute,{'status':'no_online_target','submitted':False})
        self.assertEqual(transfer.current_operation(self.db,self.c)['status'],'confirmation_pending')
        self.assertTrue(transfer.transfer_blocked(self.c))

    def test_no_online_result_after_begin_cannot_release_submitted_transfer(self):
        _,ack=self.prepare()
        self.complete(ack,{'text_sent':True,'platform_message_id':'notice'})
        execute=self.db.scalar(select(RpaTask).where(RpaTask.task_type=='qianniu_transfer_execute'))
        get_pending_tasks(self.db,self.node)
        transfer.begin(self.db,self.user,self.c.id,'2','店铺:乙','自动转接',execute.id)
        self.complete(execute,{'status':'no_online_target','submitted':False})
        self.assertTrue(transfer.transfer_blocked(self.c))
        self.assertNotEqual(transfer.current_operation(self.db,self.c)['status'],'unavailable')

    def test_missing_or_invalid_target_is_failure_not_no_online(self):
        task=self.queue()
        self.complete(task,{'target':{'uid':'wrong','nick':'other'}})
        self.assertEqual(transfer.current_operation(self.db,self.c)['status'],'failed')
        self.assertTrue(self.c.human_required)

    def test_image_goes_to_model_then_clarification_not_immediate_transfer(self):
        self.source.content='[图片]'
        self.source.raw_payload={'message_type':'image','automation_mode':'trigger',
            'image_url':'https://img.test/a?signature=private',
            'structured_payload':{'parts':[{'kind':'image','url':'https://img.test/a?signature=private'}]}}
        self.db.commit()
        reply,model=self.run_model_reply(self.source,{'decision':'auto_send',
            'text':'您想了解哪方面，可以用文字说明一下吗？','intent':{'needs_clarification':True}})
        model.assert_awaited_once()
        context=model.call_args.kwargs['platform_context']
        self.assertEqual(context[-1]['type'],'qianniu_unread_image')
        self.assertNotIn('signature',str(context))
        self.assertEqual(self.db.query(RpaTask).filter_by(task_type='qianniu_transfer_prepare').count(),0)
        send=self.db.get(RpaTask,reply['task_ids'][0])
        self.complete(send,{'text_sent':True,'platform_message_id':'clarification-sent'})
        image=self.add_customer('[图片]'); image.raw_payload=self.source.raw_payload; self.db.commit()
        reply,model=self.run_model_reply(image,{'decision':'needs_human','text':'',
            'intent':{'intent':'human_handoff','reason':'澄清后仍无法识图'}})
        self.assertIn('您想了解哪方面',str(model.call_args.kwargs['history']))
        task=self.db.get(RpaTask,reply['task_ids'][0])
        self.assertEqual(task.task_type,'qianniu_transfer_prepare')
        self.complete(task,{'status':'no_online_target','submitted':False})
        reply,model=self.run_model_reply(self.add_customer('你好'),{'decision':'auto_send','text':'您好'})
        self.assertTrue(reply['task_ids']); self.assertFalse(self.c.human_required)

    def test_duplicate_prepare_and_send_receipts_do_not_create_more_tasks(self):
        task, ack = self.prepare()
        self.complete(task, {'target': {'uid': '2', 'nick': '店铺:乙'}})
        self.assertEqual(self.db.query(RpaTask).filter_by(task_type='send_message').count(), 1)
        for _ in range(2):
            self.complete(ack, {'text_sent': True, 'platform_message_id': 'confirmed'})
        self.assertEqual(self.db.query(RpaTask).filter_by(task_type='qianniu_transfer_execute').count(), 1)

    def test_missing_receipt_still_queues_one_transfer(self):
        _, ack = self.prepare()
        self.complete(ack)
        operation = transfer.current_operation(self.db, self.c)
        self.assertEqual(operation['status'], 'ready')
        self.assertEqual(operation['ack_status'], 'confirmation_pending')
        self.assertEqual(self.db.query(RpaTask).filter_by(task_type='qianniu_transfer_execute').count(), 1)
        self.complete(ack)
        self.assertEqual(self.db.query(RpaTask).filter_by(task_type='qianniu_transfer_execute').count(), 1)

    def test_failed_notice_still_queues_one_transfer_and_records_error(self):
        _, ack = self.prepare()
        self.complete(ack, status='failed')
        operation = transfer.current_operation(self.db, self.c)
        self.assertEqual(operation['status'], 'ready')
        self.assertEqual(operation['ack_status'], 'failed')
        self.assertEqual(operation['ack_error'], 'qianniu_transfer_ack_failed')
        self.assertEqual(self.db.query(RpaTask).filter_by(task_type='qianniu_transfer_execute').count(), 1)

    def test_disabled_policy_cannot_advance(self):
        task = self.queue()
        self.robot.config_json = {'allow_auto_send': False}
        self.db.commit()
        self.complete(task, {'target': {'uid': '2', 'nick': '店铺:乙'}})
        self.assertTrue(self.c.human_required)
        self.assertEqual(self.db.query(RpaTask).filter_by(task_type='send_message').count(), 0)

    def test_policy_disabled_after_notice_dispatch_preserves_uncertainty(self):
        _, ack = self.prepare()
        get_pending_tasks(self.db, self.node)
        self.robot.config_json = {'allow_auto_send': False}
        self.db.commit()
        get_pending_tasks(self.db, self.node)
        op = transfer.current_operation(self.db, self.c)
        self.assertEqual(op['status'], 'confirmation_pending')
        self.assertEqual(op['confirmation_pending_stage'], 'ack')
        self.assertFalse(auto.ack_allowed(self.db, self.c, ack))

    def test_expired_prepare_is_cancelled_without_a_notice(self):
        task = self.queue()
        record = transfer.operation_record(self.db, self.c.id)
        auto.set_operation(self.db, self.c, record, {**record.payload_json['operation'],
            'started_at': (utcnow() - timedelta(minutes=6)).isoformat()})
        self.db.commit()
        self.assertNotIn(task.id, [t.id for t in get_pending_tasks(self.db, self.node)])
        self.assertEqual(transfer.current_operation(self.db, self.c)['status'], 'failed')
        self.assertTrue(self.c.human_required)

    def test_interrupted_execute_never_retries_native_call(self):
        _, ack = self.prepare()
        self.complete(ack, {'text_sent': True, 'platform_message_id': 'confirmed'})
        execute = self.db.scalar(select(RpaTask).where(RpaTask.task_type == 'qianniu_transfer_execute'))
        get_pending_tasks(self.db, self.node)
        transfer.begin(self.db, self.user, self.c.id, '2', '店铺:乙', '自动转接', execute.id)
        self.complete(execute, status='failed')
        self.assertEqual(transfer.current_operation(self.db, self.c)['status'], 'confirmation_pending')
        with self.assertRaises(HTTPException):
            auto.check_task(self.db, self.user, self.c.id, execute.id)

    def test_late_failure_cannot_overwrite_a_successful_native_transfer(self):
        _, ack = self.prepare()
        self.complete(ack, {'text_sent': True, 'platform_message_id': 'confirmed'})
        execute = self.db.scalar(select(RpaTask).where(RpaTask.task_type == 'qianniu_transfer_execute'))
        get_pending_tasks(self.db, self.node)
        op = transfer.begin(self.db, self.user, self.c.id, '2', '店铺:乙', '自动转接', execute.id)
        transfer.finish(self.db, self.user, self.c.id, op['id'], 'transferred', fixture.QianniuTransferTests.evidence(self), None)
        self.complete(execute, status='failed')
        self.assertEqual(execute.status, 'completed')

    def test_wrong_conversation_task_and_forged_notice_content_are_rejected(self):
        task, ack = self.prepare()
        ack.payload_json = {**ack.payload_json, 'content': '其他内容'}
        self.db.commit()
        self.assertFalse(auto.ack_allowed(self.db, self.c, ack))
        with self.assertRaises(HTTPException):
            auto.check_task(self.db, self.user, 'f' * 32, task.id)

    def test_qianniu_reconciliation_failure_does_not_block_pdd_tasks(self):
        self.queue()
        pdd = RpaTask(user_id=self.user.id, conversation_id=self.c.id, platform_code='pinduoduo',
            task_type='send_message', status='queued')
        self.db.add(pdd); self.db.commit()
        with patch('app.services.qianniu_auto_transfer.reconcile_pending', side_effect=RuntimeError('isolated failure')):
            tasks = get_pending_tasks(self.db, self.node)
        self.assertEqual([task.id for task in tasks], [pdd.id])

    def test_returned_notice_cannot_transfer_even_when_ai_requests_handoff(self):
        self.source.sender_role = 'platform'
        self.db.commit()
        result = auto.queue(self.db, self.user, self.c, self.robot, self.source, 'human_handoff')
        self.assertEqual(result['task_ids'], [])

    def test_returned_unresolved_question_does_not_transfer_again(self):
        task = self.queue()
        record = transfer.operation_record(self.db, self.c.id)
        auto.set_operation(self.db, self.c, record, {**record.payload_json['operation'], 'status': 'returned'})
        self.db.commit()
        result = auto.queue(self.db, self.user, self.c, self.robot, self.source, 'custom_order')
        self.assertEqual(result['task_ids'], [])

    def test_final_words_apply_to_qianniu_automation_only(self):
        for text in ['不支持微信', 'VIP商品', 'QQ', '非淘宝链接', '二维码', '加我', '微\u200b信']:
            self.assertTrue(qianniu_outbound_reason(text))
            with self.assertRaises(HTTPException):
                create_send_task(self.db, self.user, SendMessageRequest(conversation_id=self.c.id,
                    content=text), source='automation')
        manual = create_send_task(self.db, self.user, SendMessageRequest(conversation_id=self.c.id,
            content='VIP商品'), source='desktop')
        self.assertIsNotNone(manual.task_id)
        self.c.platform_code = 'pinduoduo'; self.db.commit()
        allowed = create_send_task(self.db, self.user, SendMessageRequest(conversation_id=self.c.id,
            content='VIP商品'), source='automation')
        self.assertIsNotNone(allowed.task_id)

    def test_ai_handoff_routes_to_prepare_without_sending_model_text(self):
        with patch('app.services.automation_service._decide_reply', new=AsyncMock(return_value={
                'decision': 'needs_human', 'text': '模型的转接承诺', 'intent': {'reason': '明确约稿'},
                'action_plan': {'workflow': 'human_review'}})):
            result = asyncio.run(run_reply(self.db, self.user, ReplyRunRequest(conversation_id=self.c.id,
                source_message_id=self.source.id, allow_auto_send=True)))
        self.assertEqual(self.db.get(RpaTask, result['task_ids'][0]).task_type, 'qianniu_transfer_prepare')
        self.assertEqual(self.db.query(RpaTask).filter_by(task_type='send_message').count(), 0)

    def test_clarification_sends_question_without_transfer_or_human_flag(self):
        self.source.content = '1'
        self.db.commit()
        question = '亲，您说的1是指哪种尺寸或配置呢？'
        with patch('app.services.automation_service._decide_reply', new=AsyncMock(return_value={
                'decision': 'auto_send', 'text': question,
                'intent': {'intent': 'direct_reply', 'reply_route': 'direct',
                           'needs_clarification': True, 'reason': '客户指代不明确'},
                'action_plan': {'workflow': 'clarify_request', 'next_action': 'send_platform_text'},
                'risk_flags': []})):
            result = asyncio.run(run_reply(self.db, self.user, ReplyRunRequest(conversation_id=self.c.id,
                source_message_id=self.source.id, allow_auto_send=True)))
        task = self.db.get(RpaTask, result['task_ids'][0])
        self.assertEqual(task.task_type, 'send_message')
        self.assertEqual(task.payload_json['content'], question)
        self.assertFalse(self.c.human_required)
        self.assertEqual(self.db.query(RpaTask).filter_by(task_type='qianniu_transfer_prepare').count(), 0)
        self.assertEqual(self.db.query(RpaTask).filter_by(task_type='qianniu_transfer_execute').count(), 0)

    def test_fallback_uses_transfer_strategy_even_when_fallback_mark_is_disabled(self):
        self.robot.config_json = {
            'allow_auto_send': True,
            'human_handoff_strategy': 'transfer_conversation',
            'fallback_mark_human_required': False,
        }
        self.db.commit()
        with patch('app.services.automation_service._decide_reply', new=AsyncMock(return_value={
                'decision': 'auto_send', 'text': '不应发送的普通兜底话术',
                'intent': {'intent': 'normal_question'},
                'action_plan': {'workflow': 'fallback_reply', 'next_action': 'send_platform_text'},
                'risk_flags': []})):
            result = asyncio.run(run_reply(self.db, self.user, ReplyRunRequest(conversation_id=self.c.id,
                source_message_id=self.source.id, allow_auto_send=True)))

        task = self.db.get(RpaTask, result['task_ids'][0])
        self.assertEqual(task.task_type, 'qianniu_transfer_prepare')
        self.assertEqual(result['text'], '')
        self.assertEqual(self.db.query(RpaTask).filter_by(task_type='send_message').count(), 0)
        self.assertEqual(transfer.current_operation(self.db, self.c)['trigger_reason'], 'fallback_reply')
        self.assertFalse(self.c.human_required)

    def test_image_request_uses_online_prepare_notice_and_confirmed_transfer(self):
        self.source.content = '能发张实拍图吗'
        workflow = ConversationWorkflow(user_id=self.user.id, conversation_id=self.c.id,
            robot_id=self.robot.id, workflow_type='collect_email_for_link', status='waiting_for_email',
            intent='email_link_request', missing_slots_json=['email'])
        self.db.add(workflow); self.db.commit()
        with patch('app.services.automation_service._decide_reply', new=AsyncMock(return_value={
                'decision': 'needs_human', 'text': '',
                'intent': {'reason': '客户请求查看图片', 'image_request_intent': 'request'},
                'action_plan': {'workflow': 'human_review'}})), \
                patch('app.services.automation_service.active_workflow', return_value=workflow), \
                patch('app.services.automation_service.start_or_resume_email_workflow') as email:
            result = asyncio.run(run_reply(self.db, self.user, ReplyRunRequest(conversation_id=self.c.id,
                source_message_id=self.source.id, allow_auto_send=True)))
        email.assert_not_called()
        self.db.refresh(workflow)
        self.assertEqual(workflow.status, 'cancelled_interrupted')
        task = self.db.get(RpaTask, result['task_ids'][0])
        self.assertEqual(task.task_type, 'qianniu_transfer_prepare')
        self.assertEqual(transfer.current_operation(self.db, self.c)['trigger_reason'], '客户请求查看图片')
        self.assertEqual(self.db.query(RpaTask).filter_by(task_type='send_message').count(), 0)
        self.complete(task, {'target': {'uid': '2', 'nick': '店铺:乙'}})
        ack = self.db.scalar(select(RpaTask).where(RpaTask.task_type == 'send_message'))
        self.assertEqual(ack.payload_json['content'], '为您转接中')
        self.assertEqual(self.db.query(RpaTask).filter_by(task_type='qianniu_transfer_execute').count(), 0)
        self.complete(ack, {'text_sent': True, 'platform_message_id': 'image-request-notice'})
        self.assertEqual(self.db.query(RpaTask).filter_by(task_type='qianniu_transfer_execute').count(), 1)
