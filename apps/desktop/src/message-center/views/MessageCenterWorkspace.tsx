import PlatformRail from '../components/PlatformRail';
import Sidebar from '../components/Sidebar';
import ChatWindow from '../components/ChatWindow';
import StatusPanel from '../components/StatusPanel';
import LogModal from '../components/LogModal';
import ImportModal from '../components/ImportModal';
import { useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react';
import type { Conversation, BotStatus, LogEntry, Message, Shop, StatusEvent } from '../types';
import type {
  ApiUser,
  CustomerProduct,
  CustomerProductsResponse,
  CustomerOrdersResponse,
  PlatformQuickReply,
  ShopProductSummary,
} from '../../shared/api/client';

const LAYOUT_STORAGE_KEY = 'messageCenter.layoutWidths';
const SHOP_COLOR_STORAGE_KEY = 'messageCenter.shopNameColors';
const MIN_SIDEBAR_WIDTH = 280;
const MAX_SIDEBAR_WIDTH = 420;
const MIN_RIGHT_PANEL_WIDTH = 300;
const MAX_RIGHT_PANEL_WIDTH = 480;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function readLayoutWidths(): { sidebar: number; rightPanel: number } {
  try {
    const raw = localStorage.getItem(LAYOUT_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as { sidebar?: unknown; rightPanel?: unknown } : {};
    return {
      sidebar: clamp(Number(parsed.sidebar) || 320, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH),
      rightPanel: clamp(Number(parsed.rightPanel) || 320, MIN_RIGHT_PANEL_WIDTH, MAX_RIGHT_PANEL_WIDTH),
    };
  } catch {
    return { sidebar: 320, rightPanel: 320 };
  }
}

function readShopNameColors(): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(SHOP_COLOR_STORAGE_KEY) || '{}') as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => typeof value === 'string'),
    ) as Record<string, string>;
  } catch {
    return {};
  }
}

interface MessageCenterWorkspaceProps {
  lang: 'zh' | 'en';
  selectedPlatform: string;
  onPlatformSelect: (id: string) => void;
  onOpenAdmin: () => void;
  onLogout: () => void;
  currentUser?: ApiUser;
  conversations: Conversation[];
  isLoadingConversations: boolean;
  selectedId: string;
  onSelectConversation: (id: string) => void;
  selectedCategory: 'all' | 'pending';
  onCategorySelect: (cat: 'all' | 'pending') => void;
  selectedShop: string;
  shops: Shop[];
  onShopSelect: (id: string) => void;
  conversationSearch: string;
  onConversationSearchChange: (value: string) => void;
  onOpenImportModal: () => void;
  selectedConversation?: Conversation;
  isLoadingMessages: boolean;
  dataError: string;
  onSendMessage: (content: string, options?: { quote?: Message | null }) => Promise<{ draftOnly: boolean; sendMethod?: 'click' | 'enter' | 'api_send_message' | null }>;
  onSendImage: (imageDataUrl: string, options?: { quote?: Message | null }) => Promise<void>;
  onListTransferCs: (conversation: Conversation) => Promise<{
    status: 'collected';
    cs_list: PddTransferCs[];
    trans_reason: PddTransferReason[];
  }>;
  onTransferConversation: (
    conversation: Conversation,
    targetCsid: string,
    transReason: string,
  ) => Promise<{
    status: 'transferred';
    target_cs_id: string | null;
    target_cs_username: string | null;
    target_cs_nickname: string | null;
  }>;
  quickReplies: {
    personal: PlatformQuickReply[];
    team: PlatformQuickReply[];
  };
  quickReplyStatus: {
    personal: { isLoading: boolean; error: string; unavailable: boolean };
    team: { isLoading: boolean; error: string; unavailable: boolean };
  };
  onRefreshQuickReplies: (source: 'personal' | 'team') => Promise<void>;
  automaticSendNotice: {
    kind: 'sending' | 'success' | 'error';
    text: string;
    version: number;
  } | null;
  onClearHumanRequired: (conversationId: string) => Promise<void>;
  onClearConversationHistory: (conversationId: string) => Promise<void>;
  onDeleteConversation: (conversationId: string) => Promise<void>;
  bot: BotStatus;
  logs: LogEntry[];
  statusEvents: StatusEvent[];
  isLoadingMonitoring: boolean;
  onMonitoringModelChange: (model: string) => void;
  connectionStatus: 'connecting' | 'connected' | 'disconnected';
  customerOrders: CustomerOrdersResponse | null;
  isLoadingCustomerOrders: boolean;
  onRefreshCustomerOrders: () => Promise<void>;
  customerProducts: CustomerProductsResponse | null;
  isLoadingCustomerProducts: boolean;
  onRefreshCustomerProducts: () => Promise<CustomerProductsResponse | null>;
  onSendCustomerProduct: (product: CustomerProduct) => Promise<void>;
  shopSummary: ShopProductSummary;
  isLoadingShopSummary: boolean;
  isGeneratingShopSummary: boolean;
  isSavingShopSummary: boolean;
  onGenerateShopSummary: () => Promise<ShopProductSummary>;
  onSaveShopSummary: (summary: { shop_intro: string; on_sale_products: string }) => Promise<ShopProductSummary>;
  onViewLogs: () => void;
  isLogModalOpen: boolean;
  onCloseLogModal: () => void;
  isImportModalOpen: boolean;
  onCloseImportModal: () => void;
  candidates: PddImportCandidate[];
  isLoadingImportCandidates: boolean;
  importError: string;
  onRefreshImportCandidates: () => void;
  onImportCandidate: (candidate: PddImportCandidate) => Promise<void>;
}

