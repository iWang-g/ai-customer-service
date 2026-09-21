"""Durable Douyin prepare -> one notice -> transfer; no-target is nonblocking."""
import re
from datetime import timezone
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError

from app.models import Conversation, Message, Robot, RpaTask, User, utcnow
from app.services import douyin_transfer_service as transfer
from app.services.douyin_automation import robot_matches
from app.services.settings_service import auto_reply_enabled

ACK = '为您转接中'
PHASES = {'preparing', 'ack_queued', 'ready'}


def enabled(db, c, robot_id):
    if not c or c.deleted_at or c.platform_code != 'douyin' or c.human_required:
        return False
    a = c.platform_account
    meta = (a.metadata_json or {}) if a else {}
    robot = db.get(Robot, robot_id) if robot_id else None
    return bool(a and a.is_active and a.login_status == 'online' and a.last_rpa_node_id
        and all(meta.get(k) is True for k in ('im_ready', 'message_send_enabled', 'ai_text_reply_enabled'))
        and robot_matches(db, robot, c) and auto_reply_enabled(db, db.get(User, c.user_id))
        and (robot.config_json or {}).get('allow_auto_send') is True
        and (robot.config_json or {}).get('human_handoff_strategy') == 'transfer_conversation')


def set_operation(db, c, record, op):
    old = dict(record.payload_json or {})
    changed = db.execute(update(RpaTask).where(RpaTask.id == record.id, RpaTask.payload_json == old)
        .values(status=op['status'], payload_json={'operation': op}).execution_options(synchronize_session=False))
    if changed.rowcount != 1:
        raise HTTPException(409, '抖店自动转接状态已变化')
    db.expire(record)
    c.metadata_json = {**(c.metadata_json or {}), transfer.KEY: op}
    db.add(c)


def fail(db, c, record, reason, *, unavailable=False):
    op = dict(record.payload_json['operation'])
    set_operation(db, c, record, {**op, 'status': 'unavailable' if unavailable else 'failed',
        'error': reason, 'completed_at': utcnow().isoformat()})
    # No staff is a failure of this attempt, not a customer takeover.
    if not unavailable:
        c.human_required = True
        c.human_required_reason = reason
        c.human_required_at = utcnow()
    for task in db.scalars(select(RpaTask).where(RpaTask.conversation_id == c.id,
            RpaTask.platform_code == 'douyin', RpaTask.status.in_(['queued', 'dispatched', 'acknowledged']))):
        if (task.payload_json or {}).get('douyin_auto_operation_id') != op['id']:
            continue
        task.status = 'failed'
        task.error_message = reason
        if task.message_id:
            message = db.get(Message, task.message_id)
            if message and message.message_status != 'sent':
                message.message_status = 'cancelled'


def queue(db, user, c, robot, source, reason):
    db.refresh(c); db.refresh(robot)
    if c.platform_account:
        db.refresh(c.platform_account)
    if not enabled(db, c, robot.id):
        return {'decision': 'no_reply', 'text': '', 'task_ids': [], 'suppression_reason': '自动转接策略已关闭'}
    from app.services.douyin_automation import reply_block_reason
    blocked = reply_block_reason(db, c, source, robot)
    if blocked:
        return {'decision': 'no_reply', 'text': '', 'task_ids': [], 'suppression_reason': blocked}
    _, identity = transfer.context(db, user, c.id)
    record = transfer.operation_record(db, c.id)
    if db.scalar(select(RpaTask.id).where(RpaTask.idempotency_key == 'dy-prepare:' + source.id)):
        return {'decision': 'no_reply', 'text': '', 'task_ids': [], 'suppression_reason': 'duplicate_transfer_source'}
    op = {'id': uuid4().hex, 'status': 'preparing', 'source': 'automation', 'robot_id': robot.id,
        'source_message_id': source.id, 'reason': str(reason)[:500], 'started_at': utcnow().isoformat(),
        'source_staff_id': identity['staffId'], 'shop_id': identity['shopId'], 'cid': identity['cid']}
    if record:
        if (record.payload_json or {}).get('operation', {}).get('status') in transfer.BLOCKED:
            return {'decision': 'no_reply', 'text': '', 'task_ids': [], 'suppression_reason': 'douyin_transfer'}
        set_operation(db, c, record, op)
    else:
        record = RpaTask(user_id=user.id, platform_account_id=c.platform_account_id, conversation_id=c.id,
            platform_code='douyin', task_type='douyin_manual_transfer', status='preparing',
            idempotency_key='dy-transfer:' + c.id, payload_json={'operation': op})
        db.add(record)
        c.metadata_json = {**(c.metadata_json or {}), transfer.KEY: op}
    task = RpaTask(user_id=user.id, platform_account_id=c.platform_account_id, conversation_id=c.id,
        node_id=c.platform_account.last_rpa_node_id, platform_code='douyin', task_type='douyin_transfer_prepare',
        status='queued', priority=10, idempotency_key='dy-prepare:' + source.id,
        payload_json={'conversation_id': c.id, 'douyin_auto_operation_id': op['id']})
    db.add(task)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        return {'decision': 'no_reply', 'text': '', 'task_ids': [], 'suppression_reason': 'duplicate_transfer_source'}
    return {'decision': 'needs_human', 'text': '', 'task_ids': [task.id],
        'action_plan': {'workflow': 'douyin_auto_transfer', 'next_action': 'query_online_staff'},
        'transfer_reason': reason}


