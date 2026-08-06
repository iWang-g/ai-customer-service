import { app, BrowserWindow, ipcMain, Menu, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PddAccountRegistry } from './platform-workspace/account-registry.js';
import { PddWorkspaceManager } from './platform-workspace/workspace-manager.js';
import { PddDiagnosticLogger } from './platform-workspace/pinduoduo/diagnostic-logger.js';
import { RpaProcessManager } from './rpa/process-manager.js';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const devServerUrl = process.env.VITE_DEV_SERVER_URL;
const preloadPath = path.join(currentDirectory, 'preload.cjs');
const pddPreloadPath = path.join(currentDirectory, 'platform-workspace', 'pinduoduo', 'preload.cjs');
const diagnosticLogDirectory = app.isPackaged
  ? path.join(app.getPath('userData'), 'logs')
  : path.join(currentDirectory, '..', '..', '..', 'logs');
let mainWindow = null;
let pddWorkspaceManager = null;
let pddAccountRegistry = null;
let rpaProcessManager = null;
let shutdownStarted = false;
let shutdownComplete = false;

function isValidUserId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

function isValidAccountId(value) {
  return typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value);
}

function isValidAccessToken(value) {
  return typeof value === 'string' && value.length >= 32 && value.length <= 8192;
}

function registerIpcHandlers() {
  ipcMain.handle('desktop:show-platform-context-menu', (event, payload) => {
    if (payload?.platformCode !== 'pinduoduo' || !isValidUserId(payload?.userId)) {
      throw new Error('平台工作区参数无效');
    }
    const ownerWindow = BrowserWindow.fromWebContents(event.sender) || mainWindow;
    const menu = Menu.buildFromTemplate([
      {
        label: '打开原平台工作区',
        click: () => void pddWorkspaceManager.open(payload.userId),
      },
    ]);
    menu.popup({ window: ownerWindow || undefined });
    return true;
  });

  ipcMain.handle('desktop:start-rpa', async (_event, payload) => {
    if (!isValidUserId(payload?.userId) || !isValidAccessToken(payload?.accessToken)) {
      throw new Error('RPA 启动参数无效');
    }
    await pddWorkspaceManager.bindUser(payload.userId);
    await rpaProcessManager.start({ userId: payload.userId, accessToken: payload.accessToken });
    rpaProcessManager.setAccounts([
      ...pddAccountRegistry.list(payload.userId),
      ...pddAccountRegistry.list(payload.userId, { archived: true }),
    ]);
    return rpaProcessManager.getState();
  });
  ipcMain.handle('desktop:close-platform-workspaces', async () => {
    await pddWorkspaceManager.closeForLogout();
    await rpaProcessManager.stop();
  });
  ipcMain.handle('pdd-workspace:get-state', () => pddWorkspaceManager.getState());
  ipcMain.handle('pdd-workspace:add-account', () =>
    pddWorkspaceManager.addAccount(),
  );
  ipcMain.handle('pdd-workspace:select-account', (_event, payload) => {
    if (!isValidAccountId(payload?.accountId)) throw new Error('店铺账号参数无效');
    return pddWorkspaceManager.selectAccount(payload.accountId);
  });
  ipcMain.handle('pdd-workspace:show-account-menu', (event, payload) => {
    if (!isValidAccountId(payload?.accountId)) throw new Error('店铺账号参数无效');
    const account = pddWorkspaceManager.getState().accounts.find(
      (item) => item.id === payload.accountId,
    );
    if (!account) throw new Error('店铺账号不存在');
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    return new Promise((resolve) => {
      let resolved = false;
      const finish = (action = null) => {
        if (resolved) return;
        resolved = true;
        resolve(action);
      };
      const menu = Menu.buildFromTemplate([
        { label: '重命名', click: () => finish('rename') },
        {
          label: '店铺名称重识别',
          enabled: !account.paused,
          click: () => finish('reidentify'),
        },
        {
          label: account.paused ? '恢复运行' : '暂停运行',
          click: () => finish('toggle_paused'),
        },
        { type: 'separator' },
        { label: '移除店铺', click: () => finish('remove') },
      ]);
      menu.popup({
        window: ownerWindow || undefined,
        callback: () => finish(null),
      });
    });
  });
  ipcMain.handle('pdd-workspace:rename-account', (_event, payload) => {
    if (!isValidAccountId(payload?.accountId)) throw new Error('店铺账号参数无效');
    return pddWorkspaceManager.renameAccount(payload.accountId, payload.alias);
  });
  ipcMain.handle('pdd-workspace:detect-account-name', (_event, payload) => {
    if (!isValidAccountId(payload?.accountId)) throw new Error('店铺账号参数无效');
    return pddWorkspaceManager.detectAccountName(payload.accountId);
  });
  ipcMain.handle('pdd-workspace:set-account-paused', (_event, payload) => {
    if (!isValidAccountId(payload?.accountId) || typeof payload?.paused !== 'boolean') {
      throw new Error('店铺账号参数无效');
    }
    return pddWorkspaceManager.setAccountPaused(payload.accountId, payload.paused);
  });
  ipcMain.handle('pdd-workspace:remove-account', (_event, payload) => {
    if (!isValidAccountId(payload?.accountId) || typeof payload?.clearStorage !== 'boolean') {
      throw new Error('店铺账号参数无效');
    }
    return pddWorkspaceManager.removeAccount(payload.accountId, payload.clearStorage);
  });
  ipcMain.handle('pdd-workspace:restore-account', (_event, payload) => {
    if (!isValidAccountId(payload?.accountId)) throw new Error('店铺账号参数无效');
    return pddWorkspaceManager.restoreAccount(payload.accountId);
  });
  ipcMain.handle('pdd-workspace:set-overlay-open', (_event, payload) =>
    pddWorkspaceManager.setOverlayOpen(Boolean(payload?.open)),
  );
  ipcMain.handle('pdd-workspace:go-back', () => pddWorkspaceManager.goBack());
  ipcMain.handle('pdd-workspace:go-forward', () => pddWorkspaceManager.goForward());
  ipcMain.handle('pdd-workspace:reload', () => pddWorkspaceManager.reload());
  ipcMain.handle('pdd-workspace:get-import-candidates', () =>
    pddWorkspaceManager.listImportCandidates(),
  );
  ipcMain.handle('pdd-workspace:import-conversation', (_event, payload) => {
    if (!isValidAccountId(payload?.accountId)) throw new Error('店铺账号参数无效');
    if (typeof payload?.conversationKey !== 'string' || payload.conversationKey.length === 0 || payload.conversationKey.length > 128) {
      throw new Error('会话参数无效');
    }
    return pddWorkspaceManager.importConversation(payload.accountId, payload.conversationKey);
  });
  ipcMain.handle('pdd-workspace:refresh-customer-orders', (_event, payload) => {
    if (typeof payload?.platformAccountId !== 'string' || payload.platformAccountId.length > 128) {
      throw new Error('平台店铺参数无效');
    }
    if (payload.externalConversationId !== null && payload.externalConversationId !== undefined
      && (typeof payload.externalConversationId !== 'string' || payload.externalConversationId.length > 128)) {
      throw new Error('目标会话参数无效');
    }
    if (typeof payload?.customerName !== 'string' || payload.customerName.length > 128) {
      throw new Error('客户名称参数无效');
    }
    return pddWorkspaceManager.refreshCustomerOrders({
      platformAccountId: payload.platformAccountId,
      externalConversationId: payload.externalConversationId || null,
      customerName: payload.customerName,
    });
  });
  ipcMain.handle('pdd-workspace:send-message', (_event, payload) => {
    if (typeof payload?.platformAccountId !== 'string' || payload.platformAccountId.length > 128) {
      throw new Error('平台店铺参数无效');
    }
    if (payload.externalConversationId !== null && payload.externalConversationId !== undefined
      && (typeof payload.externalConversationId !== 'string' || payload.externalConversationId.length > 128)) {
      throw new Error('目标会话参数无效');
    }
    if (typeof payload?.customerName !== 'string' || payload.customerName.length > 128) {
      throw new Error('客户名称参数无效');
    }
    if (typeof payload?.content !== 'string' || !payload.content.trim() || payload.content.length > 4000) {
      throw new Error('消息内容无效');
    }
    return pddWorkspaceManager.sendMessage({
      platformAccountId: payload.platformAccountId,
      externalConversationId: payload.externalConversationId || null,
      customerName: payload.customerName,
      content: payload.content,
    });
  });
  ipcMain.handle('pdd-workspace:send-image', (_event, payload) => {
    if (typeof payload?.platformAccountId !== 'string' || payload.platformAccountId.length > 128) {
      throw new Error('平台店铺参数无效');
    }
    if (typeof payload?.imageUrl !== 'string' || !/^https?:\/\//i.test(payload.imageUrl)) {
      throw new Error('图片地址参数无效');
    }
    if (typeof payload?.customerName !== 'string' || payload.customerName.length > 128) {
      throw new Error('客户名称参数无效');
    }
    return pddWorkspaceManager.sendImage({
      platformAccountId: payload.platformAccountId,
      externalConversationId: payload.externalConversationId || null,
      customerName: payload.customerName,
      imageUrl: payload.imageUrl,
    });
  });
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#f8fafc',
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (devServerUrl) {
    void window.loadURL(devServerUrl);
  } else {
    void window.loadFile(path.join(currentDirectory, '..', 'dist', 'index.html'));
  }
  mainWindow = window;
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
    if (process.platform !== 'darwin') app.quit();
  });
}

