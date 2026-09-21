'use strict';

const { ipcRenderer } = require('electron');

const CHANNEL = 'pdd-adapter:event';
const API_SHADOW_VERSION = '2026-08-22-platform-phrases-v2';
const MAX_TEXT = 4000;
const DOM_CONVERSATION_SCAN_ENABLED = false;
const SCAN_INTERVAL_MS = 5000;
const SHOP_INFO_REFRESH_INTERVAL_MS = 15000;
const MUTATION_DEBOUNCE_MS = 250;
const FAILED_SWITCH_COOLDOWN_MS = 1500;
const SWITCH_TIMEOUT_MS = 4000;
const SWITCH_POLL_MS = 100;
const IMAGE_CONFIRMATION_HARD_TIMEOUT_MS = 60000;
const MANUAL_ACTIVITY_PAUSE_MS = 5000;
const PAGE_ACTIVITY_REPORT_INTERVAL_MS = 5000;
const IDENTITY_STABLE_MS = 1000;
const HANDLED_UNREAD_RETRY_MS = 30000;
const API_SYNC_POLL_INTERVAL_MS = 2000;
const API_LATEST_CONVERSATIONS_POLL_INTERVAL_MS = 2000;
const MANUAL_VERIFICATION_PATTERN = /安全验证|请完成验证|风险验证|拖动.{0,8}滑块|滑块验证|账号异常|盗号风险|存在盗号风险|安全风险|立即修改密码|验证码错误|验证码已发送/i;
const MANUAL_VERIFICATION_SELECTOR = [
  '[class*="captcha"]',
  '[id*="captcha"]',
  '[data-testid*="captcha"]',
  '[class*="risk-verify"]',
  '[class*="slider"]',
  '[id*="slider"]',
  'iframe[src*="captcha"]',
].join(',');
const UNREAD_STATUS_PATTERN = /\u672a\u56de\u590d|\u5f85\u56de\u590d|\u8bf7\d*\u5206\u949f\u5185\u56de\u590d|\u8d85\u65f6|\u7ea2\u70b9|new/i;
const GENERIC_ACCOUNT_NAME = /^(\u62fc\u591a\u591a|\u62fc\u591a\u591a\u5546\u5bb6\u540e\u53f0|\u62fc\u591a\u591a\u5546\u5bb6\u7ba1\u7406\u540e\u53f0|\u62fc\u591a\u591a\u5ba2\u670d\u5e73\u53f0|\u5546\u5bb6\u540e\u53f0|\u5ba2\u670d\u5e73\u53f0)$/;
const PLATFORM_SYSTEM_PROMPT_PATTERN = /(?:您好像还没有配置消费者问到的常见问题回答|还没有配置.*常见问题回答|常见问题回答.*立即配置|立即配置.*常见问题回答|提升.*接待效率|减少顾客流失)/;
const FALLBACK_SELECTORS = {
  conversationItems: ['.chat-item', '[data-conversation-id]', '[data-session-id]', '[data-chat-id]'],
  conversationName: ['[data-role="customer-name"]', '[class*="nickname"]', '[class*="user-name"]'],
  conversationPreview: ['[data-role="message-preview"]', '[class*="last-message"]'],
  unreadBadge: [
    '.SessionBaseCard-unread-rot',
    '[data-role="unread-count"]',
    '.ant-badge-count',
    '.ant-badge-dot',
    '.semi-badge',
    '.semi-badge-dot',
    '[class*="unread"]',
    '[class*="badge"]',
  ],
  messageItems: [
    'li[id^="middlePanel_List_"]',
    '.msg-list li.onemsg',
    '.onemsg',
    '[data-message-id]',
    '[data-msg-id]',
    '[class*="message-item"]',
  ],
  messageContainers: [
    '#message-panel',
    '.msg-list',
    '[data-role="message-list"]',
    '[class*="MessageList"]',
    '[class*="message-list"]',
    '[class*="messageList"]',
    '[class*="msg-list"]',
  ],
  messageContent: [
    '.kwaishop-cs-BizTextCard',
    '[class*="BizTextCard"]',
    '.msg-content',
    '[data-role="message-content"]',
    '[class*="message-content"]',
    '[class*="bubble"]',
  ],
  messageTime: ['time', '[data-role="message-time"]', '[class*="message-time"]'],
  shopName: [
    '.LoginUserInfo-mainTitle-text',
    '[class*="LoginUserInfo-mainTitle-text"]',
    '[class*="LoginUserInfo"] [class*="mainTitle"]',
    '[data-role="shop-name"]',
    '.shop-name',
    '[class*="shopName"]',
    '[class*="ShopName"]',
    '[class*="mall-name"]',
    '[class*="shop-name"]',
  ],
  replyInput: [
    '#replyTextarea',
    '#replyText',
    '[contenteditable="true"][role="textbox"]',
    '[contenteditable="true"]',
    'textarea',
  ],
  replySendButton: [
    '[data-role="send-message"]',
    '[data-testid="send-message"]',
    '#replySendButton',
    '#sendBtn',
    'button[type="submit"]',
  ],
  latestOrdersTab: ['[data-role="latest-orders"]', '[class*="LatestOrder"]', '[class*="latest-order"]'],
  personalOrdersTab: ['[data-role="personal-orders"]', '[class*="PersonalOrder"]', '[class*="personal-order"]'],
  orderCards: [
    '[data-order-id]',
    '[class*="OrderCard"]',
    '[class*="order-card"]',
    '[class*="OrderItem"]',
  ],
};

function loadSelectors() {
  const prefix = '--pdd-adapter-config=';
  const argument = process.argv.find((item) => item.startsWith(prefix));
  if (!argument) return FALLBACK_SELECTORS;
  try {
    const parsed = JSON.parse(decodeURIComponent(argument.slice(prefix.length)));
    const configuredSelectors = parsed?.selectors || parsed;
    if (parsed?.rules) collectorRules = normalizeCollectorRules(parsed.rules);
    return { ...FALLBACK_SELECTORS, ...configuredSelectors };
  } catch {
    return FALLBACK_SELECTORS;
  }
}

const DEFAULT_COLLECTOR_RULES = {
  version: 'bundled',
  platform: 'pinduoduo',
  classification: {
    system_selectors: ['.msg-system', '[class*="System"]'],
    context_selectors: ['[class*="BuyerFromCard"]', '[class*="UserFrom"]'],
    product_selectors: ['[class*="GoodsCard"]', '[class*="goods"]', '[class*="product"]'],
    order_selectors: ['.order-card', '.kwaishop-cs-BizOrderCard', '[class*="OrderCard"]'],
    ignored_text_patterns: ['^没有更多了$', '^暂无更多(?:消息)?$'],
    context_text_patterns: ['^当前用户来自.*(?:商品详情页|店铺|直播间|搜索|活动页)'],
    product_text_patterns: ['(?:商品\\s*ID\\s*[：:]?\\s*\\d{6,}|查看商品规格)'],
    system_text_patterns: ['(?:撤回了一条消息|邀请下单.*立即使用)$'],
  },
};
let collectorRules = DEFAULT_COLLECTOR_RULES;

function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string').slice(0, 100) : [];
}

function normalizeCollectorRules(value) {
  if (!value || value.platform !== 'pinduoduo') return DEFAULT_COLLECTOR_RULES;
  const configured = value.classification || {};
  const defaults = DEFAULT_COLLECTOR_RULES.classification;
  return {
    version: typeof value.version === 'string' ? value.version.slice(0, 64) : 'remote',
    platform: 'pinduoduo',
    classification: Object.fromEntries(Object.keys(defaults).map((key) => [
      key,
      stringArray(configured[key]).length ? stringArray(configured[key]) : defaults[key],
    ])),
  };
}

function matchesConfiguredSelector(element, key) {
  for (const selector of collectorRules.classification[key] || []) {
    try {
      if (element.matches(selector) || element.querySelector(selector)) return true;
    } catch {
      // Ignore invalid remotely configured selectors.
    }
  }
  return false;
}

function matchesConfiguredText(value, key) {
  return (collectorRules.classification[key] || []).some((pattern) => {
    try {
      return new RegExp(pattern, 'i').test(value);
    } catch {
      return false;
    }
  });
}

const selectors = loadSelectors();

function diagnostic(stage, details = {}, level = 'info') {
  ipcRenderer.send(CHANNEL, {
    version: 1,
    type: 'diagnostic',
    level,
    stage,
    details,
    observed_at: new Date().toISOString(),
  });
}

function text(value, limit = MAX_TEXT) {
  const cleaned = String(value || '').replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, limit) : null;
}

let lastPageActivityReportedAt = 0;

function emitPageActivity(activityType) {
  const now = Date.now();
  if (now - lastPageActivityReportedAt < PAGE_ACTIVITY_REPORT_INTERVAL_MS) return;
  lastPageActivityReportedAt = now;
  ipcRenderer.send(CHANNEL, {
    version: 1,
    type: 'page_activity',
    activity_type: activityType,
    observed_at: new Date().toISOString(),
  });
}

const PDD_API_ENDPOINTS = [
  {
    key: 'latest_conversations',
    pattern: '/plateau/chat/latest_conversations',
  },
  {
    key: 'custom_service_info',
    pattern: '/janus/api/customService/queryCustomServiceInfo',
  },
  {
    key: 'userinfo_realtime',
    pattern: '/chats/userinfo/realtime',
  },
  {
    key: 'chat_list',
    pattern: '/plateau/chat/list',
  },
  {
    key: 'user_all_order',
    pattern: '/latitude/order/userAllOrder',
  },
  {
    key: 'recommend_goods',
    pattern: '/latitude/goods/recommendGoods',
  },
  {
    key: 'personal_phrases',
    pattern: '/tornado/quickReply/getAllQuickReplyWithOrder',
  },
  {
    key: 'team_phrases',
    pattern: '/tornado/phrase/getPhrase',
  },
  {
    key: 'mall_goods_card',
    pattern: '/plateau/message/send/mallGoodsCard',
  },
  {
    key: 'sync_message',
    pattern: '/plateau/sync/message',
  },
  {
    key: 'send_message',
    pattern: 'send_message',
  },
  {
    key: 'image_pre_upload',
    pattern: 'pre_upload',
  },
  {
    key: 'image_store',
    pattern: 'store_image',
  },
  {
    key: 'image_upload',
    pattern: 'image_upload',
  },
];

const apiRuntimeState = {
  antiContentHeader: null,
  antiContentBody: null,
  latestIdentity: null,
  lastDiagnosticByKey: new Map(),
};

function endpointFromUrl(value) {
  const url = String(value || '');
  return PDD_API_ENDPOINTS.find((endpoint) => url.includes(endpoint.pattern)) || null;
}

function urlSummary(value) {
  try {
    const parsed = new URL(String(value || ''), location.href);
    return {
      origin: parsed.origin,
      host: parsed.host,
      pathname: parsed.pathname,
      query_keys: [...parsed.searchParams.keys()].slice(0, 30),
    };
  } catch {
    return null;
  }
}

function customerUidFromApiMessage(message) {
  if (message?.from?.role === 'user') return text(message.from.uid ?? message.from.id, 128);
  if (message?.to?.role === 'user') return text(message.to.uid ?? message.to.id, 128);
  return text(message?.user_info?.uid, 128);
}

function mallIdFromApiMessage(message) {
  return text(message?.from?.mall_id ?? message?.to?.mall_id ?? message?.mall_id, 128);
}

function identityFromShopInfoResponse(response, source = 'pdd_api_shop_info') {
  const mallInfo = response?.result?.mallInfoResult && typeof response.result.mallInfoResult === 'object'
    ? response.result.mallInfoResult
    : null;
  const realtimeMall = response?.mall && typeof response.mall === 'object'
    ? response.mall
    : null;
  const externalAccountId = text(
    mallInfo?.mallId
      ?? realtimeMall?.mall_id
      ?? response?.mall_id,
    128,
  );
  const accountName = text(
    mallInfo?.mallName
      ?? realtimeMall?.mall_name,
    128,
  );
  const logoUrl = text(
    mallInfo?.logo
      ?? realtimeMall?.logo,
    1000,
  );
  const serviceUsername = text(response?.username, 128);
  const csId = text(response?.cs_id, 128);
  const csUid = text(response?.cs_uid, 256);
  if (!accountName && !externalAccountId) return null;
  return {
    version: 1,
    type: 'identity',
    external_account_id: externalAccountId,
    account_name: accountName,
    logo_url: logoUrl,
    service_username: serviceUsername,
    cs_id: csId,
    cs_uid: csUid,
    is_mall_owner: response?.is_mall_owner === true,
    account_name_source: source,
    observed_at: new Date().toISOString(),
  };
}

function summarizeApiPayload(endpoint, response, context = {}) {
  const result = response?.result || {};
  const requestSummary = context.requestSummary && typeof context.requestSummary === 'object'
    ? context.requestSummary
    : null;
  const requestUrl = context.urlSummary && typeof context.urlSummary === 'object'
    ? context.urlSummary
    : null;
  if (endpoint.key === 'latest_conversations') {
    const conversations = Array.isArray(result.conversations) ? result.conversations : [];
    const firstWithShop = conversations.find((conversation) => conversation?.mallName || conversation?.from?.mall_id);
    return {
      endpoint: endpoint.key,
      source: 'pdd_api_latest_conversations',
      conversation_count: conversations.length,
      message_count: 0,
      customer_uids: conversations.map(customerUidFromApiMessage).filter(Boolean).slice(0, 20),
      shop_name: text(firstWithShop?.mallName, 128),
      mall_id_present: Boolean(text(firstWithShop?.from?.mall_id || firstWithShop?.mall_id, 128)),
      has_more: Boolean(result.has_more),
      page: Number.isFinite(Number(result.page)) ? Number(result.page) : null,
      size: Number.isFinite(Number(result.size)) ? Number(result.size) : null,
    };
  }
  if (endpoint.key === 'custom_service_info' || endpoint.key === 'userinfo_realtime') {
    const source = endpoint.key === 'custom_service_info'
      ? 'pdd_api_custom_service_info'
      : 'pdd_api_userinfo_realtime';
    const identity = identityFromShopInfoResponse(response, source);
    return {
      endpoint: endpoint.key,
      source,
      success: response?.success === true,
      has_shop_identity: Boolean(identity),
      shop_name: identity?.account_name || null,
      mall_id_present: Boolean(identity?.external_account_id),
      logo_present: Boolean(
        text(response?.result?.mallInfoResult?.logo, 1000)
          || text(response?.mall?.logo, 1000),
      ),
      cs_id_present: Boolean(text(response?.cs_id, 128)),
      username_present: Boolean(text(response?.username, 128)),
    };
  }
  if (endpoint.key === 'chat_list') {
    const messages = Array.isArray(result.messages) ? result.messages : [];
    return {
      endpoint: endpoint.key,
      source: 'pdd_api_chat_list',
      conversation_count: context.customerUid || messages.some(customerUidFromApiMessage) ? 1 : 0,
      message_count: messages.length,
      customer_uids: [context.customerUid || messages.map(customerUidFromApiMessage).find(Boolean)].filter(Boolean),
      has_more: Boolean(result.has_more),
      has_read_mark: Boolean(result.read_mark),
    };
  }
  if (endpoint.key === 'sync_message') {
    const syncData = Array.isArray(result.sync_data) ? result.sync_data : [];
    const messages = syncData.flatMap((item) => (
      Array.isArray(item.data) ? item.data.map((wrapper) => wrapper?.message).filter(Boolean) : []
    ));
    return {
      endpoint: endpoint.key,
      source: 'pdd_api_sync_message',
      conversation_count: new Set(messages.map(customerUidFromApiMessage).filter(Boolean)).size,
      message_count: messages.length,
      customer_uids: [...new Set(messages.map(customerUidFromApiMessage).filter(Boolean))].slice(0, 20),
      sync_keys: syncData
        .filter((item) => Number.isFinite(Number(item.seq_type)) && Number.isFinite(Number(item.seq_id)))
        .map((item) => ({ seq_type: Number(item.seq_type), seq_id: Number(item.seq_id) }))
        .slice(0, 5),
      server_time_present: Boolean(result.server_time),
    };
  }
  if (endpoint.key === 'send_message') {
    return {
      endpoint: endpoint.key,
      success: response?.success === true && result.result === 'ok',
      has_msg_id: Boolean(result.msg_id),
      has_pre_msg_id: Boolean(result.pre_msg_id),
      has_ts: Boolean(result.ts),
    };
  }
  if (endpoint.key === 'personal_phrases' || endpoint.key === 'team_phrases') {
    const groups = Array.isArray(result.chatReplyGroupList) ? result.chatReplyGroupList : [];
    return {
      endpoint: endpoint.key,
      success: response?.success === true,
      group_count: endpoint.key === 'team_phrases'
        ? (Array.isArray(result.groupList) ? result.groupList.length : 0)
        : groups.length,
      phrase_count: endpoint.key === 'team_phrases'
        ? (Array.isArray(result.phraseList) ? result.phraseList.length : 0)
        : groups.reduce((sum, group) => (
          sum + (Array.isArray(group?.quickReplyList) ? group.quickReplyList.length : 0)
        ), 0),
    };
  }
  if (endpoint.key === 'image_pre_upload' || endpoint.key === 'image_store' || endpoint.key === 'image_upload') {
    return {
      endpoint: endpoint.key,
      source: endpoint.key === 'image_pre_upload'
        ? 'pdd_api_image_pre_upload'
        : endpoint.key === 'image_store' ? 'pdd_api_image_store' : 'pdd_api_image_upload',
      success: response?.success === true,
      result_ok: result.result === 'ok',
      request_url: requestUrl,
      request: requestSummary,
      http_status: Number.isFinite(Number(response?.__http_status)) ? Number(response.__http_status) : null,
      response_content_type: text(response?.__content_type, 256),
      response_text_preview: text(response?.__text_preview, 1000),
      response_top_keys: response && typeof response === 'object' ? Object.keys(response).slice(0, 20) : [],
      result_top_keys: result && typeof result === 'object' ? Object.keys(result).slice(0, 20) : [],
      image_url: findFirstImageUrl(response),
      hash: findFirstStringByKey(response, ['hash', 'image_hash', 'sha256'], 128),
      width: findFirstNumberByKey(response, ['width', 'w']),
      height: findFirstNumberByKey(response, ['height', 'h']),
      image_size: findFirstNumberByKey(response, ['image_size', 'size']),
      thumb_data_present: hasDataImageString(response),
      upload_token_present: Boolean(findFirstStringByKey(response, ['token', 'access_token', 'signature', 'policy'], 128)),
    };
  }
  return {
    endpoint: endpoint.key,
    success: response?.success === true,
  };
}

function walkJson(value, visit, maxNodes = 300) {
  const queue = [{ key: '', value }];
  const seen = new Set();
  let count = 0;
  while (queue.length && count < maxNodes) {
    const item = queue.shift();
    count += 1;
    if (visit(item.value, item.key)) return true;
    if (!item.value || typeof item.value !== 'object' || seen.has(item.value)) continue;
    seen.add(item.value);
    if (Array.isArray(item.value)) {
      for (let index = 0; index < item.value.length; index += 1) {
        queue.push({ key: String(index), value: item.value[index] });
      }
    } else {
      for (const [childKey, childValue] of Object.entries(item.value)) {
        queue.push({ key: childKey, value: childValue });
      }
    }
  }
  return false;
}

function findFirstStringByKey(value, keys, limit = 256) {
  const normalizedKeys = new Set(keys.map((item) => String(item).toLowerCase()));
  let found = null;
  walkJson(value, (candidate, key) => {
    if (!normalizedKeys.has(String(key || '').toLowerCase())) return false;
    if (typeof candidate !== 'string' && typeof candidate !== 'number') return false;
    found = text(candidate, limit);
    return Boolean(found);
  });
  return found;
}

function findFirstNumberByKey(value, keys) {
  const normalizedKeys = new Set(keys.map((item) => String(item).toLowerCase()));
  let found = null;
  walkJson(value, (candidate, key) => {
    if (!normalizedKeys.has(String(key || '').toLowerCase())) return false;
    const number = Number(candidate);
    if (!Number.isFinite(number)) return false;
    found = number;
    return true;
  });
  return found;
}

function findFirstImageUrl(value) {
  let found = null;
  walkJson(value, (candidate) => {
    if (typeof candidate !== 'string') return false;
    const cleaned = candidate.trim();
    if (!/^https?:\/\//i.test(cleaned)) return false;
    if (!/(chat-img|pddugc|pddpic|\.jpe?g|\.png|\.webp)/i.test(cleaned)) return false;
    found = cleaned.slice(0, 1000);
    return true;
  });
  return found;
}

function hasDataImageString(value) {
  let found = false;
  walkJson(value, (candidate) => {
    found = typeof candidate === 'string' && candidate.startsWith('data:image/');
    return found;
  });
  return found;
}

function safeApiDiagnostic(endpoint, response, context = {}) {
  try {
    const details = {
      ...summarizeApiPayload(endpoint, response, context),
      has_anti_content_header: Boolean(apiRuntimeState.antiContentHeader),
      has_anti_content_body: Boolean(apiRuntimeState.antiContentBody),
    };
    const fingerprint = JSON.stringify(details);
    const last = apiRuntimeState.lastDiagnosticByKey.get(endpoint.key);
    if (last === fingerprint) return;
    apiRuntimeState.lastDiagnosticByKey.set(endpoint.key, fingerprint);
    diagnostic('api_shadow_snapshot', details, 'debug');
  } catch (error) {
    diagnostic('api_shadow_mapping_failed', {
      endpoint: endpoint.key,
      error: error?.message || String(error),
    }, 'warn');
  }
}

function installApiShadowBridge() {
  if (window.__pddApiShadowInstalled && window.__pddApiShadowVersion === API_SHADOW_VERSION) return;
  window.__pddApiShadowInstalled = true;
  window.__pddApiShadowVersion = API_SHADOW_VERSION;
  const inject = () => {
    if (!document.documentElement && !document.head && !document.body) return false;
    const script = document.createElement('script');
    script.textContent = `;(${installApiShadowMainWorld.toString()})(${JSON.stringify(API_SHADOW_VERSION)});`;
    (document.documentElement || document.head || document.body).appendChild(script);
    script.remove();
    return true;
  };
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.source === 'pdd-api-shadow-command-ack') {
      diagnostic('api_shadow_command_received', {
        command: text(event.data.command, 128),
        request_id: text(event.data.requestId, 128),
        api_shadow_version: text(event.data.apiShadowVersion, 128),
        command_api_shadow_version: text(event.data.commandApiShadowVersion, 128),
      }, 'debug');
      return;
    }
    if (event.data?.source === 'pdd-api-client-result') {
      const payload = event.data.payload || {};
      if (payload.endpoint === 'sync_message') {
        emit('api_sync_message_result', {
          status: payload.status === 'synced' ? 'synced' : 'failed',
          source: text(payload.resultSource, 64),
          response: payload.response && typeof payload.response === 'object' ? payload.response : null,
          error: text(payload.error, 256),
          diagnostics: payload.diagnostics && typeof payload.diagnostics === 'object' ? payload.diagnostics : {},
        });
        return;
      }
      if (payload.endpoint === 'send_message') {
        emit('api_message_send_result', {
          request_id: typeof payload.requestId === 'string' ? payload.requestId.slice(0, 128) : null,
          status: payload.status === 'sent' ? 'sent' : 'failed',
          conversation_key: text(payload.conversationKey, 128),
          customer_uid: text(payload.customerUid, 128),
          customer_name: text(payload.customerName, 128),
          result: payload.result && typeof payload.result === 'object' ? payload.result : null,
          error: text(payload.error, 256),
          response_preview: text(payload.responsePreview, 1000),
          diagnostics: payload.diagnostics && typeof payload.diagnostics === 'object' ? payload.diagnostics : {},
        });
        return;
      }
      if (payload.endpoint === 'transfer_conversation') {
        emit('api_conversation_transfer_result', {
          request_id: typeof payload.requestId === 'string' ? payload.requestId.slice(0, 128) : null,
          status: ['transferred', 'no_online_target', 'confirmation_pending'].includes(payload.status) ? payload.status : 'failed',
          submitted: payload.submitted === true,
          conversation_key: text(payload.conversationKey, 128),
          customer_uid: text(payload.customerUid, 128),
          customer_name: text(payload.customerName, 128),
          target_cs_id: text(payload.targetCsId, 128),
          target_cs_username: text(payload.targetCsUsername, 128),
          target_cs_nickname: text(payload.targetCsNickname, 128),
          trans_reason: text(payload.transReason, 128),
          result: payload.result && typeof payload.result === 'object' ? payload.result : null,
          error: text(payload.error, 256),
          diagnostics: payload.diagnostics && typeof payload.diagnostics === 'object' ? payload.diagnostics : {},
        });
        return;
      }
      if (payload.endpoint === 'transfer_cs_list') {
        emit('api_transfer_cs_list_result', {
          request_id: typeof payload.requestId === 'string' ? payload.requestId.slice(0, 128) : null,
          status: payload.status === 'collected' ? 'collected' : 'failed',
          cs_list: Array.isArray(payload.csList) ? payload.csList : [],
          identity_verified: payload.identityVerified === true,
          trans_reason: Array.isArray(payload.transReason) ? payload.transReason : [],
          error: text(payload.error, 256),
          diagnostics: payload.diagnostics && typeof payload.diagnostics === 'object' ? payload.diagnostics : {},
        });
        return;
      }
      if (payload.endpoint === 'send_image') {
        emit('api_image_send_result', {
          request_id: typeof payload.requestId === 'string' ? payload.requestId.slice(0, 128) : null,
          status: payload.status === 'sent' ? 'sent' : 'failed',
          conversation_key: text(payload.conversationKey, 128),
          customer_uid: text(payload.customerUid, 128),
          customer_name: text(payload.customerName, 128),
          result: payload.result && typeof payload.result === 'object' ? payload.result : null,
          upload: payload.upload && typeof payload.upload === 'object' ? payload.upload : null,
          error: text(payload.error, 256),
          response_preview: text(payload.responsePreview, 1000),
          diagnostics: payload.diagnostics && typeof payload.diagnostics === 'object' ? payload.diagnostics : {},
        });
        return;
      }
      if (payload.endpoint === 'latest_conversations') {
        emit('api_latest_conversations_result', {
          request_id: typeof payload.requestId === 'string' ? payload.requestId.slice(0, 128) : null,
          purpose: text(payload.purpose, 64),
          status: payload.status === 'collected' ? 'collected' : 'failed',
          response: payload.response && typeof payload.response === 'object' ? payload.response : null,
          error: text(payload.error, 256),
          diagnostics: payload.diagnostics && typeof payload.diagnostics === 'object' ? payload.diagnostics : {},
        });
        return;
      }
      if (payload.endpoint === 'shop_info') {
        const source = text(payload.source, 64) || 'pdd_api_shop_info';
        const identity = payload.response && typeof payload.response === 'object'
          ? identityFromShopInfoResponse(payload.response, source)
          : null;
        if (identity) {
          apiRuntimeState.latestIdentity = identity;
          emit('identity', identity);
        }
        if (payload.purpose === 'account-name-detection') {
          emit('account_name_detection', {
            request_id: typeof payload.requestId === 'string' ? payload.requestId.slice(0, 128) : null,
            account_name: identity?.account_name || null,
            source: identity?.account_name_source || null,
            error: text(payload.error, 256),
            diagnostics: payload.diagnostics && typeof payload.diagnostics === 'object' ? payload.diagnostics : {},
          });
        }
        return;
      }
      if (payload.endpoint === 'customer_orders') {
        emit('api_customer_orders_result', {
          request_id: typeof payload.requestId === 'string' ? payload.requestId.slice(0, 128) : null,
          status: payload.status === 'collected' ? 'collected' : 'failed',
          conversation_key: text(payload.conversationKey, 128),
          customer_uid: text(payload.customerUid, 128),
          customer_name: text(payload.customerName, 128),
          response: payload.response && typeof payload.response === 'object' ? payload.response : null,
          error: text(payload.error, 256),
          diagnostics: payload.diagnostics && typeof payload.diagnostics === 'object' ? payload.diagnostics : {},
        });
        return;
      }
      if (payload.endpoint === 'customer_products') {
        emit('api_customer_products_result', {
          request_id: typeof payload.requestId === 'string' ? payload.requestId.slice(0, 128) : null,
          status: payload.status === 'collected' ? 'collected' : 'failed',
          conversation_key: text(payload.conversationKey, 128),
          customer_uid: text(payload.customerUid, 128),
          customer_name: text(payload.customerName, 128),
          response: payload.response && typeof payload.response === 'object' ? payload.response : null,
          error: text(payload.error, 256),
          diagnostics: payload.diagnostics && typeof payload.diagnostics === 'object' ? payload.diagnostics : {},
        });
        return;
      }
      if (payload.endpoint === 'platform_phrases') {
        emit('api_platform_phrases_result', {
          request_id: typeof payload.requestId === 'string' ? payload.requestId.slice(0, 128) : null,
          status: payload.status === 'collected' ? 'collected' : 'failed',
          source: payload.source === 'team' ? 'team' : 'personal',
          records: Array.isArray(payload.records) ? payload.records : [],
          raw_count: Number(payload.raw_count) || 0,
          error: text(payload.error, 256),
          diagnostics: payload.diagnostics && typeof payload.diagnostics === 'object' ? payload.diagnostics : {},
        });
        return;
      }
      if (payload.endpoint === 'send_product') {
        emit('api_product_send_result', {
          request_id: typeof payload.requestId === 'string' ? payload.requestId.slice(0, 128) : null,
          status: payload.status === 'sent' ? 'sent' : 'failed',
          conversation_key: text(payload.conversationKey, 128),
          customer_uid: text(payload.customerUid, 128),
          customer_name: text(payload.customerName, 128),
          product_id: text(payload.productId, 128),
          response: payload.response && typeof payload.response === 'object' ? payload.response : null,
          error: text(payload.error, 256),
          diagnostics: payload.diagnostics && typeof payload.diagnostics === 'object' ? payload.diagnostics : {},
        });
        return;
      }
      if (payload.endpoint !== 'chat_list' || typeof payload.requestId !== 'string') return;
      emit('api_chat_list_result', {
        request_id: payload.requestId.slice(0, 128),
        status: payload.status === 'collected' ? 'collected' : 'failed',
        conversation_key: text(payload.conversationKey, 128),
        customer_uid: text(payload.customerUid, 128),
        customer_name: text(payload.customerName, 128),
        avatar_url: text(payload.avatarUrl, 1000),
        response: payload.response && typeof payload.response === 'object' ? payload.response : null,
        error: text(payload.error, 256),
        diagnostics: payload.diagnostics && typeof payload.diagnostics === 'object' ? payload.diagnostics : {},
      });
      return;
    }
    if (event.data?.source !== 'pdd-api-shadow') return;
    const endpoint = endpointFromUrl(event.data.url || event.data.endpoint || '');
    if (!endpoint || !event.data.response) return;
    if (event.data.runtime?.hasAntiContentHeader) apiRuntimeState.antiContentHeader = '[present]';
    if (event.data.runtime?.hasAntiContentBody) apiRuntimeState.antiContentBody = '[present]';
    if (endpoint.key === 'custom_service_info' || endpoint.key === 'userinfo_realtime') {
      const source = endpoint.key === 'custom_service_info'
        ? 'pdd_api_custom_service_info'
        : 'pdd_api_userinfo_realtime';
      const identity = identityFromShopInfoResponse(event.data.response, source);
      if (identity) apiRuntimeState.latestIdentity = identity;
    }
    safeApiDiagnostic(endpoint, event.data.response, {
      customerUid: text(event.data.request?.customerUid, 128),
      urlSummary: urlSummary(event.data.url),
      requestSummary: event.data.request?.requestSummary && typeof event.data.request.requestSummary === 'object'
        ? event.data.request.requestSummary
        : null,
      hasAntiContentHeader: Boolean(event.data.runtime?.hasAntiContentHeader),
      hasAntiContentBody: Boolean(event.data.runtime?.hasAntiContentBody),
    });
  });
  if (!inject()) {
    window.addEventListener('DOMContentLoaded', () => {
      inject();
    }, { once: true });
  }
}