def ack_creation_allowed(db, c, content, source, key, payload):
    op = transfer.current_operation(db, c) or {}
    return bool(source == 'automation' and content == ACK and op.get('status') == 'ack_queued'
        and key == 'dy-transfer-ack:' + str(op.get('id'))
        and payload.get('douyin_auto_operation_id') == op.get('id') and enabled(db, c, op.get('robot_id'))
        and c.external_conversation_id == op.get('cid')
        and c.platform_account.external_account_id == op.get('shop_id')
        and str((c.platform_account.metadata_json or {}).get('cs_id') or '') == op.get('source_staff_id'))


def ack_allowed(db, c, task):
    return bool(task and task.conversation_id == c.id and task.platform_account_id == c.platform_account_id
        and task.platform_code == 'douyin' and task.task_type == 'send_message'
        and task.status in {'queued', 'dispatched', 'acknowledged', 'confirmation_pending'}
        and ack_creation_allowed(db, c, (task.payload_json or {}).get('content'),
            (task.payload_json or {}).get('source'), task.idempotency_key, task.payload_json or {}))


def check_task(db, user, conversation_id, task_id):
    c, identity = transfer.context(db, user, conversation_id)
    task = db.get(RpaTask, task_id)
    op = identity.get('transfer') or {}
    expected = {'douyin_transfer_prepare': 'preparing', 'douyin_transfer_execute': 'ready'}
    if (not task or task.user_id != user.id or task.conversation_id != c.id
        or task.platform_account_id != c.platform_account_id or task.platform_code != 'douyin'
        or task.node_id != c.platform_account.last_rpa_node_id or task.status not in {'dispatched', 'acknowledged'}
        or (task.payload_json or {}).get('douyin_auto_operation_id') != op.get('id')
        or expected.get(task.task_type) != op.get('status') or not enabled(db, c, op.get('robot_id'))
        or identity['staffId'] != op.get('source_staff_id') or identity['cid'] != op.get('cid')
        or identity['shopId'] != op.get('shop_id')):
        raise HTTPException(409, '抖店自动转接任务已失效、身份变化或策略已关闭')
    return identity


def queue_execute(db, c, record, op, ack):
    status = 'confirmed' if ack.status == 'completed' else ack.status
    set_operation(db, c, record, {**op, 'status': 'ready', 'ack_task_id': ack.id,
        'ack_status': status, 'ack_error': ack.error_message})
    key = 'dy-execute:' + op['id']
    if not db.scalar(select(RpaTask.id).where(RpaTask.idempotency_key == key)):
        db.add(RpaTask(user_id=c.user_id, platform_account_id=c.platform_account_id, conversation_id=c.id,
            node_id=c.platform_account.last_rpa_node_id, platform_code='douyin', task_type='douyin_transfer_execute',
            status='queued', priority=10, idempotency_key=key,
            payload_json={'conversation_id': c.id, 'douyin_auto_operation_id': op['id']}))


