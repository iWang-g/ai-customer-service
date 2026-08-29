/// <reference types="vite/client" />

interface PddWorkspaceAccount {
  id: string;
  alias: string;
  paused: boolean;
  createdAt: string;
  lastOpenedAt: string | null;
  platformAccountId: string | null;
  externalAccountId?: string | null;
  platformAccountName?: string | null;
  platformAccountLogoUrl: string | null;
  platformAccountServiceUsername?: string | null;
  platformAccountCsId?: string | null;
  platformAccountCsUid?: string | null;
  platformAccountIsMallOwner?: boolean;
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

interface PddCustomerProduct {
  product_id: string | null;
  title: string | null;
  image_url: string | null;
  link_url: string | null;
  price?: number | null;
  price_label?: string | null;
  quantity?: number | null;
  sold_quantity?: number | null;
  sold_quantity_30d?: number | null;
  source?: string | null;
  raw_payload?: Record<string, unknown>;
}

interface PddCustomerProductsResponse {
  status: 'collected' | 'failed';
  method?: 'api_recommend_goods';
  conversation_key: string | null;
  customer_name: string | null;
  collection_status?: 'success' | 'empty' | 'unavailable';
  observed_at?: string | null;
  total_count?: number;
  has_more?: boolean;
  products: PddCustomerProduct[];
  error?: string | null;
}

interface PddTransferCs {
  csid: string;
  accountName: string;
  username?: string;
  nickname: string;
  remark: string;
  unreplyNum: number;
  recvUser: number | null;
  bindWechat: boolean;
  id?: string;
}

interface PddTransferReason {
  code: string | number | null;
  desc: string;
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
  desktopConfig?: {
    businessApiUrl: string;
    knowledgeBaseUrl: string;
    websocketUrl: string;
  };
  desktopBridge?: {
    notifyHumanRequired(payload: {
      items: Array<{
        conversationId: string;
        notificationKey: string;
        platformName: string;
        shopName: string;
        customerName: string;
      }>;
      messageCenterVisible: boolean;
      viewingConversationId: string | null;
    }): Promise<boolean>;
    clearHumanRequiredNotifications(): Promise<boolean>;
    onOpenHumanRequiredConversation(listener: (conversationId: string | null) => void): () => void;
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
      localAccountId?: string | null;
      externalConversationId: string | null;
      customerName: string;
    }): Promise<{
      status: 'collected';
      conversation_key: string;
      customer_name: string | null;
    }>;
    refreshPddCustomerProducts(payload: {
      platformAccountId: string;
      localAccountId?: string | null;
      externalConversationId: string | null;
      customerName: string;
    }): Promise<PddCustomerProductsResponse>;
    importPddPlatformPhrases(payload: {
      accountId: string;
      source: 'personal' | 'team';
    }): Promise<{
      status: 'collected' | 'failed';
      account_id: string;
      source: 'personal' | 'team';
      records: Array<{
        source_id: string;
        category: string;
        quick_key: string;
        content: string;
        images: Array<{ url: string; width?: number | null; height?: number | null; image_size?: number | null }>;
      }>;
      raw_count: number;
      error?: string | null;
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
      localAccountId?: string | null;
      externalConversationId: string | null;
      customerName: string;
      content: string;
      quoteMessageId?: string | null;
    }): Promise<{
      status: 'sent';
      conversation_key: string;
      customer_name: string | null;
      method: 'api_send_message';
      msg_id: string | null;
      pre_msg_id: string | null;
      ts: string | null;
    }>;
    listPddTransferCs(payload: {
      platformAccountId: string;
      localAccountId?: string | null;
      externalConversationId?: string | null;
      customerName?: string | null;
    }): Promise<{
      status: 'collected';
      method: 'api_get_assign_cs_list';
      cs_list: PddTransferCs[];
      trans_reason: PddTransferReason[];
      error: null;
    }>;
    transferPddConversation(payload: {
      platformAccountId: string;
      localAccountId?: string | null;
      externalConversationId: string;
      customerName: string;
      targetCsid: string;
      transReason?: string | null;
    }): Promise<{
      status: 'transferred';
      method: 'api_move_conversation';
      conversation_key: string | null;
      customer_name: string | null;
      target_cs_id: string | null;
      target_cs_username: string | null;
      target_cs_nickname: string | null;
      trans_reason: string | null;
      error: null;
    }>;
    sendPddProduct(payload: {
      platformAccountId: string;
      localAccountId?: string | null;
      externalConversationId: string | null;
      customerName: string;
      productId: string;
    }): Promise<{
      status: 'sent';
      conversation_key: string;
      customer_name: string | null;
      method: 'api_send_product';
      product_id: string | null;
      backfill?: {
        status?: string;
        message_count?: number;
        has_more?: boolean;
        error?: string | null;
      } | null;
    }>;
    sendPddImage(payload: {
      platformAccountId: string;
      localAccountId?: string | null;
      externalConversationId: string | null;
      customerName: string;
      imageUrl: string;
      quoteMessageId?: string | null;
    }): Promise<{
      status: 'sent';
      conversation_key: string;
      customer_name: string | null;
      method: 'api_send_image';
      msg_id: string | null;
      pre_msg_id: string | null;
      ts: string | null;
      image_url: string | null;
    }>;
    sendPddImageData(payload: {
      platformAccountId: string;
      localAccountId?: string | null;
      externalConversationId: string | null;
      customerName: string;
      imageDataUrl: string;
      quoteMessageId?: string | null;
    }): Promise<{
      status: 'sent';
      conversation_key: string;
      customer_name: string | null;
      method: 'api_send_image';
      msg_id: string | null;
      pre_msg_id: string | null;
      ts: string | null;
      image_url: string | null;
    }>;
  };
  pddWorkspace: {
    getState(): Promise<PddWorkspaceState>;
    addAccount(): Promise<PddWorkspaceState>;
    selectAccount(accountId: string): Promise<PddWorkspaceState>;
    showAccountMenu(accountId: string): Promise<'rename' | 'reidentify' | 'toggle_paused' | 'remove' | null>;
    detectAccountName(accountId: string): Promise<{
      accountName: string;
      source: 'dom' | 'document_title' | 'pdd_api_latest_conversations' | 'pdd_api_custom_service_info' | 'pdd_api_userinfo_realtime' | 'pdd_api_shop_info';
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
