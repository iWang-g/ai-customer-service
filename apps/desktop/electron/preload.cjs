const { contextBridge, ipcRenderer } = require('electron');

function readRuntimeArgument(name) {
  const prefix = `--${name}=`;
  const argument = process.argv.find((value) => value.startsWith(prefix));
  if (!argument) return null;
  try {
    return decodeURIComponent(argument.slice(prefix.length));
  } catch {
    return null;
  }
}

const runtimeConfig = {
  businessApiUrl: readRuntimeArgument('acs-business-api-url'),
  knowledgeBaseUrl: readRuntimeArgument('acs-knowledge-base-url'),
  websocketUrl: readRuntimeArgument('acs-websocket-url'),
};
if (Object.values(runtimeConfig).every(Boolean)) {
  contextBridge.exposeInMainWorld('desktopConfig', Object.freeze(runtimeConfig));
}

contextBridge.exposeInMainWorld('desktopBridge', {
  setMessageNoticeOwner: (userId) => ipcRenderer.invoke('message-notice:owner', userId),
  publishMessageNotices: (payload) => ipcRenderer.invoke('message-notice:publish', payload),
  onOpenNoticeConversation: (listener) => {
    const handler = (_event, conversationId, platformCode) => listener(conversationId, platformCode);
    ipcRenderer.on('desktop:open-notice-conversation', handler);
    return () => ipcRenderer.removeListener('desktop:open-notice-conversation', handler);
  },
  showPlatformContextMenu: (payload) => ipcRenderer.invoke('desktop:show-platform-context-menu', payload),
  startRpa: (payload) => ipcRenderer.invoke('desktop:start-rpa', payload),
  closePlatformWorkspaces: () => ipcRenderer.invoke('desktop:close-platform-workspaces'),
  getPddImportCandidates: () => ipcRenderer.invoke('pdd-workspace:get-import-candidates'),
  importPddConversation: (accountId, conversationKey) => ipcRenderer.invoke(
    'pdd-workspace:import-conversation',
    { accountId, conversationKey },
  ),
  refreshPddCustomerOrders: (payload) => ipcRenderer.invoke(
    'pdd-workspace:refresh-customer-orders',
    payload,
  ),
  refreshQianniuCustomerOrders: (payload) => ipcRenderer.invoke('qianniu-workspace:refresh-customer-orders', payload),
  refreshQianniuStoreProducts: (payload) => ipcRenderer.invoke('qianniu-workspace:refresh-store-products', payload),
  refreshDouyinStoreProducts: (payload) => ipcRenderer.invoke('douyin-workspace:refresh-store-products', payload),
  probeDouyinProductDetail: (payload) => ipcRenderer.invoke('douyin-workspace:probe-product-detail', payload),
  probeDouyinOrders: (payload) => ipcRenderer.invoke('douyin-workspace:probe-orders', payload),
  cancelDouyinOrderProbe: (payload) => ipcRenderer.invoke('douyin-workspace:cancel-order-probe', payload),
  getQianniuProductSyncStatus: (payload) => ipcRenderer.invoke('qianniu-workspace:product-sync-status', payload),
  syncQianniuRecentMessages: (payload) => ipcRenderer.invoke('qianniu-workspace:sync-recent-messages', payload),
  refreshPddCustomerProducts: (payload) => ipcRenderer.invoke(
    'pdd-workspace:refresh-customer-products',
    payload,
  ),
  importPddPlatformPhrases: (payload) => ipcRenderer.invoke(
    'pdd-workspace:import-platform-phrases',
    payload,
  ),
  preparePddConversationTestReset: (payload) => ipcRenderer.invoke(
    'pdd-workspace:prepare-conversation-test-reset',
    payload,
  ),
  resumePddConversationAfterTestReset: (payload) => ipcRenderer.invoke(
    'pdd-workspace:resume-conversation-after-test-reset',
    payload,
  ),
  sendPddMessage: (payload) => ipcRenderer.invoke('pdd-workspace:send-message', payload),
  sendQianniuMessage: (payload) => ipcRenderer.invoke('qianniu-workspace:send-message', payload),
  listQianniuTransferTargets: (payload) => ipcRenderer.invoke('qianniu-workspace:list-transfer-targets', payload),
  listDouyinTransferTargets: (payload) => ipcRenderer.invoke('douyin-workspace:list-transfer-targets', payload),
  transferDouyinConversation: (payload) => ipcRenderer.invoke('douyin-workspace:transfer-conversation', payload),
  transferQianniuConversation: (payload) => ipcRenderer.invoke('qianniu-workspace:transfer-conversation', payload),
  listPddTransferCs: (payload) => ipcRenderer.invoke('pdd-workspace:list-transfer-cs', payload),
  transferPddConversation: (payload) => ipcRenderer.invoke('pdd-workspace:transfer-conversation', payload),
  sendPddProduct: (payload) => ipcRenderer.invoke('pdd-workspace:send-product', payload),
  sendPddImage: (payload) => ipcRenderer.invoke('pdd-workspace:send-image', payload),
  sendPddImageData: (payload) => ipcRenderer.invoke('pdd-workspace:send-image-data', payload),
  getWechatAccounts: () => ipcRenderer.invoke('wechat:get-accounts'),
  identifyWechatAccounts: (payload) => ipcRenderer.invoke('wechat:identify-accounts', payload),
  onShowWechatAccounts: (listener) => {
    const handler = () => listener();
    ipcRenderer.on('wechat:show-accounts', handler);
    return () => ipcRenderer.removeListener('wechat:show-accounts', handler);
  },
});