function installApiShadowMainWorld(apiShadowVersion = 'unknown') {
  if (
    window.__pddApiShadowMainWorldInstalled
    && window.__pddApiShadowMainWorldVersion === apiShadowVersion
  ) return;
  window.__pddApiShadowMainWorldInstalled = true;
  window.__pddApiShadowMainWorldVersion = apiShadowVersion;
  const syncPollIntervalMs = 2000;
  const latestConversationsPollIntervalMs = 2000;
  const endpoints = [
    { key: 'latest_conversations', pattern: '/plateau/chat/latest_conversations' },
    { key: 'custom_service_info', pattern: '/janus/api/customService/queryCustomServiceInfo' },
    { key: 'userinfo_realtime', pattern: '/chats/userinfo/realtime' },
    { key: 'chat_list', pattern: '/plateau/chat/list' },
    { key: 'user_all_order', pattern: '/latitude/order/userAllOrder' },
    { key: 'recommend_goods', pattern: '/latitude/goods/recommendGoods' },
    { key: 'personal_phrases', pattern: '/tornado/quickReply/getAllQuickReplyWithOrder' },
    { key: 'team_phrases', pattern: '/tornado/phrase/getPhrase' },
    { key: 'mall_goods_card', pattern: '/plateau/message/send/mallGoodsCard' },
    { key: 'sync_message', pattern: '/plateau/sync/message' },
    { key: 'send_message', pattern: 'send_message' },
    { key: 'image_pre_upload', pattern: 'pre_upload' },
    { key: 'image_store', pattern: 'store_image' },
    { key: 'image_upload', pattern: 'image_upload' },
  ];
  const clientState = {
    antiContentHeader: null,
    topAntiContent: null,
    dataAntiContent: null,
    latestConversationsTemplate: null,
    chatListTemplate: null,
    userAllOrderTemplate: null,
    recommendGoodsTemplate: null,
    mallGoodsCardTemplate: null,
    syncTemplate: null,
    sendMessageTemplate: null,
    imagePreUploadTemplate: null,
    imageStoreTemplate: null,
    syncKeys: new Map(),
    seenSyncMessageIds: new Set(),
    syncPollTimer: null,
    syncPollInFlight: false,
    latestConversationsPollTimer: null,
    latestConversationsPollInFlight: false,
    internalRequestEndpoint: null,
    latestConversations: new Map(),
    imageUploadTargets: [],
    latestIdentity: null,
  };
  const normalizeUrlInPage = (value) => {
    try {
      return new URL(String(value || ''), location.href);
    } catch {
      return null;
    }
  };
  const sameUploadTargetInPage = (left, right) => {
    const leftUrl = normalizeUrlInPage(left);
    const rightUrl = normalizeUrlInPage(right);
    if (!leftUrl || !rightUrl) return false;
    return leftUrl.origin === rightUrl.origin && (
      leftUrl.pathname === rightUrl.pathname
      || leftUrl.href === rightUrl.href
      || rightUrl.href.startsWith(leftUrl.href)
    );
  };
  const endpointFromUrlInPage = (value) => {
    const url = String(value || '');
    const matched = endpoints.find((endpoint) => endpoint.key !== 'image_upload' && url.includes(endpoint.pattern));
    if (matched) return matched;
    if (clientState.imageUploadTargets.some((target) => sameUploadTargetInPage(target, url))) {
      return { key: 'image_upload', pattern: 'dynamic_image_upload' };
    }
    return null;
  };
  const parseJsonBodyInPage = (value) => {
    if (!value) return null;
    if (typeof value === 'string') {
      try { return JSON.parse(value); } catch { return null; }
    }
    if (value && typeof value === 'object' && !(value instanceof FormData) && !(value instanceof URLSearchParams)) return value;
    return null;
  };
  const textInPage = (value, limit = 2048) => {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const cleaned = String(value).replace(/\\s+/g, ' ').trim();
    return cleaned ? cleaned.slice(0, limit) : null;
  };
  const messageContentInPage = (value, limit = 4000) => {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const content = String(value);
    return content.length > 0 ? content.slice(0, limit) : null;
  };
  const antiContentFromHeadersInPage = (headers) => {
    try {
      if (!headers) return null;
      if (typeof headers.get === 'function') return textInPage(headers.get('anti-content'));
      if (Array.isArray(headers)) {
        const found = headers.find(([key]) => String(key).toLowerCase() === 'anti-content');
        return textInPage(found?.[1]);
      }
      if (typeof headers === 'object') return textInPage(headers['anti-content'] || headers['Anti-Content'] || headers['ANTI-CONTENT']);
    } catch {}
    return null;
  };
  const headersObjectInPage = (headers) => {
    const result = {};
    try {
      if (!headers) return result;
      if (typeof Headers !== 'undefined' && headers instanceof Headers) {
        headers.forEach((value, key) => { result[key] = value; });
        return result;
      }
      if (Array.isArray(headers)) {
        for (const [key, value] of headers) {
          if (typeof key === 'string') result[key] = value;
        }
        return result;
      }
      if (typeof headers === 'object') {
        for (const [key, value] of Object.entries(headers)) {
          if (typeof key === 'string') result[key] = value;
        }
      }
    } catch {}
    return result;
  };
  const headerValueInPage = (headers, name) => {
    const normalizedName = String(name || '').toLowerCase();
    const found = Object.entries(headersObjectInPage(headers)).find(([key]) => (
      String(key || '').toLowerCase() === normalizedName
    ));
    return textInPage(found?.[1], 256);
  };
  const cloneJsonInPage = (value) => {
    try {
      return value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : null;
    } catch {
      return null;
    }
  };
  const redactTemplateValueInPage = (key, value) => {
    const normalizedKey = String(key || '').toLowerCase();
    if (typeof value === 'string') {
      if (value.startsWith('data:image/')) {
        return { type: 'data_image', length: value.length };
      }
      if (/(anti|token|signature|secret|policy|authorization|cookie|credential)/i.test(normalizedKey)) {
        return value ? '[present]' : '';
      }
      return value.length > 256 ? { type: 'string', length: value.length, preview: value.slice(0, 120) } : value;
    }
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
    if (Array.isArray(value)) return { type: 'array', length: value.length };
    if (value && typeof value === 'object') return { type: 'object', keys: Object.keys(value).slice(0, 30) };
    return typeof value;
  };
  const jsonTemplateSummaryInPage = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 50)
        .map(([key, item]) => [key, redactTemplateValueInPage(key, item)]),
    );
  };
  const bodyByteLengthInPage = (value) => {
    if (!value) return 0;
    if (typeof value === 'string') return value.length;
    if (value instanceof Blob) return Number(value.size) || 0;
    if (value instanceof ArrayBuffer) return Number(value.byteLength) || 0;
    if (ArrayBuffer.isView(value)) return Number(value.byteLength) || 0;
    return 0;
  };
  const requestBodySummaryInPage = (body, parsedBody) => {
    if (!body && !parsedBody) return { body_kind: 'empty' };
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      const fieldNames = [];
      const fileFields = [];
      const textFields = [];
      for (const [name, value] of body.entries()) {
        const fieldName = textInPage(name, 128);
        if (fieldName) fieldNames.push(fieldName);
        if (value instanceof Blob) {
          fileFields.push({
            name: fieldName,
            size: Number(value.size) || 0,
            type: textInPage(value.type, 128),
            filename: textInPage(value.name, 256),
          });
        } else {
          textFields.push({
            name: fieldName,
            length: String(value ?? '').length,
            data_url: typeof value === 'string' && value.startsWith('data:image/'),
          });
        }
      }
      return {
        body_kind: 'form_data',
        field_names: [...new Set(fieldNames)].slice(0, 50),
        file_fields: fileFields.slice(0, 10),
        text_fields: textFields.slice(0, 20),
      };
    }
    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
      return {
        body_kind: 'url_search_params',
        field_names: [...new Set([...body.keys()].map((item) => textInPage(item, 128)).filter(Boolean))].slice(0, 50),
      };
    }
    if (typeof Blob !== 'undefined' && body instanceof Blob) {
      return {
        body_kind: 'blob',
        size: Number(body.size) || 0,
        type: textInPage(body.type, 128),
      };
    }
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
      return {
        body_kind: 'binary',
        byte_length: bodyByteLengthInPage(body),
      };
    }
    if (parsedBody && typeof parsedBody === 'object') {
      const data = parsedBody.data && typeof parsedBody.data === 'object' ? parsedBody.data : null;
      return {
        body_kind: 'json',
        top_keys: Object.keys(parsedBody).slice(0, 30),
        top_template: jsonTemplateSummaryInPage(parsedBody),
        data_keys: data ? Object.keys(data).slice(0, 30) : [],
        data_template: data ? jsonTemplateSummaryInPage(data) : null,
        cmd: textInPage(data?.cmd, 128),
        has_anti_content: Boolean(parsedBody.anti_content || data?.anti_content),
      };
    }
    if (typeof body === 'string') {
      return {
        body_kind: 'text',
        length: body.length,
        data_url: body.startsWith('data:image/'),
      };
    }
    return { body_kind: typeof body };
  };
  const captureApiResponseInPage = (endpoint, response) => {
    if (endpoint.key === 'custom_service_info' || endpoint.key === 'userinfo_realtime') {
      const identity = shopIdentityFromResponseInPage(response);
      if (identity) clientState.latestIdentity = identity;
      return;
    }
    if (endpoint.key === 'image_pre_upload') {
      for (const candidate of imageUploadTargetCandidatesInPage(response)) {
        if (!clientState.imageUploadTargets.some((target) => sameUploadTargetInPage(target, candidate))) {
          clientState.imageUploadTargets.push(candidate);
        }
      }
      if (clientState.imageUploadTargets.length > 20) {
        clientState.imageUploadTargets = clientState.imageUploadTargets.slice(-10);
      }
      return;
    }
    if (endpoint.key === 'sync_message') {
      captureSyncKeysFromResponseInPage(response);
      return;
    }
    if (endpoint.key !== 'latest_conversations') return;
    const conversations = Array.isArray(response?.result?.conversations)
      ? response.result.conversations
      : [];
    for (const conversation of conversations) {
      const uid = textInPage(
        conversation?.to?.role === 'user'
          ? conversation.to.uid
          : conversation?.from?.role === 'user' ? conversation.from.uid : conversation?.user_info?.uid,
        128,
      );
      if (!uid) continue;
      clientState.latestConversations.set(uid, {
        customerName: textInPage(conversation?.user_info?.nickname, 128),
        avatarUrl: textInPage(conversation?.user_info?.avatar, 1000),
        mallName: textInPage(conversation?.mallName, 128),
      });
    }
  };
  const walkJsonInPage = (value, visit, maxNodes = 300) => {
    const queue = [{ key: '', value }];
    const seen = new Set();
    let count = 0;
    while (queue.length && count < maxNodes) {
      const item = queue.shift();
      count += 1;
      if (visit(item.value, item.key)) return true;
      if (!item.value || typeof item.value !== 'object' || seen.has(item.value)) continue;
      seen.add(item.value);
      if (Array.isArray(item.value)) {
        for (let index = 0; index < item.value.length; index += 1) {
          queue.push({ key: String(index), value: item.value[index] });
        }
      } else {
        for (const [childKey, childValue] of Object.entries(item.value)) {
          queue.push({ key: childKey, value: childValue });
        }
      }
    }
    return false;
  };
  const imageUploadTargetCandidatesInPage = (response) => {
    const candidates = [];
    walkJsonInPage(response, (value, key) => {
      if (typeof value !== 'string') return false;
      if (!/(upload|host|url|endpoint|uri|action)/i.test(String(key || ''))) return false;
      const parsed = normalizeUrlInPage(value);
      if (!parsed) return false;
      if (!/(upload|image|img|file|chat|pdd|pddugc|pddpic)/i.test(parsed.href)) return false;
      candidates.push(parsed.href);
      return false;
    });
    return [...new Set(candidates)].slice(0, 10);
  };
  const firstImageUrlInPage = (value) => {
    let found = null;
    walkJsonInPage(value, (candidate) => {
      if (typeof candidate !== 'string') return false;
      const cleaned = candidate.trim();
      if (!/^https?:\/\//i.test(cleaned)) return false;
      if (!/(chat-img|pddugc|pddpic|\.jpe?g|\.png|\.webp)/i.test(cleaned)) return false;
      found = cleaned.slice(0, 1000);
      return true;
    });
    return found;
  };
  const responsePayloadFromTextInPage = (textValue, { ok, status, contentType }) => {
    const rawText = typeof textValue === 'string' ? textValue : '';
    let parsed = null;
    if (rawText.trim()) {
      try { parsed = JSON.parse(rawText); } catch { parsed = null; }
    }
    const metadata = {
      __http_status: Number(status) || 0,
      __content_type: textInPage(contentType, 256),
      __text_preview: rawText.slice(0, 1000),
    };
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ...parsed, ...metadata };
    }
    return {
      success: Boolean(ok),
      ...metadata,
    };
  };
  const responsePayloadFromFetchInPage = async (response) => {
    const contentType = textInPage(response.headers?.get?.('content-type'), 256) || '';
    try {
      const textValue = await response.clone().text();
      return responsePayloadFromTextInPage(textValue, {
        ok: response.ok,
        status: response.status,
        contentType,
      });
    } catch {
      return responsePayloadFromTextInPage('', {
        ok: response.ok,
        status: response.status,
        contentType,
      });
    }
  };
  const captureSyncKeysFromResponseInPage = (response) => {
    const syncData = Array.isArray(response?.result?.sync_data) ? response.result.sync_data : [];
    for (const item of syncData) {
      if (!Number.isFinite(Number(item?.seq_type)) || !Number.isFinite(Number(item?.seq_id))) continue;
      const seqType = Number(item.seq_type);
      const seqId = Number(item.seq_id);
      const previous = clientState.syncKeys.get(seqType);
      clientState.syncKeys.set(seqType, Math.max(Number(previous) || 0, seqId));
    }
  };
  const currentSyncKeysInPage = () => [...clientState.syncKeys.entries()]
    .map(([seqType, seqId]) => ({ seq_type: Number(seqType), seq_id: Number(seqId) }))
    .filter((item) => Number.isFinite(item.seq_type) && Number.isFinite(item.seq_id));
  const syncKeysFromResponseInPage = (response) => {
    const syncData = Array.isArray(response?.result?.sync_data) ? response.result.sync_data : [];
    return syncData
      .filter((item) => Number.isFinite(Number(item?.seq_type)) && Number.isFinite(Number(item?.seq_id)))
      .map((item) => ({ seq_type: Number(item.seq_type), seq_id: Number(item.seq_id) }));
  };
  const syncActivityFromResponseInPage = (response, previousSyncKeys = []) => {
    const previousByType = new Map(
      (Array.isArray(previousSyncKeys) ? previousSyncKeys : [])
        .filter((item) => Number.isFinite(Number(item?.seq_type)) && Number.isFinite(Number(item?.seq_id)))
        .map((item) => [Number(item.seq_type), Number(item.seq_id)]),
    );
    const responseSyncKeys = syncKeysFromResponseInPage(response);
    return {
      advanced: responseSyncKeys.some((item) => item.seq_id > (previousByType.get(item.seq_type) ?? -1)),
      responseSyncKeys,
      syncDataCount: Array.isArray(response?.result?.sync_data) ? response.result.sync_data.length : 0,
    };
  };
  const messageIdInPage = (message) => (
    textInPage(message?.msg_id, 128)
    || textInPage(message?.client_msg_id, 128)
  );
  const filterNewSyncMessagesInPage = (response) => {
    const clone = cloneJsonInPage(response);
    const syncData = Array.isArray(clone?.result?.sync_data) ? clone.result.sync_data : [];
    let inputMessageCount = 0;
    let outputMessageCount = 0;
    for (const item of syncData) {
      const wrappers = Array.isArray(item?.data) ? item.data : [];
      inputMessageCount += wrappers.length;
      item.data = wrappers.filter((wrapper) => {
        const id = messageIdInPage(wrapper?.message);
        if (!id) {
          outputMessageCount += 1;
          return true;
        }
        if (clientState.seenSyncMessageIds.has(id)) return false;
        clientState.seenSyncMessageIds.add(id);
        outputMessageCount += 1;
        return true;
      });
    }
    if (clientState.seenSyncMessageIds.size > 5000) {
      clientState.seenSyncMessageIds = new Set([...clientState.seenSyncMessageIds].slice(-2500));
    }
    return { response: clone, inputMessageCount, outputMessageCount };
  };
  const hasSyncGapInPage = (response) => {
    const syncData = Array.isArray(response?.result?.sync_data) ? response.result.sync_data : [];
    return syncData.some((item) => item?.has_gap || item?.reset_seq_id);
  };
  const requestContext = ({ endpoint, url, method, headers, body }) => {
    const parsedBody = parseJsonBodyInPage(body);
    const headerValue = antiContentFromHeadersInPage(headers);
    if (headerValue) clientState.antiContentHeader = headerValue;
    const topAntiContent = textInPage(parsedBody?.anti_content);
    const dataAntiContent = textInPage(parsedBody?.data?.anti_content);
    if (topAntiContent) clientState.topAntiContent = topAntiContent;
    if (dataAntiContent) clientState.dataAntiContent = dataAntiContent;
    if (endpoint?.key === 'chat_list') {
      clientState.chatListTemplate = {
        url: String(url || `${location.origin}/plateau/chat/list`),
        method: String(method || 'POST').toUpperCase(),
        headers: headersObjectInPage(headers),
        body: cloneJsonInPage(parsedBody),
      };
    }
    if (endpoint?.key === 'latest_conversations') {
      clientState.latestConversationsTemplate = {
        url: String(url || `${location.origin}/plateau/chat/latest_conversations`),
        method: String(method || 'POST').toUpperCase(),
        headers: headersObjectInPage(headers),
        body: cloneJsonInPage(parsedBody),
      };
    }
    if (endpoint?.key === 'user_all_order') {
      clientState.userAllOrderTemplate = {
        url: String(url || `${location.origin}/latitude/order/userAllOrder`),
        method: String(method || 'POST').toUpperCase(),
        headers: headersObjectInPage(headers),
        body: cloneJsonInPage(parsedBody),
      };
    }
    if (endpoint?.key === 'recommend_goods') {
      clientState.recommendGoodsTemplate = {
        url: String(url || `${location.origin}/latitude/goods/recommendGoods`),
        method: String(method || 'POST').toUpperCase(),
        headers: headersObjectInPage(headers),
        body: cloneJsonInPage(parsedBody),
      };
    }
    if (endpoint?.key === 'mall_goods_card') {
      clientState.mallGoodsCardTemplate = {
        url: String(url || `${location.origin}/plateau/message/send/mallGoodsCard`),
        method: String(method || 'POST').toUpperCase(),
        headers: headersObjectInPage(headers),
        body: cloneJsonInPage(parsedBody),
      };
    }
    if (endpoint?.key === 'sync_message') {
      clientState.syncTemplate = {
        url: String(url || `${location.origin}/plateau/sync/message`),
        method: String(method || 'POST').toUpperCase(),
        headers: headersObjectInPage(headers),
        body: cloneJsonInPage(parsedBody),
      };
    }
    if (endpoint?.key === 'send_message') {
      const messageType = Number(parsedBody?.data?.message?.type);
      const isImageSendMessage = messageType === 1 || Boolean(parsedBody?.data?.message?.size);
      if (isImageSendMessage) {
        clientState.sendImageMessageTemplate = {
          url: String(url || `${location.origin}/plateau/chat/send_message`),
          method: String(method || 'POST').toUpperCase(),
          headers: headersObjectInPage(headers),
          body: cloneJsonInPage(parsedBody),
        };
      } else {
      clientState.sendMessageTemplate = {
        url: String(url || `${location.origin}/plateau/chat/send_message`),
        method: String(method || 'POST').toUpperCase(),
        headers: headersObjectInPage(headers),
        body: cloneJsonInPage(parsedBody),
      };
      }
    }
    if (endpoint?.key === 'image_pre_upload') {
      clientState.imagePreUploadTemplate = {
        url: String(url || `${location.origin}/plateau/file/pre_upload`),
        method: String(method || 'POST').toUpperCase(),
        headers: headersObjectInPage(headers),
        body: cloneJsonInPage(parsedBody),
      };
    }
    if (endpoint?.key === 'image_store' || endpoint?.key === 'image_upload') {
      clientState.imageStoreTemplate = {
        url: String(url || 'https://file.pinduoduo.com/v2/store_image'),
        method: String(method || 'POST').toUpperCase(),
        headers: headersObjectInPage(headers),
        body: cloneJsonInPage(parsedBody),
      };
    }
    const requestSyncKeys = Array.isArray(parsedBody?.sync_key) ? parsedBody.sync_key : [];
    for (const syncKey of requestSyncKeys) {
      if (!Number.isFinite(Number(syncKey?.seq_type)) || !Number.isFinite(Number(syncKey?.seq_id))) continue;
      const seqType = Number(syncKey.seq_type);
      if (!clientState.syncKeys.has(seqType)) clientState.syncKeys.set(seqType, Number(syncKey.seq_id));
    }
    return {
      customerUid: textInPage(parsedBody?.data?.list?.with?.id, 128),
      requestSummary: {
        method: textInPage(method || 'POST', 16),
        content_type: headerValueInPage(headers, 'content-type'),
        ...requestBodySummaryInPage(body, parsedBody),
      },
      hasAntiContentBody: Boolean(topAntiContent || dataAntiContent),
      syncKeys: Array.isArray(parsedBody?.sync_key)
        ? parsedBody.sync_key
          .filter((item) => Number.isFinite(Number(item?.seq_type)) && Number.isFinite(Number(item?.seq_id)))
          .map((item) => ({ seq_type: Number(item.seq_type), seq_id: Number(item.seq_id) }))
          .slice(0, 5)
        : [],
      hasAntiContentHeader: Boolean(headerValue),
    };
  };
  const postApiShadow = (endpoint, url, request, response) => {
    if (endpoint.key === 'sync_message') {
      const syncActivity = syncActivityFromResponseInPage(response, request?.syncKeys);
      captureApiResponseInPage(endpoint, response);
      postSyncMessageResult(response, 'native', syncActivity);
      window.setTimeout(() => {
        try {
          startSyncPolling();
          void pollSyncMessage();
        } catch (error) {
          window.postMessage({
            source: 'pdd-api-client-result',
            payload: {
              endpoint: 'sync_message',
              resultSource: 'poll',
              status: 'failed',
              error: error?.message || String(error),
              diagnostics: {
                phase: 'native_sync_poll_trigger',
                sync_key_count: clientState.syncKeys.size,
              },
            },
          }, '*');
        }
      }, 0);
    } else {
      captureApiResponseInPage(endpoint, response);
    }
    window.postMessage({
      source: 'pdd-api-shadow',
      endpoint: endpoint.key,
      url,
      request: {
        customerUid: request?.customerUid,
        syncKeys: request?.syncKeys,
        requestSummary: request?.requestSummary,
      },
      runtime: {
        hasAntiContentHeader: Boolean(request?.hasAntiContentHeader),
        hasAntiContentBody: Boolean(request?.hasAntiContentBody),
      },
      response,
    }, '*');
  };
  const safeHeader = (headers, name) => {
    const found = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name);
    return textInPage(found?.[1], 2048);
  };
  const buildChatListRequest = ({ customerUid, size }) => {
    const template = clientState.chatListTemplate || {};
    const templateBody = cloneJsonInPage(template.body) || {};
    const body = templateBody && typeof templateBody === 'object' ? templateBody : {};
    body.client = body.client || 'WEB';
    if (clientState.topAntiContent) body.anti_content = clientState.topAntiContent;
    const data = body.data && typeof body.data === 'object' ? body.data : {};
    body.data = data;
    data.cmd = 'list';
    data.request_id = Date.now();
    data.notUpdateUnreplyTs = true;
    if (clientState.dataAntiContent || clientState.topAntiContent) {
      data.anti_content = clientState.dataAntiContent || clientState.topAntiContent;
    }
    const list = data.list && typeof data.list === 'object' ? data.list : {};
    data.list = list;
    list.with = { role: 'user', id: customerUid };
    list.start_msg_id = null;
    list.start_index = 0;
    const requestedSize = Math.max(1, Math.min(Number(size) || Number(list.size) || 50, 100));
    list.size = requestedSize;

    const templateHeaders = template.headers || {};
    const headers = {
      accept: safeHeader(templateHeaders, 'accept') || '*/*',
      'content-type': 'application/json',
    };
    if (clientState.antiContentHeader) headers['anti-content'] = clientState.antiContentHeader;
    return {
      url: template.url || `${location.origin}/plateau/chat/list`,
      init: {
        method: template.method || 'POST',
        headers,
        body: JSON.stringify(body),
        mode: 'cors',
        credentials: 'include',
      },
    };
  };
  const buildLatestConversationsRequest = ({ page, size }) => {
    const template = clientState.latestConversationsTemplate || {};
    const templateBody = cloneJsonInPage(template.body) || {};
    const body = templateBody && typeof templateBody === 'object' ? templateBody : {};
    body.client = body.client || 'WEB';
    if (clientState.topAntiContent) body.anti_content = clientState.topAntiContent;
    const data = body.data && typeof body.data === 'object' ? body.data : {};
    body.data = data;
    data.cmd = 'latest_conversations';
    data.request_id = Date.now();
    data.version = Number.isFinite(Number(data.version)) ? Number(data.version) : 2;
    data.need_unreply_time = data.need_unreply_time !== false;
    data.page = Math.max(1, Math.min(Number(page) || Number(data.page) || 1, 50));
    data.size = Math.max(1, Math.min(Number(size) || Number(data.size) || 100, 100));
    if (!Number.isFinite(Number(data.end_time))) data.end_time = Math.floor(Date.now() / 1000);
    if (clientState.dataAntiContent || clientState.topAntiContent) {
      data.anti_content = clientState.dataAntiContent || clientState.topAntiContent;
    }
    const templateHeaders = template.headers || {};
    const headers = {
      accept: safeHeader(templateHeaders, 'accept') || '*/*',
      'content-type': 'application/json',
    };
    if (clientState.antiContentHeader) headers['anti-content'] = clientState.antiContentHeader;
    return {
      url: template.url || `${location.origin}/plateau/chat/latest_conversations`,
      init: {
        method: template.method || 'POST',
        headers,
        body: JSON.stringify(body),
        mode: 'cors',
        credentials: 'include',
      },
    };
  };
  const buildCustomServiceInfoRequest = () => {
    const headers = {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json;charset=UTF-8',
    };
    if (clientState.antiContentHeader) headers['anti-content'] = clientState.antiContentHeader;
    return {
      url: `${location.origin}/janus/api/customService/queryCustomServiceInfo`,
      init: {
        method: 'POST',
        headers,
        body: JSON.stringify({
          needCustomServiceInfo: true,
          needMallInfo: true,
        }),
        mode: 'cors',
        credentials: 'include',
      },
    };
  };
  const buildRealtimeUserInfoRequest = () => {
    const headers = {
      accept: 'application/json, text/plain, */*',
    };
    if (clientState.antiContentHeader) headers['anti-content'] = clientState.antiContentHeader;
    return {
      url: `${location.origin}/chats/userinfo/realtime?get_response=true`,
      init: {
        method: 'GET',
        headers,
        mode: 'cors',
        credentials: 'include',
      },
    };
  };
  const shopIdentityFromResponseInPage = (response) => {
    const mallInfo = response?.result?.mallInfoResult && typeof response.result.mallInfoResult === 'object'
      ? response.result.mallInfoResult
      : null;
    const realtimeMall = response?.mall && typeof response.mall === 'object' ? response.mall : null;
    const accountName = textInPage(mallInfo?.mallName ?? realtimeMall?.mall_name, 128);
    const externalAccountId = textInPage(mallInfo?.mallId ?? realtimeMall?.mall_id ?? response?.mall_id, 128);
    const logoUrl = textInPage(mallInfo?.logo ?? realtimeMall?.logo, 1000);
    const serviceUsername = textInPage(response?.username, 128);
    const csId = textInPage(response?.cs_id, 128);
    const csUid = textInPage(response?.cs_uid, 256);
    if (!accountName && !externalAccountId) return null;
    return {
      accountName,
      externalAccountId,
      logoUrl,
      serviceUsername,
      csId,
      csUid,
      isMallOwner: response?.is_mall_owner === true,
    };
  };
  const shopInfoAttemptDiagnosticsInPage = (source, payload, status = null, error = null) => {
    const identity = payload && typeof payload === 'object' ? shopIdentityFromResponseInPage(payload) : null;
    return {
      source,
      http_status: Number.isFinite(Number(status)) ? Number(status) : null,
      success: payload?.success === true,
      error_code: textInPage(payload?.errorCode ?? payload?.error_code, 128),
      error_msg: textInPage(payload?.errorMsg ?? payload?.error_msg, 256),
      has_shop_identity: Boolean(identity),
      shop_name: identity?.accountName || null,
      mall_id_present: Boolean(identity?.externalAccountId),
      logo_present: Boolean(identity?.logoUrl),
      service_username_present: Boolean(identity?.serviceUsername),
      error: textInPage(error, 256),
    };
  };
  const requestShopInfoInPage = async ({ requestId, purpose }) => {
    const normalizedRequestId = typeof requestId === 'string'
      ? requestId.slice(0, 128)
      : `shop-info-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const normalizedPurpose = textInPage(purpose, 64) || 'identity';
    if (!clientState.antiContentHeader) {
      postApiClientResult({
        endpoint: 'shop_info',
        requestId: normalizedRequestId,
        purpose: normalizedPurpose,
        status: 'failed',
        error: 'runtime_anti_content_missing',
        diagnostics: {
          has_anti_content_header: Boolean(clientState.antiContentHeader),
        },
      });
      return false;
    }
    const attempts = [
      {
        endpointKey: 'custom_service_info',
        source: 'pdd_api_custom_service_info',
        build: buildCustomServiceInfoRequest,
      },
      {
        endpointKey: 'userinfo_realtime',
        source: 'pdd_api_userinfo_realtime',
        build: buildRealtimeUserInfoRequest,
      },
    ];
    const diagnostics = [];
    let lastPayload = null;
    let lastError = null;
    for (const attempt of attempts) {
      try {
        const { url, init } = attempt.build();
        clientState.internalRequestEndpoint = attempt.endpointKey;
        const response = await window.fetch(url, init);
        clientState.internalRequestEndpoint = null;
        const payload = await response.json();
        captureApiResponseInPage({ key: attempt.endpointKey }, payload);
        lastPayload = payload;
        const identity = shopIdentityFromResponseInPage(payload);
        diagnostics.push(shopInfoAttemptDiagnosticsInPage(attempt.source, payload, response.status));
        if (response.ok && identity) {
          postApiClientResult({
            endpoint: 'shop_info',
            requestId: normalizedRequestId,
            purpose: normalizedPurpose,
            status: 'collected',
            source: attempt.source,
            response: payload,
            diagnostics: {
              attempts: diagnostics,
              has_anti_content_header: true,
              shop_name: identity.accountName || null,
              mall_id_present: Boolean(identity.externalAccountId),
              logo_present: Boolean(identity.logoUrl),
              service_username_present: Boolean(identity.serviceUsername),
            },
            error: null,
          });
          return true;
        }
      } catch (error) {
        clientState.internalRequestEndpoint = null;
        lastError = error?.message || String(error);
        diagnostics.push(shopInfoAttemptDiagnosticsInPage(attempt.source, null, null, lastError));
      }
    }
    postApiClientResult({
      endpoint: 'shop_info',
      requestId: normalizedRequestId,
      purpose: normalizedPurpose,
      status: 'failed',
      source: null,
      response: lastPayload && typeof lastPayload === 'object' ? lastPayload : null,
      diagnostics: {
        attempts: diagnostics,
        has_anti_content_header: true,
      },
      error: lastError || 'shop_identity_missing',
    });
    return false;
  };
  const buildUserAllOrderRequest = ({ customerUid, page, size }) => {
    const template = clientState.userAllOrderTemplate || {};
    const templateBody = cloneJsonInPage(template.body) || {};
    const body = templateBody && typeof templateBody === 'object' ? templateBody : {};
    body.pageNo = Math.max(1, Math.min(Number(page) || Number(body.pageNo) || 1, 100));
    body.pageSize = Math.max(1, Math.min(Number(size) || Number(body.pageSize) || 10, 100));
    body.showHistory = body.showHistory !== false;
    body.uid = customerUid;
    const templateHeaders = template.headers || {};
    const headers = {
      accept: safeHeader(templateHeaders, 'accept') || '*/*',
      'content-type': 'application/json',
    };
    if (clientState.antiContentHeader) headers['anti-content'] = clientState.antiContentHeader;
    return {
      url: template.url || `${location.origin}/latitude/order/userAllOrder`,
      init: {
        method: template.method || 'POST',
        headers,
        body: JSON.stringify(body),
        mode: 'cors',
        credentials: 'include',
      },
    };
  };
  const buildRecommendGoodsRequest = ({ customerUid, page, size }) => {
    const template = clientState.recommendGoodsTemplate || {};
    const templateBody = cloneJsonInPage(template.body) || {};
    const body = templateBody && typeof templateBody === 'object' ? templateBody : {};
    body.uid = customerUid || '';
    body.pageNum = Math.max(1, Math.min(Number(page) || Number(body.pageNum) || 1, 100));
    body.pageSize = Math.max(1, Math.min(Number(size) || Number(body.pageSize) || 10, 100));
    const templateHeaders = template.headers || {};
    const headers = {
      accept: safeHeader(templateHeaders, 'accept') || 'application/json, text/plain, */*',
      'content-type': 'application/json;charset=UTF-8',
    };
    if (clientState.antiContentHeader) headers['anti-content'] = clientState.antiContentHeader;
    return {
      url: template.url || `${location.origin}/latitude/goods/recommendGoods`,
      init: {
        method: template.method || 'POST',
        headers,
        body: JSON.stringify(body),
        mode: 'cors',
        credentials: 'include',
      },
    };
  };
  const buildPlatformPhraseRequest = ({ source }) => {
    const normalizedSource = source === 'team' ? 'team' : 'personal';
    const endpointKey = normalizedSource === 'team' ? 'team_phrases' : 'personal_phrases';
    const headers = {
      accept: 'application/json, text/plain, */*',
    };
    if (clientState.antiContentHeader) headers['anti-content'] = clientState.antiContentHeader;
    return {
      endpointKey,
      url: normalizedSource === 'team'
        ? `${location.origin}/tornado/phrase/getPhrase`
        : `${location.origin}/tornado/quickReply/getAllQuickReplyWithOrder`,
      init: {
        method: 'GET',
        headers,
        mode: 'cors',
        credentials: 'include',
      },
    };
  };
  const fetchJsonWithTimeoutInPage = async (url, init = {}, timeoutMs = 10000) => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      try {
        controller.abort(new Error('request_timeout'));
      } catch {
        controller.abort();
      }
    }, timeoutMs);
    try {
      const response = await window.fetch(url, { ...init, signal: controller.signal });
      const textValue = await response.clone().text();
      let payload = null;
      try {
        payload = textValue ? JSON.parse(textValue) : null;
      } catch {
        payload = null;
      }
      return {
        response,
        payload,
        textPreview: textInPage(textValue, 1000),
      };
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`request_timeout_${timeoutMs}ms`);
      throw error;
    } finally {
      window.clearTimeout(timer);
    }
  };
  const normalizePlatformPhraseImagesInPage = (images) => (
    Array.isArray(images)
      ? images.map((image) => ({
        url: textInPage(image?.url, 1000) || '',
        width: Number.isFinite(Number(image?.width)) ? Number(image.width) : null,
        height: Number.isFinite(Number(image?.height)) ? Number(image.height) : null,
        image_size: Number.isFinite(Number(image?.imageSize ?? image?.image_size))
          ? Number(image.imageSize ?? image.image_size)
          : null,
      })).filter((image) => image.url)
      : []
  );
  const normalizePlatformPhrasesInPage = (payload, source) => {
    const records = [];
    if (source === 'team') {
      const result = payload?.result || {};
      const groupNames = new Map((Array.isArray(result.groupList) ? result.groupList : [])
        .map((group) => [String(group?.id ?? group?.groupId ?? ''), textInPage(group?.groupName, 128)]));
      for (const phrase of Array.isArray(result.phraseList) ? result.phraseList : []) {
        const content = textInPage(phrase?.content, 4000);
        if (!content) continue;
        const groupId = String(phrase?.groupId ?? '');
        records.push({
          source_id: `pdd-team:${textInPage(phrase?.id, 128) || `${groupId}:${records.length}`}`,
          category: groupNames.get(groupId) || textInPage(phrase?.groupName, 128) || '',
          quick_key: textInPage(phrase?.quickKey, 128) || '',
          content,
          images: normalizePlatformPhraseImagesInPage(phrase?.imageInfoList),
        });
      }
      return records;
    }
    const groups = payload?.result?.chatReplyGroupList;
    for (const group of Array.isArray(groups) ? groups : []) {
      const category = textInPage(group?.groupName, 128);
      const groupId = textInPage(group?.groupId ?? group?.id, 128);
      for (const item of Array.isArray(group?.quickReplyList) ? group.quickReplyList : []) {
        const content = textInPage(item?.content, 4000);
        if (!content) continue;
        records.push({
          source_id: `pdd-personal:${textInPage(item?.id, 128) || `${groupId}:${records.length}`}`,
          category: category || '',
          quick_key: textInPage(item?.quickKey, 128) || '',
          content,
          images: normalizePlatformPhraseImagesInPage(item?.imageInfoList),
        });
      }
    }
    return records;
  };
  const recommendGoodsPageItemsInPage = (payload) => {
    const result = payload?.result || {};
    return [
      ...(Array.isArray(result.recommendGoods) ? result.recommendGoods : []),
      ...(Array.isArray(result.todayBrowseGoods) ? result.todayBrowseGoods : []),
      ...(Array.isArray(result.historyBrowseGoods) ? result.historyBrowseGoods : []),
      ...(Array.isArray(result.onSaleGoods) ? result.onSaleGoods : []),
    ];
  };
  const mergeRecommendGoodsResponsesInPage = (pages, { pageSize, maxPagesReached }) => {
    const first = pages[0]?.payload || {};
    const firstResult = first?.result && typeof first.result === 'object' ? first.result : {};
    const mergedResult = {
      ...firstResult,
      returnDiscount: [],
      reduceDiscount: [],
      todayBrowseGoods: [],
      recommendGoods: [],
      historyBrowseGoods: [],
      onSaleGoods: [],
      headGoods: firstResult.headGoods || null,
      pageNum: 1,
      pageSize,
      page_count: pages.length,
    };
    let total = Number.isFinite(Number(firstResult.total)) ? Number(firstResult.total) : null;
    let lastPageItemCount = 0;
    for (const page of pages) {
      const result = page.payload?.result && typeof page.payload.result === 'object' ? page.payload.result : {};
      if (total === null && Number.isFinite(Number(result.total))) total = Number(result.total);
      const append = (key) => {
        if (Array.isArray(result[key])) mergedResult[key].push(...result[key]);
      };
      append('returnDiscount');
      append('reduceDiscount');
      append('todayBrowseGoods');
      append('recommendGoods');
      append('historyBrowseGoods');
      append('onSaleGoods');
      lastPageItemCount = recommendGoodsPageItemsInPage(page.payload).length;
    }
    const mergedItemCount = recommendGoodsPageItemsInPage({ result: mergedResult }).length;
    const hasMoreByTotal = total !== null && mergedItemCount < total;
    const hasMoreByPageSize = total === null && lastPageItemCount >= pageSize;
    mergedResult.total = total ?? mergedItemCount;
    mergedResult.has_more = Boolean(hasMoreByTotal || (maxPagesReached && hasMoreByPageSize));
    return {
      ...first,
      result: mergedResult,
    };
  };
  const buildMallGoodsCardRequest = ({ customerUid, productId }) => {
    const template = clientState.mallGoodsCardTemplate || {};
    const templateBody = cloneJsonInPage(template.body) || {};
    const body = templateBody && typeof templateBody === 'object' ? templateBody : {};
    body.uid = customerUid;
    body.goods_id = Number.isFinite(Number(productId)) ? Number(productId) : productId;
    body.biz_type = Number.isFinite(Number(body.biz_type)) ? Number(body.biz_type) : 3;
    const templateHeaders = template.headers || {};
    const headers = {
      accept: safeHeader(templateHeaders, 'accept') || 'application/json, text/plain, */*',
      'content-type': 'application/json;charset=UTF-8',
    };
    if (clientState.antiContentHeader) headers['anti-content'] = clientState.antiContentHeader;
    return {
      url: template.url || `${location.origin}/plateau/message/send/mallGoodsCard`,
      init: {
        method: template.method || 'POST',
        headers,
        body: JSON.stringify(body),
        mode: 'cors',
        credentials: 'include',
      },
    };
  };
  const buildSyncMessageRequest = () => {
    const template = clientState.syncTemplate || {};
    const templateBody = cloneJsonInPage(template.body) || {};
    const body = templateBody && typeof templateBody === 'object' ? templateBody : {};
    if (clientState.topAntiContent) body.anti_content = clientState.topAntiContent;
    const syncEntries = clientState.syncKeys.size > 0
      ? [...clientState.syncKeys.entries()]
      : [[1, 0]];
    body.sync_key = syncEntries
      .sort(([left], [right]) => left - right)
      .map(([seqType, seqId]) => ({ seq_id: seqId, seq_type: seqType }));
    const templateHeaders = template.headers || {};
    const headers = {
      accept: safeHeader(templateHeaders, 'accept') || '*/*',
      'content-type': 'application/json',
    };
    if (clientState.antiContentHeader) headers['anti-content'] = clientState.antiContentHeader;
    return {
      url: template.url || `${location.origin}/plateau/sync/message`,
      init: {
        method: template.method || 'POST',
        headers,
        body: JSON.stringify(body),
        mode: 'cors',
        credentials: 'include',
      },
    };
  };
  const randomHexInPage = (byteLength = 16) => {
    const bytes = new Uint8Array(byteLength);
    crypto.getRandomValues(bytes);
    return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  };
  const sha256HexInPage = async (value) => {
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  };
  const bytesFromBase64InPage = (base64) => {
    const binary = atob(String(base64 || ''));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  };
  const sha256HexBytesInPage = async (bytes) => {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  };
  const imageDimensionsInPage = (dataUrl) => new Promise((resolve) => {
    const image = new Image();
    const cleanup = () => {
      image.onload = null;
      image.onerror = null;
    };
    image.onload = () => {
      const width = Number(image.naturalWidth || image.width) || null;
      const height = Number(image.naturalHeight || image.height) || null;
      cleanup();
      resolve({ width, height });
    };
    image.onerror = () => {
      cleanup();
      resolve({ width: null, height: null });
    };
    image.src = dataUrl;
  });
  const imageDataInPage = async (imageDataUrl) => {
    const match = String(imageDataUrl || '').trim().match(/^data:image\/(png|jpeg|jpg|webp);base64,([a-z0-9+/=\s]+)$/i);
    if (!match) return null;
    const mimeType = `image/${match[1].toLowerCase() === 'jpg' ? 'jpeg' : match[1].toLowerCase()}`;
    const base64Payload = match[2].replace(/\s+/g, '');
    const normalizedDataUrl = `data:${mimeType};base64,${base64Payload}`;
    const bytes = bytesFromBase64InPage(base64Payload);
    const dimensions = await imageDimensionsInPage(normalizedDataUrl);
    return {
      dataUrl: normalizedDataUrl,
      mimeType,
      byteSize: bytes.byteLength,
      imageSizeKb: Math.max(1, Math.ceil(bytes.byteLength / 1024)),
      hash: await sha256HexBytesInPage(bytes),
      width: dimensions.width,
      height: dimensions.height,
    };
  };
  const buildImagePreUploadRequest = () => {
    const template = clientState.imagePreUploadTemplate || {};
    const templateBody = cloneJsonInPage(template.body) || {};
    const body = templateBody && typeof templateBody === 'object' ? templateBody : {};
    body.chat_type_id = Number(body.chat_type_id) || 1;
    body.file_usage = Number(body.file_usage) || 1;
    const templateHeaders = template.headers || {};
    const headers = {
      accept: safeHeader(templateHeaders, 'accept') || '*/*',
      'content-type': 'application/json',
    };
    if (clientState.antiContentHeader) headers['anti-content'] = clientState.antiContentHeader;
    return {
      url: template.url || `${location.origin}/plateau/file/pre_upload`,
      init: {
        method: template.method || 'POST',
        headers,
        body: JSON.stringify(body),
        mode: 'cors',
        credentials: 'include',
      },
    };
  };
  const buildImageStoreRequest = ({ uploadUrl, uploadSignature, imageDataUrl }) => {
    const template = clientState.imageStoreTemplate || {};
    const templateHeaders = template.headers || {};
    const headers = {
      accept: safeHeader(templateHeaders, 'accept') || '*/*',
      'content-type': 'application/json',
    };
    if (clientState.antiContentHeader) headers['anti-content'] = clientState.antiContentHeader;
    return {
      url: uploadUrl || template.url || 'https://file.pinduoduo.com/v2/store_image',
      init: {
        method: template.method || 'POST',
        headers,
        body: JSON.stringify({
          image: imageDataUrl,
          upload_sign: uploadSignature,
        }),
        mode: 'cors',
        credentials: 'include',
      },
    };
  };
  const uploadImageToPdd = async ({ imageDataUrl }) => {
    const imageData = await imageDataInPage(imageDataUrl);
    if (!imageData) throw new Error('image_data_url_invalid');
    const { url: preUploadUrl, init: preUploadInit } = buildImagePreUploadRequest();
    clientState.internalRequestEndpoint = 'image_pre_upload';
    const preUploadResponse = await window.fetch(preUploadUrl, preUploadInit);
    clientState.internalRequestEndpoint = null;
    if (!preUploadResponse.ok) throw new Error(`pre_upload_http_${preUploadResponse.status}`);
    const preUploadPayload = await preUploadResponse.json();
    captureApiResponseInPage({ key: 'image_pre_upload' }, preUploadPayload);
    const uploadSignature = textInPage(preUploadPayload?.result?.upload_signature, 4096);
    const uploadUrl = textInPage(preUploadPayload?.result?.upload_url, 1000)
      || textInPage(preUploadPayload?.result?.upload_host, 1000);
    if (preUploadPayload?.success !== true || !uploadSignature || !uploadUrl) {
      throw new Error('pre_upload_response_invalid');
    }
    const { url: storeUrl, init: storeInit } = buildImageStoreRequest({
      uploadUrl,
      uploadSignature,
      imageDataUrl: imageData.dataUrl,
    });
    clientState.internalRequestEndpoint = 'image_upload';
    const storeResponse = await window.fetch(storeUrl, storeInit);
    clientState.internalRequestEndpoint = null;
    if (!storeResponse.ok) throw new Error(`store_image_http_${storeResponse.status}`);
    const storePayload = await storeResponse.json();
    captureApiResponseInPage({ key: 'image_upload' }, storePayload);
    const imageUrl = textInPage(storePayload?.url || storePayload?.result?.url || firstImageUrlInPage(storePayload), 1000);
    if (!imageUrl) throw new Error('store_image_response_missing_url');
    return {
      imageUrl,
      width: Number(storePayload?.width || storePayload?.result?.width) || imageData.width || null,
      height: Number(storePayload?.height || storePayload?.result?.height) || imageData.height || null,
      hash: textInPage(storePayload?.hash || storePayload?.result?.hash, 128) || imageData.hash,
      byteSize: imageData.byteSize,
      imageSizeKb: imageData.imageSizeKb,
      thumbData: imageData.dataUrl,
      uploadBucketTag: textInPage(preUploadPayload?.result?.upload_bucket_tag, 128),
    };
  };
  const buildSendMessageRequest = async ({ customerUid, content, quoteMessageId = null }) => {
    const template = clientState.sendMessageTemplate || {};
    const templateBody = cloneJsonInPage(template.body) || {};
    const body = templateBody && typeof templateBody === 'object' ? templateBody : {};
    body.client = body.client || 'WEB';
    if (clientState.topAntiContent) body.anti_content = clientState.topAntiContent;
    const data = body.data && typeof body.data === 'object' ? body.data : {};
    body.data = data;
    data.cmd = 'send_message';
    data.request_id = Date.now();
    if (clientState.dataAntiContent || clientState.topAntiContent) {
      data.anti_content = clientState.dataAntiContent || clientState.topAntiContent;
    }
    data.random = randomHexInPage(16);
    const normalizedQuoteMessageId = textInPage(quoteMessageId, 128);
    if (normalizedQuoteMessageId) data.quote_msg_id = normalizedQuoteMessageId;
    else if ('quote_msg_id' in data) delete data.quote_msg_id;
    const nowSeconds = Math.floor(Date.now() / 1000);
    const message = data.message && typeof data.message === 'object' ? data.message : {};
    data.message = message;
    message.to = { role: 'user', uid: customerUid };
    message.from = message.from && typeof message.from === 'object'
      ? { ...message.from, role: message.from.role || 'mall_cs' }
      : { role: 'mall_cs' };
    message.ts = nowSeconds;
    message.content = content;
    message.msg_id = null;
    message.type = 0;
    message.is_aut = 0;
    message.manual_reply = 1;
    message.status = 'read';
    message.is_read = 1;
    message.hash = await sha256HexInPage(content);
    delete message.size;
    delete message.info;
    delete message.media;
    delete message.image;
    delete message.image_url;
    delete message.width;
    delete message.height;
    delete message.image_size;
    delete message.thumb_data;

    const templateHeaders = template.headers || {};
    const headers = {
      accept: safeHeader(templateHeaders, 'accept') || '*/*',
      'content-type': 'application/json',
    };
    if (clientState.antiContentHeader) headers['anti-content'] = clientState.antiContentHeader;
    return {
      url: template.url || `${location.origin}/plateau/chat/send_message`,
      init: {
        method: template.method || 'POST',
        headers,
        body: JSON.stringify(body),
        mode: 'cors',
        credentials: 'include',
      },
    };
  };
  const buildAssignCsListRequest = () => {
    const headers = {
      accept: '*/*',
      'content-type': 'application/json',
    };
    if (clientState.antiContentHeader) headers['anti-content'] = clientState.antiContentHeader;
    return {
      url: `${location.origin}/latitude/assign/getAssignCsList`,
      init: {
        method: 'POST',
        headers,
        body: JSON.stringify({ wechatCheck: true }),
        mode: 'cors',
        credentials: 'include',
      },
    };
  };
  const buildMoveConversationRequest = ({ customerUid, csid, transReason }) => {
    const body = {
      data: {
        cmd: 'move_conversation',
        request_id: Date.now(),
        conversation: {
          csid,
          uid: customerUid,
          chat_type: 'cs',
          need_wx: false,
          remark: transReason || '无原因直接转移',
        },
      },
      client: 'WEB',
    };
    if (clientState.topAntiContent) body.anti_content = clientState.topAntiContent;
    if (clientState.dataAntiContent || clientState.topAntiContent) {
      body.data.anti_content = clientState.dataAntiContent || clientState.topAntiContent;
    }
    const headers = {
      accept: '*/*',
      'content-type': 'application/json',
    };
    if (clientState.antiContentHeader) headers['anti-content'] = clientState.antiContentHeader;
    return {
      url: `${location.origin}/plateau/chat/move_conversation`,
      init: {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        mode: 'cors',
        credentials: 'include',
      },
    };
  };
  const mapTransferCsListInPage = (csList) => Object.entries(csList && typeof csList === 'object' ? csList : {})
    .map(([csid, item]) => {
      const source = item && typeof item === 'object' ? item : {};
      return {
        csid: textInPage(csid, 128),
        accountName: textInPage(source.username || source.accountName || source.account_name, 128),
        username: textInPage(source.username || source.accountName || source.account_name, 128),
        nickname: textInPage(source.nickname || source.nickName || source.nick_name, 128),
        remark: textInPage(source.remark || source.memo || source.note, 128),
        unreplyNum: Number(source.unreplyNum ?? source.unreply_num ?? source.unReplyNum ?? 0) || 0,
        recvUser: Number.isFinite(Number(source.recvUser ?? source.recv_user))
          ? Number(source.recvUser ?? source.recv_user)
          : null,
        bindWechat: Boolean(source.bindWechat ?? source.bind_wechat ?? source.wechatBind),
        id: textInPage(source.id, 128),
        csUid: textInPage(source.csUid || source.cs_uid || source.uid, 256),
      };
    })
    .filter((entry) => entry.csid);
  const mapTransferReasonsInPage = (transReason) => {
    const reasons = [];
    const append = (code, value) => {
      const desc = textInPage(typeof value === 'object' && value ? value.desc || value.name || value.label || value.reason : value, 128);
      if (!desc) return;
      reasons.push({
        code: textInPage(typeof value === 'object' && value ? value.code ?? value.id ?? code : code, 128) || null,
        desc,
      });
    };
    if (Array.isArray(transReason)) {
      transReason.forEach((item, index) => append(index, item));
    } else if (transReason && typeof transReason === 'object') {
      Object.entries(transReason).forEach(([code, value]) => append(code, value));
    }
    if (!reasons.some((reason) => reason.desc === '无原因直接转移')) {
      reasons.unshift({ code: null, desc: '无原因直接转移' });
    }
    return reasons;
  };
  const normalizedTransferIdentityInPage = (value, limit = 256) => (
    textInPage(value, limit)?.toLocaleLowerCase() || ''
  );
  const isCurrentTransferCsInPage = (entry) => {
    const identity = clientState.latestIdentity || null;
    if (!identity || !entry) return false;
    const currentCsId = normalizedTransferIdentityInPage(identity.csId, 128);
    const currentCsUid = normalizedTransferIdentityInPage(identity.csUid, 256);
    const currentUsername = normalizedTransferIdentityInPage(identity.serviceUsername, 128);
    const entryCsIds = [
      normalizedTransferIdentityInPage(entry.csid, 128),
      normalizedTransferIdentityInPage(entry.id, 128),
    ].filter(Boolean);
    const entryCsUid = normalizedTransferIdentityInPage(entry.csUid, 256);
    const entryUsernames = [
      normalizedTransferIdentityInPage(entry.username, 128),
      normalizedTransferIdentityInPage(entry.accountName, 128),
    ].filter(Boolean);
    return Boolean(
      (currentCsId && entryCsIds.includes(currentCsId))
      || (currentCsUid && entryCsUid === currentCsUid)
      || (currentUsername && entryUsernames.includes(currentUsername))
    );
  };
  const chooseTransferCsInPage = (csList) => {
    const entries = mapTransferCsListInPage(csList).filter((entry) => !isCurrentTransferCsInPage(entry));
    const receivable = entries.filter((entry) => Number(entry.recvUser) === 1);
    const candidates = receivable.length ? receivable : entries;
    if (!candidates.length) return null;
    const selected = candidates[Math.floor(Math.random() * candidates.length)];
    return {
      csid: selected.csid,
      username: selected.username,
      nickname: selected.nickname,
      id: selected.id,
    };
  };
  const buildSendImageMessageRequest = async ({
    customerUid,
    imageUrl,
    width,
    height,
    imageSizeKb,
    imageHash,
    thumbData,
    quoteMessageId = null,
  }) => {
    const originalTextTemplate = clientState.sendMessageTemplate;
    let request;
    try {
      if (clientState.sendImageMessageTemplate) {
        clientState.sendMessageTemplate = clientState.sendImageMessageTemplate;
      }
      request = await buildSendMessageRequest({ customerUid, content: imageUrl, quoteMessageId });
    } finally {
      clientState.sendMessageTemplate = originalTextTemplate;
    }
    const { url, init } = request;
    const body = parseJsonBodyInPage(init.body) || {};
    const message = body?.data?.message;
    if (!message || typeof message !== 'object') throw new Error('send_message_template_invalid');
    message.type = 1;
    message.content = imageUrl;
    message.hash = imageHash || await sha256HexInPage(imageUrl);
    message.size = {
      height: Number(height) || 0,
      width: Number(width) || 0,
      image_size: Math.max(1, Number(imageSizeKb) || 1),
    };
    message.info = {
      thumb_data: thumbData || null,
    };
    init.body = JSON.stringify(body);
    return { url, init };
  };
  const requestLatestConversationsInPage = async ({
    requestId,
    purpose,
    page,
    size,
  }) => {
    const normalizedRequestId = typeof requestId === 'string'
      ? requestId.slice(0, 128)
      : `latest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const normalizedPurpose = textInPage(purpose, 64) || 'import-candidates';
    if (!clientState.antiContentHeader || (!clientState.topAntiContent && !clientState.dataAntiContent)) {
      postApiClientResult({
        endpoint: 'latest_conversations',
        requestId: normalizedRequestId,
        purpose: normalizedPurpose,
        status: 'failed',
        error: 'runtime_anti_content_missing',
        diagnostics: {
          has_anti_content_header: Boolean(clientState.antiContentHeader),
          has_anti_content_body: Boolean(clientState.topAntiContent || clientState.dataAntiContent),
        },
      });
      return false;
    }
    try {
      const { url, init } = buildLatestConversationsRequest({ page, size });
      const response = await window.fetch(url, init);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      captureApiResponseInPage({ key: 'latest_conversations' }, payload);
      const collected = payload?.success === true && payload?.result?.result === 'ok';
      const conversations = Array.isArray(payload?.result?.conversations)
        ? payload.result.conversations
        : [];
      const shopIdentityCount = conversations.filter((conversation) => (
        textInPage(conversation?.mallName, 128)
        || textInPage(conversation?.from?.mall_id ?? conversation?.to?.mall_id ?? conversation?.mall_id, 128)
      )).length;
      postApiClientResult({
        endpoint: 'latest_conversations',
        requestId: normalizedRequestId,
        purpose: normalizedPurpose,
        status: collected ? 'collected' : 'failed',
        response: payload,
        diagnostics: {
          conversation_count: conversations.length,
          has_shop_identity: shopIdentityCount > 0,
          shop_identity_count: shopIdentityCount,
          has_more: Boolean(payload?.result?.has_more),
          page: Number.isFinite(Number(payload?.result?.page)) ? Number(payload.result.page) : null,
          size: Number.isFinite(Number(payload?.result?.size)) ? Number(payload.result.size) : null,
        },
        error: collected ? null : 'pdd_response_not_ok',
      });
      return collected;
    } catch (error) {
      postApiClientResult({
        endpoint: 'latest_conversations',
        requestId: normalizedRequestId,
        purpose: normalizedPurpose,
        status: 'failed',
        error: error?.message || String(error),
      });
      return false;
    }
  };
  const syncReady = () => (
    Boolean(clientState.antiContentHeader && (clientState.topAntiContent || clientState.dataAntiContent))
  );
  const postSyncMessageResult = (response, resultSource, syncActivity = null) => {
    const filtered = filterNewSyncMessagesInPage(response);
    const hasSyncGap = hasSyncGapInPage(filtered.response);
    const syncAdvanced = Boolean(syncActivity?.advanced);
    if (filtered.outputMessageCount <= 0 && !hasSyncGap && !syncAdvanced) return;
    window.postMessage({
      source: 'pdd-api-client-result',
      payload: {
        endpoint: 'sync_message',
        resultSource,
        status: 'synced',
        response: filtered.response,
        diagnostics: {
          input_message_count: filtered.inputMessageCount,
          message_count: filtered.outputMessageCount,
          sync_key_count: clientState.syncKeys.size,
          bootstrap: clientState.syncKeys.size === 0,
          has_gap: hasSyncGap,
          sync_advanced: syncAdvanced,
          sync_data_count: Number(syncActivity?.syncDataCount) || 0,
          response_sync_keys: Array.isArray(syncActivity?.responseSyncKeys)
            ? syncActivity.responseSyncKeys.slice(0, 5)
            : [],
        },
      },
    }, '*');
  };
  const pollSyncMessage = async () => {
    if (clientState.syncPollInFlight || !syncReady()) return;
    clientState.syncPollInFlight = true;
    try {
      const previousSyncKeys = currentSyncKeysInPage();
      const { url, init } = buildSyncMessageRequest();
      clientState.internalRequestEndpoint = 'sync_message';
      const response = await window.fetch(url, init);
      clientState.internalRequestEndpoint = null;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      const syncActivity = syncActivityFromResponseInPage(payload, previousSyncKeys);
      captureSyncKeysFromResponseInPage(payload);
      postSyncMessageResult(payload, 'poll', syncActivity);
    } catch (error) {
      window.postMessage({
        source: 'pdd-api-client-result',
        payload: {
          endpoint: 'sync_message',
          resultSource: 'poll',
          status: 'failed',
          error: error?.message || String(error),
          diagnostics: {
            has_anti_content_header: Boolean(clientState.antiContentHeader),
            has_anti_content_body: Boolean(clientState.topAntiContent),
            sync_key_count: clientState.syncKeys.size,
          },
        },
      }, '*');
    } finally {
      clientState.internalRequestEndpoint = null;
      clientState.syncPollInFlight = false;
    }
  };
  const startSyncPolling = () => {
    if (clientState.syncPollTimer) return;
    clientState.syncPollTimer = window.setInterval(() => {
      void pollSyncMessage();
    }, syncPollIntervalMs);
    void pollSyncMessage();
  };
  const stopSyncPolling = () => {
    if (!clientState.syncPollTimer) return;
    window.clearInterval(clientState.syncPollTimer);
    clientState.syncPollTimer = null;
  };
  const pollLatestConversations = async () => {
    if (clientState.latestConversationsPollInFlight) return;
    clientState.latestConversationsPollInFlight = true;
    try {
      await requestLatestConversationsInPage({
        requestId: `latest-unread-poll-${Date.now().toString(36)}`,
        purpose: 'latest-unread-poll',
        page: 1,
        size: 100,
      });
    } finally {
      clientState.latestConversationsPollInFlight = false;
    }
  };
  const startLatestConversationsPolling = () => {
    if (clientState.latestConversationsPollTimer) return;
    clientState.latestConversationsPollTimer = window.setInterval(() => {
      void pollLatestConversations();
    }, latestConversationsPollIntervalMs);
    void pollLatestConversations();
  };
  const stopLatestConversationsPolling = () => {
    if (!clientState.latestConversationsPollTimer) return;
    window.clearInterval(clientState.latestConversationsPollTimer);
    clientState.latestConversationsPollTimer = null;
  };
  const postApiClientResult = (payload) => {
    window.postMessage({ source: 'pdd-api-client-result', payload }, '*');
  };
  const responsePreview = (value) => {
    try {
      return JSON.stringify(value).slice(0, 1000);
    } catch {
      return null;
    }
  };
  const sendResponseDiagnostics = (payload) => {
    const result = payload?.result && typeof payload.result === 'object' ? payload.result : {};
    return {
      response_success: payload?.success === true,
      response_error_code: textInPage(payload?.errorCode ?? payload?.error_code, 64),
      response_error_msg: textInPage(payload?.errorMsg || payload?.error_msg, 256),
      result_result: textInPage(result.result, 128),
      response_preview: responsePreview(payload),
    };
  };
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== 'pdd-api-shadow-command') return;
    const command = event.data;
    window.postMessage({
      source: 'pdd-api-shadow-command-ack',
      command: typeof command.command === 'string' ? command.command.slice(0, 128) : null,
      requestId: typeof command.requestId === 'string' ? command.requestId.slice(0, 128) : null,
      apiShadowVersion,
      commandApiShadowVersion: typeof command.apiShadowVersion === 'string'
        ? command.apiShadowVersion.slice(0, 128)
        : null,
    }, '*');
    if (command.command === 'start-sync-polling') {
      startSyncPolling();
      return;
    }
    if (command.command === 'stop-sync-polling') {
      stopSyncPolling();
      return;
    }
    if (command.command === 'start-latest-conversations-polling') {
      startLatestConversationsPolling();
      return;
    }
    if (command.command === 'stop-latest-conversations-polling') {
      stopLatestConversationsPolling();
      return;
    }
    if (command.command === 'latest-conversations' && typeof command.requestId === 'string') {
      void requestLatestConversationsInPage({
        requestId: command.requestId,
        purpose: command.purpose,
        page: command.page,
        size: command.size,
      });
      return;
    }
    if (command.command === 'shop-info' && typeof command.requestId === 'string') {
      void requestShopInfoInPage({
        requestId: command.requestId,
        purpose: command.purpose,
      });
      return;
    }
    if (command.command === 'customer-orders' && typeof command.requestId === 'string') {
      const requestId = command.requestId.slice(0, 128);
      const customerUid = textInPage(command.customerUid, 128);
      const conversationKey = textInPage(command.conversationKey, 128) || customerUid;
      const customerName = textInPage(command.customerName, 128)
        || clientState.latestConversations.get(customerUid)?.customerName
        || null;
      if (!customerUid) {
        postApiClientResult({
          endpoint: 'customer_orders',
          requestId,
          status: 'failed',
          conversationKey,
          customerUid,
          customerName,
          error: 'target_customer_uid_missing',
        });
        return;
      }
      if (!clientState.antiContentHeader) {
        postApiClientResult({
          endpoint: 'customer_orders',
          requestId,
          status: 'failed',
          conversationKey,
          customerUid,
          customerName,
          error: 'runtime_anti_content_missing',
          diagnostics: {
            has_anti_content_header: Boolean(clientState.antiContentHeader),
          },
        });
        return;
      }
      (async () => {
        try {
          const { url, init } = buildUserAllOrderRequest({
            customerUid,
            page: command.page,
            size: command.size,
          });
          clientState.internalRequestEndpoint = 'user_all_order';
          const response = await window.fetch(url, init);
          clientState.internalRequestEndpoint = null;
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const payload = await response.json();
          const collected = payload?.success === true && (
            payload.errorCode === undefined
            || Number(payload.errorCode) === 1000000
            || payload.errorCode === null
          );
          postApiClientResult({
            endpoint: 'customer_orders',
            requestId,
            status: collected ? 'collected' : 'failed',
            conversationKey,
            customerUid,
            customerName,
            response: payload,
            diagnostics: {
              total: Number.isFinite(Number(payload?.result?.total)) ? Number(payload.result.total) : null,
              order_count: Array.isArray(payload?.result?.orders) ? payload.result.orders.length : 0,
              page_no: Number.isFinite(Number(payload?.result?.pageNo)) ? Number(payload.result.pageNo) : null,
              page_size: Number.isFinite(Number(payload?.result?.pageSize)) ? Number(payload.result.pageSize) : null,
              has_anti_content_header: true,
            },
            error: collected ? null : textInPage(payload?.errorMsg, 256) || 'pdd_response_not_ok',
          });
        } catch (error) {
          clientState.internalRequestEndpoint = null;
          postApiClientResult({
            endpoint: 'customer_orders',
            requestId,
            status: 'failed',
            conversationKey,
            customerUid,
            customerName,
            error: error?.message || String(error),
          });
        }
      })();
      return;
    }
    if (command.command === 'customer-products' && typeof command.requestId === 'string') {
      const requestId = command.requestId.slice(0, 128);
      const customerUid = textInPage(command.customerUid, 128);
      const conversationKey = textInPage(command.conversationKey, 128) || customerUid || 'shop';
      const customerName = textInPage(command.customerName, 128)
        || clientState.latestConversations.get(customerUid)?.customerName
        || null;
      if (!clientState.antiContentHeader) {
        postApiClientResult({
          endpoint: 'customer_products',
          requestId,
          status: 'failed',
          conversationKey,
          customerUid,
          customerName,
          error: 'runtime_anti_content_missing',
          diagnostics: {
            has_anti_content_header: Boolean(clientState.antiContentHeader),
          },
        });
        return;
      }
      (async () => {
        try {
          const firstPage = Math.max(1, Math.min(Number(command.page) || 1, 100));
          const pageSize = Math.max(1, Math.min(Number(command.size) || 10, 100));
          const maxPages = Math.max(1, Math.min(Number(command.maxPages) || 10, 20));
          const pages = [];
          let pageError = null;
          let maxPagesReached = false;
          for (let offset = 0; offset < maxPages; offset += 1) {
            const page = firstPage + offset;
            let payload = null;
            try {
              const { url, init } = buildRecommendGoodsRequest({
                customerUid,
                page,
                size: pageSize,
              });
              clientState.internalRequestEndpoint = 'recommend_goods';
              const response = await window.fetch(url, init);
              clientState.internalRequestEndpoint = null;
              if (!response.ok) throw new Error(`HTTP ${response.status}`);
              payload = await response.json();
            } catch (error) {
              clientState.internalRequestEndpoint = null;
              if (pages.length <= 0) throw error;
              pageError = error?.message || String(error);
              maxPagesReached = true;
              break;
            }
            const collected = payload?.success === true && (
              payload.errorCode === undefined
              || Number(payload.errorCode) === 1000000
              || payload.errorCode === null
              || Number(payload.error_code) === 1000000
              || payload.error_code === null
            );
            if (!collected) {
              const errorMessage = textInPage(payload?.errorMsg || payload?.error_msg, 256) || 'pdd_response_not_ok';
              if (pages.length <= 0) throw new Error(errorMessage);
              pageError = errorMessage;
              maxPagesReached = true;
              break;
            }
            pages.push({ page, payload });
            const total = Number.isFinite(Number(payload?.result?.total)) ? Number(payload.result.total) : null;
            const pageItemCount = recommendGoodsPageItemsInPage(payload).length;
            const hasNextByTotal = total !== null && page * pageSize < total;
            const hasNextByPageSize = total === null && pageItemCount >= pageSize;
            const shouldContinue = hasNextByTotal || hasNextByPageSize;
            if (!shouldContinue) break;
            if (offset === maxPages - 1) maxPagesReached = true;
          }
          const payload = mergeRecommendGoodsResponsesInPage(pages, {
            pageSize,
            maxPagesReached,
          });
          const collected = pages.length > 0;
          const result = payload?.result || {};
          postApiClientResult({
            endpoint: 'customer_products',
            requestId,
            status: collected ? 'collected' : 'failed',
            conversationKey,
            customerUid,
            customerName,
            response: payload,
            diagnostics: {
              total: Number.isFinite(Number(result.total)) ? Number(result.total) : null,
              recommend_count: Array.isArray(result.recommendGoods) ? result.recommendGoods.length : 0,
              on_sale_count: Array.isArray(result.onSaleGoods) ? result.onSaleGoods.length : 0,
              page_count: pages.length,
              page_size: pageSize,
              has_more: result.has_more === true,
              page_error: pageError,
              has_anti_content_header: true,
            },
            error: collected ? null : pageError || 'pdd_response_not_ok',
          });
        } catch (error) {
          clientState.internalRequestEndpoint = null;
          postApiClientResult({
            endpoint: 'customer_products',
            requestId,
            status: 'failed',
            conversationKey,
            customerUid,
            customerName,
            error: error?.message || String(error),
          });
        }
      })();
      return;
    }
    if (command.command === 'platform-phrases' && typeof command.requestId === 'string') {
      const requestId = command.requestId.slice(0, 128);
      const source = (command.phraseSource || command.source) === 'team' ? 'team' : 'personal';
      (async () => {
        let requestUrl = '';
        let endpointKey = source === 'team' ? 'team_phrases' : 'personal_phrases';
        try {
          const { endpointKey: builtEndpointKey, url, init } = buildPlatformPhraseRequest({ source });
          endpointKey = builtEndpointKey;
          requestUrl = url;
          clientState.internalRequestEndpoint = endpointKey;
          const { response, payload, textPreview } = await fetchJsonWithTimeoutInPage(url, init, 10000);
          clientState.internalRequestEndpoint = null;
          if (!response.ok) {
            postApiClientResult({
              endpoint: 'platform_phrases',
              requestId,
              status: 'failed',
              source,
              records: [],
              raw_count: 0,
              diagnostics: {
                url: url.slice(0, 512),
                http_status: Number(response.status) || null,
                content_type: textInPage(response.headers?.get?.('content-type'), 256),
                response_preview: textPreview,
                has_anti_content_header: Boolean(clientState.antiContentHeader),
              },
              error: `HTTP ${response.status}`,
            });
            return;
          }
          const collected = payload?.success === true && (
            payload.errorCode === undefined
            || Number(payload.errorCode) === 1000000
            || payload.errorCode === null
          );
          const records = collected ? normalizePlatformPhrasesInPage(payload, source) : [];
          postApiClientResult({
            endpoint: 'platform_phrases',
            requestId,
            status: collected ? 'collected' : 'failed',
            source,
            response: null,
            records,
            raw_count: records.length,
            diagnostics: {
              url: url.slice(0, 512),
              http_status: Number(response.status) || null,
              content_type: textInPage(response.headers?.get?.('content-type'), 256),
              response_preview: collected ? null : textPreview,
              has_anti_content_header: Boolean(clientState.antiContentHeader),
              record_count: records.length,
            },
            error: collected ? null : textInPage(payload?.errorMsg, 256) || 'pdd_response_not_ok',
          });
        } catch (error) {
          clientState.internalRequestEndpoint = null;
          postApiClientResult({
            endpoint: 'platform_phrases',
            requestId,
            status: 'failed',
            source,
            records: [],
            raw_count: 0,
            diagnostics: {
              url: requestUrl.slice(0, 512),
              endpoint_key: endpointKey,
              has_anti_content_header: Boolean(clientState.antiContentHeader),
            },
            error: error?.message || String(error),
          });
        }
      })();
      return;
    }
    if (command.command === 'send-product' && typeof command.requestId === 'string') {
      const requestId = command.requestId.slice(0, 128);
      const customerUid = textInPage(command.customerUid, 128);
      const conversationKey = textInPage(command.conversationKey, 128) || customerUid;
      const customerName = textInPage(command.customerName, 128);
      const productId = textInPage(command.productId, 128);
      if (!customerUid || !productId) {
        postApiClientResult({
          endpoint: 'send_product',
          requestId,
          status: 'failed',
          conversationKey,
          customerUid,
          customerName,
          productId,
          error: !customerUid ? 'target_customer_uid_missing' : 'product_id_missing',
        });
        return;
      }
      if (!clientState.antiContentHeader) {
        postApiClientResult({
          endpoint: 'send_product',
          requestId,
          status: 'failed',
          conversationKey,
          customerUid,
          customerName,
          productId,
          error: 'runtime_anti_content_missing',
          diagnostics: {
            has_anti_content_header: Boolean(clientState.antiContentHeader),
          },
        });
        return;
      }
      (async () => {
        try {
          const { url, init } = buildMallGoodsCardRequest({ customerUid, productId });
          clientState.internalRequestEndpoint = 'mall_goods_card';
          const response = await window.fetch(url, init);
          clientState.internalRequestEndpoint = null;
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const payload = await response.json();
          const sent = payload?.success === true && payload?.result === true;
          postApiClientResult({
            endpoint: 'send_product',
            requestId,
            status: sent ? 'sent' : 'failed',
            conversationKey,
            customerUid,
            customerName,
            productId,
            response: payload,
            diagnostics: {
              result: payload?.result === true,
              has_anti_content_header: true,
            },
            error: sent ? null : textInPage(payload?.errorMsg || payload?.error_msg, 256) || 'pdd_response_not_ok',
          });
        } catch (error) {
          clientState.internalRequestEndpoint = null;
          postApiClientResult({
            endpoint: 'send_product',
            requestId,
            status: 'failed',
            conversationKey,
            customerUid,
            customerName,
            productId,
            error: error?.message || String(error),
          });
        }
      })();
      return;
    }
    if (command.command === 'send-message' && typeof command.requestId === 'string') {
      const requestId = command.requestId.slice(0, 128);
      const customerUid = textInPage(command.customerUid, 128);
      const conversationKey = textInPage(command.conversationKey, 128) || customerUid;
      const customerName = textInPage(command.customerName, 128);
      const content = messageContentInPage(command.content, 4000);
      const quoteMessageId = textInPage(command.quoteMessageId, 128);
      if (!customerUid || !content) {
        postApiClientResult({
          endpoint: 'send_message',
          requestId,
          status: 'failed',
          conversationKey,
          customerUid,
          customerName,
          error: !customerUid ? 'target_customer_uid_missing' : 'message_content_missing',
        });
        return;
      }
      if (!clientState.antiContentHeader || (!clientState.topAntiContent && !clientState.dataAntiContent)) {
        postApiClientResult({
          endpoint: 'send_message',
          requestId,
          status: 'failed',
          conversationKey,
          customerUid,
          customerName,
          error: 'runtime_anti_content_missing',
          diagnostics: {
            has_anti_content_header: Boolean(clientState.antiContentHeader),
            has_anti_content_body: Boolean(clientState.topAntiContent || clientState.dataAntiContent),
          },
        });
        return;
      }
      (async () => {
        try {
          const { url, init } = await buildSendMessageRequest({ customerUid, content, quoteMessageId });
          const response = await window.fetch(url, init);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const payload = await response.json();
          const result = payload?.result || {};
          const sent = payload?.success === true && result.result === 'ok';
          postApiClientResult({
            endpoint: 'send_message',
            requestId,
            status: sent ? 'sent' : 'failed',
            conversationKey,
            customerUid,
            customerName,
            result: {
              request_id: textInPage(result.request_id, 128),
              msg_id: textInPage(result.msg_id, 128),
              pre_msg_id: textInPage(result.pre_msg_id, 128),
              ts: textInPage(result.ts, 64),
            },
            diagnostics: {
              has_msg_id: Boolean(result.msg_id),
              has_pre_msg_id: Boolean(result.pre_msg_id),
              has_ts: Boolean(result.ts),
              quote_msg_id_present: Boolean(quoteMessageId),
              ...(!sent ? sendResponseDiagnostics(payload) : {}),
            },
            responsePreview: sent ? null : responsePreview(payload),
            error: sent
              ? null
              : textInPage(payload?.errorMsg || payload?.error_msg, 256) || 'pdd_response_not_ok',
          });
        } catch (error) {
          postApiClientResult({
            endpoint: 'send_message',
            requestId,
            status: 'failed',
            conversationKey,
            customerUid,
            customerName,
            error: error?.message || String(error),
          });
        }
      })();
      return;
    }
    if (command.command === 'list-transfer-cs' && typeof command.requestId === 'string') {
      const requestId = command.requestId.slice(0, 128);
      (async () => {
        try {
          const assignRequest = buildAssignCsListRequest();
          const assignResponse = await window.fetch(assignRequest.url, assignRequest.init);
          if (!assignResponse.ok) throw new Error(`assign HTTP ${assignResponse.status}`);
          const assignPayload = await assignResponse.json();
          if (assignPayload?.success !== true || !assignPayload?.result?.csList
              || typeof assignPayload.result.csList !== 'object' || Array.isArray(assignPayload.result.csList)) {
            throw new Error('assign_cs_list_invalid_response');
          }
          const csList = assignPayload?.result?.csList;
          const transReason = assignPayload?.result?.transReason;
          postApiClientResult({
            endpoint: 'transfer_cs_list',
            requestId,
            status: 'collected',
            csList: mapTransferCsListInPage(csList).map((entry) => ({ ...entry, isCurrent: isCurrentTransferCsInPage(entry) })),
            identityVerified: Boolean(clientState.latestIdentity?.csId || clientState.latestIdentity?.csUid || clientState.latestIdentity?.serviceUsername),
            transReason: mapTransferReasonsInPage(transReason),
            diagnostics: {
              cs_count: csList && typeof csList === 'object' ? Object.keys(csList).length : 0,
            },
          });
        } catch (error) {
          postApiClientResult({
            endpoint: 'transfer_cs_list',
            requestId,
            status: 'failed',
            error: error?.message || String(error),
          });
        }
      })();
      return;
    }
    if (command.command === 'transfer-conversation' && typeof command.requestId === 'string') {
      const requestId = command.requestId.slice(0, 128);
      const customerUid = textInPage(command.customerUid, 128);
      const conversationKey = textInPage(command.conversationKey, 128) || customerUid;
      const customerName = textInPage(command.customerName, 128);
      const transReason = textInPage(command.transReason, 128) || '无原因直接转移';
      const targetCsid = textInPage(command.targetCsid, 128);
      if (!customerUid) {
        postApiClientResult({
          endpoint: 'transfer_conversation',
          requestId,
          status: 'failed',
          conversationKey,
          customerUid,
          customerName,
          transReason,
          error: 'target_customer_uid_missing',
        });
        return;
      }
      if (!clientState.antiContentHeader || (!clientState.topAntiContent && !clientState.dataAntiContent)) {
        postApiClientResult({
          endpoint: 'transfer_conversation',
          requestId,
          status: 'failed',
          conversationKey,
          customerUid,
          customerName,
          transReason,
          error: 'runtime_anti_content_missing',
          diagnostics: {
            has_anti_content_header: Boolean(clientState.antiContentHeader),
            has_anti_content_body: Boolean(clientState.topAntiContent || clientState.dataAntiContent),
          },
        });
        return;
      }
      (async () => {
        let submitted = false;
        try {
          const assignRequest = buildAssignCsListRequest();
          const assignResponse = await window.fetch(assignRequest.url, assignRequest.init);
          if (!assignResponse.ok) throw new Error(`assign HTTP ${assignResponse.status}`);
          const assignPayload = await assignResponse.json();
          if (assignPayload?.success !== true || !assignPayload?.result?.csList
              || typeof assignPayload.result.csList !== 'object' || Array.isArray(assignPayload.result.csList)) {
            throw new Error('assign_cs_list_invalid_response');
          }
          const csList = assignPayload?.result?.csList;
          const mappedCsList = mapTransferCsListInPage(csList);
          if (command.autoTransfer === true) {
            if (!(clientState.latestIdentity?.csId || clientState.latestIdentity?.csUid || clientState.latestIdentity?.serviceUsername)) {
              throw new Error('current_cs_identity_unavailable');
            }
            const candidates = mappedCsList.filter((entry) => !isCurrentTransferCsInPage(entry) && entry.recvUser === 1);
            if (!candidates.length) {
              postApiClientResult({ endpoint: 'transfer_conversation', requestId, status: 'no_online_target',
                submitted: false, conversationKey, customerUid });
              return;
            }
            if (!candidates.some((entry) => entry.csid === targetCsid)) throw new Error('target_cs_no_longer_receivable');
          }
          const targetCs = targetCsid
            ? mappedCsList.find((entry) => entry.csid === targetCsid)
            : chooseTransferCsInPage(csList);
          if (targetCsid && !targetCs?.csid) throw new Error('target_cs_not_found_in_assign_list');
          if (!targetCs?.csid) throw new Error('assign_cs_list_empty');
          const { url, init } = buildMoveConversationRequest({
            customerUid,
            csid: targetCs.csid,
            transReason,
          });
          submitted = true;
          const moveResponse = await window.fetch(url, init);
          if (!moveResponse.ok) throw new Error(`move HTTP ${moveResponse.status}`);
          const movePayload = await moveResponse.json();
          const moveResult = movePayload?.result || {};
          const transferred = movePayload?.success === true && moveResult.result === 'ok';
          postApiClientResult({
            endpoint: 'transfer_conversation',
            requestId,
            status: transferred ? 'transferred' : 'failed',
            submitted,
            conversationKey,
            customerUid,
            customerName,
            transReason,
            targetCsId: targetCs.csid,
            targetCsUsername: targetCs.username,
            targetCsNickname: targetCs.nickname,
            result: {
              response: textInPage(moveResult.response, 128),
              request_id: textInPage(moveResult.request_id, 128),
              result: textInPage(moveResult.result, 128),
            },
            diagnostics: {
              cs_count: csList && typeof csList === 'object' ? Object.keys(csList).length : 0,
              target_selected_from_cs_list: true,
              target_csid_requested: Boolean(targetCsid),
              has_anti_content_header: true,
              has_anti_content_body: true,
            },
            error: transferred ? null : textInPage(movePayload?.errorMsg || movePayload?.error_msg, 256) || 'pdd_response_not_ok',
          });
        } catch (error) {
          postApiClientResult({
            endpoint: 'transfer_conversation',
            requestId,
            status: submitted ? 'confirmation_pending' : 'failed',
            submitted,
            conversationKey,
            customerUid,
            customerName,
            transReason,
            error: error?.message || String(error),
          });
        }
      })();
      return;
    }
    if (command.command === 'send-image' && typeof command.requestId === 'string') {
      const requestId = command.requestId.slice(0, 128);
      const customerUid = textInPage(command.customerUid, 128);
      const conversationKey = textInPage(command.conversationKey, 128) || customerUid;
      const customerName = textInPage(command.customerName, 128);
      const imageDataUrl = typeof command.imageDataUrl === 'string' ? command.imageDataUrl : '';
      const quoteMessageId = textInPage(command.quoteMessageId, 128);
      const fallbackWidth = Number(command.width) || null;
      const fallbackHeight = Number(command.height) || null;
      const fallbackByteSize = Number(command.byteSize) || null;
      if (!customerUid || !imageDataUrl) {
        postApiClientResult({
          endpoint: 'send_image',
          requestId,
          status: 'failed',
          conversationKey,
          customerUid,
          customerName,
          error: !customerUid ? 'target_customer_uid_missing' : 'image_data_missing',
        });
        return;
      }
      if (!clientState.antiContentHeader || (!clientState.topAntiContent && !clientState.dataAntiContent)) {
        postApiClientResult({
          endpoint: 'send_image',
          requestId,
          status: 'failed',
          conversationKey,
          customerUid,
          customerName,
          error: 'runtime_anti_content_missing',
          diagnostics: {
            has_anti_content_header: Boolean(clientState.antiContentHeader),
            has_anti_content_body: Boolean(clientState.topAntiContent || clientState.dataAntiContent),
          },
        });
        return;
      }
      (async () => {
        try {
          const upload = await uploadImageToPdd({ imageDataUrl });
          const width = upload.width || fallbackWidth || 0;
          const height = upload.height || fallbackHeight || 0;
          const imageSizeKb = upload.imageSizeKb
            || Math.max(1, Math.ceil((fallbackByteSize || upload.byteSize || 0) / 1024));
          const { url, init } = await buildSendImageMessageRequest({
            customerUid,
            imageUrl: upload.imageUrl,
            width,
            height,
            imageSizeKb,
            imageHash: upload.hash,
            thumbData: upload.thumbData,
            quoteMessageId,
          });
          clientState.internalRequestEndpoint = 'send_message';
          const response = await window.fetch(url, init);
          clientState.internalRequestEndpoint = null;
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const payload = await response.json();
          const result = payload?.result || {};
          const sent = payload?.success === true && result.result === 'ok';
          postApiClientResult({
            endpoint: 'send_image',
            requestId,
            status: sent ? 'sent' : 'failed',
            conversationKey,
            customerUid,
            customerName,
            upload: {
              image_url: upload.imageUrl,
              width,
              height,
              image_size: imageSizeKb,
              hash: upload.hash,
              upload_bucket_tag: upload.uploadBucketTag,
            },
            result: {
              request_id: textInPage(result.request_id, 128),
              msg_id: textInPage(result.msg_id, 128),
              pre_msg_id: textInPage(result.pre_msg_id, 128),
              ts: textInPage(result.ts, 64),
            },
            diagnostics: {
              has_msg_id: Boolean(result.msg_id),
              has_pre_msg_id: Boolean(result.pre_msg_id),
              has_ts: Boolean(result.ts),
              has_image_url: Boolean(upload.imageUrl),
              image_width: width,
              image_height: height,
              image_size: imageSizeKb,
              quote_msg_id_present: Boolean(quoteMessageId),
              ...(!sent ? sendResponseDiagnostics(payload) : {}),
            },
            responsePreview: sent ? null : responsePreview(payload),
            error: sent
              ? null
              : textInPage(payload?.errorMsg || payload?.error_msg, 256) || 'pdd_response_not_ok',
          });
        } catch (error) {
          clientState.internalRequestEndpoint = null;
          postApiClientResult({
            endpoint: 'send_image',
            requestId,
            status: 'failed',
            conversationKey,
            customerUid,
            customerName,
            error: error?.message || String(error),
          });
        }
      })();
      return;
    }
    if (command.command !== 'chat-list' || typeof command.requestId !== 'string') return;
    const requestId = command.requestId.slice(0, 128);
    const customerUid = textInPage(command.customerUid, 128);
    const conversationKey = textInPage(command.conversationKey, 128) || customerUid;
    const metadata = customerUid ? clientState.latestConversations.get(customerUid) : null;
    const customerName = textInPage(command.customerName, 128) || metadata?.customerName || null;
    const avatarUrl = textInPage(command.avatarUrl, 1000) || metadata?.avatarUrl || null;
    if (!customerUid) {
      postApiClientResult({
        endpoint: 'chat_list',
        requestId,
        status: 'failed',
        conversationKey,
        customerUid,
        customerName,
        avatarUrl,
        error: 'target_customer_uid_missing',
      });
      return;
    }
    if (!clientState.antiContentHeader || (!clientState.topAntiContent && !clientState.dataAntiContent)) {
      postApiClientResult({
        endpoint: 'chat_list',
        requestId,
        status: 'failed',
        conversationKey,
        customerUid,
        customerName,
        avatarUrl,
        error: 'runtime_anti_content_missing',
        diagnostics: {
          has_anti_content_header: Boolean(clientState.antiContentHeader),
          has_anti_content_body: Boolean(clientState.topAntiContent || clientState.dataAntiContent),
        },
      });
      return;
    }
    (async () => {
      try {
        const { url, init } = buildChatListRequest({
          customerUid,
          size: command.size,
        });
        const response = await window.fetch(url, init);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        postApiClientResult({
          endpoint: 'chat_list',
          requestId,
          status: payload?.success === true && payload?.result?.result === 'ok' ? 'collected' : 'failed',
          conversationKey,
          customerUid,
          customerName,
          avatarUrl,
          response: payload,
          diagnostics: {
            has_anti_content_header: true,
            has_anti_content_body: true,
            message_count: Array.isArray(payload?.result?.messages) ? payload.result.messages.length : 0,
            has_more: Boolean(payload?.result?.has_more),
          },
          error: payload?.success === true && payload?.result?.result === 'ok' ? null : 'pdd_response_not_ok',
        });
      } catch (error) {
        postApiClientResult({
          endpoint: 'chat_list',
          requestId,
          status: 'failed',
          conversationKey,
          customerUid,
          customerName,
          avatarUrl,
          error: error?.message || String(error),
        });
      }
    })();
  });
  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = async function pddApiShadowFetch(input, init = {}) {
      const url = typeof input === 'string' ? input : input?.url;
      const endpoint = endpointFromUrlInPage(url);
      const suppressShadow = endpoint && clientState.internalRequestEndpoint === endpoint.key;
      const request = endpoint ? requestContext({
        endpoint,
        url,
        method: init?.method || input?.method,
        headers: init?.headers || input?.headers,
        body: init?.body,
      }) : null;
      const response = await originalFetch.apply(this, arguments);
      if (endpoint && !suppressShadow) {
        responsePayloadFromFetchInPage(response)
          .then((payload) => postApiShadow(endpoint, url, request, payload))
          .catch(() => {});
      }
      return response;
    };
  }
  const OriginalXhr = window.XMLHttpRequest;
  if (typeof OriginalXhr === 'function') {
    const originalOpen = OriginalXhr.prototype.open;
    const originalSetRequestHeader = OriginalXhr.prototype.setRequestHeader;
    const originalSend = OriginalXhr.prototype.send;
    OriginalXhr.prototype.open = function pddApiShadowOpen(method, url) {
      this.__pddApiShadow = { method, url, headers: {}, endpoint: endpointFromUrlInPage(url) };
      return originalOpen.apply(this, arguments);
    };
    OriginalXhr.prototype.setRequestHeader = function pddApiShadowSetHeader(name, value) {
      if (this.__pddApiShadow?.headers && typeof name === 'string') this.__pddApiShadow.headers[name] = value;
      return originalSetRequestHeader.apply(this, arguments);
    };
    OriginalXhr.prototype.send = function pddApiShadowSend(body) {
      const shadow = this.__pddApiShadow;
      const request = shadow?.endpoint ? requestContext({
        endpoint: shadow.endpoint,
        url: shadow.url,
        method: shadow.method,
        headers: shadow.headers,
        body,
      }) : null;
      if (shadow?.endpoint) {
        this.addEventListener('loadend', () => {
          try {
            if (this.responseType && this.responseType !== 'text' && this.responseType !== 'json') return;
            const payload = this.responseType === 'json'
              ? {
                ...(this.response && typeof this.response === 'object'
                  ? this.response
                  : { success: this.status >= 200 && this.status < 300 }),
                __http_status: Number(this.status) || 0,
                __content_type: textInPage(this.getResponseHeader?.('content-type'), 256),
              }
              : responsePayloadFromTextInPage(this.responseText, {
                ok: this.status >= 200 && this.status < 300,
                status: this.status,
                contentType: this.getResponseHeader?.('content-type') || '',
              });
            if (payload) postApiShadow(shadow.endpoint, shadow.url, request, payload);
          } catch {}
        });
      }
      return originalSend.apply(this, arguments);
    };
  }
}