def completed(db, task):
    operation_id = (task.payload_json or {}).get('douyin_auto_operation_id')
    if not operation_id:
        return
    c = db.get(Conversation, task.conversation_id)
    record = transfer.operation_record(db, c.id)
    op = dict((record.payload_json or {}).get('operation') or {}) if record else {}
    if op.get('id') != operation_id:
        return
    if task.task_type == 'douyin_transfer_execute' and op.get('status') in {'transferred', 'confirmation_pending', 'transferring', 'failed'}:
        if op['status'] == 'transferring':
            set_operation(db, c, record, {**op, 'status': 'confirmation_pending', 'error': '执行中断，请在飞鸽核对'})
        elif op['status'] == 'transferred':
            task.status = 'completed'
            task.error_message = None
        elif op['status'] == 'failed':
            fail(db, c, record, task.error_message or 'douyin_transfer_failed')
        return
    if op.get('status') not in PHASES:
        return
    if not enabled(db, c, op.get('robot_id')):
        fail(db, c, record, '自动转接策略已关闭或店铺不可用')
        return
    if task.task_type == 'send_message' and op['status'] == 'ack_queued':
        # The sender journals pending BEFORE calling SDK. Give the real receipt time to arrive.
        acknowledged = task.acked_at or task.requested_at
        age = (utcnow().replace(tzinfo=timezone.utc) - acknowledged.replace(tzinfo=timezone.utc)).total_seconds()
        if task.status == 'confirmation_pending' and age < 20:
            return
        if task.status in {'completed', 'failed', 'confirmation_pending'}:
            queue_execute(db, c, record, op, task)
        return
    if task.status != 'completed':
        fail(db, c, record, task.error_message or '抖店自动转接未执行')
        return
    if task.task_type in {'douyin_transfer_prepare', 'douyin_transfer_execute'} and (task.result_json or {}).get('status') == 'no_online_target':
        fail(db, c, record, '暂无其他在线客服，本次未转接；新消息仍会自动处理', unavailable=True)
        return
    if task.task_type == 'douyin_transfer_execute':
        task.status = 'failed'
        task.error_message = '缺少平台转接结果'
        fail(db, c, record, task.error_message)
        return
    if task.task_type == 'douyin_transfer_prepare' and op['status'] == 'preparing':
        result = task.result_json or {}
        target = result.get('target') or {}
        if (not re.fullmatch(r'\d{1,40}', str(target.get('id', ''))) or target['id'] == op['source_staff_id']
            or not isinstance(target.get('name'), str) or not 0 < len(target['name']) <= 128):
            fail(db, c, record, '无效的在线客服目标')
            return
        set_operation(db, c, record, {**op, 'status': 'ack_queued', 'target_id': target['id'], 'target_name': target['name']})
        db.flush()
        from app.services.message_service import create_send_task
        from app.schemas.message import SendMessageRequest
        create_send_task(db, db.get(User, c.user_id), SendMessageRequest(conversation_id=c.id,
            content=ACK, platform_code='douyin'), source='automation', idempotency_key='dy-transfer-ack:' + op['id'],
            automation_context={'douyin_auto_operation_id': op['id'], 'automation_robot_id': op['robot_id'],
                                'automation_source_message_id': op['source_message_id']})


def reconcile_pending(db, user_id):
    records = list(db.scalars(select(RpaTask).where(RpaTask.user_id == user_id,
        RpaTask.platform_code == 'douyin', RpaTask.task_type == 'douyin_manual_transfer', RpaTask.status.in_(PHASES))))
    for record in records:
        op = (record.payload_json or {}).get('operation') or {}
        if op.get('source') != 'automation':
            continue
        c = db.get(Conversation, record.conversation_id)
        started = transfer._time(op.get('started_at'))
        expired = not started or (utcnow().replace(tzinfo=timezone.utc) - started).total_seconds() > 300
        if expired or not enabled(db, c, op.get('robot_id')):
            fail(db, c, record, '自动转接已过期或策略已关闭')
        elif op['status'] == 'ack_queued':
            ack = db.scalar(select(RpaTask).where(RpaTask.idempotency_key == 'dy-transfer-ack:' + op['id']))
            if ack:
                completed(db, ack)
    db.flush()
