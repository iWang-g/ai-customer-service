import unittest
from datetime import datetime, timedelta, timezone

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.models import Base, Conversation, Message, PlatformAccount, RpaTask, User
from app.services.message_notice_service import list_message_notices


class MessageNoticeTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine('sqlite:///:memory:', connect_args={'check_same_thread': False})
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.user = User(username='notice-test', password_hash='unused', display_name='Test')
        self.db.add(self.user)
        self.db.flush()
        self.account = PlatformAccount(user_id=self.user.id, platform_code='pinduoduo', platform_name='拼多多', account_name='测试店铺')
        self.db.add(self.account)
        self.db.flush()
        self.chat = Conversation(user_id=self.user.id, platform_code='pinduoduo', platform_account_id=self.account.id,
                                 customer_name='小王', awaiting_reply=False, human_required=False)
        self.db.add(self.chat)
        self.db.flush()
        self.since = datetime.now(timezone.utc) - timedelta(minutes=10)
        self.sequence = 0

    def tearDown(self):
        self.db.close()
        self.engine.dispose()

    def message(self, seconds=10, role='customer', status='sent', source='rpa', **kwargs):
        self.sequence += 1
        time = self.since + timedelta(seconds=seconds)
        values = dict(conversation_id=self.chat.id, user_id=self.user.id, platform_code='pinduoduo',
                      sender_role=role, message_status=status, source=source, content=f'message {self.sequence}',
                      platform_sent_at=time, sent_at=time, collected_at=time,
                      conversation_sequence=self.sequence, collection_kind='incremental')
        values.update(kwargs)
        message = Message(**values)
        self.db.add(message)
        self.db.flush()
        return message

    def items(self):
        return list_message_notices(self.db, self.user, self.since).items

    def test_all_customer_messages_including_images_without_pending_flags(self):
        image = self.message(content='[图片]', automation_eligible=False)
        result = self.items()
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0].message_id, image.id)
        self.assertEqual(result[0].message_text, '[图片]')
        self.assertIsNone(result[0].reply_kind)
        self.assertEqual(result[0].shop_name, '测试店铺')

    def test_only_successful_reply_stops_waiting_and_new_message_resets(self):
        self.message()
        reply = self.message(20, role='agent', source='automation', status='queued')
        for status in ['queued', 'failed', 'confirmation_pending']:
            reply.message_status = status
            self.db.flush()
            self.assertIsNone(self.items()[0].reply_kind)
        reply.message_status = 'sent'
        self.db.flush()
        self.assertEqual(self.items()[0].reply_kind, 'ai')
        incoming = self.message(30)
        self.assertIsNone(self.items()[0].reply_kind)
        self.assertEqual(self.items()[0].message_id, incoming.id)
        self.assertEqual(len(self.items()), 1)

    def test_manual_reply_is_not_labeled_ai_and_viewing_does_not_resolve(self):
        self.message()
        self.chat.awaiting_reply = False
        self.chat.human_required = False
        self.db.flush()
        self.assertIsNone(self.items()[0].reply_kind)
        self.message(20, role='agent', source='desktop')
        self.assertEqual(self.items()[0].reply_kind, 'manual')

    def test_session_boundary_history_deletion_and_clear(self):
        self.message(-20, collected_at=self.since + timedelta(seconds=5))
        self.message(5, collection_kind='bootstrap', platform_sent_at=None)
        self.assertEqual(self.items(), [])
        incoming = self.message(10)
        self.chat.messages_cleared_sequence = incoming.conversation_sequence
        self.db.flush()
        self.assertEqual(self.items(), [])
        self.chat.messages_cleared_sequence = 0
        self.chat.deleted_at = datetime.now(timezone.utc)
        self.db.flush()
        self.assertEqual(self.items(), [])

    def test_other_user_never_leaks_and_new_app_run_is_empty(self):
        self.message()
        other = User(username='other', password_hash='unused', display_name='Other')
        self.db.add(other)
        self.db.flush()
        self.assertEqual(list_message_notices(self.db, other, self.since).items, [])
        self.assertEqual(list_message_notices(self.db, self.user, datetime.now(timezone.utc)).items, [])

    def test_old_ai_turn_finishing_late_does_not_resolve_new_customer_message(self):
        old = self.message(10)
        latest = self.message(20)
        reply = self.message(30, role='agent', source='automation')
        self.db.add(RpaTask(user_id=self.user.id, platform_code='pinduoduo', task_type='send_message',
                            conversation_id=self.chat.id, message_id=reply.id, requested_at=self.since,
                            status='completed', payload_json={'automation_source_message_id': old.id,
                            'automation_trigger_sequence': old.conversation_sequence}))
        self.db.flush()
        self.assertEqual(self.items()[0].message_id, latest.id)
        self.assertIsNone(self.items()[0].reply_kind)

    def test_no_first_page_limit_and_replied_records_do_not_expire(self):
        self.message(10)
        self.message(20, role='agent', source='ai')
        for index in range(105):
            chat = Conversation(user_id=self.user.id, platform_code='douyin', customer_name=f'客户{index}')
            self.db.add(chat)
            self.db.flush()
            self.message(30, conversation_id=chat.id, platform_code='douyin')
        self.assertEqual(len(self.items()), 106)
        self.assertEqual(next(item for item in self.items() if item.conversation_id == self.chat.id).reply_kind, 'ai')

    def test_platform_time_prevents_late_history_overwriting_latest_preview(self):
        latest = self.message(50)
        self.message(20, collected_at=self.since + timedelta(seconds=60))
        self.assertEqual(self.items()[0].message_id, latest.id)

    def test_fresh_message_in_initial_snapshot_is_not_lost(self):
        fresh = self.message(20, collection_kind='bootstrap')
        self.assertEqual(self.items()[0].message_id, fresh.id)

    def test_http_route_and_utc_response(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from app.api.deps import get_current_user, get_db_session
        from app.api.routes.conversations import router
        self.message(10)
        app = FastAPI()
        app.include_router(router)
        app.dependency_overrides[get_current_user] = lambda: self.user
        app.dependency_overrides[get_db_session] = lambda: self.db
        with TestClient(app) as client:
            response = client.get('/conversations/message-notices', params={'since': self.since.isoformat()})
            self.assertEqual(response.status_code, 200, response.text)
            value = response.json()
            self.assertEqual(len(value['items']), 1)
            self.assertTrue(value['items'][0]['customer_message_at'].endswith('Z'))
            self.assertEqual(client.get('/conversations/message-notices', params={'since': 'invalid'}).status_code, 422)


if __name__ == '__main__':
    unittest.main()
