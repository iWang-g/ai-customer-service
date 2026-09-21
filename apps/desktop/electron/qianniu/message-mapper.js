import { createHash } from 'node:crypto';
import { parseMessageParts, projectMessageParts, isCompleteTextProjection,
  isQianniuSystemMessage, qianniuTransferNotice } from './message-parts.js';

const QIANNIU_PLATFORM_CODE = 'qianniu';
const MAX_TEXT_LENGTH = 4000;
const SINGLE_CHAT_CID = /^(\d+)\.1-(\d+)\.1#11001@cntaobao$/;
const RAW_EVIDENCE_BUDGET = 24 * 1024;
const RAW_EVIDENCE_MAX_DEPTH = 6;
const RAW_EVIDENCE_SECRET_KEY = /(?:authorization|cookie|credential|password|passwd|secret|session|ticket|token|signature|auth_key|(?:local|cache).*path)/i;
const RAW_EVIDENCE_SECRET_QUERY = /^(?:auth_key|authorization|credential|expires?|password|secret|session|sign|signature|ticket|token|x-amz-.+)$/i;

function digest(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

function evidenceString(value) {
  const text = value.slice(0, 1024);
  if (/^(?:file:\/\/|[a-z]:[\\/]|\\\\)/i.test(text)) return null;
  if (!/^https?:\/\//i.test(text)) return text;
  try {
    const url = new URL(text);
    if (url.username || url.password) return null;
    for (const key of [...url.searchParams.keys()]) {
      if (RAW_EVIDENCE_SECRET_QUERY.test(key)) url.searchParams.delete(key);
    }
    return url.href;
  } catch {
    return text;
  }
}

function sanitizeEvidence(value, state, depth = 0) {
  if (state.remaining <= 0 || state.nodes <= 0 || depth > RAW_EVIDENCE_MAX_DEPTH) return undefined;
  state.nodes--;
  if (value == null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    const safe = evidenceString(value);
    if (safe == null) return undefined;
    let clipped = safe.slice(0, 1024);
    while (clipped && Buffer.byteLength(clipped, 'utf8') > state.remaining) {
      clipped = clipped.slice(0, Math.max(0, Math.floor(clipped.length * 0.75)));
    }
    state.remaining -= Buffer.byteLength(clipped, 'utf8');
    return clipped;
  }
  if (Array.isArray(value)) {
    const result = [];
    for (const item of value.slice(0, 32)) {
      const safe = sanitizeEvidence(item, state, depth + 1);
      if (safe !== undefined) result.push(safe);
      if (state.remaining <= 0) break;
    }
    return result;
  }
  if (typeof value !== 'object') return undefined;
  const result = {};
  for (const [rawKey, item] of Object.entries(value).slice(0, 64)) {
    const key = String(rawKey).slice(0, 128);
    if (!key || RAW_EVIDENCE_SECRET_KEY.test(key)) continue;
    state.remaining -= Buffer.byteLength(key, 'utf8');
    const safe = sanitizeEvidence(item, state, depth + 1);
    if (safe !== undefined) result[key] = safe;
    if (state.remaining <= 0) break;
  }
  return result;
}

function evidenceShape(value, depth = 0) {
  if (depth > RAW_EVIDENCE_MAX_DEPTH) return 'depth-limit';
  if (value == null) return 'null';
  if (Array.isArray(value)) return ['array', ...value.slice(0, 32).map(item => evidenceShape(item, depth + 1))];
  if (typeof value === 'object') return Object.fromEntries(
    Object.keys(value).sort().slice(0, 64).map(key => [key, evidenceShape(value[key], depth + 1)]),
  );
  return typeof value;
}

function rawEvidence(raw) {
  const prior = raw.qianniuRaw && typeof raw.qianniuRaw === 'object' ? raw.qianniuRaw : {};
  const state = { remaining: RAW_EVIDENCE_BUDGET, nodes: 512 };
  const originalData = sanitizeEvidence(raw.originalData ?? prior.original_data, state);
  const templateData = sanitizeEvidence(raw.templateData ?? prior.template_data, state);
  const evidence = {
    schema_version: 1,
    template_id: Number.isSafeInteger(raw.templateId) ? raw.templateId
      : Number.isSafeInteger(prior.template_id) ? prior.template_id : null,
    media_version: Number.isSafeInteger(raw.mediaVersion) ? raw.mediaVersion
      : Number.isSafeInteger(prior.media_version) ? prior.media_version : null,
    structure_hash: digest(JSON.stringify({
      original_data: evidenceShape(originalData),
      template_data: evidenceShape(templateData),
    })),
  };
  if (originalData !== undefined) evidence.original_data = originalData;
  if (templateData !== undefined) evidence.template_data = templateData;
  return evidence;
}

function cleanText(value, limit = MAX_TEXT_LENGTH) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, limit);
}

