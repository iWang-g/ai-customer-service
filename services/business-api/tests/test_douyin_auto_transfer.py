import asyncio
import unittest
from datetime import timedelta
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from sqlalchemy import select

from tests import test_douyin_transfer as fixture
from app.models import Message, Robot, RobotPlatformScope, RpaTask, UserSettings, utcnow
from app.schemas.automation import ReplyRunRequest
from app.schemas.message import SendMessageRequest
from app.schemas.rpa import TaskCompleteRequest
from app.services import douyin_auto_transfer as auto, douyin_transfer_service as transfer
from app.services.douyin_automation import reply_block_reason, task_block_reason
from app.services.automation_service import run_reply
from app.services.message_service import create_send_task
from app.services.rpa_service import acknowledge_task, complete_task, get_pending_tasks


class DouyinAutoTransferTests(unittest.TestCase):
    tearDown = fixture.DouyinTransferTests.tearDown
    evidence = fixture.DouyinTransferTests.evidence

    def setUp(self):
        fixture.DouyinTransferTests.setUp(self)
        self.account.metadata_json = {**self.account.metadata_json, 'ai_text_reply_enabled': True}
        self.robot = Robot(user_id=self.user.id, name='robot', enabled=True, status='online',
            config_json={'allow_auto_send': True, 'human_handoff_strategy': 'transfer_conversation'})
        self.db.add_all([self.robot, UserSettings(user_id=self.user.id, auto_reply_enabled=True)])
        self.db.flush()
        self.db.add(RobotPlatformScope(robot_id=self.robot.id, platform_code='douyin', platform_account_id=self.account.id))
        self.source = self.add_customer('帮我定制一个')
        self.db.commit()

    def add_customer(self, text):
        now = utcnow()
        self.c.last_message_sequence += 1
        source = Message(user_id=self.user.id, conversation_id=self.c.id, platform_code='douyin',
            platform_message_id='customer-' + str(self.c.last_message_sequence), sender_role='customer', content=text,
            message_status='received', conversation_sequence=self.c.last_message_sequence, raw_payload={
                'sender_role': 'customer', 'message_type': 'text', 'content': text, 'automation_mode': 'trigger',
                'platform_sent_at': now.isoformat(), 'observed_at': now.isoformat(),
                'collector_started_at': (now-timedelta(seconds=2)).isoformat(),
                'structured_payload': {'sender_biz_role': 'Buyer', 'collection_source': 'live'}})
        self.db.add(source); self.db.commit()
        return source

    def queue(self):
        result = auto.queue(self.db, self.user, self.c, self.robot, self.source, 'needs_human')
        task = self.db.get(RpaTask, result['task_ids'][0])
        get_pending_tasks(self.db, self.node); acknowledge_task(self.db, task)
        return task

    def complete(self, task, result=None, status='completed'):
        return complete_task(self.db, task, TaskCompleteRequest(status=status, result_json=result or {}))

    def prepare(self):
        task = self.queue()
        self.complete(task, {'target': {'id': '222', 'name': '盼盼'}})
        ack = self.db.scalar(select(RpaTask).where(RpaTask.task_type == 'send_message'))
        get_pending_tasks(self.db, self.node); acknowledge_task(self.db, ack)
        return task, ack

    def execute_task(self):
        task = self.db.scalar(select(RpaTask).where(RpaTask.task_type == 'douyin_transfer_execute'))
        get_pending_tasks(self.db, self.node); acknowledge_task(self.db, task)
        return task

    def test_no_target_does_not_send_or_permanently_block_next_reply(self):
        task = self.queue()
        self.complete(task, {'status': 'no_online_target'})
        self.assertEqual(transfer.current_operation(self.db, self.c)['status'], 'unavailable')
        self.assertFalse(self.c.human_required); self.assertFalse(transfer.transfer_blocked(self.c))
        self.assertEqual(self.db.query(RpaTask).filter_by(task_type='send_message').count(), 0)
        source = self.add_customer('你好')
        self.assertIsNone(reply_block_reason(self.db, self.c, source, self.robot))
        with patch('app.services.automation_service._decide_reply', AsyncMock(return_value={
                'decision': 'auto_send', 'text': '您好', 'intent': {}, 'confidence': 1, 'provider': 'mock', 'trace_id': 'test'})):
            reply = asyncio.run(run_reply(self.db, self.user, ReplyRunRequest(conversation_id=self.c.id,
                source_message_id=source.id, allow_auto_send=True)))
        self.assertEqual(reply['text'], '您好')
        self.assertEqual(self.db.get(RpaTask, reply['task_ids'][0]).task_type, 'send_message')

    def test_new_handoff_after_no_target_can_try_again_but_old_source_cannot(self):
        task = self.queue(); self.complete(task, {'status': 'no_online_target'})
        result = auto.queue(self.db, self.user, self.c, self.robot, self.source, 'again')
        self.assertEqual(result['task_ids'], [])
        self.source = self.add_customer('转人工')
        self.assertNotEqual(self.queue().id, task.id)

    def test_notice_is_the_only_send_allowed_then_confirmed_transfer_stops_replies(self):
        _, ack = self.prepare()
        self.assertEqual(ack.payload_json['content'], auto.ACK)
        self.assertIsNone(task_block_reason(self.db, ack))
        self.assertTrue(transfer.send_guard(self.db, self.user, ack.id)['allowed'])
        with self.assertRaises(HTTPException):
            create_send_task(self.db, self.user, SendMessageRequest(conversation_id=self.c.id, content='其他'))
        with self.assertRaises(HTTPException): transfer.begin(self.db, self.user, self.c.id, '222', '盼盼', '111', 'manual')
        self.complete(ack, {'text_sent': True, 'platform_message_id': 'sent', 'response_status': '0', 'check_code': '0'})
        execute = self.execute_task()
        op = transfer.begin(self.db, self.user, self.c.id, '222', '盼盼', '111', '自动转接', execute.id)
        transfer.finish(self.db, self.user, self.c.id, op['id'], 'transferred', self.evidence(), None)
        self.complete(execute, {'status': 'transferred'})
        self.assertTrue(transfer.transfer_blocked(self.c))
        self.assertEqual(execute.status, 'completed')
        self.assertFalse(self.c.awaiting_reply)

    def test_notice_failure_still_executes_once_without_marking_human(self):
        prepare, ack = self.prepare()
        self.complete(ack, status='failed')
        self.assertFalse(self.c.human_required)
        self.assertEqual(transfer.current_operation(self.db, self.c)['ack_status'], 'failed')
        self.complete(prepare, {'target': {'id': '222', 'name': '盼盼'}})
        self.complete(ack, status='failed')
        self.assertEqual(self.db.query(RpaTask).filter_by(task_type='douyin_transfer_execute').count(), 1)

    def test_pending_notice_waits_then_executes_without_retry(self):
        _, ack = self.prepare()
        self.complete(ack, status='confirmation_pending')
        self.assertEqual(transfer.current_operation(self.db, self.c)['status'], 'ack_queued')
        ack.acked_at = utcnow() - timedelta(seconds=21); self.db.commit()
        auto.reconcile_pending(self.db, self.user.id); self.db.commit()
        execute = self.execute_task()
        self.assertIsNotNone(task_block_reason(self.db, ack))
        op = transfer.begin(self.db, self.user, self.c.id, '222', '盼盼', '111', 'auto', execute.id)
        transfer.finish(self.db, self.user, self.c.id, op['id'], 'confirmation_pending', {}, '未知')
        self.complete(execute, status='failed')
        self.assertTrue(transfer.transfer_blocked(self.c))
        self.assertEqual(self.db.query(RpaTask).filter_by(task_type='send_message').count(), 1)

    def test_policy_disable_identity_change_and_target_change_prevent_submission(self):
        _, ack = self.prepare(); self.complete(ack, status='failed')
        execute = self.execute_task()
        with self.assertRaises(HTTPException):
            transfer.begin(self.db, self.user, self.c.id, '333', '其他人', '111', 'auto', execute.id)
        self.account.metadata_json = {**self.account.metadata_json, 'cs_id': '444'}; self.db.commit()
        with self.assertRaises(HTTPException): auto.check_task(self.db, self.user, self.c.id, execute.id)
        self.account.metadata_json = {**self.account.metadata_json, 'cs_id': '111'}
        self.robot.enabled = False; self.db.commit()
        with self.assertRaises(HTTPException): auto.check_task(self.db, self.user, self.c.id, execute.id)
        get_pending_tasks(self.db, self.node)
        self.assertEqual(transfer.current_operation(self.db, self.c)['status'], 'failed')

    def test_all_staff_offline_before_submission_does_not_permanently_pause(self):
        _, ack = self.prepare(); self.complete(ack, status='failed')
        execute = self.execute_task()
        self.complete(execute, {'status': 'no_online_target'})
        self.assertEqual(transfer.current_operation(self.db, self.c)['status'], 'unavailable')
        self.assertFalse(self.c.human_required)
        self.assertIsNone(reply_block_reason(self.db, self.c, self.add_customer('你好'), self.robot))

    def test_ai_human_result_queues_transfer_without_fallback_flag(self):
        with patch('app.services.automation_service._decide_reply', AsyncMock(return_value={
                'decision': 'needs_human', 'text': '', 'intent': {'reason': '需要办理定制'}, 'confidence': 1,
                'provider': 'mock', 'trace_id': 'test', 'action_plan': {'workflow': 'human_review'}})):
            result = asyncio.run(run_reply(self.db, self.user, ReplyRunRequest(conversation_id=self.c.id,
                source_message_id=self.source.id, allow_auto_send=True)))
        self.assertEqual(self.db.get(RpaTask, result['task_ids'][0]).task_type, 'douyin_transfer_prepare')
        self.assertFalse(self.c.human_required)

    def test_history_keeps_actual_platform_replies_but_not_drafts_or_system_events(self):
        from app.services.automation_service import _message_history
        from types import SimpleNamespace
        def row(content, kind='text', status='sent'):
            return SimpleNamespace(id=content, platform_code='douyin', sender_role='agent',
                content=content, message_status=status, raw_payload={'message_type': kind, 'automation_mode': 'ignore'})
        result = _message_history([row('草稿', status='queued'), row('已取消', status='cancelled'),
            row('待确认', status='confirmation_pending'), row('系统提示', kind='system'), row('您想了解哪种尺寸？')])
        self.assertEqual(result, [{'role': 'assistant', 'content': '您想了解哪种尺寸？'}])