contextBridge.exposeInMainWorld('pddWorkspace', {
  getState: () => ipcRenderer.invoke('pdd-workspace:get-state'),
  addAccount: () => ipcRenderer.invoke('pdd-workspace:add-account'),
  selectAccount: (accountId) => ipcRenderer.invoke('pdd-workspace:select-account', { accountId }),
  showAccountMenu: (accountId) => ipcRenderer.invoke('pdd-workspace:show-account-menu', { accountId }),
  detectAccountName: (accountId) => ipcRenderer.invoke('pdd-workspace:detect-account-name', { accountId }),
  renameAccount: (accountId, alias) => ipcRenderer.invoke('pdd-workspace:rename-account', { accountId, alias }),
  setAccountPaused: (accountId, paused) => ipcRenderer.invoke('pdd-workspace:set-account-paused', { accountId, paused }),
  removeAccount: (accountId, clearStorage) => ipcRenderer.invoke('pdd-workspace:remove-account', { accountId, clearStorage }),
  restoreAccount: (accountId) => ipcRenderer.invoke('pdd-workspace:restore-account', { accountId }),
  setOverlayOpen: (open) => ipcRenderer.invoke('pdd-workspace:set-overlay-open', { open }),
  goBack: () => ipcRenderer.invoke('pdd-workspace:go-back'),
  goForward: () => ipcRenderer.invoke('pdd-workspace:go-forward'),
  reload: () => ipcRenderer.invoke('pdd-workspace:reload'),
  onStateChanged: (listener) => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on('pdd-workspace:state-changed', handler);
    return () => ipcRenderer.removeListener('pdd-workspace:state-changed', handler);
  },
});

contextBridge.exposeInMainWorld('douyinWorkspace', {
  getState: () => ipcRenderer.invoke('douyin-workspace:get-state'),
  addAccount: () => ipcRenderer.invoke('douyin-workspace:add-account'),
  selectAccount: (accountId) => ipcRenderer.invoke('douyin-workspace:select-account', { accountId }),
  showAccountMenu: (accountId) => ipcRenderer.invoke('douyin-workspace:show-account-menu', { accountId }),
  detectAccountName: (accountId) => ipcRenderer.invoke('douyin-workspace:detect-account-name', { accountId }),
  renameAccount: (accountId, alias) => ipcRenderer.invoke('douyin-workspace:rename-account', { accountId, alias }),
  setAccountPaused: (accountId, paused) => ipcRenderer.invoke('douyin-workspace:set-account-paused', { accountId, paused }),
  removeAccount: (accountId, clearStorage) => ipcRenderer.invoke('douyin-workspace:remove-account', { accountId, clearStorage }),
  restoreAccount: (accountId) => ipcRenderer.invoke('douyin-workspace:restore-account', { accountId }),
  setOverlayOpen: (open) => ipcRenderer.invoke('douyin-workspace:set-overlay-open', { open }),
  goBack: () => ipcRenderer.invoke('douyin-workspace:go-back'),
  goForward: () => ipcRenderer.invoke('douyin-workspace:go-forward'),
  reload: () => ipcRenderer.invoke('douyin-workspace:reload'),
  onStateChanged: (listener) => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on('douyin-workspace:state-changed', handler);
    return () => ipcRenderer.removeListener('douyin-workspace:state-changed', handler);
  },
});
