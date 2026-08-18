'use strict';

const { ipcRenderer } = require('electron');

const CHANNEL = 'pdd-adapter:event';
const MAX_TEXT = 4000;
const SCAN_INTERVAL_MS = 1500;
const MUTATION_DEBOUNCE_MS = 250;
const FAILED_SWITCH_COOLDOWN_MS = 1500;
const SWITCH_TIMEOUT_MS = 4000;
const SWITCH_POLL_MS = 100;
const IMAGE_CONFIRMATION_HARD_TIMEOUT_MS = 60000;
const MANUAL_ACTIVITY_PAUSE_MS = 5000;
const PAGE_ACTIVITY_REPORT_INTERVAL_MS = 5000;
const IDENTITY_STABLE_MS = 1000;
const HANDLED_UNREAD_RETRY_MS = 30000;
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
  const shopElement = queryFirst(document, selectors.shopName);
  const nameCandidate = accountNameCandidate();
  const externalId = attribute(shopElement, ['data-mall-id', 'data-shop-id', 'data-store-id'])
    || attribute(document.body, ['data-mall-id', 'data-shop-id', 'data-store-id']);
  return externalId || nameCandidate
    ? {
      external_account_id: externalId,
      account_name: nameCandidate?.accountName || null,
      account_name_source: nameCandidate?.source || null,
    }
    : null;
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
let lastSnapshot = null;
let scanTimer = null;
let scanInProgress = false;
let scanRequested = false;
let manualPauseUntil = 0;
let storeActorBusy = false;
let collectUnreadRequested = false;
const pendingScanRequestIds = new Set();
const handledUnread = new Map();
const failedUnread = new Map();

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

async function processConversationEntry(entry, entries, { markUnread = false, emitMessages = true } = {}) {
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
  const orderSnapshot = await collectCustomerOrders();
  const activeEntry = verifiedEntries.find((candidate) => candidate.key === entry.key);
  if (activeEntry) activeEntry.conversation.customer_orders = orderSnapshot;
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

async function collectNextUnread(requestId) {
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
      return;
    }
    const identity = accountIdentity();
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
      if (!collectUnreadRequested) {
        collectUnreadRequested = true;
        emit('collect_unread_request', {
          conversation_key: unreadEntry.key,
          customer_name: unreadEntry.conversation.customer_name,
        });
      }
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
  diagnostic('preload_ready', {
    page_path: `${location.origin}${location.pathname}`,
    scan_interval_ms: SCAN_INTERVAL_MS,
    mutation_debounce_ms: MUTATION_DEBOUNCE_MS,
    conversation_selectors: selectors.conversationItems,
    unread_selectors: selectors.unreadBadge,
  });
  scheduleScan(0, 'dom_content_loaded');
  const observer = new MutationObserver(() => scheduleScan(MUTATION_DEBOUNCE_MS, 'mutation'));
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
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
    const candidate = accountNameCandidate();
    emit('account_name_detection', {
      request_id: command.requestId.slice(0, 128),
      account_name: candidate?.accountName || null,
      source: candidate?.source || null,
    });
    diagnostic('account_name_detection_completed', {
      request_id: command.requestId.slice(0, 128),
      detected: Boolean(candidate),
      source: candidate?.source || null,
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
    command?.type === 'collect-conversation'
    && typeof command.requestId === 'string'
    && typeof command.conversationKey === 'string'
  ) {
    void collectConversation(command.requestId, command.conversationKey.slice(0, 128));
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
