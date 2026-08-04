import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  clearStoredSession,
  clearConversationHumanRequired,
  connectRealtime,
  getQaImageUrl,
  getCurrentUser,
  getMonitoringOverview,
  getStoredSession,
  listConversations,
  listMessages,
  listMonitoringEvents,
  listMonitoringLogs,
  login,
  logout,
  recordSentMessage,
  register,
  sendMessage,
  storeSession,
  type ApiConversation,
  type ApiMessage,
  type AuthSession,
  type MonitoringEvent,
  type MonitoringLog,
} from '../../shared/api/client';
import { MOCK_PLATFORMS } from '../types';
import type { BotStatus, Conversation, LogEntry, Message, Shop, StatusEvent } from '../types';

type AuthMode = 'login' | 'register';
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
      : message.sender_role === 'assistant' || message.sender_role === 'bot'
        ? 'bot'
        : 'agent';
  const mediaType = typeof message.raw_payload.media_type === 'string'
    ? message.raw_payload.media_type
    : '';
  const rawImageUrl = typeof message.raw_payload.image_url === 'string'
    ? message.raw_payload.image_url
    : '';
  return {
    id: message.id,
    sender,
    content: message.content,
    timestamp: formatTime(message.observed_at || message.sent_at),
    ...(mediaType === 'image' && rawImageUrl
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
    humanRequired: conversation.human_required,
    humanRequiredReason: conversation.human_required_reason,
    humanRequiredWord: conversation.human_required_word,
    time: formatTime(conversation.latest_message_at),
    messages: existingMessages,
  };
}

