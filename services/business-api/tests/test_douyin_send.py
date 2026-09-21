import unittest

from fastapi import HTTPException
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.models import Base, Conversation, Message, PlatformAccount, RpaTask, User
from app.schemas.message import SendMessageRequest
from app.schemas.rpa import RpaEventCreate
from app.services.message_service import create_send_task
from app.services.rpa_service import create_event, get_or_create_desktop_ingest_node, acknowledge_task, get_pending_tasks


class DouyinSendTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine('sqlite:///:memory:')
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.user = User(username='send-test', display_name='Test', password_hash='unused')
        self.db.add(self.user)
        self.db.commit()
        self.node = get_or_create_desktop_ingest_node(self.db, self.user)
        self.account = PlatformAccount(user_id=self.user.id, platform_code='douyin', platform_name='抖店',
            local_account_id='local', external_account_id='shop', account_name='测试', login_status='online',
            last_rpa_node_id=self.node.id, metadata_json={'message_send_enabled': True, 'im_ready': True})
        self.db.add(self.account)
        self.db.flush()
        self.conversation = Conversation(user_id=self.user.id, platform_account_id=self.account.id,
            platform_code='douyin', external_conversation_id='buyer:shop::2:1:pigeon', awaiting_reply=True)
        self.db.add(self.conversation)
        self.db.commit()

    def tearDown(self):
        self.db.close()
        self.engine.dispose()

    def queue(self, key='client-1', **kwargs):
        return create_send_task(self.db, self.user, SendMessageRequest(conversation_id=self.conversation.id,
            content='你好', client_message_id=key), **kwargs)

    def result(self, task_id, status, **kwargs):
        return create_event(self.db, self.user, self.node, RpaEventCreate(event_id=f'{task_id}:{status}',
            platform_code='douyin', event_type='douyin_send_result', platform_account_id=self.account.id,
            conversation_external_id=self.conversation.external_conversation_id,
            payload_json={'task_id': task_id, 'status': status, **kwargs}))

    def echo(self):
        return create_event(self.db, self.user, self.node, RpaEventCreate(event_id='echo', platform_code='douyin',
            event_type='agent_message', platform_account_id=self.account.id, platform_message_id='server-1',
            conversation_external_id=self.conversation.external_conversation_id,
            payload_json={'sender_role': 'agent', 'content': '你好', 'platform_sent_at': '2026-09-11T08:00:00Z',
                'structured_payload': {'sender_biz_role': 'CurrentServer', 'client_message_id': 'sdk-client-1'}}))

    def test_pending_sdk_identity_merges_with_echo_in_either_order(self):
        for echo_first in (True, False):
            with self.subTest(echo_first=echo_first):
                if not echo_first:
                    self.tearDown()
                    self.setUp()
                response = self.queue()
                if echo_first:
                    self.echo()
                self.result(response.task_id, 'confirmation_pending', sdk_client_message_id='sdk-client-1')
                if not echo_first:
                    self.echo()
                self.assertEqual(self.db.get(RpaTask, response.task_id).status, 'completed')
                messages = self.db.scalars(select(Message)).all()
                self.assertEqual(len(messages), 1)
                self.assertEqual(messages[0].platform_message_id, 'server-1')

    def test_identical_text_with_wrong_sdk_identity_stays_separate(self):
        response = self.queue()
        self.echo()
        self.result(response.task_id, 'confirmation_pending', sdk_client_message_id='other-sdk-call')
        self.assertEqual(self.db.get(RpaTask, response.task_id).status, 'confirmation_pending')
        self.assertEqual(len(self.db.scalars(select(Message)).all()), 2)

    def test_persistent_task_identity_and_no_automatic_retry(self):
        response = self.queue()
        self.assertEqual(self.queue().task_id, response.task_id)
        task = self.db.get(RpaTask, response.task_id)
        self.assertEqual(task.node_id, self.node.id)
        acknowledge_task(self.db, task)
        self.assertEqual(get_pending_tasks(self.db, self.node), [])
        self.assertEqual(self.db.get(Message, task.message_id).message_status, 'confirmation_pending')
        with self.assertRaises(HTTPException):
            self.queue('second')
        self.result(task.id, 'confirmation_pending')
        self.assertEqual(task.status, 'confirmation_pending')
        self.assertEqual(self.db.get(Message, task.message_id).message_status, 'confirmation_pending')

    def test_confirmation_and_echo_merge_in_either_order(self):
        for echo_first in (True, False):
            with self.subTest(echo_first=echo_first):
                if not echo_first:
                    self.tearDown()
                    self.setUp()
                response = self.queue()
                if echo_first:
                    self.echo()
                    self.assertEqual(len(self.db.scalars(select(Message)).all()), 2,
                        'same text alone must not merge queued send with a platform message')
                self.result(response.task_id, 'completed', platform_message_id='server-1', text_sent=True,
                    response_status='0', check_code='0', platform_sent_at='2026-09-11T08:00:00Z')
                if not echo_first:
                    self.echo()
                self.result(response.task_id, 'confirmation_pending')
                messages = self.db.scalars(select(Message)).all()
                self.assertEqual(len(messages), 1)
                self.assertEqual(messages[0].message_status, 'sent')
                self.assertEqual(messages[0].platform_message_id, 'server-1')
                self.assertEqual(self.db.get(RpaTask, response.task_id).status, 'completed')
                self.assertFalse(self.conversation.awaiting_reply)

    def test_failure_retained_and_new_task_allowed(self):
        response = self.queue()
        self.result(response.task_id, 'failed', error='平台拒绝发送')
        self.assertEqual(self.db.get(Message, response.message.id).message_status, 'failed')
        self.assertNotEqual(self.queue('new-attempt').task_id, response.task_id)

    def test_scope_capability_and_confirmation_validation(self):
        with self.assertRaises(HTTPException):
            self.queue(source='automation')
        self.account.metadata_json = {'message_send_enabled': False, 'im_ready': True}
        self.db.commit()
        with self.assertRaises(HTTPException):
            self.queue()
        self.account.metadata_json = {'message_send_enabled': True, 'im_ready': True}
        self.db.commit()
        response = self.queue()
        with self.assertRaises(HTTPException):
            self.result(response.task_id, 'completed', text_sent=True)
        self.assertEqual(self.db.get(Message, response.message.id).message_status, 'queued')


if __name__ == '__main__':
    unittest.main()
