/// <reference types="vite/client" />

interface PddWorkspaceAccount {
  id: string;
  alias: string;
  paused: boolean;
  createdAt: string;
  lastOpenedAt: string | null;
  platformAccountId: string | null;
  loginStatus: 'unknown' | 'login_required' | 'online' | 'offline' | 'risk_control' | 'account_mismatch' | 'error' | 'paused';
  runtimeStatus: 'idle' | 'queued' | 'loading' | 'ready' | 'error' | 'paused';
  collectionStatus: 'idle' | 'watching' | 'collecting' | 'login_required' | 'risk_control' | 'error' | 'paused';
  lastCollectedAt: string | null;
}

interface PddWorkspaceState {
  accounts: PddWorkspaceAccount[];
  archivedAccounts: PddWorkspaceAccount[];
  activeAccountId: string | null;
  navigation: {
    canGoBack?: boolean;
    canGoForward?: boolean;
    isLoading?: boolean;
  };
  rpa: {
    status: 'stopped' | 'starting' | 'online' | 'offline' | 'error';
    nodeId?: string | null;
    detail?: string | null;
    lastHeartbeatAt?: string | null;
  };
}

interface PddImportCandidate {
  id: string;
  accountId: string;
  platformAccountId: string | null;
  platformCode: 'pinduoduo' | 'wechat';
  platformName: string;
  shopName: string;
  conversationKey: string;
  externalConversationId: string | null;
  customerName: string;
  previewText: string | null;
  unreadCount: number;
  active: boolean;
}

interface WechatAccount {
  localAccountId: string;
  externalAccountId: string | null;
  platformAccountId: string | null;
  wechatName: string | null;
  wechatId: string | null;
  alias: string;
  processId: number | null;
  lastKnownProcessId: number | null;
  windowHandle: number | null;
  executablePath: string | null;
  loginStatus: string;
  healthStatus: string;
  identityStatus: string;
  identitySource: string | null;
  identityDetail: string | null;
  identityLastCheckedAt: string | null;
  identityProbeStatus: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  disconnectedAt: string | null;
}

interface Window {
  desktopBridge?: {
    showPlatformContextMenu(payload: { platformCode: 'pinduoduo' | 'wechat'; userId: string }): Promise<boolean>;
    getWechatAccounts(): Promise<WechatAccount[]>;
    identifyWechatAccounts(payload: { localAccountId?: string; force?: boolean }): Promise<{
      accounts: WechatAccount[];
      results: Array<{ localAccountId: string; status: string }>;
    }>;
    onShowWechatAccounts(listener: () => void): () => void;
    startRpa(payload: { userId: string; accessToken: string }): Promise<{
      status: string;
      nodeId?: string | null;
      detail?: string | null;
    }>;
    closePlatformWorkspaces(): Promise<void>;
    getPddImportCandidates(): Promise<PddImportCandidate[]>;
    importPddConversation(accountId: string, conversationKey: string): Promise<{
      status: 'collected';
      conversation_key: string;
      customer_name: string | null;
    }>;
    refreshPddCustomerOrders(payload: {
      platformAccountId: string;
      externalConversationId: string | null;
      customerName: string;
    }): Promise<{
      status: 'collected';
      conversation_key: string;
      customer_name: string | null;
    }>;
    preparePddConversationTestReset(payload: {
      platformAccountId: string;
      externalConversationId: string;
    }): Promise<{
      status: 'prepared';
      account_id: string;
      deleted_event_count: number;
    }>;
    resumePddConversationAfterTestReset(payload: {
      platformAccountId: string;
      externalConversationId: string;
    }): Promise<{
      status: 'resumed';
      account_id: string;
    }>;
    sendPddMessage(payload: {
      platformAccountId: string;
      externalConversationId: string | null;
      customerName: string;
      content: string;
    }): Promise<{
      status: 'sent';
      conversation_key: string;
      customer_name: string | null;
      method: 'click' | 'enter' | null;
    }>;
    sendPddImage(payload: {
      platformAccountId: string;
      externalConversationId: string | null;
      customerName: string;
      imageUrl: string;
    }): Promise<{ status: 'sent'; conversation_key: string; customer_name: string | null }>;
  };
  pddWorkspace: {
    getState(): Promise<PddWorkspaceState>;
    addAccount(): Promise<PddWorkspaceState>;
    selectAccount(accountId: string): Promise<PddWorkspaceState>;
    showAccountMenu(accountId: string): Promise<'rename' | 'reidentify' | 'toggle_paused' | 'remove' | null>;
    detectAccountName(accountId: string): Promise<{
      accountName: string;
      source: 'dom' | 'document_title';
    }>;
    renameAccount(accountId: string, alias: string): Promise<PddWorkspaceState>;
    setAccountPaused(accountId: string, paused: boolean): Promise<PddWorkspaceState>;
    removeAccount(accountId: string, clearStorage: boolean): Promise<PddWorkspaceState>;
    restoreAccount(accountId: string): Promise<PddWorkspaceState>;
    setOverlayOpen(open: boolean): Promise<PddWorkspaceState>;
    goBack(): Promise<PddWorkspaceState>;
    goForward(): Promise<PddWorkspaceState>;
    reload(): Promise<PddWorkspaceState>;
    onStateChanged(listener: (state: PddWorkspaceState) => void): () => void;
  };
}
