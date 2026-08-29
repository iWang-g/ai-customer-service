import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  clearStoredSession,
  clearConversationAwaitingReply,
  clearConversationHumanRequired,
  clearConversationHistory,
  connectRealtime,
  generatePlatformAccountShopSummary,
  dismissConversationMessageSyncIssue,
  getBusinessAssetUrl,
  getQaImageUrl,
  getConversationMessageSyncIssue,
  getCurrentUser,
  getCustomerOrders,
  getCustomerProducts,
  getMonitoringOverview,
  getStoredSession,
  isAuthenticationError,
  listConversations,
  listPlatformAccounts,
  listMessages,
  listMonitoringEvents,
  listMonitoringLogs,
  login,
  logout,
  deleteConversation,
  rebuildConversationMessageQueue,
  recordSentMessage,
  getPlatformPhraseCache,
  savePlatformPhraseCache,
  updatePlatformAccountShopSummary,
  sendMessage,
  storeSession,
  subscribeToSessionChanges,
  type ApiConversation,
  type ApiMessage,
  type AuthSession,
  type CustomerProduct,
  type CustomerProductsResponse,
  type CustomerOrdersResponse,
  type MonitoringEvent,
  type MonitoringLog,
  type MessageSyncIssueDetail,
  type PlatformAccount,
  type PlatformPhraseRecord,
  type PlatformQuickReply,
  type ShopProductSummary,
} from '../../shared/api/client';
import { MOCK_PLATFORMS } from '../types';
import type { BotStatus, Conversation, LogEntry, Message, Shop, StatusEvent } from '../types';

type AuthMode = 'login';
type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';
type RpaBatchAffectedConversation = {
  conversation_id?: unknown;
  external_conversation_id?: unknown;
  appended_message_count?: unknown;
};

type PlatformQuickRepliesState = {
  accountId: string;
  personal: PlatformQuickReply[];
  team: PlatformQuickReply[];
  personalError: string;
  teamError: string;
  personalUnavailable: boolean;
  teamUnavailable: boolean;
  personalLoading: boolean;
  teamLoading: boolean;
};

type PlatformQuickRepliesCacheEntry = Omit<PlatformQuickRepliesState, 'accountId' | 'personalLoading' | 'teamLoading'> & {
  personalLoaded: boolean;
  teamLoaded: boolean;
};

function emptyPlatformQuickRepliesState(accountId = ''): PlatformQuickRepliesState {
  return {
    accountId,
    personal: [],
    team: [],
    personalError: '',
    teamError: '',
    personalUnavailable: false,
    teamUnavailable: false,
    personalLoading: false,
    teamLoading: false,
  };
}

function mapPlatformQuickReply(record: PlatformPhraseRecord, source: PlatformQuickReply['source']): PlatformQuickReply {
  return {
    source,
    source_id: record.source_id,
    category: record.category || '',
    quick_key: record.quick_key || '',
    content: record.content || '',
    images: Array.isArray(record.images) ? record.images : [],
  };
}

function formatTime(value: string | null): string {
  if (!value) return '';
  const trimmedValue = value.trim();
  const normalizedValue = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmedValue)
    ? trimmedValue
    : `${trimmedValue}Z`;
  const date = new Date(normalizedValue);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}

function pddTimestampToIso(value: unknown): string | null {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0) return null;
  const milliseconds = numericValue > 1_000_000_000_000 ? numericValue : numericValue * 1000;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function senderFromRole(role: unknown): Message['sender'] {
  return role === 'customer'
    ? 'user'
    : role === 'platform'
      ? 'platform'
      : role === 'assistant' || role === 'bot'
        ? 'bot'
        : 'agent';
}

function isPlatformSystemMessage(message: ApiMessage): boolean {
  const rawPayload = message.raw_payload as Record<string, unknown>;
  const structuredPayload = rawPayload.structured_payload;
  const rawType = typeof structuredPayload === 'object' && structuredPayload !== null
    && typeof (structuredPayload as Record<string, unknown>).raw_type === 'number'
      ? (structuredPayload as Record<string, unknown>).raw_type
      : typeof rawPayload.raw_type === 'number'
        ? rawPayload.raw_type
      : null;
  return rawType === 24 || rawType === 31 || rawType === 41 || rawType === 74
    || rawPayload.message_type === 'system'
    || rawPayload.message_type === 'context';
}

function mapMessage(message: ApiMessage): Message {
  const platformSystemMessage = isPlatformSystemMessage(message);
  const sender = platformSystemMessage ? 'platform' : senderFromRole(message.sender_role);
  const mediaType = typeof message.raw_payload.media_type === 'string'
    ? message.raw_payload.media_type
    : typeof message.raw_payload.message_type === 'string'
      ? message.raw_payload.message_type
      : '';
  const structuredPayload = message.raw_payload.structured_payload;
  const timelineData = structuredPayload && typeof structuredPayload === 'object'
    ? { ...(structuredPayload as Record<string, unknown>) }
    : null;
  const quotePayload = timelineData && typeof timelineData.quote_msg === 'object' && timelineData.quote_msg !== null
    ? timelineData.quote_msg as Record<string, unknown>
    : null;
  const quoteImageUrl = typeof quotePayload?.image_url === 'string' ? quotePayload.image_url : '';
  const quoteType = typeof quotePayload?.message_type === 'string' ? quotePayload.message_type : '';
  const quoteContent = typeof quotePayload?.content === 'string' ? quotePayload.content : '';
  const structuredImageUrl = structuredPayload && typeof structuredPayload === 'object'
    && typeof (structuredPayload as Record<string, unknown>).image_url === 'string'
    ? (structuredPayload as Record<string, unknown>).image_url as string
    : '';
  const rawImageUrl = typeof message.raw_payload.image_url === 'string'
    ? message.raw_payload.image_url
    : structuredImageUrl;
  const rawType = typeof message.raw_payload.message_type === 'string'
    ? message.raw_payload.message_type
    : mediaType || 'text';
  const timelineType = platformSystemMessage
    ? (typeof message.raw_payload.message_type === 'string' && message.raw_payload.message_type === 'context'
      ? 'context'
      : 'system')
    : rawType;
  const allowedTypes = new Set(['text', 'image', 'product', 'order', 'system', 'context', 'time', 'unknown']);
  const rawDisplayMode = typeof message.raw_payload.display_mode === 'string'
    ? message.raw_payload.display_mode
    : 'bubble';
  const displayMode = platformSystemMessage
    ? (timelineType === 'context' ? 'card' : 'separator')
    : rawDisplayMode;
  const allowedDisplayModes = new Set(['bubble', 'card', 'separator', 'notice', 'hidden']);
  return {
    id: message.id,
    platformMessageId: message.platform_message_id,
    sender,
    content: message.content,
    timestamp: message.time_label || formatTime(message.collected_at),
    deliveryStatus: message.message_status === 'queued'
      ? 'sending'
      : message.message_status === 'failed'
        ? 'failed'
        : 'sent',
    timeline: {
      type: (allowedTypes.has(timelineType) ? timelineType : 'unknown') as NonNullable<Message['timeline']>['type'],
      displayMode: (allowedDisplayModes.has(displayMode) ? displayMode : 'bubble') as NonNullable<Message['timeline']>['displayMode'],
      ...(timelineData
        ? { data: {
            ...timelineData,
            ...(typeof timelineData.image_url === 'string'
              ? { image_url: getQaImageUrl(timelineData.image_url) }
              : {}),
          } as NonNullable<Message['timeline']>['data'] }
        : {}),
    },
    ...(quotePayload ? {
      quote: {
        platformMessageId: typeof quotePayload.msg_id === 'string' ? quotePayload.msg_id : null,
        sender: senderFromRole(quotePayload.sender_role),
        content: quoteContent || (quoteType === 'image' ? '[图片]' : '[引用消息]'),
        ...(quoteType === 'image' && quoteImageUrl
          ? { media: { type: 'image' as const, url: getQaImageUrl(quoteImageUrl) } }
          : {}),
      },
    } : {}),
    ...((mediaType === 'image' || rawImageUrl) && rawImageUrl
      ? { media: { type: 'image' as const, url: getQaImageUrl(rawImageUrl) } }
      : {}),
  };
}

function quotePayloadFromMessage(message: Message | null | undefined): Record<string, unknown> | null {
  if (!message?.platformMessageId) return null;
  const isImage = message.media?.type === 'image' || message.timeline?.type === 'image';
  const isText = message.timeline?.type === 'text' || !message.timeline;
  if (!isImage && !isText) return null;
  const messageType = isImage ? 'image' : 'text';
  return {
    msg_id: message.platformMessageId,
    sender_role: message.sender === 'user'
      ? 'customer'
      : message.sender === 'platform'
        ? 'platform'
        : 'agent',
    message_type: messageType,
    content: message.content || (messageType === 'image' ? '[图片]' : '[引用消息]'),
    image_url: message.media?.url || null,
  };
}

