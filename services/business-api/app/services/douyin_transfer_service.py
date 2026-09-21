"""Minimal manual transfer with a durable send barrier; no return handling."""
import re
from uuid import uuid4
from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy import select, update
from sqlalchemy.orm import object_session
from sqlalchemy.exc import IntegrityError

from app.models import Conversation, RpaTask, utcnow

KEY = 'douyin_transfer'
BLOCKED = {'preparing', 'ack_queued', 'ready', 'transferring', 'transferred', 'confirmation_pending'}


def operation_record(db, conversation_id):
    return db.scalar(select(RpaTask).where(RpaTask.idempotency_key == 'dy-transfer:' + conversation_id)
                     .execution_options(populate_existing=True))


def current_operation(db, conversation):
    task = operation_record(db, conversation.id) if db else None
    return (task.payload_json or {}).get('operation') if task else (conversation.metadata_json or {}).get(KEY)


def transfer_blocked(conversation):
    return bool(conversation and conversation.platform_code == 'douyin'
        and (current_operation(object_session(conversation), conversation) or {}).get('status') in BLOCKED)


def context(db, user, conversation_id, *, require_online=True):
    c = db.scalar(select(Conversation).where(Conversation.id == conversation_id, Conversation.user_id == user.id))
    if not c or c.deleted_at:
        raise HTTPException(404, '会话不存在')
    a = c.platform_account
    if c.platform_code != 'douyin' or not a or a.platform_code != 'douyin' or a.user_id != user.id or not a.is_active:
        raise HTTPException(409, '不是有效的抖店会话')
    meta = a.metadata_json or {}
    suffix = f':{a.external_account_id}::2:1:pigeon'
    cid = c.external_conversation_id or ''
    if not cid.endswith(suffix) or not cid[:-len(suffix)] or ':' in cid[:-len(suffix)] or len(cid) > 350:
        raise HTTPException(409, '抖店会话身份不完整，请先同步客户消息')
    staff = str(meta.get('cs_id') or '')
    if require_online and (a.login_status != 'online' or meta.get('im_ready') is not True
            or not re.fullmatch(r'\d{1,40}', staff)):
        raise HTTPException(409, '请先登录飞鸽并同步当前客服身份')
    return c, {'conversationId': c.id, 'platformAccountId': a.id, 'localAccountId': a.local_account_id,
        'shopId': a.external_account_id, 'staffId': staff, 'cid': cid, 'transfer': current_operation(db, c)}


def begin(db, user, conversation_id, target_id, target_name, source_id, reason, auto_task_id=None):
    c, identity = context(db, user, conversation_id)
    previous = identity.get('transfer') or {}
    if auto_task_id:
        from app.services.douyin_auto_transfer import check_task
        check_task(db, user, c.id, auto_task_id)
        if previous.get('status') != 'ready' or previous.get('target_id') != target_id:
            raise HTTPException(409, '自动转接目标已变化')
    elif transfer_blocked(c):
        raise HTTPException(409, '会话正在转接、已转出或待核对，不能重复转接')
    if (not re.fullmatch(r'\d{1,40}', target_id) or target_id == source_id or source_id != identity['staffId']):
        raise HTTPException(409, '当前客服或转接目标不匹配')
    active = db.scalar(select(RpaTask.id).where(RpaTask.conversation_id == c.id,
        RpaTask.platform_code == 'douyin', RpaTask.task_type == 'send_message',
        RpaTask.status.in_(['queued', 'waiting_timeout', 'dispatched', 'acknowledged', 'confirmation_pending']),
        RpaTask.id != (previous.get('ack_task_id') if auto_task_id else '')).limit(1))
    if active:
        raise HTTPException(409, '该会话仍有消息发送中或待确认，请完成后再转接')
    op = {**(previous if auto_task_id else {}), 'id': previous['id'] if auto_task_id else uuid4().hex,
        'status': 'transferring', 'started_at': utcnow().isoformat(),
        'source_staff_id': source_id, 'target_id': target_id, 'target_name': target_name,
        'shop_id': identity['shopId'], 'cid': identity['cid'], 'reason': reason}
    old = dict(c.metadata_json or {})
    task = operation_record(db, c.id)
    if task:
        changed = db.execute(update(RpaTask).where(RpaTask.id == task.id,
            RpaTask.status.in_(['ready'] if auto_task_id else ['failed', 'unavailable']),
            RpaTask.payload_json == task.payload_json).values(status='transferring', payload_json={'operation': op},
            result_json={}, completed_at=None).execution_options(synchronize_session=False))
        if changed.rowcount != 1:
            db.rollback(); raise HTTPException(409, '转接状态已变化')
    else:
        db.add(RpaTask(user_id=user.id, platform_code='douyin', platform_account_id=c.platform_account_id,
            conversation_id=c.id, task_type='douyin_manual_transfer', status='transferring',
            idempotency_key='dy-transfer:' + c.id, payload_json={'operation': op}))
        try: db.flush()
        except IntegrityError:
            db.rollback(); raise HTTPException(409, '已存在转接操作')
    changed = db.execute(update(Conversation).where(Conversation.id == c.id, Conversation.metadata_json == old)
        .values(metadata_json={**old, KEY: op}).execution_options(synchronize_session=False))
    if changed.rowcount != 1:
        db.rollback(); raise HTTPException(409, '会话状态已变化，请重新选择客服')
    db.commit(); db.expire_all()
    return op


