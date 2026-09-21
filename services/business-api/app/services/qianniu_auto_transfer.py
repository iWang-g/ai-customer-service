"""Durable prepare -> confirmed notice -> transfer workflow for Qianniu."""
import re
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError

from app.models import Conversation, Message, RpaTask, Robot, RobotPlatformScope, User, utcnow
from app.services import qianniu_transfer_service as transfer
from app.services.settings_service import auto_reply_enabled
from app.services.qianniu_transfer_notice import notice_time

ACK = '为您转接中'
PHASES = {'preparing', 'ack_queued', 'ready'}


def enabled(db, c, robot_id):
    if not c or c.deleted_at or c.platform_code != 'qianniu' or not c.platform_account or not c.platform_account.is_active:
        return False
    robot = db.get(Robot, robot_id)
    if (not robot or robot.user_id != c.user_id or not robot.enabled or robot.status != 'online'
            or not auto_reply_enabled(db, db.get(User, c.user_id))):
        return False
    config = robot.config_json or {}
    scopes = db.scalars(select(RobotPlatformScope).where(RobotPlatformScope.robot_id == robot.id))
    return (config.get('allow_auto_send') is True and config.get('human_handoff_strategy') == 'transfer_conversation'
        and any(s.platform_code == 'all' or (s.platform_code == 'qianniu'
            and (s.all_accounts or s.platform_account_id == c.platform_account_id)) for s in scopes))


def set_operation(db, c, record, operation):
    old_payload = dict(record.payload_json or {})
    changed = db.execute(update(RpaTask).where(RpaTask.id == record.id, RpaTask.payload_json == old_payload)
        .values(status=operation['status'], payload_json={'operation': operation})
        .execution_options(synchronize_session=False))
    if changed.rowcount != 1:
        raise HTTPException(409, '千牛自动转接状态已变化')
    db.expire(record)
    # The separate operation record remains authoritative if a snapshot changes metadata.
    c.metadata_json = {**(c.metadata_json or {}), transfer.KEY: operation}
    db.add(c)


def fail(db, c, record, reason):
    op = dict(record.payload_json['operation'])
    set_operation(db, c, record, {**op, 'status': 'failed', 'error': reason,
        'completed_at': utcnow().isoformat()})
    c.human_required = True
    c.human_required_reason = reason
    c.human_required_at = utcnow()
    cancel_queued_replies(db, c, op, reason)


def cancel_queued_replies(db, c, op, reason):
    # Never resume ordinary replies generated before the handoff decision.
    for task in db.scalars(select(RpaTask).where(RpaTask.conversation_id == c.id,
            RpaTask.platform_code == 'qianniu', RpaTask.task_type == 'send_message',
            RpaTask.status.in_(['queued', 'waiting_timeout']))):
        task.status = 'failed'
        task.result_json = {'cancelled_by_transfer': op['id']}
        task.error_message = reason
        if task.message_id:
            message = db.get(Message, task.message_id)
            if message and message.message_status != 'sent':
                message.message_status = 'cancelled'


def unavailable(db, c, record, op):
    """A successful empty roster ends only this attempt, never human takeover."""
    ack = db.scalar(select(RpaTask).where(RpaTask.idempotency_key == 'qn-transfer-ack:' + op['id']))
    uncertain = ack and ack.status in {'dispatched', 'acknowledged', 'confirmation_pending'}
    set_operation(db, c, record, {**op,
        'status': 'confirmation_pending' if uncertain else 'unavailable',
        'error': 'no_online_transfer_target', 'completed_at': utcnow().isoformat(),
        **({'confirmation_pending_stage': 'ack'} if uncertain else {})})
    # Do not clear a human marker set independently. Do not resurrect queued replies
    # from before the handoff decision when lifting the transfer barrier.
    cancel_queued_replies(db, c, op, 'no_online_transfer_target')


