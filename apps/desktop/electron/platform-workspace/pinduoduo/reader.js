const MAX_TEXT_LENGTH = 4000;
const MAX_IDENTIFIER_LENGTH = 128;

function cleanText(value, limit = MAX_TEXT_LENGTH) {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, limit) : null;
}

function cleanMessageText(value, limit = MAX_TEXT_LENGTH) {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/\r\n?/g, '\n').trim();
  return cleaned ? cleaned.slice(0, limit) : null;
}

function cleanId(value) {
  return cleanText(value, MAX_IDENTIFIER_LENGTH);
}

function cleanSnapshotMessage(message, domSequence) {
  if (!message || typeof message !== 'object') return null;
  const messageType = ['text', 'image', 'product', 'order', 'system', 'context', 'time', 'unknown'].includes(message.message_type)
    ? message.message_type
    : 'unknown';
  const content = cleanMessageText(message.content) || (messageType === 'image' ? '[image]' : null);
  if (!content) return null;
  const displayModes = ['bubble', 'card', 'separator', 'notice', 'hidden'];
  const automationModes = ['trigger', 'context', 'ignore'];
  return {
    dom_sequence: domSequence,
    sender_role: message.sender_role === 'agent'
      ? 'agent'
      : message.sender_role === 'platform' ? 'platform' : 'customer',
    message_type: messageType,
    content,
    image_url: cleanText(message.image_url, 8192),
    image_sha256: cleanText(message.image_sha256, 64),
    media_resource_id: cleanText(message.media_resource_id, 512),
    platform_message_id: cleanId(message.platform_message_id),
    display_mode: displayModes.includes(message.display_mode) ? message.display_mode : 'bubble',
    automation_mode: automationModes.includes(message.automation_mode) ? message.automation_mode : 'ignore',
    structured_payload: message.structured_payload && typeof message.structured_payload === 'object'
      ? message.structured_payload
      : null,
    collector_rule_version: cleanText(message.collector_rule_version, 64),
    time_label: cleanText(message.time_label, 64),
    has_explicit_time: Boolean(message.has_explicit_time),
  };
}

function cleanConversation(conversation) {
  if (!conversation || typeof conversation !== 'object') return null;
  const externalId = cleanId(conversation.external_conversation_id);
  const customerName = cleanText(conversation.customer_name, 128);
  if (!externalId && !customerName) return null;
  const snapshotMessages = Array.isArray(conversation.snapshot_messages)
    ? conversation.snapshot_messages.slice(-200).map(cleanSnapshotMessage).filter(Boolean)
    : null;
  return {
    external_conversation_id: externalId,
    customer_name: customerName,
    title: cleanText(conversation.title, 256) || customerName,
    latest_message_text: cleanText(conversation.latest_message_text),
    unread_count: Math.max(0, Math.min(Number(conversation.unread_count) || 0, 9999)),
    avatar_url: cleanText(conversation.avatar_url, 1000),
    active: Boolean(conversation.active),
    customer_orders: cleanOrdersSnapshot(conversation.customer_orders),
    customer_products: cleanProductsSnapshot(conversation.customer_products),
    snapshot_messages: snapshotMessages?.map((message, domSequence) => ({
      ...message,
      dom_sequence: domSequence,
    })) || null,
  };
}

function cleanProductsSnapshot(value) {
  if (!value || typeof value !== 'object') return null;
  const allowed = ['success', 'empty', 'unavailable'];
  const collectionStatus = allowed.includes(value.collection_status)
    ? value.collection_status
    : 'unavailable';
  return {
    collection_status: collectionStatus,
    observed_at: cleanText(value.observed_at, 64),
    products: Array.isArray(value.products) ? value.products.slice(0, 100).map((product) => ({
      product_id: cleanId(product?.product_id ?? product?.platform_product_id),
      title: cleanText(product?.title, 1000),
      image_url: cleanText(product?.image_url, 8192),
      link_url: cleanText(product?.link_url, 8192),
      price: Number.isFinite(product?.price) ? product.price : null,
      price_label: cleanText(product?.price_label, 64),
      quantity: Number.isFinite(product?.quantity) ? product.quantity : null,
      sold_quantity: Number.isFinite(product?.sold_quantity) ? product.sold_quantity : null,
      sold_quantity_30d: Number.isFinite(product?.sold_quantity_30d) ? product.sold_quantity_30d : null,
      source: cleanText(product?.source, 64),
      raw_payload: product?.raw_payload && typeof product.raw_payload === 'object'
        ? product.raw_payload
        : {},
    })).filter((product) => product.product_id) : [],
    page_summary: value.page_summary && typeof value.page_summary === 'object'
      ? value.page_summary
      : {},
    error: cleanText(value.error, 256),
  };
}

