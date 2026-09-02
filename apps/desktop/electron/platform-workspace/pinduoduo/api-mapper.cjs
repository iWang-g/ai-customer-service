'use strict';

const MAX_TEXT = 4000;
const MAX_ID = 128;
const PDD_CONTEXT_MESSAGE_TYPES = new Set([41]);
const PDD_SYSTEM_MESSAGE_TYPES = new Set([24, 31, 74]);

function cleanText(value, limit = MAX_TEXT) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const cleaned = String(value).replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, limit) : null;
}

function cleanMessageText(value, limit = MAX_TEXT) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const cleaned = String(value).replace(/\r\n?/g, '\n').trim();
  return cleaned ? cleaned.slice(0, limit) : null;
}

function cleanId(value) {
  return cleanText(value, MAX_ID);
}

function cleanUrl(value) {
  return cleanText(value, 8192);
}

function cleanObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function amountFromCents(value) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return null;
  return Math.round(numberValue) / 100;
}

function amountFromYuan(value) {
  if (typeof value === 'string') {
    const normalized = value.replace(/[^\d.]/g, '');
    if (!normalized) return null;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function priceLabel(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? `¥${value.toFixed(2)}`
    : null;
}

function orderStatusLabel(info) {
  const status = Number(info.status);
  const groupStatus = Number(info.group_status);
  if (status === 7 || groupStatus === 99) return '已取消';
  if (Number(info.shipping_status) > 0) return '已发货';
  if (Number(info.pay_status) > 0) return '待付款';
  if (Number(info.order_status) > 0) return '待发货';
  return null;
}

function afterSalesLabel(info) {
  return cleanText(info.orderBriefPrompt, 128) || '无售后';
}

function normalizePddLink(value) {
  const link = cleanUrl(value);
  if (!link) return null;
  if (/^https?:\/\//i.test(link)) return link;
  if (link.startsWith('//')) return `https:${link}`;
  if (link.startsWith('/')) return `https://mobile.yangkeduo.com${link}`;
  if (/^(goods|order|chat)\.html(?:\?|$)/i.test(link)) return `https://mobile.yangkeduo.com/${link}`;
  return link;
}

function commonStructuredPayload(message) {
  return {
    from_role: cleanText(message?.from?.role, 64),
    from_uid: cleanId(message?.from?.uid ?? message?.from?.id),
    from_mall_id: cleanId(message?.from?.mall_id),
    from_csid: cleanText(message?.from?.csid, 128),
    to_role: cleanText(message?.to?.role, 64),
    to_uid: cleanId(message?.to?.uid ?? message?.to?.id),
    to_csid: cleanText(message?.to?.csid, 128),
    pre_msg_id: cleanId(message.pre_msg_id),
    quote_msg_id: cleanId(message.quote_msg_id ?? message.quote_msg?.msg_id),
    quote_msg: mapQuoteMessage(message.quote_msg),
    status: cleanText(message.status, 64),
    client_msg_id: cleanId(message.client_msg_id),
    raw_type: Number.isFinite(Number(message.type)) ? Number(message.type) : null,
    template_name: cleanText(message.template_name, 128),
    source_id: Number.isFinite(Number(message.source_id)) ? Number(message.source_id) : null,
    sub_type: Number.isFinite(Number(message.sub_type)) ? Number(message.sub_type) : null,
    biz_context: cleanObject(message.biz_context),
    raw_info: cleanObject(message.info),
  };
}

function mapQuoteMessage(message) {
  if (!message || typeof message !== 'object') return null;
  const type = Number(message.type) === 1 ? 'image' : Number(message.type) === 0 ? 'text' : 'unknown';
  const content = cleanMessageText(message.content) || (type === 'image' ? '[image]' : null);
  const imageUrl = type === 'image' ? cleanUrl(message.content) : null;
  const platformMessageId = cleanId(message.msg_id);
  if (!platformMessageId && !content && !imageUrl) return null;
  return {
    msg_id: platformMessageId,
    sender_role: senderRole(message),
    message_type: type,
    content,
    image_url: imageUrl,
  };
}

function customerUidFromMessage(message) {
  if (message?.from?.role === 'user') return cleanId(message.from.uid ?? message.from.id);
  if (message?.to?.role === 'user') return cleanId(message.to.uid ?? message.to.id);
  return cleanId(message?.user_info?.uid);
}

function mallIdFromMessage(message) {
  return cleanId(message?.from?.mall_id ?? message?.to?.mall_id ?? message?.mall_id);
}

function rawPddMessageType(message) {
  const value = Number(message?.type);
  return Number.isFinite(value) ? value : null;
}

function senderRole(message) {
  const rawType = rawPddMessageType(message);
  if (PDD_SYSTEM_MESSAGE_TYPES.has(rawType) || PDD_CONTEXT_MESSAGE_TYPES.has(rawType)) return 'platform';
  if (message?.from?.role === 'mall_cs') return 'agent';
  if (message?.from?.role === 'user') return 'customer';
  return 'platform';
}

function messageType(message) {
  const rawType = rawPddMessageType(message);
  if (PDD_SYSTEM_MESSAGE_TYPES.has(rawType)) return 'system';
  if (rawType === 1) return 'image';
  const info = cleanObject(message?.info) || {};
  if (message?.template_name === 'user_source' || PDD_CONTEXT_MESSAGE_TYPES.has(rawType)) return 'context';
  if (info.orderSequenceNo || info.order_id || info.group_order_id) return 'order';
  if (message?.template_name === 'user_goods_card' || message?.template_name === 'goods_info_card') return 'product';
  if (info.goodsName || info.goods_name || info.goodsID || info.goodsId || info.goods_id || info.goodsThumbUrl || info.linkUrl) {
    return 'product';
  }
  if (Number(message?.type) === 0) return 'text';
  return 'unknown';
}

function mapOrderCard(message, domSequence) {
  const info = cleanObject(message.info) || {};
  const productId = cleanId(info.goodsID ?? info.goodsId ?? info.goods_id ?? message.biz_context?.goodsId);
  const orderSequenceNo = cleanId(info.orderSequenceNo ?? info.order_sequence_no);
  const orderId = cleanId(info.order_id);
  const groupOrderId = cleanId(info.group_order_id);
  const title = cleanMessageText(info.goodsName ?? info.goods_name, 1000);
  const imageUrl = cleanUrl(info.goodsThumbUrl ?? info.goods_thumb_url ?? info.thumbUrl);
  const quantity = Number.isFinite(Number(info.goodsNumber)) ? Number(info.goodsNumber) : null;
  const amount = amountFromCents(info.totalAmount ?? info.total_amount ?? info.merchant_amount);
  const statusLabel = orderStatusLabel(info);
  const serviceLabel = afterSalesLabel(info);
  const spec = cleanText(info.spec, 512);
  const orderLine = orderSequenceNo ? `订单编号：${orderSequenceNo}` : cleanMessageText(message.content) || '订单信息';
  const detailLines = [
    orderLine,
    [statusLabel, serviceLabel].filter(Boolean).join(' '),
    title,
    spec ? `规格：${spec}` : null,
    quantity ? `数量：${quantity}` : null,
    priceLabel(amount) ? `实收 ${priceLabel(amount)}` : null,
  ].filter(Boolean);
  return {
    dom_sequence: domSequence,
    sender_role: senderRole(message),
    message_type: 'order',
    content: detailLines.join('\n'),
    image_url: null,
    platform_message_id: cleanId(message.msg_id),
    platform_sent_at: cleanText(message.ts, 64),
    display_mode: 'card',
    automation_mode: senderRole(message) === 'customer' ? 'trigger' : 'context',
    structured_payload: {
      ...commonStructuredPayload(message),
      order_sequence_no: orderSequenceNo,
      order_id: orderId,
      group_order_id: groupOrderId,
      order_status_label: statusLabel,
      after_sales_label: serviceLabel,
      product_id: productId,
      title,
      image_url: imageUrl,
      quantity,
      spec,
      amount,
      amount_label: priceLabel(amount),
      link_url: normalizePddLink(info.linkUrl ?? info.link_url ?? info.mall_link_url),
    },
  };
}

function mapProductCard(message, domSequence) {
  const info = cleanObject(message.info) || {};
  const button = cleanObject(info.spellOrderData)?.button;
  const productId = cleanId(info.goodsID ?? info.goodsId ?? info.goods_id ?? message.biz_context?.goodsId);
  const title = cleanMessageText(info.goodsName ?? info.goods_name ?? message.content, 1000);
  const imageUrl = cleanUrl(info.goodsThumbUrl ?? info.goods_thumb_url ?? info.thumbUrl);
  const price = amountFromYuan(info.goodsPrice ?? info.price ?? info.price_label);
  const content = title || cleanMessageText(message.content) || '商品卡片';
  return {
    dom_sequence: domSequence,
    sender_role: senderRole(message),
    message_type: 'product',
    content,
    image_url: null,
    platform_message_id: cleanId(message.msg_id),
    platform_sent_at: cleanText(message.ts, 64),
    display_mode: 'card',
    automation_mode: senderRole(message) === 'customer' ? 'trigger' : 'context',
    structured_payload: {
      ...commonStructuredPayload(message),
      product_id: productId,
      title,
      image_url: imageUrl,
      price,
      price_label: priceLabel(price),
      sales_tip: cleanText(info.salesTip ?? info.sales_tip, 128),
      link_url: normalizePddLink(info.linkUrl ?? info.link_url ?? info.mall_link_url),
      button_text: cleanText(button?.text, 64) || '查看商品规格',
      customer_number: Number.isFinite(Number(info.customerNumber)) ? Number(info.customerNumber) : null,
    },
  };
}

function mapSourceContextCard(message, domSequence) {
  const info = cleanObject(message.info) || {};
  const goodsInfo = cleanObject(info.goods_info) || {};
  const productId = cleanId(goodsInfo.goods_id ?? goodsInfo.goodsId ?? info.goodsID ?? message.biz_context?.goodsId);
  const title = cleanMessageText(goodsInfo.goods_name ?? info.goodsName, 1000);
  const imageUrl = cleanUrl(goodsInfo.goods_thumb_url ?? info.goodsThumbUrl);
  const sourceLabel = cleanMessageText(info.title ?? message.content, 1000) || '当前用户来源';
  const price = amountFromCents(goodsInfo.total_amount ?? message.biz_context?.minOnSaleGroupPrice);
  return {
    dom_sequence: domSequence,
    sender_role: senderRole(message),
    message_type: 'context',
    content: sourceLabel,
    image_url: null,
    platform_message_id: cleanId(message.msg_id),
    platform_sent_at: cleanText(message.ts, 64),
    display_mode: 'card',
    automation_mode: 'context',
    structured_payload: {
      ...commonStructuredPayload(message),
      source_label: sourceLabel,
      product_id: productId,
      title,
      image_url: imageUrl,
      price,
      price_label: priceLabel(price),
      link_url: normalizePddLink(goodsInfo.mall_link_url ?? info.linkUrl),
      button_text: '查看商品规格',
    },
  };
}

function mapPddMessage(message, domSequence = 0) {
  if (!message || typeof message !== 'object') return null;
  const type = messageType(message);
  if (type === 'order') return mapOrderCard(message, domSequence);
  if (type === 'product') return mapProductCard(message, domSequence);
  if (type === 'context') return mapSourceContextCard(message, domSequence);
  const rawContent = cleanMessageText(message.content);
  const imageUrl = type === 'image' ? cleanUrl(message.content) : null;
  const content = type === 'image' ? '[image]' : rawContent;
  if (!content) return null;
  const platformMessageId = cleanId(message.msg_id);
  return {
    dom_sequence: domSequence,
    sender_role: senderRole(message),
    message_type: type,
    content,
    image_url: imageUrl,
    platform_message_id: platformMessageId,
    platform_sent_at: cleanText(message.ts, 64),
    display_mode: type === 'system' ? 'separator' : 'bubble',
    automation_mode: type === 'system'
      ? 'ignore'
      : senderRole(message) === 'customer'
        ? 'trigger'
        : 'context',
    structured_payload: {
      ...commonStructuredPayload(message),
    },
  };
}

function mapLatestConversation(message) {
  if (!message || typeof message !== 'object') return null;
  const customerUid = customerUidFromMessage(message);
  if (!customerUid) return null;
  const customerName = cleanText(message.user_info?.nickname, 128);
  const rawStatus = cleanText(message.status, 64);
  const normalizedStatus = String(rawStatus || '').toLowerCase();
  const unreadCount = normalizedStatus === 'unread'
    ? 1
    : Math.max(0, Math.min(Number(message.unread_count || 0) || 0, 9999));
  return {
    external_conversation_id: customerUid,
    customer_name: customerName,
    title: customerName,
    latest_message_text: cleanMessageText(message.content),
    unread_count: unreadCount,
    avatar_url: cleanText(message.user_info?.avatar, 1000),
    active: false,
    platform_account_name: cleanText(message.mallName, 128),
    platform_external_account_id: mallIdFromMessage(message),
    structured_payload: {
      customer_uid: customerUid,
      mall_name: cleanText(message.mallName, 128),
      mall_id: mallIdFromMessage(message),
      latest_msg_id: cleanId(message.msg_id),
      pre_msg_id: cleanId(message.pre_msg_id),
      status: rawStatus,
      is_read: Number.isFinite(Number(message.is_read)) ? Number(message.is_read) : null,
      last_unreply_time: Number.isFinite(Number(message.last_unreply_time))
        ? Number(message.last_unreply_time)
        : null,
    },
  };
}

function mapLatestConversationsResponse(response, observedAt = new Date().toISOString()) {
  const result = response?.result || {};
  const conversations = Array.isArray(result.conversations)
    ? result.conversations.map(mapLatestConversation).filter(Boolean)
    : [];
  return {
    version: 1,
    type: 'snapshot',
    source: 'pdd_api_latest_conversations',
    snapshot_id: `pdd-api-latest-${Date.now().toString(36)}`,
    observed_at: observedAt,
    platform_identity: null,
    conversations,
    has_more: Boolean(result.has_more),
    page: Number.isFinite(Number(result.page)) ? Number(result.page) : null,
    size: Number.isFinite(Number(result.size)) ? Number(result.size) : null,
  };
}

function mapChatListResponse(response, {
  customerUid = null,
  customerName = null,
  avatarUrl = null,
} = {}, observedAt = new Date().toISOString()) {
  const result = response?.result || {};
  const messages = Array.isArray(result.messages)
    ? result.messages.map(mapPddMessage).filter(Boolean).reverse().map((message, index) => ({
      ...message,
      dom_sequence: index,
    }))
    : [];
  const uid = cleanId(customerUid) || customerUidFromMessage(result.messages?.[0]) || null;
  return {
    version: 1,
    type: 'snapshot',
    source: 'pdd_api_chat_list',
    snapshot_id: `pdd-api-list-${Date.now().toString(36)}`,
    observed_at: observedAt,
    conversations: uid ? [{
      external_conversation_id: uid,
      customer_name: cleanText(customerName, 128),
      title: cleanText(customerName, 128),
      latest_message_text: messages[messages.length - 1]?.content || null,
      unread_count: 0,
      avatar_url: cleanText(avatarUrl, 1000),
      active: true,
      snapshot_messages: messages,
    }] : [],
    has_more: Boolean(result.has_more),
    read_mark: result.read_mark && typeof result.read_mark === 'object' ? result.read_mark : null,
  };
}

function isoFromSeconds(value) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue <= 0) return null;
  try {
    const date = new Date(numberValue * 1000 + 8 * 60 * 60 * 1000);
    return date.toISOString().replace('Z', '').slice(0, 19);
  } catch {
    return null;
  }
}

function firstCleanText(...values) {
  for (const value of values) {
    const cleaned = cleanText(value, 512);
    if (cleaned) return cleaned;
  }
  return null;
}

function normalizeUserAllOrderStatus(order) {
  const primaryRaw = [
    order?.orderStatusStr,
    order?.tagName,
  ].map((item) => String(item || '')).join(' ');
  if (/\u5df2\u7b7e\u6536|\u5df2\u5b8c\u6210|\u4ea4\u6613\u6210\u529f|signed|completed/i.test(primaryRaw)) return 'signed';
  if (/\u5df2\u53d6\u6d88|\u5df2\u5173\u95ed|\u53d6\u6d88|\u5173\u95ed|cancel/i.test(primaryRaw)) return 'cancelled';
  if (/\u5f85\u652f\u4ed8|\u5f85\u4ed8\u6b3e|\u672a\u652f\u4ed8|pending.?payment/i.test(primaryRaw)) return 'pending_payment';
  if (/\u5df2\u53d1\u8d27|\u5f85\u6536\u8d27|shipped/i.test(primaryRaw)) return 'shipped_pending_receipt';
  const raw = [
    order?.orderStatusStr,
    order?.tagName,
    order?.afterSalesInfo?.afterSalesStatusDesc,
    order?.afterSalesInfo?.statusDesc,
  ].map((item) => String(item || '')).join(' ');
  if (/取消|关闭|cancel/i.test(raw) || Number(order?.groupStatus) === 99) return 'cancelled';
  if (/退款成功|已退款|refund(ed)?/i.test(raw)) return 'refunded';
  if (/退款|退货|售后|after.?sale|refund/i.test(raw)) return 'refunding';
  if (/已签收|已完成|交易成功|signed|completed/i.test(raw)) return 'signed';
  if (Number(order?.receiveTime) > 0 || Number(order?.confirmTime) > 0) return 'signed';
  if (/已发货|待收货|shipped/i.test(raw) || Number(order?.shippingStatus) > 0 || Number(order?.shippingTime) > 0) {
    return 'shipped_pending_receipt';
  }
  if (/待付款|未支付|pending.?payment/i.test(raw)) return 'pending_payment';
  if (Number(order?.payStatus) > 0 || Number(order?.payTime) > 0) return 'paid_pending_shipment';
  return 'unknown';
}

function normalizeOrderGoodsList(value) {
  if (Array.isArray(value)) return value.filter((item) => item && typeof item === 'object');
  if (value && typeof value === 'object') return [value];
  return [];
}

function mapUserAllOrderProduct(goods) {
  const goodsId = cleanId(goods?.goodsId ?? goods?.goodsID ?? goods?.goods_id);
  return {
    title: cleanMessageText(goods?.goodsName ?? goods?.goods_name, 1000) || null,
    quantity: Number.isFinite(Number(goods?.goodsNumber)) ? Number(goods.goodsNumber) : 1,
    image_url: cleanUrl(goods?.thumbUrl ?? goods?.thumb_url ?? goods?.goodsThumbUrl),
    goods_id: goodsId,
    product_id: goodsId,
    sku_id: cleanId(goods?.skuId ?? goods?.sku_id),
    spec: cleanText(goods?.spec, 512),
    price: amountFromCents(goods?.goodsPrice ?? goods?.goods_price),
  };
}

function mapUserAllOrderAfterSale(order) {
  const tags = Array.isArray(order?.workbenchOrderTagNew)
    ? order.workbenchOrderTagNew.map((item) => ({
      text: cleanText(item?.text, 128),
      status: cleanText(item?.status, 128),
      type: Number.isFinite(Number(item?.type)) ? Number(item.type) : null,
    })).filter((item) => item.text || item.status)
    : [];
  const textValue = firstCleanText(
    order?.afterSalesInfo?.afterSalesStatusDesc,
    order?.afterSalesInfo?.statusDesc,
    order?.compensate?.text,
    order?.compensateInfo?.note,
    tags.map((item) => [item.text, item.status].filter(Boolean).join(' ')).filter(Boolean).join(' '),
  );
  return {
    text: textValue || '',
    tags,
    raw_after_sales: cleanObject(order?.afterSalesInfo),
    compensate: cleanObject(order?.compensate) || cleanObject(order?.compensateInfo) || {},
  };
}

function mapUserAllOrder(order, index = 0) {
  if (!order || typeof order !== 'object') return null;
  const platformOrderId = cleanId(order.orderSn ?? order.order_sn);
  if (!platformOrderId) return null;
  const orderAmount = amountFromCents(order.orderAmount ?? order.order_amount);
  const discountAmount = amountFromCents(order.totalDiscount ?? order.discountAmount ?? order.discount_amount);
  const paidAmount = amountFromCents(
    order.paidAmount
    ?? order.payAmount
    ?? order.actualPayAmount
    ?? (
      Number.isFinite(Number(order.orderAmount))
        ? Number(order.orderAmount) - (Number(order.totalDiscount ?? order.discountAmount) || 0)
        : null
    ),
  );
  const products = normalizeOrderGoodsList(order.orderGoodsList)
    .map(mapUserAllOrderProduct)
    .filter((item) => item.title || item.image_url || item.product_id);
  const goodsId = products.find((item) => item.goods_id)?.goods_id || '';
  return {
    platform_order_id: platformOrderId,
    order_id: cleanId(order.id),
    goods_id: goodsId,
    group_order_id: cleanId(order.groupOrderId ?? order.group_order_id),
    customer_uid: cleanId(order.uid),
    status: normalizeUserAllOrderStatus(order),
    raw_status: firstCleanText(order.orderStatusStr, order.tagName) || '',
    products,
    order_amount: orderAmount,
    discount_amount: discountAmount,
    paid_amount: paidAmount,
    ordered_at: isoFromSeconds(order.orderTime ?? order.createdAt),
    paid_at: isoFromSeconds(order.payTime),
    signed_at: isoFromSeconds(order.receiveTime ?? order.confirmTime),
    after_sale: mapUserAllOrderAfterSale(order),
    sequence: index,
    raw_payload: order,
  };
}

function normalizeRecommendGoodsList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'object') return [value];
  return [];
}

