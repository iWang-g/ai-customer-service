"""Shop-scoped product candidates and canonical links for Qianniu replies."""
import re

from sqlalchemy import select

from app.models import Message, StoreProduct
from app.services.outbound_safety import prohibited_outbound_reason, qianniu_outbound_reason


PREFIX = 'https://item.taobao.com/item.htm?id='
URL = re.compile(r'https?://[^\s]+', re.IGNORECASE)


def current_products(db, conversation):
    account = conversation.platform_account
    if (conversation.platform_code != 'qianniu' or not account or not account.is_active
            or account.platform_code != 'qianniu' or account.user_id != conversation.user_id):
        return []
    # Reload the snapshot: a collection may have completed while the model ran.
    db.refresh(account, ['metadata_json'])
    snapshot = (account.metadata_json or {}).get('store_products') or {}
    ids = snapshot.get('product_ids') or []
    if snapshot.get('source') != 'qianniu_products_v1' or snapshot.get('collection_status') != 'success':
        return []
    return list(db.execute(select(StoreProduct.goods_id, StoreProduct.platform_product_id, StoreProduct.title).where(
        StoreProduct.user_id == conversation.user_id,
        StoreProduct.platform_account_id == account.id,
        StoreProduct.goods_id.in_(ids),
    )).all()) if ids else []


def product_id(row):
    value = str(row.platform_product_id or '')
    return value if value == row.goods_id and re.fullmatch(r'[0-9]{1,30}', value) else None


def reply_candidates(db, conversation, message):
    query = re.sub(r'相关介绍|介绍一下|介绍|相关|推荐|商品|产品|有没有|有什么|了解一下', ' ', message.casefold())
    terms = set(re.findall(r'[a-z0-9]{2,}', query))
    for chunk in re.findall(r'[\u4e00-\u9fff]{2,}', query):
        terms.update(chunk[i:i + 2] for i in range(len(chunk) - 1))
    ranked = []
    for row in current_products(db, conversation):
        pid = product_id(row)
        title = str(row.title or '').strip()
        score = sum(len(term) for term in terms if term in title.casefold())
        if pid and title and score:
            ranked.append((score, pid, title[:200]))
    ranked.sort(key=lambda item: (-item[0], item[1]))
    return [{'product_id': pid, 'title': title} for _, pid, title in ranked[:12]]


def outbound_reason(db, conversation, text):
    if conversation.platform_code != 'qianniu':
        return prohibited_outbound_reason(text)
    blocked = qianniu_outbound_reason(text)
    reason = prohibited_outbound_reason(text)
    if blocked or reason != 'external_link':
        return blocked or reason
    allowed = {PREFIX + pid for row in current_products(db, conversation) if (pid := product_id(row))}
    # Replace whole URL tokens only; never allow lookalike hosts, redirects or extra parameters.
    remainder = URL.sub(lambda match: ' ' if match.group() in allowed else match.group(), text)
    return qianniu_outbound_reason(text) or prohibited_outbound_reason(remainder)


def append_reply_links(db, conversation, result, candidates):
    intent = result.get('intent') or {}
    plan = result.get('action_plan') or {}
    body = str(result.get('text') or '').strip()
    if (conversation.platform_code != 'qianniu' or result.get('decision') not in {'auto_send', 'suggest'}
            or intent.get('attach_product_links') is not True or intent.get('needs_clarification') is True
            or intent.get('reply_route') not in {'direct', 'retrieve_product'}
            or intent.get('custom_order_intent') == 'proceed'
            or intent.get('image_request_intent') == 'request'
            or intent.get('image_delivery_intent') in {'photo_request', 'email_link_request'}
            or plan.get('workflow') not in {'answer_question', 'direct_reply'}
            or not body or prohibited_outbound_reason(body) or qianniu_outbound_reason(body)):
        return
    selected = intent.get('selected_product_ids')
    if not isinstance(selected, list):
        return
    eligible = {item['product_id'] for item in candidates}
    eligible.intersection_update(pid for row in current_products(db, conversation) if (pid := product_id(row)))
    recent = db.scalars(select(Message).where(
        Message.conversation_id == conversation.id, Message.user_id == conversation.user_id,
        Message.sender_role == 'agent', Message.message_status.notin_(['failed', 'cancelled']),
    ).order_by(Message.conversation_sequence.desc()).limit(10)).all()
    sent_urls = {match.group() for message in recent for match in URL.finditer(message.content or '')}
    attached = []
    for pid in selected:
        if not isinstance(pid, str) or pid not in eligible or pid in attached or PREFIX + pid in sent_urls:
            continue
        addition = '\n相关商品 ' + str(len(attached) + 1) + '：' + PREFIX + pid
        if len((body + addition).encode('utf-8')) > 4095:
            continue
        body += addition
        attached.append(pid)
        if len(attached) == 3:
            break
    if attached:
        result['text'] = body
        result['qianniu_product_links'] = [{'product_id': pid, 'url': PREFIX + pid} for pid in attached]