function messageText(value, limit = MAX_TEXT) {
  const cleaned = String(value || '').replace(/\r\n?/g, '\n').trim();
  return cleaned ? cleaned.slice(0, limit) : null;
}

function queryFirst(root, catalog) {
  for (const selector of catalog || []) {
    try {
      const element = root.querySelector(selector);
      if (element) return element;
    } catch {
      // Ignore a selector that is incompatible with a future Chromium version.
    }
  }
  return null;
}

function queryAllCandidates(root, catalog) {
  const matches = [];
  const seen = new Set();
  for (const selector of catalog || []) {
    try {
      for (const element of root.querySelectorAll(selector)) {
        if (!seen.has(element)) {
          seen.add(element);
          matches.push(element);
        }
      }
    } catch {
      // Continue with the remaining selectors.
    }
  }
  return matches.sort((left, right) => {
    if (left === right) return 0;
    const position = left.compareDocumentPosition(right);
    return position & Node.DOCUMENT_POSITION_PRECEDING ? 1 : -1;
  });
}

function outermostCandidates(matches) {
  return matches.filter((element) => !matches.some(
    (candidate) => candidate !== element && candidate.contains(element),
  ));
}

function queryCandidates(root, catalog) {
  return outermostCandidates(queryAllCandidates(root, catalog));
}