function mapRecommendGoodsProduct(goods, source = 'unknown') {
  const productId = cleanId(goods?.goodsId ?? goods?.goodsID ?? goods?.goods_id);
  const title = cleanMessageText(goods?.goodsName ?? goods?.goods_name, 1000);
  if (!productId && !title) return null;
  const price = amountFromCents(goods?.minOnSaleGroupPrice ?? goods?.maxOnSaleGroupPrice ?? goods?.goodsPrice)
    ?? amountFromYuan(goods?.defaultPriceStr ?? goods?.price);
  return {
    goods_id: productId,
    product_id: productId,
    title,
    image_url: cleanUrl(goods?.thumbUrl ?? goods?.goodsThumbUrl ?? goods?.goods_thumb_url),
    link_url: normalizePddLink(goods?.goodsUrl ?? goods?.linkUrl ?? goods?.mallLinkUrl),
    price,
    price_label: priceLabel(price),
    quantity: Number.isFinite(Number(goods?.quantity)) ? Number(goods.quantity) : null,
    sold_quantity: Number.isFinite(Number(goods?.soldQuantity)) ? Number(goods.soldQuantity) : null,
    sold_quantity_30d: Number.isFinite(Number(goods?.soldQuantity30d)) ? Number(goods.soldQuantity30d) : null,
    source,
    raw_payload: goods && typeof goods === 'object' ? goods : {},
  };
}

