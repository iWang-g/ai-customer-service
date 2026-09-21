import unittest
from datetime import datetime, timezone

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.models import Base, User, PlatformAccount, Conversation, RpaNode, Message, RpaTask
from app.schemas.rpa import RpaEventCreate
from app.services.rpa_service import create_event
from app.services.message_service import list_messages


class QianniuMessageTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine('sqlite:///:memory:')
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.user = User(username='media-test', password_hash='unused', display_name='Test')
        self.db.add(self.user)
        self.db.flush()
        self.account = PlatformAccount(user_id=self.user.id, platform_code='qianniu', platform_name='千牛', local_account_id='qianniu-123', account_name='Test')
        self.node = RpaNode(user_id=self.user.id, node_key='media-test', hostname='test')
        self.db.add_all([self.account, self.node])
        self.db.flush()
        self.conversation = Conversation(user_id=self.user.id, platform_account_id=self.account.id, platform_code='qianniu', external_conversation_id='456.1-789.1#11001@cntaobao', unread_count=0, latest_message_text='original')
        self.db.add(self.conversation)
        self.db.commit()

    def tearDown(self):
        self.db.close()
        self.engine.dispose()

    def event(self, key, parts, snapshot=False, system=False, message_id='m1'):
        now = datetime.now(timezone.utc)
        payload = dict(content='[平台系统消息]' if system else '[商品] 123', message_type='system' if system else 'product', sender_role='platform' if system else 'customer',
                       qianniu_media_version=1, automation_mode='ignore' if snapshot or system else 'trigger',
                       structured_payload={'parts': parts}, platform_sent_at=now.isoformat(), observed_at=now.isoformat())
        return RpaEventCreate(event_id=key, dedup_key=key, event_type='qianniu_message_snapshot' if snapshot else 'customer_message',
            platform_code='qianniu', platform_account_id=self.account.id, conversation_external_id=self.conversation.external_conversation_id,
            platform_message_id=message_id, received_at=now, payload_json=payload)

    def test_completion_persists_without_duplicate_reply_or_unread_and_stale_read_keeps_card(self):
        link = {'index': 0, 'kind': 'product', 'product_id': '123', 'url': 'https://item.taobao.com/item.htm?id=123'}
        _, triggers, _ = create_event(self.db, self.user, self.node, self.event('first', [link]))
        self.assertEqual(len(triggers), 1)
        original_time = self.conversation.latest_message_at
        card = {**link, 'title': '商品标题', 'image_url': 'https://img.alicdn.com/a.png', 'price_label': '¥30.0'}
        _, triggers, _ = create_event(self.db, self.user, self.node, self.event('complete', [card], snapshot=True))
        self.assertEqual(triggers, [])
        create_event(self.db, self.user, self.node, self.event('stale', [{**link, 'title': None}], snapshot=True))
        self.db.expire_all()
        messages = list(self.db.scalars(select(Message)))
        self.assertEqual(len(messages), 1)
        self.assertEqual(messages[0].raw_payload['structured_payload']['title'], '商品标题')
        self.assertEqual(messages[0].raw_payload['automation_mode'], 'trigger')
        self.assertEqual(self.conversation.unread_count, 1)
        self.assertEqual(self.conversation.latest_message_at, original_time)
        self.assertEqual(list(self.db.scalars(select(RpaTask))), [])

    def test_history_and_system_keep_distinct_ids_without_automation(self):
        for key, system in [('image', False), ('system', True)]:
            parts = [{'index': 0, 'kind': 'unsupported' if system else 'image', 'url': None}]
            event = self.event(key, parts, snapshot=True, system=system, message_id=key)
            _, triggers, _ = create_event(self.db, self.user, self.node, event)
            self.assertEqual(triggers, [])
            create_event(self.db, self.user, self.node, event)
        self.assertEqual(self.db.query(Message).count(), 2)
        self.assertEqual(self.conversation.unread_count, 0)
        self.assertEqual(self.conversation.latest_message_text, 'original')

    def test_same_message_id_in_other_conversation_is_not_merged(self):
        part = {'index': 0, 'kind': 'image', 'url': 'https://img.alicdn.com/a.png'}
        create_event(self.db, self.user, self.node, self.event('one', [part], snapshot=True))
        other = self.event('two', [part], snapshot=True).model_copy(update={'conversation_external_id': '999.1-789.1#11001@cntaobao'})
        create_event(self.db, self.user, self.node, other)
        self.assertEqual(self.db.query(Message).count(), 2)

    def test_initial_snapshot_rejects_invalid_node(self):
        from fastapi import HTTPException
        with self.assertRaises(HTTPException):
            create_event(self.db, self.user, self.node, self.event('invalid', [{'index': -1, 'kind': 'image'}], snapshot=True))

    def test_complete_text_projection_replaces_stale_unsupported_fragments(self):
        broken = self.event('broken-email', [
            {'index': 0, 'kind': 'text', 'text': '2796263815@'},
            {'index': 1, 'kind': 'unsupported', 'text': '[暂不支持的消息]'},
        ], snapshot=True, message_id='email')
        broken.payload_json.update(content='2796263815@\n[暂不支持的消息]', message_type='text')
        create_event(self.db, self.user, self.node, broken)
        repaired = self.event('repaired-email', [
            {'index': 0, 'kind': 'text', 'text': '2796263815@qq.com'},
        ], snapshot=True, message_id='email')
        repaired.payload_json.update(content='2796263815@qq.com', message_type='text')
        repaired.payload_json['structured_payload']['parts_complete'] = True
        create_event(self.db, self.user, self.node, repaired)
        message = self.db.scalar(select(Message))
        self.assertEqual(message.content, '2796263815@qq.com')
        self.assertEqual(message.raw_payload['structured_payload']['parts'], [
            {'index': 0, 'kind': 'text', 'text': '2796263815@qq.com'},
        ])
        self.assertTrue(message.raw_payload['structured_payload']['parts_complete'])
        self.assertEqual(message.raw_payload['automation_mode'], 'ignore')

    def test_seller_card_replaces_misclassified_system_without_trigger_or_duplicate(self):
        create_event(self.db, self.user, self.node, self.event('old-system', [{'index': 0, 'kind': 'unsupported'}], snapshot=True, system=True))
        card = self.event('seller-card', [{'index': 0, 'kind': 'product', 'product_id': '123',
            'title': 'Recommendation', 'url': 'https://item.taobao.com/item.htm?id=123'}], snapshot=True)
        card.payload_json['sender_role'] = 'agent'
        for _ in range(2):
            _, triggers, _ = create_event(self.db, self.user, self.node, card)
            self.assertEqual(triggers, [])
        message = self.db.scalar(select(Message))
        self.assertEqual(self.db.query(Message).count(), 1)
        self.assertEqual(message.sender_role, 'agent')
        self.assertEqual(message.raw_payload['structured_payload']['parts'][0]['kind'], 'product')
        self.assertEqual(message.raw_payload['automation_mode'], 'ignore')
        self.assertEqual(self.conversation.unread_count, 0)

    def history_at(self, message_id, sent_at, parts=None):
        event = self.event('history-' + message_id, parts or [{'index': 0, 'kind': 'text', 'text': message_id}],
                           snapshot=True, message_id=message_id)
        event.payload_json['platform_sent_at'] = sent_at
        create_event(self.db, self.user, self.node, event)

    def listed_ids(self, **kwargs):
        return [m.platform_message_id for m in list_messages(self.db, self.user, self.conversation.id, **kwargs).items]

    def test_late_card_history_is_ordered_before_paging_without_renumbering(self):
        self.history_at('reply', '2026-09-09T10:22:02Z')
        self.history_at('buyer', '2026-09-09T10:31:21Z')
        self.history_at('seller', '2026-09-09T10:31:29Z')
        self.history_at('card', '2026-09-09T10:30:52Z', [
            {'index': 0, 'kind': 'product', 'product_id': '123', 'url': 'https://item.taobao.com/item.htm?id=123'},
        ])
        self.assertEqual(self.listed_ids(), ['reply', 'card', 'buyer', 'seller'])
        self.assertEqual(self.listed_ids(limit=2), ['buyer', 'seller'])
        self.assertEqual(self.listed_ids(limit=2, offset=2), ['reply', 'card'])
        self.assertEqual(self.listed_ids(limit=2, offset=4), [])
        rows = list(self.db.scalars(select(Message).order_by(Message.conversation_sequence)))
        self.assertEqual([m.platform_message_id for m in rows], ['reply', 'buyer', 'seller', 'card'])
        self.assertEqual(list_messages(self.db, self.user, self.conversation.id, limit=2).meta.total, 4)

    def test_same_time_and_missing_platform_time_use_stable_fallbacks(self):
        # IDs deliberately disagree with insertion order; equal times use permanent sequence.
        self.history_at('z', '2026-09-09T10:30:52.157Z')
        self.history_at('a', '2026-09-09T10:30:52.157Z')
        self.history_at('missing', None)
        missing = self.db.scalar(select(Message).where(Message.platform_message_id == 'missing'))
        missing.collected_at = datetime(2026, 9, 9, 10, 30, 52, 100000)
        self.db.commit()
        self.assertEqual(self.listed_ids(), ['missing', 'z', 'a'])
        self.assertEqual(self.listed_ids(limit=1), ['a'])
        self.assertEqual(self.listed_ids(limit=1, offset=1), ['z'])

    def test_history_completion_and_clear_boundary_keep_original_sequences(self):
        self.history_at('old', '2026-09-09T10:31:00Z')
        self.history_at('card', '2026-09-09T10:30:00Z')
        card = self.db.scalar(select(Message).where(Message.platform_message_id == 'card'))
        sequence = card.conversation_sequence
        update = self.event('card-completion', [{'index': 0, 'kind': 'text', 'text': 'completed'}],
                            snapshot=True, message_id='card')
        update.payload_json['platform_sent_at'] = '2026-09-09T10:30:00Z'
        create_event(self.db, self.user, self.node, update)
        self.assertEqual(self.listed_ids(), ['card', 'old'])
        self.assertEqual(card.conversation_sequence, sequence)
        self.assertEqual(self.db.query(Message).count(), 2)
        self.conversation.messages_cleared_sequence = sequence - 1
        self.db.commit()
        self.assertEqual(self.listed_ids(), ['card'])
        self.assertEqual(self.conversation.unread_count, 0)


if __name__ == '__main__':
    unittest.main()
