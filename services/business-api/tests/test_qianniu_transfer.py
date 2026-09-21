import unittest
import asyncio
from datetime import timedelta
from unittest.mock import patch, AsyncMock

from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.models import Base, User, Conversation, PlatformAccount, RpaTask, Message, RpaNode, Robot, RobotPlatformScope, UserSettings, utcnow
from app.schemas.rpa import RpaEventCreate
from app.schemas.automation import ReplyRunRequest
from app.services.qianniu_transfer_service import begin, finish, context, transfer_blocked
from app.services.rpa_service import get_pending_tasks, create_event, select_inbound_reply_source
from app.services.qianniu_transfer_notice import is_transfer_reply_source


class QianniuTransferTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine('sqlite:///:memory:')
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.user = User(username='transfer', password_hash='unused', display_name='tester')
        self.db.add(self.user); self.db.flush()
        self.account = PlatformAccount(user_id=self.user.id, platform_code='qianniu', platform_name='Qianniu',
            local_account_id='qianniu-123', account_name='店铺:甲')
        self.db.add(self.account); self.db.flush()
        self.c = Conversation(user_id=self.user.id, platform_account_id=self.account.id, platform_code='qianniu',
            external_conversation_id='456.1-789.1#11001@cntaobao', customer_name='买家', awaiting_reply=True,
            metadata_json={'buyer_uid': '456', 'shop_uid': '123'})
        self.db.add(self.c)
        self.node = RpaNode(user_id=self.user.id, node_key='transfer', hostname='test')
        self.db.add(self.node); self.db.commit()

    def tearDown(self):
        self.db.close(); self.engine.dispose()

    def start(self):
        return begin(self.db, self.user, self.c.id, '2', '店铺:乙', '人工转接')

    def evidence(self):
        return {'shopUid': '123', 'buyerUid': '456', 'cid': self.c.external_conversation_id, 'targetUid': '2',
            'errorCode': 0, 'errorMap': {}, 'module': True, 'ret': ['SUCCESS::ok'], 'requestId': '1', 'pid': '3',
            'api': 'mtop.taobao.qianniu.cloudkefu.forward', 'version': '3.0'}

    def task(self, platform='qianniu', state='queued'):
        task = RpaTask(user_id=self.user.id, platform_code=platform, conversation_id=self.c.id,
            platform_account_id=self.account.id, task_type='send_message', status=state)
        self.db.add(task); self.db.commit(); return task

    def test_permission_and_platform_and_missing_buyer_are_rejected(self):
        other = User(username='other', password_hash='unused', display_name='other')
        self.db.add(other); self.db.commit()
        with self.assertRaises(HTTPException): context(self.db, other, self.c.id)
        self.c.platform_code = 'pinduoduo'; self.db.commit()
        with self.assertRaises(HTTPException): self.start()
        self.c.platform_code = 'qianniu'; self.c.metadata_json = {}; self.db.commit()
        with self.assertRaises(HTTPException): self.start()

    def test_durable_barrier_and_duplicate_begin(self):
        op = self.start()
        self.assertTrue(transfer_blocked(self.db.get(Conversation, self.c.id)))
        with Session(self.engine) as session:
            self.assertTrue(transfer_blocked(session.get(Conversation, self.c.id)))
        with self.assertRaises(HTTPException): self.start()
        self.assertEqual(op['operator_id'], self.user.id)

    def test_business_success_required_cancels_only_qianniu_pending_tasks(self):
        qn = self.task(); pdd = self.task('pinduoduo')
        op = self.start()
        with self.assertRaises(HTTPException): finish(self.db, self.user, self.c.id, op['id'], 'transferred', {}, None)
        finish(self.db, self.user, self.c.id, op['id'], 'transferred', self.evidence(), None)
        self.db.refresh(qn); self.db.refresh(pdd); self.db.refresh(self.c)
        self.assertEqual(qn.status, 'failed'); self.assertEqual(pdd.status, 'queued')
        self.assertTrue(transfer_blocked(self.c)); self.assertFalse(self.c.awaiting_reply)
        self.assertEqual(self.c.metadata_json['qianniu_transfer_audit'][0]['target_uid'], '2')

    def test_failure_restores_queue_pending_stays_blocked(self):
        task = self.task(); op = self.start()
        self.assertNotIn(task.id, [t.id for t in get_pending_tasks(self.db, self.node)])
        finish(self.db, self.user, self.c.id, op['id'], 'failed', {}, 'offline')
        self.assertFalse(transfer_blocked(self.db.get(Conversation, self.c.id)))
        op = self.start()
        finish(self.db, self.user, self.c.id, op['id'], 'confirmation_pending', {}, 'timeout')
        self.assertTrue(transfer_blocked(self.db.get(Conversation, self.c.id)))
        with self.assertRaises(HTTPException): self.start()

    def test_active_task_prevents_transfer(self):
        self.task(state='acknowledged')
        with self.assertRaises(HTTPException): self.start()

    def test_chat_metadata_overwrite_cannot_remove_durable_barrier(self):
        self.start()
        self.c.metadata_json = {'buyer_uid': '456', 'shop_uid': '123'}
        self.db.commit()
        self.assertTrue(transfer_blocked(self.c))
        self.assertEqual(context(self.db, self.user, self.c.id)[1]['transfer']['status'], 'transferring')

    def returned_event(self, key='return', snapshot=False, **changes):
        now = utcnow() + timedelta(milliseconds=1)
        payload = {'content': '由 乙 转交给 甲', 'sender_role': 'platform', 'sender_name': '千牛平台',
            'message_type': 'system', 'display_mode': 'separator', 'template_id': 101, 'qianniu_media_version': 1,
            'automation_mode': 'ignore' if snapshot else 'trigger', 'raw_direction': 'incoming',
            'platform_sent_at': now.isoformat(), 'observed_at': now.isoformat(),
            'structured_payload': {'parts': [{'index': 0, 'kind': 'text', 'text': '由 乙 转交给 甲'}]},
            'qianniu_transfer_notice': {'source_nick': '店铺:乙', 'target_nick': '店铺:甲',
                'receiver_uid': '123', 'buyer_uid': '456', 'main_uid': '789'}}
        payload.update(changes)
        return RpaEventCreate(event_id=key, dedup_key=key, platform_code='qianniu',
            event_type='qianniu_message_snapshot' if snapshot else 'message_received',
            platform_account_id=self.account.id, conversation_external_id=self.c.external_conversation_id,
            platform_message_id='notice1', received_at=now, payload_json=payload)

    def transfer_out(self):
        op = self.start()
        finish(self.db, self.user, self.c.id, op['id'], 'transferred', self.evidence(), None)
        self.db.expire_all()

    def test_return_restores_reception_before_trigger_preserves_audit_and_cancelled_tasks(self):
        cancelled = self.task()
        self.transfer_out()
        request = self.returned_event()
        _, messages, _ = create_event(self.db, self.user, self.node, request)
        self.assertEqual(len(messages), 1)
        msg = messages[0]
        self.assertEqual(msg.sender_role, 'platform')
        self.assertEqual(msg.content, '由 乙 转交给 甲')
        self.assertTrue(is_transfer_reply_source(msg))
        self.assertEqual(select_inbound_reply_source(self.db, request, messages), msg)
        self.assertFalse(transfer_blocked(self.c))
        self.assertTrue(self.c.awaiting_reply)
        self.assertEqual(self.c.metadata_json['qianniu_transfer']['status'], 'returned')
        self.assertEqual([a['status'] for a in self.c.metadata_json['qianniu_transfer_audit']], ['transferred', 'returned'])
        self.db.refresh(cancelled)
        self.assertEqual(cancelled.status, 'failed')
        new_task = self.task()
        self.assertIn(new_task.id, [t.id for t in get_pending_tasks(self.db, self.node)])

    def test_duplicate_and_history_do_not_repeat_reply_or_unlock_later_transfer(self):
        self.transfer_out()
        request = self.returned_event()
        create_event(self.db, self.user, self.node, request)
        for repeated in [request, self.returned_event('different-delivery'), self.returned_event('history', snapshot=True)]:
            _, messages, _ = create_event(self.db, self.user, self.node, repeated)
            self.assertEqual(messages, [])
        self.start()
        self.assertTrue(transfer_blocked(self.c))
        create_event(self.db, self.user, self.node, self.returned_event('old-after-new-transfer'))
        self.assertTrue(transfer_blocked(self.c))
        self.assertEqual(self.db.query(Message).count(), 1)

    def test_snapshot_and_stale_notice_never_restore_or_trigger(self):
        self.transfer_out()
        _, messages, _ = create_event(self.db, self.user, self.node, self.returned_event('history', snapshot=True))
        self.assertEqual(messages, [])
        self.assertTrue(transfer_blocked(self.c))
        old = (utcnow() - timedelta(minutes=10)).isoformat()
        request = self.returned_event('stale', platform_sent_at=old, observed_at=old).model_copy(update={'platform_message_id': 'old'})
        _, messages, _ = create_event(self.db, self.user, self.node, request)
        self.assertEqual(messages, [])
        self.assertTrue(transfer_blocked(self.c))

    def test_wrong_identity_or_plain_text_cannot_restore(self):
        self.transfer_out()
        variants = [dict(template_id=1), dict(sender_role='customer'), dict(content='普通聊天'),
            dict(raw_direction='outgoing')]
        for field, value in [('receiver_uid', '999'), ('buyer_uid', '999'), ('main_uid', '999'),
                             ('target_nick', '店铺:丙'), ('source_nick', '别家:乙')]:
            notice = dict(self.returned_event().payload_json['qianniu_transfer_notice'])
            notice[field] = value
            variants.append({'qianniu_transfer_notice': notice})
        for index, changes in enumerate(variants):
            request = self.returned_event(str(index), **changes).model_copy(update={'platform_message_id': str(index)})
            _, messages, _ = create_event(self.db, self.user, self.node, request)
            self.assertEqual(messages, [])
            self.assertTrue(transfer_blocked(self.c))

    def test_notice_before_outbound_completion_does_not_unlock(self):
        old = utcnow().isoformat()
        self.transfer_out()
        _, messages, _ = create_event(self.db, self.user, self.node, self.returned_event(platform_sent_at=old))
        self.assertEqual(messages, [])
        self.assertTrue(transfer_blocked(self.c))

    def test_explicit_historical_reconciliation_is_silent(self):
        from app.services.qianniu_transfer_service import receive_return_notice
        self.transfer_out()
        request = self.returned_event()
        msg = Message(user_id=self.user.id, conversation_id=self.c.id, platform_code='qianniu',
            platform_message_id='history', content='由 乙 转交给 甲', sender_role='platform', raw_payload=request.payload_json)
        self.db.add(msg)
        self.db.flush()
        self.assertTrue(receive_return_notice(self.db, self.c, msg, request, historical_reconciliation=True))
        self.db.commit()
        self.assertFalse(transfer_blocked(self.c))
        self.assertFalse(is_transfer_reply_source(msg))
        self.assertFalse(msg.automation_eligible)

    def test_return_routes_through_ai_as_platform_context_and_queues_once(self):
        from app.api.routes.rpa import _schedule_inbound_reply
        from app.services.automation_service import run_reply
        robot = Robot(user_id=self.user.id, name='test', enabled=True, status='online', config_json={'allow_auto_send': True})
        self.db.add_all([robot, UserSettings(user_id=self.user.id, auto_reply_enabled=True)])
        self.db.flush()
        self.db.add(RobotPlatformScope(robot_id=robot.id, platform_code='qianniu', platform_account_id=self.account.id))
        self.db.commit()
        self.transfer_out()
        request = self.returned_event()
        event, messages, _ = create_event(self.db, self.user, self.node, request)
        msg = messages[0]
        with patch('app.api.routes.rpa.schedule_debounced_inbound_reply') as schedule:
            _schedule_inbound_reply(self.db, self.user, request, msg, event.id)
            schedule.assert_called_once()
        provider = AsyncMock(return_value={'decision': 'auto_send', 'text': '您好，已由我接手为您处理。',
            'confidence': 1, 'provider': 'fixture', 'trace_id': 'fixture', 'intent': {}, 'retrieval': []})
        async def reply():
            with patch('app.services.automation_service._decide_reply', provider):
                req = ReplyRunRequest(conversation_id=self.c.id, source_message_id=msg.id, allow_auto_send=True)
                first = await run_reply(self.db, self.user, req)
                with self.assertRaises(HTTPException) as duplicate:
                    await run_reply(self.db, self.user, req)
                self.assertEqual(duplicate.exception.status_code, 409)
                return first
        result = asyncio.run(reply())
        self.assertEqual(len(result['task_ids']), 1)
        provider.assert_awaited_once()
        self.assertIn('并非买家发言', str(provider.call_args))
        self.assertEqual(self.db.query(RpaTask).filter_by(task_type='send_message').count(), 1)


if __name__ == '__main__':
    unittest.main()