function mapPddRecommendGoodsResponse(response, observedAt = new Date().toISOString()) {
  const result = response?.result || {};
  const ok = response?.success === true && (
    response.errorCode === undefined
    || Number(response.errorCode) === 1000000
    || response.errorCode === null
    || Number(response.error_code) === 1000000
    || response.error_code === null
  );
  const rawProducts = [
    ...normalizeRecommendGoodsList(result.recommendGoods).map((item) => ({ item, source: 'recommend' })),
    ...normalizeRecommendGoodsList(result.todayBrowseGoods).map((item) => ({ item, source: 'today_browse' })),
    ...normalizeRecommendGoodsList(result.historyBrowseGoods).map((item) => ({ item, source: 'history_browse' })),
    ...normalizeRecommendGoodsList(result.onSaleGoods).map((item) => ({ item, source: 'on_sale' })),
    ...normalizeRecommendGoodsList(result.headGoods).map((item) => ({ item, source: 'head' })),
  ];
  const products = [];
  const seen = new Set();
  for (const { item, source } of rawProducts) {
    const product = mapRecommendGoodsProduct(item, source);
    if (!product) continue;
    const key = product.product_id || product.link_url || product.title;
    if (seen.has(key)) continue;
    seen.add(key);
    products.push(product);
  }
  const total = Number.isFinite(Number(result.total)) ? Number(result.total) : products.length;
  const hasMore = typeof result.has_more === 'boolean'
    ? result.has_more
    : products.length < total;
  return {
    success: ok,
    collection_status: !ok ? 'unavailable' : products.length > 0 ? 'success' : 'empty',
    observed_at: observedAt,
    total_count: total,
    has_more: hasMore,
    products,
    error: ok ? null : cleanText(response?.errorMsg ?? response?.error_msg, 256) || 'pdd_response_not_ok',
  };
}