function mapConversation(conversation: ApiConversation, existingMessages: Message[] = []): Conversation {
  const legacyShopName = typeof conversation.metadata_json.shop_name === 'string'
    ? conversation.metadata_json.shop_name
    : null;
  const localShopId = typeof conversation.metadata_json.local_account_id === 'string'
    ? conversation.metadata_json.local_account_id
    : null;
  const shopName = conversation.shop_name || legacyShopName || '未绑定门店';
  const platformName = conversation.platform_name
    || MOCK_PLATFORMS.find((platform) => platform.id === conversation.platform_code)?.name
    || conversation.platform_code;
  const status: Conversation['status'] =
    conversation.status === 'pending' || conversation.status === 'resolved'
      ? conversation.status
      : 'active';
  return {
    id: conversation.id,
    userName: conversation.customer_name || conversation.title || '未知客户',
    avatarUrl: conversation.avatar_url ? getBusinessAssetUrl(conversation.avatar_url) : null,
    shopLogoUrl: conversation.shop_logo_url ? getBusinessAssetUrl(conversation.shop_logo_url) : null,
    shopId: conversation.platform_account_id
      || `legacy:${conversation.platform_code}:${shopName}`,
    localShopId,
    shopName,
    shopServiceUsername: conversation.shop_service_username,
    shopIsMallOwner: conversation.shop_is_mall_owner,
    externalConversationId: conversation.external_conversation_id,
    lastMessage: conversation.latest_message_text || '暂无消息',
    platform: conversation.platform_code,
    platformName,
    status,
    awaitingReply: conversation.awaiting_reply,
    humanRequired: conversation.human_required,
    humanRequiredReason: conversation.human_required_reason,
    humanRequiredWord: conversation.human_required_word,
    latestCustomerMessageAt: conversation.latest_customer_message_at,
    syncIssue: conversation.message_sync_issue ? {
      observationId: conversation.message_sync_issue.observation_id,
      firstDetectedAt: conversation.message_sync_issue.first_detected_at,
      latestDetectedAt: conversation.message_sync_issue.latest_detected_at,
      unread: conversation.message_sync_issue.unread,
      messageCount: conversation.message_sync_issue.message_count,
      consecutiveFailureCount: conversation.message_sync_issue.consecutive_failure_count,
      requiresAttention: conversation.message_sync_issue.requires_attention,
      dismissedAt: conversation.message_sync_issue.dismissed_at,
    } : null,
    time: formatTime(conversation.latest_message_at),
    messages: existingMessages,
  };
}

function productShopCacheKey(conversation: Conversation | undefined | null): string {
  if (!conversation || conversation.platform !== 'pinduoduo') return '';
  return [
    conversation.platform,
    conversation.shopId || '',
    conversation.localShopId || '',
  ].join(':');
}

function parseShopProductSummary(value: unknown): ShopProductSummary {
  const summary = value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
  return {
    shop_intro: typeof summary.shop_intro === 'string' ? summary.shop_intro : '',
    on_sale_products: typeof summary.on_sale_products === 'string' ? summary.on_sale_products : '',
    generated_at: typeof summary.generated_at === 'string' ? summary.generated_at : null,
    edited_at: typeof summary.edited_at === 'string' ? summary.edited_at : null,
  };
}

async function withPreparedPddConversation<T>(
  conversation: Conversation | undefined,
  action: () => Promise<T>,
): Promise<T> {
  const desktopBridge = window.desktopBridge;
  const resetPayload = conversation?.platform === 'pinduoduo'
    && conversation.shopId
    && conversation.externalConversationId
    && desktopBridge
    ? {
        platformAccountId: conversation.shopId,
        externalConversationId: conversation.externalConversationId,
      }
    : null;
  if (resetPayload && desktopBridge) {
    await desktopBridge.preparePddConversationTestReset(resetPayload);
  }
  try {
    return await action();
  } finally {
    if (resetPayload && desktopBridge) {
      await desktopBridge.resumePddConversationAfterTestReset(resetPayload);
    }
  }
}

