// Self-contained: also serialized into the platform world by observerScript.
export function douyinMessageCore(message) {
  const result = { version: 1, fields: [], truncated: false, omitted: false, parse_status: {} };
  const blocked = /token|cookie|auth|secret|password|signature|credential|url|link|uri|address|phone|mobile|telephone|receiver|recipient|contact|姓名|地址|电话|手机|收货人|button|action|onclick|script|style|layout|image|avatar|__proto__|constructor|prototype/i;
  const meaningful = /^(content|hintContent|text|title|subtitle|description|desc|name|label|value|reason|status|status_text|status_desc|status_name|order_status|refund_status|order_id|orderId|product_id|goods_id|sku_id|sku|spec|specification|quantity|product_name|goods_name|apply_reason|refund_reason|售后原因|订单号|商品名称|规格|状态|说明)$/i;
  const read = (owner, name) => owner && typeof owner === 'object'
    ? Object.getOwnPropertyDescriptor(owner, name)?.value : undefined;
  const seen = new WeakSet();
  let nodes = 0;
  const walk = (value, path, key, depth = 0) => {
    if (++nodes > 300 || depth > 5 || result.fields.length >= 32) { result.truncated = true; return; }
    if (blocked.test(key)) { result.omitted = true; return; }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      if (!meaningful.test(key)) { result.omitted = true; return; }
      if (typeof value === 'number' && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) {
        result.omitted = true; return;
      }
      if (typeof value === 'string') {
        if (value.length > 512) result.truncated = true;
        value = value.slice(0, 512).replace(/https?:\/\/\S+/gi, '[链接已省略]');
        if (!/(?:_id|Id|订单号)$/.test(key)) value = value.replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, '[电话已省略]');
        value = value.replace(/(?:收货)?地址\s*[:：].*/g, '[地址已省略]');
        if (!value.trim()) return;
      }
      const field = { path: path.slice(0, 160), value };
      result.fields.push(field);
      if (JSON.stringify(result).length > 3900) { result.fields.pop(); result.truncated = true; }
      return;
    }
    if (!value || typeof value !== 'object' || seen.has(value)) { if (value) result.omitted = true; return; }
    seen.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (['label', 'name', 'title'].some((name) => typeof descriptors[name]?.value === 'string'
        && /^(?:收货地址|收件地址|详细地址|地址|联系电话|电话|手机号|手机|联系人|收货人|收件人|姓名|address|phone|mobile|recipient)\s*[:：]?$/i.test(descriptors[name].value.trim()))) {
      result.omitted = true; return;
    }
    const keys = Object.keys(descriptors).filter((name) => name !== 'length');
    const limit = Array.isArray(value) ? 12 : 40;
    if (keys.length > limit) result.truncated = true;
    for (const name of keys.slice(0, limit)) {
      const d = descriptors[name];
      if (!('value' in d) || typeof d.value === 'function') { result.omitted = true; continue; }
      walk(d.value, `${path}.${name}`, name, depth + 1);
    }
  };
  const ext = read(message, 'ext');
  for (const [owner, key, path] of [[message, 'content', 'content'], [message, 'hintContent', 'hintContent'],
    [ext, 'order_id', 'ext.order_id'], [ext, 'goods_id', 'ext.goods_id'],
    [ext, 'static_data', 'ext.static_data'], [ext, 'generic_search_keywords', 'ext.generic_search_keywords'],
    [ext, 'msg_render_model', 'ext.msg_render_model']]) {
    let value = read(owner, key);
    if (value === undefined) continue;
    if (typeof value === 'string' && (['static_data', 'generic_search_keywords', 'msg_render_model'].includes(key)
        || /^\s*[\[{]/.test(value) && !/^\[[^\]{}"]*\]$/.test(value))) {
      if (value.length > 65536) { result.truncated = true; result.parse_status[key] = 'size_limit'; continue; }
      try { value = JSON.parse(value); result.parse_status[key] = 'parsed'; }
      catch { result.parse_status[key] = 'invalid_json'; result.omitted = true; continue; }
    }
    walk(value, path, key);
  }
  return result;
}

export function douyinContextEligible(messageType, structured) {
  return ['image', 'unknown'].includes(messageType)
    && [1000, '1000'].includes(structured.raw_type)
    && structured.sender_biz_role === 'Buyer'
    && typeof structured.platform_message_type === 'string'
    && !!structured.platform_message_type
    && !/system|transfer|notice|notification|receipt|read|typing|event|command|control|close|withdraw|revoke/i.test(structured.platform_message_type)
    && structured.chat_context_eligible === true;
}
