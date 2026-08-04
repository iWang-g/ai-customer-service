import PlatformRail from '../components/PlatformRail';
import Sidebar from '../components/Sidebar';
import ChatWindow from '../components/ChatWindow';
import StatusPanel from '../components/StatusPanel';
import LogModal from '../components/LogModal';
import ImportModal from '../components/ImportModal';
import type { Conversation, BotStatus, LogEntry, Shop, StatusEvent } from '../types';
import type { ApiUser } from '../../shared/api/client';

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
  onOpenImportModal: () => void;
  selectedConversation?: Conversation;
  isLoadingMessages: boolean;
  dataError: string;
  onSendMessage: (content: string) => Promise<{ draftOnly: boolean; sendMethod?: 'click' | 'enter' | null }>;
  bot: BotStatus;
  logs: LogEntry[];
  statusEvents: StatusEvent[];
  isLoadingMonitoring: boolean;
  onMonitoringModelChange: (model: string) => void;
  connectionStatus: 'connecting' | 'connected' | 'disconnected';
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
  onOpenImportModal,
  selectedConversation,
  isLoadingMessages,
  dataError,
  onSendMessage,
  bot,
  logs,
  statusEvents,
  isLoadingMonitoring,
  onMonitoringModelChange,
  connectionStatus,
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
  return (
    <div className="flex h-screen w-full bg-white overflow-hidden selection:bg-brand-active selection:text-white" id="main-container">
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

      <div className="w-80 h-full border-r border-brand-border h-full flex flex-col">
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
          onOpenImportModal={onOpenImportModal}
          lang={lang}
        />
      </div>

      <ChatWindow
        conversation={selectedConversation}
        isLoading={isLoadingMessages}
        error={dataError}
        onSendMessage={onSendMessage}
      />

      <StatusPanel
        bot={bot}
        events={statusEvents}
        isLoading={isLoadingMonitoring}
        onModelChange={onMonitoringModelChange}
        onViewLogs={onViewLogs}
        connectionStatus={connectionStatus}
      />

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