export default function MessageCenterWorkspace({
  lang,
  selectedPlatform,
  onPlatformSelect,
  onOpenAdmin,
  onLogout,
  currentUser,
  conversations,
  isLoadingConversations,
  selectedId,
  onSelectConversation,
  selectedCategory,
  onCategorySelect,
  selectedShop,
  shops,
  onShopSelect,
  conversationSearch,
  onConversationSearchChange,
  onOpenImportModal,
  selectedConversation,
  isLoadingMessages,
  dataError,
  onSendMessage,
  onSendImage,
  onListTransferCs,
  onTransferConversation,
  quickReplies,
  quickReplyStatus,
  onRefreshQuickReplies,
  automaticSendNotice,
  onClearHumanRequired,
  onClearConversationHistory,
  onDeleteConversation,
  bot,
  logs,
  statusEvents,
  isLoadingMonitoring,
  onMonitoringModelChange,
  connectionStatus,
  customerOrders,
  isLoadingCustomerOrders,
  onRefreshCustomerOrders,
  customerProducts,
  isLoadingCustomerProducts,
  onRefreshCustomerProducts,
  onSendCustomerProduct,
  shopSummary,
  isLoadingShopSummary,
  isGeneratingShopSummary,
  isSavingShopSummary,
  onGenerateShopSummary,
  onSaveShopSummary,
  onViewLogs,
  isLogModalOpen,
  onCloseLogModal,
  isImportModalOpen,
  onCloseImportModal,
  candidates,
  isLoadingImportCandidates,
  importError,
  onRefreshImportCandidates,
  onImportCandidate,
}: MessageCenterWorkspaceProps) {
  const [layoutWidths, setLayoutWidths] = useState(readLayoutWidths);
  const [shopNameColors, setShopNameColors] = useState(readShopNameColors);
  const [quickReplyInsert, setQuickReplyInsert] = useState<{
    conversationId: string;
    sourceId: string;
    content: string;
  } | null>(null);

  useEffect(() => {
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layoutWidths));
  }, [layoutWidths]);

  useEffect(() => {
    localStorage.setItem(SHOP_COLOR_STORAGE_KEY, JSON.stringify(shopNameColors));
  }, [shopNameColors]);

  useEffect(() => {
    setQuickReplyInsert(null);
  }, [selectedConversation?.id]);

  const handleSelectQuickReply = (item: PlatformQuickReply) => {
    if (!selectedConversation) return;
    setQuickReplyInsert({
      conversationId: selectedConversation.id,
      sourceId: item.source_id,
      content: item.content,
    });
  };

  const startResize = (target: 'sidebar' | 'rightPanel', startEvent: ReactMouseEvent<HTMLButtonElement>) => {
    startEvent.preventDefault();
    const startX = startEvent.clientX;
    const startWidth = target === 'sidebar' ? layoutWidths.sidebar : layoutWidths.rightPanel;
    const handleMouseMove = (event: MouseEvent) => {
      const delta = event.clientX - startX;
      setLayoutWidths((current) => ({
        ...current,
        [target]: target === 'sidebar'
          ? clamp(startWidth + delta, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH)
          : clamp(startWidth - delta, MIN_RIGHT_PANEL_WIDTH, MAX_RIGHT_PANEL_WIDTH),
      }));
    };
    const handleMouseUp = () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  return (
    <div className="flex h-screen w-full min-w-0 bg-white overflow-hidden selection:bg-brand-active selection:text-white" id="main-container">
      <PlatformRail
        selectedPlatform={selectedPlatform}
        onPlatformSelect={onPlatformSelect}
        onOpenAdmin={onOpenAdmin}
        onLogout={onLogout}
        userName={currentUser?.display_name || currentUser?.username || '客服账号'}
        userId={currentUser?.id || ''}
        userRole={currentUser?.role || 'agent'}
        lang={lang}
      />

      <div
        className="h-full shrink-0 border-r border-brand-border flex flex-col"
        style={{ width: layoutWidths.sidebar }}
      >
        <Sidebar
          conversations={conversations}
          isLoading={isLoadingConversations}
          error={dataError}
          selectedId={selectedId}
          onSelect={onSelectConversation}
          selectedCategory={selectedCategory}
          onCategorySelect={onCategorySelect}
          selectedShop={selectedShop}
          shops={shops}
          onShopSelect={onShopSelect}
          searchTerm={conversationSearch}
          onSearchTermChange={onConversationSearchChange}
          onOpenImportModal={onOpenImportModal}
          onClearHumanRequired={onClearHumanRequired}
          onClearConversationHistory={onClearConversationHistory}
          onDeleteConversation={onDeleteConversation}
          shopNameColors={shopNameColors}
          onShopNameColorsChange={setShopNameColors}
          lang={lang}
        />
      </div>

      <button
        type="button"
        onMouseDown={(event) => startResize('sidebar', event)}
        className="group h-full w-1.5 shrink-0 cursor-col-resize bg-transparent hover:bg-sky-100"
        aria-label="调整会话栏宽度"
        title="调整会话栏宽度"
      >
        <span className="mx-auto block h-full w-px bg-transparent group-hover:bg-sky-300" />
      </button>

      <ChatWindow
        conversation={selectedConversation}
        isLoading={isLoadingMessages}
        error={dataError}
        onSendMessage={onSendMessage}
        onSendImage={onSendImage}
        onListTransferCs={onListTransferCs}
        onTransferConversation={onTransferConversation}
        quickReplies={quickReplies}
        quickReplyInsert={quickReplyInsert}
        onQuickReplyInserted={() => setQuickReplyInsert(null)}
        automaticSendNotice={automaticSendNotice}
      />

      <button
        type="button"
        onMouseDown={(event) => startResize('rightPanel', event)}
        className="group h-full w-1.5 shrink-0 cursor-col-resize bg-transparent hover:bg-sky-100"
        aria-label="调整右侧栏宽度"
        title="调整右侧栏宽度"
      >
        <span className="mx-auto block h-full w-px bg-transparent group-hover:bg-sky-300" />
      </button>

      <div className="h-full shrink-0" style={{ width: layoutWidths.rightPanel }}>
        <StatusPanel
          bot={bot}
          events={statusEvents}
          isLoading={isLoadingMonitoring}
          onModelChange={onMonitoringModelChange}
          onViewLogs={onViewLogs}
          connectionStatus={connectionStatus}
          isLoadingConversations={isLoadingConversations}
          customerOrders={customerOrders}
          isLoadingCustomerOrders={isLoadingCustomerOrders}
          onRefreshCustomerOrders={onRefreshCustomerOrders}
          customerProducts={customerProducts}
          isLoadingCustomerProducts={isLoadingCustomerProducts}
          onRefreshCustomerProducts={onRefreshCustomerProducts}
          onSendCustomerProduct={onSendCustomerProduct}
          shopSummary={shopSummary}
          isLoadingShopSummary={isLoadingShopSummary}
          isGeneratingShopSummary={isGeneratingShopSummary}
          isSavingShopSummary={isSavingShopSummary}
          onGenerateShopSummary={onGenerateShopSummary}
          onSaveShopSummary={onSaveShopSummary}
          conversation={selectedConversation}
          quickReplies={quickReplies}
          quickReplyStatus={quickReplyStatus}
          onRefreshQuickReplies={onRefreshQuickReplies}
          onSelectQuickReply={handleSelectQuickReply}
        />
      </div>

      <LogModal isOpen={isLogModalOpen} onClose={onCloseLogModal} logs={logs} isLoading={isLoadingMonitoring} />

      <ImportModal
        isOpen={isImportModalOpen}
        onClose={onCloseImportModal}
        candidates={candidates}
        isLoading={isLoadingImportCandidates}
        error={importError}
        onRefresh={onRefreshImportCandidates}
        onImport={onImportCandidate}
        lang={lang}
      />
    </div>
  );
}
