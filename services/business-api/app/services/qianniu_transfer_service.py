"""Durable per-conversation transfer barrier; platform execution stays on desktop."""
import re
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import select, update
from sqlalchemy.orm import Session, object_session
from sqlalchemy.exc import IntegrityError

from app.models import Conversation, Message, RpaTask, User, utcnow
from app.services.qianniu_transfer_notice import notice_time

KEY = 'qianniu_transfer'
BLOCKED = {'preparing', 'ack_queued', 'ready', 'transferring', 'transferred', 'confirmation_pending'}


def operation_record(db, conversation_id):
    return db.scalar(select(RpaTask).where(RpaTask.idempotency_key == 'qn-transfer:' + conversation_id)
                     .execution_options(populate_existing=True))


def current_operation(db, conversation):
    task = operation_record(db, conversation.id)
    return (task.payload_json or {}).get('operation') if task else (conversation.metadata_json or {}).get(KEY)


def transfer_blocked(conversation) -> bool:
    if not conversation or conversation.platform_code != 'qianniu':
        return False
    db = object_session(conversation)
    operation = current_operation(db, conversation) if db else (conversation.metadata_json or {}).get(KEY)
    return (operation or {}).get('status') in BLOCKED


def context(db: Session, user: User, conversation_id: str) -> tuple[Conversation, dict]:
    c = db.scalar(select(Conversation).where(Conversation.id == conversation_id, Conversation.user_id == user.id))
    if not c or c.deleted_at:
        raise HTTPException(404, '会话不存在')
    a = c.platform_account
    if c.platform_code != 'qianniu' or not a or a.platform_code != 'qianniu' or a.user_id != user.id or not a.is_active:
        raise HTTPException(409, '不是有效的千牛店铺会话')
    match = re.fullmatch(r'qianniu-(\d{1,30})', a.local_account_id or '')
    cid = c.external_conversation_id or ''
    pair = re.fullmatch(r'(\d+)\.1-(\d+)\.1#11001@cntaobao', cid)
    meta = c.metadata_json or {}
    buyer = str(meta.get('buyer_uid') or '')
    if not match or not pair or buyer not in pair.groups() or not c.customer_name or c.customer_name.isdecimal():
        raise HTTPException(409, '千牛买家身份不完整，先同步该会话消息')
    if meta.get('shop_uid') and str(meta['shop_uid']) != match[1] or meta.get('cid') and meta['cid'] != cid:
        raise HTTPException(409, '千牛会话绑定不一致')
    return c, {'conversationId': c.id, 'platformAccountId': a.id, 'shopUid': match[1], 'cid': cid,
               'buyerUid': buyer, 'buyerNick': c.customer_name.removeprefix('cntaobao'), 'shopName': a.account_name,
               'transfer': current_operation(db, c)}


def begin(db, user, conversation_id, target_uid, target_nick, reason, auto_task_id=None):
    c, identity = context(db, user, conversation_id)
    automatic = None
    if auto_task_id:
        from app.services.qianniu_auto_transfer import check_task
        automatic = check_task(db, user, conversation_id, auto_task_id)['transfer']
        send = db.get(RpaTask, automatic.get('ack_task_id'))
        if not send or send.status != 'completed' or not (send.result_json or {}).get('text_sent'):
            raise HTTPException(409, '转接提示尚未确认发送')
    if transfer_blocked(c) and not automatic:
        raise HTTPException(409, '该会话已转接或结果待确认，不能重复转接')
    if not re.fullmatch(r'\d{1,30}', target_uid) or ':' not in target_nick or target_uid == identity['shopUid']:
        raise HTTPException(400, '转接目标无效')
    active = db.scalar(select(RpaTask.id).where(RpaTask.conversation_id == c.id,
        RpaTask.platform_code == 'qianniu', RpaTask.task_type == 'send_message',
        RpaTask.status.in_(['dispatched', 'acknowledged', 'confirmation_pending'])).limit(1))
    if active:
        raise HTTPException(409, '该会话有发送中的任务，请等待完成再转接')
    old = dict(c.metadata_json or {})
    operation = {'id': uuid4().hex, 'status': 'transferring', 'operator_id': user.id,
        'started_at': utcnow().isoformat(), 'target_uid': target_uid, 'target_nick': target_nick,
        'reason': reason, 'source_shop_uid': identity['shopUid'], 'buyer_uid': identity['buyerUid'], 'cid': identity['cid']}
    if automatic:
        operation = {**automatic, **operation, 'id': automatic['id']}
    # A separate unique task record survives concurrent chat metadata updates.
    task = operation_record(db, c.id)
    if task:
        changed = db.execute(update(RpaTask).where(RpaTask.id == task.id,
            RpaTask.status.in_(['ready'] if automatic else ['failed', 'returned', 'unavailable']), RpaTask.payload_json == task.payload_json)
            .values(status='transferring', payload_json={'operation': operation}, completed_at=None).execution_options(synchronize_session=False))
        if changed.rowcount != 1:
            db.rollback(); raise HTTPException(409, '该会话已存在转接操作')
    else:
        task = RpaTask(user_id=user.id, platform_account_id=c.platform_account_id, conversation_id=c.id,
            platform_code='qianniu', task_type='qianniu_manual_transfer', idempotency_key='qn-transfer:' + c.id,
            status='transferring', payload_json={'operation': operation})
        db.add(task)
        try: db.flush()
        except IntegrityError:
            db.rollback(); raise HTTPException(409, '该会话已存在转接操作')
    changed = db.execute(update(Conversation).where(Conversation.id == c.id, Conversation.metadata_json == old)
        .values(metadata_json={**old, KEY: operation}).execution_options(synchronize_session=False))
    if changed.rowcount != 1:
        db.rollback()
        raise HTTPException(409, '会话状态变化，请重新打开转接窗口')
    db.commit()
    return operation


