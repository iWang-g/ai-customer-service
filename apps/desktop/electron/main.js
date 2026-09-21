import { app, BrowserWindow, dialog, ipcMain, Menu, screen, session, shell } from 'electron';
import path from 'node:path';
import { MessageNoticeWindow } from './message-notice-window.js';
import { fileURLToPath } from 'node:url';
import { PddAccountRegistry } from './platform-workspace/account-registry.js';
import { PddWorkspaceManager } from './platform-workspace/workspace-manager.js';
import { DouyinAccountRegistry } from './platform-workspace/douyin/account-registry.js';
import { DouyinWorkspaceManager } from './platform-workspace/douyin/workspace-manager.js';
import { registerDouyinWorkspaceIpc } from './platform-workspace/douyin/ipc.js';
import { registerDouyinOrderProbeIpc } from './platform-workspace/douyin/order-probe-controller.js';
import { registerDouyinTransferIpc } from './platform-workspace/douyin/transfer-controller.js';
import { PddDiagnosticLogger } from './platform-workspace/pinduoduo/diagnostic-logger.js';
import { QianniuDiagnosticLogger } from './qianniu/diagnostic-logger.js';
import { QianniuWorkerManager } from './qianniu/worker-manager.js';
import { RpaProcessManager } from './rpa/process-manager.js';
import { DailyLogFile } from './daily-log-file.js';
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
const mainWindowLog = new DailyLogFile({ directory: diagnosticLogDirectory, baseName: 'main-window' });
let mainWindow = null;
let pddWorkspaceManager = null;
let douyinWorkspaceManager = null;
let pddAccountRegistry = null;
let rpaProcessManager = null;
let qianniuWorkerManager = null;
let wechatProcessManager = null;
let shutdownStarted = false;
let shutdownComplete = false;
let messageNoticeWindow = null;
let runtimeConfig = null;
const hasSingleInstanceLock = app.requestSingleInstanceLock();

function rendererWebPreferences() {
  return {
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    additionalArguments: runtimeConfig ? rendererRuntimeArguments(runtimeConfig) : [],
  };
}

function writeMainWindowLog(stage, details = {}, level = 'info') {
  try {
    mainWindowLog.appendSync(`${JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      stage,
      details,
    })}\n`);
  } catch {
    // Main-window diagnostics must not affect application startup or recovery.
  }
}

function installMainWindowRecovery(window) {
  const recoveryCooldownMs = 5 * 60 * 1000;
  let lastRecoveryAt = 0;
  let recoveryTimer = null;
  let unresponsiveTimer = null;

  const scheduleRecovery = (stage, details = {}, delayMs = 1000) => {
    if (shutdownStarted || shutdownComplete || window.isDestroyed()) return;
    const now = Date.now();
    if (recoveryTimer || now - lastRecoveryAt < recoveryCooldownMs) {
      writeMainWindowLog('renderer_recovery_suppressed', { stage, ...details }, 'warn');
      return;
    }
    lastRecoveryAt = now;
    writeMainWindowLog('renderer_recovery_scheduled', { stage, delay_ms: delayMs, ...details }, 'warn');
    recoveryTimer = setTimeout(() => {
      recoveryTimer = null;
      if (shutdownStarted || shutdownComplete || window.isDestroyed() || window.webContents.isDestroyed()) return;
      writeMainWindowLog('renderer_recovery_started', { stage }, 'warn');
      window.webContents.reloadIgnoringCache();
    }, delayMs);
  };

  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return;
    const details = {
      error_code: errorCode,
      error: String(errorDescription || '').slice(0, 500),
      url: String(validatedUrl || '').slice(0, 500),
    };
    writeMainWindowLog('renderer_load_failed', details, 'error');
    scheduleRecovery('did-fail-load', details);
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    const diagnostic = {
      reason: details?.reason || 'unknown',
      exit_code: details?.exitCode ?? null,
    };
    writeMainWindowLog('renderer_process_gone', diagnostic, 'error');
    scheduleRecovery('render-process-gone', diagnostic);
  });
  window.webContents.on('did-finish-load', () => {
    writeMainWindowLog('renderer_load_finished', {
      url: String(window.webContents.getURL() || '').slice(0, 500),
    });
  });
  window.webContents.on('console-message', (details) => {
    if (!details || details.level !== 'error') return;
    writeMainWindowLog('renderer_console_error', {
      message: String(details.message || '').slice(0, 1000),
      line_number: details.lineNumber || null,
      source_id: String(details.sourceId || '').slice(0, 500),
    }, 'error');
  });
  window.on('unresponsive', () => {
    writeMainWindowLog('renderer_unresponsive', {}, 'error');
    if (unresponsiveTimer) return;
    unresponsiveTimer = setTimeout(() => {
      unresponsiveTimer = null;
      scheduleRecovery('unresponsive', {}, 0);
    }, 5000);
  });
  window.on('responsive', () => {
    if (unresponsiveTimer) clearTimeout(unresponsiveTimer);
    unresponsiveTimer = null;
    writeMainWindowLog('renderer_responsive');
  });
  window.once('closed', () => {
    if (recoveryTimer) clearTimeout(recoveryTimer);
    if (unresponsiveTimer) clearTimeout(unresponsiveTimer);
  });
}