app.whenReady().then(() => {
  pddAccountRegistry = new PddAccountRegistry(app.getPath('userData'));
  const pddDiagnosticLogger = new PddDiagnosticLogger(diagnosticLogDirectory);
  pddDiagnosticLogger.write('system', {
    type: 'diagnostic',
    level: 'info',
    stage: 'logger_initialized',
    details: { packaged: app.isPackaged },
    observed_at: new Date().toISOString(),
  });
  const agentPath = app.isPackaged
    ? path.join(process.resourcesPath, 'rpa', 'agent.py')
    : path.join(currentDirectory, '..', '..', '..', 'agents', 'rpa', 'agent.py');
  rpaProcessManager = new RpaProcessManager({
    userDataPath: app.getPath('userData'),
    agentPath,
    apiBaseUrl: process.env.BUSINESS_API_URL || 'http://127.0.0.1:8001/api/v1',
    pythonExecutable: process.env.RPA_PYTHON_PATH || 'python',
  });
  pddWorkspaceManager = new PddWorkspaceManager({
    registry: pddAccountRegistry,
    devServerUrl,
    rendererPath: path.join(currentDirectory, '..', 'dist', 'index.html'),
    preloadPath,
    pddPreloadPath,
    rpaManager: rpaProcessManager,
    diagnosticLogger: pddDiagnosticLogger,
  });
  registerIpcHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  if (shutdownStarted) return;
  shutdownStarted = true;
  const shutdownPromise = Promise.allSettled([
    pddWorkspaceManager ? pddWorkspaceManager.prepareToQuit() : Promise.resolve(),
    rpaProcessManager ? rpaProcessManager.stop() : Promise.resolve(),
  ]);
  void shutdownPromise.finally(() => {
    shutdownComplete = true;
    app.quit();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