def queue(db, user, c, robot, source, reason):
    _, identity = transfer.context(db, user, c.id)
    record = transfer.operation_record(db, c.id)
    previous = (record.payload_json or {}).get('operation', {}) if record else {}
    # A returned system notice, or an unresolved returned request, must not loop.
    explicit_human = source.sender_role == 'customer' and bool(re.search(r'转人工|转客服|找人工|人工客服', source.content))
    if source.sender_role != 'customer' or (previous.get('status') == 'returned' and not explicit_human):
        c.human_required = True
        c.human_required_reason = 'returned_handoff_requires_human'
        c.human_required_at = utcnow()
        db.commit()
        return {'decision': 'needs_human', 'text': '', 'task_ids': [], 'reason': c.human_required_reason}
    if not enabled(db, c, robot.id):
        raise HTTPException(409, '千牛自动转接策略未启用')
    if previous.get('status') in transfer.BLOCKED:
        return {'decision': 'no_reply', 'text': '', 'task_ids': [], 'suppression_reason': 'qianniu_transfer'}
    if previous.get('source_message_id') == source.id:
        return {'decision': 'needs_human', 'text': '', 'task_ids': [], 'reason': 'duplicate_transfer_source'}
    active = db.scalar(select(RpaTask.id).where(RpaTask.conversation_id == c.id,
        RpaTask.platform_code == 'qianniu', RpaTask.task_type == 'send_message',
        RpaTask.status.in_(['dispatched', 'acknowledged', 'confirmation_pending'])).limit(1))
    if active:
        c.human_required = True
        c.human_required_reason = 'transfer_send_in_progress'
        c.human_required_at = utcnow()
        db.commit()
        return {'decision': 'needs_human', 'text': '', 'task_ids': [], 'reason': c.human_required_reason}
    op = {'id': uuid4().hex, 'status': 'preparing', 'source': 'automation', 'robot_id': robot.id,
        'operator_id': user.id, 'source_message_id': source.id, 'reason': reason, 'trigger_reason': reason,
        'source_shop_uid': identity['shopUid'], 'buyer_uid': identity['buyerUid'], 'cid': identity['cid'],
        'started_at': utcnow().isoformat()}
    if record:
        set_operation(db, c, record, op)
    else:
        record = RpaTask(user_id=user.id, platform_account_id=c.platform_account_id, conversation_id=c.id,
            platform_code='qianniu', task_type='qianniu_manual_transfer', status='preparing',
            idempotency_key='qn-transfer:' + c.id, payload_json={'operation': op})
        db.add(record)
        c.metadata_json = {**(c.metadata_json or {}), transfer.KEY: op}
    task = RpaTask(user_id=user.id, platform_account_id=c.platform_account_id, conversation_id=c.id,
        platform_code='qianniu', task_type='qianniu_transfer_prepare', status='queued', priority=10,
        idempotency_key='qn-prepare:' + source.id,
        payload_json={'conversation_id': c.id, 'qianniu_auto_operation_id': op['id']})
    db.add(task)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, '千牛自动转接已由另一任务处理')
    return {'decision': 'needs_human', 'text': '', 'task_ids': [task.id],
        'action_plan': {'workflow': 'qianniu_auto_transfer', 'next_action': 'query_online_staff'},
        'transfer_reason': reason}


def ack_allowed(db, c, task):
    op = transfer.current_operation(db, c) or {}
    return bool(task and task.conversation_id == c.id and task.platform_code == 'qianniu'
        and task.task_type == 'send_message' and task.status in {'queued', 'dispatched', 'acknowledged'}
        and task.idempotency_key == 'qn-transfer-ack:' + str(op.get('id'))
        and task.payload_json.get('content') == ACK
        and op.get('status') == 'ack_queued' and enabled(db, c, op.get('robot_id')))


def _queue_execute(db, c, record, op, *, ack_task, ack_status, ack_error=None):
    """Advance once to transfer execution, regardless of the notice outcome."""
    ready = {**op, 'status': 'ready', 'ack_task_id': ack_task.id,
        'ack_status': ack_status}
    if ack_error:
        ready['ack_error'] = ack_error
    set_operation(db, c, record, ready)
    execute_key = 'qn-execute:' + op['id']
    existing = db.scalar(select(RpaTask.id).where(RpaTask.idempotency_key == execute_key))
    if existing:
        return
    db.add(RpaTask(user_id=c.user_id, platform_account_id=c.platform_account_id, conversation_id=c.id,
        platform_code='qianniu', task_type='qianniu_transfer_execute', status='queued', priority=10,
        idempotency_key=execute_key,
        payload_json={'conversation_id': c.id, 'qianniu_auto_operation_id': op['id']}))


def check_task(db, user, conversation_id, task_id):
    c, identity = transfer.context(db, user, conversation_id)
    task = db.get(RpaTask, task_id)
    op = identity.get('transfer') or {}
    expected = {'qianniu_transfer_prepare': 'preparing', 'qianniu_transfer_execute': 'ready'}
    if (not task or task.user_id != user.id or task.conversation_id != c.id
            or task.platform_account_id != c.platform_account_id or task.platform_code != 'qianniu'
            or task.status not in {'dispatched', 'acknowledged'}
            or task.payload_json.get('qianniu_auto_operation_id') != op.get('id')
            or expected.get(task.task_type) != op.get('status') or not enabled(db, c, op.get('robot_id'))):
        raise HTTPException(409, '千牛自动转接任务已失效或策略已关闭')
    return identity