function cleanOutboundText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function cleanId(value, limit = 128) {
  return String(value || '').trim().slice(0, limit);
}

function sentAt(value) {
  const text = cleanId(value, 64);
  if (/^\d{10}$/.test(text) || /^\d{13}$/.test(text)) {
    const date = new Date(Number(text) * (text.length === 10 ? 1000 : 1));
    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
  }
  return text;
}

export function buyerUidFromCid(cid) {
  const match = SINGLE_CHAT_CID.exec(String(cid || ''));
  return match ? match[1] : '';
}

export function normalizeQianniuMessage(raw, { shopUid, cid } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const normalizedCid = cleanId(raw.cid || cid, 256);
  const messageId = cleanId(raw.messageId || raw.platform_message_id, 128);
  const fromId = cleanId(raw.fromId || raw.from_id, 128);
  const toId = cleanId(raw.toId || raw.to_id, 128);
  const direction = raw.direction === 'outgoing' ? 'outgoing' : raw.direction === 'incoming' ? 'incoming' : 'unknown';
  const transferNotice = qianniuTransferNotice({ ...raw, shopUid: raw.shopUid || shopUid, cid: normalizedCid });
  const system = Boolean(transferNotice) || isQianniuSystemMessage(raw);
  const senderRole = system ? 'platform' : direction === 'outgoing' ? 'agent' : 'customer';
  const parts = Array.isArray(raw.parts) ? raw.parts : parseMessageParts(raw);
  const hasUnsupportedParts = parts.some(part => part?.kind === 'unsupported');
  const projection = projectMessageParts(parts, system, {
    partsComplete: !Array.isArray(raw.parts) && isCompleteTextProjection(raw, parts),
  });
  if (system && raw.templateId === 101 && raw.text) projection.content = raw.text;
  const text = projection.content || cleanText(raw.text || raw.content);
  if (!normalizedCid || !messageId || !text || direction === 'unknown') return null;
  return {
    shopUid: cleanId(raw.shopUid || shopUid, 128),
    cid: normalizedCid,
    messageId,
    clientId: cleanId(raw.clientId, 128),
    direction,
    senderRole,
    fromId,
    fromNick: cleanText(raw.fromNick || raw.from_nick, 128),
    toId,
    toNick: cleanText(raw.toNick || raw.to_nick, 128),
    text,
    parts,
    templateId: raw.templateId,
    templateData: raw.templateData,
    qianniuRaw: hasUnsupportedParts ? rawEvidence(raw) : null,
    transferNotice,
    projection,
    sendTime: sentAt(raw.sendTime || raw.platform_sent_at),
    sortTimeMicrosecond: cleanId(raw.sortTimeMicrosecond, 64),
  };
}

export function qianniuAccountFromBridgeClient(client, profile = null) {
  const shopUid = cleanId(client?.state?.loginID?.targetId, 128);
  if (!shopUid) return null;
  const display = cleanText(
    client?.state?.loginID?.display || client?.state?.loginID?.nick || `千牛店铺 ${shopUid}`,
    128,
  );
  const mainUid = cleanId(client?.state?.loginID?.havMainId, 128);
  const nick = cleanText(client?.state?.loginID?.nick || display, 128);
  const verified = profile?.service_account_uid === shopUid && profile?.main_account_uid === mainUid &&
    profile?.service_account_name === nick && profile?.shop_name_source === 'qianniu_shop_info' ? profile : null;
  return {
    id: `qianniu-${shopUid}`,
    platform_code: QIANNIU_PLATFORM_CODE,
    alias: verified?.shop_name || '待识别店铺',
    external_account_id: `qianniu:${shopUid}`,
    account_name: display,
    login_status: 'online',
    paused: false,
    archived: false,
    metadata_json: {
      shop_uid: shopUid,
      service_account_uid: shopUid,
      service_account_name: nick,
      main_account_uid: mainUid,
      ...(verified || {}),
      bridge_client_id: cleanId(client.clientId, 128),
      bridge_page: cleanId(client.page, 512),
      bridge_read_messages_version: Number(client.readMessagesVersion || 0),
      ability_mode: cleanId(client.abilityMode, 128),
    },
  };
}

