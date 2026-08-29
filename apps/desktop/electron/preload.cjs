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
  notifyHumanRequired: (payload) => ipcRenderer.invoke('desktop:notify-human-required', payload),
  clearHumanRequiredNotifications: () => ipcRenderer.invoke('desktop:clear-human-required-notifications'),
  onOpenHumanRequiredConversation: (listener) => {
    const handler = (_event, conversationId) => listener(conversationId);
    ipcRenderer.on('desktop:open-human-required-conversation', handler);
    return () => ipcRenderer.removeListener('desktop:open-human-required-conversation', handler);
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
