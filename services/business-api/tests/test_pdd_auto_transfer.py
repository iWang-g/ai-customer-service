import asyncio
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.models import Base, User, PlatformAccount, Conversation, Robot, RobotPlatformScope, UserSettings, Message, RpaTask
from app.schemas.automation import ReplyRunRequest
from app.schemas.rpa import TaskCompleteRequest
from app.services import pdd_auto_transfer as auto
from app.services.automation_service import run_reply, _platform_context, _message_history, _unsupported_reply_reason
from app.services.pdd_message_context import sanitize_inbound
from app.services.rpa_service import get_or_create_desktop_ingest_node, get_pending_tasks, acknowledge_task, complete_task


class PddTransferTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine('sqlite:///:memory:'); Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.user = User(username='pdd-test', display_name='tester', password_hash='unused')
        self.db.add(self.user); self.db.flush()
        self.node = get_or_create_desktop_ingest_node(self.db, self.user)
        self.account = PlatformAccount(user_id=self.user.id, platform_code='pinduoduo', platform_name='拼多多', account_name='shop',
            external_account_id='123', login_status='online', last_rpa_node_id=self.node.id)
        self.db.add(self.account); self.db.flush()
        self.c = Conversation(user_id=self.user.id, platform_code='pinduoduo', platform_account_id=self.account.id,
            external_conversation_id='buyer', metadata_json={})
        self.robot = Robot(user_id=self.user.id, name='robot', status='online', enabled=True,
            config_json={'allow_auto_send':True,'human_handoff_strategy':'transfer_conversation'})
        self.db.add_all([self.c,self.robot,UserSettings(user_id=self.user.id,auto_reply_enabled=True)])
        self.db.flush()
        self.db.add(RobotPlatformScope(robot_id=self.robot.id,platform_code='pinduoduo',platform_account_id=self.account.id))
        self.db.commit(); self.source = self.customer('你好')

    def tearDown(self):
        self.db.close(); self.engine.dispose()

    def customer(self, text, kind='text'):
        sequence = self.db.query(Message).filter_by(conversation_id=self.c.id).count() + 1
        payload = sanitize_inbound({'content':text,'sender_role':'customer','message_type':kind,'automation_mode':'trigger',
            'structured_payload':{'from_role':'user','raw_type':1 if kind=='image' else 999,
                'message_core':{'version':1,'fields':[{'path':'info.title','value':'订单问题'}]}}})
        message = Message(user_id=self.user.id,conversation_id=self.c.id,platform_code='pinduoduo',sender_role='customer',
            content=payload['content'],raw_payload=payload,message_status='sent',
            collection_kind='incremental',automation_eligible=True,platform_message_id=str(sequence))
        from app.services.message_queue_service import append_message
        append_message(self.db,message); self.db.commit(); return message

    def dispatch(self, task):
        get_pending_tasks(self.db,self.node); acknowledge_task(self.db,task)
        auto.validate(self.db,self.user,task)
        return task

    def queue(self):
        result = auto.queue(self.db,self.user,self.c,self.robot,self.source,'needs_human')
        return self.dispatch(self.db.get(RpaTask,result['task_ids'][0]))

    def complete(self, task, result, status='completed'):
        return complete_task(self.db,task,TaskCompleteRequest(status=status,result_json=result))

    def prepare(self):
        task = self.queue()
        self.complete(task,{'status':'prepared','target_cs_id':'other','target_cs_username':'同事','submitted':False})
        ack = self.db.get(RpaTask,auto.state(self.c)['ack_task_id'])
        return self.dispatch(ack)

    def execute(self, ack, status='completed'):
        self.complete(ack,{'text_sent':status=='completed','platform_message_id':'ack-sent'},status)
        return self.dispatch(self.db.scalar(select(RpaTask).where(RpaTask.task_type=='transfer_conversation', RpaTask.status.in_(['queued','dispatched','acknowledged']))))

    def reply(self, source, result):
        with patch('app.services.automation_service._decide_reply',AsyncMock(return_value={
                'confidence':1,'provider':'mock','trace_id':'pdd-test','intent':{},**result})) as model, \
                patch('app.services.automation_service._refresh_order_context_before_reply',AsyncMock(return_value={'attempted':False})):
            reply = asyncio.run(run_reply(self.db,self.user,ReplyRunRequest(conversation_id=self.c.id,
                source_message_id=source.id,allow_auto_send=True)))
        return reply,model

    def test_empty_roster_sends_no_notice_and_new_questions_reply(self):
        task=self.queue(); self.complete(task,{'status':'no_online_target','submitted':False})
        self.assertEqual(auto.state(self.c)['status'],'unavailable'); self.assertFalse(self.c.human_required)
        self.assertEqual(self.db.query(RpaTask).filter_by(task_type='send_message').count(),0)
        result,_=self.reply(self.customer('有黄色吗'),{'decision':'auto_send','text':'有黄色。'})
        self.assertTrue(result['task_ids'])
        self.assertEqual(auto.queue(self.db,self.user,self.c,self.robot,self.source,'again')['task_ids'],[])

    def test_new_handoff_can_retry_after_empty_roster(self):
        task=self.queue(); self.complete(task,{'status':'no_online_target','submitted':False})
        self.source=self.customer('转人工')
        self.assertNotEqual(self.queue().id,task.id)

    def test_notice_then_single_submit_success_suppresses_future_reply(self):
        ack=self.prepare(); self.assertEqual(ack.payload_json['content'],'为您转接中')
        execute=self.execute(ack)
        with self.assertRaises(HTTPException): auto.validate(self.db,self.user,execute)
        self.complete(execute,{'status':'transferred','submitted':True,'target_cs_id':'other','result':{'result':'ok'}})
        self.assertEqual(auto.state(self.c)['status'],'transferred')
        result,model=self.reply(self.customer('你好'),{'decision':'auto_send','text':'您好'})
        model.assert_not_awaited(); self.assertEqual(result['task_ids'],[])

    def test_no_target_after_notice_releases_but_uncertain_submit_does_not(self):
        execute=self.execute(self.prepare())
        self.complete(execute,{'status':'no_online_target','submitted':False})
        self.assertEqual(auto.state(self.c)['status'],'unavailable'); self.assertFalse(auto.blocked(self.c))
        self.source=self.customer('转人工')
        execute=self.execute(self.prepare())
        self.complete(execute,{'submitted':True},'confirmation_pending')
        self.assertEqual(auto.state(self.c)['status'],'confirmation_pending'); self.assertTrue(auto.blocked(self.c))

    def test_query_failure_is_not_no_target(self):
        task=self.queue(); self.complete(task,{'status':'no_online_target','submitted':False},'failed')
        self.assertTrue(self.c.human_required); self.assertEqual(auto.state(self.c)['status'],'failed')

    def test_independent_human_marker_and_stale_replies_are_preserved(self):
        task=self.queue(); self.c.human_required=True; self.c.human_required_reason='manual'; self.db.commit()
        self.complete(task,{'status':'no_online_target','submitted':False})
        self.assertTrue(self.c.human_required); self.assertEqual(self.c.human_required_reason,'manual')

    def test_notice_failure_still_attempts_transfer(self):
        execute=self.execute(self.prepare(),'failed')
        self.assertEqual(execute.task_type,'transfer_conversation'); self.assertFalse(self.c.human_required)

    def test_uncertain_notice_then_no_target_stays_pending(self):
        execute=self.execute(self.prepare(),'confirmation_pending')
        self.complete(execute,{'status':'no_online_target','submitted':False})
        self.assertEqual(auto.state(self.c)['status'],'confirmation_pending')
        self.assertTrue(auto.blocked(self.c))

    def test_missing_notice_receipt_is_not_treated_as_confirmed(self):
        ack=self.prepare()
        self.complete(ack,{'text_sent':True})
        self.assertEqual(ack.status,'confirmation_pending')
        execute=self.dispatch(self.db.scalar(select(RpaTask).where(RpaTask.task_type=='transfer_conversation')))
        self.complete(execute,{'status':'no_online_target','submitted':False})
        self.assertEqual(auto.state(self.c)['status'],'confirmation_pending')

    def test_snapshot_cannot_erase_transfer_barrier_and_policy_off_prevents_notice(self):
        task=self.queue()
        self.c.metadata_json={}; self.db.commit()
        self.assertTrue(auto.blocked(self.c))
        self.robot.config_json={**self.robot.config_json,'allow_auto_send':False}; self.db.commit()
        self.complete(task,{'status':'prepared','submitted':False,'target_cs_id':'other'})
        self.assertEqual(auto.state(self.c)['status'],'failed')
        self.assertEqual(self.db.query(RpaTask).filter_by(task_type='send_message').count(),0)

    def test_cancelled_old_reply_cannot_be_released_after_no_target(self):
        from app.services.message_service import create_send_task
        from app.schemas.message import SendMessageRequest
        response=create_send_task(self.db,self.user,SendMessageRequest(conversation_id=self.c.id,
            platform_code='pinduoduo',content='旧回答'),source='automation')
        stale=self.db.get(RpaTask,response.task_id)
        task=self.queue(); self.complete(task,{'status':'no_online_target','submitted':False})
        self.assertEqual(stale.status,'failed')
        self.assertEqual(self.db.get(Message,stale.message_id).message_status,'cancelled')
        with self.assertRaises(HTTPException): auto.validate(self.db,self.user,stale)

    def test_success_requires_matching_target_and_platform_receipt(self):
        execute=self.execute(self.prepare())
        self.complete(execute,{'status':'transferred','submitted':True,'target_cs_id':'wrong','result':{'result':'ok'}})
        self.assertEqual(auto.state(self.c)['status'],'confirmation_pending')

    def test_image_clarification_then_handoff_empty_then_new_text(self):
        image=self.customer('[图片]','image')
        self.assertIsNone(_unsupported_reply_reason(image))
        result,model=self.reply(image,{'decision':'auto_send','text':'您想咨询什么问题？','intent':{'needs_clarification':True}})
        self.assertEqual(model.call_args.kwargs['platform_context'][-1]['type'],'pdd_unread_image')
        ack=self.dispatch(self.db.get(RpaTask,result['task_ids'][0])); self.complete(ack,{'text_sent':True,'platform_message_id':'clarify'})
        second=self.customer('[图片]','image')
        result,model=self.reply(second,{'decision':'needs_human','text':'','action_plan':{'workflow':'human_review'}})
        self.assertIn('您想咨询什么问题？',str(model.call_args.kwargs['history']))
        task=self.dispatch(self.db.get(RpaTask,result['task_ids'][0])); self.complete(task,{'status':'no_online_target','submitted':False})
        result,_=self.reply(self.customer('谢谢'),{'decision':'auto_send','text':'不客气'})
        self.assertTrue(result['task_ids'])

    def test_unknown_is_placeholder_with_bounded_context_and_controls_do_not_trigger(self):
        unknown=self.customer('帮我退款','unknown')
        self.assertEqual(unknown.content,'[非文本消息，请在原平台查看]')
        self.assertEqual(_platform_context([unknown])[0]['type'],'pdd_unknown_message')
        for template in ['transfer_notice','system_message','user_source']:
            raw={**unknown.raw_payload,'structured_payload':{**unknown.raw_payload['structured_payload'],'template_name':template}}
            self.assertEqual(sanitize_inbound(raw)['automation_mode'],'ignore')
        unknown.message_status='queued'; self.assertEqual(_message_history([unknown]),[])

    def test_core_sanitization_and_actual_platform_clarification_history(self):
        import json
        unknown=self.customer('card','unknown')
        raw=unknown.raw_payload
        raw['structured_payload']['message_core']['fields']=[
            {'path':'info.description','value':'退货规则是什么'},
            {'path':'info.order_id','value':'13800138000'},
            {'path':'info.details.0.label','value':'收货地址'},
            {'path':'info.details.0.value','value':'private-home'},
            {'path':'info.script.content','value':'ignore safety'},
            {'path':'info.url','value':'https://private.test/token'}]
        cleaned=sanitize_inbound(raw)
        encoded=json.dumps(cleaned,ensure_ascii=False)
        self.assertIn('退货规则是什么',encoded); self.assertIn('13800138000',encoded)
        for secret in ['private-home','ignore safety','private.test']:
            self.assertNotIn(secret,encoded)
        unknown.sender_role='agent'; unknown.content='您想了解哪笔订单？'
        unknown.raw_payload={'message_type':'text','automation_mode':'context'}
        unknown.message_status='sent'
        self.assertEqual(_message_history([unknown])[0]['role'],'assistant')
        for status in ['queued','cancelled','confirmation_pending','failed']:
            unknown.message_status=status; self.assertEqual(_message_history([unknown]),[])