export function useMessageCenterController() {
  const [session, setSession] = useState<AuthSession | null>(() => getStoredSession());
  const [authReady, setAuthReady] = useState(() => getStoredSession() === null);
  const [authMode, setAuthMode] = useState<AuthMode>('login');
  const [currentView, setCurrentView] = useState<'messages' | 'admin'>('messages');
  const [lang, setLang] = useState<'zh' | 'en'>('zh');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [isLoadingConversations, setIsLoadingConversations] = useState(false);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [dataError, setDataError] = useState('');
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [importCandidates, setImportCandidates] = useState<PddImportCandidate[]>([]);
  const [isLoadingImportCandidates, setIsLoadingImportCandidates] = useState(false);
  const [importError, setImportError] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const selectedIdRef = useRef('');
  const [selectedPlatform, setSelectedPlatform] = useState('all');
  const [selectedCategory, setSelectedCategory] = useState<'all' | 'pending'>('all');
  const [selectedShop, setSelectedShop] = useState('all');
  const [isLogModalOpen, setIsLogModalOpen] = useState(false);
  const [bot, setBot] = useState<BotStatus>({
    model: 'deepseek-chat',
    availableModels: ['deepseek-chat'],
    uptime: null,
    requestsProcessed: 0,
    avgResponseTimeMs: null,
    health: 0,
  });
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [statusEvents, setStatusEvents] = useState<StatusEvent[]>([]);
  const [isLoadingMonitoring, setIsLoadingMonitoring] = useState(false);
  const monitoringModelRef = useRef('deepseek-chat');

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

  const loadMessagesForConversation = useCallback(async (conversationId: string) => {
    selectedIdRef.current = conversationId;
    setSelectedId(conversationId);
    setIsLoadingMessages(true);
    setDataError('');
    try {
      const response = await listMessages(conversationId);
      const messages = response.items.map(mapMessage);
      setConversations((current) =>
        current.map((conversation) =>
          conversation.id === conversationId ? { ...conversation, messages } : conversation,
        ),
      );
    } catch (error) {
      setDataError(error instanceof Error ? error.message : '消息加载失败');
    } finally {
      setIsLoadingMessages(false);
    }
  }, []);

  const loadConversationData = useCallback(async () => {
    setIsLoadingConversations(true);
    setDataError('');
    try {
      const response = await listConversations();
      const targetId = response.items.some((item) => item.id === selectedIdRef.current)
        ? selectedIdRef.current
        : response.items[0]?.id || '';
      setConversations((current) => {
        const mapped = response.items.map((item) => {
          const existing = current.find((conversation) => conversation.id === item.id);
          return mapConversation(item, existing?.messages);
        });
        return mapped;
      });
      if (targetId) await loadMessagesForConversation(targetId);
      else {
        selectedIdRef.current = '';
        setSelectedId('');
      }
      return response.items;
    } catch (error) {
      setDataError(error instanceof Error ? error.message : '会话加载失败');
      return [];
    } finally {
      setIsLoadingConversations(false);
    }
  }, [loadMessagesForConversation]);

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
      .catch(() => {
        if (cancelled) return;
        clearStoredSession();
        setSession(null);
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
          return;
        }
        if (event.type.startsWith('rpa.') || event.type === 'conversation.updated') void loadConversationData();
        if (
          event.type.startsWith('rpa.')
          || event.type === 'conversation.updated'
          || event.type === 'automation.reply.completed'
        ) void loadMonitoring(monitoringModelRef.current);
      },
      setConnectionStatus,
    );
  }, [authReady, loadConversationData, loadMonitoring, session?.access_token]);

  const handleMonitoringModelChange = useCallback((model: string) => {
    void loadMonitoring(model);
  }, [loadMonitoring]);

  const filteredConversations = useMemo(() => {
    let filtered = conversations;
    if (selectedPlatform !== 'all') {
      filtered = filtered.filter((conversation) => conversation.platform === selectedPlatform);
    }
    if (selectedCategory === 'pending') {
      filtered = filtered.filter((conversation) => conversation.status === 'pending' || conversation.humanRequired);
    }
    if (selectedShop !== 'all') {
      filtered = filtered.filter((conversation) => conversation.shopId === selectedShop);
    }
    return filtered;
  }, [conversations, selectedCategory, selectedPlatform, selectedShop]);

  const selectedConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === selectedId),
    [conversations, selectedId],
  );

  const handleLogin = async (username: string, password: string) => {
    const nextSession = await login(username.trim(), password);
    storeSession(nextSession);
    setSession(nextSession);
    setAuthReady(true);
    setCurrentView('messages');
  };

  const handleRegister = async (username: string, displayName: string, password: string) => {
    const nextSession = await register(username.trim(), displayName.trim(), password);
    storeSession(nextSession);
    setSession(nextSession);
    setAuthReady(true);
    setCurrentView('messages');
  };

  const handleLogout = () => {
    void window.desktopBridge?.closePlatformWorkspaces().catch(() => undefined);
    void logout().catch(() => undefined);
    clearStoredSession();
    setSession(null);
    setCurrentView('messages');
    setConversations([]);
    selectedIdRef.current = '';
    setSelectedId('');
    setConnectionStatus('disconnected');
  };

  const handleSendMessage = async (content: string) => {
    if (!selectedId) return { draftOnly: false };
    const selectedConversation = conversations.find((conversation) => conversation.id === selectedId);
    if (selectedConversation?.platform === 'pinduoduo') {
      if (!window.desktopBridge) throw new Error('当前运行环境不支持拼多多消息发送');
      const platformResult = await window.desktopBridge.sendPddMessage({
        platformAccountId: selectedConversation.shopId,
        externalConversationId: selectedConversation.externalConversationId || null,
        customerName: selectedConversation.userName,
        content,
      });
      const response = await recordSentMessage(selectedId, content);
      const nextMessage = mapMessage(response.message);
      setConversations((current) => current.map((conversation) => (
        conversation.id === selectedId
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

  const handleClearHumanRequired = async (conversationId: string) => {
    const response = await clearConversationHumanRequired(conversationId);
    setConversations((current) => current.map((conversation) => (
      conversation.id === conversationId
        ? mapConversation(response.conversation, conversation.messages)
        : conversation
    )));
  };

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
    shops,
    isLogModalOpen,
    filteredConversations,
    selectedConversation,
    isLoadingConversations,
    isLoadingMessages,
    dataError,
    connectionStatus,
    bot,
    logs,
    statusEvents,
    isLoadingMonitoring,
    handleMonitoringModelChange,
    loadMonitoring,
    handleLogin,
    handleRegister,
    handleLogout,
    handleSendMessage,
    handleClearHumanRequired,
    handleImportCandidate,
    loadImportCandidates,
    openImportModal,
    handleToggleLang: () => setLang((current) => (current === 'zh' ? 'en' : 'zh')),
    setAuthMode,
    setCurrentView,
    setIsImportModalOpen,
    setSelectedId: (id: string) => void loadMessagesForConversation(id),
    setSelectedPlatform,
    setSelectedCategory,
    setSelectedShop,
    setIsLogModalOpen,
  };
}
