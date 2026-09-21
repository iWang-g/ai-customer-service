const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('messageNoticeBridge', {
  getState: () => ipcRenderer.invoke('message-notice:get-state'),
  setCollapsed: (collapsed) => ipcRenderer.invoke('message-notice:collapse', collapsed),
  openConversation: (conversationId) => ipcRenderer.invoke('message-notice:open', conversationId),
  onState: (listener) => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on('message-notice:state', handler);
    return () => ipcRenderer.removeListener('message-notice:state', handler);
  },
});
