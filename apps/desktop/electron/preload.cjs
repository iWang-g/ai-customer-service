const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopBridge', {
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
  sendPddMessage: (payload) => ipcRenderer.invoke('pdd-workspace:send-message', payload),
  sendPddImage: (payload) => ipcRenderer.invoke('pdd-workspace:send-image', payload),
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
