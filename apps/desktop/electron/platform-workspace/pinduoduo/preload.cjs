'use strict';

const { ipcRenderer } = require('electron');

const CHANNEL = 'pdd-adapter:event';
const MAX_TEXT = 4000;
const SCAN_INTERVAL_MS = 1500;
const MUTATION_DEBOUNCE_MS = 250;
const FAILED_SWITCH_COOLDOWN_MS = 1500;
const SWITCH_TIMEOUT_MS = 4000;
const SWITCH_POLL_MS = 100;
const MANUAL_ACTIVITY_PAUSE_MS = 5000;
const IDENTITY_STABLE_MS = 1000;
const UNREAD_STATUS_PATTERN = /\u672a\u56de\u590d|\u5f85\u56de\u590d|\u8bf7\d*\u5206\u949f\u5185\u56de\u590d|\u8d85\u65f6|\u7ea2\u70b9|new/i;
const GENERIC_ACCOUNT_NAME = /^(\u62fc\u591a\u591a|\u62fc\u591a\u591a\u5546\u5bb6\u540e\u53f0|\u62fc\u591a\u591a\u5546\u5bb6\u7ba1\u7406\u540e\u53f0|\u62fc\u591a\u591a\u5ba2\u670d\u5e73\u53f0|\u5546\u5bb6\u540e\u53f0|\u5ba2\u670d\u5e73\u53f0)$/;
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
};