def _time(value):
    try:
        d = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return d.replace(tzinfo=timezone.utc) if d.tzinfo is None else d
    except (AttributeError, TypeError, ValueError):
        return None


def finish(db, user, conversation_id, operation_id, outcome, evidence, error):
    c, _ = context(db, user, conversation_id, require_online=False)
    task = operation_record(db, c.id)
    op = dict((task.payload_json or {}).get('operation') or {}) if task else {}
    if op.get('id') != operation_id:
        raise HTTPException(409, '转接操作不匹配')
    if op.get('status') != 'transferring':
        if op.get('status') == outcome: return op
        raise HTTPException(409, '已保存的转接结果不能被覆盖')
    if outcome not in {'transferred', 'failed', 'confirmation_pending'}:
        raise HTTPException(400, '无效转接结果')
    if outcome == 'transferred':
        sent, observed, submitted, started = [_time(evidence.get(k)) for k in ['platform_sent_at', 'observed_at', 'submitted_at']] + [_time(op['started_at'])]
        if not (all(evidence.get(k) == op[v] for k, v in [
                ('conversation_id', 'cid'), ('shop_id', 'shop_id'), ('source_staff_id', 'source_staff_id'), ('target_staff_id', 'target_id')])
            and evidence.get('method') == 'douyin_transfer_event_v1' and evidence.get('sdk_resolved') is True
            and isinstance(evidence.get('server_id'), str) and 0 < len(evidence['server_id']) <= 128 and evidence['server_id'] != '0'
            and evidence.get('server_status') == 0 and evidence.get('is_offline') is False and evidence.get('pull_source') == 1
            and sent and observed and submitted and started and -5 <= (submitted - started).total_seconds() <= 120
            and -5 <= (sent - submitted).total_seconds() <= 30 and 0 <= (observed - submitted).total_seconds() <= 30
            and -5 <= (observed - sent).total_seconds() <= 30):
            raise HTTPException(400, '缺少匹配的抖店转出事件，结果待核对')
    if outcome == 'failed' and evidence.get('submitted') is not False:
        raise HTTPException(400, '已提交的转接不能仅凭异常判定失败')
    op.update(status=outcome, completed_at=utcnow().isoformat(), error=error)
    old = dict(c.metadata_json or {})
    changed = db.execute(update(RpaTask).where(RpaTask.id == task.id, RpaTask.status == 'transferring')
        .values(status=outcome, payload_json={'operation': op}, result_json={'evidence': evidence}, completed_at=utcnow())
        .execution_options(synchronize_session=False))
    if changed.rowcount != 1:
        db.rollback(); raise HTTPException(409, '转接结果已变化')
    changed = db.execute(update(Conversation).where(Conversation.id == c.id, Conversation.metadata_json == old)
        .values(metadata_json={**old, KEY: op}, **({'awaiting_reply': False} if outcome == 'transferred' else {}))
        .execution_options(synchronize_session=False))
    if changed.rowcount != 1:
        db.rollback(); raise HTTPException(409, '会话状态变化，转接结果待核对')
    db.commit(); db.expire_all()
    return op


def send_guard(db, user, task_id):
    task = db.get(RpaTask, task_id)
    if not task or task.user_id != user.id or task.platform_code != 'douyin' or task.task_type != 'send_message':
        raise HTTPException(404, '发送任务不存在')
    from app.services.douyin_auto_transfer import ack_allowed
    c = db.get(Conversation, task.conversation_id)
    return {'allowed': task.status == 'confirmation_pending' and (not transfer_blocked(c) or ack_allowed(db, c, task))}