function mapPddRecommendGoodsSnapshot(response, {
  customerUid = null,
  customerName = null,
} = {}, observedAt = new Date().toISOString()) {
  const mapped = mapPddRecommendGoodsResponse(response, observedAt);
  const uid = cleanId(customerUid);
  return {
    version: 1,
    type: 'snapshot',
    source: 'pdd_api_recommend_goods',
    snapshot_id: `pdd-api-products-${Date.now().toString(36)}`,
    observed_at: observedAt,
    conversations: uid ? [{
      external_conversation_id: uid,
      customer_name: cleanText(customerName, 128),
      title: cleanText(customerName, 128),
      latest_message_text: null,
      unread_count: 0,
      active: true,
      customer_products: {
        collection_status: mapped.collection_status,
        observed_at: mapped.observed_at,
        products: mapped.products,
        page_summary: {
          total_count: Math.max(mapped.total_count, mapped.products.length),
          has_more: mapped.has_more,
        },
        ...(mapped.error ? { error: mapped.error } : {}),
      },
    }] : [],
  };
}

function mapPddUserAllOrderResponse(response, {
  customerUid = null,
  customerName = null,
} = {}, observedAt = new Date().toISOString()) {
  const result = response?.result || {};
  const rawOrders = Array.isArray(result.orders) ? result.orders : [];
  const orders = rawOrders.map(mapUserAllOrder).filter(Boolean);
  const uid = cleanId(customerUid) || cleanId(rawOrders.find((item) => item?.uid)?.uid);
  const total = Number.isFinite(Number(result.total)) ? Number(result.total) : orders.length;
  const ok = response?.success === true && (
    response.errorCode === undefined
    || Number(response.errorCode) === 1000000
    || response.errorCode === null
  );
  const collectionStatus = !ok
    ? 'unavailable'
    : total <= 0 && orders.length === 0
      ? 'empty'
      : orders.length > 0 ? 'success' : 'unavailable';
  const pageNo = Number.isFinite(Number(result.pageNo)) ? Number(result.pageNo) : 1;
  const pageSize = Number.isFinite(Number(result.pageSize)) ? Number(result.pageSize) : rawOrders.length;
  return {
    version: 1,
    type: 'snapshot',
    source: 'pdd_api_user_all_order',
    snapshot_id: `pdd-api-orders-${Date.now().toString(36)}`,
    observed_at: observedAt,
    conversations: uid ? [{
      external_conversation_id: uid,
      customer_name: cleanText(customerName, 128),
      title: cleanText(customerName, 128),
      latest_message_text: null,
      unread_count: 0,
      active: true,
      customer_orders: {
        collection_status: collectionStatus,
        observed_at: observedAt,
        orders,
        page_summary: {
          page_no: pageNo,
          page_size: pageSize,
          total_count: Math.max(total, orders.length),
          history_total: Number.isFinite(Number(result.historyTotal)) ? Number(result.historyTotal) : null,
          has_more: pageNo * Math.max(pageSize, orders.length || 1) < total,
        },
        ...(!ok || collectionStatus === 'unavailable' ? {
          error: cleanText(response?.errorMsg, 128) || 'pdd_user_all_order_response_unavailable',
        } : {}),
      },
    }] : [],
  };
}