function cleanOrdersSnapshot(value) {
  if (!value || typeof value !== 'object') return null;
  const allowed = ['success', 'empty', 'unavailable'];
  const collectionStatus = allowed.includes(value.collection_status)
    ? value.collection_status
    : 'unavailable';
  return {
    collection_status: collectionStatus,
    observed_at: cleanText(value.observed_at, 64),
    orders: Array.isArray(value.orders) ? value.orders.slice(0, 100).map((order) => ({
      platform_order_id: cleanId(order?.platform_order_id),
      raw_status: cleanText(order?.raw_status, 128) || '',
      status: cleanText(order?.status, 32) || 'unknown',
      ordered_at: cleanText(order?.ordered_at, 64),
      products: Array.isArray(order?.products) ? order.products.slice(0, 50) : [],
      order_amount: Number.isFinite(order?.order_amount) ? order.order_amount : null,
      discount_amount: Number.isFinite(order?.discount_amount) ? order.discount_amount : null,
      paid_amount: Number.isFinite(order?.paid_amount) ? order.paid_amount : null,
      after_sale: order?.after_sale && typeof order.after_sale === 'object' ? order.after_sale : {},
      raw_text: cleanText(order?.raw_text),
    })).filter((order) => order.platform_order_id) : [],
    page_summary: value.page_summary && typeof value.page_summary === 'object'
      ? value.page_summary
      : {},
    error: cleanText(value.error, 256),
  };
}

export function validateAdapterPayload(payload) {
  if (!payload || typeof payload !== 'object' || payload.version !== 1) return null;
  const observedAt = cleanText(payload.observed_at, 64) || new Date().toISOString();
  if (payload.type === 'status') {
    const allowed = ['unknown', 'login_required', 'online', 'risk_control', 'unsupported', 'error'];
    return {
      version: 1,
      type: 'status',
      status: allowed.includes(payload.status) ? payload.status : 'unknown',
      page_path: cleanText(payload.page_path, 512),
      observed_at: observedAt,
    };
  }
  if (payload.type === 'identity') {
    const externalAccountId = cleanId(payload.external_account_id);
    const accountName = cleanText(payload.account_name, 128);
    const logoUrl = cleanText(payload.logo_url, 1000);
    const serviceUsername = cleanText(payload.service_username, 128);
    const csId = cleanText(payload.cs_id, 128);
    const csUid = cleanText(payload.cs_uid, 256);
    const accountNameSource = [
      'dom',
      'document_title',
      'pdd_api_latest_conversations',
      'pdd_api_custom_service_info',
      'pdd_api_userinfo_realtime',
      'pdd_api_shop_info',
    ].includes(payload.account_name_source)
      ? payload.account_name_source
      : null;
    if (!externalAccountId && !accountName) return null;
    return {
      version: 1,
      type: 'identity',
      external_account_id: externalAccountId,
      account_name: accountName,
      logo_url: logoUrl,
      service_username: serviceUsername,
      cs_id: csId,
      cs_uid: csUid,
      is_mall_owner: payload.is_mall_owner === true,
      account_name_source: accountNameSource,
      observed_at: observedAt,
    };
  }
  if (payload.type === 'snapshot') {
    return {
      version: 1,
      type: 'snapshot',
      snapshot_id: cleanId(payload.snapshot_id),
      conversations: Array.isArray(payload.conversations)
        ? payload.conversations.slice(0, 200).map(cleanConversation).filter(Boolean)
        : [],
      observed_at: observedAt,
    };
  }
  return null;
}
