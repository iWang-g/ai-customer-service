/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import LoginScreen from './components/LoginScreen';
import AdminApp from '../admin/App';
import MessageCenterWorkspace from './views/MessageCenterWorkspace';
import { useMessageCenterController } from './state/useMessageCenterController';

export default function App() {
  const controller = useMessageCenterController();

  if (!controller.authReady) {
    return (
      <div className="h-screen w-full flex items-center justify-center bg-slate-50 text-sm font-semibold text-slate-500">
        正在恢复登录状态...
      </div>
    );
  }

  if (!controller.isLoggedIn) {
    return (
      <LoginScreen
        onLogin={controller.handleLogin}
      />
    );
  }

  if (controller.currentView === 'admin') {
    return <AdminApp onBack={() => controller.setCurrentView('messages')} />;
  }

  return (
    <MessageCenterWorkspace
      lang={controller.lang}
      selectedPlatform={controller.selectedPlatform}
      onPlatformSelect={controller.setSelectedPlatform}
      onOpenAdmin={() => controller.setCurrentView('admin')}
      onLogout={controller.handleLogout}
      currentUser={controller.currentUser}
      conversations={controller.filteredConversations}
      isLoadingConversations={controller.isLoadingConversations}
      selectedId={controller.selectedId}
      onSelectConversation={controller.setSelectedId}
      selectedCategory={controller.selectedCategory}
      onCategorySelect={controller.setSelectedCategory}
      selectedShop={controller.selectedShop}
      shops={controller.shops}
      onShopSelect={controller.setSelectedShop}
      conversationSearch={controller.conversationSearch}
      onConversationSearchChange={controller.setConversationSearch}
      onOpenImportModal={controller.openImportModal}
      selectedConversation={controller.selectedConversation}
      isLoadingMessages={controller.isLoadingMessages}
      dataError={controller.dataError}
      onSendMessage={controller.handleSendMessage}
      onSendImage={controller.handleSendImage}
      automaticSendNotice={controller.automaticSendNotice}
      onClearHumanRequired={controller.handleClearHumanRequired}
      onClearConversationHistory={controller.handleClearConversationHistory}
      onDeleteConversation={controller.handleDeleteConversation}
      onLoadMessageSyncIssue={controller.handleLoadMessageSyncIssue}
      onDismissMessageSyncIssue={controller.handleDismissMessageSyncIssue}
      onRebuildMessageQueue={controller.handleRebuildMessageQueue}
      bot={controller.bot}
      logs={controller.logs}
      statusEvents={controller.statusEvents}
      isLoadingMonitoring={controller.isLoadingMonitoring}
      onMonitoringModelChange={controller.handleMonitoringModelChange}
      connectionStatus={controller.connectionStatus}
      customerOrders={controller.customerOrders}
      isLoadingCustomerOrders={controller.isLoadingCustomerOrders}
      onRefreshCustomerOrders={controller.handleRefreshCustomerOrders}
      onViewLogs={() => controller.setIsLogModalOpen(true)}
      isLogModalOpen={controller.isLogModalOpen}
      onCloseLogModal={() => controller.setIsLogModalOpen(false)}
      isImportModalOpen={controller.isImportModalOpen}
      onCloseImportModal={() => controller.setIsImportModalOpen(false)}
      candidates={controller.importCandidates}
      isLoadingImportCandidates={controller.isLoadingImportCandidates}
      importError={controller.importError}
      onRefreshImportCandidates={controller.loadImportCandidates}
      onImportCandidate={controller.handleImportCandidate}
    />
  );
}