function isCanonicalPlatformMessage(element) {
  const id = element.getAttribute?.('id') || '';
  return (
    element.tagName === 'LI'
    && (/^middlepanel_list_/i.test(id) || element.classList.contains('onemsg'))
  );
}

function inspectMessageCandidates() {
  const conversationItems = queryCandidates(document, selectors.conversationItems);
  const containerCandidates = queryAllCandidates(document, selectors.messageContainers)
    .filter((container) => !conversationItems.some(
      (conversationItem) => conversationItem === container || conversationItem.contains(container),
    ))
    .map((container) => ({
      container,
      canonicalCount: queryAllCandidates(container, selectors.messageItems)
        .filter(isCanonicalPlatformMessage).length,
    }))
    .filter((candidate) => candidate.canonicalCount > 0)
    .sort((left, right) => (
      Number(isVisible(right.container)) - Number(isVisible(left.container))
      || right.canonicalCount - left.canonicalCount
    ));
  const root = containerCandidates[0]?.container || document;
  const all = queryAllCandidates(root, selectors.messageItems);
  const outsideConversationList = all.filter((element) => !conversationItems.some(
    (conversationItem) => conversationItem === element || conversationItem.contains(element),
  ));
  const canonical = outsideConversationList.filter(isCanonicalPlatformMessage);
  const selected = canonical.length ? canonical : outermostCandidates(outsideConversationList);
  return {
    elements: selected,
    diagnostics: {
      candidate_count: all.length,
      conversation_preview_rejected_count: all.length - outsideConversationList.length,
      canonical_count: canonical.length,
      selected_count: selected.length,
      fallback_used: canonical.length === 0,
      scoped_to_message_container: root !== document,
    },
  };
}