function mapSyncMessageResponse(response, observedAt = new Date().toISOString()) {
  const result = response?.result || {};
  const syncData = Array.isArray(result.sync_data) ? result.sync_data : [];
  const byConversation = new Map();
  const syncKeys = [];
  const syncGaps = [];
  for (const item of syncData) {
    if (Number.isFinite(Number(item.seq_type)) && Number.isFinite(Number(item.seq_id))) {
      syncKeys.push({ seq_type: Number(item.seq_type), seq_id: Number(item.seq_id) });
    }
    const data = Array.isArray(item.data) ? item.data : [];
    const itemCustomerUids = [];
    for (const wrapper of data) {
      const message = wrapper?.message;
      const uid = customerUidFromMessage(message);
      const mapped = mapPddMessage(message);
      if (!uid || !mapped) continue;
      itemCustomerUids.push(uid);
      if (!byConversation.has(uid)) {
        byConversation.set(uid, {
          external_conversation_id: uid,
          customer_name: null,
          title: null,
          latest_message_text: null,
          unread_count: 0,
          active: false,
          snapshot_messages: [],
        });
      }
      const conversation = byConversation.get(uid);
      mapped.dom_sequence = conversation.snapshot_messages.length;
      conversation.snapshot_messages.push(mapped);
      conversation.latest_message_text = mapped.content;
      if (mapped.sender_role === 'customer') conversation.unread_count += 1;
    }
    if (item.has_gap || item.reset_seq_id) {
      syncGaps.push({
        seq_type: Number.isFinite(Number(item.seq_type)) ? Number(item.seq_type) : null,
        seq_id: Number.isFinite(Number(item.seq_id)) ? Number(item.seq_id) : null,
        has_gap: Boolean(item.has_gap),
        reset_seq_id: Boolean(item.reset_seq_id),
        has_more: Boolean(item.has_more),
        customer_uids: [...new Set(itemCustomerUids)].slice(0, 20),
      });
    }
  }
  return {
    version: 1,
    type: 'snapshot',
    source: 'pdd_api_sync_message',
    snapshot_id: `pdd-api-sync-${Date.now().toString(36)}`,
    observed_at: observedAt,
    conversations: [...byConversation.values()],
    sync_keys: syncKeys,
    sync_gaps: syncGaps,
    server_time: cleanText(result.server_time, 64),
  };
}

