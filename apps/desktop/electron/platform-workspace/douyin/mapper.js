import { douyinMessageCore, douyinContextEligible } from './message-core.js';

export function douyinId(value) {
  if (typeof value === 'string') return value.length <= 256 ? value.trim() : '';
  return Number.isSafeInteger(value) && value > 0 ? String(value) : '';
}

export function isDouyinLiveReply(message, collectorStartedAt, observedAt) {
  const started = Date.parse(collectorStartedAt);
  const observed = Date.parse(observedAt);
  const sent = Date.parse(message.platformSentAt);
  // Match the server's five-second clock tolerance and five-minute age limit.
  return message.structuredPayload.collection_source === 'live'
    && message.senderRole === 'customer' && (['text', 'product'].includes(message.messageType)
      || douyinContextEligible(message.messageType, message.structuredPayload))
    && Number.isFinite(sent) && started <= observed && sent >= started - 5000
    && observed - sent >= -5000 && observed - sent <= 300000;
}

export function douyinMessageTime(message) {
  for (const value of [message.createTime, message.createdAt]) {
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    const numeric = Number(value);
    // Live compensation samples use Unix milliseconds; never turn zero into 1970.
    const millis = Number.isFinite(numeric) ? numeric : Date.parse(value);
    if (millis >= 946684800000 && millis <= 4102444800000) return new Date(millis).toISOString();
  }
  return null;
}

function objectPayload(value) {
  if (typeof value === 'string') {
    if (value.length > 65536) return {};
    try { value = JSON.parse(value); } catch { return {}; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function label(value, limit = 512) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function imageUrl(value) {
  if (typeof value !== 'string' || value.length >= 4096) return '';
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

function productId(value) {
  const id = douyinId(value);
  return /^[1-9]\d{0,63}$/.test(id) ? id : '';
}

function messageBody(message, ext) {
  const unknown = { messageType: 'unknown', content: '[非文本消息，请在原平台查看]', displayMode: 'bubble', data: {} };
  if (![1000, '1000'].includes(message.type ?? message.msgType)) return unknown;
  if (ext.type === 'text') return { ...unknown, messageType: 'text',
    content: typeof message.content === 'string' ? message.content.slice(0, 4000) : '' };
  if (ext.type === 'file_image') {
    const url = imageUrl(ext.imageUrl);
    return { messageType: 'image', displayMode: 'bubble',
      content: url ? '[图片]' : '[图片暂不可用，请在原平台查看]', data: url ? { image_url: url } : {} };
  }
  if (ext.type !== 'template_card') return unknown;
  const card = objectPayload(ext.static_data);
  const products = [card.sale_goods, card.b_goods].flatMap((items) => Array.isArray(items)
    ? items.slice(0, 30).filter((item) => item && typeof item === 'object' && !Array.isArray(item)) : []);
  if (message.content !== '[商品]' && message.hintContent !== '[商品]' && !products.length) return unknown;
  const extId = productId(ext.goods_id);
  // Do not pair a card for another product with the outer product ID.
  const product = products.find((item) => extId && productId(item.product_id) === extId)
    || (!extId && products.length === 1 ? products[0] : {});
  const id = extId || productId(product.product_id);
  const title = label(product.product_name) || label(product.product_name_two_lines)
    || label(product.product_name_one_line) || label(objectPayload(ext.generic_search_keywords).content);
  const currentPrice = objectPayload(product.current_price);
  const price = label(currentPrice.price, 64);
  // Preserve the platform's display string; currency codes and amount units
  // have not been verified, so do not convert cents or invent a currency symbol.
  const priceLabel = price
    ? `${label(currentPrice.prefix, 16)}${price}${label(currentPrice.suffix, 16)}` : label(product.price, 64);
  const url = imageUrl(product.img);
  return { messageType: 'product', displayMode: 'card', content: title ? `[商品] ${title}` : '[商品消息，请在原平台查看]',
    data: { title: title || '商品信息暂缺', ...(id ? { product_id: id } : {}),
      ...(url ? { image_url: url } : {}), ...(priceLabel ? { price_label: priceLabel } : {}) } };
}

export function mapDouyinMessage(message, shopId, source = 'live') {
  if (!message || typeof message !== 'object') return null;
  const ext = message.ext && typeof message.ext === 'object' ? message.ext : {};
  const conversationId = douyinId(message.securityConversationId || message.conversationId);
  if (!shopId || !conversationId.endsWith(`:${shopId}::2:1:pigeon`)) return null;
  const buyerId = conversationId.slice(0, -`:${shopId}::2:1:pigeon`.length);
  if (!buyerId || buyerId.includes(':') || (ext.shop_id && douyinId(ext.shop_id) !== shopId)) return null;
  const platformMessageId = douyinId(message.serverId || message.serverMessageId);
  if (!platformMessageId || platformMessageId === '0' || platformMessageId.length > 128) return null;
  const role = ext['s:sender_biz_role'];
  const senderRole = role === 'Buyer' ? 'customer' : role === 'CurrentServer' ? 'agent' : 'platform';
  const { messageType, content, displayMode, data } = messageBody(message, ext);
  if (!content) return null;
  const chatEligible = [1000, '1000'].includes(message.type ?? message.msgType)
    && !/system|transfer|notice|notification|receipt|read|typing|event|command|control|close|withdraw|revoke/i.test(label(ext.type, 64))
    && !/^\[(?:客服关闭会话|转接|系统)/.test(message.content || '')
    && !/^(?:用户超时未回复，系统关闭会话|(?:用户)?从历史会话发起会话)$/.test(message.content || '');
  return { conversationId, platformMessageId, senderRole, content, messageType, displayMode,
    customerName: senderRole === 'customer' && typeof (ext.nickname || ext.uname) === 'string'
      ? (ext.nickname || ext.uname).slice(0, 128) : null,
    platformSentAt: douyinMessageTime(message),
    structuredPayload: { security_conversation_id: conversationId, buyer_id: buyerId,
      sub_conversation_short_id: douyinId(message.subConversationShortId || ext.talk_id) || null,
      client_message_id: douyinId(ext['s:client_message_id']) || null,
      server_message_id: platformMessageId, message_logid: douyinId(ext.message_logid) || null,
      sender_biz_role: typeof role === 'string' ? role.slice(0, 64) : null,
      collection_source: source, raw_type: message.type ?? message.msgType ?? null,
      platform_message_type: label(ext.type, 64) || null,
      ...(['unknown', 'image'].includes(messageType) ? { chat_context_eligible: chatEligible,
        ...(messageType === 'unknown' ? { message_core: message.message_core || douyinMessageCore(message) }
          : { vision_available: false }) } : {}), ...data },
  };
}
