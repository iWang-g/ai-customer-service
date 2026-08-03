const MAX_TEXT_LENGTH = 4000;
const MAX_IDENTIFIER_LENGTH = 128;

function cleanText(value, limit = MAX_TEXT_LENGTH) {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, limit) : null;
}

function cleanId(value) {
  return cleanText(value, MAX_IDENTIFIER_LENGTH);
}

function cleanInteger(value, minimum = 0) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= minimum ? numeric : null;
}

function cleanMessage(message) {
  if (!message || typeof message !== 'object') return null;
  const content = cleanText(message.content);
  if (!content) return null;
  return {
    platform_message_id: cleanId(message.platform_message_id),
    sender_role: message.sender_role === 'agent' ? 'agent' : 'customer',
    sender_name: cleanText(message.sender_name, 128),
    content,
    message_type: ['text', 'image', 'product', 'order'].includes(message.message_type)
      ? message.message_type
      : 'text',
    image_url: cleanText(message.image_url, 2000),
    platform_sent_at: cleanText(message.platform_sent_at, 64),
    time_label: cleanText(message.time_label, 64),
    time_group_index: cleanInteger(message.time_group_index),
    snapshot_sequence: cleanInteger(message.snapshot_sequence),
    has_explicit_time: Boolean(message.has_explicit_time),
  };
}

function cleanConversation(conversation) {
  if (!conversation || typeof conversation !== 'object') return null;
  const externalId = cleanId(conversation.external_conversation_id);
  const customerName = cleanText(conversation.customer_name, 128);
  if (!externalId && !customerName) return null;
  return {
    external_conversation_id: externalId,
    customer_name: customerName,
    title: cleanText(conversation.title, 256) || customerName,
    latest_message_text: cleanText(conversation.latest_message_text),
    unread_count: Math.max(0, Math.min(Number(conversation.unread_count) || 0, 9999)),
    avatar_url: cleanText(conversation.avatar_url, 1000),
    active: Boolean(conversation.active),
    messages: Array.isArray(conversation.messages)
      ? conversation.messages.slice(-200).map(cleanMessage).filter(Boolean)
      : [],
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
    const accountNameSource = ['dom', 'document_title'].includes(payload.account_name_source)
      ? payload.account_name_source
      : null;
    if (!externalAccountId && !accountName) return null;
    return {
      version: 1,
      type: 'identity',
      external_account_id: externalAccountId,
      account_name: accountName,
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