def receive_return_notice(db, conversation, message, request, *, historical_reconciliation=False):
    """Restore reception atomically with ingestion; historical reads never unlock."""
    payload = message.raw_payload or {}
    notice = payload.get('qianniu_transfer_notice')
    if (conversation.platform_code != 'qianniu' or message.sender_role != 'platform'
            or payload.get('template_id') != 101 or payload.get('message_type') != 'system'
            or payload.get('raw_direction') != 'incoming'
            or request.event_type != 'message_received' or payload.get('automation_mode') != 'trigger'
            or not isinstance(notice, dict) or not message.platform_message_id):
        return False
    account = conversation.platform_account
    shop = (account.local_account_id or '').removeprefix('qianniu-') if account else ''
    pair = re.fullmatch(r'(\d+)\.1-(\d+)\.1#11001@cntaobao', conversation.external_conversation_id or '')
    sent = notice_time(payload.get('platform_sent_at'))
    observed = notice_time(payload.get('observed_at') or request.received_at)
    names = re.fullmatch(r'由 ([^\r\n]+) 转交给 ([^\r\n]+)', message.content)
    if (not account or not account.is_active or account.platform_code != 'qianniu' or not pair
            or not sent or not observed or abs((observed - sent).total_seconds()) > 300
            or (not historical_reconciliation and abs((utcnow() - sent).total_seconds()) > 300) or not names
            or notice.get('receiver_uid') != shop or notice.get('target_nick') != account.account_name
            or notice.get('buyer_uid') != str((conversation.metadata_json or {}).get('buyer_uid') or '')
            or {notice.get('buyer_uid'), notice.get('main_uid')} != set(pair.groups())):
        return False
    prefix, sep, _ = account.account_name.partition(':')
    full = lambda name: name if ':' in name else prefix + ':' + name
    if (not sep or full(names[1]) != notice.get('source_nick') or full(names[2]) != account.account_name
            or not notice.get('source_nick', '').startswith(prefix + ':')
            or notice['source_nick'] == account.account_name):
        return False
    task = operation_record(db, conversation.id)
    operation = dict((task.payload_json or {}).get('operation') or {}) if task else {}
    if (not task or operation.get('status') not in {'transferred', 'confirmation_pending'}
            or operation.get('confirmation_pending_stage') == 'ack'):
        return False
    cutoff = notice_time(operation.get('completed_at') or operation.get('started_at'))
    if (not cutoff or sent <= cutoff or operation.get('source_shop_uid') != shop
            or operation.get('cid') != conversation.external_conversation_id
            or operation.get('buyer_uid') != notice['buyer_uid']
            or operation.get('target_nick') != notice['source_nick']):
        return False
    returned = {**operation, 'status': 'returned', 'returned_at': sent.isoformat(),
                'return_message_id': message.platform_message_id, 'return_notice': notice,
                'historical_reconciliation': historical_reconciliation}
    audit = [*((task.result_json or {}).get('audit') or []), returned]
    changed = db.execute(update(RpaTask).where(RpaTask.id == task.id, RpaTask.status == task.status,
        RpaTask.payload_json == task.payload_json).values(status='returned', payload_json={'operation': returned},
        result_json={'audit': audit}).execution_options(synchronize_session=False))
    if changed.rowcount != 1:
        raise HTTPException(409, '转接状态变化，请重试通知处理')
    db.expire(task)
    old = dict(conversation.metadata_json or {})
    changed = db.execute(update(Conversation).where(Conversation.id == conversation.id, Conversation.metadata_json == old)
        .values(metadata_json={**old, KEY: returned, 'qianniu_transfer_audit': audit,
            **({'auto_transfer': {**old['auto_transfer'], 'status': 'returned'}} if old.get('auto_transfer') else {})})
        .execution_options(synchronize_session=False))
    if changed.rowcount != 1:
        raise HTTPException(409, '会话状态变化，请重试通知处理')
    db.expire(conversation)
    message.raw_payload = {**payload, 'qianniu_transfer_notice_accepted': True,
                          'automation_mode': 'ignore' if historical_reconciliation else 'trigger'}
    message.automation_eligible = not historical_reconciliation
    db.add_all([conversation, message])
    db.flush()
    return True


