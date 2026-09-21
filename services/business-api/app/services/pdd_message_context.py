"""Unverified PDD card data and unread images, separate from buyer utterances."""
import re

from app.services.douyin_message_context import sanitize_core

PLACEHOLDER = '[非文本消息，请在原平台查看]'
CONTROL = re.compile(r'system|transfer|notice|notification|receipt|typing|command|withdraw|revoke|user_source', re.I)


def eligible(payload):
    data = payload.get('structured_payload') or {}
    return (isinstance(data, dict) and payload.get('sender_role') == 'customer'
            and payload.get('message_type') in {'image', 'unknown'}
            and data.get('from_role') == 'user'
            and data.get('raw_type') not in {24, 31, 41, 74, '24', '31', '41', '74'}
            and not CONTROL.search(str(data.get('template_name') or '')))


def core(data):
    return sanitize_core(data, roots=('content', 'info', 'biz_context'))


def sanitize_inbound(payload):
    if payload.get('message_type') not in {'image', 'unknown'}:
        return payload
    data = payload.get('structured_payload')
    data = dict(data) if isinstance(data, dict) else {}
    image = payload.get('message_type') == 'image'
    data.pop('raw_info', None)
    data.pop('biz_context', None)
    if image:
        data['vision_available'] = False
        data.pop('message_core', None)
    else:
        data['message_core'] = core(data.get('message_core'))
    result = {**payload, 'content': '[图片]' if image else PLACEHOLDER, 'structured_payload': data}
    if not eligible(result):
        result['automation_mode'] = 'ignore'
    return result


def prompt_context(message):
    if getattr(message, 'platform_code', None) != 'pinduoduo' or message.sender_role != 'customer':
        return None
    payload = {**(message.raw_payload or {}), 'sender_role': message.sender_role}
    if not eligible(payload):
        return None
    data = payload['structured_payload']
    image = payload['message_type'] == 'image'
    return {'type': 'pdd_unread_image' if image else 'pdd_unknown_message',
            'message_id': getattr(message, 'id', None), 'sender_role': 'customer',
            'content': '[图片，未识图]' if image else PLACEHOLDER,
            'data': {'untrusted': True, 'semantic_verified': False,
                     'raw_type': data.get('raw_type'), 'template_name': data.get('template_name'),
                     **({'vision_available': False} if image else {'core': core(data.get('message_core'))})}}