function selectorHitCounts(catalog) {
  const result = {};
  for (const selector of catalog || []) {
    try {
      result[selector] = document.querySelectorAll(selector).length;
    } catch {
      result[selector] = -1;
    }
  }
  return result;
}

function attribute(element, names) {
  for (const name of names) {
    const value = text(element?.getAttribute?.(name), 128);
    if (value) return value;
  }
  return null;
}

function idFromLink(element) {
  const link = element?.closest?.('a[href]') || element?.querySelector?.('a[href]');
  if (!link) return null;
  try {
    const url = new URL(link.href, location.href);
    for (const key of ['conversationId', 'conversation_id', 'sessionId', 'session_id', 'chatId', 'uid', 'userId']) {
      const value = text(url.searchParams.get(key), 128);
      if (value) return value;
    }
  } catch {
    // Ignore malformed page links.
  }
  return null;
}

function isActive(element) {
  if (element.getAttribute('aria-selected') === 'true' || element.getAttribute('data-active') === 'true') {
    return true;
  }
  const marker = `${element.className || ''}`.toLowerCase();
  return /(^|[\s_-])(active|current|selected)([\s_-]|$)/.test(marker)
    || Boolean(element.querySelector('.active, .current, .selected'));
}

function isVisible(element) {
  if (!element?.isConnected) return false;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const style = window.getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
}

function unreadCount(element) {
  if (!isVisible(element)) return 0;
  let count = 0;
  const seen = new Set();
  for (const selector of selectors.unreadBadge || []) {
    try {
      const matches = [
        ...(element.matches(selector) ? [element] : []),
        ...element.querySelectorAll(selector),
      ];
      for (const badge of matches) {
        if (seen.has(badge) || !isVisible(badge)) continue;
        seen.add(badge);
        const matched = text(badge.textContent, 32)?.match(/\d+/);
        count = Math.max(count, matched ? Math.min(Number(matched[0]), 9999) : 1);
      }
    } catch {
      // Continue with the remaining unread selectors.
    }
  }
  if (count > 0) return count;
  return UNREAD_STATUS_PATTERN.test(text(element.textContent, 1000) || '') ? 1 : 0;
}

function avatarUrl(element) {
  const image = element.querySelector('img');
  if (!image) return null;
  try {
    const url = new URL(image.currentSrc || image.src, location.href);
    return url.protocol === 'https:' ? url.toString().slice(0, 1000) : null;
  } catch {
    return null;
  }
}

function isPlatformSystemPrompt(value) {
  const normalized = text(value, 1000);
  return Boolean(normalized && PLATFORM_SYSTEM_PROMPT_PATTERN.test(normalized));
}

function conversationPreviewText(element) {
  const candidates = queryCandidates(element, selectors.conversationPreview);
  for (const candidate of candidates) {
    const candidateText = text(candidate.textContent);
    if (candidateText && !isPlatformSystemPrompt(candidateText)) return candidateText;
  }
  return null;
}

function readConversation(element) {
  const nameElement = queryFirst(element, selectors.conversationName);
  const customerName = text(nameElement?.textContent, 128);
  const randomMarker = attribute(element.querySelector('[data-random]'), ['data-random']);
  const externalId = attribute(element, [
    'data-conversation-id', 'data-session-id', 'data-chat-id', 'data-user-id', 'data-uid',
  ]) || randomMarker?.match(/^([0-9]+)-/)?.[1] || idFromLink(element);
  if (!externalId && !customerName) return null;
  return {
    external_conversation_id: externalId,
    customer_name: customerName,
    title: customerName,
    latest_message_text: conversationPreviewText(element),
    unread_count: unreadCount(element),
    avatar_url: avatarUrl(element),
    active: isActive(element),
  };
}

function conversationKey(conversation) {
  return conversation.external_conversation_id || `name:${conversation.customer_name}`;
}

function collectConversationEntries() {
  const entries = queryCandidates(document, selectors.conversationItems)
    .map((element, sequence) => {
      const conversation = readConversation(element);
      return conversation
        ? {
          element,
          sequence,
          key: conversationKey(conversation),
          conversation,
          visible: isVisible(element),
          sourceCount: 1,
        }
        : null;
    })
    .filter(Boolean);
  const byKey = new Map();
  for (const entry of entries) {
    const existing = byKey.get(entry.key);
    if (!existing) {
      byKey.set(entry.key, entry);
      continue;
    }
    const existingScore = (existing.conversation.active ? 100 : 0)
      + (existing.conversation.unread_count > 0 ? 20 : 0)
      + (existing.visible ? 10 : 0);
    const entryScore = (entry.conversation.active ? 100 : 0)
      + (entry.conversation.unread_count > 0 ? 20 : 0)
      + (entry.visible ? 10 : 0);
    const preferred = entryScore > existingScore ? entry : existing;
    byKey.set(entry.key, {
      ...preferred,
      sourceCount: existing.sourceCount + entry.sourceCount,
      conversation: {
        ...preferred.conversation,
        unread_count: Math.max(
          existing.conversation.unread_count,
          entry.conversation.unread_count,
        ),
        active: existing.conversation.active || entry.conversation.active,
      },
    });
  }
  return [...byKey.values()];
}

function senderRole(element) {
  if (element.querySelector('.buyer-item')) return 'customer';
  if (element.querySelector('.cs-item')) return 'agent';
  const explicit = attribute(element, ['data-sender-role', 'data-direction', 'data-from']);
  if (explicit && /agent|self|mine|out|send|seller/i.test(explicit)) return 'agent';
  if (explicit && /customer|other|in|receive|buyer/i.test(explicit)) return 'customer';
  const marker = `${element.className || ''} ${element.getAttribute('aria-label') || ''}`.toLowerCase();
  return /(^|[\s_-])(right|self|mine|send|seller|outgoing)([\s_-]|$)/.test(marker)
    ? 'agent'
    : 'customer';
}

function isLikelyAvatarImage(image, messageElement) {
  if (!image) return false;
  let url;
  try {
    url = new URL(image.currentSrc || image.src || '', location.href);
  } catch {
    url = null;
  }
  if (url?.hostname.toLowerCase() === 'savatar.pddpic.com') return true;
  let current = image;
  const classNames = [];
  while (current && current !== messageElement && classNames.length < 6) {
    classNames.push(`${current.className || ''}`.toLowerCase());
    current = current.parentElement;
  }
  return /(^|[\s_-])(avatar|head|portrait|usericon|user-icon)([\s_-]|$)/i.test(classNames.join(' '));
}

function contentImage(element, contentElement) {
  const scoped = contentElement && contentElement !== element
    ? [...contentElement.querySelectorAll('img')]
    : [];
  const images = scoped.length ? scoped : [...element.querySelectorAll('img')];
  return images.find((image) => !isLikelyAvatarImage(image, element)) || null;
}

function hasProductCardEvidence(element, contentElement) {
  const explicit = attribute(element, ['data-message-type', 'data-msg-type']);
  if (explicit && /goods|product|mall/i.test(explicit)) return true;
  const content = messageText(contentElement?.innerText || contentElement?.textContent) || '';
  const hasProductId = /\u5546\u54c1\s*ID\s*[\uff1a:]?\s*\d{6,}/i.test(content);
  const hasProductAction = /\u67e5\u770b\u5546\u54c1\u89c4\u683c/.test(content);
  const hasPrice = /[\uffe5\u00a5]\s*\d+(?:\.\d{1,2})?/.test(content);
  const hasImage = Boolean(contentImage(element, contentElement));
  const selectorMatched = matchesConfiguredSelector(element, 'product_selectors');
  return (
    (hasProductAction && (hasProductId || hasImage))
    || (hasProductId && hasImage && hasPrice)
    || (selectorMatched && hasImage && (hasProductId || hasProductAction || hasPrice))
  );
}

function messageType(element, contentElement) {
  const explicit = attribute(element, ['data-message-type', 'data-msg-type']);
  if (explicit && /image|pic/i.test(explicit)) return 'image';
  if (explicit && /goods|product|mall/i.test(explicit)) return 'product';
  if (explicit && /order/i.test(explicit)) return 'order';
  if (explicit && /system|notice/i.test(explicit)) return 'notice';
  if (matchesConfiguredSelector(element, 'system_selectors')) return 'system';
  if (matchesConfiguredSelector(element, 'context_selectors')) return 'context';
  if (matchesConfiguredSelector(element, 'order_selectors')) return 'order';
  if (hasProductCardEvidence(element, contentElement)) return 'product';
  if (contentImage(element, contentElement)) return 'image';
  return 'text';
}

function messageTimeLabel(element) {
  const timeElement = queryFirst(element, selectors.messageTime);
  return attribute(timeElement || element, ['datetime', 'data-time', 'data-timestamp'])
    || text(timeElement?.textContent, 64);
}

function hasKnownSender(element) {
  if (element.querySelector('.buyer-item, .cs-item')) return true;
  const explicit = attribute(element, ['data-sender-role', 'data-direction', 'data-from']);
  if (explicit) return true;
  const marker = `${element.className || ''} ${element.getAttribute('aria-label') || ''}`.toLowerCase();
  return /(^|[\s_-])(right|left|self|mine|send|seller|outgoing|buyer|customer|incoming)([\s_-]|$)/.test(marker);
}

function isIgnoredMessage(_element, _type, content) {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (isPlatformSystemPrompt(normalized)) return true;
  return matchesConfiguredText(normalized, 'ignored_text_patterns');
}

const FULL_TIME_LABEL_PATTERN = /^(?:(?:\d{4}\s*(?:[-/.]|年))?\d{1,2}\s*(?:[-/.]|月)\s*\d{1,2}\s*(?:日)?|今天|昨天|前天)\s+\d{1,2}:\d{2}(?::\d{2})?$/;