function summarizeMappedSnapshot(snapshot) {
  const conversations = Array.isArray(snapshot?.conversations) ? snapshot.conversations : [];
  const messageCount = conversations.reduce(
    (total, conversation) => total + (conversation.snapshot_messages?.length || 0),
    0,
  );
  return {
    source: cleanText(snapshot?.source, 64),
    conversation_count: conversations.length,
    message_count: messageCount,
    customer_uids: conversations.map((conversation) => conversation.external_conversation_id).filter(Boolean).slice(0, 20),
    shop_name: cleanText(snapshot?.platform_identity?.account_name, 128)
      || cleanText(conversations.find((conversation) => conversation.platform_account_name)?.platform_account_name, 128),
    mall_id_present: Boolean(snapshot?.platform_identity?.external_account_id)
      || conversations.some((conversation) => Boolean(conversation.platform_external_account_id)),
    has_more: Boolean(snapshot?.has_more),
    sync_keys: Array.isArray(snapshot?.sync_keys) ? snapshot.sync_keys.slice(0, 5) : [],
    sync_gap_count: Array.isArray(snapshot?.sync_gaps) ? snapshot.sync_gaps.length : 0,
    sync_gap_customer_uids: Array.isArray(snapshot?.sync_gaps)
      ? [...new Set(snapshot.sync_gaps.flatMap((gap) => gap.customer_uids || []))].slice(0, 20)
      : [],
  };
}

function mapSendMessageResponse(response) {
  const result = response?.result || {};
  return {
    success: response?.success === true && result.result === 'ok',
    request_id: cleanId(result.request_id),
    msg_id: cleanId(result.msg_id),
    pre_msg_id: cleanId(result.pre_msg_id),
    ts: cleanText(result.ts, 64),
  };
}

module.exports = {
  mapChatListResponse,
  mapLatestConversationsResponse,
  mapPddRecommendGoodsSnapshot,
  mapPddRecommendGoodsResponse,
  mapPddUserAllOrderResponse,
  mapPddMessage,
  mapSendMessageResponse,
  mapSyncMessageResponse,
  summarizeMappedSnapshot,
};