def finish(db, user, conversation_id, operation_id, outcome, evidence, error):
    c, _ = context(db, user, conversation_id)
    task = operation_record(db, c.id)
    old = dict(c.metadata_json or {}); operation = dict((task.payload_json or {}).get('operation') or {}) if task else {}
    if operation.get('id') != operation_id:
        raise HTTPException(409, '转接操作不匹配')
    if operation.get('status') != 'transferring':
        if operation.get('status') == outcome:
            return operation
        raise HTTPException(409, '转接结果不能被覆盖')
    if outcome == 'transferred' and not (
        evidence.get('shopUid') == operation['source_shop_uid'] and evidence.get('cid') == operation['cid']
        and evidence.get('buyerUid') == operation['buyer_uid'] and evidence.get('targetUid') == operation['target_uid']
        and evidence.get('errorCode') == 0 and evidence.get('errorMap') == {} and evidence.get('module') is True
        and evidence.get('api') == 'mtop.taobao.qianniu.cloudkefu.forward' and evidence.get('version') == '3.0'
        and evidence.get('requestId') and evidence.get('pid') and evidence.get('ret')
        and all(str(x).startswith('SUCCESS::') for x in evidence['ret'])):
        raise HTTPException(400, '缺少匹配的千牛转接业务回执')
    operation.update(status=outcome, completed_at=utcnow().isoformat(), evidence=evidence, error=error)
    if operation.get('source') == 'automation' and outcome == 'failed':
        c.human_required = True
        c.human_required_reason = error or 'qianniu_auto_transfer_failed'
        c.human_required_at = utcnow()
    history = [*((task.result_json or {}).get('audit') or []), operation]
    changed = db.execute(update(RpaTask).where(RpaTask.id == task.id, RpaTask.status == 'transferring')
        .values(status=outcome, payload_json={'operation': operation}, result_json={'audit': history}, completed_at=utcnow())
        .execution_options(synchronize_session=False))
    if changed.rowcount != 1:
        db.rollback(); raise HTTPException(409, '转接结果已更新')
    updated = {**old, KEY: operation, 'qianniu_transfer_audit': history}
    changed = db.execute(update(Conversation).where(Conversation.id == c.id, Conversation.metadata_json == old)
        .values(metadata_json=updated).execution_options(synchronize_session=False))
    if changed.rowcount != 1:
        db.rollback(); raise HTTPException(409, '会话状态变化，转接结果待核对')
    if outcome == 'transferred':
        c.awaiting_reply = False
        for task in db.scalars(select(RpaTask).where(RpaTask.conversation_id == c.id,
                RpaTask.platform_code == 'qianniu', RpaTask.task_type == 'send_message',
                RpaTask.status.in_(['queued', 'waiting_timeout', 'dispatched']))):
            task.status = 'failed'; task.error_message = '会话已转交其他客服，已取消发送'
            task.completed_at = utcnow(); task.result_json = {'cancelled_by_transfer': operation_id}
            if task.message_id:
                message = db.get(Message, task.message_id)
                if message and message.message_status != 'sent':
                    message.message_status = 'cancelled'
    db.commit()
    return operation