def completed(db, task):
    if task.platform_code != 'qianniu':
        return
    operation_id = (task.payload_json or {}).get('qianniu_auto_operation_id')
    if not operation_id:
        return
    c = db.get(Conversation, task.conversation_id)
    record = transfer.operation_record(db, c.id)
    op = dict((record.payload_json or {}).get('operation', {})) if record else {}
    if (op.get('id') == operation_id and task.task_type == 'qianniu_transfer_execute'
            and op.get('status') == 'transferred'):
        task.status = 'completed'
        task.result_json = {**(task.result_json or {}), 'status': 'transferred', 'target_cs_username': op['target_nick']}
        task.error_message = None
        return
    if (op.get('id') == operation_id and op.get('status') == 'transferring'
            and task.task_type == 'qianniu_transfer_execute' and task.status != 'completed'):
        transfer.finish(db, db.get(User, c.user_id), c.id, operation_id, 'confirmation_pending', {},
            '执行中断或回执保存未完成，请核对千牛转接结果')
        return
    if op.get('id') != operation_id or op.get('status') not in PHASES:
        return
    if task.status != 'completed':
        if (task.task_type == 'send_message'
                and task.status in {'failed', 'confirmation_pending'}
                and enabled(db, c, op.get('robot_id'))):
            _queue_execute(db, c, record, op, ack_task=task,
                ack_status='confirmation_pending' if task.status == 'confirmation_pending' else 'failed',
                ack_error=task.error_message or ('提示发送结果待确认'
                    if task.status == 'confirmation_pending' else 'qianniu_transfer_ack_failed'))
        elif task.status == 'confirmation_pending':
            set_operation(db, c, record, {**op, 'status': 'confirmation_pending', 'confirmation_pending_stage': 'ack',
                'error': '提示发送结果待确认'})
        else:
            fail(db, c, record, task.error_message or 'qianniu_auto_transfer_failed')
        return
    if not enabled(db, c, op.get('robot_id')):
        fail(db, c, record, 'qianniu_auto_transfer_disabled')
        return
    result = task.result_json or {}
    if (result.get('status') == 'no_online_target' and result.get('submitted') is False
            and ((task.task_type == 'qianniu_transfer_prepare' and op['status'] == 'preparing')
                 or (task.task_type == 'qianniu_transfer_execute' and op['status'] == 'ready'))):
        unavailable(db, c, record, op)
        return
    if task.task_type == 'qianniu_transfer_prepare' and op['status'] in {'preparing', 'ack_queued'}:
        target = (task.result_json or {}).get('target') or {}
        if (not re.fullmatch(r'\d{1,30}', str(target.get('uid', '')))
                or target.get('uid') == op['source_shop_uid']
                or not str(target.get('nick', '')).startswith(c.platform_account.account_name.split(':')[0] + ':')):
            fail(db, c, record, 'invalid_transfer_target')
            return
        set_operation(db, c, record, {**op, 'status': 'ack_queued', 'target_uid': target['uid'], 'target_nick': target['nick']})
        db.flush()
        from app.services.message_service import create_send_task
        from app.schemas.message import SendMessageRequest
        create_send_task(db, db.get(User, c.user_id), SendMessageRequest(conversation_id=c.id,
            content=ACK, platform_code='qianniu'), source='automation',
            idempotency_key='qn-transfer-ack:' + op['id'],
            automation_context={'qianniu_auto_operation_id': op['id']})
    elif task.task_type == 'send_message' and op['status'] == 'ack_queued':
        if not (task.result_json or {}).get('text_sent') or not (task.result_json or {}).get('platform_message_id'):
            _queue_execute(db, c, record, op, ack_task=task,
                ack_status='confirmation_pending', ack_error='缺少提示发送业务回执')
            return
        _queue_execute(db, c, record, op, ack_task=task, ack_status='confirmed')


def reconcile_pending(db, user_id):
    """Only cancel work that has not submitted; uncertain sends stay blocked."""
    records = list(db.scalars(select(RpaTask).where(RpaTask.user_id == user_id,
        RpaTask.platform_code == 'qianniu', RpaTask.task_type == 'qianniu_manual_transfer',
        RpaTask.status.in_(PHASES))))
    for record in records:
        op = (record.payload_json or {}).get('operation') or {}
        if op.get('source') != 'automation':
            continue
        c = db.get(Conversation, record.conversation_id)
        started = notice_time(op.get('started_at'))
        expired = not started or (notice_time(utcnow()) - started).total_seconds() > 300
        if not expired and enabled(db, c, op.get('robot_id')):
            continue
        ack = db.scalar(select(RpaTask).where(RpaTask.idempotency_key == 'qn-transfer-ack:' + op['id']))
        if ack and ack.status in {'dispatched', 'acknowledged', 'confirmation_pending'}:
            set_operation(db, c, record, {**op, 'status': 'confirmation_pending',
                'confirmation_pending_stage': 'ack',
                'error': '自动转接已暂停，提示发送结果需要核对'})
            c.human_required = True
            c.human_required_reason = 'qianniu_transfer_confirmation_pending'
            c.human_required_at = utcnow()
        else:
            fail(db, c, record, 'qianniu_auto_transfer_expired' if expired else 'qianniu_auto_transfer_disabled')
        for child in db.scalars(select(RpaTask).where(RpaTask.conversation_id == c.id,
                RpaTask.task_type.in_(['qianniu_transfer_prepare', 'qianniu_transfer_execute']),
                RpaTask.status.in_(['queued', 'dispatched']))):
            if (child.payload_json or {}).get('qianniu_auto_operation_id') == op['id']:
                child.status = 'failed'
                child.error_message = '自动转接已暂停'
    if records:
        db.flush()
