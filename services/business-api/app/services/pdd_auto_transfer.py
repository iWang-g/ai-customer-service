"""PDD prepare -> notice -> single transfer attempt, using the existing task queue."""
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import select, update
from sqlalchemy.orm import object_session

from app.models import Conversation, Message, RpaTask, Robot, RobotPlatformScope, User, utcnow
from app.services.settings_service import auto_reply_enabled

BLOCKED = {'preparing', 'ack_queued', 'ready', 'transferring', 'transferred', 'confirmation_pending'}


def state(c):
    if not c:
        return {}
    db = object_session(c)
    record = operation_record(db, c) if db else None
    value = (record.payload_json or {}).get('operation') if record else (c.metadata_json or {}).get('auto_transfer')
    return value if isinstance(value, dict) else {}


def operation_record(db, c):
    return db.scalar(select(RpaTask).where(RpaTask.user_id == c.user_id,
        RpaTask.idempotency_key == 'pdd-transfer-state:' + c.id).execution_options(populate_existing=True))


def blocked(c):
    return bool(c and c.platform_code == 'pinduoduo' and state(c).get('status') in BLOCKED)


def reply_blocked(c):
    op = state(c)
    return blocked(c) or bool(c and c.human_required and op.get('source') == 'automation'
        and op.get('status') in {'failed', 'unavailable'})


def enabled(db, c, robot_id):
    robot = db.get(Robot, robot_id) if robot_id else None
    if (not c or c.deleted_at or c.platform_code != 'pinduoduo' or not c.platform_account
            or not c.platform_account.is_active or not robot or robot.user_id != c.user_id
            or not robot.enabled or robot.status != 'online'
            or not auto_reply_enabled(db, db.get(User, c.user_id))):
        return False
    config = robot.config_json or {}
    scopes = db.scalars(select(RobotPlatformScope).where(RobotPlatformScope.robot_id == robot.id))
    return (config.get('allow_auto_send') is True and config.get('human_handoff_strategy') == 'transfer_conversation'
            and any(s.platform_code == 'all' or (s.platform_code == 'pinduoduo'
                and (s.all_accounts or s.platform_account_id == c.platform_account_id)) for s in scopes))


def set_state(db, c, op):
    # Keep an authoritative record so a concurrent conversation snapshot cannot erase the barrier.
    record = operation_record(db, c)
    if record:
        changed = db.execute(update(RpaTask).where(RpaTask.id == record.id, RpaTask.payload_json == record.payload_json)
            .values(status=op['status'], payload_json={'operation': op}).execution_options(synchronize_session=False))
        if changed.rowcount != 1:
            raise HTTPException(409, '拼多多转接状态已变化')
        db.expire(record)
    else:
        db.add(RpaTask(user_id=c.user_id, platform_code='pinduoduo', platform_account_id=c.platform_account_id,
            conversation_id=c.id, task_type='pdd_transfer_state', status=op['status'],
            idempotency_key='pdd-transfer-state:' + c.id, payload_json={'operation': op}))
    old = dict(c.metadata_json or {})
    changed = db.execute(update(Conversation).where(Conversation.id == c.id, Conversation.metadata_json == c.metadata_json)
        .values(metadata_json={**old, 'auto_transfer': {**op, 'updated_at': utcnow().isoformat()}})
        .execution_options(synchronize_session=False))
    if changed.rowcount != 1:
        raise HTTPException(409, '拼多多转接状态已变化')
    db.expire(c, ['metadata_json'])


def cancel_queued(db, c, op):
    for task in db.scalars(select(RpaTask).where(RpaTask.conversation_id == c.id,
            RpaTask.platform_code == 'pinduoduo', RpaTask.task_type == 'send_message',
            RpaTask.status.in_(['queued', 'waiting_timeout']))):
        task.status = 'failed'
        task.error_message = 'cancelled_by_transfer'
        task.result_json = {'cancelled_by_transfer': op['id']}
        if task.message_id:
            message = db.get(Message, task.message_id)
            if message and message.message_status != 'sent':
                message.message_status = 'cancelled'


def finish(db, c, op, status, error=''):
    set_state(db, c, {**op, 'status': status, 'error': error, 'completed_at': utcnow().isoformat()})
    cancel_queued(db, c, op)
    if status in {'failed', 'confirmation_pending'} and not c.human_required:
        c.human_required = True
        c.human_required_reason = error or 'pdd_transfer_confirmation_pending'
        c.human_required_at = utcnow()
    # Neither unavailable nor success clears an independently set human marker.


