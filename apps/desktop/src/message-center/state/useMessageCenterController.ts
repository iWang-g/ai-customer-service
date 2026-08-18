import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  clearStoredSession,
  clearConversationHumanRequired,
  clearConversationHistory,
  connectRealtime,
  dismissConversationMessageSyncIssue,
  getQaImageUrl,
  getConversationMessageSyncIssue,
  getCurrentUser,
  getCustomerOrders,
  getMonitoringOverview,
  getStoredSession,
  isAuthenticationError,
  listConversations,
  listMessages,
  listMonitoringEvents,
  listMonitoringLogs,
  login,
  logout,
  deleteConversation,
  rebuildConversationMessageQueue,
  recordSentMessage,
  sendMessage,
  storeSession,
  subscribeToSessionChanges,
  type ApiConversation,
  type ApiMessage,
  type AuthSession,
  type CustomerOrdersResponse,
  type MonitoringEvent,
  type MonitoringLog,
  type MessageSyncIssueDetail,
} from '../../shared/api/client';
import { MOCK_PLATFORMS } from '../types';
import type { BotStatus, Conversation, LogEntry, Message, Shop, StatusEvent } from '../types';

type AuthMode = 'login';
type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

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

function mapMessage(message: ApiMessage): Message {
  const sender: Message['sender'] =
    message.sender_role === 'customer'
      ? 'user'
      : message.sender_role === 'platform'
        ? 'platform'
      : message.sender_role === 'assistant' || message.sender_role === 'bot'
        ? 'bot'
        : 'agent';
  const mediaType = typeof message.raw_payload.media_type === 'string'
    ? message.raw_payload.media_type
    : typeof message.raw_payload.message_type === 'string'
      ? message.raw_payload.message_type
      : '';
  const structuredPayload = message.raw_payload.structured_payload;
  const timelineData = structuredPayload && typeof structuredPayload === 'object'
    ? { ...(structuredPayload as Record<string, unknown>) }
    : null;
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
  const allowedTypes = new Set(['text', 'image', 'product', 'order', 'system', 'context', 'time', 'unknown']);
  const rawDisplayMode = typeof message.raw_payload.display_mode === 'string'
    ? message.raw_payload.display_mode
    : 'bubble';
  const allowedDisplayModes = new Set(['bubble', 'card', 'separator', 'notice', 'hidden']);
  return {
    id: message.id,
    sender,
    content: message.content,
    timestamp: message.time_label || formatTime(message.collected_at),
    deliveryStatus: message.message_status === 'queued' ? 'sending' : 'sent',
    timeline: {
      type: (allowedTypes.has(rawType) ? rawType : 'unknown') as NonNullable<Message['timeline']>['type'],
      displayMode: (allowedDisplayModes.has(rawDisplayMode) ? rawDisplayMode : 'bubble') as NonNullable<Message['timeline']>['displayMode'],
      ...(timelineData
        ? { data: {
            ...timelineData,
            ...(typeof timelineData.image_url === 'string'
              ? { image_url: getQaImageUrl(timelineData.image_url) }
              : {}),
          } as NonNullable<Message['timeline']>['data'] }
        : {}),
    },
    ...((mediaType === 'image' || rawImageUrl) && rawImageUrl
      ? { media: { type: 'image' as const, url: getQaImageUrl(rawImageUrl) } }
      : {}),
  };
}

