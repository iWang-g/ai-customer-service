import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, session, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PddAccountRegistry } from './platform-workspace/account-registry.js';
import { PddWorkspaceManager } from './platform-workspace/workspace-manager.js';
import { PddDiagnosticLogger } from './platform-workspace/pinduoduo/diagnostic-logger.js';
import { RpaProcessManager } from './rpa/process-manager.js';
import { loadRuntimeConfig, rendererRuntimeArguments, serviceProxyBypassRules } from './runtime-config.js';
import { WechatAccountRegistry } from './wechat/account-registry.js';
import { WechatProcessManager } from './wechat/process-manager.js';

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
let wechatProcessManager = null;
let shutdownStarted = false;
let shutdownComplete = false;
const pendingHumanRequiredNotifications = new Map();
const shownHumanRequiredNotificationKeys = new Set();
const activeHumanRequiredNotifications = new Set();
let humanRequiredNotificationTimer = null;
let runtimeConfig = null;

function rendererWebPreferences() {
  return {
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    additionalArguments: runtimeConfig ? rendererRuntimeArguments(runtimeConfig) : [],
  };
}

function focusMessageCenter(conversationId = null) {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send('desktop:open-human-required-conversation', conversationId);
}

function flushHumanRequiredNotifications() {
  humanRequiredNotificationTimer = null;
  const items = [...pendingHumanRequiredNotifications.values()];
  pendingHumanRequiredNotifications.clear();
  if (items.length === 0 || !Notification.isSupported()) return;

  const singleItem = items.length === 1 ? items[0] : null;
  const notification = new Notification({
    title: singleItem ? '有新的会话待人工处理' : `${items.length} 个会话待人工处理`,
    body: singleItem
      ? [singleItem.platformName, singleItem.shopName, singleItem.customerName].filter(Boolean).join(' · ')
      : '请打开消息中心查看并及时处理。',
  });
  activeHumanRequiredNotifications.add(notification);
  notification.on('click', () => focusMessageCenter(singleItem?.conversationId || null));
  notification.on('close', () => activeHumanRequiredNotifications.delete(notification));
  notification.show();
}

function queueHumanRequiredNotifications(payload) {
  if (!Array.isArray(payload?.items)) return false;
  const suppressConversationId = (
    mainWindow?.isFocused()
    && payload.messageCenterVisible === true
    && typeof payload.viewingConversationId === 'string'
  ) ? payload.viewingConversationId : null;

  for (const item of payload.items) {
    if (
      typeof item?.conversationId !== 'string'
      || !item.conversationId
      || typeof item.notificationKey !== 'string'
      || !item.notificationKey
      || item.conversationId === suppressConversationId
      || shownHumanRequiredNotificationKeys.has(item.notificationKey)
    ) continue;
    shownHumanRequiredNotificationKeys.add(item.notificationKey);
    pendingHumanRequiredNotifications.set(item.notificationKey, {
      conversationId: item.conversationId,
      platformName: typeof item.platformName === 'string' ? item.platformName.slice(0, 64) : '',
      shopName: typeof item.shopName === 'string' ? item.shopName.slice(0, 64) : '',
      customerName: typeof item.customerName === 'string' ? item.customerName.slice(0, 64) : '',
    });
  }
  if (pendingHumanRequiredNotifications.size === 0) return true;
  if (humanRequiredNotificationTimer) clearTimeout(humanRequiredNotificationTimer);
  humanRequiredNotificationTimer = setTimeout(flushHumanRequiredNotifications, 2500);
  return true;
}

function clearHumanRequiredNotifications() {
  if (humanRequiredNotificationTimer) clearTimeout(humanRequiredNotificationTimer);
  humanRequiredNotificationTimer = null;
  pendingHumanRequiredNotifications.clear();
  shownHumanRequiredNotificationKeys.clear();
  for (const notification of activeHumanRequiredNotifications) notification.close();
  activeHumanRequiredNotifications.clear();
}

function syncWechatRpaAccounts(accounts = wechatProcessManager?.listAccounts?.() || []) {
  rpaProcessManager?.setPlatformAccounts('wechat', accounts.map((account) => ({
    ...account,
    id: account.localAccountId,
    alias: account.wechatName || account.alias,
    platformAccountName: account.wechatName || account.alias,
  })));
}

function isValidUserId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

function isValidAccountId(value) {
  return typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value);
}

function isValidWechatLocalAccountId(value) {
  return typeof value === 'string' && /^wechat-[0-9a-f-]{36}$/i.test(value);
}

function isValidAccessToken(value) {
  return typeof value === 'string' && value.length >= 32 && value.length <= 8192;
}