def task_for(db, c, op, kind):
    key = f"pdd-{kind}:{op['source_message_id']}"
    existing = db.scalar(select(RpaTask).where(RpaTask.idempotency_key == key, RpaTask.user_id == c.user_id))
    if existing:
        return existing
    task = RpaTask(user_id=c.user_id, platform_account_id=c.platform_account_id, conversation_id=c.id,
        platform_code='pinduoduo', task_type='pdd_transfer_prepare' if kind == 'prepare' else 'transfer_conversation',
        status='queued', priority=10, idempotency_key=key,
        payload_json={'pdd_auto_operation_id': op['id'], 'conversation_id': c.id,
            'platform_account_id': c.platform_account_id, 'external_conversation_id': c.external_conversation_id,
            'customer_name': c.customer_name or '', 'source': 'automation_transfer',
            'target_csid': op.get('target_cs_id', ''), 'trans_reason': '无原因直接转移'})
    db.add(task)
    db.flush()
    return task


def queue(db, user, c, robot, source, reason):
    if not enabled(db, c, robot.id):
        raise HTTPException(409, '拼多多自动转接策略未启用')
    if reply_blocked(c):
        return {'decision': 'no_reply', 'text': '', 'task_ids': [], 'suppression_reason': 'pdd_transfer'}
    prior = db.scalar(select(RpaTask).where(RpaTask.idempotency_key == f'pdd-prepare:{source.id}',
                                          RpaTask.user_id == user.id))
    if prior:
        return {'decision': 'no_reply', 'text': '', 'task_ids': [], 'suppression_reason': 'duplicate_transfer_source'}
    op = {'id': uuid4().hex, 'status': 'preparing', 'source': 'automation', 'robot_id': robot.id,
          'source_message_id': source.id, 'reason': reason, 'started_at': utcnow().isoformat()}
    set_state(db, c, op)
    cancel_queued(db, c, op)
    active_send = db.scalar(select(RpaTask.id).where(RpaTask.conversation_id == c.id,
        RpaTask.task_type == 'send_message', RpaTask.status.in_(['dispatched', 'acknowledged', 'confirmation_pending'])).limit(1))
    if active_send:
        finish(db, c, op, 'confirmation_pending', 'transfer_send_in_progress')
        db.commit()
        return {'decision': 'needs_human', 'text': '', 'task_ids': []}
    task = task_for(db, c, op, 'prepare')
    db.commit()
    return {'decision': 'needs_human', 'text': '', 'task_ids': [task.id],
            'action_plan': {'workflow': 'pdd_auto_transfer', 'next_action': 'query_online_staff'}, 'transfer_reason': reason}


def ack_allowed(db, c, task):
    op = state(c)
    return bool(task and op.get('status') == 'ack_queued' and task.id == op.get('ack_task_id')
        and (task.payload_json or {}).get('pdd_auto_operation_id') == op.get('id')
        and enabled(db, c, op.get('robot_id')) and not c.human_required)


def validate(db, user, task):
    c = db.get(Conversation, task.conversation_id) if task else None
    if (not task or task.user_id != user.id or task.platform_code != 'pinduoduo' or not c
            or task.platform_account_id != c.platform_account_id or c.deleted_at
            or task.status not in {'dispatched', 'acknowledged'}):
        raise HTTPException(409, '拼多多任务已失效')
    op = state(c)
    operation_id = (task.payload_json or {}).get('pdd_auto_operation_id')
    if operation_id:
        expected = {'pdd_transfer_prepare': 'preparing', 'send_message': 'ack_queued', 'transfer_conversation': 'ready'}
        if (op.get('id') != operation_id or expected.get(task.task_type) != op.get('status')
                or not enabled(db, c, op.get('robot_id')) or c.human_required):
            raise HTTPException(409, '拼多多转接任务已失效或策略已关闭')
        if task.task_type == 'transfer_conversation':
            set_state(db, c, {**op, 'status': 'transferring', 'transfer_task_id': task.id})
            db.commit()  # Claim once before the native request; never replay an uncertain submit.
    elif task.task_type in {'send_message', 'send_image', 'transfer_conversation'} and (blocked(c) or reply_blocked(c) and (task.payload_json or {}).get('source') == 'automation'):
        raise HTTPException(409, '拼多多会话正在转接、已转出或结果待核对')
    return {'allowed': True}