function mapConversation(conversation: ApiConversation, existingMessages: Message[] = []): Conversation {
  const legacyShopName = typeof conversation.metadata_json.shop_name === 'string'
    ? conversation.metadata_json.shop_name
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
    shopId: conversation.platform_account_id
      || `legacy:${conversation.platform_code}:${shopName}`,
    shopName,
    externalConversationId: conversation.external_conversation_id,
    lastMessage: conversation.latest_message_text || '暂无消息',
    platform: conversation.platform_code,
    platformName,
    status,
    awaitingReply: conversation.awaiting_reply,
    humanRequired: conversation.human_required,
    humanRequiredReason: conversation.human_required_reason,
    humanRequiredWord: conversation.human_required_word,
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
  const monitoringModelRef = useRef('deepseek-v4-flash');
  const currentViewRef = useRef(currentView);
  const humanRequiredSnapshotRef = useRef(new Map<string, string>());

  useEffect(() => {
    currentViewRef.current = currentView;
  }, [currentView]);

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
      if (selectedIdRef.current === conversationId) setCustomerOrders(null);
      return null;
    } finally {
      if (selectedIdRef.current === conversationId) setIsLoadingCustomerOrders(false);
    }
  }, []);

  const loadConversationData = useCallback(async (
    options: {
      background?: boolean;
      refreshMessages?: boolean;
      refreshOrders?: boolean;
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
  }, [loadCustomerOrders, loadMessagesForConversation]);

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
    void loadConversationData();
    void loadMonitoring();
  }, [authReady, session?.user.id]);

  useEffect(() => {
    if (!session || !authReady) return;
    void window.desktopBridge
      ?.startRpa({ userId: session.user.id, accessToken: session.access_token })
      .catch((error) => console.error('启动本机 RPA 节点失败:', error));
  }, [authReady, session?.access_token, session?.user.id]);

  useEffect(() => {
    if (!session || !authReady) return;
    return connectRealtime(
      session.access_token,
      (event) => {
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
          const pendingIds = pendingAutomaticMessageIdsRef.current.get(event.message.conversation_id)
            || new Set<string>();
          pendingIds.add(event.message.id);
          pendingAutomaticMessageIdsRef.current.set(event.message.conversation_id, pendingIds);
          setConversations((current) => current.map((conversation) => (
            conversation.id === event.message?.conversation_id
              ? {
                  ...conversation,
                  lastMessage: nextMessage.content,
                  time: nextMessage.timestamp,
                  messages: conversation.messages.some((message) => message.id === nextMessage.id)
                    ? conversation.messages
                    : [...conversation.messages, nextMessage],
                }
              : conversation
          )));
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
          if (task.conversation_id && task.message_id) {
            const pendingIds = pendingAutomaticMessageIdsRef.current.get(task.conversation_id);
            pendingIds?.delete(task.message_id);
            if (pendingIds?.size === 0) pendingAutomaticMessageIdsRef.current.delete(task.conversation_id);
          }
          setConversations((current) => current.map((conversation) => {
            if (conversation.id !== task.conversation_id) return conversation;
            if (sent) {
              return {
                ...conversation,
                awaitingReply: false,
                messages: conversation.messages.map((message) => (
                  message.id === task.message_id
                    ? { ...message, deliveryStatus: 'sent' }
                    : message
                )),
              };
            }
            const messages = conversation.messages.filter((message) => message.id !== task.message_id);
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
          }
        }
        if (event.type === 'rpa.events.batch' && Array.isArray(event.events)) {
          const eventTypes = new Set(event.events.map((item) => (
            item && typeof item === 'object' && typeof (item as Record<string, unknown>).event_type === 'string'
              ? (item as Record<string, unknown>).event_type as string
              : ''
          )));
          if (eventTypes.has('message_snapshot')) {
            void loadConversationData({
              background: true,
              refreshMessages: true,
              refreshOrders: false,
            });
          } else if (eventTypes.has('conversation_snapshot')) {
            void loadConversationData({
              background: true,
              refreshMessages: false,
              refreshOrders: false,
            });
          }
          if (eventTypes.has('customer_orders_snapshot') && selectedIdRef.current) {
            void loadCustomerOrders(selectedIdRef.current);
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
  }, [authReady, loadConversationData, loadMonitoring, session?.access_token]);

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
      ]);
    }
  }), [loadCustomerOrders, loadMessagesForConversation]);

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
  };

  const handleSendMessage = async (content: string) => {
    if (!selectedId) return { draftOnly: false };
    const selectedConversation = conversations.find((conversation) => conversation.id === selectedId);
    if (selectedConversation?.platform === 'pinduoduo') {
      if (!window.desktopBridge) throw new Error('当前运行环境不支持拼多多消息发送');
      const clientMessageId = `optimistic:${crypto.randomUUID()}`;
      const optimisticMessage: Message = {
        id: clientMessageId,
        sender: 'agent',
        content,
        timestamp: formatTime(new Date().toISOString()),
        deliveryStatus: 'sending',
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
          externalConversationId: selectedConversation.externalConversationId || null,
          customerName: selectedConversation.userName,
          content,
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
        const response = await recordSentMessage(selectedId, content, null, clientMessageId);
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
    return { draftOnly: false };
  };

  const handleSendImage = async (imageDataUrl: string) => {
    if (!selectedId) throw new Error('请先选择会话');
    const selectedConversation = conversations.find((conversation) => conversation.id === selectedId);
    if (!selectedConversation || selectedConversation.platform !== 'pinduoduo') {
      throw new Error('当前仅支持向拼多多会话发送图片');
    }
    if (!window.desktopBridge) throw new Error('当前运行环境不支持拼多多图片发送');
    const clientMessageId = `optimistic:${crypto.randomUUID()}`;
    const optimisticMessage: Message = {
      id: clientMessageId,
      sender: 'agent',
      content: '[图片]',
      timestamp: formatTime(new Date().toISOString()),
      deliveryStatus: 'sending',
      media: { type: 'image', url: imageDataUrl },
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
    try {
      await window.desktopBridge.sendPddImageData({
        platformAccountId: selectedConversation.shopId,
        externalConversationId: selectedConversation.externalConversationId || null,
        customerName: selectedConversation.userName,
        imageDataUrl,
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
      const response = await recordSentMessage(selectedId, '[图片]', null, clientMessageId, 'image');
      const nextMessage = mapMessage(response.message);
      // Keep the local preview until the next platform snapshot supplies its durable URL.
      nextMessage.media = optimisticMessage.media;
      setConversations((current) => current.map((conversation) => (
        conversation.id === selectedId
          ? {
              ...conversation,
              lastMessage: '[图片]',
              time: nextMessage.timestamp,
              awaitingReply: false,
              messages: conversation.messages.map((message) => (
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
  };

  const handleClearHumanRequired = async (conversationId: string) => {
    const response = await clearConversationHumanRequired(conversationId);
    setConversations((current) => current.map((conversation) => (
      conversation.id === conversationId
        ? mapConversation(response.conversation, conversation.messages)
        : conversation
    )));
  };

  const handleClearConversationHistory = async (conversationId: string) => {
    const conversation = conversations.find((item) => item.id === conversationId);
    await withPreparedPddConversation(conversation, async () => {
      const response = await clearConversationHistory(conversationId);
      setConversations((current) => current.map((item) => (
        item.id === conversationId ? mapConversation(response.conversation, []) : item
      )));
      if (selectedIdRef.current === conversationId) setCustomerOrders(null);
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
    handleMonitoringModelChange,
    handleRefreshCustomerOrders,
    loadMonitoring,
    handleLogin,
    handleLogout,
    handleSendMessage,
    handleSendImage,
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
      setAutomaticSendNotice(null);
      if (automaticSendNoticeTimerRef.current) {
        clearTimeout(automaticSendNoticeTimerRef.current);
        automaticSendNoticeTimerRef.current = null;
      }
      void Promise.all([loadMessagesForConversation(id), loadCustomerOrders(id)]);
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