function registerIpcHandlers() {
  ipcMain.handle('desktop:notify-human-required', (_event, payload) => (
    queueHumanRequiredNotifications(payload)
  ));
  ipcMain.handle('desktop:clear-human-required-notifications', () => {
    clearHumanRequiredNotifications();
    return true;
  });
  ipcMain.handle('desktop:show-platform-context-menu', (event, payload) => {
    if (!['pinduoduo', 'wechat'].includes(payload?.platformCode) || !isValidUserId(payload?.userId)) {
      throw new Error('平台工作区参数无效');
    }
    const ownerWindow = BrowserWindow.fromWebContents(event.sender) || mainWindow;
    const openPlatformItem = {
      label: payload.platformCode === 'wechat' ? '打开微信登录窗口' : '打开原平台工作区',
      click: () => {
        if (payload.platformCode === 'wechat') {
          void (async () => {
            try {
              const result = await wechatProcessManager.openLogin();
              if (result.status === 'no_new_instance') {
                await dialog.showMessageBox(ownerWindow || undefined, {
                  type: 'warning',
                  title: '未检测到新的微信窗口',
                  message: '微信已启动，但未产生新的登录窗口。请稍后重试或检查当前微信版本的多开行为。',
                });
              }
            } catch (error) {
              if (error?.code !== 'WECHAT_EXECUTABLE_NOT_FOUND') {
                await dialog.showMessageBox(ownerWindow || undefined, {
                  type: 'error',
                  title: '微信启动失败',
                  message: error instanceof Error ? error.message : String(error),
                });
                return;
              }
              const selection = await dialog.showOpenDialog(ownerWindow || undefined, {
                title: '选择微信程序',
                properties: ['openFile'],
                filters: [{ name: '微信程序', extensions: ['exe'] }],
              });
              if (selection.canceled || !selection.filePaths[0]) return;
              wechatProcessManager.setExecutablePath(selection.filePaths[0]);
              try {
                const result = await wechatProcessManager.openLogin();
                if (result.status === 'no_new_instance') {
                  await dialog.showMessageBox(ownerWindow || undefined, {
                    type: 'warning',
                    title: '未检测到新的微信窗口',
                    message: '微信已启动，但未产生新的登录窗口。请稍后重试或检查当前微信版本的多开行为。',
                  });
                }
              } catch (retryError) {
                await dialog.showMessageBox(ownerWindow || undefined, {
                  type: 'error',
                  title: '微信启动失败',
                  message: retryError instanceof Error ? retryError.message : String(retryError),
                });
              }
            }
          })();
          return;
        }
        void pddWorkspaceManager.open(payload.userId);
      },
    };
    const menu = Menu.buildFromTemplate(payload.platformCode === 'wechat'
      ? [
          openPlatformItem,
          { type: 'separator' },
          {
            label: '查看已登录账号',
            click: () => ownerWindow?.webContents.send('wechat:show-accounts'),
          },
        ]
      : [openPlatformItem]);
    menu.popup({ window: ownerWindow || undefined });
    return true;
  });

  ipcMain.handle('desktop:start-rpa', async (_event, payload) => {
    if (!isValidUserId(payload?.userId) || !isValidAccessToken(payload?.accessToken)) {
      throw new Error('RPA 启动参数无效');
    }
    await pddWorkspaceManager.bindUser(payload.userId, payload.accessToken);
    await rpaProcessManager.start({ userId: payload.userId, accessToken: payload.accessToken });
    rpaProcessManager.setPlatformAccounts('pinduoduo', [
      ...pddAccountRegistry.list(payload.userId),
      ...pddAccountRegistry.list(payload.userId, { archived: true }),
    ]);
    syncWechatRpaAccounts();
    return rpaProcessManager.getState();
  });
  ipcMain.handle('desktop:close-platform-workspaces', async () => {
    await pddWorkspaceManager.closeForLogout();
    await rpaProcessManager.stop();
  });
  ipcMain.handle('wechat:get-accounts', () => wechatProcessManager.refreshAccounts());
  ipcMain.handle('wechat:identify-accounts', (_event, payload) => {
    const localAccountId = payload?.localAccountId || null;
    if (localAccountId && !isValidWechatLocalAccountId(localAccountId)) {
      throw new Error('微信账号参数无效');
    }
    return wechatProcessManager.identifyAccounts({
      localAccountId,
      force: Boolean(payload?.force),
    });
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
  ipcMain.handle('pdd-workspace:prepare-conversation-test-reset', (_event, payload) => {
    if (typeof payload?.platformAccountId !== 'string' || payload.platformAccountId.length > 128) {
      throw new Error('平台店铺参数无效');
    }
    if (
      typeof payload?.externalConversationId !== 'string'
      || !payload.externalConversationId
      || payload.externalConversationId.length > 128
    ) throw new Error('目标会话参数无效');
    return pddWorkspaceManager.prepareConversationTestReset(payload);
  });
  ipcMain.handle('pdd-workspace:resume-conversation-after-test-reset', (_event, payload) => {
    if (typeof payload?.platformAccountId !== 'string' || payload.platformAccountId.length > 128) {
      throw new Error('平台店铺参数无效');
    }
    if (
      typeof payload?.externalConversationId !== 'string'
      || !payload.externalConversationId
      || payload.externalConversationId.length > 128
    ) throw new Error('目标会话参数无效');
    return pddWorkspaceManager.resumeConversationAfterTestReset(payload);
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
  ipcMain.handle('pdd-workspace:send-image-data', (_event, payload) => {
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
    if (typeof payload?.imageDataUrl !== 'string' || payload.imageDataUrl.length > 14 * 1024 * 1024) {
      throw new Error('图片内容无效或超过 10 MB');
    }
    return pddWorkspaceManager.sendImageData(payload);
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
    webPreferences: rendererWebPreferences(),
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

app.whenReady().then(async () => {
  if (process.platform === 'win32') app.setAppUserModelId('com.omniai.customer-service');
  try {
    runtimeConfig = loadRuntimeConfig({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
    });
  } catch (error) {
    dialog.showErrorBox(
      '客户端配置错误',
      error instanceof Error ? error.message : String(error),
    );
    app.quit();
    return;
  }
  await session.defaultSession.setProxy({
    mode: 'system',
    proxyBypassRules: serviceProxyBypassRules(runtimeConfig),
  });
  pddAccountRegistry = new PddAccountRegistry(app.getPath('userData'));
  wechatProcessManager = new WechatProcessManager({
    registry: new WechatAccountRegistry(app.getPath('userData')),
    onAccountsChanged: (accounts) => syncWechatRpaAccounts(accounts),
  });
  const pddDiagnosticLogger = new PddDiagnosticLogger(diagnosticLogDirectory);
  pddDiagnosticLogger.write('system', {
    type: 'diagnostic',
    level: 'info',
    stage: 'logger_initialized',
    details: { packaged: app.isPackaged },
    observed_at: new Date().toISOString(),
  });
  const rpaExecutablePath = app.isPackaged
    ? path.join(process.resourcesPath, 'rpa', 'rpa-agent.exe')
    : process.env.RPA_PYTHON_PATH || 'python';
  const rpaAgentPath = app.isPackaged
    ? rpaExecutablePath
    : path.join(currentDirectory, '..', '..', '..', 'agents', 'rpa', 'agent.py');
  const rpaExecutableArgs = app.isPackaged
    ? []
    : ['-u', rpaAgentPath];
  rpaProcessManager = new RpaProcessManager({
    userDataPath: app.getPath('userData'),
    executablePath: rpaExecutablePath,
    executableArgs: rpaExecutableArgs,
    requiredFilePath: rpaAgentPath,
    apiBaseUrl: runtimeConfig.businessApiUrl,
    appVersion: app.getVersion(),
  });
  rpaProcessManager.on('bindings', (bindings) => {
    for (const binding of bindings) {
      if (binding.platform_code !== 'wechat') continue;
      wechatProcessManager.registry?.bindPlatformAccount(
        binding.local_account_id,
        binding.platform_account_id,
        binding.login_status,
      );
    }
  });
  pddWorkspaceManager = new PddWorkspaceManager({
    registry: pddAccountRegistry,
    devServerUrl,
    rendererPath: path.join(currentDirectory, '..', 'dist', 'index.html'),
    preloadPath,
    pddPreloadPath,
    rpaManager: rpaProcessManager,
    diagnosticLogger: pddDiagnosticLogger,
    knowledgeBaseUrl: runtimeConfig.knowledgeBaseUrl,
    businessApiUrl: runtimeConfig.businessApiUrl,
    collectorRulesCachePath: path.join(app.getPath('userData'), 'collector-rules', 'pinduoduo.json'),
    rendererAdditionalArguments: rendererRuntimeArguments(runtimeConfig),
  });
  registerIpcHandlers();
  createWindow();
  void wechatProcessManager.startMonitoring().catch((error) => {
    console.error('微信账号恢复失败:', error);
  });

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
  wechatProcessManager?.stopMonitoring();
  void shutdownPromise.finally(() => {
    shutdownComplete = true;
    app.quit();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
