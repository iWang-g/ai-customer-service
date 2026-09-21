"""Read-only, run-scoped notification projection; viewing a chat never resolves it."""
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.core.security import utcnow
from app.models import Conversation, Message, RpaTask, User
from app.schemas.message_notice import MessageNoticeItem, MessageNoticeSnapshot


def _utc(value: datetime) -> datetime:
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def _time(message: Message) -> datetime:
    return _utc(message.platform_sent_at or message.sent_at)


def list_message_notices(db: Session, user: User, since: datetime) -> MessageNoticeSnapshot:
    since = _utc(since)
    # Scope by account and app run, independently of the paginated conversation list.
    rows = db.execute(
        select(Message, Conversation)
        .join(Conversation, Conversation.id == Message.conversation_id)
        .options(selectinload(Conversation.platform_account))
        .where(
            Conversation.user_id == user.id, Message.user_id == user.id,
            Conversation.deleted_at.is_(None), Message.message_status == 'sent',
            Message.collected_at >= since,
            Message.conversation_sequence > Conversation.messages_cleared_sequence,
            Message.sender_role.in_(['customer', 'agent', 'assistant', 'bot']),
        )
        .order_by(Message.conversation_sequence, Message.id)
    ).all()
    latest: dict[str, tuple[Message, Conversation]] = {}
    replies: dict[str, list[Message]] = {}
    for message, conversation in rows:
        if message.sender_role != 'customer':
            replies.setdefault(conversation.id, []).append(message)
            continue
        # Do not restore old messages from imports/bootstrap or a previous application run.
        # Ignore automation_eligible: images and messages requiring a human also belong here.
        if _time(message) < since or (message.collection_kind in {'bootstrap', 'recovery'} and message.platform_sent_at is None):
            continue
        previous = latest.get(conversation.id)
        if previous is None or (_time(message), message.conversation_sequence or 0) > (
            _time(previous[0]), previous[0].conversation_sequence or 0
        ):
            latest[conversation.id] = (message, conversation)

    tasks = list(db.scalars(select(RpaTask).where(
        RpaTask.user_id == user.id, RpaTask.requested_at >= since,
        RpaTask.message_id.is_not(None),
    ))) if latest else []
    tasks_by_message = {task.message_id: task for task in tasks}
    items = []
    for message, conversation in latest.values():
        reply = None
        reply_kind = None
        for candidate in replies.get(conversation.id, []):
            if _time(candidate) < _time(message) or (
                _time(candidate) == _time(message)
                and (candidate.conversation_sequence or 0) <= (message.conversation_sequence or 0)
            ):
                continue
            task = tasks_by_message.get(candidate.id)
            payload = (task.payload_json or {}) if task else {}
            is_ai = candidate.source in {'ai', 'automation', 'automation_timeout'} or payload.get('source') in {'ai', 'automation', 'automation_timeout'}
            # A late completion of an older AI turn must not resolve a newer customer message.
            trigger_id = payload.get('automation_source_message_id')
            trigger_sequence = payload.get('automation_trigger_sequence')
            if is_ai and trigger_id and trigger_id != message.id:
                if not isinstance(trigger_sequence, int) or trigger_sequence < (message.conversation_sequence or 0):
                    continue
            if reply is None or (_time(candidate), candidate.conversation_sequence or 0) > (_time(reply), reply.conversation_sequence or 0):
                reply = candidate
                reply_kind = 'ai' if is_ai else 'manual'
        account = conversation.platform_account
        metadata = conversation.metadata_json or {}
        shop_name = (account.account_alias or account.account_name) if account else None
        if conversation.platform_code == 'qianniu':
            from app.services.qianniu_shop_profile import shop_name as qianniu_shop_name
            shop_name = qianniu_shop_name(account) or shop_name
        preview_message = reply or message
        items.append(MessageNoticeItem(
            conversation_id=conversation.id, platform_code=conversation.platform_code,
            customer_name=conversation.customer_name or conversation.title or '未知客户',
            shop_name=shop_name or str(metadata.get('shop_name') or '未绑定店铺'),
            message_id=message.id, message_text=preview_message.content or '[消息]',
            latest_message_sender=('ai' if reply_kind == 'ai' else 'manual' if reply_kind == 'manual' else 'customer'),
            customer_message_at=_time(message), reply_kind=reply_kind,
            replied_at=_time(reply) if reply else None,
        ))
    items.sort(key=lambda item: (item.customer_message_at, item.conversation_id), reverse=True)
    return MessageNoticeSnapshot(since=since, server_time=utcnow(), items=items)