export function useMessageCenterController() {
  const [session, setSession] = useState<AuthSession | null>(() => getStoredSession());
  const [authReady, setAuthReady] = useState(() => getStoredSession() === null);

  useEffect(() => subscribeToSessionChanges(setSession), []);

  const [authMode, setAuthMode] = useState<AuthMode>('login');
  const [currentView, setCurrentView] = useState<'messages' | 'admin'>('messages');
  const [lang, setLang] = useState<'zh' | 'en'>('zh');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const conversationsRef = useRef<Conversation[]>([]);
  const [isLoadingConversations, setIsLoadingConversations] = useState(false);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [dataError, setDataError] = useState('');
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const [automaticSendNotice, setAutomaticSendNotice] = useState<{
    kind: 'sending' | 'success' | 'error';
    text: string;
    version: number;
  } | null>(null);
  const automaticSendNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingAutomaticMessageIdsRef = useRef(new Map<string, Set<string>>());

  useEffect(() => () => {
    if (automaticSendNoticeTimerRef.current) clearTimeout(automaticSendNoticeTimerRef.current);
  }, []);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [importCandidates, setImportCandidates] = useState<PddImportCandidate[]>([]);
  const [isLoadingImportCandidates, setIsLoadingImportCandidates] = useState(false);
  const [importError, setImportError] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const selectedIdRef = useRef('');
  const [selectedPlatform, setSelectedPlatform] = useState('pinduoduo');
  const [selectedCategory, setSelectedCategory] = useState<'all' | 'pending'>('all');
  const [selectedShop, setSelectedShop] = useState('all');
  const [conversationSearch, setConversationSearch] = useState('');
  const [isLogModalOpen, setIsLogModalOpen] = useState(false);
  const [bot, setBot] = useState<BotStatus>({
    model: 'deepseek-v4-flash',
    availableModels: [],
    uptime: null,
    requestsProcessed: 0,
    avgResponseTimeMs: null,
    health: 0,
  });
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [statusEvents, setStatusEvents] = useState<StatusEvent[]>([]);
  const [isLoadingMonitoring, setIsLoadingMonitoring] = useState(false);
  const [customerOrders, setCustomerOrders] = useState<CustomerOrdersResponse | null>(null);
  const [isLoadingCustomerOrders, setIsLoadingCustomerOrders] = useState(false);
  const [customerProducts, setCustomerProducts] = useState<CustomerProductsResponse | null>(null);
  const [isLoadingCustomerProducts, setIsLoadingCustomerProducts] = useState(false);
  const [platformAccounts, setPlatformAccounts] = useState<PlatformAccount[]>([]);
  const [isLoadingPlatformAccounts, setIsLoadingPlatformAccounts] = useState(false);
  const [platformQuickReplies, setPlatformQuickReplies] = useState<PlatformQuickRepliesState>(
    emptyPlatformQuickRepliesState(),
  );
  const [isGeneratingShopSummary, setIsGeneratingShopSummary] = useState(false);
  const [isSavingShopSummary, setIsSavingShopSummary] = useState(false);
  const shopProductsRef = useRef(new Map<string, CustomerProductsResponse>());
  const platformQuickRepliesCacheRef = useRef(new Map<string, PlatformQuickRepliesCacheEntry>());
  const platformQuickRepliesRequestsRef = useRef(new Map<string, Promise<void>>());
  const activePlatformQuickRepliesAccountRef = useRef('');
  const monitoringModelRef = useRef('deepseek-v4-flash');
  const currentViewRef = useRef(currentView);
  const humanRequiredSnapshotRef = useRef(new Map<string, string>());

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  useEffect(() => {
    currentViewRef.current = currentView;
  }, [currentView]);

  const platformAccountById = useMemo(
    () => new Map(platformAccounts.map((account) => [account.id, account])),
    [platformAccounts],
  );

  const mapMonitoringLog = (item: MonitoringLog): LogEntry => ({
    id: item.id,
    timestamp: item.timestamp,
    type: item.type,
    status: item.status,
    message: item.message,
    details: item.details,
    inputTokens: item.input_tokens,
    outputTokens: item.output_tokens,
    durationMs: item.duration_ms,
  });

  const mapMonitoringEvent = (item: MonitoringEvent): StatusEvent => ({
    id: item.id,
    timestamp: item.timestamp,
    message: item.message,
    level: item.level,
  });

  const loadMonitoring = useCallback(async (model?: string) => {
    setIsLoadingMonitoring(true);
    try {
      const [overview, logResponse, eventResponse] = await Promise.all([
        getMonitoringOverview(model),
        listMonitoringLogs('all'),
        listMonitoringEvents(),
      ]);
      setBot({
        model: overview.current_model,
        availableModels: overview.available_models,
        uptime: overview.metrics.uptime,
        requestsProcessed: overview.metrics.request_count,
        avgResponseTimeMs: overview.metrics.average_response_ms,
        health: overview.metrics.success_rate,
      });
      monitoringModelRef.current = overview.current_model;
      setLogs(logResponse.items.map(mapMonitoringLog));
      setStatusEvents(eventResponse.items.map(mapMonitoringEvent));
    } catch (error) {
      console.error('加载模型运行数据失败:', error);
    } finally {
      setIsLoadingMonitoring(false);
    }
  }, []);

  const loadPlatformAccounts = useCallback(async () => {
    setIsLoadingPlatformAccounts(true);
    try {
      const response = await listPlatformAccounts();
      setPlatformAccounts(response.items);
    } catch (error) {
      console.error('加载平台账号失败:', error);
    } finally {
      setIsLoadingPlatformAccounts(false);
    }
  }, []);

  const shops = useMemo<Shop[]>(() => {
    const unique = new Map<string, Shop>();
    for (const conversation of conversations) {
      if (conversation.shopName === '未绑定门店') continue;
      if (selectedPlatform !== 'all' && conversation.platform !== selectedPlatform) continue;
      unique.set(conversation.shopId, {
        id: conversation.shopId,
        name: conversation.shopName,
        platform: conversation.platform,
        platformName: conversation.platformName,
        logoUrl: conversation.shopLogoUrl,
      });
    }
    return [
      { id: 'all', name: '全部门店' },
      ...[...unique.values()].sort((left, right) => left.name.localeCompare(right.name, 'zh-CN')),
    ];
  }, [conversations, selectedPlatform]);

  useEffect(() => {
    if (selectedShop !== 'all' && !shops.some((shop) => shop.id === selectedShop)) {
      setSelectedShop('all');
    }
  }, [selectedShop, shops]);

  const loadMessagesForConversation = useCallback(async (
    conversationId: string,
    options: { background?: boolean } = {},
  ) => {
    selectedIdRef.current = conversationId;
    setSelectedId(conversationId);
    if (!options.background) {
      setIsLoadingMessages(true);
      setDataError('');
    }
    try {
      const response = await listMessages(conversationId);
      const messages = response.items.map(mapMessage);
      setConversations((current) =>
        current.map((conversation) =>
          conversation.id === conversationId
            ? {
                ...conversation,
                messages: [
                  ...messages.map((message) => {
                    const existing = conversation.messages.find((item) => item.id === message.id);
                    return !message.media && existing?.media
                      ? { ...message, media: existing.media }
                      : message;
                  }),
                  ...conversation.messages.filter((message) => (
                    message.deliveryStatus === 'sending'
                    && message.id.startsWith('optimistic:')
                    && !messages.some((loaded) => loaded.id === message.id)
                  )),
                ],
              }
            : conversation,
        ),
      );
    } catch (error) {
      if (!options.background) setDataError(error instanceof Error ? error.message : '消息加载失败');
    } finally {
      if (!options.background) setIsLoadingMessages(false);
    }
  }, []);

  const loadCustomerOrders = useCallback(async (conversationId: string) => {
    setIsLoadingCustomerOrders(true);
    try {
      const response = await getCustomerOrders(conversationId);
      console.info('[customer-orders] loaded', {
        conversationId,
        collectionStatus: response.collection_status,
        collectionError: response.collection_error,
        observedAt: response.observed_at,
        totalCount: response.total_count,
        visibleOrderCount: response.orders.length,
        outreachCount: response.outreach.length,
      });
      if (selectedIdRef.current === conversationId) setCustomerOrders(response);
      return response;
    } catch (error) {
      console.error('加载客户订单失败:', error);
      if (selectedIdRef.current === conversationId) {
        setCustomerOrders(null);
      }
      return null;
    } finally {
      if (selectedIdRef.current === conversationId) setIsLoadingCustomerOrders(false);
    }
  }, []);

  const loadCustomerProducts = useCallback(async (conversationId: string) => {
    const conversation = conversationsRef.current.find((item) => item.id === conversationId);
    const cacheKey = productShopCacheKey(conversation);
    const cached = cacheKey ? shopProductsRef.current.get(cacheKey) || null : null;
    if (selectedIdRef.current === conversationId && cached) setCustomerProducts(cached);
    setIsLoadingCustomerProducts(true);
    try {
      const response = await getCustomerProducts(conversationId);
      console.info('[customer-products] loaded', {
        conversationId,
        collectionStatus: response.collection_status,
        collectionError: response.collection_error,
        observedAt: response.observed_at,
        totalCount: response.total_count,
        visibleProductCount: response.products.length,
      });
      if (cacheKey && response.products.length > 0) {
        shopProductsRef.current.set(cacheKey, response);
      }
      if (selectedIdRef.current === conversationId) {
        setCustomerProducts(response.products.length > 0 ? response : cached || response);
      }
      return response;
    } catch (error) {
      console.error('鍔犺浇瀹㈡埛鍟嗗搧澶辫触:', error);
      if (selectedIdRef.current === conversationId) setCustomerProducts(cached);
      return null;
    } finally {
      if (selectedIdRef.current === conversationId) setIsLoadingCustomerProducts(false);
    }
  }, []);

  const loadConversationData = useCallback(async (
    options: {
      background?: boolean;
      refreshMessages?: boolean;
      refreshOrders?: boolean;
      refreshProducts?: boolean;
    } = {},
  ) => {
    const background = options.background === true;
    if (!background) {
      setIsLoadingConversations(true);
      setDataError('');
    }
    try {
      const response = await listConversations();
      const targetId = response.items.some((item) => item.id === selectedIdRef.current)
        ? selectedIdRef.current
        : response.items[0]?.id || '';
      const previousHumanRequired = humanRequiredSnapshotRef.current;
      const nextHumanRequired = new Map<string, string>();
      const newlyHumanRequired = response.items.filter((item) => {
        if (!item.human_required) return false;
        const notificationKey = `${item.id}:${item.human_required_at || 'active'}`;
        nextHumanRequired.set(item.id, notificationKey);
        return previousHumanRequired.get(item.id) !== notificationKey;
      });
      humanRequiredSnapshotRef.current = nextHumanRequired;
      setConversations((current) => {
        const mapped = response.items.map((item) => {
          const existing = current.find((conversation) => conversation.id === item.id);
          return mapConversation(item, existing?.messages);
        });
        return mapped;
      });
      if (newlyHumanRequired.length > 0) {
        void window.desktopBridge?.notifyHumanRequired({
          items: newlyHumanRequired.map((item) => ({
            conversationId: item.id,
            notificationKey: nextHumanRequired.get(item.id) || `${item.id}:active`,
            platformName: item.platform_name || item.platform_code,
            shopName: item.shop_name || '',
            customerName: item.customer_name || item.title || '',
          })),
          messageCenterVisible: currentViewRef.current === 'messages',
          viewingConversationId: selectedIdRef.current || null,
        }).catch((error) => console.error('发送待人工桌面通知失败:', error));
      }
      if (targetId) {
        const refreshes: Promise<unknown>[] = [];
        if (options.refreshMessages !== false) {
          refreshes.push(loadMessagesForConversation(targetId, { background }));
        }
        if (options.refreshOrders !== false) refreshes.push(loadCustomerOrders(targetId));
        if (options.refreshProducts !== false) refreshes.push(loadCustomerProducts(targetId));
        await Promise.all(refreshes);
      }
      else {
        selectedIdRef.current = '';
        setSelectedId('');
      }
      return response.items;
    } catch (error) {
      if (!background) setDataError(error instanceof Error ? error.message : '会话加载失败');
      return [];
    } finally {
      if (!background) setIsLoadingConversations(false);
    }
  }, [loadCustomerOrders, loadCustomerProducts, loadMessagesForConversation]);

  const refreshRpaBatchChanges = useCallback(async (
    affectedConversations: RpaBatchAffectedConversation[],
    options: { refreshOrders?: boolean; refreshProducts?: boolean } = {},
  ) => {
    const affectedIds = new Set(
      affectedConversations
        .map((item) => (typeof item.conversation_id === 'string' ? item.conversation_id : ''))
        .filter(Boolean),
    );
    const affectedExternalIds = new Set(
      affectedConversations
        .map((item) => (
          typeof item.external_conversation_id === 'string'
            ? item.external_conversation_id
            : ''
        ))
        .filter(Boolean),
    );
    const selectedBefore = selectedIdRef.current;
    const selectedBeforeConversation = conversationsRef.current.find((item) => item.id === selectedBefore);
    const selectedExternalId = selectedBeforeConversation?.externalConversationId || '';

    try {
      const response = await listConversations();
      const currentById = new Map(conversationsRef.current.map((item) => [item.id, item]));
      setConversations(response.items.map((item) => (
        mapConversation(item, currentById.get(item.id)?.messages)
      )));

      const selectedStillExists = response.items.some((item) => item.id === selectedBefore);
      const reboundSelected = selectedStillExists
        ? selectedBefore
        : selectedExternalId
          ? response.items.find((item) => item.external_conversation_id === selectedExternalId)?.id || ''
          : '';
      const firstAffected = response.items.find((item) => (
        affectedIds.has(item.id)
        || (item.external_conversation_id ? affectedExternalIds.has(item.external_conversation_id) : false)
      ));
      const targetId = reboundSelected || firstAffected?.id || response.items[0]?.id || '';
      if (!targetId) {
        selectedIdRef.current = '';
        setSelectedId('');
        return;
      }

      const target = response.items.find((item) => item.id === targetId);
      const targetWasAffected = Boolean(
        target
        && (
          affectedIds.has(target.id)
          || (target.external_conversation_id ? affectedExternalIds.has(target.external_conversation_id) : false)
        ),
      );
      const selectedWasRebound = Boolean(selectedBefore && targetId !== selectedBefore && targetId === reboundSelected);
      if (targetWasAffected || selectedWasRebound || !selectedBefore) {
        await loadMessagesForConversation(targetId, { background: true });
        if (options.refreshOrders !== false) void loadCustomerOrders(targetId);
        if (options.refreshProducts !== false) void loadCustomerProducts(targetId);
      }
    } catch {
      void loadConversationData({
        background: true,
        refreshMessages: true,
        refreshOrders: options.refreshOrders !== false,
        refreshProducts: options.refreshProducts !== false,
      });
    }
  }, [loadConversationData, loadCustomerOrders, loadCustomerProducts, loadMessagesForConversation]);

  const loadImportCandidates = useCallback(async () => {
    setIsLoadingImportCandidates(true);
    setImportError('');
    try {
      const nextCandidates = await window.desktopBridge?.getPddImportCandidates();
      setImportCandidates(nextCandidates || []);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : '拼多多会话扫描失败');
      setImportCandidates([]);
    } finally {
      setIsLoadingImportCandidates(false);
    }
  }, []);

  const openImportModal = useCallback(() => {
    setIsImportModalOpen(true);
    void loadImportCandidates();
  }, [loadImportCandidates]);

  useEffect(() => {
    if (!session || authReady) return;
    let cancelled = false;
    getCurrentUser()
      .then((user) => {
        if (cancelled) return;
        const currentSession = getStoredSession();
        if (currentSession) setSession({ ...currentSession, user });
      })
      .catch((error) => {
        if (cancelled) return;
        if (isAuthenticationError(error)) {
          clearStoredSession();
          setSession(null);
        } else {
          setConnectionStatus('disconnected');
        }
      })
      .finally(() => {
        if (!cancelled) setAuthReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [authReady, session]);

  useEffect(() => {
    if (!session || !authReady) return;
    let cancelled = false;
    const initializeMessageCenter = async () => {
      try {
        await window.desktopBridge?.startRpa({
          userId: session.user.id,
          accessToken: session.access_token,
        });
      } catch (error) {
        console.error('启动本机 RPA 节点失败:', error);
      }
      if (cancelled) return;
      await Promise.all([
        loadConversationData(),
        loadPlatformAccounts(),
        loadMonitoring(),
      ]);
    };
    void initializeMessageCenter();
    return () => {
      cancelled = true;
    };
  }, [
    authReady,
    loadConversationData,
    loadMonitoring,
    loadPlatformAccounts,
    session?.access_token,
    session?.user.id,
  ]);

  const clearAwaitingReplyFlag = useCallback(async (conversationId: string) => {
    setConversations((current) => current.map((conversation) => (
      conversation.id === conversationId
        ? { ...conversation, awaitingReply: false }
        : conversation
    )));
    const response = await clearConversationAwaitingReply(conversationId);
    setConversations((current) => current.map((conversation) => (
      conversation.id === conversationId
        ? mapConversation(response.conversation, conversation.messages)
        : conversation
    )));
  }, []);

  const clearAwaitingReplyIfNeeded = useCallback((conversationId: string) => {
    const conversation = conversationsRef.current.find((item) => item.id === conversationId);
    if (!conversation?.awaitingReply) return;
    void clearAwaitingReplyFlag(conversationId).catch((error) => {
      console.error('clear awaiting reply failed', error);
    });
  }, [clearAwaitingReplyFlag]);

  useEffect(() => {
    if (!session || !authReady) return;
    return connectRealtime(
      session.access_token,
      (event) => {
        if (event.type === 'rpa.platform_accounts.synced') {
          void loadPlatformAccounts();
          return;
        }
        if (event.type === 'message.queued' && event.message) {
          const nextMessage = mapMessage(event.message);
          const pendingIds = pendingAutomaticMessageIdsRef.current.get(event.message.conversation_id)
            || new Set<string>();
          pendingIds.add(event.message.id);
          pendingAutomaticMessageIdsRef.current.set(event.message.conversation_id, pendingIds);
          setConversations((current) =>
            current.map((conversation) =>
              conversation.id === event.message?.conversation_id
                ? {
                    ...conversation,
                    lastMessage: nextMessage.content,
                    time: nextMessage.timestamp,
                    messages: conversation.messages.some((message) => message.id === nextMessage.id)
                      ? conversation.messages
                      : [...conversation.messages, nextMessage],
                  }
                : conversation,
            ),
          );
          if (event.message.conversation_id === selectedIdRef.current) {
            if (automaticSendNoticeTimerRef.current) clearTimeout(automaticSendNoticeTimerRef.current);
            setAutomaticSendNotice((current) => ({
              kind: 'sending',
              text: '发送中',
              version: (current?.version || 0) + 1,
            }));
          }
          return;
        }
        if (event.type === 'automation.reply.started' && event.conversation_id) {
          if (event.conversation_id === selectedIdRef.current) {
            if (automaticSendNoticeTimerRef.current) clearTimeout(automaticSendNoticeTimerRef.current);
            setAutomaticSendNotice((current) => ({
              kind: 'sending',
              text: '自动回复中...',
              version: (current?.version || 0) + 1,
            }));
          }
          return;
        }
        if (event.type === 'automation.reply.failed' && event.conversation_id) {
          void listConversations().then((response) => {
            const updated = response.items.find((item) => item.id === event.conversation_id);
            if (!updated) return;
            setConversations((current) => current.map((conversation) => (
              conversation.id === event.conversation_id
                ? mapConversation(updated, conversation.messages)
                : conversation
            )));
          });
          if (event.conversation_id === selectedIdRef.current) {
            if (automaticSendNoticeTimerRef.current) clearTimeout(automaticSendNoticeTimerRef.current);
            setAutomaticSendNotice((current) => ({
              kind: 'error',
              text: '自动回复失败，已等待人工处理',
              version: (current?.version || 0) + 1,
            }));
            automaticSendNoticeTimerRef.current = setTimeout(() => {
              setAutomaticSendNotice(null);
              automaticSendNoticeTimerRef.current = null;
            }, 5000);
          }
          return;
        }
        if (event.type === 'message.sent' && event.message) {
          const nextMessage = mapMessage(event.message);
          const clientMessageId = typeof event.message.raw_payload.client_message_id === 'string'
            ? event.message.raw_payload.client_message_id
            : '';
          setConversations((current) => current.map((conversation) => {
            if (conversation.id !== event.message?.conversation_id) return conversation;
            const optimistic = clientMessageId
              ? conversation.messages.find((message) => message.id === clientMessageId)
              : undefined;
            const resolvedMessage = !nextMessage.media && optimistic?.media
              ? { ...nextMessage, media: optimistic.media }
              : nextMessage;
            const withoutOptimistic = clientMessageId
              ? conversation.messages.filter((message) => message.id !== clientMessageId)
              : conversation.messages;
            return {
              ...conversation,
              lastMessage: nextMessage.content,
              time: nextMessage.timestamp,
              awaitingReply: false,
              messages: withoutOptimistic.some((message) => message.id === resolvedMessage.id)
                ? withoutOptimistic
                : [...withoutOptimistic, resolvedMessage],
            };
          }));
          return;
        }
        if (event.type === 'automation.reply.completed' && event.message) {
          const nextMessage = mapMessage(event.message);
          const followUpMessages = Array.isArray(event.follow_up_messages)
            ? event.follow_up_messages.map(mapMessage)
            : event.follow_up_message ? [mapMessage(event.follow_up_message)] : [];
          const replyMessages = [nextMessage, ...followUpMessages];
          const pendingIds = pendingAutomaticMessageIdsRef.current.get(event.message.conversation_id)
            || new Set<string>();
          pendingIds.add(event.message.id);
          for (const item of followUpMessages) pendingIds.add(item.id);
          pendingAutomaticMessageIdsRef.current.set(event.message.conversation_id, pendingIds);
          setConversations((current) => current.map((conversation) => (
            conversation.id === event.message?.conversation_id
              ? {
                  ...conversation,
                  lastMessage: followUpMessages[followUpMessages.length - 1]?.content || nextMessage.content,
                  time: followUpMessages[followUpMessages.length - 1]?.timestamp || nextMessage.timestamp,
                  awaitingReply: false,
                  messages: replyMessages.reduce<Message[]>(
                    (messages, item) => (
                      messages.some((message) => message.id === item.id)
                        ? messages.map((message) => (message.id === item.id ? item : message))
                        : [...messages, item]
                    ),
                    conversation.messages,
                  ),
                }
              : conversation
          )));
          clearAwaitingReplyIfNeeded(event.message.conversation_id);
          if (event.message.conversation_id === selectedIdRef.current) {
            if (automaticSendNoticeTimerRef.current) clearTimeout(automaticSendNoticeTimerRef.current);
            setAutomaticSendNotice((current) => ({
              kind: 'sending',
              text: '发送中',
              version: (current?.version || 0) + 1,
            }));
          }
        }
        let handledSendCompletion = false;
        if (event.type === 'rpa.task.completed' && event.task?.task_type === 'send_message') {
          handledSendCompletion = true;
          const task = event.task;
          const textSent = task.result_json?.text_sent === true;
          const sent = task.status === 'completed' || textSent;
          const mergedFromMessageId = typeof task.result_json?.merged_from_message_id === 'string'
            ? task.result_json.merged_from_message_id
            : '';
          const imageMessageId = typeof task.result_json?.image_message_id === 'string'
            ? task.result_json.image_message_id
            : '';
          const imageMergedFromMessageId = typeof task.result_json?.image_merged_from_message_id === 'string'
            ? task.result_json.image_merged_from_message_id
            : '';
          const followUpMessageId = typeof task.payload_json?.follow_up_message_id === 'string'
            ? task.payload_json.follow_up_message_id
            : '';
          const followUpProductMessageIds = Array.isArray(task.payload_json?.follow_up_product_message_ids)
            ? task.payload_json.follow_up_product_message_ids.filter(
              (value): value is string => typeof value === 'string' && value.length > 0,
            )
            : [];
          const productFailedMessageIds = Array.isArray(task.result_json?.product_failed_message_ids)
            ? task.result_json.product_failed_message_ids.filter(
              (value): value is string => typeof value === 'string' && value.length > 0,
            )
            : [];
          const productSentMessageIds = Array.isArray(task.result_json?.product_message_ids)
            ? task.result_json.product_message_ids.filter(
              (value): value is string => typeof value === 'string' && value.length > 0,
            )
            : [];
          const completedMessageIds = new Set(
            [task.message_id, mergedFromMessageId, imageMessageId, imageMergedFromMessageId, followUpMessageId, ...followUpProductMessageIds].filter(
              (value): value is string => typeof value === 'string' && value.length > 0,
            ),
          );
          if (task.conversation_id && task.message_id) {
            const pendingIds = pendingAutomaticMessageIdsRef.current.get(task.conversation_id);
            if (pendingIds) {
              for (const messageId of completedMessageIds) pendingIds.delete(messageId);
            }
            if (pendingIds?.size === 0) pendingAutomaticMessageIdsRef.current.delete(task.conversation_id);
          }
          setConversations((current) => current.map((conversation) => {
            if (conversation.id !== task.conversation_id) return conversation;
            if (sent) {
              const messages = conversation.messages
                .filter((message) => (
                  message.id !== mergedFromMessageId
                  && message.id !== imageMergedFromMessageId
                ))
                .map((message) => (
                  message.id === task.message_id
                    || message.id === imageMessageId
                    || productSentMessageIds.includes(message.id)
                    ? { ...message, deliveryStatus: 'sent' as const }
                    : productFailedMessageIds.includes(message.id)
                      ? { ...message, deliveryStatus: 'failed' as const }
                    : message
                ));
              return {
                ...conversation,
                awaitingReply: false,
                messages,
              };
            }
            const messages = conversation.messages.filter((message) => (
              !completedMessageIds.has(message.id)
            ));
            const latest = messages[messages.length - 1];
            return {
              ...conversation,
              messages,
              lastMessage: latest?.content || '暂无消息',
              time: latest?.timestamp || '',
            };
          }));
          if (task.conversation_id === selectedIdRef.current) {
            if (automaticSendNoticeTimerRef.current) clearTimeout(automaticSendNoticeTimerRef.current);
            const stillSending = Boolean(
              task.conversation_id
              && pendingAutomaticMessageIdsRef.current.get(task.conversation_id)?.size,
            );
            setAutomaticSendNotice((current) => ({
              kind: stillSending ? 'sending' : sent ? 'success' : 'error',
              text: stillSending
                ? '发送中'
                : sent
                  ? '发送成功'
                  : `发送失败${task.error_message ? `：${task.error_message}` : ''}`,
              version: (current?.version || 0) + 1,
            }));
            if (!stillSending) {
              automaticSendNoticeTimerRef.current = setTimeout(() => {
                setAutomaticSendNotice(null);
                automaticSendNoticeTimerRef.current = null;
              }, sent ? 1800 : 5000);
            }
          }
          if (!sent && task.conversation_id) {
            void listConversations().then((response) => {
              const updated = response.items.find((item) => item.id === task.conversation_id);
              if (!updated) return;
              setConversations((current) => current.map((conversation) => (
                conversation.id === task.conversation_id
                  ? mapConversation(updated, conversation.messages)
                  : conversation
              )));
            });
          }
        }
        if (
          event.type === 'conversation.updated'
          || event.type === 'conversation.reset'
          || event.type === 'conversation.rebuilt'
          || event.type === 'conversation.cleared'
          || event.type === 'conversation.deleted'
        ) {
          if (handledSendCompletion && event.task?.conversation_id) {
            const conversationId = event.task.conversation_id;
            const refreshes: Promise<unknown>[] = [
              listConversations().then((response) => {
                const updated = response.items.find((item) => item.id === conversationId);
                if (!updated) return;
                setConversations((current) => current.map((conversation) => (
                  conversation.id === conversationId
                    ? mapConversation(updated, conversation.messages)
                    : conversation
                )));
              }),
            ];
            if (conversationId === selectedIdRef.current) {
              refreshes.push(loadMessagesForConversation(conversationId));
            }
            void Promise.all(refreshes);
          } else {
            void loadConversationData({ background: true });
          }
        }
        if (event.type === 'rpa.event') {
          const eventPayload = event.event && typeof event.event === 'object'
            ? event.event as Record<string, unknown>
            : null;
          const eventType = typeof eventPayload?.event_type === 'string' ? eventPayload.event_type : '';
          if (eventType === 'message_snapshot') {
            void loadConversationData({
              background: true,
              refreshMessages: true,
              refreshOrders: false,
            });
          } else if (eventType === 'conversation_snapshot') {
            void loadConversationData({
              background: true,
              refreshMessages: false,
              refreshOrders: false,
            });
          } else if (eventType === 'customer_orders_snapshot' && selectedIdRef.current) {
            void loadCustomerOrders(selectedIdRef.current);
          } else if (eventType === 'customer_products_snapshot' && selectedIdRef.current) {
            void loadCustomerProducts(selectedIdRef.current);
          }
        }
        if (event.type === 'rpa.events.batch' && Array.isArray(event.events)) {
          const eventTypes = new Set(event.events.map((item) => (
            item && typeof item === 'object' && typeof (item as Record<string, unknown>).event_type === 'string'
              ? (item as Record<string, unknown>).event_type as string
              : ''
          )));
          const affectedConversations = Array.isArray(event.affected_conversations)
            ? event.affected_conversations as RpaBatchAffectedConversation[]
            : [];
          if (eventTypes.has('message_snapshot')) {
            if (affectedConversations.length > 0) {
              void refreshRpaBatchChanges(affectedConversations, { refreshOrders: false });
            } else {
              void loadConversationData({
                background: true,
                refreshMessages: true,
                refreshOrders: false,
                refreshProducts: false,
              });
            }
          } else if (eventTypes.has('conversation_snapshot')) {
            void loadConversationData({
              background: true,
              refreshMessages: false,
              refreshOrders: false,
              refreshProducts: false,
            });
          }
          if (eventTypes.has('customer_orders_snapshot') && selectedIdRef.current) {
            void loadCustomerOrders(selectedIdRef.current);
          }
          if (eventTypes.has('customer_products_snapshot') && selectedIdRef.current) {
            void loadCustomerProducts(selectedIdRef.current);
          }
        }
        if (
          event.type.startsWith('rpa.')
          || event.type === 'conversation.updated'
          || event.type === 'automation.reply.completed'
        ) void loadMonitoring(monitoringModelRef.current);
      },
      setConnectionStatus,
      () => {
        void loadConversationData({ background: true });
      },
    );
  }, [
    authReady,
    clearAwaitingReplyIfNeeded,
    loadConversationData,
    loadCustomerOrders,
    loadCustomerProducts,
    loadMonitoring,
    refreshRpaBatchChanges,
    session?.access_token,
  ]);

  const clearHumanRequiredFlag = useCallback(async (conversationId: string) => {
    const response = await clearConversationHumanRequired(conversationId);
    humanRequiredSnapshotRef.current.delete(conversationId);
    setConversations((current) => current.map((conversation) => (
      conversation.id === conversationId
        ? mapConversation(response.conversation, conversation.messages)
        : conversation
    )));
  }, []);

  const clearHumanRequiredIfNeeded = useCallback((conversationId: string) => {
    const conversation = conversationsRef.current.find((item) => item.id === conversationId);
    if (!conversation?.humanRequired) return;
    void clearHumanRequiredFlag(conversationId).catch((error) => {
      console.error('自动清除待人工处理标记失败:', error);
    });
  }, [clearHumanRequiredFlag]);

  useEffect(() => window.desktopBridge?.onOpenHumanRequiredConversation((conversationId) => {
    setCurrentView('messages');
    setSelectedPlatform('pinduoduo');
    setSelectedCategory('all');
    setSelectedShop('all');
    setConversationSearch('');
    if (conversationId) {
      void Promise.all([
        loadMessagesForConversation(conversationId),
        loadCustomerOrders(conversationId),
        loadCustomerProducts(conversationId),
      ]);
      clearHumanRequiredIfNeeded(conversationId);
      clearAwaitingReplyIfNeeded(conversationId);
    }
  }), [clearAwaitingReplyIfNeeded, clearHumanRequiredIfNeeded, loadCustomerOrders, loadCustomerProducts, loadMessagesForConversation]);

  const handleMonitoringModelChange = useCallback((model: string) => {
    void loadMonitoring(model);
  }, [loadMonitoring]);

  const filteredConversations = useMemo(() => {
    let filtered = conversations;
    if (selectedPlatform !== 'all') {
      filtered = filtered.filter((conversation) => conversation.platform === selectedPlatform);
    }
    if (selectedCategory === 'pending') {
      filtered = filtered.filter((conversation) => conversation.awaitingReply);
    }
    if (selectedShop !== 'all') {
      filtered = filtered.filter((conversation) => conversation.shopId === selectedShop);
    }
    const keyword = conversationSearch.trim().toLocaleLowerCase();
    if (keyword) {
      filtered = filtered.filter((conversation) => [
        conversation.userName,
        conversation.lastMessage,
        conversation.shopName,
        conversation.platformName,
      ].some((value) => value.toLocaleLowerCase().includes(keyword)));
    }
    return filtered;
  }, [conversationSearch, conversations, selectedCategory, selectedPlatform, selectedShop]);

  useEffect(() => {
    if (filteredConversations.some((conversation) => conversation.id === selectedIdRef.current)) return;
    const nextId = filteredConversations[0]?.id || '';
    if (nextId) {
      void loadMessagesForConversation(nextId);
      return;
    }
    selectedIdRef.current = '';
    setSelectedId('');
  }, [filteredConversations, loadMessagesForConversation]);

  const selectedConversation = useMemo(
    () => filteredConversations.find((conversation) => conversation.id === selectedId),
    [filteredConversations, selectedId],
  );

  const resolveQuickReplyAccountId = useCallback((conversation: Conversation | null | undefined) => {
    if (!conversation || conversation.platform !== 'pinduoduo') return '';
    const localAccountId = conversation.localShopId?.trim();
    if (localAccountId) return localAccountId;
    return platformAccountById.get(conversation.shopId)?.local_account_id?.trim() || '';
  }, [platformAccountById]);

  const loadPlatformQuickReplies = useCallback(async (
    accountId: string,
    source: 'personal' | 'team',
    force = false,
  ) => {
    if (!accountId) {
      activePlatformQuickRepliesAccountRef.current = '';
      setPlatformQuickReplies(emptyPlatformQuickRepliesState());
      return;
    }
    if (!window.desktopBridge?.importPddPlatformPhrases) {
      const errorKey = source === 'personal' ? 'personalError' : 'teamError';
      const loadingKey = source === 'personal' ? 'personalLoading' : 'teamLoading';
      setPlatformQuickReplies((current) => ({
        ...current,
        accountId,
        [errorKey]: '当前运行环境不支持读取平台话术',
        [loadingKey]: false,
      }));
      return;
    }

    const cached = platformQuickRepliesCacheRef.current.get(accountId) || {
      personal: [],
      team: [],
      personalError: '',
      teamError: '',
      personalUnavailable: false,
      teamUnavailable: false,
      personalLoaded: false,
      teamLoaded: false,
    };
    const loadedKey = source === 'personal' ? 'personalLoaded' : 'teamLoaded';
    const loadingKey = source === 'personal' ? 'personalLoading' : 'teamLoading';
    const errorKey = source === 'personal' ? 'personalError' : 'teamError';
    const unavailableKey = source === 'personal' ? 'personalUnavailable' : 'teamUnavailable';
    const shouldLoad = force || !cached[loadedKey];
    activePlatformQuickRepliesAccountRef.current = accountId;
    setPlatformQuickReplies((current) => ({
      ...(current.accountId === accountId ? current : {
        ...emptyPlatformQuickRepliesState(accountId),
        personal: cached.personal,
        team: cached.team,
        personalError: cached.personalError,
        teamError: cached.teamError,
        personalUnavailable: cached.personalUnavailable,
        teamUnavailable: cached.teamUnavailable,
      }),
      accountId,
      [loadingKey]: shouldLoad,
    }));
    if (!shouldLoad) return;

    const requestKey = `${accountId}:${source}`;
    const existingRequest = platformQuickRepliesRequestsRef.current.get(requestKey);
    if (existingRequest && !force) return existingRequest;

    const request = (async () => {
      const nextEntry: PlatformQuickRepliesCacheEntry = {
        personal: cached.personal,
        team: cached.team,
        personalError: cached.personalError,
        teamError: cached.teamError,
        personalUnavailable: cached.personalUnavailable,
        teamUnavailable: cached.teamUnavailable,
        personalLoaded: cached.personalLoaded,
        teamLoaded: cached.teamLoaded,
      };
      try {
        let result: Awaited<ReturnType<NonNullable<typeof window.desktopBridge>['importPddPlatformPhrases']>> | null = null;
        let records: PlatformPhraseRecord[] = [];
        if (!force) {
          const cached = await getPlatformPhraseCache({ source, localAccountId: accountId });
          records = cached.item?.records || [];
        }
        if (!records.length) {
          result = await window.desktopBridge!.importPddPlatformPhrases({ accountId, source });
          records = result.status === 'collected'
            ? result.records as PlatformPhraseRecord[]
            : [];
          if (result.status === 'collected' && records.length) {
            void savePlatformPhraseCache({
              platform: 'pinduoduo',
              source,
              localAccountId: accountId,
              records,
              rawCount: result.raw_count,
            }).catch(() => undefined);
          }
        }
        const items = records
          .filter((record) => record && typeof record.content === 'string' && record.content.trim())
          .map((record) => mapPlatformQuickReply(record, source));
        const resultError = !result || result.status === 'collected'
          ? ''
          : result.error || '平台话术读取失败';
        const unavailable = source === 'team' && /未启用该功能|未开通|未启用/.test(resultError);
        nextEntry[source] = items;
        nextEntry[loadedKey] = true;
        nextEntry[errorKey] = unavailable ? '' : resultError;
        nextEntry[unavailableKey] = unavailable;
      } catch (error) {
        const message = error instanceof Error ? error.message : '平台话术读取失败';
        nextEntry[errorKey] = message;
        nextEntry[loadedKey] = false;
        nextEntry[unavailableKey] = false;
      }
      platformQuickRepliesCacheRef.current.set(accountId, nextEntry);
      if (activePlatformQuickRepliesAccountRef.current === accountId) {
        setPlatformQuickReplies((current) => ({
          ...(current.accountId === accountId ? current : emptyPlatformQuickRepliesState(accountId)),
          accountId,
          personal: nextEntry.personal,
          team: nextEntry.team,
          personalError: nextEntry.personalError,
          teamError: nextEntry.teamError,
          personalUnavailable: nextEntry.personalUnavailable,
          teamUnavailable: nextEntry.teamUnavailable,
          personalLoading: source === 'personal' ? false : current.personalLoading,
          teamLoading: source === 'team' ? false : current.teamLoading,
        }));
      }
    })();
    platformQuickRepliesRequestsRef.current.set(requestKey, request);
    try {
      await request;
    } finally {
      if (platformQuickRepliesRequestsRef.current.get(requestKey) === request) {
        platformQuickRepliesRequestsRef.current.delete(requestKey);
      }
    }
  }, []);

  const refreshPlatformQuickReplies = useCallback(async (source: 'personal' | 'team') => {
    const conversation = conversationsRef.current.find((item) => item.id === selectedIdRef.current);
    if (!conversation || conversation.platform !== 'pinduoduo') {
      return;
    }
    const accountId = resolveQuickReplyAccountId(conversation);
    if (!accountId) {
      const errorKey = source === 'personal' ? 'personalError' : 'teamError';
      setPlatformQuickReplies((current) => ({
        ...current,
        accountId: '',
        [errorKey]: '当前会话未关联本地拼多多店铺，请先刷新店铺状态',
      }));
      return;
    }
    await loadPlatformQuickReplies(accountId, source, true);
  }, [loadPlatformQuickReplies, resolveQuickReplyAccountId]);

  useEffect(() => {
    const accountId = resolveQuickReplyAccountId(selectedConversation);
    activePlatformQuickRepliesAccountRef.current = accountId;
    if (!accountId) {
      setPlatformQuickReplies(selectedConversation?.platform === 'pinduoduo'
        ? {
            ...emptyPlatformQuickRepliesState(),
            personalError: '当前会话未关联本地拼多多店铺，请先刷新店铺状态',
          }
        : emptyPlatformQuickRepliesState());
      return;
    }
    const cached = platformQuickRepliesCacheRef.current.get(accountId);
    if (cached) {
      setPlatformQuickReplies({
        accountId,
        personal: cached.personal,
        team: cached.team,
        personalError: cached.personalError,
        teamError: cached.teamError,
        personalUnavailable: cached.personalUnavailable,
        teamUnavailable: cached.teamUnavailable,
        personalLoading: false,
        teamLoading: false,
      });
    }
    void (async () => {
      await loadPlatformQuickReplies(accountId, 'personal');
      if (activePlatformQuickRepliesAccountRef.current !== accountId) return;
      await loadPlatformQuickReplies(accountId, 'team');
    })();
  }, [
    loadPlatformQuickReplies,
    resolveQuickReplyAccountId,
    selectedConversation?.localShopId,
    selectedConversation?.platform,
    selectedConversation?.shopId,
  ]);

  const selectedPlatformAccount = useMemo(() => (
    selectedConversation?.shopId
      ? platformAccountById.get(selectedConversation.shopId) || null
      : null
  ), [platformAccountById, selectedConversation?.shopId]);

  const selectedShopSummary = useMemo(() => (
    parseShopProductSummary(selectedPlatformAccount?.metadata_json?.shop_summary)
  ), [selectedPlatformAccount?.metadata_json]);

  const updatePlatformAccountState = useCallback((account: PlatformAccount) => {
    setPlatformAccounts((current) => {
      const exists = current.some((item) => item.id === account.id);
      return exists
        ? current.map((item) => (item.id === account.id ? account : item))
        : [...current, account];
    });
  }, []);

  const handleGenerateShopSummary = useCallback(async () => {
    if (!selectedPlatformAccount) throw new Error('请先选择已绑定店铺的会话');
    setIsGeneratingShopSummary(true);
    try {
      const account = await generatePlatformAccountShopSummary(selectedPlatformAccount.id);
      updatePlatformAccountState(account);
      return parseShopProductSummary(account.metadata_json.shop_summary);
    } finally {
      setIsGeneratingShopSummary(false);
    }
  }, [selectedPlatformAccount, updatePlatformAccountState]);

  const handleSaveShopSummary = useCallback(async (summary: { shop_intro: string; on_sale_products: string }) => {
    if (!selectedPlatformAccount) throw new Error('请先选择已绑定店铺的会话');
    setIsSavingShopSummary(true);
    try {
      const account = await updatePlatformAccountShopSummary(selectedPlatformAccount.id, summary);
      updatePlatformAccountState(account);
      return parseShopProductSummary(account.metadata_json.shop_summary);
    } finally {
      setIsSavingShopSummary(false);
    }
  }, [selectedPlatformAccount, updatePlatformAccountState]);

  const handleLogin = async (username: string, password: string) => {
    const nextSession = await login(username.trim(), password);
    storeSession(nextSession);
    setSession(nextSession);
    setAuthReady(true);
    setCurrentView('messages');
  };

  const handleLogout = () => {
    void window.desktopBridge?.closePlatformWorkspaces().catch(() => undefined);
    void window.desktopBridge?.clearHumanRequiredNotifications().catch(() => undefined);
    void logout().catch(() => undefined);
    clearStoredSession();
    setSession(null);
    setCurrentView('messages');
    setConversations([]);
    pendingAutomaticMessageIdsRef.current.clear();
    setAutomaticSendNotice(null);
    humanRequiredSnapshotRef.current.clear();
    selectedIdRef.current = '';
    setSelectedId('');
    setConnectionStatus('disconnected');
    activePlatformQuickRepliesAccountRef.current = '';
    platformQuickRepliesCacheRef.current.clear();
    platformQuickRepliesRequestsRef.current.clear();
    setPlatformQuickReplies(emptyPlatformQuickRepliesState());
  };

  const handleSendMessage = async (content: string, options: { quote?: Message | null } = {}) => {
    if (!selectedId) return { draftOnly: false };
    const selectedConversation = conversations.find((conversation) => conversation.id === selectedId);
    if (selectedConversation?.platform === 'pinduoduo') {
      if (!window.desktopBridge) throw new Error('当前运行环境不支持拼多多消息发送');
      const clientMessageId = `optimistic:${crypto.randomUUID()}`;
      const quotePayload = quotePayloadFromMessage(options.quote);
      const optimisticMessage: Message = {
        id: clientMessageId,
        sender: 'agent',
        content,
        timestamp: formatTime(new Date().toISOString()),
        deliveryStatus: 'sending',
        ...(quotePayload ? {
          quote: {
            platformMessageId: typeof quotePayload.msg_id === 'string' ? quotePayload.msg_id : null,
            sender: senderFromRole(quotePayload.sender_role),
            content: typeof quotePayload.content === 'string' ? quotePayload.content : '[引用消息]',
            ...(typeof quotePayload.image_url === 'string' && quotePayload.image_url
              ? { media: { type: 'image' as const, url: quotePayload.image_url } }
              : {}),
          },
        } : {}),
      };
      setConversations((current) => current.map((conversation) => (
        conversation.id === selectedId
          ? {
              ...conversation,
              lastMessage: content,
              time: optimisticMessage.timestamp,
              messages: [...conversation.messages, optimisticMessage],
            }
          : conversation
      )));
      let platformResult: Awaited<ReturnType<NonNullable<typeof window.desktopBridge>['sendPddMessage']>>;
      try {
        platformResult = await window.desktopBridge.sendPddMessage({
          platformAccountId: selectedConversation.shopId,
          localAccountId: selectedConversation.localShopId || null,
          externalConversationId: selectedConversation.externalConversationId || null,
          customerName: selectedConversation.userName,
          content,
          quoteMessageId: quotePayload ? options.quote?.platformMessageId || null : null,
        });
      } catch (error) {
        setConversations((current) => current.map((conversation) => {
          if (conversation.id !== selectedId) return conversation;
          const messages = conversation.messages.filter((message) => message.id !== clientMessageId);
          const latest = messages[messages.length - 1];
          return {
            ...conversation,
            messages,
            lastMessage: latest?.content || '暂无消息',
            time: latest?.timestamp || '',
          };
        }));
        throw error;
      }
      try {
        const response = await recordSentMessage(
          selectedId,
          content,
          platformResult.msg_id || null,
          clientMessageId,
          'text',
          {
            platformSentAt: pddTimestampToIso(platformResult.ts),
            rawPayload: {
              message_type: 'text',
              send_method: platformResult.method,
              quote_msg_id: quotePayload ? options.quote?.platformMessageId || null : null,
              pre_msg_id: platformResult.pre_msg_id || null,
              platform_ts: platformResult.ts || null,
              structured_payload: quotePayload ? {
                quote_msg_id: quotePayload ? options.quote?.platformMessageId || null : null,
                quote_msg: quotePayload,
              } : undefined,
            },
          },
        );
        const nextMessage = mapMessage(response.message);
        setConversations((current) => current.map((conversation) => (
          conversation.id === selectedId
            ? {
                ...conversation,
                lastMessage: nextMessage.content,
                time: nextMessage.timestamp,
                awaitingReply: false,
                messages: conversation.messages.some((message) => message.id === nextMessage.id)
                  ? conversation.messages.filter((message) => message.id !== clientMessageId)
                  : conversation.messages.map((message) => (
                      message.id === clientMessageId ? nextMessage : message
                    )),
              }
            : conversation
        )));
      } catch (error) {
        console.error('拼多多消息已发送，但服务端记录失败，将等待平台采集补齐:', error);
        setConversations((current) => current.map((conversation) => (
          conversation.id === selectedId
            ? {
                ...conversation,
                awaitingReply: false,
                messages: conversation.messages.map((message) => (
                  message.id === clientMessageId
                    ? { ...message, deliveryStatus: 'sent' }
                    : message
                )),
              }
            : conversation
        )));
      }
      clearHumanRequiredIfNeeded(selectedId);
      clearAwaitingReplyIfNeeded(selectedId);
      return { draftOnly: false, sendMethod: platformResult.method };
    }
    const response = await sendMessage(selectedId, content);
    const nextMessage = mapMessage(response.message);
    setConversations((current) =>
      current.map((conversation) =>
        conversation.id === selectedId
          ? {
              ...conversation,
              lastMessage: nextMessage.content,
              time: nextMessage.timestamp,
              messages: conversation.messages.some((message) => message.id === nextMessage.id)
                ? conversation.messages
                : [...conversation.messages, nextMessage],
            }
          : conversation,
      ),
    );
    clearHumanRequiredIfNeeded(selectedId);
    clearAwaitingReplyIfNeeded(selectedId);
    return { draftOnly: false };
  };

  const handleSendImage = async (imageDataUrl: string, options: { quote?: Message | null } = {}) => {
    if (!selectedId) throw new Error('请先选择会话');
    const selectedConversation = conversations.find((conversation) => conversation.id === selectedId);
    if (!selectedConversation || selectedConversation.platform !== 'pinduoduo') {
      throw new Error('当前仅支持向拼多多会话发送图片');
    }
    if (!window.desktopBridge) throw new Error('当前运行环境不支持拼多多图片发送');
    const clientMessageId = `optimistic:${crypto.randomUUID()}`;
    const quotePayload = quotePayloadFromMessage(options.quote);
    const optimisticMessage: Message = {
      id: clientMessageId,
      sender: 'agent',
      content: '[图片]',
      timestamp: formatTime(new Date().toISOString()),
      deliveryStatus: 'sending',
      media: { type: 'image', url: imageDataUrl },
      ...(quotePayload ? {
        quote: {
          platformMessageId: typeof quotePayload.msg_id === 'string' ? quotePayload.msg_id : null,
          sender: senderFromRole(quotePayload.sender_role),
          content: typeof quotePayload.content === 'string' ? quotePayload.content : '[引用消息]',
          ...(typeof quotePayload.image_url === 'string' && quotePayload.image_url
            ? { media: { type: 'image' as const, url: quotePayload.image_url } }
            : {}),
        },
      } : {}),
    };
    setConversations((current) => current.map((conversation) => (
      conversation.id === selectedId
        ? {
            ...conversation,
            lastMessage: '[图片]',
            time: optimisticMessage.timestamp,
            messages: [...conversation.messages, optimisticMessage],
          }
        : conversation
    )));
    let platformResult: Awaited<ReturnType<NonNullable<typeof window.desktopBridge>['sendPddImageData']>>;
    try {
      platformResult = await window.desktopBridge.sendPddImageData({
        platformAccountId: selectedConversation.shopId,
        localAccountId: selectedConversation.localShopId || null,
        externalConversationId: selectedConversation.externalConversationId || null,
        customerName: selectedConversation.userName,
        imageDataUrl,
        quoteMessageId: quotePayload ? options.quote?.platformMessageId || null : null,
      });
    } catch (error) {
      setConversations((current) => current.map((conversation) => {
        if (conversation.id !== selectedId) return conversation;
        const messages = conversation.messages.filter((message) => message.id !== clientMessageId);
        const latest = messages[messages.length - 1];
        return { ...conversation, messages, lastMessage: latest?.content || '暂无消息', time: latest?.timestamp || '' };
      }));
      throw error;
    }
    try {
      const response = await recordSentMessage(
        selectedId,
        '[图片]',
        platformResult.msg_id || null,
        clientMessageId,
        'image',
        {
          platformSentAt: pddTimestampToIso(platformResult.ts),
          rawPayload: {
            message_type: 'image',
            media_type: 'image',
            send_method: platformResult.method,
            quote_msg_id: quotePayload ? options.quote?.platformMessageId || null : null,
            pre_msg_id: platformResult.pre_msg_id || null,
            platform_ts: platformResult.ts || null,
            image_url: platformResult.image_url || null,
            structured_payload: quotePayload ? {
              quote_msg_id: quotePayload ? options.quote?.platformMessageId || null : null,
              quote_msg: quotePayload,
            } : undefined,
          },
        },
      );
      const nextMessage = mapMessage(response.message);
      if (!nextMessage.media) nextMessage.media = optimisticMessage.media;
      setConversations((current) => current.map((conversation) => (
        conversation.id === selectedId
          ? {
              ...conversation,
              lastMessage: '[图片]',
              time: nextMessage.timestamp,
              awaitingReply: false,
              messages: conversation.messages.some((message) => message.id === nextMessage.id)
                ? conversation.messages.filter((message) => message.id !== clientMessageId)
                : conversation.messages.map((message) => (
                    message.id === clientMessageId ? nextMessage : message
                  )),
            }
          : conversation
      )));
    } catch (error) {
      console.error('拼多多图片已发送，但服务端记录失败，将等待平台采集补齐:', error);
      setConversations((current) => current.map((conversation) => (
        conversation.id === selectedId
          ? {
              ...conversation,
              awaitingReply: false,
              messages: conversation.messages.map((message) => (
                message.id === clientMessageId ? { ...message, deliveryStatus: 'sent' } : message
              )),
            }
          : conversation
      )));
    }
    clearHumanRequiredIfNeeded(selectedId);
    clearAwaitingReplyIfNeeded(selectedId);
  };

  const handleListTransferCs = async (conversation: Conversation) => {
    if (conversation.platform !== 'pinduoduo') throw new Error('当前仅支持拼多多会话转移');
    if (!conversation.shopId || !conversation.externalConversationId) {
      throw new Error('当前会话缺少拼多多店铺或客户 UID，无法转移');
    }
    if (!window.desktopBridge?.listPddTransferCs) throw new Error('当前运行环境不支持拼多多会话转移');
    return window.desktopBridge.listPddTransferCs({
      platformAccountId: conversation.shopId,
      localAccountId: conversation.localShopId || null,
      externalConversationId: conversation.externalConversationId,
      customerName: conversation.userName,
    });
  };

  const handleTransferConversation = async (
    conversation: Conversation,
    targetCsid: string,
    transReason: string,
  ) => {
    if (conversation.platform !== 'pinduoduo') throw new Error('当前仅支持拼多多会话转移');
    if (!conversation.shopId || !conversation.externalConversationId) {
      throw new Error('当前会话缺少拼多多店铺或客户 UID，无法转移');
    }
    if (!window.desktopBridge?.transferPddConversation) throw new Error('当前运行环境不支持拼多多会话转移');
    return window.desktopBridge.transferPddConversation({
      platformAccountId: conversation.shopId,
      localAccountId: conversation.localShopId || null,
      externalConversationId: conversation.externalConversationId,
      customerName: conversation.userName,
      targetCsid,
      transReason: transReason || '无原因直接转移',
    });
  };

  const handleClearHumanRequired = clearHumanRequiredFlag;

  const handleClearConversationHistory = async (conversationId: string) => {
    const conversation = conversations.find((item) => item.id === conversationId);
    await withPreparedPddConversation(conversation, async () => {
      const response = await clearConversationHistory(conversationId);
      setConversations((current) => current.map((item) => (
        item.id === conversationId ? mapConversation(response.conversation, []) : item
      )));
      if (selectedIdRef.current === conversationId) {
        setCustomerOrders(null);
        setCustomerProducts(null);
      }
    });
  };

  const handleDeleteConversation = async (conversationId: string) => {
    const conversation = conversations.find((item) => item.id === conversationId);
    await withPreparedPddConversation(conversation, async () => {
      await deleteConversation(conversationId);
      setConversations((current) => {
        const next = current.filter((item) => item.id !== conversationId);
        if (selectedIdRef.current === conversationId) {
          const nextId = next[0]?.id || '';
          selectedIdRef.current = nextId;
          setSelectedId(nextId);
          setCustomerOrders(null);
          setCustomerProducts(null);
          if (nextId) void loadMessagesForConversation(nextId);
        }
        return next;
      });
    });
  };

  const handleLoadMessageSyncIssue = async (
    conversationId: string,
  ): Promise<MessageSyncIssueDetail> => getConversationMessageSyncIssue(conversationId);

  const handleDismissMessageSyncIssue = async (conversationId: string) => {
    const response = await dismissConversationMessageSyncIssue(conversationId);
    setConversations((current) => current.map((conversation) => (
      conversation.id === conversationId
        ? mapConversation(response.conversation, conversation.messages)
        : conversation
    )));
  };

  const handleRebuildMessageQueue = async (conversationId: string) => {
    const conversation = conversations.find((item) => item.id === conversationId);
    await withPreparedPddConversation(conversation, async () => {
      const response = await rebuildConversationMessageQueue(conversationId);
      const messages = response.messages.map(mapMessage);
      setConversations((current) => current.map((item) => (
        item.id === conversationId
          ? mapConversation(response.conversation, messages)
          : item
      )));
      if (selectedIdRef.current === conversationId) setCustomerOrders(null);
    });
  };

  const handleRefreshCustomerOrders = useCallback(async () => {
    const conversation = conversations.find((item) => item.id === selectedIdRef.current);
    if (!conversation) return;
    if (conversation.platform !== 'pinduoduo') {
      throw new Error('当前平台暂不支持自动读取客户订单');
    }
    if (!window.desktopBridge) throw new Error('当前运行环境不支持拼多多订单采集');
    const previousObservedAt = customerOrders?.conversation_id === conversation.id
      ? customerOrders.observed_at
      : null;
    setIsLoadingCustomerOrders(true);
    await window.desktopBridge.refreshPddCustomerOrders({
      platformAccountId: conversation.shopId,
      externalConversationId: conversation.externalConversationId || null,
      customerName: conversation.userName,
    });
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await loadCustomerOrders(conversation.id);
      if (response?.observed_at && response.observed_at !== previousObservedAt) break;
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
  }, [conversations, customerOrders, loadCustomerOrders]);

  const handleRefreshCustomerProducts = useCallback(async () => {
    const conversation = conversations.find((item) => item.id === selectedIdRef.current);
    if (!conversation) return null;
    if (conversation.platform !== 'pinduoduo') {
      throw new Error('当前平台暂不支持读取商品列表');
    }
    if (!window.desktopBridge) throw new Error('当前运行环境不支持拼多多商品采集');
    const previousObservedAt = customerProducts?.conversation_id === conversation.id
      ? customerProducts.observed_at
      : null;
    setIsLoadingCustomerProducts(true);
    try {
      const collected = await window.desktopBridge.refreshPddCustomerProducts({
        platformAccountId: conversation.shopId,
        localAccountId: conversation.localShopId || null,
        externalConversationId: null,
        customerName: conversation.userName,
      });
      const collectedProducts: CustomerProduct[] = collected.products.map((product) => {
        const rawProduct = product as unknown as Record<string, unknown>;
        const productId = String(rawProduct.product_id || rawProduct.platform_product_id || '');
        const goodsId = String(rawProduct.goods_id || productId || '');
        return {
        id: String(productId || rawProduct.link_url || rawProduct.title || crypto.randomUUID()),
        goods_id: goodsId,
        product_id: productId || null,
        platform_product_id: productId,
        title: typeof rawProduct.title === 'string' ? rawProduct.title : null,
        image_url: typeof rawProduct.image_url === 'string' ? rawProduct.image_url : null,
        link_url: typeof rawProduct.link_url === 'string' ? rawProduct.link_url : null,
        price: typeof rawProduct.price === 'number' ? rawProduct.price : null,
        price_label: typeof rawProduct.price_label === 'string' ? rawProduct.price_label : null,
        quantity: typeof rawProduct.quantity === 'number' ? rawProduct.quantity : null,
        sold_quantity: typeof rawProduct.sold_quantity === 'number' ? rawProduct.sold_quantity : null,
        sold_quantity_30d: typeof rawProduct.sold_quantity_30d === 'number' ? rawProduct.sold_quantity_30d : null,
        source: typeof rawProduct.source === 'string' ? rawProduct.source : null,
        raw_payload: rawProduct.raw_payload && typeof rawProduct.raw_payload === 'object'
          ? rawProduct.raw_payload as Record<string, unknown>
          : {},
        last_observed_at: collected.observed_at || new Date().toISOString(),
        };
      });
      const collectedResponse: CustomerProductsResponse = {
        conversation_id: conversation.id,
        status: collected.status,
        method: collected.method || 'api_recommend_goods',
        conversation_key: collected.conversation_key,
        customer_name: collected.customer_name,
        collection_status: collected.collection_status || (collected.status === 'collected' ? 'success' : 'unavailable'),
        collection_error: collected.error || null,
        observed_at: collected.observed_at || null,
        customer_key: collected.conversation_key || 'shop',
        total_count: collected.total_count || collectedProducts.length,
        has_more: collected.has_more === true,
        products: collectedProducts,
        error: collected.error || null,
      };
      const cacheKey = productShopCacheKey(conversation);
      if (cacheKey && collectedResponse.products.length > 0) {
        shopProductsRef.current.set(cacheKey, collectedResponse);
      }
      if (selectedIdRef.current === conversation.id) setCustomerProducts(collectedResponse);
      let latest: CustomerProductsResponse | null = null;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        latest = await loadCustomerProducts(conversation.id);
        if (latest?.observed_at && latest.observed_at !== previousObservedAt) break;
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
      if (cacheKey && latest && latest.products.length > 0) {
        shopProductsRef.current.set(cacheKey, latest);
      }
      return latest?.products.length ? latest : collectedResponse;
    } finally {
      if (selectedIdRef.current === conversation.id) setIsLoadingCustomerProducts(false);
    }
  }, [conversations, customerProducts, loadCustomerProducts]);

  const handleSendCustomerProduct = useCallback(async (product: CustomerProduct) => {
    const conversation = conversations.find((item) => item.id === selectedIdRef.current);
    const productId = String(product.product_id || '').trim();
    if (!conversation) throw new Error('请先选择会话');
    if (conversation.platform !== 'pinduoduo') throw new Error('当前平台暂不支持发送商品');
    if (!productId) throw new Error('商品 ID 缺失，无法发送');
    if (!window.desktopBridge) throw new Error('当前运行环境不支持拼多多商品发送');
    await window.desktopBridge.sendPddProduct({
      platformAccountId: conversation.shopId,
      localAccountId: conversation.localShopId || null,
      externalConversationId: conversation.externalConversationId || null,
      customerName: conversation.userName,
      productId,
    });
    await Promise.all([
      loadConversationData({
        background: true,
        refreshMessages: false,
        refreshOrders: false,
        refreshProducts: false,
      }),
      loadMessagesForConversation(conversation.id, { background: true }),
    ]);
    clearHumanRequiredIfNeeded(conversation.id);
    clearAwaitingReplyIfNeeded(conversation.id);
  }, [clearAwaitingReplyIfNeeded, clearHumanRequiredIfNeeded, conversations, loadConversationData, loadMessagesForConversation]);

  const handleImportCandidate = useCallback(async (candidate: PddImportCandidate) => {
    if (!window.desktopBridge) throw new Error('当前运行环境不支持桌面客服窗口导入');
    await window.desktopBridge.importPddConversation(candidate.accountId, candidate.conversationKey);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const items = await loadConversationData();
      const target = items.find((item) => (
        item.platform_account_id === candidate.platformAccountId
        && (candidate.externalConversationId
          ? item.external_conversation_id === candidate.externalConversationId
          : item.customer_name === candidate.customerName)
      ));
      if (target) {
        await loadMessagesForConversation(target.id);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    throw new Error('消息中心暂未收到导入的会话，请稍后刷新重试');
  }, [loadConversationData, loadMessagesForConversation]);

  return {
    isLoggedIn: Boolean(session),
    authReady,
    authMode,
    currentUser: session?.user,
    currentView,
    lang,
    isImportModalOpen,
    importCandidates,
    isLoadingImportCandidates,
    importError,
    selectedId,
    selectedPlatform,
    selectedCategory,
    selectedShop,
    conversationSearch,
    shops,
    isLogModalOpen,
    filteredConversations,
    selectedConversation,
    selectedShopSummary,
    isLoadingPlatformAccounts,
    isGeneratingShopSummary,
    isSavingShopSummary,
    isLoadingConversations,
    isLoadingMessages,
    dataError,
    connectionStatus,
    automaticSendNotice,
    bot,
    logs,
    statusEvents,
    isLoadingMonitoring,
    customerOrders,
    isLoadingCustomerOrders,
    customerProducts,
    isLoadingCustomerProducts,
    quickReplies: {
      personal: platformQuickReplies.personal,
      team: platformQuickReplies.team,
    },
    quickReplyStatus: {
      personal: {
        isLoading: platformQuickReplies.personalLoading,
        error: platformQuickReplies.personalError,
        unavailable: platformQuickReplies.personalUnavailable,
      },
      team: {
        isLoading: platformQuickReplies.teamLoading,
        error: platformQuickReplies.teamError,
        unavailable: platformQuickReplies.teamUnavailable,
      },
    },
    refreshPlatformQuickReplies,
    handleMonitoringModelChange,
    handleRefreshCustomerOrders,
    handleRefreshCustomerProducts,
    handleSendCustomerProduct,
    handleGenerateShopSummary,
    handleSaveShopSummary,
    loadMonitoring,
    handleLogin,
    handleLogout,
    handleSendMessage,
    handleSendImage,
    handleListTransferCs,
    handleTransferConversation,
    handleClearHumanRequired,
    handleClearConversationHistory,
    handleDeleteConversation,
    handleLoadMessageSyncIssue,
    handleDismissMessageSyncIssue,
    handleRebuildMessageQueue,
    handleImportCandidate,
    loadImportCandidates,
    openImportModal,
    handleToggleLang: () => setLang((current) => (current === 'zh' ? 'en' : 'zh')),
    setAuthMode,
    setCurrentView,
    setIsImportModalOpen,
    setSelectedId: (id: string) => {
      selectedIdRef.current = id;
      setAutomaticSendNotice(null);
      if (automaticSendNoticeTimerRef.current) {
        clearTimeout(automaticSendNoticeTimerRef.current);
        automaticSendNoticeTimerRef.current = null;
      }
      const selectedConversation = conversationsRef.current.find((conversation) => conversation.id === id);
      const cachedProducts = shopProductsRef.current.get(productShopCacheKey(selectedConversation)) || null;
      setCustomerProducts(cachedProducts);
      void Promise.all([loadMessagesForConversation(id), loadCustomerOrders(id), loadCustomerProducts(id)]);
      clearAwaitingReplyIfNeeded(id);
      clearHumanRequiredIfNeeded(id);
    },
    setSelectedPlatform: (platform: string) => {
      if (platform !== 'pinduoduo') return;
      setSelectedShop('all');
      setSelectedPlatform(platform);
    },
    setSelectedCategory,
    setSelectedShop,
    setConversationSearch,
    setIsLogModalOpen,
  };
}