function structuredCardPayload(element, type, content, imageUrl) {
  if (!['product', 'order', 'context', 'unknown'].includes(type)) return null;
  const normalized = content.replace(/\s+/g, ' ').trim();
  const lines = content.split(/\n+/).map((item) => item.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const productId = normalized.match(/(?:商品\s*ID|商品ID|ID)\s*[：:]?\s*([0-9]{6,})/i)?.[1] || null;
  const priceLine = lines.find((item) => /^[￥¥]\s*[0-9]/.test(item)) || null;
  const price = normalized.match(/[￥¥]\s*([0-9]+(?:\.[0-9]{1,2})?)/)?.[1] || null;
  const sourceLabel = lines.find((item) => /^当前用户来自\s*/.test(item)) || null;
  const title = lines.find((item) => !(
    /^(?:商品\s*ID|商品ID|ID)\s*[：:]?/i.test(item)
    || /^当前用户来自\s*/.test(item)
    || /^[￥¥]\s*[0-9]/.test(item)
    || /^(?:复制|查看商品规格)$/.test(item)
  )) || normalized;
  const links = [...element.querySelectorAll('a[href]')];
  const linkUrl = links.map((link) => link.href).find((value) => /^https?:/i.test(value || '')) || null;
  return {
    title: title.slice(0, 512),
    product_id: productId,
    price: price ? Number(price) : null,
    price_label: priceLine,
    image_url: imageUrl,
    platform_url: linkUrl,
    source_label: sourceLabel,
  };
}

function stripLeadingTimeLabel(content, timeLabel) {
  if (!timeLabel || !content.startsWith(timeLabel)) return content;
  return messageText(content.slice(timeLabel.length)) || '';
}

function readMessage(element) {
  const contentElement = queryFirst(element, selectors.messageContent) || element;
  let type = messageType(element, contentElement);
  const image = ['image', 'product', 'order', 'context'].includes(type)
    ? contentImage(element, contentElement)
    : null;
  let imageUrl = null;
  if (image) {
    try {
      const candidate = new URL(
        image.currentSrc || image.src || image.getAttribute('data-src') || '',
        location.href,
      );
      if (candidate.protocol === 'http:' || candidate.protocol === 'https:') imageUrl = candidate.href;
    } catch {
      imageUrl = null;
    }
  }
  const timeLabel = messageTimeLabel(element);
  let content = messageText(contentElement.innerText || contentElement.textContent);
  const originalContent = content || '';
  if (FULL_TIME_LABEL_PATTERN.test(originalContent.replace(/\s+/g, ' ').trim())) type = 'time';
  if (type !== 'time') content = stripLeadingTimeLabel(originalContent, timeLabel);
  const normalizedContent = (content || '').replace(/\s+/g, ' ').trim();
  if (matchesConfiguredText(normalizedContent, 'context_text_patterns')) type = 'context';
  else if (matchesConfiguredText(normalizedContent, 'system_text_patterns')) type = 'system';
  else if (
    matchesConfiguredText(normalizedContent, 'product_text_patterns')
    && hasProductCardEvidence(element, contentElement)
  ) type = 'product';
  else if (type === 'text' && !hasKnownSender(element)) type = 'unknown';
  if (!content && type === 'image') content = '[image]';
  if (!content && type === 'product') content = '[product]';
  if (!content && type === 'order') content = '[order]';
  if (!content && type === 'context') content = '[context]';
  if (!content || isIgnoredMessage(element, type, content)) return null;
  const sender = text(element.querySelector('.nickname')?.textContent, 128)
    || attribute(element, ['data-sender-name', 'data-nickname']);
  const resolvedSenderRole = ['system', 'time', 'context', 'unknown'].includes(type)
    ? 'platform'
    : senderRole(element);
  return {
    platform_message_id: attribute(element, ['data-message-id', 'data-msg-id', 'data-id', 'id']),
    sender_role: resolvedSenderRole,
    sender_name: sender,
    content,
    message_type: type,
    image_url: imageUrl,
    display_mode: type === 'time' ? 'separator'
      : type === 'system' ? 'notice'
        : ['product', 'order', 'context', 'unknown'].includes(type) ? 'card' : 'bubble',
    automation_mode: type === 'text' || type === 'image' || (
      resolvedSenderRole === 'customer' && (type === 'product' || type === 'order')
    ) ? 'trigger' : type === 'context' || type === 'product' || type === 'order' ? 'context' : 'ignore',
    structured_payload: structuredCardPayload(element, type, content, imageUrl),
    collector_rule_version: collectorRules.version,
    time_label: timeLabel,
    has_explicit_time: Boolean(timeLabel),
  };
}

function readSnapshotMessages(elements) {
  const messages = [];
  for (const element of elements) {
    const message = readMessage(element);
    if (!message) continue;
    messages.push({
      dom_sequence: messages.length,
      sender_role: message.sender_role,
      message_type: message.message_type,
      content: message.content,
      image_url: message.image_url,
      platform_message_id: message.platform_message_id,
      display_mode: message.display_mode,
      automation_mode: message.automation_mode,
      structured_payload: message.structured_payload,
      collector_rule_version: message.collector_rule_version,
      time_label: message.time_label,
      has_explicit_time: message.has_explicit_time,
    });
  }
  return messages;
}

function accountNameCandidate() {
  const shopElement = queryFirst(document, selectors.shopName);
  for (const selector of selectors.shopName || []) {
    try {
      for (const element of document.querySelectorAll(selector)) {
        const candidate = text(element.textContent, 128);
        if (isVisible(element) && candidate && !GENERIC_ACCOUNT_NAME.test(candidate)) {
          return { accountName: candidate, source: 'dom' };
        }
      }
    } catch {
      // Continue with the remaining shop name selectors.
    }
  }
  const titleCandidate = text(document.title, 128);
  return titleCandidate && !GENERIC_ACCOUNT_NAME.test(titleCandidate)
    ? { accountName: titleCandidate, source: 'document_title' }
    : null;
}

function accountIdentity() {
  return apiRuntimeState.latestIdentity || null;
}

function currentPageStatus() {
  const path = location.pathname.toLowerCase();
  if (/\/risk|\/verify|\/captcha/.test(path)) return 'risk_control';
  if (document.querySelector(MANUAL_VERIFICATION_SELECTOR)) {
    return 'risk_control';
  }
  if (hasManualVerification()) return 'risk_control';
  if (path.startsWith('/login')) return 'login_required';
  return path.startsWith('/chat-windows') || path.startsWith('/chat-merchant') ? 'online' : 'unknown';
}

function hasManualVerification() {
  return MANUAL_VERIFICATION_PATTERN.test(text(document.body?.innerText, 6000) || '');
}

function messageAreaFingerprint() {
  return JSON.stringify(inspectMessageCandidates().elements.slice(-200).map((element) => [
    attribute(element, ['data-message-id', 'data-msg-id', 'data-id', 'id']),
    `${element.className || ''}`.slice(0, 180),
    text(element.textContent, 600),
  ]));
}

function hasVisibleMessages() {
  return inspectMessageCandidates().elements.length > 0;
}

function strictCurrentConversationName() {
  const element = queryFirst(document, [
    '[data-role="active-customer-name"]',
    '[class*="chatHeader"] [class*="buyerName"]',
    '[class*="ChatHeader"] [class*="BuyerName"]',
    '[class*="conversationHeader"] [class*="customerName"]',
    '[class*="ConversationHeader"] [class*="CustomerName"]',
    '[id*="middlePanel"] [data-role="customer-name"]',
  ]);
  return text(element?.textContent, 128);
}

function activeConversationEntry(entries) {
  return entries.find((entry) => entry.conversation.active) || null;
}

function readSnapshot(observedAt, entries = collectConversationEntries(), verifiedActiveKey = null) {
  const conversations = entries.map((entry) => ({
    ...entry.conversation,
    active: verifiedActiveKey ? entry.key === verifiedActiveKey : entry.conversation.active,
  }));
  let active = verifiedActiveKey
    ? conversations.find((conversation) => conversationKey(conversation) === verifiedActiveKey)
    : conversations.find((conversation) => conversation.active);
  if (!active && conversations.length === 1) active = conversations[0];
  if (active) {
    const { elements } = inspectMessageCandidates();
    const snapshotMessages = readSnapshotMessages(elements).slice(-200);
    active.snapshot_messages = snapshotMessages.map((message, domSequence) => ({
      ...message,
      dom_sequence: domSequence,
    }));
  }
  return conversations;
}

function visibleElement(element) {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
}

function safeElementSummary(element) {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  const value = (text(element.textContent, 80) || '')
    .replace(/\d{4,}/g, '[number]');
  return {
    tag: element.tagName?.toLowerCase?.() || '',
    role: attribute(element, ['role', 'data-role', 'data-testid']),
    id: attribute(element, ['id']),
    class_name: text(element.className, 160),
    text: value,
    rect: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
  };
}

function orderLabelCandidates() {
  return [...document.querySelectorAll('button,[role="tab"],a,div,span')]
    .filter(visibleElement)
    .map((element) => ({ element, value: text(element.textContent, 80) || '' }))
    .filter(({ value }) => value.length <= 40 && /最新订单|个人订单/.test(value))
    .slice(0, 20)
    .map(({ element }) => safeElementSummary(element));
}

function textNodeHitElement(label) {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const value = String(node.nodeValue || '');
    const index = value.indexOf(label);
    const parent = node.parentElement;
    if (index >= 0 && visibleElement(parent)) {
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + label.length);
      const rect = range.getBoundingClientRect();
      const hit = rect.width > 0 && rect.height > 0
        ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
        : null;
      if (visibleElement(hit)) return hit;
      return parent;
    }
    node = walker.nextNode();
  }
  return null;
}

function findVisibleTextElement(label, catalogs = []) {
  const configured = queryCandidates(document, catalogs).filter(visibleElement);
  const textNodeHit = textNodeHitElement(label);
  const textMatches = [...document.querySelectorAll('button,[role="tab"],a,div,span')].filter((element) => {
    const value = text(element.textContent, 128) || '';
    return visibleElement(element) && value.includes(label);
  });
  const candidates = [...new Set([...configured, ...(textNodeHit ? [textNodeHit] : []), ...textMatches])];
  return candidates.sort((left, right) => {
    const leftText = text(left.textContent, 128) || '';
    const rightText = text(right.textContent, 128) || '';
    const leftExact = leftText === label ? 0 : 1;
    const rightExact = rightText === label ? 0 : 1;
    if (leftExact !== rightExact) return leftExact - rightExact;
    const leftInteractive = left.matches('button,[role="tab"],a,[onclick]') ? 0 : 1;
    const rightInteractive = right.matches('button,[role="tab"],a,[onclick]') ? 0 : 1;
    if (leftInteractive !== rightInteractive) return leftInteractive - rightInteractive;
    return leftText.length - rightText.length;
  })[0] || null;
}

async function waitForVisibleTextElement(label, catalogs, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  let element = findVisibleTextElement(label, catalogs);
  while (!element && Date.now() < deadline) {
    await sleep(100);
    element = findVisibleTextElement(label, catalogs);
  }
  return element;
}

function parseMoney(source, label) {
  const pattern = new RegExp(`${label}\\s*[：:]?\\s*([+-]?)\\s*[¥￥]?\\s*(\\d+(?:\\.\\d{1,2})?)`);
  const matched = source.match(pattern);
  return matched ? Number(`${matched[1] || ''}${matched[2]}`) : null;
}

function parseOrderTime(source) {
  const matched = source.match(
    /下单时间\s*[：:]?\s*(\d{4})[/-](\d{1,2})[/-](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/,
  );
  if (!matched) return null;
  const pad = (value) => String(value).padStart(2, '0');
  // Pinduoduo displays shop-local wall time without a timezone marker.
  return `${matched[1]}-${pad(matched[2])}-${pad(matched[3])}T${pad(matched[4])}:${matched[5]}:${pad(matched[6] || 0)}`;
}

function orderMarkerElements() {
  const markers = [];
  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const parent = node.parentElement;
    if (String(node.nodeValue || '').includes('订单编号') && visibleElement(parent) && !seen.has(parent)) {
      seen.add(parent);
      markers.push(parent);
    }
    node = walker.nextNode();
  }
  return markers;
}

function fallbackOrderCards() {
  const markers = orderMarkerElements();
  const cards = markers.map((marker) => {
    let candidate = marker;
    for (let depth = 0; candidate && depth < 14; depth += 1, candidate = candidate.parentElement) {
      const value = text(candidate.innerText || candidate.textContent, MAX_TEXT) || '';
      const hasOrderId = /订单编号\s*[：:]?\s*[\d\s-]{8,}/.test(value);
      const hasStatus = normalizeOrderStatus(value) !== 'unknown';
      const hasAmount = /实付\s*[：:]|实收\s*[：:]|订单金额\s*[：:]/.test(value);
      if (hasOrderId && /下单时间/.test(value) && (hasStatus || hasAmount)) return candidate;
    }
    return null;
  }).filter(Boolean);
  return [...new Set(cards)].filter((element) => (
    !cards.some((candidate) => candidate !== element && element.contains(candidate))
  ));
}

function orderMarkerDiagnostics() {
  const markers = orderMarkerElements();
  return markers.slice(-5).map((marker) => {
    const ancestors = [];
    let candidate = marker;
    for (let depth = 0; candidate && depth < 10; depth += 1, candidate = candidate.parentElement) {
      const value = text(candidate.innerText || candidate.textContent, MAX_TEXT) || '';
      ancestors.push({
        depth,
        tag: candidate.tagName?.toLowerCase?.() || '',
        class_name: text(candidate.className, 160),
        text_length: value.length,
        has_order_time: /下单时间/.test(value),
        has_paid: /实付\s*[：:]/.test(value),
        has_received: /实收\s*[：:]/.test(value),
        has_amount: /订单金额\s*[：:]/.test(value),
        normalized_status: normalizeOrderStatus(value),
      });
    }
    return { marker: safeElementSummary(marker), ancestors };
  });
}

function normalizeOrderStatus(source) {
  if (/退款中|退货中|售后中|退款\/售后/.test(source)) return 'refunding';
  if (/已退款|退款成功/.test(source)) return 'refunded';
  if (/待支付|待付款/.test(source)) return 'pending_payment';
  if (/待发货|已付款|已支付/.test(source)) return 'paid_pending_shipment';
  if (/待签收|已发货|运输中/.test(source)) return 'shipped_pending_receipt';
  if (/已签收/.test(source)) return 'signed';
  if (/已完成|交易成功|订单完成/.test(source)) return 'completed';
  if (/已取消|已关闭|交易关闭/.test(source)) return 'cancelled';
  return 'unknown';
}