function loadSelectors() {
  const prefix = '--pdd-adapter-config=';
  const argument = process.argv.find((item) => item.startsWith(prefix));
  if (!argument) return FALLBACK_SELECTORS;
  try {
    const parsed = JSON.parse(decodeURIComponent(argument.slice(prefix.length)));
    return { ...FALLBACK_SELECTORS, ...parsed };
  } catch {
    return FALLBACK_SELECTORS;
  }
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

function queryCandidates(root, catalog) {
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
  return matches.filter((element) => !matches.some(
    (candidate) => candidate !== element && candidate.contains(element),
  )).sort((left, right) => {
    if (left === right) return 0;
    const position = left.compareDocumentPosition(right);
    return position & Node.DOCUMENT_POSITION_PRECEDING ? 1 : -1;
  });
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

function readConversation(element) {
  const nameElement = queryFirst(element, selectors.conversationName);
  const previewElement = queryFirst(element, selectors.conversationPreview);
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
    latest_message_text: text(previewElement?.textContent),
    unread_count: unreadCount(element),
    avatar_url: avatarUrl(element),
    active: isActive(element),
    messages: [],
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

function messageType(element, contentElement) {
  const explicit = attribute(element, ['data-message-type', 'data-msg-type']);
  if (explicit && /image|pic/i.test(explicit)) return 'image';
  if (explicit && /goods|product|mall/i.test(explicit)) return 'product';
  if (explicit && /order/i.test(explicit)) return 'order';
  if (explicit && /system|notice/i.test(explicit)) return 'notice';
  if (element.querySelector('.msg-system, [class*="System"]')) return 'notice';
  if (element.querySelector('[class*="BuyerFromCard"]')) return 'lead';
  if (element.querySelector('.order-card, .kwaishop-cs-BizOrderCard, [class*="OrderCard"]')) return 'order';
  if (element.querySelector('[class*="goods"], [class*="product"]')) return 'product';
  if (contentImage(element, contentElement)) return 'image';
  return 'text';
}

function dateFromParts(year, month, day, hour, minute, second = 0) {
  const value = new Date(year, month - 1, day, hour, minute, second);
  if (
    value.getFullYear() !== year
    || value.getMonth() !== month - 1
    || value.getDate() !== day
    || value.getHours() !== hour
    || value.getMinutes() !== minute
  ) return null;
  return value;
}

function parseTimeLabel(value, observedAt) {
  if (!value) return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (/^\d{10,13}$/.test(normalized)) {
    const numeric = Number(normalized);
    const date = new Date(numeric < 100000000000 ? numeric * 1000 : numeric);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const direct = new Date(normalized);
  if (!Number.isNaN(direct.getTime()) && /[TzZ]|[+-]\d{2}:?\d{2}$/.test(normalized)) {
    return direct.toISOString();
  }
  const full = normalized.match(/(\d{4})\s*(?:[-/.]|\u5e74)\s*(\d{1,2})\s*(?:[-/.]|\u6708)\s*(\d{1,2})\s*(?:\u65e5)?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (full) {
    return dateFromParts(...full.slice(1).map((part) => Number(part || 0)))?.toISOString() || null;
  }
  const observed = new Date(observedAt);
  if (Number.isNaN(observed.getTime())) return null;
  const monthDay = normalized.match(/(\d{1,2})\s*(?:[-/.]|\u6708)\s*(\d{1,2})\s*(?:\u65e5)?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (monthDay) {
    return dateFromParts(
      observed.getFullYear(),
      ...monthDay.slice(1).map((part) => Number(part || 0)),
    )?.toISOString() || null;
  }
  const relative = normalized.match(/^(\u4eca\u5929|\u6628\u5929|\u524d\u5929)\s*(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (relative) {
    const dayOffset = relative[1] === '\u4eca\u5929' ? 0 : relative[1] === '\u6628\u5929' ? -1 : -2;
    const base = new Date(observed.getFullYear(), observed.getMonth(), observed.getDate() + dayOffset);
    return dateFromParts(
      base.getFullYear(),
      base.getMonth() + 1,
      base.getDate(),
      ...relative.slice(2).map((part) => Number(part || 0)),
    )?.toISOString() || null;
  }
  const clock = normalized.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (clock) {
    return dateFromParts(
      observed.getFullYear(),
      observed.getMonth() + 1,
      observed.getDate(),
      ...clock.slice(1).map((part) => Number(part || 0)),
    )?.toISOString() || null;
  }
  return null;
}

function parseMessageTime(element, observedAt) {
  const timeElement = queryFirst(element, selectors.messageTime);
  const raw = attribute(timeElement || element, ['datetime', 'data-time', 'data-timestamp'])
    || text(timeElement?.textContent, 64);
  return {
    platform_sent_at: parseTimeLabel(raw, observedAt),
    time_label: raw,
    has_explicit_time: Boolean(raw),
  };
}

function isIgnoredMessage(element, type, content) {
  if (['notice', 'system', 'lead'].includes(type)) return true;
  if (element.querySelector('[class*="BuyerFromCard"]')) return true;
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (/^(?:(?:\d{4}\s*(?:[-/.]|\u5e74))?\d{1,2}\s*(?:[-/.]|\u6708)\s*\d{1,2}\s*(?:\u65e5)?|\u4eca\u5929|\u6628\u5929|\u524d\u5929)\s+\d{1,2}:\d{2}(?::\d{2})?$/.test(normalized)) return true;
  return /^(?:\u5f53\u524d\u7528\u6237\u6765\u81ea.*(?:\u5546\u54c1\u8be6\u60c5\u9875|\u5e97\u94fa|\u76f4\u64ad\u95f4|\u641c\u7d22|\u6d3b\u52a8\u9875)|(?:\u5bf9\u65b9|\u60a8|\u4f60)?\u64a4\u56de\u4e86\u4e00\u6761\u6d88\u606f|.*\u9080\u8bf7\u4e0b\u5355.*\u7acb\u5373\u4f7f\u7528)/.test(normalized);
}

function stripLeadingTimeLabel(content, timeLabel) {
  if (!timeLabel || !content.startsWith(timeLabel)) return content;
  return text(content.slice(timeLabel.length)) || '';
}

function readMessage(element, sequence, timeInfo) {
  const contentElement = queryFirst(element, selectors.messageContent) || element;
  const type = messageType(element, contentElement);
  const image = type === 'image' ? contentImage(element, contentElement) : null;
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
  let content = text(contentElement.textContent);
  content = stripLeadingTimeLabel(content || '', timeInfo.time_label);
  if (!content && type === 'image') content = '[image]';
  if (!content && type === 'product') content = '[product]';
  if (!content && type === 'order') content = '[order]';
  if (!content || isIgnoredMessage(element, type, content)) return null;
  const sender = text(element.querySelector('.nickname')?.textContent, 128)
    || attribute(element, ['data-sender-name', 'data-nickname']);
  return {
    platform_message_id: attribute(element, ['data-message-id', 'data-msg-id', 'data-id', 'id']),
    sender_role: senderRole(element),
    sender_name: sender,
    content,
    message_type: type,
    image_url: imageUrl,
    snapshot_sequence: sequence,
    ...timeInfo,
  };
}

function readMessages(elements, observedAt) {
  const entries = elements.map((element, sequence) => ({
    element,
    sequence,
    time: parseMessageTime(element, observedAt),
  }));
  let anchor = null;
  let groupIndex = -1;
  for (const entry of entries) {
    if (entry.time.has_explicit_time) {
      groupIndex += 1;
      anchor = entry.time.platform_sent_at;
    }
    entry.time.platform_sent_at = entry.time.platform_sent_at || anchor;
    entry.time.time_group_index = groupIndex >= 0 ? groupIndex : null;
  }
  const firstAnchored = entries.find((entry) => entry.time.platform_sent_at);
  if (firstAnchored) {
    for (const entry of entries) {
      if (entry.time.platform_sent_at) break;
      entry.time.platform_sent_at = firstAnchored.time.platform_sent_at;
      entry.time.time_group_index = firstAnchored.time.time_group_index;
    }
  }
  return entries.map(({ element, sequence, time }) => readMessage(element, sequence, time)).filter(Boolean);
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
  if (path.startsWith('/login')) return 'login_required';
  if (/\/risk|\/verify|\/captcha/.test(path)) return 'risk_control';
  if (document.querySelector('[class*="captcha"], [class*="risk-verify"], [data-testid*="captcha"]')) {
    return 'risk_control';
  }
  return path.startsWith('/chat-windows') || path.startsWith('/chat-merchant') ? 'online' : 'unknown';
}

function messageAreaFingerprint() {
  return JSON.stringify(queryCandidates(document, selectors.messageItems).slice(-200).map((element) => [
    attribute(element, ['data-message-id', 'data-msg-id', 'data-id', 'id']),
    `${element.className || ''}`.slice(0, 180),
    text(element.textContent, 600),
  ]));
}

function hasVisibleMessages() {
  return queryCandidates(document, selectors.messageItems).length > 0;
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
    messages: [],
  }));
  let active = verifiedActiveKey
    ? conversations.find((conversation) => conversationKey(conversation) === verifiedActiveKey)
    : conversations.find((conversation) => conversation.active);
  if (!active && conversations.length === 1) active = conversations[0];
  if (active) {
    const messages = readMessages(queryCandidates(document, selectors.messageItems), observedAt);
    if (messages.length) active.messages = messages.slice(-200);
  }
  return conversations;
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
  diagnostic('snapshot_emitted', {
    force,
    conversation_count: conversations.length,
    active_conversation_key: active ? conversationKey(active) : null,
    active_message_count: active?.messages?.length || 0,
    verified_active_key: verifiedActiveKey,
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
  if (handledUnread.get(entry.key)?.version === version) return 'already_handled_preview';
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
  if (emitMessages) emitSnapshot(verifiedEntries, entry.key, true);
  if (markUnread) {
    handledUnread.set(entry.key, {
      version: unreadVersion(entry),
      at: Date.now(),
    });
    failedUnread.delete(entry.key);
  }
  diagnostic(markUnread ? 'unread_processing_succeeded' : 'conversation_collection_succeeded', {
    conversation_key: entry.key,
    customer_name: entry.conversation.customer_name,
    unread_count: entry.conversation.unread_count,
    message_count: readMessages(queryCandidates(document, selectors.messageItems), new Date().toISOString()).length,
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

function findReplySendButton(input) {
  const roots = [
    input.closest?.('form'),
    input.parentElement,
    input.parentElement?.parentElement,
    document,
  ].filter(Boolean);
  const textPattern = /^发送$|发送消息|立即发送|send/i;
  for (const root of roots) {
    const candidates = [
      ...queryCandidates(root, selectors.replySendButton),
      ...queryCandidates(root, ['button', '[role="button"]']),
    ];
    const button = candidates.find((candidate) => {
      if (!isVisible(candidate) || candidate.disabled || candidate === input) return false;
      const label = text(candidate.textContent, 80) || attribute(candidate, ['aria-label', 'title', 'data-testid']);
      const marker = `${candidate.className || ''} ${candidate.id || ''}`;
      return textPattern.test(label || '') || /(^|[-_\s])(send|reply)([-_\s]|$)/i.test(marker);
    });
    if (button) return button;
  }
  return null;
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

    const sendButton = findReplySendButton(input);
    if (sendButton) clickSendButton(sendButton);
    let method = sendButton ? 'click' : null;
    let sent = await waitForReplyInputEmpty(input);
    if (!sent) {
      dispatchEnterToSend(input);
      method = 'enter';
      sent = await waitForReplyInputEmpty(input);
    }
    diagnostic('message_send_attempt_completed', {
      conversation_key: entry.key,
      customer_name: entry.conversation.customer_name,
      sent,
      method,
      click_attempted: Boolean(sendButton),
      enter_fallback_attempted: method === 'enter',
      content_length: content.length,
    });
    emit('message_send_result', {
      request_id: requestId.slice(0, 128),
      status: sent ? 'sent' : 'failed',
      conversation_key: entry.key,
      customer_name: entry.conversation.customer_name,
      method,
      error: sent ? null : 'reply_input_not_cleared_after_click_and_enter',
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
    if (!await waitForDialogClosed(dialog)) {
      throw new Error('image_confirmation_modal_not_closed');
    }
    diagnostic('image_confirmation_completed', {
      request_id: requestId.slice(0, 128),
      conversation_key: targetKey || null,
      method,
    });
    emit('image_send_result', {
      request_id: requestId.slice(0, 128),
      status: 'sent',
      method,
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
      diagnostic('manual_activity_pause_started', {
        event_type: 'pointerdown',
        pause_ms: MANUAL_ACTIVITY_PAUSE_MS,
      }, 'debug');
    }
  }, true);
  document.addEventListener('keydown', (event) => {
    if (event.isTrusted) {
      manualPauseUntil = Date.now() + MANUAL_ACTIVITY_PAUSE_MS;
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
