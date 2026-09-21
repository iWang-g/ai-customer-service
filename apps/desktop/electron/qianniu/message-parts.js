function httpUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) return null;
  try {
    const url = new URL(value.startsWith('//') ? 'https:' + value : value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function productId(value) {
  const normalized = httpUrl(value);
  if (!normalized) return null;
  const url = new URL(normalized);
  const routes = { 'h5.m.taobao.com': '/awp/core/detail.htm', 'item.taobao.com': '/item.htm' };
  const id = url.searchParams.get('id');
  return !url.port && routes[url.hostname] === url.pathname && url.searchParams.getAll('id').length === 1 &&
    /^\d{1,30}$/.test(id || '') ? id : null;
}

export function parseMessageParts(raw) {
  const templates = raw.templateData?.dynamicContent;
  if (raw.templateId === 129 && Array.isArray(templates)) {
    const recommendations = templates.filter(t => t?.templateId === 295001 && t.platform === 3);
    if (recommendations.length === 1) {
      const items = recommendations[0].templateData?.E2_items;
      if (Array.isArray(items) && items.length > 0 && items.length <= 32) {
        return items.map((item, index) => {
          const id = productId(item?.actionUrl);
          if (!id || String(item?.itemId) !== id) return { index, kind: 'unsupported', text: '[暂不支持的商品推荐]' };
          return { index, kind: 'product', product_id: id, url: 'https://item.taobao.com/item.htm?id=' + id,
            title: typeof item.title === 'string' ? item.title.slice(0, 512) : null,
            image_url: httpUrl(item.pic),
            price_label: typeof item.price === 'string' && /^\d{1,12}(?:\.\d{1,4})?$/.test(item.price) ? '¥' + item.price : null };
        });
      }
    }
  }
  const original = raw.originalData || {};
  const nodes = Array.isArray(original.jsview) ? original.jsview : [];
  const parts = nodes.map((node, index) => {
    const value = node?.value || {};
    if (node.type === 0 && typeof value.text === 'string') return { index, kind: 'text', text: value.text };
    if (node.type === 7) return { index, kind: 'image', url: httpUrl(value.url) || (nodes.length === 1 ? httpUrl(original.url) : null),
      width: nodes.length === 1 && Number.isSafeInteger(original.width) ? original.width : null,
      height: nodes.length === 1 && Number.isSafeInteger(original.height) ? original.height : null };
    if (node.type === 1 || node.type === 5) {
      const id = productId(value.url);
      if (id) {
        let info;
        try { info = JSON.parse(value.urlinfo || 'null'); } catch { /* A link remains usable before metadata arrives. */ }
        return { index, kind: 'product', product_id: id, url: 'https://item.taobao.com/item.htm?id=' + id,
          title: typeof info?.title === 'string' ? info.title.slice(0, 512) : null,
          image_url: httpUrl(info?.imageUrl),
          price_label: typeof info?.price === 'string' && /^\d{1,12}(?:\.\d{1,4})?$/.test(info.price) ? '¥' + info.price : null };
      }
      if (httpUrl(value.url)) return { index, kind: 'text', text: value.url };
    }
    return { index, kind: 'unsupported', text: '[暂不支持的消息]' };
  });
  if (typeof original.text === 'string' && original.text &&
      !parts.some(part => part.kind === 'image' || part.kind === 'product')) {
    return [{ index: 0, kind: 'text', text: original.text }];
  }
  if (!parts.length) {
    const text = typeof original.text === 'string' ? original.text : raw.text;
    if (text) {
      const id = productId(text);
      parts.push(id ? { index: 0, kind: 'product', product_id: id, url: 'https://item.taobao.com/item.htm?id=' + id } : { index: 0, kind: 'text', text });
    } else if (raw.mediaVersion === 1) parts.push({ index: 0, kind: 'unsupported', text: '[暂不支持的消息]' });
  }
  return parts;
}

export function isCompleteTextProjection(raw, parts) {
  const text = raw?.originalData?.text;
  return typeof text === 'string' && Boolean(text) && parts.length === 1 &&
    parts[0]?.kind === 'text' && parts[0]?.text === text;
}

export function mergeMessageParts(previous = [], next = []) {
  const parts = new Map(previous.map(part => [part.index, { ...part }]));
  for (const part of next) {
    const old = parts.get(part.index);
    if (old && ((old.kind !== 'unsupported' && old.kind !== part.kind) || (old.product_id && old.product_id !== part.product_id))) continue;
    parts.set(part.index, { ...old, ...Object.fromEntries(Object.entries(part).filter(([, value]) => value != null && value !== '')) });
  }
  return [...parts.values()].sort((a, b) => a.index - b.index);
}

export function qianniuTransferNotice(raw) {
  if (raw.templateId !== 101 || raw.direction !== 'incoming' || raw.toId !== raw.shopUid) return null;
  const pair = /^(\d+)\.1-(\d+)\.1#11001@cntaobao$/.exec(raw.cid || '');
  const names = /^由 ([^\r\n]+) 转交给 ([^\r\n]+)$/.exec(raw.text || '');
  const colon = (raw.toNick || '').indexOf(':');
  if (!pair || !names || colon <= 0 || ![pair[1], pair[2]].includes(raw.fromId)) return null;
  const prefix = raw.toNick.slice(0, colon + 1);
  const fullNick = value => value.includes(':') ? value : prefix + value;
  const sourceNick = fullNick(names[1]), targetNick = fullNick(names[2]);
  if (!sourceNick.startsWith(prefix) || targetNick !== raw.toNick || sourceNick === targetNick || sourceNick.length > 128) return null;
  return { source_nick: sourceNick, target_nick: targetNick, receiver_uid: raw.toId,
    buyer_uid: raw.fromId, main_uid: pair[1] === raw.fromId ? pair[2] : pair[1] };
}

export function isQianniuSystemMessage(raw) {
  if (raw.templateId === 101 && /^由 [^\r\n]+ 转交给 [^\r\n]+$/.test(raw.text || '')) return true;
  if (raw.templateId !== 129) return raw.senderRole === 'platform';
  const templates = raw.templateData?.dynamicContent;
  return Array.isArray(templates) && templates.length > 0 && templates.every(t => t?.templateId === 332001);
}

export function projectMessageParts(parts, system = false, { partsComplete = false } = {}) {
  const first = parts[0];
  const type = system ? 'system' : parts.some(part => part?.kind === 'unsupported')
    ? 'unknown' : parts.length === 1 ? (first?.kind || 'text') : 'text';
  const content = system ? '[平台系统消息]' : parts.map(p => p.kind === 'image' ? '[图片]' : p.kind === 'product'
    ? '[商品] ' + (p.title || p.product_id) : p.text || '[暂不支持的消息]').join('\n');
  return { content, message_type: type, display_mode: system ? 'separator' : type === 'product' ? 'card' : 'bubble',
    ...(type === 'image' && first?.url ? { image_url: first.url } : {}),
    structured_payload: { parts, ...(partsComplete ? { parts_complete: true } : {}),
      ...(type === 'product' ? { ...first, link_url: first.url } : {}) } };
}

export function needsMediaCompletion(message) {
  return message.parts?.some(p => (p.kind === 'image' && !p.url) || (p.kind === 'product' && (!p.title || !p.image_url || !p.price_label))) || false;
}
