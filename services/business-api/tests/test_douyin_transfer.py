import unittest
from datetime import timedelta

from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.models import Base, User, PlatformAccount, Conversation, RpaTask, utcnow
from app.services.douyin_transfer_service import begin, finish, context, transfer_blocked, send_guard
from app.services.rpa_service import get_pending_tasks, acknowledge_task, get_or_create_desktop_ingest_node
from app.services.message_service import create_send_task, get_conversation
from app.services.douyin_automation import reply_block_reason
from app.schemas.message import SendMessageRequest


class DouyinTransferTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine('sqlite:///:memory:'); Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.user = User(username='dy-transfer', password_hash='unused', display_name='tester')
        self.db.add(self.user); self.db.commit()
        self.node = get_or_create_desktop_ingest_node(self.db, self.user)
        self.account = PlatformAccount(user_id=self.user.id, platform_code='douyin', platform_name='抖店',
            account_name='测试', local_account_id='local', external_account_id='123', login_status='online',
            last_rpa_node_id=self.node.id, metadata_json={'cs_id':'111', 'im_ready': True, 'message_send_enabled': True})
        self.db.add(self.account); self.db.flush()
        self.c = Conversation(user_id=self.user.id, platform_account_id=self.account.id, platform_code='douyin',
            external_conversation_id='buyer:123::2:1:pigeon', awaiting_reply=True)
        self.db.add(self.c); self.db.commit()

    def tearDown(self):
        self.db.close(); self.engine.dispose()

    def start(self): return begin(self.db, self.user, self.c.id, '222', '盼盼', '111', '人工转接')

    def evidence(self):
        now = utcnow().isoformat()
        return {'method':'douyin_transfer_event_v1', 'conversation_id':self.c.external_conversation_id,
            'shop_id':'123', 'source_staff_id':'111', 'target_staff_id':'222', 'server_id':'9007199254740993123',
            'sdk_resolved':True, 'server_status':0, 'is_offline':False, 'pull_source':1,
            'submitted_at':now, 'platform_sent_at':now, 'observed_at':now}

    def task(self, status='queued'):
        t = RpaTask(user_id=self.user.id, platform_code='douyin', platform_account_id=self.account.id,
            conversation_id=self.c.id, task_type='send_message', status=status, node_id=self.node.id)
        self.db.add(t); self.db.commit(); return t

    def test_context_permissions_binding_self_and_offline_rejected(self):
        other = User(username='other-transfer', password_hash='unused', display_name='other')
        self.db.add(other); self.db.commit()
        with self.assertRaises(HTTPException): context(self.db, other, self.c.id)
        with self.assertRaises(HTTPException): begin(self.db, self.user, self.c.id, '111', '本人', '111', 'test')
        with self.assertRaises(HTTPException): begin(self.db, self.user, self.c.id, '222', '目标', '333', 'test')
        self.account.login_status = 'offline'; self.db.commit()
        with self.assertRaises(HTTPException): self.start()
        self.account.login_status = 'online'; self.c.external_conversation_id = 'buyer:456::2:1:pigeon'; self.db.commit()
        with self.assertRaises(HTTPException): self.start()

    def test_durable_barrier_blocks_generation_manual_sends_dispatch_and_ack(self):
        self.start()
        self.assertTrue(transfer_blocked(self.c))
        with Session(self.engine) as db: self.assertTrue(transfer_blocked(db.get(Conversation, self.c.id)))
        with self.assertRaises(HTTPException): self.start()
        with self.assertRaises(HTTPException): create_send_task(self.db, self.user, SendMessageRequest(conversation_id=self.c.id, content='test'))
        self.assertIn('转接', reply_block_reason(self.db, self.c, None, None))
        task = self.task()
        self.assertNotIn(task.id, [t.id for t in get_pending_tasks(self.db, self.node)])
        self.assertEqual(acknowledge_task(self.db, task).status, 'queued')
        task.status = 'confirmation_pending'; self.db.commit()
        self.assertFalse(send_guard(self.db, self.user, task.id)['allowed'])
        self.c.metadata_json = {}; self.db.commit()
        self.assertTrue(transfer_blocked(self.c))
        self.assertEqual(get_conversation(self.db, self.user, self.c.id).metadata_json['douyin_transfer']['status'], 'transferring')

    def test_matched_live_receipt_required_null_sdk_alone_cannot_finish(self):
        op = self.start()
        for update in [{}, {'target_staff_id':'wrong'}, {'conversation_id':'other'}, {'source_staff_id':'other'},
            {'is_offline':True}, {'sdk_resolved':False}, {'server_id':''},
            {'platform_sent_at':(utcnow()-timedelta(minutes=5)).isoformat()}]:
            evidence = {} if not update else {**self.evidence(), **update}
            with self.assertRaises(HTTPException): finish(self.db, self.user, self.c.id, op['id'], 'transferred', evidence, None)
        result = finish(self.db, self.user, self.c.id, op['id'], 'transferred', self.evidence(), None)
        self.assertEqual(result['status'], 'transferred'); self.assertTrue(transfer_blocked(self.c))
        self.assertFalse(self.db.get(Conversation,self.c.id).awaiting_reply)
        self.assertEqual(finish(self.db,self.user,self.c.id,op['id'],'transferred',{},None)['status'],'transferred')
        with self.assertRaises(HTTPException): finish(self.db,self.user,self.c.id,op['id'],'failed',{'submitted':False},None)

    def test_only_pre_submit_failure_allows_retry_pending_stays_blocked(self):
        op = self.start()
        with self.assertRaises(HTTPException): finish(self.db,self.user,self.c.id,op['id'],'failed',{},'timeout')
        finish(self.db,self.user,self.c.id,op['id'],'failed',{'submitted':False},'offline')
        self.assertFalse(transfer_blocked(self.c))
        op = self.start()
        finish(self.db,self.user,self.c.id,op['id'],'confirmation_pending',{},'timeout')
        with self.assertRaises(HTTPException): self.start()
        self.c.human_required = False; self.c.metadata_json = {}; self.db.commit()
        self.assertTrue(transfer_blocked(self.c))

    def test_queued_or_active_send_prevents_begin(self):
        task = self.task()
        for state in ['queued','dispatched','acknowledged','confirmation_pending']:
            task.status=state; self.db.commit()
            with self.assertRaises(HTTPException): self.start()
        task.status='completed'; self.db.commit()
        self.assertEqual(self.start()['status'], 'transferring')