function orderCardImageUrl(element) {
  const images = [...element.querySelectorAll('img')]
    .filter(visibleElement)
    .map((image) => {
      const rect = image.getBoundingClientRect();
      const source = ['src', 'data-src', 'data-original']
        .map((name) => text(image.getAttribute(name), 2000))
        .find((value) => /^(?:https?:)?\/\//i.test(value || '')) || null;
      return { source, area: rect.width * rect.height };
    })
    .filter(({ source, area }) => area >= 400 && /^(?:https?:)?\/\//i.test(source || ''))
    .sort((left, right) => right.area - left.area);
  if (images.length) {
    return images[0].source.startsWith('//') ? `https:${images[0].source}` : images[0].source;
  }
  const backgrounds = [...element.querySelectorAll('*')]
    .filter(visibleElement)
    .map((candidate) => {
      const rect = candidate.getBoundingClientRect();
      const matched = getComputedStyle(candidate).backgroundImage.match(/url\(["']?((?:https?:)?\/\/[^"')]+)["']?\)/i);
      return { source: matched?.[1] || null, area: rect.width * rect.height };
    })
    .filter(({ source, area }) => source && area >= 400)
    .sort((left, right) => right.area - left.area);
  if (!backgrounds.length) return null;
  return backgrounds[0].source.startsWith('//') ? `https:${backgrounds[0].source}` : backgrounds[0].source;
}

function productTitleFromOrderSource(source) {
  const afterOrderedAt = source.split(/下单时间\s*[：:]?\s*\d{4}[/-]\d{1,2}[/-]\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?/)[1] || '';
  return afterOrderedAt
    .replace(/^(?:退货包运费\s*(?:未赠送|已赠送)?\s*)+/g, '')
    .split(/\s+x\d+\s+[¥￥]|店铺优惠抵扣|实付[：:]|实收[：:]/i)[0]
    .trim();
}

function readOrderCard(element, sequence) {
  const source = text(element.innerText || element.textContent, MAX_TEXT);
  if (!source) return null;
  const orderId = attribute(element, ['data-order-id', 'data-id'])
    || source.match(/订单编号\s*[：:]?\s*([\d\s-]{8,})/)?.[1]?.replace(/\s+/g, '')
    || null;
  if (!orderId) return null;
  const orderedAt = parseOrderTime(source);
  const status = normalizeOrderStatus(source);
  const rawStatus = source.match(/(?:待支付|待付款|待发货|待签收|已签收|已完成|交易成功|退款中|退货中|售后中|已退款|已取消|已关闭)/)?.[0] || '';
  const quantity = Number(source.match(/(?:^|\s)x(\d+)(?:\s|$)/i)?.[1] || 1);
  const productText = productTitleFromOrderSource(source);
  const imageUrl = orderCardImageUrl(element);
  return {
    platform_order_id: orderId.slice(0, 128),
    raw_status: rawStatus,
    status,
    ordered_at: orderedAt,
    products: productText ? [{
      title: productText.slice(0, 512),
      quantity,
      ...(imageUrl ? { image_url: imageUrl } : {}),
    }] : [],
    order_amount: parseMoney(source, '订单金额'),
    discount_amount: parseMoney(source, '店铺优惠抵扣'),
    paid_amount: parseMoney(source, '实付') ?? parseMoney(source, '实收'),
    after_sale: {
      text: source.match(/(?:退款中|退货中|售后中|已退款|退货包运费[^\s]*)/)?.[0] || '',
    },
    sequence,
    raw_text: source,
  };
}

function personalOrderPanelState() {
  const personalTab = findVisibleTextElement('个人订单', selectors.personalOrdersTab);
  const panel = personalTab?.closest?.('.right-panel-container') || document.querySelector('.right-panel-container');
  const value = text(panel?.innerText || panel?.textContent, 12000) || '';
  const filterCounts = [...value.matchAll(/(?:全部|未完成|待发货)\s*[（(]?\s*(\d+)\s*[）)]?/g)]
    .map((match) => Number(match[1]));
  const selected = Boolean(
    personalTab?.classList?.contains('bar-select')
    || personalTab?.getAttribute?.('aria-selected') === 'true'
  );
  const hasLoadingIndicator = panel ? [
    ...panel.querySelectorAll(
      '.ant-spin-spinning,.semi-spin,[aria-busy="true"],[class*="loading"],[class*="Loading"]',
    ),
  ].some(visibleElement) : false;
  const explicitEmptyText = /(?:(?:近\s*)?\d+\s*(?:天|个?月|年)\s*(?:内)?\s*)?(?:暂无|没有|无)(?:更多)?(?:个人)?订单|(?:当前客户|该客户)\s*(?:暂无|没有|无)(?:更多)?订单/.test(value);
  return {
    personal_tab_selected: selected,
    has_personal_filters: /全部\s*\d*\s+未完成\s*\d*\s+待发货/.test(value),
    filter_counts: filterCounts,
    filters_confirm_empty: filterCounts.length >= 3 && filterCounts.every((count) => count === 0),
    explicit_empty_text: explicitEmptyText,
    has_loading_indicator: hasLoadingIndicator,
    has_store_pending_notice: /店铺待支付订单不再提供聊天催付|您可使用催支付/.test(value),
    has_store_pending_action: /(?:^|\s)催支付(?:\s|$)/.test(value),
    has_personal_action: /查看说明书|查看视频|改价/.test(value),
    has_order_marker: /订单编号/.test(value),
    has_latest_orders_label: value.includes('最新订单'),
    has_personal_orders_label: value.includes('个人订单'),
    panel_text_length: value.length,
  };
}

async function waitForPersonalOrdersStable(timeoutMs = 3500) {
  const deadline = Date.now() + timeoutMs;
  let stableChecks = 0;
  let lastFingerprint = '';
  let state = personalOrderPanelState();
  while (Date.now() < deadline) {
    const next = personalOrderPanelState();
    const ready = next.personal_tab_selected
      && next.has_personal_filters
      && !next.has_store_pending_notice
      && !next.has_store_pending_action;
    const fingerprint = JSON.stringify(next);
    if (ready && fingerprint === lastFingerprint) stableChecks += 1;
    else stableChecks = ready ? 1 : 0;
    state = next;
    lastFingerprint = fingerprint;
    if (stableChecks >= 3) return { ready: true, state };
    await sleep(250);
  }
  return { ready: false, state };
}

async function collectCustomerOrders() {
  const observedAt = new Date().toISOString();
  let phase = 'find_latest_orders';
  diagnostic('order_collection_started', {
    location_host: location.hostname,
    location_path: location.pathname,
    iframe_count: document.querySelectorAll('iframe').length,
    latest_selector_hits: selectorHitCounts(selectors.latestOrdersTab),
    personal_selector_hits: selectorHitCounts(selectors.personalOrdersTab),
    label_candidates: orderLabelCandidates(),
  }, 'debug');
  try {
    const latestOrders = await waitForVisibleTextElement('最新订单', selectors.latestOrdersTab);
    if (!latestOrders) throw new Error('latest_orders_tab_not_found');
    diagnostic('order_latest_tab_found', { element: safeElementSummary(latestOrders) }, 'debug');
    latestOrders.click();
    phase = 'find_personal_orders';
    const personalOrders = await waitForVisibleTextElement('个人订单', selectors.personalOrdersTab);
    if (!personalOrders) throw new Error('personal_orders_tab_not_found');
    diagnostic('order_personal_tab_found', {
      element: safeElementSummary(personalOrders),
      label_candidates: orderLabelCandidates(),
    }, 'debug');
    personalOrders.click();
    phase = 'wait_personal_orders';
    await sleep(2000);
    const personalPanel = await waitForPersonalOrdersStable();
    diagnostic('order_personal_panel_stabilized', personalPanel, personalPanel.ready ? 'info' : 'warn');
    if (!personalPanel.ready) throw new Error('personal_orders_panel_not_stable');
    phase = 'read_order_cards';

    const configuredCards = queryCandidates(document, selectors.orderCards).filter(visibleElement);
    const fallbackCards = fallbackOrderCards();
    const candidates = configuredCards.length ? configuredCards : fallbackCards;
    const orders = candidates.map(readOrderCard).filter(Boolean);
    const uniqueOrders = [...new Map(orders.map((order) => [order.platform_order_id, order])).values()];
    diagnostic('order_cards_scanned', {
      configured_selector_hits: selectorHitCounts(selectors.orderCards),
      configured_visible_count: configuredCards.length,
      fallback_card_count: fallbackCards.length,
      selected_card_source: configuredCards.length ? 'configured' : 'fallback',
      selected_card_count: candidates.length,
      parsed_order_count: uniqueOrders.length,
      parsed_statuses: uniqueOrders.map((order) => order.status),
      candidate_shapes: candidates.slice(0, 5).map((element) => {
        const value = text(element.innerText || element.textContent, MAX_TEXT) || '';
        return {
          has_order_id: /订单编号\s*[：:]?\s*[\d-]{8,}/.test(value),
          has_order_time: /下单时间/.test(value),
          has_paid_amount: /实付\s*[：:]|实收\s*[：:]/.test(value),
          normalized_status: normalizeOrderStatus(value),
          text_length: value.length,
        };
      }),
      ...(!candidates.length ? { order_marker_diagnostics: orderMarkerDiagnostics() } : {}),
    }, uniqueOrders.length ? 'info' : 'warn');
    if (uniqueOrders.length) {
      diagnostic('order_collection_succeeded', {
        order_count: uniqueOrders.length,
        statuses: uniqueOrders.map((order) => order.status),
      });
      return {
        collection_status: 'success',
        observed_at: observedAt,
        orders: uniqueOrders,
        page_summary: { visible_count: uniqueOrders.length, total_count: uniqueOrders.length, has_more: false },
      };
    }
    const hasUnparsedOrder = personalPanel.state.has_order_marker;
    const explicitEmptyText = personalPanel.state.explicit_empty_text;
    // A stable personal-order panel with three zero filters is also a confirmed empty state.
    const explicitEmpty = !hasUnparsedOrder
      && !personalPanel.state.has_loading_indicator
      && (explicitEmptyText || personalPanel.state.filters_confirm_empty);
    diagnostic(explicitEmpty ? 'order_collection_empty' : 'order_collection_unavailable', {
      phase,
      error: explicitEmpty ? null : 'order_cards_and_empty_state_not_found',
      has_unparsed_order: hasUnparsedOrder,
      explicit_empty_text: explicitEmptyText,
      filters_confirm_empty: personalPanel.state.filters_confirm_empty,
      filter_counts: personalPanel.state.filter_counts,
      has_loading_indicator: personalPanel.state.has_loading_indicator,
      panel_has_latest_orders_label: personalPanel.state.has_latest_orders_label,
      panel_has_personal_orders_label: personalPanel.state.has_personal_orders_label,
      label_candidates: orderLabelCandidates(),
    }, explicitEmpty ? 'info' : 'warn');
    return {
      collection_status: explicitEmpty ? 'empty' : 'unavailable',
      observed_at: observedAt,
      orders: [],
      page_summary: { visible_count: 0, total_count: 0, has_more: false },
      ...(!explicitEmpty ? { error: 'order_cards_and_empty_state_not_found' } : {}),
    };
  } catch (error) {
    diagnostic('order_collection_unavailable', {
      phase,
      error: error?.message || String(error),
      latest_selector_hits: selectorHitCounts(selectors.latestOrdersTab),
      personal_selector_hits: selectorHitCounts(selectors.personalOrdersTab),
      label_candidates: orderLabelCandidates(),
      iframe_count: document.querySelectorAll('iframe').length,
    }, 'warn');
    return {
      collection_status: 'unavailable',
      observed_at: observedAt,
      orders: [],
      page_summary: { visible_count: 0, total_count: 0, has_more: false },
      error: error?.message || String(error),
    };
  }
}

function emit(type, payload = {}, observedAt = new Date().toISOString()) {
  ipcRenderer.send(CHANNEL, {
    version: 1,
    type,
    ...payload,
    observed_at: observedAt,
  });
}

let lastStatus = null;
let lastIdentity = null;
let pendingIdentity = null;
let lastShopInfoRefreshAt = 0;
let lastSnapshot = null;
let scanTimer = null;
let scanInProgress = false;
let scanRequested = false;
let manualPauseUntil = 0;
let storeActorBusy = false;
let collectUnreadRequested = false;
let apiSyncPollingRequested = false;
let apiLatestConversationsPollingRequested = false;
const pendingScanRequestIds = new Set();
const handledUnread = new Map();
const failedUnread = new Map();

function setApiSyncPollingEnabled(enabled, reason = 'unspecified') {
  if (apiSyncPollingRequested !== enabled) {
    apiSyncPollingRequested = enabled;
    window.postMessage({
      source: 'pdd-api-shadow-command',
      command: enabled ? 'start-sync-polling' : 'stop-sync-polling',
    }, '*');
    diagnostic(enabled ? 'api_sync_polling_started' : 'api_sync_polling_stopped', {
      reason,
      interval_ms: API_SYNC_POLL_INTERVAL_MS,
    }, 'debug');
  }
  if (apiLatestConversationsPollingRequested !== enabled) {
    apiLatestConversationsPollingRequested = enabled;
    window.postMessage({
      source: 'pdd-api-shadow-command',
      command: enabled ? 'start-latest-conversations-polling' : 'stop-latest-conversations-polling',
    }, '*');
    diagnostic(
      enabled ? 'api_latest_conversations_polling_started' : 'api_latest_conversations_polling_stopped',
      {
        reason,
        interval_ms: API_LATEST_CONVERSATIONS_POLL_INTERVAL_MS,
      },
      'debug',
    );
  }
}

function emitSnapshot(entries, verifiedActiveKey = null, force = false) {
  const observedAt = new Date().toISOString();
  const conversations = readSnapshot(observedAt, entries, verifiedActiveKey);
  if (!conversations.length) return false;
  const fingerprint = JSON.stringify(conversations);
  if (!force && fingerprint === lastSnapshot) return false;
  lastSnapshot = fingerprint;
  emit('snapshot', {
    snapshot_id: `pdd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    conversations,
  }, observedAt);
  const active = conversations.find((conversation) => conversation.active) || null;
  const messageCandidates = inspectMessageCandidates().diagnostics;
  diagnostic('snapshot_emitted', {
    force,
    conversation_count: conversations.length,
    active_conversation_key: active ? conversationKey(active) : null,
    active_message_count: active?.snapshot_messages?.length || 0,
    verified_active_key: verifiedActiveKey,
    message_candidates: messageCandidates,
  });
  return true;
}

function unreadVersion(entry) {
  return JSON.stringify([
    entry.conversation.unread_count,
    entry.conversation.latest_message_text || '',
  ]);
}

function unreadEntryBlockedReason(entry, now) {
  const version = unreadVersion(entry);
  const handledState = handledUnread.get(entry.key);
  if (handledState?.version === version) {
    if (now - handledState.at < HANDLED_UNREAD_RETRY_MS) return 'already_handled_preview';
    handledUnread.delete(entry.key);
    diagnostic('unread_handled_retry_elapsed', {
      conversation_key: entry.key,
      preview_text: entry.conversation.latest_message_text || '',
      unread_count: entry.conversation.unread_count,
      unread_version: version,
      elapsed_ms: now - handledState.at,
    }, 'debug');
  }
  const failedState = failedUnread.get(entry.key);
  if (
    failedState?.version === version
    && now - failedState.at < FAILED_SWITCH_COOLDOWN_MS
  ) {
    return 'failed_switch_cooldown';
  }
  return null;
}

function selectUnreadEntry(entries) {
  const now = Date.now();
  for (const entry of entries) {
    if (entry.conversation.unread_count === 0) {
      handledUnread.delete(entry.key);
      failedUnread.delete(entry.key);
    }
  }
  for (const [key, state] of failedUnread) {
    if (now - state.at > 60000) failedUnread.delete(key);
  }
  return entries.find((entry) => (
    entry.conversation.unread_count > 0
    && !unreadEntryBlockedReason(entry, now)
  )) || null;
}

function resolveConversationClickTarget(element) {
  const candidates = [
    element.querySelector('[role="button"]'),
    element.querySelector('button'),
    element.querySelector('a'),
    element.querySelector('[class*="item"]'),
    element,
    element.closest('li'),
    element.parentElement,
  ].filter(Boolean);
  return candidates.find((candidate) => {
    const rect = candidate.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }) || element;
}

function dispatchPointerLikeEvent(target, type, init) {
  const EventClass = type.startsWith('pointer') && typeof PointerEvent !== 'undefined'
    ? PointerEvent
    : MouseEvent;
  try {
    target.dispatchEvent(new EventClass(type, init));
  } catch {
    target.dispatchEvent(new MouseEvent(type, init));
  }
}

function clickConversationEntry(entry) {
  const target = resolveConversationClickTarget(entry.element);
  target.scrollIntoView({ block: 'center', inline: 'nearest' });
  const rect = target.getBoundingClientRect();
  const clientX = Math.max(1, Math.min(window.innerWidth - 1, rect.left + Math.min(rect.width / 2, 80)));
  const clientY = Math.max(1, Math.min(window.innerHeight - 1, rect.top + rect.height / 2));
  const init = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX,
    clientY,
    screenX: window.screenX + clientX,
    screenY: window.screenY + clientY,
    button: 0,
    buttons: 1,
  };
  try {
    target.focus({ preventScroll: true });
  } catch {
    // Some conversation containers are not focusable.
  }
  for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointerdown', 'mousedown']) {
    dispatchPointerLikeEvent(target, type, init);
  }
  for (const type of ['pointerup', 'mouseup']) {
    dispatchPointerLikeEvent(target, type, { ...init, buttons: 0 });
  }
  target.click();
  const summary = {
    conversation_key: entry.key,
    customer_name: entry.conversation.customer_name,
    target_tag: target.tagName?.toLowerCase() || null,
    target_class: `${target.className || ''}`.slice(0, 180),
    target_rect: [
      Math.round(rect.left),
      Math.round(rect.top),
      Math.round(rect.width),
      Math.round(rect.height),
    ],
  };
  diagnostic('unread_click_dispatched', summary);
  return summary;
}

function sleep(duration) {
  return new Promise((resolve) => setTimeout(resolve, duration));
}

async function waitForVerifiedSwitch(entry, beforeFingerprint, wasAlreadyActive) {
  const startedAt = Date.now();
  const deadline = Date.now() + SWITCH_TIMEOUT_MS;
  let stableFingerprint = null;
  let stableChecks = 0;
  let lastObserved = null;
  diagnostic('switch_verification_started', {
    conversation_key: entry.key,
    customer_name: entry.conversation.customer_name,
    was_already_active: wasAlreadyActive,
    before_message_area_length: beforeFingerprint.length,
    timeout_ms: SWITCH_TIMEOUT_MS,
  });
  while (Date.now() < deadline) {
    const entries = collectConversationEntries();
    const target = entries.find((candidate) => candidate.key === entry.key) || null;
    const active = activeConversationEntry(entries);
    const headerName = strictCurrentConversationName();
    const identityVerified = Boolean(
      target?.conversation.active
      || active?.key === entry.key
      || (headerName && headerName === entry.conversation.customer_name)
      || (entries.length === 1 && entries[0].key === entry.key),
    );
    const fingerprint = messageAreaFingerprint();
    const contentReady = hasVisibleMessages()
      && Boolean(fingerprint)
      && (wasAlreadyActive || fingerprint !== beforeFingerprint);
    lastObserved = {
      target_present: Boolean(target),
      target_active: Boolean(target?.conversation.active),
      active_conversation_key: active?.key || null,
      header_name: headerName,
      identity_verified: identityVerified,
      visible_messages: hasVisibleMessages(),
      message_area_changed: fingerprint !== beforeFingerprint,
      message_area_length: fingerprint.length,
      stable_checks: stableChecks,
    };
    if (identityVerified && contentReady) {
      if (stableFingerprint === fingerprint) stableChecks += 1;
      else {
        stableFingerprint = fingerprint;
        stableChecks = 1;
      }
      if (stableChecks >= 2) {
        diagnostic('switch_verification_succeeded', {
          conversation_key: entry.key,
          customer_name: entry.conversation.customer_name,
          elapsed_ms: Date.now() - startedAt,
          ...lastObserved,
          stable_checks: stableChecks,
        });
        return entries;
      }
    } else {
      stableFingerprint = null;
      stableChecks = 0;
    }
    await sleep(SWITCH_POLL_MS);
  }
  diagnostic('switch_verification_timed_out', {
    conversation_key: entry.key,
    customer_name: entry.conversation.customer_name,
    elapsed_ms: Date.now() - startedAt,
    last_observed: lastObserved,
  }, 'warn');
  return null;
}

async function processUnreadConversation(entry, entries) {
  const verifiedEntries = await processConversationEntry(entry, entries, { markUnread: true });
  return Boolean(verifiedEntries);
}

async function processConversationEntry(entry, entries, {
  markUnread = false,
  emitMessages = true,
  collectOrders = true,
} = {}) {
  const active = activeConversationEntry(entries);
  const wasAlreadyActive = Boolean(entry.conversation.active || active?.key === entry.key);
  const beforeFingerprint = messageAreaFingerprint();
  diagnostic(markUnread ? 'unread_processing_started' : 'conversation_collection_started', {
    conversation_key: entry.key,
    customer_name: entry.conversation.customer_name,
    unread_count: entry.conversation.unread_count,
    was_already_active: wasAlreadyActive,
    mark_unread: markUnread,
  });
  clickConversationEntry(entry);
  const verifiedEntries = await waitForVerifiedSwitch(entry, beforeFingerprint, wasAlreadyActive);
  if (!verifiedEntries) {
    if (markUnread) {
      failedUnread.set(entry.key, {
        version: unreadVersion(entry),
        at: Date.now(),
      });
    }
    diagnostic(markUnread ? 'unread_processing_failed' : 'conversation_collection_failed', {
      conversation_key: entry.key,
      customer_name: entry.conversation.customer_name,
      unread_count: entry.conversation.unread_count,
      reason: 'switch_not_verified',
      ...(markUnread ? { retry_cooldown_ms: FAILED_SWITCH_COOLDOWN_MS } : {}),
    }, 'warn');
    return null;
  }
  const activeEntry = verifiedEntries.find((candidate) => candidate.key === entry.key);
  let orderSnapshot = { collection_status: 'skipped', orders: [] };
  if (collectOrders) {
    orderSnapshot = await collectCustomerOrders();
    if (activeEntry) activeEntry.conversation.customer_orders = orderSnapshot;
  }
  const snapshotEmitted = emitMessages ? emitSnapshot(verifiedEntries, entry.key, true) : false;
  if (markUnread) {
    if (snapshotEmitted) {
      handledUnread.set(entry.key, {
        version: unreadVersion(entry),
        at: Date.now(),
      });
      failedUnread.delete(entry.key);
    } else {
      failedUnread.set(entry.key, {
        version: unreadVersion(entry),
        at: Date.now(),
      });
      diagnostic('unread_processing_not_marked_handled', {
        conversation_key: entry.key,
        customer_name: entry.conversation.customer_name,
        reason: 'snapshot_not_emitted',
        retry_cooldown_ms: FAILED_SWITCH_COOLDOWN_MS,
      }, 'warn');
    }
  }
  diagnostic(markUnread ? 'unread_processing_succeeded' : 'conversation_collection_succeeded', {
    conversation_key: entry.key,
    customer_name: entry.conversation.customer_name,
    unread_count: entry.conversation.unread_count,
    message_count: readSnapshotMessages(inspectMessageCandidates().elements).length,
    order_collection_status: orderSnapshot.collection_status,
    order_count: orderSnapshot.orders.length,
  });
  return verifiedEntries;
}

function findReplyInput() {
  return queryFirst(document, selectors.replyInput)
    || document.querySelector('#replyTextarea,#replyText,textarea,[contenteditable="true"]');
}

function injectReplyText(input, content) {
  input.focus();
  if ('value' in input) {
    const prototype = Object.getPrototypeOf(input);
    const descriptor = prototype && Object.getOwnPropertyDescriptor(prototype, 'value');
    if (descriptor?.set) descriptor.set.call(input, content);
    else input.value = content;
  } else {
    input.textContent = content;
  }
  input.dispatchEvent(new InputEvent('input', {
    bubbles: true,
    inputType: 'insertText',
    data: content,
  }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  const actual = 'value' in input ? String(input.value || '') : String(input.textContent || '');
  return actual === content || actual.includes(content);
}

function currentReplyText(input) {
  return 'value' in input ? String(input.value || '') : String(input.textContent || '');
}

function clickSendButton(button) {
  const rect = button.getBoundingClientRect();
  const init = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
    button: 0,
    buttons: 1,
  };
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
    dispatchPointerLikeEvent(button, type, { ...init, buttons: type.endsWith('up') ? 0 : 1 });
  }
  button.click();
}

function dispatchEnterToSend(input) {
  dispatchEnterOnce(input);
}

function dispatchEnterOnce(target) {
  const eventInit = {
    key: 'Enter',
    code: 'Enter',
    keyCode: 13,
    which: 13,
    charCode: 13,
    bubbles: true,
    cancelable: true,
    composed: true,
  };
  target?.focus?.();
  for (const type of ['keydown', 'keypress', 'keyup']) {
    target.dispatchEvent(new KeyboardEvent(type, eventInit));
  }
}

function findImageConfirmationDialog() {
  const candidates = queryCandidates(document, [
    '[role="dialog"]',
    '.ant-modal',
    '.semi-modal',
    '[class*="Modal"]',
    '[class*="modal"]',
    '[class*="Dialog"]',
    '[class*="dialog"]',
  ]);
  return candidates.find((candidate) => (
    isVisible(candidate)
    && (text(candidate.textContent, 4000) || '').includes('\u662f\u5426\u53d1\u9001\u56fe\u7247')
  )) || null;
}

function findImageConfirmationButton(dialog) {
  const selectorsInPriorityOrder = [
    'button',
    '[role="button"]',
    'input[type="button"]',
    'input[type="submit"]',
    '[class*="button"]',
    '[class*="Button"]',
  ];
  for (const selector of selectorsInPriorityOrder) {
    let candidates = [];
    try {
      candidates = [...dialog.querySelectorAll(selector)];
    } catch {
      continue;
    }
    const match = candidates.find((candidate) => (
      isVisible(candidate)
      && !candidate.disabled
      && (text(candidate.textContent || candidate.value, 32) || '') === '\u53d1\u9001'
    ));
    if (match) return match;
  }
  return null;
}

async function waitForImageConfirmationDialog(timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const dialog = findImageConfirmationDialog();
    if (dialog) return dialog;
    await sleep(100);
  }
  return findImageConfirmationDialog();
}

async function waitForDialogClosed(dialog, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!dialog.isConnected || !isVisible(dialog)) return true;
    await sleep(100);
  }
  return !dialog.isConnected || !isVisible(dialog);
}

function agentImageEvidence() {
  const messages = readSnapshotMessages(inspectMessageCandidates().elements)
    .filter((message) => message.sender_role === 'agent' && message.message_type === 'image');
  return {
    count: messages.length,
    identities: new Set(messages.map((message) => (
      message.platform_message_id || message.image_url || ''
    )).filter(Boolean)),
  };
}

function hasNewAgentImageEvidence(before) {
  const current = agentImageEvidence();
  return current.count > before.count
    || [...current.identities].some((identity) => !before.identities.has(identity));
}

function imageConfirmationFailed(dialog) {
  const content = text(dialog?.textContent, 4000) || '';
  return /\u4e0a\u4f20\u5931\u8d25|\u53d1\u9001\u5931\u8d25|\u7f51\u7edc\u5f02\u5e38|\u91cd\u8bd5\u4e0a\u4f20/.test(content);
}

async function waitForImageConfirmation(dialog, before, timeout = IMAGE_CONFIRMATION_HARD_TIMEOUT_MS) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!dialog.isConnected || !isVisible(dialog)) return 'dialog_closed';
    if (hasNewAgentImageEvidence(before)) return 'dom_echo';
    if (imageConfirmationFailed(dialog)) return 'failed';
    await sleep(200);
  }
  if (!dialog.isConnected || !isVisible(dialog)) return 'dialog_closed';
  if (hasNewAgentImageEvidence(before)) return 'dom_echo';
  return imageConfirmationFailed(dialog) ? 'failed' : 'pending';
}

async function waitForReplyInputEmpty(input, timeout = 1800) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!currentReplyText(input).trim()) return true;
    await sleep(100);
  }
  return !currentReplyText(input).trim();
}

async function prepareMessage(requestId, targetKey, customerName, content) {
  const deadline = Date.now() + 5000;
  let entries = collectConversationEntries();
  let entry = entries.find((candidate) => candidate.key === targetKey)
    || entries.find((candidate) => candidate.conversation.customer_name === customerName);
  while (!entry && Date.now() < deadline) {
    await sleep(200);
    entries = collectConversationEntries();
    entry = entries.find((candidate) => candidate.key === targetKey)
      || entries.find((candidate) => candidate.conversation.customer_name === customerName);
  }
  if (!entry) {
    emit('message_preparation_result', {
      request_id: requestId.slice(0, 128),
      status: 'not_found',
      conversation_key: targetKey.slice(0, 128),
      customer_name: null,
    });
    return;
  }
  try {
    const verifiedEntries = await processConversationEntry(entry, entries, {
      markUnread: false,
      emitMessages: false,
    });
    if (!verifiedEntries) {
      emit('message_preparation_result', {
        request_id: requestId.slice(0, 128),
        status: 'failed',
        conversation_key: entry.key,
        customer_name: entry.conversation.customer_name,
        error: 'conversation_switch_not_verified',
      });
      return;
    }
    const input = findReplyInput();
    if (!input || !isVisible(input)) {
      emit('message_preparation_result', {
        request_id: requestId.slice(0, 128),
        status: 'failed',
        conversation_key: entry.key,
        customer_name: entry.conversation.customer_name,
        error: 'reply_input_missing',
      });
      return;
    }
    const prepared = injectReplyText(input, content);
    diagnostic('message_preparation_input_injected', {
      conversation_key: entry.key,
      customer_name: entry.conversation.customer_name,
      prepared,
      content_length: content.length,
      send_triggered: false,
    });
    emit('message_preparation_result', {
      request_id: requestId.slice(0, 128),
      status: prepared ? 'prepared' : 'failed',
      conversation_key: entry.key,
      customer_name: entry.conversation.customer_name,
      error: prepared ? null : 'reply_input_value_verification_failed',
    });
  } catch (error) {
    diagnostic('message_preparation_exception', {
      request_id: requestId.slice(0, 128),
      conversation_key: entry.key,
      error_name: error?.name || 'Error',
      error: error?.message || String(error),
    }, 'error');
    emit('message_preparation_result', {
      request_id: requestId.slice(0, 128),
      status: 'failed',
      conversation_key: entry.key,
      customer_name: entry.conversation.customer_name,
      error: 'message_preparation_exception',
    });
  }
}

async function sendMessage(requestId, targetKey, customerName, content) {
  while (scanInProgress) await sleep(50);
  const deadline = Date.now() + 5000;
  let entries = collectConversationEntries();
  let entry = entries.find((candidate) => candidate.key === targetKey)
    || entries.find((candidate) => candidate.conversation.customer_name === customerName);
  while (!entry && Date.now() < deadline) {
    await sleep(200);
    entries = collectConversationEntries();
    entry = entries.find((candidate) => candidate.key === targetKey)
      || entries.find((candidate) => candidate.conversation.customer_name === customerName);
  }
  if (!entry) {
    emit('message_send_result', {
      request_id: requestId.slice(0, 128),
      status: 'not_found',
      conversation_key: targetKey.slice(0, 128),
      customer_name: null,
    });
    return;
  }
  try {
    const verifiedEntries = await processConversationEntry(entry, entries, {
      markUnread: false,
      emitMessages: false,
    });
    if (!verifiedEntries) {
      emit('message_send_result', {
        request_id: requestId.slice(0, 128),
        status: 'failed',
        conversation_key: entry.key,
        customer_name: entry.conversation.customer_name,
        error: 'conversation_switch_not_verified',
      });
      return;
    }
    const input = findReplyInput();
    if (!input || !isVisible(input)) {
      emit('message_send_result', {
        request_id: requestId.slice(0, 128),
        status: 'failed',
        conversation_key: entry.key,
        customer_name: entry.conversation.customer_name,
        error: 'reply_input_missing',
      });
      return;
    }
    if (!injectReplyText(input, content)) {
      emit('message_send_result', {
        request_id: requestId.slice(0, 128),
        status: 'failed',
        conversation_key: entry.key,
        customer_name: entry.conversation.customer_name,
        error: 'reply_input_value_verification_failed',
      });
      return;
    }

    dispatchEnterToSend(input);
    const method = 'enter';
    const sent = await waitForReplyInputEmpty(input);
    diagnostic('message_send_attempt_completed', {
      conversation_key: entry.key,
      customer_name: entry.conversation.customer_name,
      sent,
      method,
      enter_attempted: true,
      content_length: content.length,
    });
    emit('message_send_result', {
      request_id: requestId.slice(0, 128),
      status: sent ? 'sent' : 'failed',
      conversation_key: entry.key,
      customer_name: entry.conversation.customer_name,
      method,
      error: sent ? null : 'reply_input_not_cleared_after_enter',
    });
  } catch (error) {
    diagnostic('message_send_exception', {
      request_id: requestId.slice(0, 128),
      conversation_key: entry.key,
      error_name: error?.name || 'Error',
      error: error?.message || String(error),
    }, 'error');
    emit('message_send_result', {
      request_id: requestId.slice(0, 128),
      status: 'failed',
      conversation_key: entry.key,
      customer_name: entry.conversation.customer_name,
      error: 'message_send_exception',
    });
  }
}

async function prepareImage(requestId, targetKey, customerName) {
  const deadline = Date.now() + 5000;
  let entries = collectConversationEntries();
  let entry = entries.find((candidate) => candidate.key === targetKey)
    || entries.find((candidate) => candidate.conversation.customer_name === customerName);
  while (!entry && Date.now() < deadline) {
    await sleep(200);
    entries = collectConversationEntries();
    entry = entries.find((candidate) => candidate.key === targetKey)
      || entries.find((candidate) => candidate.conversation.customer_name === customerName);
  }
  if (!entry) {
    emit('image_preparation_result', {
      request_id: requestId.slice(0, 128),
      status: 'not_found',
      conversation_key: targetKey.slice(0, 128),
      customer_name: null,
    });
    return;
  }
  try {
    const verifiedEntries = await processConversationEntry(entry, entries, {
      markUnread: false,
      emitMessages: false,
    });
    const input = findReplyInput();
    if (!verifiedEntries || !input || !isVisible(input)) {
      emit('image_preparation_result', {
        request_id: requestId.slice(0, 128),
        status: 'failed',
        conversation_key: entry.key,
        customer_name: entry.conversation.customer_name,
        error: !verifiedEntries ? 'conversation_switch_not_verified' : 'reply_input_missing',
      });
      return;
    }
    input.focus();
    emit('image_preparation_result', {
      request_id: requestId.slice(0, 128),
      status: 'ready',
      conversation_key: entry.key,
      customer_name: entry.conversation.customer_name,
    });
  } catch (error) {
    emit('image_preparation_result', {
      request_id: requestId.slice(0, 128),
      status: 'failed',
      conversation_key: entry.key,
      customer_name: entry.conversation.customer_name,
      error: error?.message || String(error),
    });
  }
}

function currentConversationMatches(targetKey, customerName) {
  const entries = collectConversationEntries();
  const active = activeConversationEntry(entries);
  const target = entries.find((entry) => entry.key === targetKey);
  const headerName = strictCurrentConversationName();
  return Boolean(
    target?.conversation.active
    || active?.key === targetKey
    || (customerName && headerName === customerName)
    || (entries.length === 1 && entries[0].key === targetKey)
  );
}

function prepareImageInCurrentConversation(requestId, targetKey, customerName) {
  try {
    if (!currentConversationMatches(targetKey, customerName)) {
      throw new Error('active_conversation_changed_before_image');
    }
    const input = findReplyInput();
    if (!input || !isVisible(input)) throw new Error('reply_input_missing');
    input.focus();
    emit('image_preparation_result', {
      request_id: requestId.slice(0, 128),
      status: 'ready',
      conversation_key: targetKey,
      customer_name: customerName,
    });
  } catch (error) {
    emit('image_preparation_result', {
      request_id: requestId.slice(0, 128),
      status: 'failed',
      error: error?.message || String(error),
    });
  }
}

async function sendImageEnter(requestId, targetKey = '', customerName = '') {
  try {
    if (targetKey && !currentConversationMatches(targetKey, customerName)) {
      throw new Error('active_conversation_changed_before_image_send');
    }
    const input = findReplyInput();
    if (!input || !isVisible(input)) throw new Error('reply_input_missing');
    const dialog = await waitForImageConfirmationDialog();
    if (!dialog) throw new Error('image_confirmation_modal_not_found');
    const imageEvidenceBeforeSend = agentImageEvidence();
    diagnostic('image_confirmation_modal_detected', {
      request_id: requestId.slice(0, 128),
      conversation_key: targetKey || null,
    });
    const confirmButton = findImageConfirmationButton(dialog);
    let method = 'modal-enter';
    if (confirmButton) {
      clickSendButton(confirmButton);
      method = 'modal-confirm-click';
      diagnostic('image_confirmation_clicked', {
        request_id: requestId.slice(0, 128),
        conversation_key: targetKey || null,
      });
    } else {
      dispatchEnterOnce(document.activeElement || dialog);
      diagnostic('image_confirmation_enter_fallback', {
        request_id: requestId.slice(0, 128),
        conversation_key: targetKey || null,
      }, 'warn');
    }
    const confirmation = await waitForImageConfirmation(dialog, imageEvidenceBeforeSend);
    if (confirmation === 'failed') {
      throw new Error('image_confirmation_reported_failure');
    }
    if (confirmation === 'pending') {
      diagnostic('image_confirmation_pending', {
        request_id: requestId.slice(0, 128),
        conversation_key: targetKey || null,
        method,
      }, 'warn');
      emit('image_send_result', {
        request_id: requestId.slice(0, 128),
        status: 'pending',
        method,
        confirmation: 'pending',
      });
      return;
    }
    diagnostic('image_confirmation_completed', {
      request_id: requestId.slice(0, 128),
      conversation_key: targetKey || null,
      method,
      confirmation,
    });
    emit('image_send_result', {
      request_id: requestId.slice(0, 128),
      status: 'sent',
      method,
      confirmation,
    });
  } catch (error) {
    diagnostic('image_confirmation_failed', {
      request_id: requestId.slice(0, 128),
      conversation_key: targetKey || null,
      error: error?.message || String(error),
    }, 'error');
    emit('image_send_result', {
      request_id: requestId.slice(0, 128),
      status: 'failed',
      error: error?.message || String(error),
    });
  }
}

async function waitForImagePaste(requestId, targetKey = '', customerName = '') {
  try {
    if (targetKey && !currentConversationMatches(targetKey, customerName)) {
      throw new Error('active_conversation_changed_before_image_paste');
    }
    const dialog = await waitForImageConfirmationDialog();
    if (!dialog) throw new Error('image_confirmation_modal_not_found');
    emit('image_paste_result', {
      request_id: requestId.slice(0, 128),
      status: 'ready',
    });
  } catch (error) {
    emit('image_paste_result', {
      request_id: requestId.slice(0, 128),
      status: 'failed',
      error: error?.message || String(error),
    });
  }
}

function conversationCandidate(entry) {
  return {
    conversation_key: entry.key,
    external_conversation_id: entry.conversation.external_conversation_id,
    customer_name: entry.conversation.customer_name || entry.conversation.title || '未知客户',
    preview_text: entry.conversation.latest_message_text,
    unread_count: entry.conversation.unread_count,
    active: entry.conversation.active,
    avatar_url: entry.conversation.avatar_url,
  };
}

async function emitConversationCandidates(requestId) {
  const deadline = Date.now() + 5000;
  let entries = collectConversationEntries();
  while (!entries.length && Date.now() < deadline) {
    await sleep(200);
    entries = collectConversationEntries();
  }
  emit('conversation_candidates', {
    request_id: requestId.slice(0, 128),
    conversations: entries.slice(0, 200).map(conversationCandidate),
  });
  diagnostic('conversation_candidates_emitted', {
    request_id: requestId.slice(0, 128),
    conversation_count: entries.length,
  });
}

async function collectConversation(requestId, targetKey) {
  const deadline = Date.now() + 5000;
  let entries = collectConversationEntries();
  let entry = entries.find((candidate) => candidate.key === targetKey);
  while (!entry && Date.now() < deadline) {
    await sleep(200);
    entries = collectConversationEntries();
    entry = entries.find((candidate) => candidate.key === targetKey);
  }
  if (!entry) {
    emit('conversation_collection_result', {
      request_id: requestId.slice(0, 128),
      status: 'not_found',
      conversation_key: targetKey.slice(0, 128),
      customer_name: null,
    });
    return;
  }
  try {
    const verifiedEntries = await processConversationEntry(entry, entries, { markUnread: false });
    emit('conversation_collection_result', {
      request_id: requestId.slice(0, 128),
      status: verifiedEntries ? 'collected' : 'failed',
      conversation_key: entry.key,
      customer_name: entry.conversation.customer_name,
    });
  } catch (error) {
    diagnostic('conversation_collection_exception', {
      request_id: requestId.slice(0, 128),
      conversation_key: entry.key,
      error_name: error?.name || 'Error',
      error: error?.message || String(error),
    }, 'error');
    emit('conversation_collection_result', {
      request_id: requestId.slice(0, 128),
      status: 'failed',
      conversation_key: entry.key,
      customer_name: entry.conversation.customer_name,
    });
  }
}

async function switchConversationOnly(requestId, targetKey, customerName = '') {
  const deadline = Date.now() + 5000;
  let entries = collectConversationEntries();
  let entry = entries.find((candidate) => candidate.key === targetKey)
    || entries.find((candidate) => (
      customerName && candidate.conversation.customer_name === customerName
    ));
  while (!entry && Date.now() < deadline) {
    await sleep(200);
    entries = collectConversationEntries();
    entry = entries.find((candidate) => candidate.key === targetKey)
      || entries.find((candidate) => (
        customerName && candidate.conversation.customer_name === customerName
      ));
  }
  if (!entry) {
    emit('conversation_switch_result', {
      request_id: requestId.slice(0, 128),
      status: 'not_found',
      conversation_key: targetKey.slice(0, 128),
      customer_name: customerName ? customerName.slice(0, 128) : null,
      resolved_conversation_key: null,
    });
    return;
  }
  try {
    const verifiedEntries = await processConversationEntry(entry, entries, {
      markUnread: false,
      emitMessages: false,
      collectOrders: false,
    });
    const activeEntry = Array.isArray(verifiedEntries) ? activeConversationEntry(verifiedEntries) : null;
    emit('conversation_switch_result', {
      request_id: requestId.slice(0, 128),
      status: verifiedEntries ? 'switched' : 'failed',
      conversation_key: targetKey.slice(0, 128),
      customer_name: entry.conversation.customer_name,
      resolved_conversation_key: activeEntry?.key || entry.key,
      resolved_customer_name: activeEntry?.conversation?.customer_name || entry.conversation.customer_name,
      preview_text: activeEntry?.conversation?.latest_message_text || entry.conversation.latest_message_text || null,
    });
  } catch (error) {
    diagnostic('conversation_switch_exception', {
      request_id: requestId.slice(0, 128),
      conversation_key: entry.key,
      error_name: error?.name || 'Error',
      error: error?.message || String(error),
    }, 'error');
    emit('conversation_switch_result', {
      request_id: requestId.slice(0, 128),
      status: 'failed',
      conversation_key: targetKey.slice(0, 128),
      customer_name: entry.conversation.customer_name,
      resolved_conversation_key: entry.key,
      error: error?.message || String(error),
    });
  }
}

function apiCustomerUidFromConversationKey(value) {
  const key = text(value, 128);
  if (!key || key.startsWith('name:')) return null;
  return key;
}

function collectConversationViaApi(requestId, targetKey) {
  const customerUid = apiCustomerUidFromConversationKey(targetKey);
  const entry = collectConversationEntries().find((candidate) => candidate.key === targetKey) || null;
  if (!customerUid) {
    emit('api_chat_list_result', {
      request_id: requestId.slice(0, 128),
      status: 'failed',
      conversation_key: targetKey.slice(0, 128),
      customer_uid: null,
      customer_name: entry?.conversation?.customer_name || null,
      avatar_url: entry?.conversation?.avatar_url || null,
      error: 'target_customer_uid_missing',
    });
    return;
  }
  diagnostic('api_chat_list_requested', {
    request_id: requestId.slice(0, 128),
    conversation_key: targetKey.slice(0, 128),
    customer_uid: customerUid,
    has_dom_conversation_entry: Boolean(entry),
  });
  window.postMessage({
    source: 'pdd-api-shadow-command',
    command: 'chat-list',
    requestId: requestId.slice(0, 128),
    conversationKey: targetKey.slice(0, 128),
    customerUid,
    customerName: entry?.conversation?.customer_name || null,
    avatarUrl: entry?.conversation?.avatar_url || null,
    size: 50,
  }, '*');
}

function latestConversationsViaApi(requestId, purpose = 'import-candidates') {
  diagnostic('api_latest_conversations_requested', {
    request_id: requestId.slice(0, 128),
    purpose: text(purpose, 64),
  });
  window.postMessage({
    source: 'pdd-api-shadow-command',
    command: 'latest-conversations',
    requestId: requestId.slice(0, 128),
    purpose: text(purpose, 64),
    page: 1,
    size: 100,
  }, '*');
}

function shopInfoViaApi(requestId, purpose = 'identity') {
  diagnostic('api_shop_info_requested', {
    request_id: requestId.slice(0, 128),
    purpose: text(purpose, 64),
  });
  window.postMessage({
    source: 'pdd-api-shadow-command',
    command: 'shop-info',
    requestId: requestId.slice(0, 128),
    purpose: text(purpose, 64),
  }, '*');
}

function collectCustomerOrdersViaApi(requestId, targetKey, customerName = '') {
  const customerUid = apiCustomerUidFromConversationKey(targetKey);
  if (!customerUid) {
    emit('api_customer_orders_result', {
      request_id: requestId.slice(0, 128),
      status: 'failed',
      conversation_key: targetKey.slice(0, 128),
      customer_uid: null,
      customer_name: text(customerName, 128),
      error: 'target_customer_uid_missing',
    });
    return;
  }
  const entry = collectConversationEntries().find((candidate) => candidate.key === targetKey) || null;
  diagnostic('api_customer_orders_requested', {
    request_id: requestId.slice(0, 128),
    conversation_key: targetKey.slice(0, 128),
    customer_uid: customerUid,
    has_dom_conversation_entry: Boolean(entry),
  });
  window.postMessage({
    source: 'pdd-api-shadow-command',
    command: 'customer-orders',
    requestId: requestId.slice(0, 128),
    conversationKey: targetKey.slice(0, 128),
    customerUid,
    customerName: text(customerName, 128) || entry?.conversation?.customer_name || null,
    page: 1,
    size: 10,
  }, '*');
}

function collectCustomerProductsViaApi(requestId, targetKey, customerName = '') {
  const customerUid = apiCustomerUidFromConversationKey(targetKey);
  const entry = collectConversationEntries().find((candidate) => candidate.key === targetKey) || null;
  const conversationKey = text(targetKey, 128) || customerUid || 'shop';
  diagnostic('api_customer_products_requested', {
    request_id: requestId.slice(0, 128),
    conversation_key: conversationKey,
    customer_uid: customerUid || null,
    has_dom_conversation_entry: Boolean(entry),
  });
  window.postMessage({
    source: 'pdd-api-shadow-command',
    command: 'customer-products',
    requestId: requestId.slice(0, 128),
    conversationKey,
    customerUid: customerUid || '',
    customerName: text(customerName, 128) || entry?.conversation?.customer_name || null,
    page: 1,
    size: 10,
  }, '*');
}

function collectPlatformPhrasesViaApi(requestId, source = 'personal') {
  const normalizedSource = source === 'team' ? 'team' : 'personal';
  diagnostic('api_platform_phrases_requested', {
    request_id: requestId.slice(0, 128),
    source: normalizedSource,
    api_shadow_version: API_SHADOW_VERSION,
  });
  window.postMessage({
    source: 'pdd-api-shadow-command',
    command: 'platform-phrases',
    requestId: requestId.slice(0, 128),
    phraseSource: normalizedSource,
    apiShadowVersion: API_SHADOW_VERSION,
  }, '*');
}

function sendMessageViaApi(requestId, targetKey, customerName, content, quoteMessageId = null) {
  const customerUid = apiCustomerUidFromConversationKey(targetKey);
  if (!customerUid) {
    emit('api_message_send_result', {
      request_id: requestId.slice(0, 128),
      status: 'failed',
      conversation_key: targetKey.slice(0, 128),
      customer_uid: null,
      customer_name: customerName.slice(0, 128),
      error: 'target_customer_uid_missing',
    });
    return;
  }
  diagnostic('api_message_send_requested', {
    request_id: requestId.slice(0, 128),
    conversation_key: targetKey.slice(0, 128),
    customer_uid: customerUid,
    content_length: content.length,
    quote_msg_id_present: Boolean(quoteMessageId),
  });
  window.postMessage({
    source: 'pdd-api-shadow-command',
    command: 'send-message',
    requestId: requestId.slice(0, 128),
    conversationKey: targetKey.slice(0, 128),
    customerUid,
    customerName: customerName.slice(0, 128),
    content: content.slice(0, 4000),
    quoteMessageId: quoteMessageId ? String(quoteMessageId).slice(0, 128) : null,
  }, '*');
}

function listTransferCsViaApi(requestId) {
  diagnostic('api_transfer_cs_list_requested', {
    request_id: requestId.slice(0, 128),
  });
  window.postMessage({
    source: 'pdd-api-shadow-command',
    command: 'list-transfer-cs',
    requestId: requestId.slice(0, 128),
  }, '*');
}

function transferConversationViaApi(requestId, targetKey, customerName, transReason = '无原因直接转移', targetCsid = '', autoTransfer = false) {
  const customerUid = apiCustomerUidFromConversationKey(targetKey);
  if (!customerUid) {
    emit('api_conversation_transfer_result', {
      request_id: requestId.slice(0, 128),
      status: 'failed',
      conversation_key: targetKey.slice(0, 128),
      customer_uid: null,
      customer_name: customerName.slice(0, 128),
      trans_reason: text(transReason, 128) || '无原因直接转移',
      error: 'target_customer_uid_missing',
    });
    return;
  }
  diagnostic('api_conversation_transfer_requested', {
    request_id: requestId.slice(0, 128),
    conversation_key: targetKey.slice(0, 128),
    customer_uid: customerUid,
  });
  window.postMessage({
    source: 'pdd-api-shadow-command',
    command: 'transfer-conversation',
    requestId: requestId.slice(0, 128),
    conversationKey: targetKey.slice(0, 128),
    customerUid,
    customerName: customerName.slice(0, 128),
    transReason: text(transReason, 128) || '无原因直接转移',
    targetCsid: text(targetCsid, 128),
    autoTransfer: autoTransfer === true,
  }, '*');
}

function sendProductViaApi(requestId, targetKey, customerName, productId) {
  const customerUid = apiCustomerUidFromConversationKey(targetKey);
  const normalizedProductId = text(productId, 128);
  if (!customerUid || !normalizedProductId) {
    emit('api_product_send_result', {
      request_id: requestId.slice(0, 128),
      status: 'failed',
      conversation_key: targetKey.slice(0, 128),
      customer_uid: customerUid || null,
      customer_name: customerName.slice(0, 128),
      product_id: normalizedProductId || null,
      error: !customerUid ? 'target_customer_uid_missing' : 'product_id_missing',
    });
    return;
  }
  diagnostic('api_product_send_requested', {
    request_id: requestId.slice(0, 128),
    conversation_key: targetKey.slice(0, 128),
    customer_uid: customerUid,
    product_id: normalizedProductId,
  });
  window.postMessage({
    source: 'pdd-api-shadow-command',
    command: 'send-product',
    requestId: requestId.slice(0, 128),
    conversationKey: targetKey.slice(0, 128),
    customerUid,
    customerName: customerName.slice(0, 128),
    productId: normalizedProductId,
  }, '*');
}

function sendImageViaApi(requestId, targetKey, customerName, imageDataUrl, imageMeta = {}) {
  const customerUid = apiCustomerUidFromConversationKey(targetKey);
  if (!customerUid) {
    emit('api_image_send_result', {
      request_id: requestId.slice(0, 128),
      status: 'failed',
      conversation_key: targetKey.slice(0, 128),
      customer_uid: null,
      customer_name: customerName.slice(0, 128),
      error: 'target_customer_uid_missing',
    });
    return;
  }
  diagnostic('api_image_send_requested', {
    request_id: requestId.slice(0, 128),
    conversation_key: targetKey.slice(0, 128),
    customer_uid: customerUid,
    image_bytes: Number(imageMeta.byteSize) || null,
    width: Number(imageMeta.width) || null,
    height: Number(imageMeta.height) || null,
    quote_msg_id_present: Boolean(imageMeta.quoteMessageId),
  });
  window.postMessage({
    source: 'pdd-api-shadow-command',
    command: 'send-image',
    requestId: requestId.slice(0, 128),
    conversationKey: targetKey.slice(0, 128),
    customerUid,
    customerName: customerName.slice(0, 128),
    imageDataUrl,
    width: Number(imageMeta.width) || null,
    height: Number(imageMeta.height) || null,
    byteSize: Number(imageMeta.byteSize) || null,
    quoteMessageId: imageMeta.quoteMessageId ? String(imageMeta.quoteMessageId).slice(0, 128) : null,
  }, '*');
}

async function collectNextUnread(requestId) {
  if (!DOM_CONVERSATION_SCAN_ENABLED) {
    collectUnreadRequested = false;
    emit('unread_collection_result', {
      request_id: requestId.slice(0, 128),
      status: 'disabled',
      reason: 'dom_conversation_scan_disabled',
    });
    diagnostic('unread_collection_disabled', {
      reason: 'dom_conversation_scan_disabled',
    }, 'debug');
    return;
  }
  try {
    while (scanInProgress) await sleep(50);
    const entries = collectConversationEntries();
    const entry = selectUnreadEntry(entries);
    if (!entry) {
      emit('unread_collection_result', {
        request_id: requestId.slice(0, 128),
        status: 'empty',
      });
      return;
    }
    if (Date.now() < manualPauseUntil) {
      emit('unread_collection_result', {
        request_id: requestId.slice(0, 128),
        status: 'paused',
        conversation_key: entry.key,
      });
      return;
    }
    const collected = await processUnreadConversation(entry, entries);
    emit('unread_collection_result', {
      request_id: requestId.slice(0, 128),
      status: collected ? 'collected' : 'failed',
      conversation_key: entry.key,
      customer_name: entry.conversation.customer_name,
    });
  } catch (error) {
    emit('unread_collection_result', {
      request_id: requestId.slice(0, 128),
      status: 'failed',
      error: error?.message || String(error),
    });
  } finally {
    collectUnreadRequested = false;
  }
}

function acknowledgeUnreadApiBackfill(targetKey, customerName = '', domTargetKey = '') {
  if (!DOM_CONVERSATION_SCAN_ENABLED) {
    collectUnreadRequested = false;
    diagnostic('dom_unread_api_backfill_acknowledged', {
      conversation_key: text(targetKey, 128) || null,
      dom_conversation_key: text(domTargetKey, 128) || null,
      customer_name: text(customerName, 128) || null,
      clicked: false,
      skipped_click_reason: 'dom_conversation_scan_disabled',
    }, 'debug');
    return;
  }
  try {
    const key = text(targetKey, 128);
    const domKey = text(domTargetKey, 128);
    const entries = collectConversationEntries();
    const entry = entries.find((candidate) => candidate.key === domKey)
      || entries.find((candidate) => candidate.key === key)
      || null;
    collectUnreadRequested = false;
    if (!entry) {
      diagnostic('dom_unread_api_backfill_ack_failed', {
        conversation_key: key || null,
        dom_conversation_key: domKey || null,
        customer_name: text(customerName, 128) || null,
        reason: 'conversation_entry_not_found',
      }, 'warn');
      return;
    }
    handledUnread.set(entry.key, {
      version: unreadVersion(entry),
      at: Date.now(),
    });
    failedUnread.delete(entry.key);
    let clicked = false;
    if (Date.now() >= manualPauseUntil) {
      clickConversationEntry(entry);
      clicked = true;
      scheduleScan(300, 'api_unread_backfill_ack');
    }
    diagnostic('dom_unread_api_backfill_acknowledged', {
      conversation_key: entry.key,
      customer_name: entry.conversation.customer_name || text(customerName, 128) || null,
      unread_count: entry.conversation.unread_count,
      unread_version: unreadVersion(entry),
      clicked,
      skipped_click_reason: clicked ? null : 'manual_activity_pause',
    });
  } catch (error) {
    collectUnreadRequested = false;
    diagnostic('dom_unread_api_backfill_ack_failed', {
      conversation_key: text(targetKey, 128) || null,
      dom_conversation_key: text(domTargetKey, 128) || null,
      customer_name: text(customerName, 128) || null,
      error_name: error?.name || 'Error',
      error: error?.message || String(error),
    }, 'warn');
  }
}

async function scan() {
  scanTimer = null;
  if (storeActorBusy && pendingScanRequestIds.size === 0) {
    emit('rescan_requested', { reason: scheduledScanReason });
    diagnostic('scan_deferred_for_store_actor', { reason: scheduledScanReason }, 'debug');
    return;
  }
  if (scanInProgress) {
    scanRequested = true;
    diagnostic('scan_deferred_busy', { reason: scheduledScanReason }, 'debug');
    return;
  }
  scanInProgress = true;
  const scanRequestIds = [...pendingScanRequestIds];
  for (const requestId of scanRequestIds) pendingScanRequestIds.delete(requestId);
  const scanReason = scheduledScanReason;
  scheduledScanReason = 'unspecified';
  try {
    diagnostic('scan_started', {
      reason: scanReason,
      page_path: `${location.origin}${location.pathname}`,
      manual_pause_remaining_ms: Math.max(0, manualPauseUntil - Date.now()),
    }, 'debug');
    const status = currentPageStatus();
    if (status !== lastStatus) {
      lastStatus = status;
      emit('status', { status, page_path: `${location.origin}${location.pathname}` });
      diagnostic('page_status_changed', {
        status,
        page_path: `${location.origin}${location.pathname}`,
      });
    }
    if (status !== 'online') {
      pendingIdentity = null;
      setApiSyncPollingEnabled(false, status);
      return;
    }
    setApiSyncPollingEnabled(true, 'page_online');
    const identity = accountIdentity();
    if (!identity?.external_account_id && !identity?.account_name) {
      const now = Date.now();
      if (now - lastShopInfoRefreshAt >= SHOP_INFO_REFRESH_INTERVAL_MS) {
        lastShopInfoRefreshAt = now;
        shopInfoViaApi(`shop-info-auto-${now.toString(36)}`, 'auto-identity');
      }
    }
    const identityFingerprint = JSON.stringify(identity);
    if (!identity || identityFingerprint === lastIdentity) {
      pendingIdentity = null;
    } else if (pendingIdentity?.fingerprint !== identityFingerprint) {
      pendingIdentity = {
        fingerprint: identityFingerprint,
        identity,
        firstSeenAt: Date.now(),
      };
      diagnostic('identity_candidate_observed', {
        has_external_account_id: Boolean(identity.external_account_id),
        has_account_name: Boolean(identity.account_name),
        account_name_length: identity.account_name?.length || 0,
        account_name_source: identity.account_name_source || null,
        stable_for_ms: IDENTITY_STABLE_MS,
      }, 'debug');
    } else if (Date.now() - pendingIdentity.firstSeenAt >= IDENTITY_STABLE_MS) {
      lastIdentity = pendingIdentity.fingerprint;
      emit('identity', pendingIdentity.identity);
      diagnostic('identity_emitted', {
        has_external_account_id: Boolean(pendingIdentity.identity.external_account_id),
        has_account_name: Boolean(pendingIdentity.identity.account_name),
        account_name_length: pendingIdentity.identity.account_name?.length || 0,
        account_name_source: pendingIdentity.identity.account_name_source || null,
      });
      pendingIdentity = null;
    }
    if (!DOM_CONVERSATION_SCAN_ENABLED) {
      diagnostic('dom_conversation_scan_disabled', {
        reason: scanReason,
        api_latest_conversations_polling: true,
      }, 'debug');
      return;
    }
    const entries = collectConversationEntries();
    const entrySummary = entries.slice(0, 30).map((entry) => ({
      sequence: entry.sequence,
      conversation_key: entry.key,
      customer_name: entry.conversation.customer_name,
      preview_text: entry.conversation.latest_message_text || '',
      preview_text_length: (entry.conversation.latest_message_text || '').length,
      unread_version: unreadVersion(entry),
      unread_count: entry.conversation.unread_count,
      active: entry.conversation.active,
      visible: entry.visible,
      source_count: entry.sourceCount,
    }));
    diagnostic('conversation_scan_completed', {
      conversation_count: entries.length,
      unread_count: entries.filter((entry) => entry.conversation.unread_count > 0).length,
      conversations: entrySummary,
      conversation_selector_hits: selectorHitCounts(selectors.conversationItems),
      unread_selector_hits: selectorHitCounts(selectors.unreadBadge),
      message_candidate_filter: inspectMessageCandidates().diagnostics,
    }, entries.length ? 'info' : 'warn');
    if (!entries.length) return;
    const unreadEntry = selectUnreadEntry(entries);
    if (unreadEntry) {
      if (Date.now() < manualPauseUntil) {
        diagnostic('unread_processing_paused_for_manual_activity', {
          conversation_key: unreadEntry.key,
          remaining_ms: manualPauseUntil - Date.now(),
        }, 'debug');
        return;
      }
      diagnostic('unread_target_selected', {
        conversation_key: unreadEntry.key,
        customer_name: unreadEntry.conversation.customer_name,
        unread_count: unreadEntry.conversation.unread_count,
        sequence: unreadEntry.sequence,
        active: unreadEntry.conversation.active,
      });
    } else if (entries.some((entry) => entry.conversation.unread_count > 0)) {
      const now = Date.now();
      diagnostic('unread_targets_not_actionable', {
        unread_conversations: entries
          .filter((entry) => entry.conversation.unread_count > 0)
          .map((entry) => ({
            conversation_key: entry.key,
            preview_text: entry.conversation.latest_message_text || '',
            unread_count: entry.conversation.unread_count,
            unread_version: unreadVersion(entry),
            handled_version: handledUnread.get(entry.key)?.version || null,
            handled_at: handledUnread.get(entry.key)?.at || null,
            reason: unreadEntryBlockedReason(entry, now),
          }))
          .slice(0, 30),
      }, 'debug');
    }
  } catch (error) {
    lastStatus = 'error';
    emit('status', { status: 'error', page_path: `${location.origin}${location.pathname}` });
    diagnostic('scan_failed', {
      error_name: error?.name || 'Error',
      error: error?.message || String(error),
    }, 'error');
  } finally {
    scanInProgress = false;
    for (const requestId of scanRequestIds) {
      emit('scan_result', {
        request_id: requestId.slice(0, 128),
        status: lastStatus === 'error' ? 'failed' : 'completed',
      });
    }
    if (scanRequested) {
      scanRequested = false;
      scheduleScan(MUTATION_DEBOUNCE_MS, 'deferred_scan');
    }
  }
}

let scheduledScanReason = 'initial';

function scheduleScan(delay = MUTATION_DEBOUNCE_MS, reason = 'scheduled') {
  scheduledScanReason = reason;
  if (scanTimer) clearTimeout(scanTimer);
  scanTimer = setTimeout(() => void scan(), delay);
}

window.addEventListener('DOMContentLoaded', () => {
  installApiShadowBridge();
  diagnostic('preload_ready', {
    page_path: `${location.origin}${location.pathname}`,
    api_shadow_version: API_SHADOW_VERSION,
    dom_conversation_scan_enabled: DOM_CONVERSATION_SCAN_ENABLED,
    scan_interval_ms: SCAN_INTERVAL_MS,
    mutation_debounce_ms: MUTATION_DEBOUNCE_MS,
    conversation_selectors: selectors.conversationItems,
    unread_selectors: selectors.unreadBadge,
  });
  scheduleScan(0, 'dom_content_loaded');
  if (DOM_CONVERSATION_SCAN_ENABLED) {
    const observer = new MutationObserver(() => scheduleScan(MUTATION_DEBOUNCE_MS, 'mutation'));
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
  }
  document.addEventListener('pointerdown', (event) => {
    if (event.isTrusted) {
      manualPauseUntil = Date.now() + MANUAL_ACTIVITY_PAUSE_MS;
      emitPageActivity('pointerdown');
      diagnostic('manual_activity_pause_started', {
        event_type: 'pointerdown',
        pause_ms: MANUAL_ACTIVITY_PAUSE_MS,
      }, 'debug');
    }
  }, true);
  document.addEventListener('keydown', (event) => {
    if (event.isTrusted) {
      manualPauseUntil = Date.now() + MANUAL_ACTIVITY_PAUSE_MS;
      emitPageActivity('keydown');
      diagnostic('manual_activity_pause_started', {
        event_type: 'keydown',
        key: event.key,
        pause_ms: MANUAL_ACTIVITY_PAUSE_MS,
      }, 'debug');
    }
  }, true);
  setInterval(() => scheduleScan(0, 'interval'), SCAN_INTERVAL_MS);
});

installApiShadowBridge();

ipcRenderer.on('pdd-adapter:command', (_event, command) => {
  if (command?.type === 'collector-rules') {
    collectorRules = normalizeCollectorRules(command.rules);
    lastSnapshot = null;
    diagnostic('collector_rules_updated', { version: collectorRules.version });
    scheduleScan(0, 'collector_rules_updated');
    return;
  }
  if (command?.type === 'set-store-actor-state') {
    storeActorBusy = command.state !== 'idle' && command.state !== 'cancelled';
    if (!storeActorBusy) {
      if (command.state === 'cancelled') collectUnreadRequested = false;
      scheduleScan(0, 'store_actor_idle');
    }
    return;
  }
  if (command?.type === 'scan-current-page' && typeof command.requestId === 'string') {
    pendingScanRequestIds.add(command.requestId.slice(0, 128));
    scheduleScan(0, 'store_actor_rescan');
    return;
  }
  if (command?.type === 'scan') {
    scheduleScan(0, 'main_process_command');
    return;
  }
  if (command?.type === 'detect-account-name' && typeof command.requestId === 'string') {
    if (currentPageStatus() === 'online') {
      shopInfoViaApi(command.requestId, 'account-name-detection');
    } else {
      emit('account_name_detection', {
        request_id: command.requestId.slice(0, 128),
        account_name: null,
        source: null,
        error: 'page_not_online',
        diagnostics: {
          page_status: currentPageStatus(),
        },
      });
      diagnostic('account_name_detection_completed', {
        request_id: command.requestId.slice(0, 128),
        detected: false,
        source: null,
      });
    }
    return;
  }
  if (command?.type === 'list-conversations-api' && typeof command.requestId === 'string') {
    if (currentPageStatus() === 'online') {
      latestConversationsViaApi(command.requestId, command.purpose || 'import-candidates');
    }
    else emit('api_latest_conversations_result', {
      request_id: command.requestId.slice(0, 128),
      purpose: text(command.purpose, 64) || 'import-candidates',
      status: 'failed',
      error: 'page_not_online',
    });
    return;
  }
  if (command?.type === 'list-conversations' && typeof command.requestId === 'string') {
    if (currentPageStatus() === 'online') void emitConversationCandidates(command.requestId);
    else emit('conversation_candidates', {
      request_id: command.requestId.slice(0, 128),
      conversations: [],
    });
    return;
  }
  if (
    command?.type === 'collect-next-unread'
    && typeof command.requestId === 'string'
  ) {
    void collectNextUnread(command.requestId);
    return;
  }
  if (
    command?.type === 'ack-unread-api-backfill'
    && typeof command.conversationKey === 'string'
  ) {
    acknowledgeUnreadApiBackfill(
      command.conversationKey,
      command.customerName || '',
      command.domConversationKey || '',
    );
    return;
  }
  if (
    command?.type === 'collect-conversation-api'
    && typeof command.requestId === 'string'
    && typeof command.conversationKey === 'string'
  ) {
    collectConversationViaApi(command.requestId, command.conversationKey.slice(0, 128));
    return;
  }
  if (
    command?.type === 'collect-customer-orders-api'
    && typeof command.requestId === 'string'
    && typeof command.conversationKey === 'string'
  ) {
    collectCustomerOrdersViaApi(
      command.requestId,
      command.conversationKey.slice(0, 128),
      typeof command.customerName === 'string' ? command.customerName.slice(0, 128) : '',
    );
    return;
  }
  if (
    command?.type === 'collect-customer-products-api'
    && typeof command.requestId === 'string'
    && typeof command.conversationKey === 'string'
  ) {
    collectCustomerProductsViaApi(
      command.requestId,
      command.conversationKey.slice(0, 128),
      typeof command.customerName === 'string' ? command.customerName.slice(0, 128) : '',
    );
    return;
  }
  if (
    command?.type === 'collect-platform-phrases-api'
    && typeof command.requestId === 'string'
  ) {
    collectPlatformPhrasesViaApi(
      command.requestId,
      command.source === 'team' ? 'team' : 'personal',
    );
    return;
  }
  if (
    command?.type === 'collect-conversation'
    && typeof command.requestId === 'string'
    && typeof command.conversationKey === 'string'
  ) {
    void collectConversation(command.requestId, command.conversationKey.slice(0, 128));
    return;
  }
  if (
    command?.type === 'switch-conversation'
    && typeof command.requestId === 'string'
    && typeof command.conversationKey === 'string'
  ) {
    void switchConversationOnly(
      command.requestId,
      command.conversationKey.slice(0, 128),
      typeof command.customerName === 'string' ? command.customerName.slice(0, 128) : '',
    );
    return;
  }
  if (
    command?.type === 'send-message-api'
    && typeof command.requestId === 'string'
    && typeof command.conversationKey === 'string'
    && typeof command.customerName === 'string'
    && typeof command.content === 'string'
  ) {
    sendMessageViaApi(
      command.requestId,
      command.conversationKey.slice(0, 128),
      command.customerName.slice(0, 128),
      command.content.slice(0, 4000),
      typeof command.quoteMessageId === 'string' ? command.quoteMessageId.slice(0, 128) : null,
    );
    return;
  }
  if (
    command?.type === 'transfer-conversation-api'
    && typeof command.requestId === 'string'
    && typeof command.conversationKey === 'string'
    && typeof command.customerName === 'string'
  ) {
    transferConversationViaApi(
      command.requestId,
      command.conversationKey.slice(0, 128),
      command.customerName.slice(0, 128),
      typeof command.transReason === 'string' ? command.transReason.slice(0, 128) : '无原因直接转移',
      typeof command.targetCsid === 'string' ? command.targetCsid.slice(0, 128) : '',
      command.autoTransfer === true,
    );
    return;
  }
  if (
    command?.type === 'list-transfer-cs-api'
    && typeof command.requestId === 'string'
  ) {
    listTransferCsViaApi(command.requestId);
    return;
  }
  if (
    command?.type === 'send-product-api'
    && typeof command.requestId === 'string'
    && typeof command.conversationKey === 'string'
    && typeof command.customerName === 'string'
    && typeof command.productId === 'string'
  ) {
    sendProductViaApi(
      command.requestId,
      command.conversationKey.slice(0, 128),
      command.customerName.slice(0, 128),
      command.productId.slice(0, 128),
    );
    return;
  }
  if (
    command?.type === 'send-image-api'
    && typeof command.requestId === 'string'
    && typeof command.conversationKey === 'string'
    && typeof command.customerName === 'string'
    && typeof command.imageDataUrl === 'string'
  ) {
    sendImageViaApi(
      command.requestId,
      command.conversationKey.slice(0, 128),
      command.customerName.slice(0, 128),
      command.imageDataUrl,
      {
        width: command.width,
        height: command.height,
        byteSize: command.byteSize,
        quoteMessageId: typeof command.quoteMessageId === 'string' ? command.quoteMessageId.slice(0, 128) : null,
      },
    );
    return;
  }
  if (
    command?.type === 'prepare-message'
    && typeof command.requestId === 'string'
    && typeof command.conversationKey === 'string'
    && typeof command.customerName === 'string'
    && typeof command.content === 'string'
  ) {
    void prepareMessage(
      command.requestId,
      command.conversationKey.slice(0, 128),
      command.customerName.slice(0, 128),
      command.content.slice(0, 4000),
    );
    return;
  }
  if (
    command?.type === 'send-message'
    && typeof command.requestId === 'string'
    && typeof command.conversationKey === 'string'
    && typeof command.customerName === 'string'
    && typeof command.content === 'string'
  ) {
    void sendMessage(
      command.requestId,
      command.conversationKey.slice(0, 128),
      command.customerName.slice(0, 128),
      command.content.slice(0, 4000),
    );
    return;
  }
  if (
    command?.type === 'prepare-image-current'
    && typeof command.requestId === 'string'
    && typeof command.expectedConversationKey === 'string'
    && typeof command.customerName === 'string'
  ) {
    prepareImageInCurrentConversation(
      command.requestId,
      command.expectedConversationKey.slice(0, 128),
      command.customerName.slice(0, 128),
    );
    return;
  }
  if (
    command?.type === 'prepare-image'
    && typeof command.requestId === 'string'
    && typeof command.conversationKey === 'string'
    && typeof command.customerName === 'string'
  ) {
    void prepareImage(
      command.requestId,
      command.conversationKey.slice(0, 128),
      command.customerName.slice(0, 128),
    );
    return;
  }
  if (command?.type === 'send-image-enter' && typeof command.requestId === 'string') {
    void sendImageEnter(
      command.requestId,
      typeof command.expectedConversationKey === 'string'
        ? command.expectedConversationKey.slice(0, 128)
        : '',
      typeof command.customerName === 'string' ? command.customerName.slice(0, 128) : '',
    );
    return;
  }
  if (command?.type === 'wait-image-paste' && typeof command.requestId === 'string') {
    void waitForImagePaste(
      command.requestId,
      typeof command.expectedConversationKey === 'string'
        ? command.expectedConversationKey.slice(0, 128)
        : '',
      typeof command.customerName === 'string' ? command.customerName.slice(0, 128) : '',
    );
  }
});
