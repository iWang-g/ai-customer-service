"""Bounded, unverified buyer card context; images are placeholders, never vision input."""
import json
import math
import re

BLOCKED = re.compile(r'token|cookie|auth|secret|password|signature|credential|url|link|uri|address|phone|mobile|telephone|receiver|recipient|contact|姓名|地址|电话|手机|收货人|button|action|onclick|(?:^|[._])script(?:$|[._])|style|layout|image|avatar|__proto__|constructor|prototype', re.I)
LEAF = re.compile(r'^(content|hintContent|text|title|subtitle|description|desc|name|label|value|reason|status|status_text|status_desc|status_name|order_status|refund_status|order_id|orderId|product_id|goods_id|sku_id|sku|spec|specification|quantity|product_name|goods_name|apply_reason|refund_reason|售后原因|订单号|商品名称|规格|状态|说明)$', re.I)
CONTROL = re.compile(r'system|transfer|notice|notification|receipt|read|typing|event|command|control|close|withdraw|revoke', re.I)


def eligible(payload):
    data = payload.get('structured_payload')
    if not isinstance(data, dict):
        return False
    kind = data.get('platform_message_type')
    return (payload.get('message_type') in {'unknown', 'image'}
            and payload.get('sender_role') == 'customer'
            and data.get('sender_biz_role') == 'Buyer'
            and data.get('raw_type') in (1000, '1000')
            and data.get('chat_context_eligible') is True
            and isinstance(kind, str) and 0 < len(kind) <= 64 and not CONTROL.search(kind))


def sanitize_core(raw, *, roots=None):
    roots = roots or ('content', 'hintContent', 'ext.order_id', 'ext.goods_id',
                      'ext.static_data', 'ext.generic_search_keywords', 'ext.msg_render_model')
    result = {'version': 1, 'fields': [], 'truncated': False, 'omitted': False, 'parse_status': {}}
    if not isinstance(raw, dict) or raw.get('version') != 1:
        result['omitted'] = True
        return result
    result['truncated'] = raw.get('truncated') is True
    result['omitted'] = raw.get('omitted') is True
    statuses = raw.get('parse_status')
    if isinstance(statuses, dict):
        result['parse_status'] = {k: v for k, v in statuses.items()
            if k in {root.rsplit('.', 1)[-1] for root in roots}
            and isinstance(v, str) and v in {'parsed', 'invalid_json', 'size_limit'}}
    fields = raw.get('fields')
    if not isinstance(fields, list):
        result['omitted'] = True
        return result
    if len(fields) > 32:
        result['truncated'] = True
    private_groups = []
    for field in fields[:32]:
        if (isinstance(field, dict) and isinstance(field.get('path'), str)
                and field['path'].rsplit('.', 1)[-1] in {'label', 'name', 'title'}
                and isinstance(field.get('value'), str)
                and re.fullmatch(r'(?:收货地址|收件地址|详细地址|地址|联系电话|电话|手机号|手机|联系人|收货人|收件人|姓名|address|phone|mobile|recipient)\s*[:：]?', field['value'].strip(), re.I)):
            private_groups.append(field['path'].rsplit('.', 1)[0] + '.')
    for field in fields[:32]:
        if not isinstance(field, dict):
            result['omitted'] = True
            continue
        path, value = field.get('path'), field.get('value')
        if (not isinstance(path, str) or len(path) > 160 or BLOCKED.search(path)
                or any(path.startswith(prefix) for prefix in private_groups)
                or not LEAF.fullmatch(path.rsplit('.', 1)[-1])
                or not any(path == root or path.startswith(root + '.') for root in roots)):
            result['omitted'] = True
            continue
        if isinstance(value, str):
            if len(value) > 512:
                result['truncated'] = True
            value = re.sub(r'https?://\S+', '[链接已省略]', value[:512], flags=re.I)
            if not re.search(r'(?:_id|Id|订单号)$', path):
                value = re.sub(r'(?<!\d)1[3-9]\d{9}(?!\d)', '[电话已省略]', value)
            value = re.sub(r'(?:收货)?地址\s*[:：].*', '[地址已省略]', value)
        elif not isinstance(value, (bool, int, float)) or not math.isfinite(value) or abs(value) > 2**53 - 1:
            result['omitted'] = True
            continue
        result['fields'].append({'path': path, 'value': value})
        if len(json.dumps(result, ensure_ascii=False)) > 4096:
            result['fields'].pop()
            result['truncated'] = True
    return result


def sanitize_inbound(payload):
    if payload.get('message_type') not in {'unknown', 'image'}:
        return payload
    data = payload.get('structured_payload')
    data = dict(data) if isinstance(data, dict) else {}
    if payload.get('message_type') == 'unknown':
        data['message_core'] = sanitize_core(data.get('message_core'))
    else:
        data.pop('message_core', None)
        data['vision_available'] = False
    # Persist placeholders as the current utterance; raw card strings must not run
    # through text keyword rules. Semantic content has its own untrusted channel.
    content = '[非文本消息，请在原平台查看]' if payload.get('message_type') == 'unknown' else (
        '[图片]' if data.get('image_url') else '[图片暂不可用，请在原平台查看]')
    return {**payload, 'content': content, 'structured_payload': data}


def prompt_context(message):
    if getattr(message, 'platform_code', None) != 'douyin' or message.sender_role != 'customer':
        return None
    payload = message.raw_payload or {}
    if not eligible(payload):
        return None
    data = payload['structured_payload']
    image = payload.get('message_type') == 'image'
    return {'type': 'douyin_unread_image' if image else 'douyin_unknown_message',
            'message_id': getattr(message, 'id', None), 'sender_role': 'customer',
            'content': '[图片，未识图]' if image else '[未识别卡片，正文见核心数据]',
            'data': {'untrusted': True, 'semantic_verified': False,
                     'observed_at': payload.get('observed_at'),
                     'platform_sent_at': payload.get('platform_sent_at'),
                     'collection_source': data.get('collection_source'),
                     'platform_message_type': data.get('platform_message_type'),
                     **({'vision_available': False} if image else {'core': sanitize_core(data.get('message_core'))})}}


def order_hint(message):
    context = prompt_context(message)
    fields = (context or {}).get('data', {}).get('core', {}).get('fields', [])
    return any(re.search(r'order_?id|order_status|refund_status|订单号', field['path'], re.I)
               or re.search(r'订单|下单|付款|支付|发货|退款进度', str(field['value'])) for field in fields)