function focusMessageCenter(conversationId = null, platformCode = null) {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  const send = () => mainWindow?.webContents.send('desktop:open-notice-conversation', conversationId, platformCode);
  if (mainWindow.webContents.isLoadingMainFrame()) mainWindow.webContents.once('did-finish-load', send);
  else send();
}

if (hasSingleInstanceLock) {
  app.on('second-instance', (_event, _commandLine, _workingDirectory) => {
    focusMessageCenter();
  });
}

function syncWechatRpaAccounts(accounts = wechatProcessManager?.listAccounts?.() || []) {
  rpaProcessManager?.setPlatformAccounts('wechat', accounts.map((account) => ({
    ...account,
    id: account.localAccountId,
    alias: account.wechatName || account.alias,
    platformAccountName: account.wechatName || account.alias,
  })));
}

function syncQianniuRpaAccounts(accounts = []) {
  rpaProcessManager?.setPlatformAccounts('qianniu', accounts.map((account) => ({
    id: account.id,
    alias: account.alias || account.account_name,
    platformAccountName: account.account_name || account.alias,
    externalAccountId: account.external_account_id,
    loginStatus: account.login_status,
    metadataJson: account.metadata_json || {},
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
  registerDouyinWorkspaceIpc(ipcMain, douyinWorkspaceManager);
  registerDouyinOrderProbeIpc(ipcMain, douyinWorkspaceManager, () => mainWindow);
  registerDouyinTransferIpc(ipcMain, douyinWorkspaceManager, () => mainWindow);
  const fromMain = (event) => event.sender === mainWindow?.webContents && event.senderFrame === event.sender.mainFrame;
  const fromNotice = (event) => event.sender === messageNoticeWindow?.window?.webContents && event.senderFrame === event.sender.mainFrame;
  ipcMain.handle('message-notice:owner', (event, userId) => {
    if (!fromMain(event) || (userId !== null && !isValidUserId(userId))) throw new Error('Invalid notification owner');
    return messageNoticeWindow.setOwner(userId);
  });
  ipcMain.handle('message-notice:publish', (event, payload) => fromMain(event) && messageNoticeWindow.publish(payload));
  ipcMain.handle('message-notice:get-state', (event) => {
    if (!fromNotice(event)) throw new Error('Invalid notification window');
    return messageNoticeWindow.state;
  });
  ipcMain.handle('message-notice:collapse', (event, collapsed) => fromNotice(event) && messageNoticeWindow.setCollapsed(collapsed));
  ipcMain.handle('message-notice:open', (event, id) => fromNotice(event) && messageNoticeWindow.open(id));
  ipcMain.handle('desktop:show-platform-context-menu', (event, payload) => {
    if (!['pinduoduo', 'wechat', 'qianniu', 'douyin'].includes(payload?.platformCode) || !isValidUserId(payload?.userId)) {
      throw new Error('平台工作区参数无效');
    }
    if (payload.platformCode === 'douyin' && (event.sender !== mainWindow?.webContents
      || event.senderFrame !== event.sender.mainFrame || payload.userId !== douyinWorkspaceManager.userId)) {
      throw new Error('请先登录本系统再打开抖店工作区');
    }
    const ownerWindow = BrowserWindow.fromWebContents(event.sender) || mainWindow;
    const openPlatformItem = {
      label: payload.platformCode === 'wechat'
        ? '打开微信登录窗口'
        : payload.platformCode === 'qianniu' ? '查看千牛后台接入说明' : '打开原平台工作区',
      click: () => {
        if (payload.platformCode === 'douyin') {
          void douyinWorkspaceManager.open(payload.userId).catch((error) => {
            void dialog.showMessageBox(ownerWindow || undefined, {
              type: 'error', title: '抖店工作区', message: error.message,
            });
          });
          return;
        }
        if (payload.platformCode === 'qianniu') {
          void dialog.showMessageBox(ownerWindow || undefined, {
            type: 'info',
            title: '千牛后台接入',
            message: '千牛当前通过后台 worker 监听已登录客户端，不需要打开内置平台工作区。',
          });
          return;
        }
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
    await douyinWorkspaceManager.bindUser(payload.userId);
    await rpaProcessManager.start({ userId: payload.userId, accessToken: payload.accessToken });
    douyinWorkspaceManager.syncAccounts();
    if (runtimeConfig?.qianniu?.enabled) {
      void qianniuWorkerManager?.start().catch((error) => {
        console.error('千牛 worker 启动失败:', error);
      });
    }
    rpaProcessManager.setPlatformAccounts('pinduoduo', [
      ...pddAccountRegistry.list(payload.userId),
      ...pddAccountRegistry.list(payload.userId, { archived: true }),
    ]);
    syncWechatRpaAccounts();
    syncQianniuRpaAccounts(qianniuWorkerManager?.knownAccounts?.() || []);
    return rpaProcessManager.getState();
  });
  ipcMain.handle('desktop:close-platform-workspaces', async () => {
    await qianniuWorkerManager?.stop();
    await pddWorkspaceManager.closeForLogout();
    await douyinWorkspaceManager.closeForLogout();
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
    if (payload.localAccountId !== null && payload.localAccountId !== undefined
      && (typeof payload.localAccountId !== 'string' || payload.localAccountId.length > 128)) {
      throw new Error('本机店铺参数无效');
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
  ipcMain.handle('qianniu-workspace:refresh-customer-orders', (_event, payload) => {
    if (!qianniuWorkerManager || typeof payload?.platformAccountId !== 'string' || !payload.platformAccountId ||
        payload.platformAccountId.length > 128 || typeof payload.externalConversationId !== 'string' ||
        payload.externalConversationId.length > 256 || typeof payload.customerName !== 'string' || payload.customerName.length > 128)
      throw new Error('千牛订单请求无效');
    return qianniuWorkerManager.refreshCustomerOrders(payload);
  });
  ipcMain.handle('qianniu-workspace:sync-recent-messages', (_event, payload) => {
    if (!qianniuWorkerManager || typeof payload?.platformAccountId !== 'string' || !payload.platformAccountId ||
        payload.platformAccountId.length > 128 || typeof payload.externalConversationId !== 'string' ||
        !/^\d+\.1-\d+\.1#11001@cntaobao$/.test(payload.externalConversationId)) throw new Error('千牛会话参数无效');
    return qianniuWorkerManager.syncRecentMessages(payload);
  });
  ipcMain.handle('qianniu-workspace:refresh-store-products', (_event, payload) => {
    if (!qianniuWorkerManager || typeof payload?.platformAccountId !== 'string' || !payload.platformAccountId ||
        payload.platformAccountId.length > 128 || typeof payload.externalConversationId !== 'string' ||
        !/^\d+\.1-\d+\.1#11001@cntaobao$/.test(payload.externalConversationId)) throw new Error('千牛商品请求无效');
    return qianniuWorkerManager.refreshStoreProducts(payload);
  });
  ipcMain.handle('qianniu-workspace:product-sync-status', (_event, payload) => {
    if (typeof payload?.platformAccountId !== 'string' || !payload.platformAccountId || payload.platformAccountId.length > 128)
      throw new Error('千牛商品店铺参数无效');
    return qianniuWorkerManager?.getProductSyncStatus(payload.platformAccountId) || null;
  });
  ipcMain.handle('douyin-workspace:probe-product-detail', (event, payload) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame
      || !douyinWorkspaceManager || typeof payload?.platformAccountId !== 'string'
      || !payload.platformAccountId || payload.platformAccountId.length > 128
      || typeof payload.productId !== 'string' || !/^\d{1,40}$/.test(payload.productId)) throw new Error('抖店商品详情请求无效');
    return douyinWorkspaceManager.showProductDetailProbe({ platformAccountId: payload.platformAccountId, productId: payload.productId });
  });
  ipcMain.handle('douyin-workspace:refresh-store-products', (event, payload) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame
      || !douyinWorkspaceManager || typeof payload?.platformAccountId !== 'string'
      || !payload.platformAccountId || payload.platformAccountId.length > 128) throw new Error('抖店商品请求无效');
    return douyinWorkspaceManager.refreshStoreProducts({ platformAccountId: payload.platformAccountId });
  });
  ipcMain.handle('pdd-workspace:refresh-customer-products', (_event, payload) => {
    if (typeof payload?.platformAccountId !== 'string' || payload.platformAccountId.length > 128) {
      throw new Error('平台店铺参数无效');
    }
    if (payload.externalConversationId !== null && payload.externalConversationId !== undefined
      && (typeof payload.externalConversationId !== 'string' || payload.externalConversationId.length > 128)) {
      throw new Error('目标会话参数无效');
    }
    if (payload.localAccountId !== null && payload.localAccountId !== undefined
      && (typeof payload.localAccountId !== 'string' || payload.localAccountId.length > 128)) {
      throw new Error('本机店铺参数无效');
    }
    if (typeof payload?.customerName !== 'string' || payload.customerName.length > 128) {
      throw new Error('客户名称参数无效');
    }
    return pddWorkspaceManager.refreshCustomerProducts({
      platformAccountId: payload.platformAccountId,
      localAccountId: payload.localAccountId || null,
      externalConversationId: payload.externalConversationId || null,
      customerName: payload.customerName,
    });
  });
  ipcMain.handle('pdd-workspace:import-platform-phrases', (_event, payload) => {
    if (!isValidAccountId(payload?.accountId)) throw new Error('店铺账号参数无效');
    if (!['personal', 'team'].includes(payload?.source)) throw new Error('话术来源参数无效');
    return pddWorkspaceManager.importPlatformPhrases({
      accountId: payload.accountId,
      source: payload.source,
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
    if (payload.localAccountId !== null && payload.localAccountId !== undefined
      && (typeof payload.localAccountId !== 'string' || payload.localAccountId.length > 128)) {
      throw new Error('本机店铺参数无效');
    }
    if (typeof payload?.customerName !== 'string' || payload.customerName.length > 128) {
      throw new Error('客户名称参数无效');
    }
    if (typeof payload?.content !== 'string' || !payload.content.trim() || payload.content.length > 4000) {
      throw new Error('消息内容无效');
    }
    if (payload.quoteMessageId !== null && payload.quoteMessageId !== undefined
      && (typeof payload.quoteMessageId !== 'string' || payload.quoteMessageId.length > 128)) {
      throw new Error('quoteMessageId invalid');
    }
    return pddWorkspaceManager.sendMessage({
      platformAccountId: payload.platformAccountId,
      localAccountId: payload.localAccountId || null,
      externalConversationId: payload.externalConversationId || null,
      customerName: payload.customerName,
      content: payload.content,
      quoteMessageId: payload.quoteMessageId || null,
    });
  });
  ipcMain.handle('qianniu-workspace:send-message', (_event, payload) => {
    if (!qianniuWorkerManager) throw new Error('千牛后台 worker 未初始化');
    if (typeof payload?.platformAccountId !== 'string' || payload.platformAccountId.length > 128) {
      throw new Error('平台店铺参数无效');
    }
    if (payload.shopUid !== null && payload.shopUid !== undefined
      && (typeof payload.shopUid !== 'string' || !/^\d+$/.test(payload.shopUid) || payload.shopUid.length > 128)) {
      throw new Error('千牛店铺 UID 参数无效');
    }
    if (
      typeof payload?.externalConversationId !== 'string'
      || !payload.externalConversationId
      || payload.externalConversationId.length > 256
    ) {
      throw new Error('千牛会话 cid 参数无效');
    }
    if (typeof payload?.content !== 'string' || !payload.content.trim() || !payload.content.isWellFormed()) {
      throw new Error('消息内容无效');
    }
    const qianniuContentBytes = Buffer.byteLength(payload.content, 'utf8');
    if (/[\0\r]/.test(payload.content) || qianniuContentBytes > 4095) {
      throw new Error(`千牛消息正文不能包含回车或空字符，且不能超过 4095 个 UTF-8 字节（当前 ${qianniuContentBytes}）`);
    }
    return qianniuWorkerManager.sendMessage({
      platformAccountId: payload.platformAccountId,
      shopUid: payload.shopUid || null,
      externalConversationId: payload.externalConversationId,
      content: payload.content,
    });
  });
  const validateQianniuTransfer = (event, payload) => {
    if (!qianniuWorkerManager || event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame ||
        !rpaProcessManager?.accessToken || typeof payload?.conversationId !== 'string' || !/^[a-f0-9]{32}$/.test(payload.conversationId))
      throw new Error('千牛转接请求或登录状态无效');
  };
  ipcMain.handle('qianniu-workspace:list-transfer-targets', (event, payload) => {
    validateQianniuTransfer(event, payload);
    return qianniuWorkerManager.listTransferTargets({ conversationId: payload.conversationId });
  });
  ipcMain.handle('qianniu-workspace:transfer-conversation', (event, payload) => {
    validateQianniuTransfer(event, payload);
    if (typeof payload.targetCsid !== 'string' || payload.targetCsid.length > 64) throw new Error('千牛客服目标无效');
    return qianniuWorkerManager.transferConversation({ conversationId: payload.conversationId, targetCsid: payload.targetCsid, reason: payload.reason });
  });
  ipcMain.handle('pdd-workspace:list-transfer-cs', (_event, payload) => {
    if (typeof payload?.platformAccountId !== 'string' || payload.platformAccountId.length > 128) {
      throw new Error('平台店铺参数无效');
    }
    if (payload.localAccountId !== null && payload.localAccountId !== undefined
      && (typeof payload.localAccountId !== 'string' || payload.localAccountId.length > 128)) {
      throw new Error('本机店铺参数无效');
    }
    if (payload.externalConversationId !== null && payload.externalConversationId !== undefined
      && (typeof payload.externalConversationId !== 'string' || payload.externalConversationId.length > 128)) {
      throw new Error('目标会话参数无效');
    }
    if (payload.customerName !== null && payload.customerName !== undefined
      && (typeof payload.customerName !== 'string' || payload.customerName.length > 128)) {
      throw new Error('客户名称参数无效');
    }
    return pddWorkspaceManager.listTransferCs({
      platformAccountId: payload.platformAccountId,
      localAccountId: payload.localAccountId || null,
      externalConversationId: payload.externalConversationId || null,
      customerName: payload.customerName || '',
    });
  });
  ipcMain.handle('pdd-workspace:transfer-conversation', (_event, payload) => {
    if (typeof payload?.platformAccountId !== 'string' || payload.platformAccountId.length > 128) {
      throw new Error('平台店铺参数无效');
    }
    if (
      typeof payload?.externalConversationId !== 'string'
      || !payload.externalConversationId
      || payload.externalConversationId.length > 128
    ) throw new Error('目标会话参数无效');
    if (payload.localAccountId !== null && payload.localAccountId !== undefined
      && (typeof payload.localAccountId !== 'string' || payload.localAccountId.length > 128)) {
      throw new Error('本机店铺参数无效');
    }
    if (typeof payload?.customerName !== 'string' || payload.customerName.length > 128) {
      throw new Error('客户名称参数无效');
    }
    if (typeof payload?.targetCsid !== 'string' || !payload.targetCsid || payload.targetCsid.length > 128) {
      throw new Error('目标客服参数无效');
    }
    if (payload.transReason !== null && payload.transReason !== undefined
      && (typeof payload.transReason !== 'string' || payload.transReason.length > 128)) {
      throw new Error('转移原因参数无效');
    }
    return pddWorkspaceManager.transferConversation({
      platformAccountId: payload.platformAccountId,
      localAccountId: payload.localAccountId || null,
      externalConversationId: payload.externalConversationId,
      customerName: payload.customerName,
      targetCsid: payload.targetCsid,
      transReason: payload.transReason || '无原因直接转移',
    });
  });
  ipcMain.handle('pdd-workspace:send-product', (_event, payload) => {
    if (typeof payload?.platformAccountId !== 'string' || payload.platformAccountId.length > 128) {
      throw new Error('平台店铺参数无效');
    }
    if (payload.externalConversationId !== null && payload.externalConversationId !== undefined
      && (typeof payload.externalConversationId !== 'string' || payload.externalConversationId.length > 128)) {
      throw new Error('目标会话参数无效');
    }
    if (payload.localAccountId !== null && payload.localAccountId !== undefined
      && (typeof payload.localAccountId !== 'string' || payload.localAccountId.length > 128)) {
      throw new Error('本机店铺参数无效');
    }
    if (typeof payload?.customerName !== 'string' || payload.customerName.length > 128) {
      throw new Error('客户名称参数无效');
    }
    if (typeof payload?.productId !== 'string' || !payload.productId.trim() || payload.productId.length > 128) {
      throw new Error('商品参数无效');
    }
    return pddWorkspaceManager.sendProduct({
      platformAccountId: payload.platformAccountId,
      localAccountId: payload.localAccountId || null,
      externalConversationId: payload.externalConversationId || null,
      customerName: payload.customerName,
      productId: payload.productId,
    });
  });
  ipcMain.handle('pdd-workspace:send-image', (_event, payload) => {
    if (typeof payload?.platformAccountId !== 'string' || payload.platformAccountId.length > 128) {
      throw new Error('平台店铺参数无效');
    }
    if (payload.externalConversationId !== null && payload.externalConversationId !== undefined
      && (typeof payload.externalConversationId !== 'string' || payload.externalConversationId.length > 128)) {
      throw new Error('目标会话参数无效');
    }
    if (payload.localAccountId !== null && payload.localAccountId !== undefined
      && (typeof payload.localAccountId !== 'string' || payload.localAccountId.length > 128)) {
      throw new Error('本机店铺参数无效');
    }
    if (typeof payload?.imageUrl !== 'string' || !/^https?:\/\//i.test(payload.imageUrl)) {
      throw new Error('图片地址参数无效');
    }
    if (typeof payload?.customerName !== 'string' || payload.customerName.length > 128) {
      throw new Error('客户名称参数无效');
    }
    if (payload.quoteMessageId !== null && payload.quoteMessageId !== undefined
      && (typeof payload.quoteMessageId !== 'string' || payload.quoteMessageId.length > 128)) {
      throw new Error('quoteMessageId invalid');
    }
    return pddWorkspaceManager.sendImage({
      platformAccountId: payload.platformAccountId,
      localAccountId: payload.localAccountId || null,
      externalConversationId: payload.externalConversationId || null,
      customerName: payload.customerName,
      imageUrl: payload.imageUrl,
      quoteMessageId: payload.quoteMessageId || null,
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
    if (payload.localAccountId !== null && payload.localAccountId !== undefined
      && (typeof payload.localAccountId !== 'string' || payload.localAccountId.length > 128)) {
      throw new Error('本机店铺参数无效');
    }
    if (typeof payload?.customerName !== 'string' || payload.customerName.length > 128) {
      throw new Error('客户名称参数无效');
    }
    if (typeof payload?.imageDataUrl !== 'string' || payload.imageDataUrl.length > 14 * 1024 * 1024) {
      throw new Error('图片内容无效或超过 10 MB');
    }
    if (payload.quoteMessageId !== null && payload.quoteMessageId !== undefined
      && (typeof payload.quoteMessageId !== 'string' || payload.quoteMessageId.length > 128)) {
      throw new Error('quoteMessageId invalid');
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
  installMainWindowRecovery(window);

  if (devServerUrl) {
    void window.loadURL(devServerUrl);
  } else {
    void window.loadFile(path.join(currentDirectory, '..', 'dist', 'index.html'));
  }
  mainWindow = window;
  window.on('close', (event) => {
    if (shutdownStarted || shutdownComplete || !app.isPackaged) return;
    event.preventDefault();
    window.hide();
  });
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
    if (!app.isPackaged && !shutdownStarted) app.quit();
  });
}

if (hasSingleInstanceLock) app.whenReady().then(async () => {
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
  const qianniuDiagnosticLogger = new QianniuDiagnosticLogger(diagnosticLogDirectory);
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
    logPath: path.join(diagnosticLogDirectory, 'rpa-agent.log'),
  });
  rpaProcessManager.on('bindings', (bindings) => {
    qianniuWorkerManager?.applyBindings(bindings);
    for (const binding of bindings) {
      if (binding.platform_code !== 'wechat') continue;
      wechatProcessManager.registry?.bindPlatformAccount(
        binding.local_account_id,
        binding.platform_account_id,
        binding.login_status,
      );
    }
  });
  qianniuWorkerManager = new QianniuWorkerManager({
    businessApi: async (route, body) => {
      const token = rpaProcessManager?.accessToken;
      if (!token) throw new Error('请先登录项目');
      const response = await fetch(runtimeConfig.businessApiUrl.replace(/\/$/, '') + route, {
        method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(typeof value.detail === 'string' ? value.detail : '千牛转接业务服务请求失败');
      return value;
    },
    orderDataPath: path.join(app.getPath('userData'), 'qianniu-orders'),
    enabled: runtimeConfig.qianniu.enabled,
    appLogPath: runtimeConfig.qianniu.appLogPath,
    bridgeBase: runtimeConfig.qianniu.bridgeBase,
    diagnosticLogger: qianniuDiagnosticLogger,
    sendGuard: ({ taskId, platformAccountId, cid }) => rpaProcessManager.checkQianniuSendGuard({
      taskId, platformAccountId, cid,
    }),
  });
  qianniuWorkerManager.on('accounts', (accounts) => syncQianniuRpaAccounts(accounts));
  qianniuWorkerManager.on('event', (event) => rpaProcessManager?.enqueueEvent(event));
  qianniuWorkerManager.on('task-complete', (taskId, status, resultJson, errorMessage) => {
    rpaProcessManager?.completeTask(taskId, status, resultJson, errorMessage);
  });
  rpaProcessManager.on('task', (task) => {
    void qianniuWorkerManager?.handleTask(task);
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
  douyinWorkspaceManager = new DouyinWorkspaceManager({
    registry: new DouyinAccountRegistry(app.getPath('userData')),
    devServerUrl,
    rendererPath: path.join(currentDirectory, '..', 'dist', 'index.html'),
    preloadPath,
    rendererAdditionalArguments: rendererRuntimeArguments(runtimeConfig),
    rpaManager: rpaProcessManager,
  });
  messageNoticeWindow = new MessageNoticeWindow({
    BrowserWindow, screen, preload: path.join(currentDirectory, 'message-notice-preload.cjs'),
    devServerUrl, rendererPath: path.join(currentDirectory, '..', 'dist', 'index.html'),
    onOpen: focusMessageCenter,
  });
  registerIpcHandlers();
  createWindow();
  messageNoticeWindow.create();
  void wechatProcessManager.startMonitoring().catch((error) => {
    console.error('微信账号恢复失败:', error);
  });

  app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  });
});

app.on('before-quit', (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  if (shutdownStarted) return;
  shutdownStarted = true;
  messageNoticeWindow?.dispose();
  const shutdownPromise = Promise.allSettled([
    qianniuWorkerManager ? qianniuWorkerManager.stop() : Promise.resolve(),
    pddWorkspaceManager ? pddWorkspaceManager.prepareToQuit() : Promise.resolve(),
    douyinWorkspaceManager ? douyinWorkspaceManager.prepareToQuit() : Promise.resolve(),
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