export function qianniuEventsForIncomingMessage({
  platformAccountId,
  shopUid,
  cid,
  message,
  observedAt = new Date().toISOString(),
  source = 'qianniu_app_log',
  snapshot = false,
}) {
  const normalized = normalizeQianniuMessage(message, { shopUid, cid });
  if (!platformAccountId || !normalized) return [];
  const customerId = (normalized.direction === 'outgoing'
    ? (normalized.toId === normalized.fromId ? buyerUidFromCid(normalized.cid) : normalized.toId)
    : normalized.fromId) || buyerUidFromCid(normalized.cid);
  const customerName = (normalized.direction === 'outgoing' ? normalized.toNick : normalized.fromNick) || customerId || normalized.cid;
  const base = `${QIANNIU_PLATFORM_CODE}:${shopUid}:${normalized.cid}:${normalized.messageId}`;
  const conversationPayload = {
    customer_id: customerId,
    customer_name: customerName,
    title: customerName,
    content: normalized.text,
    unread_count: 1,
    conversation_metadata: {
      shop_uid: shopUid,
      cid: normalized.cid,
      buyer_uid: buyerUidFromCid(normalized.cid) || customerId,
      source,
    },
  };
  const messagePayload = {
    ...conversationPayload,
    sender_role: normalized.senderRole,
    sender_name: normalized.senderRole === 'platform' ? '千牛平台' : normalized.direction === 'outgoing' ? normalized.fromNick : customerName,
    ...normalized.projection,
    automation_mode: snapshot || normalized.direction === 'outgoing' || normalized.senderRole === 'platform'
      ? 'ignore' : 'trigger',
    qianniu_media_version: 1,
    template_id: normalized.templateId,
    platform_sent_at: normalized.sendTime || null,
    observed_at: observedAt,
    client_id: normalized.clientId || null,
    raw_direction: normalized.direction,
    ...(normalized.transferNotice ? { qianniu_transfer_notice: normalized.transferNotice } : {}),
    ...(normalized.qianniuRaw ? {
      qianniu_raw: normalized.qianniuRaw,
      context_eligible: normalized.senderRole === 'customer',
    } : {}),
  };
  if (normalized.transferNotice && !snapshot) {
    return [{ event_id: `qianniu_${digest(`${base}:transfer-notice`).slice(0, 32)}`,
      dedup_key: `${base}:transfer-notice`, event_type: 'message_received', platform_code: QIANNIU_PLATFORM_CODE,
      platform_account_id: platformAccountId, platform_message_id: normalized.messageId,
      conversation_external_id: normalized.cid, received_at: observedAt,
      payload_json: { ...messagePayload, automation_mode: 'trigger' } }];
  }
  if (snapshot || normalized.senderRole === 'platform' || normalized.direction === 'outgoing') {
    const revision = digest(JSON.stringify(messagePayload));
    return [{ event_id: `qianniu_${revision.slice(0, 32)}`, dedup_key: `${base}:snapshot:${revision}`,
      event_type: 'qianniu_message_snapshot', platform_code: QIANNIU_PLATFORM_CODE, platform_account_id: platformAccountId,
      platform_message_id: normalized.messageId, conversation_external_id: normalized.cid,
      received_at: observedAt, payload_json: { ...messagePayload, automation_mode: 'ignore' } }];
  }
  return [
    {
      event_id: `qianniu_${digest(`${base}:conversation`).slice(0, 32)}`,
      dedup_key: `${base}:conversation`,
      event_type: 'conversation_snapshot',
      platform_code: QIANNIU_PLATFORM_CODE,
      platform_account_id: platformAccountId,
      platform_message_id: normalized.messageId,
      conversation_external_id: normalized.cid,
      received_at: observedAt,
      payload_json: conversationPayload,
    },
    {
      event_id: `qianniu_${digest(`${base}:customer`).slice(0, 32)}`,
      dedup_key: `${base}:customer`,
      event_type: 'customer_message',
      platform_code: QIANNIU_PLATFORM_CODE,
      platform_account_id: platformAccountId,
      platform_message_id: normalized.messageId,
      conversation_external_id: normalized.cid,
      received_at: observedAt,
      payload_json: messagePayload,
    },
  ];
}

export function sendTargetFromTask(task, platformAccountBindings = new Map()) {
  const payload = task?.payload_json || {};
  const platformAccountId = cleanId(task?.platform_account_id || payload.platform_account_id, 128);
  const shopUid = cleanId(
    payload.shop_uid ||
    payload.shopUid ||
    platformAccountBindings.get(platformAccountId),
    128,
  );
  const cid = cleanId(payload.external_conversation_id || task?.conversation_external_id, 256);
  const text = cleanOutboundText(payload.content || payload.text || payload.message || '');
  if (!shopUid || !/^\d+$/.test(shopUid)) throw new Error('千牛发送缺少有效 shopUid');
  if (!SINGLE_CHAT_CID.test(cid)) throw new Error('千牛发送缺少有效单聊 cid');
  if (!text) throw new Error('千牛发送内容为空');
  return { shopUid, cid, text };
}

export { QIANNIU_PLATFORM_CODE };