def completed(db, task):
    if task.platform_code != 'pinduoduo' or not (task.payload_json or {}).get('pdd_auto_operation_id'):
        return
    c = db.get(Conversation, task.conversation_id)
    op = state(c)
    if not op or op.get('id') != task.payload_json['pdd_auto_operation_id'] or op.get('status') not in BLOCKED - {'transferred', 'confirmation_pending'}:
        return
    result = task.result_json or {}
    if task.task_type == 'send_message' and op.get('status') == 'ack_queued':
        if not enabled(db, c, op.get('robot_id')) or c.human_required:
            finish(db, c, op, 'failed', 'pdd_auto_transfer_disabled')
            return
        ready = {**op, 'status': 'ready', 'ack_status': task.status}
        set_state(db, c, ready)
        task_for(db, c, ready, 'execute')
    elif task.task_type in {'pdd_transfer_prepare', 'transfer_conversation'}:
        if task.status == 'completed' and result.get('status') == 'no_online_target' and result.get('submitted') is False:
            ack = db.get(RpaTask, op['ack_task_id']) if op.get('ack_task_id') else None
            uncertain = ack and ack.status in {'dispatched', 'acknowledged', 'confirmation_pending'}
            finish(db, c, op, 'confirmation_pending' if uncertain else 'unavailable', 'no_online_transfer_target')
        elif (task.task_type == 'pdd_transfer_prepare' and task.status == 'completed' and result.get('status') == 'prepared'
                and result.get('submitted') is False and isinstance(result.get('target_cs_id'), str)
                and 0 < len(result['target_cs_id']) <= 128):
            if not enabled(db, c, op.get('robot_id')) or c.human_required:
                finish(db, c, op, 'failed', 'pdd_auto_transfer_disabled')
                return
            from app.services.message_service import create_send_task
            from app.schemas.message import SendMessageRequest
            next_op = {**op, 'status': 'ack_queued', 'target_cs_id': str(result['target_cs_id']),
                       'target_cs_username': str(result.get('target_cs_username') or '')}
            set_state(db, c, next_op)
            response = create_send_task(db, db.get(User, c.user_id), SendMessageRequest(conversation_id=c.id,
                platform_code='pinduoduo', content='为您转接中'), source='automation',
                idempotency_key='pdd-transfer-ack:' + op['id'], automation_context={'pdd_auto_operation_id': op['id']})
            set_state(db, c, {**next_op, 'ack_task_id': response.task_id})
        elif (task.task_type == 'transfer_conversation' and task.status == 'completed' and result.get('status') == 'transferred'
                and result.get('submitted') is True and result.get('target_cs_id') == op.get('target_cs_id')
                and isinstance(result.get('result'), dict) and result['result'].get('result') == 'ok'):
            finish(db, c, op, 'transferred')
        else:
            uncertain = task.task_type == 'transfer_conversation' and result.get('submitted') is not False
            finish(db, c, op, 'confirmation_pending' if uncertain else 'failed', task.error_message or 'pdd_auto_transfer_failed')


def reconcile_pending(db, user_id):
    from datetime import datetime, timezone
    records = list(db.scalars(select(RpaTask).where(RpaTask.user_id == user_id,
        RpaTask.task_type == 'pdd_transfer_state', RpaTask.status.in_(['preparing', 'ack_queued', 'ready', 'transferring']))))
    for record in records:
        c = db.get(Conversation, record.conversation_id)
        op = state(c)
        if not op.get('id') or op.get('status') not in {'preparing', 'ack_queued', 'ready', 'transferring'}:
            continue
        started = datetime.fromisoformat(op['started_at']).replace(tzinfo=timezone.utc)
        if (utcnow().replace(tzinfo=timezone.utc) - started).total_seconds() < 300 and enabled(db, c, op.get('robot_id')) and not c.human_required:
            continue
        ack = db.get(RpaTask, op['ack_task_id']) if op.get('ack_task_id') else None
        uncertain = op['status'] == 'transferring' or ack and ack.status in {'dispatched', 'acknowledged', 'confirmation_pending'}
        finish(db, c, op, 'confirmation_pending' if uncertain else 'failed', 'pdd_auto_transfer_expired_or_disabled')
