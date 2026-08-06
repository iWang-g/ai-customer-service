import { BrowserWindow, WebContentsView, session, shell, clipboard, nativeImage } from 'electron';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { classifyPddPage } from './pinduoduo/detector.js';
import { PddCollectionRuntime } from './pinduoduo/runtime.js';
import { serializedSelectorArgument } from './pinduoduo/selectors.js';
import { StoreActor } from './store-actor.js';
import { SerialTaskQueue } from './serial-task-queue.js';

const PDD_HOME_URL = 'https://mms.pinduoduo.com/chat-windows/index.html';
const WORKSPACE_TOOLBAR_HEIGHT = 72;
const ACCOUNT_NAME_DETECTION_TIMEOUT_MS = 5000;
const ACCOUNT_NAME_PAGE_LOAD_TIMEOUT_MS = 15000;
const CONVERSATION_LIST_TIMEOUT_MS = 8000;
const CONVERSATION_COLLECTION_TIMEOUT_MS = 15000;
const MESSAGE_PREPARATION_TIMEOUT_MS = 15000;
const IMAGE_PREPARATION_TIMEOUT_MS = 15000;
const STORE_SCAN_TIMEOUT_MS = 10000;
const UNREAD_COLLECTION_TIMEOUT_MS = 15000;
const BACKGROUND_ACCOUNT_LOAD_TIMEOUT_MS = 30000;
const UNAVAILABLE_LOGIN_STATUSES = new Set(['login_required', 'risk_control', 'account_mismatch']);
export const PDD_PENDING_ACCOUNT_ALIAS = '待识别店铺名称';
const GENERIC_ACCOUNT_ALIAS = /^(拼多多|拼多多商家后台|拼多多商家管理后台|拼多多客服平台|商家后台|客服平台)$/;
const NUMBERED_PDD_ACCOUNT_ALIAS = /^拼多多店铺\s*\d+$/;

function detectedAlias(value) {
  const alias = String(value || '').replace(/\s+/g, ' ').trim();
  return alias && !isAutoReplaceableAlias(alias) ? alias.slice(0, 64) : null;
}

function isAutoReplaceableAlias(value) {
  const normalized = String(value || '').trim();
  return value === PDD_PENDING_ACCOUNT_ALIAS
    || GENERIC_ACCOUNT_ALIAS.test(normalized)
    || NUMBERED_PDD_ACCOUNT_ALIAS.test(normalized);
}

function isAllowedPddUrl(value) {
  if (value === 'about:blank') return true;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      (url.hostname === 'pinduoduo.com' || url.hostname.endsWith('.pinduoduo.com'))
    );
  } catch {
    return false;
  }
}

function isSafeExternalUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function diagnosticPagePath(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`.slice(0, 512);
  } catch {
    return String(value || '').slice(0, 512);
  }
}

function publicAccount(account, runtime, collector) {
  return {
    id: account.id,
    alias: account.alias,
    paused: account.paused,
    createdAt: account.createdAt,
    lastOpenedAt: account.lastOpenedAt,
    platformAccountId: account.platformAccountId || null,
    externalAccountId: account.externalAccountId || null,
    platformAccountName: account.platformAccountName || null,
    loginStatus: account.paused ? 'paused' : account.loginStatus || 'unknown',
    runtimeStatus: account.paused ? 'paused' : runtime?.status || 'idle',
    collectionStatus: account.paused ? 'paused' : collector?.status || 'idle',
    lastCollectedAt: collector?.lastCollectedAt || null,
  };
}

export class PddWorkspaceManager {
  constructor({
    registry,
    devServerUrl,
    rendererPath,
    preloadPath,
    pddPreloadPath = null,
    rpaManager = null,
    diagnosticLogger = null,
    homeUrl = PDD_HOME_URL,
    workspaceShellUrl = null,
    loadWorkspaceShell = true,
  }) {
    this.registry = registry;
    this.devServerUrl = devServerUrl;
    this.rendererPath = rendererPath;
    this.preloadPath = preloadPath;
    this.pddPreloadPath = pddPreloadPath;
    this.rpaManager = rpaManager;
    this.diagnosticLogger = diagnosticLogger;
    this.homeUrl = homeUrl;
    this.workspaceShellUrl = workspaceShellUrl;
    this.loadWorkspaceShell = loadWorkspaceShell;
    this.window = null;
    this.userId = null;
    this.activeAccountId = null;
    this.views = new Map();
    this.runtime = new Map();
    this.collectors = new Map();
    this.pendingNameDetections = new Map();
    this.pendingConversationLists = new Map();
    this.pendingConversationCollections = new Map();
    this.pendingMessagePreparations = new Map();
    this.pendingImagePreparations = new Map();
    this.pendingStoreScans = new Map();
    this.pendingUnreadCollections = new Map();
    this.storeActors = new Map();
    this.clipboardQueue = new SerialTaskQueue();
    this.configuredPartitions = new Set();
    this.initialViewLoads = new Map();
    this.backgroundLoadQueue = [];
    this.queuedBackgroundAccounts = new Set();
    this.backgroundLoadRunning = false;
    this.backgroundLoadGeneration = 0;
    this.verifiedAccountIdentities = new Set();
    this.overlayOpen = false;
    this.isQuitting = false;
    this.rpaManager?.on('state-changed', () => this.#publishState());
    this.rpaManager?.on('bindings', (bindings) => {
      if (!this.userId) return;
      for (const binding of bindings) {
        if (this.registry.get(this.userId, binding.local_account_id)) {
          this.registry.bindPlatformAccount(
            this.userId,
            binding.local_account_id,
            binding.platform_account_id,
            binding.login_status,
          );
          this.collectors.get(binding.local_account_id)?.runtime.accountBindingChanged();
          const view = this.views.get(binding.local_account_id);
          if (view && !view.webContents.isDestroyed()) {
            view.webContents.send('pdd-adapter:command', { type: 'scan' });
          }
        }
      }
      this.#publishState();
    });
    this.rpaManager?.on('task', (task) => {
      this.#enqueueRpaTask(task);
    });
  }

  async open(userId) {
    if (!userId) throw new Error('缺少当前用户信息');
    if (this.window && !this.window.isDestroyed() && this.userId !== userId) {
      await this.closeForLogout();
    }

    this.userId = userId;
    if (!this.window || this.window.isDestroyed()) {
      await this.#createWindow();
    }

    this.window.show();
    this.window.focus();
    this.#syncRpaAccounts();
    await this.#ensureInitialAccount();
    this.#scheduleBackgroundAccountLoads();
    this.#publishState();
  }

  async bindUser(userId) {
    if (!userId) throw new Error('缺少当前用户信息');
    if (this.userId && this.userId !== userId) await this.closeForLogout();
    this.userId = userId;
    this.#syncRpaAccounts();
    this.#publishState();
  }

  async #createWindow() {
    this.window = new BrowserWindow({
      width: 1320,
      height: 860,
      minWidth: 960,
      minHeight: 640,
      title: '拼多多原平台工作区 - AI智能客服',
      backgroundColor: '#f8fafc',
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    this.window.on('resize', () => this.#layoutViews());
    this.window.on('close', (event) => {
      if (!this.isQuitting) {
        event.preventDefault();
        this.window?.hide();
      }
    });
    this.window.on('closed', () => {
      this.window = null;
    });

    if (!this.loadWorkspaceShell) {
      return;
    } else if (this.workspaceShellUrl) {
      await this.window.loadURL(this.workspaceShellUrl);
    } else if (this.devServerUrl) {
      const workspaceUrl = new URL(this.devServerUrl);
      workspaceUrl.searchParams.set('view', 'pinduoduo-workspace');
      await this.window.loadURL(workspaceUrl.toString());
    } else {
      await this.window.loadFile(this.rendererPath, { query: { view: 'pinduoduo-workspace' } });
    }
  }

  async #ensureInitialAccount() {
    if (!this.userId || this.activeAccountId) return;
    const account = this.registry
      .list(this.userId)
      .filter((item) => !item.paused)
      .sort((left, right) => {
        if (left.lastOpenedAt && right.lastOpenedAt) {
          return right.lastOpenedAt.localeCompare(left.lastOpenedAt);
        }
        if (left.lastOpenedAt) return -1;
        if (right.lastOpenedAt) return 1;
        return left.createdAt.localeCompare(right.createdAt);
      })[0];
    if (account) await this.selectAccount(account.id);
  }

  getState() {
    if (!this.userId) {
      return {
        accounts: [], archivedAccounts: [], activeAccountId: null, navigation: {},
        rpa: this.rpaManager?.getState() || { status: 'stopped' },
      };
    }
    const accounts = this.registry
      .list(this.userId)
      .map((account) => publicAccount(
        account,
        this.runtime.get(account.id),
        this.collectors.get(account.id),
      ));
    const archivedAccounts = this.registry
      .list(this.userId, { archived: true })
      .map((account) => publicAccount(
        account,
        this.runtime.get(account.id),
        this.collectors.get(account.id),
      ));
    const activeView = this.views.get(this.activeAccountId);
    const contents = activeView?.webContents;
    return {
      accounts,
      archivedAccounts,
      activeAccountId: this.activeAccountId,
      navigation: {
        canGoBack: Boolean(contents && !contents.isDestroyed() && contents.navigationHistory.canGoBack()),
        canGoForward: Boolean(contents && !contents.isDestroyed() && contents.navigationHistory.canGoForward()),
        isLoading: Boolean(contents && !contents.isDestroyed() && contents.isLoading()),
      },
      rpa: this.rpaManager?.getState() || { status: 'stopped' },
    };
  }

  addAccount() {
    this.#requireUser();
    const account = this.registry.create(this.userId, PDD_PENDING_ACCOUNT_ALIAS);
    this.#syncRpaAccounts();
    return this.selectAccount(account.id);
  }

  async selectAccount(accountId) {
    this.#requireUser();
    const account = this.registry.get(this.userId, accountId);
    if (!account || account.archivedAt) throw new Error('店铺账号不存在');
    if (account.paused) throw new Error('请先恢复已暂停的店铺');

    this.#dequeueBackgroundAccount(accountId);
    const view = this.#ensureView(account);
    this.activeAccountId = accountId;
    this.registry.update(this.userId, accountId, { lastOpenedAt: new Date().toISOString() });
    for (const [id, candidate] of this.views) {
      candidate.setVisible(id === accountId && !this.overlayOpen);
    }
    view.webContents.focus();
    this.#layoutViews();
    this.#publishState();
    return this.getState();
  }

  renameAccount(accountId, alias) {
    this.#requireUser();
    this.registry.update(this.userId, accountId, { alias });
    this.#syncRpaAccounts();
    this.#publishState();
    return this.getState();
  }

  async detectAccountName(accountId) {
    this.#requireUser();
    const account = this.registry.get(this.userId, accountId);
    if (!account || account.archivedAt) throw new Error('店铺账号不存在');
    if (account.paused) throw new Error('请先恢复已暂停的店铺');
    const view = this.#ensureView(account);
    const contents = view.webContents;
    await this.#waitForViewReady(contents);

    const requestId = randomUUID();
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingNameDetections.delete(requestId);
        reject(new Error('店铺名称识别超时，请确认客服接待页面已加载完成后重试'));
      }, ACCOUNT_NAME_DETECTION_TIMEOUT_MS);
      this.pendingNameDetections.set(requestId, { accountId, resolve, reject, timer });
      contents.send('pdd-adapter:command', {
        type: 'detect-account-name',
        requestId,
      });
      this.#writeDiagnostic(accountId, 'account_name_detection_requested');
    });
    if (!result) throw new Error('当前页面未识别到有效店铺名称，请确认客服接待页面已加载完成后重试');
    return result;
  }

  async listImportCandidates() {
    this.#requireUser();
    if (!this.window || this.window.isDestroyed()) await this.#createWindow();
    const accounts = this.registry.list(this.userId).filter((account) => !account.paused);
    const results = await Promise.all(accounts.map(async (account) => {
      const view = this.#ensureView(account);
      try {
        await this.#waitForViewReady(view.webContents);
        if (!this.#isAccountIdentityVerified(account)) return [];
        const requestId = randomUUID();
        const candidates = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            this.pendingConversationLists.delete(requestId);
            reject(new Error('拼多多会话列表扫描超时'));
          }, CONVERSATION_LIST_TIMEOUT_MS);
          this.pendingConversationLists.set(requestId, { accountId: account.id, resolve, reject, timer });
          view.webContents.send('pdd-adapter:command', { type: 'list-conversations', requestId });
        });
        const shopName = detectedAlias(account.alias)
          || detectedAlias(account.platformAccountName)
          || account.alias;
        return candidates.map((candidate) => {
          const conversationKey = typeof candidate?.conversation_key === 'string'
            ? candidate.conversation_key.trim().slice(0, 128)
            : '';
          if (!conversationKey) return null;
          return {
            id: `${account.id}:${conversationKey}`,
            accountId: account.id,
            platformAccountId: account.platformAccountId || null,
            platformCode: 'pinduoduo',
            platformName: '拼多多',
            shopName,
            conversationKey,
            externalConversationId: typeof candidate.external_conversation_id === 'string'
              ? candidate.external_conversation_id.slice(0, 128)
              : null,
            customerName: typeof candidate.customer_name === 'string' && candidate.customer_name.trim()
              ? candidate.customer_name.trim().slice(0, 128)
              : '未知客户',
            previewText: typeof candidate.preview_text === 'string'
              ? candidate.preview_text.trim().slice(0, 4000) || null
              : null,
            unreadCount: Math.max(0, Math.min(Number(candidate.unread_count) || 0, 9999)),
            active: Boolean(candidate.active),
          };
        }).filter(Boolean);
      } catch (error) {
        this.#writeDiagnostic(account.id, 'conversation_candidates_failed', {
          error: error?.message || String(error),
        }, 'warn');
        return [];
      }
    }));
    return results.flat();
  }

  async importConversation(accountId, conversationKey) {
    this.#requireUser();
    if (typeof conversationKey !== 'string' || !conversationKey.trim() || conversationKey.length > 128) {
      throw new Error('会话参数无效');
    }
    const account = this.registry.get(this.userId, accountId);
    if (!account || account.archivedAt || account.paused) throw new Error('店铺账号不可用');
    if (!this.#isAccountIdentityVerified(account)) throw new Error('店铺身份尚未确认，请等待页面识别完成');
    return this.#getStoreActor(account).enqueue('collect_unread', () => (
      this.#importConversationNow(account, conversationKey.trim().slice(0, 128))
    ));
  }

  async #importConversationNow(account, conversationKey) {
    if (!this.window || this.window.isDestroyed()) await this.#createWindow();
    const view = this.#ensureView(account);
    await this.#waitForViewReady(view.webContents);
    const requestId = randomUUID();
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingConversationCollections.delete(requestId);
        reject(new Error('读取拼多多历史会话超时，请确认客服接待页面已加载完成'));
      }, CONVERSATION_COLLECTION_TIMEOUT_MS);
      this.pendingConversationCollections.set(requestId, { accountId: account.id, resolve, reject, timer });
      view.webContents.send('pdd-adapter:command', {
        type: 'collect-conversation',
        requestId,
        conversationKey,
      });
    });
    if (result?.status === 'not_found') throw new Error('未找到目标会话，可能已不在当前会话列表中');
    if (result?.status !== 'collected') throw new Error('拼多多会话切换或消息读取失败，请稍后重试');
    return result;
  }

  async sendMessage({ platformAccountId, externalConversationId, customerName, content }) {
    this.#requireUser();
    const account = this.registry.list(this.userId).find(
      (candidate) => candidate.platformAccountId === platformAccountId
        && !candidate.paused
        && !UNAVAILABLE_LOGIN_STATUSES.has(candidate.loginStatus)
        && this.#isAccountIdentityVerified(candidate),
    );
    if (!account) throw new Error('未找到消息对应的拼多多店铺，请确认店铺已登录');
    return this.#getStoreActor(account).enqueue('send_message', ({ setState }) => (
      this.#sendMessageNow(account, externalConversationId, customerName, content, setState)
    ));
  }

  async #sendMessageNow(account, externalConversationId, customerName, content, setState = () => {}) {
    if (!this.window || this.window.isDestroyed()) await this.#createWindow();
    const view = this.#ensureView(account);
    await this.#waitForViewReady(view.webContents);
    setState('switching_conversation');
    const requestId = randomUUID();
    const conversationKey = externalConversationId || `name:${customerName}`;
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingMessagePreparations.delete(requestId);
        reject(new Error('切换拼多多会话并发送消息超时'));
      }, MESSAGE_PREPARATION_TIMEOUT_MS);
      this.pendingMessagePreparations.set(requestId, { accountId: account.id, resolve, reject, timer });
      view.webContents.send('pdd-adapter:command', {
        type: 'send-message',
        requestId,
        conversationKey: conversationKey.slice(0, 128),
        customerName: customerName.slice(0, 128),
        content: content.slice(0, 4000),
      });
    });
    if (result?.status === 'not_found') throw new Error('未找到目标拼多多会话，可能已不在当前会话列表中');
    if (result?.status !== 'sent') throw new Error('拼多多会话切换或消息发送失败');
    setState('waiting_text_confirmation');
    return result;
  }

  async sendImage({ platformAccountId, externalConversationId, customerName, imageUrl }) {
    this.#requireUser();
    if (!/^https?:\/\//i.test(String(imageUrl || ''))) throw new Error('图片地址无效');
    const account = this.registry.list(this.userId).find(
      (candidate) => candidate.platformAccountId === platformAccountId
        && !candidate.paused
        && !UNAVAILABLE_LOGIN_STATUSES.has(candidate.loginStatus)
        && this.#isAccountIdentityVerified(candidate),
    );
    if (!account) throw new Error('未找到消息对应的拼多多店铺，请确认店铺已登录');
    return this.#getStoreActor(account).enqueue('send_image', async ({ setState, signal }) => {
      const image = await this.#downloadImage(imageUrl, signal);
      return this.#sendImageNow(account, externalConversationId, customerName, image, setState);
    });
  }

  async #sendImageNow(account, externalConversationId, customerName, image, setState = () => {}) {
    if (!this.window || this.window.isDestroyed()) await this.#createWindow();
    const view = this.#ensureView(account);
    await this.#waitForViewReady(view.webContents);
    setState('switching_conversation');
    const requestId = randomUUID();
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingImagePreparations.delete(requestId);
        reject(new Error('切换拼多多会话并发送图片超时'));
      }, IMAGE_PREPARATION_TIMEOUT_MS);
      this.pendingImagePreparations.set(requestId, { accountId: account.id, resolve, reject, timer });
      view.webContents.send('pdd-adapter:command', {
        type: 'prepare-image',
        requestId,
        conversationKey: (externalConversationId || `name:${customerName}`).slice(0, 128),
        customerName: customerName.slice(0, 128),
      });
    });
    if (result?.status !== 'ready') throw new Error(result?.error || '拼多多图片输入框准备失败');
    setState('sending_image');
    const sent = await this.#pasteAndSendImage(
      view,
      account,
      requestId,
      image,
      result.conversation_key || '',
      customerName,
    );
    if (sent?.status !== 'sent') throw new Error(sent?.error || '拼多多图片发送失败');
    return sent;
  }

  async #downloadImage(imageUrl, signal = undefined) {
    if (!/^https?:\/\//i.test(String(imageUrl || ''))) throw new Error('图片地址无效');
    const response = await fetch(imageUrl, { signal });
    if (!response.ok) throw new Error(`图片下载失败（HTTP ${response.status}）`);
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) throw new Error('远程资源不是图片');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 10 * 1024 * 1024) throw new Error('图片不能超过 10 MB');
    const image = nativeImage.createFromBuffer(bytes);
    if (image.isEmpty()) throw new Error('图片内容无效');
    return image;
  }

  #withClipboardLock(operation) {
    return this.clipboardQueue.run(operation);
  }

  #getStoreActor(account) {
    const existing = this.storeActors.get(account.id);
    if (existing) return existing;
    const actor = new StoreActor({
      accountId: account.id,
      rescan: ({ reasons }) => this.#scanStore(account.id, reasons),
      onStateChange: ({ state, error }) => {
        const view = this.views.get(account.id);
        if (view && !view.webContents.isDestroyed()) {
          view.webContents.send('pdd-adapter:command', {
            type: 'set-store-actor-state',
            state,
          });
        }
        this.#writeDiagnostic(account.id, 'store_actor_state_changed', {
          state,
          ...(error ? { error } : {}),
        }, error ? 'warn' : 'debug');
      },
    });
    this.storeActors.set(account.id, actor);
    return actor;
  }

  async #scanStore(accountId, reasons = []) {
    const view = this.views.get(accountId);
    if (!view || view.webContents.isDestroyed()) throw new Error('店铺页面已关闭，无法重新扫描');
    const requestId = randomUUID();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingStoreScans.delete(requestId);
        reject(new Error('店铺页面重新扫描超时'));
      }, STORE_SCAN_TIMEOUT_MS);
      this.pendingStoreScans.set(requestId, { accountId, resolve, reject, timer });
      view.webContents.send('pdd-adapter:command', {
        type: 'scan-current-page',
        requestId,
      });
    });
    this.#writeDiagnostic(accountId, 'store_actor_rescan_completed', { reasons });
  }

  async #collectNextUnread(account) {
    const view = this.views.get(account.id);
    if (!view || view.webContents.isDestroyed()) throw new Error('店铺页面已关闭，无法读取未读会话');
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingUnreadCollections.delete(requestId);
        reject(new Error('读取拼多多未读会话超时'));
      }, UNREAD_COLLECTION_TIMEOUT_MS);
      this.pendingUnreadCollections.set(requestId, { accountId: account.id, resolve, reject, timer });
      view.webContents.send('pdd-adapter:command', { type: 'collect-next-unread', requestId });
    });
  }

  async #pasteAndSendImage(
    view,
    account,
    requestId,
    image,
    expectedConversationKey = '',
    customerName = '',
  ) {
    await this.#withClipboardLock(async () => {
      clipboard.writeImage(image);
      const pasted = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingImagePreparations.delete(requestId);
          reject(new Error('拼多多图片粘贴确认超时'));
        }, IMAGE_PREPARATION_TIMEOUT_MS);
        this.pendingImagePreparations.set(requestId, { accountId: account.id, resolve, reject, timer });
      });
      view.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: ['control'] });
      view.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers: ['control'] });
      view.webContents.send('pdd-adapter:command', {
        type: 'wait-image-paste',
        requestId,
        expectedConversationKey,
        customerName,
      });
      const result = await pasted;
      if (result?.status !== 'ready') throw new Error(result?.error || '拼多多图片粘贴失败');
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingImagePreparations.delete(requestId);
        reject(new Error('拼多多图片发送超时'));
      }, IMAGE_PREPARATION_TIMEOUT_MS);
      this.pendingImagePreparations.set(requestId, { accountId: account.id, resolve, reject, timer });
      view.webContents.send('pdd-adapter:command', {
        type: 'send-image-enter',
        requestId,
        expectedConversationKey,
        customerName,
      });
    });
  }

  #enqueueRpaTask(task) {
    if (!task?.id) return;
    const platformAccountId = task.platform_account_id || task.payload_json?.platform_account_id;
    const account = this.registry.list(this.userId).find(
      (candidate) => candidate.platformAccountId === platformAccountId
        && !candidate.paused
        && !UNAVAILABLE_LOGIN_STATUSES.has(candidate.loginStatus)
        && this.#isAccountIdentityVerified(candidate),
    );
    if (!account) {
      void this.#executeRpaTask(task, null);
      return;
    }
    let started = false;
    void this.#getStoreActor(account)
      .enqueue(
        task.task_type === 'send_message'
          ? 'send_reply_bundle'
          : task.task_type === 'refresh_customer_orders' ? 'collect_unread' : 'send_image',
        ({ setState, signal }) => {
        started = true;
        return this.#executeRpaTask(task, account, setState, signal);
        },
      )
      .catch((error) => {
        if (!started) {
          this.rpaManager?.completeTask(task.id, 'failed', {}, error?.message || String(error));
        }
      });
  }

  async #sendFollowUpImageInCurrentConversation(
    view,
    account,
    expectedConversationKey,
    customerName,
    image,
  ) {
    const requestId = randomUUID();
    const prepared = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingImagePreparations.delete(requestId);
        reject(new Error('当前拼多多会话图片输入框准备超时'));
      }, IMAGE_PREPARATION_TIMEOUT_MS);
      this.pendingImagePreparations.set(requestId, { accountId: account.id, resolve, reject, timer });
      view.webContents.send('pdd-adapter:command', {
        type: 'prepare-image-current',
        requestId,
        expectedConversationKey,
        customerName,
      });
    });
    if (prepared?.status !== 'ready') throw new Error(prepared?.error || '当前拼多多会话图片输入框准备失败');
    const sent = await this.#pasteAndSendImage(
      view,
      account,
      requestId,
      image,
      expectedConversationKey,
      customerName,
    );
    if (sent?.status !== 'sent') throw new Error(sent?.error || '拼多多图片发送失败');
    return sent;
  }

  async #sendReplyBundle(task, payload, account, setState = () => {}, signal = undefined) {
    if (!account) throw new Error('未找到消息对应的拼多多店铺，请确认店铺已登录');
    const followUp = payload.follow_up;
    const image = followUp?.type === 'image' && followUp.url
      ? await this.#downloadImage(followUp.url, signal)
      : null;
    if (!this.window || this.window.isDestroyed()) await this.#createWindow();
    const view = this.#ensureView(account);
    await this.#waitForViewReady(view.webContents);
    const textResult = await this.#sendMessageNow(
      account,
      payload.external_conversation_id,
      payload.customer_name || '',
      payload.content || '',
      setState,
    );
    let imageResult = null;
    if (image) {
      try {
        setState('sending_image');
        imageResult = await this.#sendFollowUpImageInCurrentConversation(
          view,
          account,
          textResult.conversation_key,
          payload.customer_name || '',
          image,
        );
      } catch (error) {
        error.resultJson = {
          text_sent: true,
          image_sent: false,
          image_error: error?.message || String(error),
        };
        throw error;
      }
    }
    return {
      method: textResult.method || null,
      text_sent: true,
      image_sent: Boolean(imageResult),
      image_method: imageResult?.method || null,
    };
  }

  async #executeRpaTask(task, account, setState = () => {}, signal = undefined) {
    if (!task?.id || !this.rpaManager) return;
    const payload = task.payload_json || {};
    try {
      if (task.task_type === 'send_message') {
        const result = await this.#sendReplyBundle(task, payload, account, setState, signal);
        this.rpaManager.completeTask(task.id, 'completed', result);
      } else if (task.task_type === 'send_image') {
        if (!account) throw new Error('未找到消息对应的拼多多店铺，请确认店铺已登录');
        const image = await this.#downloadImage(payload.image_url, signal);
        const result = await this.#sendImageNow(
          account,
          payload.external_conversation_id,
          payload.customer_name || '',
          image,
          setState,
        );
        this.rpaManager.completeTask(task.id, 'completed', result);
      } else if (task.task_type === 'refresh_customer_orders') {
        if (!account) throw new Error('未找到订单对应的拼多多店铺，请确认店铺已登录');
        const conversationKey = payload.external_conversation_id || `name:${payload.customer_name || ''}`;
        const result = await this.#importConversationNow(account, conversationKey.slice(0, 128));
        if (result?.status !== 'collected') throw new Error('重新读取客户订单失败');
        this.rpaManager.completeTask(task.id, 'completed', result);
      } else {
        this.rpaManager.completeTask(task.id, 'failed', {}, `Unsupported RPA task: ${task.task_type}`);
      }
    } catch (error) {
      this.rpaManager.completeTask(
        task.id,
        'failed',
        error?.resultJson || {},
        error?.message || String(error),
      );
    }
  }

  async setAccountPaused(accountId, paused) {
    this.#requireUser();
    const account = this.registry.get(this.userId, accountId);
    if (!account || account.archivedAt) throw new Error('店铺账号不存在');
    this.registry.update(this.userId, accountId, { paused });
    this.registry.update(this.userId, accountId, {
      loginStatus: paused ? 'paused' : 'unknown',
    });

    if (paused) {
      this.#dequeueBackgroundAccount(accountId);
      this.#destroyView(accountId);
      if (this.activeAccountId === accountId) this.activeAccountId = null;
      await this.#ensureInitialAccount();
    } else {
      await this.selectAccount(accountId);
    }
    this.#publishState();
    this.#syncRpaAccounts();
    return this.getState();
  }

  async removeAccount(accountId, clearStorage) {
    this.#requireUser();
    const account = this.registry.get(this.userId, accountId);
    if (!account || account.archivedAt) throw new Error('店铺账号不存在');
    this.#dequeueBackgroundAccount(accountId);
    this.#destroyView(accountId);
    if (this.activeAccountId === accountId) this.activeAccountId = null;

    if (clearStorage) {
      this.registry.remove(this.userId, accountId);
      await this.#clearPartition(account.partition);
    } else {
      this.registry.update(this.userId, accountId, { archivedAt: new Date().toISOString(), paused: true });
    }

    await this.#ensureInitialAccount();
    this.#syncRpaAccounts();
    this.#publishState();
    return this.getState();
  }

  async restoreAccount(accountId) {
    this.#requireUser();
    const account = this.registry.get(this.userId, accountId);
    if (!account || !account.archivedAt) throw new Error('没有可恢复的店铺资料');
    this.registry.update(this.userId, accountId, { archivedAt: null, paused: false });
    this.registry.update(this.userId, accountId, { loginStatus: 'unknown' });
    this.#syncRpaAccounts();
    return this.selectAccount(accountId);
  }

  setOverlayOpen(open) {
    this.overlayOpen = Boolean(open);
    const activeView = this.views.get(this.activeAccountId);
    if (activeView && !activeView.webContents.isDestroyed()) {
      activeView.setVisible(!this.overlayOpen);
    }
    return this.getState();
  }

  goBack() {
    this.#requireIdleActiveStore('后退');
    const contents = this.#activeWebContents();
    if (contents?.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    return this.getState();
  }

  goForward() {
    this.#requireIdleActiveStore('前进');
    const contents = this.#activeWebContents();
    if (contents?.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
    return this.getState();
  }

  reload() {
    this.#requireIdleActiveStore('刷新');
    this.#activeWebContents()?.reload();
    return this.getState();
  }

  async closeForLogout() {
    this.#cancelBackgroundAccountLoads();
    await this.#flushAccountStorage();
    for (const accountId of [...this.views.keys()]) this.#destroyView(accountId);
    this.activeAccountId = null;
    this.runtime.clear();
    this.collectors.clear();
    if (this.window && !this.window.isDestroyed()) {
      this.isQuitting = true;
      this.window.destroy();
      this.isQuitting = false;
    }
    this.window = null;
    this.userId = null;
  }

  async prepareToQuit() {
    this.isQuitting = true;
    this.#cancelBackgroundAccountLoads();
    await this.#flushAccountStorage();
    for (const accountId of [...this.views.keys()]) this.#destroyView(accountId);
  }

  async #flushAccountStorage() {
    if (!this.userId) return;
    const accounts = [
      ...this.registry.list(this.userId),
      ...this.registry.list(this.userId, { archived: true }),
    ];
    await Promise.allSettled(accounts.map(async (account) => {
      try {
        await session.fromPartition(account.partition).flushStorageData();
      } catch (error) {
        this.#writeDiagnostic(account.id, 'partition_flush_failed', {
          error: error?.message || String(error),
        }, 'warn');
      }
    }));
  }

  #scheduleBackgroundAccountLoads() {
    if (!this.userId) return;
    for (const account of this.registry.list(this.userId)) {
      if (
        account.paused
        || account.archivedAt
        || this.views.has(account.id)
        || this.queuedBackgroundAccounts.has(account.id)
      ) continue;
      this.backgroundLoadQueue.push(account.id);
      this.queuedBackgroundAccounts.add(account.id);
      this.#patchRuntime(account.id, { status: 'queued' });
      this.#writeDiagnostic(account.id, 'background_load_queued');
    }
    this.#publishState();
    this.#startBackgroundAccountLoads();
  }

  #startBackgroundAccountLoads() {
    if (this.backgroundLoadRunning || !this.backgroundLoadQueue.length) return;
    const generation = this.backgroundLoadGeneration;
    this.backgroundLoadRunning = true;
    void this.#drainBackgroundAccountLoads(generation).finally(() => {
      if (generation !== this.backgroundLoadGeneration) return;
      this.backgroundLoadRunning = false;
      if (this.backgroundLoadQueue.length) this.#startBackgroundAccountLoads();
    });
  }

  async #drainBackgroundAccountLoads(generation) {
    while (generation === this.backgroundLoadGeneration && this.backgroundLoadQueue.length) {
      await this.#waitForInitialViewLoads(generation);
      if (generation !== this.backgroundLoadGeneration) return;

      const accountId = this.backgroundLoadQueue.shift();
      this.queuedBackgroundAccounts.delete(accountId);
      const account = this.userId ? this.registry.get(this.userId, accountId) : null;
      if (!account || account.paused || account.archivedAt || this.views.has(accountId)) {
        if (this.runtime.get(accountId)?.status === 'queued') this.runtime.delete(accountId);
        continue;
      }

      this.#writeDiagnostic(accountId, 'background_load_started');
      this.#ensureView(account);
      this.#publishState();
    }
  }

  async #waitForInitialViewLoads(generation) {
    const loads = [...this.initialViewLoads.entries()];
    if (!loads.length) return;
    await Promise.all(loads.map(([accountId, loadPromise]) => new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.initialViewLoads.get(accountId) === loadPromise) {
          this.initialViewLoads.delete(accountId);
          if (this.runtime.get(accountId)?.status === 'loading') {
            this.#patchRuntime(accountId, { status: 'error', detail: '后台页面加载超时' });
          }
          this.#writeDiagnostic(accountId, 'background_load_timeout', {}, 'warn');
          this.#publishState();
        }
        resolve();
      }, BACKGROUND_ACCOUNT_LOAD_TIMEOUT_MS);
      loadPromise.finally(() => {
        clearTimeout(timer);
        resolve();
      });
    })));
    if (generation !== this.backgroundLoadGeneration) return;
  }

  #dequeueBackgroundAccount(accountId) {
    if (!this.queuedBackgroundAccounts.delete(accountId)) return;
    this.backgroundLoadQueue = this.backgroundLoadQueue.filter((id) => id !== accountId);
    if (this.runtime.get(accountId)?.status === 'queued') this.runtime.delete(accountId);
  }

  #cancelBackgroundAccountLoads() {
    this.backgroundLoadGeneration += 1;
    this.backgroundLoadRunning = false;
    this.backgroundLoadQueue = [];
    for (const accountId of this.queuedBackgroundAccounts) {
      if (this.runtime.get(accountId)?.status === 'queued') this.runtime.delete(accountId);
    }
    this.queuedBackgroundAccounts.clear();
    this.initialViewLoads.clear();
  }

  #ensureView(account) {
    const existing = this.views.get(account.id);
    if (existing && !existing.webContents.isDestroyed()) return existing;

    const view = new WebContentsView({
      webPreferences: {
        partition: account.partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        ...(this.pddPreloadPath ? { preload: this.pddPreloadPath } : {}),
        additionalArguments: [serializedSelectorArgument()],
      },
    });
    view.setBackgroundColor('#ffffff');
    view.setVisible(false);
    view.webContents.setBackgroundThrottling(false);
    this.views.set(account.id, view);
    this.#createCollector(account.id);
    this.window.contentView.addChildView(view);
    this.#configureSession(view.webContents.session);
    this.#bindViewEvents(account.id, view);
    this.#layoutViews();

    this.#patchRuntime(account.id, { status: 'loading' });
    this.#writeDiagnostic(account.id, 'view_created', {
      page_path: this.homeUrl,
      partition: account.partition,
    });
    const initialLoad = view.webContents.loadURL(this.homeUrl).catch((error) => {
      if (this.views.get(account.id) !== view) return;
      this.#patchRuntime(account.id, { status: 'error', detail: error.message });
      this.#writeDiagnostic(account.id, 'view_load_rejected', {
        error: error.message,
      }, 'error');
      this.#publishState();
    }).finally(() => {
      if (this.initialViewLoads.get(account.id) === initialLoad) {
        this.initialViewLoads.delete(account.id);
      }
    });
    this.initialViewLoads.set(account.id, initialLoad);
    return view;
  }

  #configureSession(accountSession) {
    if (this.configuredPartitions.has(accountSession.partition)) return;
    this.configuredPartitions.add(accountSession.partition);
    accountSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    accountSession.setPermissionCheckHandler(() => false);
    accountSession.on('will-download', (event) => event.preventDefault());
  }

  #bindViewEvents(accountId, view) {
    const contents = view.webContents;
    let mainFrameLoadFailed = false;
    const setStatus = (status, detail) => {
      this.#patchRuntime(accountId, { status, detail });
      this.#publishState();
    };

    contents.on('did-start-loading', () => {
      mainFrameLoadFailed = false;
      setStatus('loading');
      this.#writeDiagnostic(accountId, 'view_load_started', {
        page_path: diagnosticPagePath(contents.getURL()),
      });
    });
    contents.on('did-stop-loading', () => {
      if (!mainFrameLoadFailed) {
        setStatus('ready');
        this.#updateLoginStatus(accountId, contents.getURL());
        contents.send('pdd-adapter:command', { type: 'scan' });
        this.#writeDiagnostic(accountId, 'view_load_stopped', {
          page_path: diagnosticPagePath(contents.getURL()),
        });
      }
    });
    contents.on('did-fail-load', (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
      if (isMainFrame && errorCode !== -3) {
        mainFrameLoadFailed = true;
        setStatus('error', errorDescription);
        this.#setAccountLoginStatus(accountId, 'error');
        this.#writeDiagnostic(accountId, 'view_load_failed', {
          error_code: errorCode,
          error: errorDescription,
        }, 'error');
      }
    });
    contents.on('render-process-gone', (_event, details) => {
      setStatus('error', details.reason);
      this.#writeDiagnostic(accountId, 'view_render_process_gone', {
        reason: details.reason,
        exit_code: details.exitCode,
      }, 'error');
    });
    contents.on('did-navigate', (_event, url) => {
      this.#updateLoginStatus(accountId, url);
      this.#writeDiagnostic(accountId, 'view_navigated', {
        page_path: diagnosticPagePath(url),
      });
      this.#publishState();
    });
    contents.on('did-navigate-in-page', (_event, url) => {
      this.#updateLoginStatus(accountId, url);
      this.#writeDiagnostic(accountId, 'view_navigated_in_page', {
        page_path: diagnosticPagePath(url),
      });
      this.#publishState();
    });
    contents.on('ipc-message', (_event, channel, payload) => {
      if (channel !== 'pdd-adapter:event') return;
      if (payload?.type === 'diagnostic') {
        this.diagnosticLogger?.write(accountId, payload);
        return;
      }
      if (payload?.type === 'account_name_detection') {
        const pending = this.pendingNameDetections.get(payload.request_id);
        if (!pending || pending.accountId !== accountId) return;
        clearTimeout(pending.timer);
        this.pendingNameDetections.delete(payload.request_id);
        const accountName = detectedAlias(payload.account_name);
        const source = ['dom', 'document_title'].includes(payload.source) ? payload.source : null;
        this.#writeDiagnostic(accountId, 'account_name_detection_received', {
          detected: Boolean(accountName && source),
          source,
          detected_name_length: accountName?.length || 0,
        });
        pending.resolve(accountName && source ? { accountName, source } : null);
        return;
      }
      if (payload?.type === 'conversation_candidates') {
        const pending = this.pendingConversationLists.get(payload.request_id);
        if (!pending || pending.accountId !== accountId) return;
        clearTimeout(pending.timer);
        this.pendingConversationLists.delete(payload.request_id);
        pending.resolve(Array.isArray(payload.conversations) ? payload.conversations : []);
        return;
      }
      if (payload?.type === 'conversation_collection_result') {
        const pending = this.pendingConversationCollections.get(payload.request_id);
        if (!pending || pending.accountId !== accountId) return;
        clearTimeout(pending.timer);
        this.pendingConversationCollections.delete(payload.request_id);
        pending.resolve(payload);
        return;
      }
      if (payload?.type === 'collect_unread_request') {
        const account = this.registry.get(this.userId, accountId);
        if (
          !account
          || account.paused
          || account.archivedAt
          || UNAVAILABLE_LOGIN_STATUSES.has(account.loginStatus)
        ) return;
        void this.#getStoreActor(account)
          .enqueue(
            'collect_unread',
            () => this.#collectNextUnread(account),
            { coalesceKey: 'collect_unread' },
          )
          .catch((error) => {
            this.#writeDiagnostic(accountId, 'collect_unread_actor_failed', {
              error: error?.message || String(error),
            }, 'warn');
          });
        return;
      }
      if (payload?.type === 'rescan_requested') {
        this.storeActors.get(accountId)?.requestRescan(payload.reason || 'preload_requested');
        return;
      }
      if (payload?.type === 'scan_result') {
        const pending = this.pendingStoreScans.get(payload.request_id);
        if (!pending || pending.accountId !== accountId) return;
        clearTimeout(pending.timer);
        this.pendingStoreScans.delete(payload.request_id);
        if (payload.status === 'completed') pending.resolve(payload);
        else pending.reject(new Error('店铺页面重新扫描失败'));
        return;
      }
      if (payload?.type === 'unread_collection_result') {
        const pending = this.pendingUnreadCollections.get(payload.request_id);
        if (!pending || pending.accountId !== accountId) return;
        clearTimeout(pending.timer);
        this.pendingUnreadCollections.delete(payload.request_id);
        if (payload.status === 'failed') pending.reject(new Error(payload.error || '读取未读会话失败'));
        else pending.resolve(payload);
        return;
      }
      if (payload?.type === 'message_send_result') {
        const pending = this.pendingMessagePreparations.get(payload.request_id);
        if (!pending || pending.accountId !== accountId) return;
        clearTimeout(pending.timer);
        this.pendingMessagePreparations.delete(payload.request_id);
        pending.resolve(payload);
        return;
      }
      if (
        payload?.type === 'image_preparation_result'
        || payload?.type === 'image_paste_result'
        || payload?.type === 'image_send_result'
      ) {
        const pending = this.pendingImagePreparations.get(payload.request_id);
        if (!pending || pending.accountId !== accountId) return;
        clearTimeout(pending.timer);
        this.pendingImagePreparations.delete(payload.request_id);
        pending.resolve(payload);
        return;
      }
      const ingested = this.collectors.get(accountId)?.runtime.ingest(payload);
      if (!ingested) {
        this.#writeDiagnostic(accountId, 'adapter_payload_rejected', {
          payload_type: payload?.type,
          payload_version: payload?.version,
        }, 'warn');
      }
    });
    contents.on('will-navigate', (event, navigationUrl) => {
      if (!isAllowedPddUrl(navigationUrl)) event.preventDefault();
    });
    contents.setWindowOpenHandler(({ url }) => {
      if (isAllowedPddUrl(url)) {
        void contents.loadURL(url);
      } else if (isSafeExternalUrl(url)) {
        void shell.openExternal(url);
      }
      return { action: 'deny' };
    });
  }

  #layoutViews() {
    if (!this.window || this.window.isDestroyed()) return;
    const [width, height] = this.window.getContentSize();
    const bounds = {
      x: 0,
      y: WORKSPACE_TOOLBAR_HEIGHT,
      width: Math.max(width, 1),
      height: Math.max(height - WORKSPACE_TOOLBAR_HEIGHT, 1),
    };
    for (const view of this.views.values()) view.setBounds(bounds);
  }

  #destroyView(accountId) {
    this.#cancelStoreActor(accountId, '店铺页面已关闭，任务已取消');
    this.verifiedAccountIdentities.delete(accountId);
    this.initialViewLoads.delete(accountId);
    const view = this.views.get(accountId);
    if (!view) return;
    try {
      this.window?.contentView.removeChildView(view);
    } catch {
      // The window may already be tearing down.
    }
    if (!view.webContents.isDestroyed()) view.webContents.close();
    this.views.delete(accountId);
    this.runtime.delete(accountId);
    this.collectors.delete(accountId);
    for (const [requestId, pending] of this.pendingNameDetections) {
      if (pending.accountId !== accountId) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error('店铺页面已关闭，无法继续识别名称'));
      this.pendingNameDetections.delete(requestId);
    }
    for (const [requestId, pending] of this.pendingConversationLists) {
      if (pending.accountId !== accountId) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error('店铺页面已关闭，无法扫描会话'));
      this.pendingConversationLists.delete(requestId);
    }
    for (const [requestId, pending] of this.pendingConversationCollections) {
      if (pending.accountId !== accountId) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error('店铺页面已关闭，无法读取会话'));
      this.pendingConversationCollections.delete(requestId);
    }
    for (const [requestId, pending] of this.pendingMessagePreparations) {
      if (pending.accountId !== accountId) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error('店铺页面已关闭，无法发送消息'));
      this.pendingMessagePreparations.delete(requestId);
    }
    for (const [requestId, pending] of this.pendingImagePreparations) {
      if (pending.accountId !== accountId) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error('店铺页面已关闭，无法继续发送图片'));
      this.pendingImagePreparations.delete(requestId);
    }
    for (const [requestId, pending] of this.pendingStoreScans) {
      if (pending.accountId !== accountId) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error('店铺页面已关闭，无法重新扫描'));
      this.pendingStoreScans.delete(requestId);
    }
    for (const [requestId, pending] of this.pendingUnreadCollections) {
      if (pending.accountId !== accountId) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error('店铺页面已关闭，无法读取未读会话'));
      this.pendingUnreadCollections.delete(requestId);
    }
  }

  #cancelStoreActor(accountId, reason) {
    const actor = this.storeActors.get(accountId);
    if (actor) {
      actor.cancel(reason);
      this.storeActors.delete(accountId);
    }
    this.#rejectAccountRequests(accountId, reason);
  }

  #rejectAccountRequests(accountId, reason) {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    const pendingMaps = [
      this.pendingNameDetections,
      this.pendingConversationLists,
      this.pendingConversationCollections,
      this.pendingMessagePreparations,
      this.pendingImagePreparations,
      this.pendingStoreScans,
      this.pendingUnreadCollections,
    ];
    for (const pendingMap of pendingMaps) {
      for (const [requestId, pending] of pendingMap) {
        if (pending.accountId !== accountId) continue;
        clearTimeout(pending.timer);
        pending.reject(error);
        pendingMap.delete(requestId);
      }
    }
  }

  async #waitForViewReady(contents) {
    if (!contents.isLoading()) return;
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        contents.removeListener('did-stop-loading', onLoaded);
        contents.removeListener('render-process-gone', onGone);
      };
      const onLoaded = () => {
        cleanup();
        resolve();
      };
      const onGone = () => {
        cleanup();
        reject(new Error('店铺页面加载失败'));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('店铺页面加载超时，请稍后重试'));
      }, ACCOUNT_NAME_PAGE_LOAD_TIMEOUT_MS);
      contents.once('did-stop-loading', onLoaded);
      contents.once('render-process-gone', onGone);
    });
  }

  async #clearPartition(partition) {
    const accountSession = session.fromPartition(partition);
    await accountSession.clearStorageData({
      storages: [
        'cookies',
        'filesystem',
        'indexdb',
        'localstorage',
        'serviceworkers',
        'cachestorage',
      ],
    });
    await accountSession.clearCache();
  }

  #activeWebContents() {
    const view = this.views.get(this.activeAccountId);
    return view && !view.webContents.isDestroyed() ? view.webContents : null;
  }

  #requireIdleActiveStore(action) {
    const actor = this.storeActors.get(this.activeAccountId);
    if (!actor || actor.state === 'idle' || actor.state === 'cancelled') return;
    this.#writeDiagnostic(this.activeAccountId, 'manual_navigation_blocked', {
      action,
      actor_state: actor.state,
    }, 'warn');
    throw new Error(`店铺正在执行自动化任务，暂时不能${action}`);
  }

  #publishState() {
    if (!this.window || this.window.isDestroyed() || this.window.webContents.isDestroyed()) return;
    this.window.webContents.send('pdd-workspace:state-changed', this.getState());
  }

  #patchRuntime(accountId, updates) {
    this.runtime.set(accountId, { ...this.runtime.get(accountId), ...updates });
  }

  async refreshCustomerOrders({ platformAccountId, externalConversationId, customerName }) {
    this.#requireUser();
    const account = this.registry.list(this.userId).find(
      (candidate) => candidate.platformAccountId === platformAccountId
        && !candidate.paused
        && !candidate.archivedAt
        && !UNAVAILABLE_LOGIN_STATUSES.has(candidate.loginStatus)
        && this.#isAccountIdentityVerified(candidate),
    );
    if (!account) throw new Error('未找到订单对应的拼多多店铺，请确认店铺已登录');
    const conversationKey = externalConversationId || `name:${customerName}`;
    return this.#getStoreActor(account).enqueue('collect_unread', () => (
      this.#importConversationNow(account, conversationKey.slice(0, 128))
    ));
  }

  #isAccountIdentityVerified(account) {
    if (!account.externalAccountId) return Boolean(account.platformAccountId);
    return this.verifiedAccountIdentities.has(account.id);
  }

  #updateLoginStatus(accountId, value) {
    try {
      const status = classifyPddPage(value);
      if (['login_required', 'online', 'risk_control'].includes(status)) {
        this.#setAccountLoginStatus(accountId, status);
      }
    } catch {
      // Ignore incomplete navigation URLs.
    }
  }

  #setAccountLoginStatus(accountId, loginStatus) {
    if (!this.userId) return;
    const account = this.registry.get(this.userId, accountId);
    if (!account) return;
    if (account.loginStatus !== loginStatus) this.registry.update(this.userId, accountId, { loginStatus });
    if (loginStatus === 'login_required' || loginStatus === 'risk_control') {
      this.#cancelStoreActor(accountId, '店铺登录状态不可用，任务已取消');
    }
    this.#syncRpaAccounts();
  }

  #syncRpaAccounts() {
    if (!this.userId || !this.rpaManager) return;
    this.rpaManager.setAccounts([
      ...this.registry.list(this.userId),
      ...this.registry.list(this.userId, { archived: true }),
    ]);
  }

  #createCollector(accountId) {
    if (this.collectors.has(accountId)) return this.collectors.get(accountId);
    const collector = {
      status: 'idle',
      lastCollectedAt: null,
      runtime: new PddCollectionRuntime({
        localAccountId: accountId,
        getPlatformAccountId: () => {
          const account = this.registry.get(this.userId, accountId);
          return account && this.#isAccountIdentityVerified(account) ? account.platformAccountId || null : null;
        },
        enqueueEvent: (event) => {
          const account = this.registry.get(this.userId, accountId);
          const identityVerified = account ? this.#isAccountIdentityVerified(account) : false;
          if (!account || !identityVerified) {
            this.#writeDiagnostic(accountId, 'runtime_event_dropped_before_rpa_enqueue', {
              reason: !account ? 'account_missing' : 'identity_not_verified',
              event_id: event?.event_id || null,
              event_type: event?.event_type || null,
              platform_message_id: event?.platform_message_id || null,
              conversation_external_id: event?.conversation_external_id || null,
              sender_role: event?.payload_json?.sender_role || null,
              content_preview: String(event?.payload_json?.content || '').slice(0, 128),
              has_platform_account_id: Boolean(account?.platformAccountId),
              has_external_account_id: Boolean(account?.externalAccountId),
              login_status: account?.loginStatus || null,
            }, 'warn');
            return;
          }
          collector.status = 'collecting';
          collector.lastCollectedAt = new Date().toISOString();
          this.#writeDiagnostic(accountId, 'runtime_event_forwarding_to_rpa', {
            event_id: event?.event_id || null,
            event_type: event?.event_type || null,
            platform_account_id: event?.platform_account_id || null,
            platform_message_id: event?.platform_message_id || null,
            conversation_external_id: event?.conversation_external_id || null,
            sender_role: event?.payload_json?.sender_role || null,
            content_preview: String(event?.payload_json?.content || '').slice(0, 128),
            rpa_state: this.rpaManager?.getState?.().status || null,
            ...(event?.event_type === 'customer_orders_snapshot' ? {
              order_collection_status: event?.payload_json?.collection_status || null,
              order_collection_error: event?.payload_json?.error || null,
              order_count: Array.isArray(event?.payload_json?.orders) ? event.payload_json.orders.length : 0,
            } : {}),
          });
          this.rpaManager?.enqueueEvent(event);
          this.#publishState();
        },
        onDiagnostic: (stage, details = {}, level = 'debug') => {
          this.#writeDiagnostic(accountId, stage, details, level);
        },
        onStatus: (status) => {
          collector.status = status === 'online' ? 'watching' : status;
          if (['login_required', 'online', 'risk_control', 'error'].includes(status)) {
            this.#setAccountLoginStatus(accountId, status);
          }
          this.#publishState();
        },
        onIdentity: ({
          external_account_id: externalAccountId,
          account_name: platformAccountName,
          account_name_source: accountNameSource,
        }) => {
          const current = this.registry.get(this.userId, accountId);
          if (!current) return;
          if (
            current.externalAccountId
            && externalAccountId
            && current.externalAccountId !== externalAccountId
          ) {
            this.registry.update(this.userId, accountId, { loginStatus: 'account_mismatch' });
            collector.status = 'error';
            this.#cancelStoreActor(accountId, '登录账号与原店铺不匹配，任务已取消');
            this.#writeDiagnostic(accountId, 'account_identity_mismatch', {
              expected_present: true,
              actual_present: true,
            }, 'error');
            this.#syncRpaAccounts();
            this.#publishState();
            return;
          }
          const canVerifyIdentity = externalAccountId
            ? (!current.externalAccountId || current.externalAccountId === externalAccountId)
            : (!current.externalAccountId && Boolean(current.platformAccountId));
          if (canVerifyIdentity) {
            const wasVerified = this.verifiedAccountIdentities.has(accountId);
            this.verifiedAccountIdentities.add(accountId);
            if (!wasVerified) {
              this.#writeDiagnostic(accountId, 'account_identity_verified', {
                method: externalAccountId ? 'external_account_id' : 'bound_platform_account',
                has_platform_account_id: Boolean(current.platformAccountId),
                has_external_account_id: Boolean(externalAccountId),
              });
            }
            collector.runtime.accountBindingChanged();
          }
          const identifiedAlias = detectedAlias(platformAccountName);
          const shouldIdentifyAlias = isAutoReplaceableAlias(current.alias) && identifiedAlias;
          if (
            current.externalAccountId === externalAccountId
            && current.platformAccountName === platformAccountName
            && !shouldIdentifyAlias
          ) return;
          this.registry.update(this.userId, accountId, {
            externalAccountId,
            platformAccountName,
            ...(shouldIdentifyAlias ? { alias: identifiedAlias } : {}),
          });
          if (shouldIdentifyAlias) {
            this.#writeDiagnostic(accountId, 'account_name_identified', {
              detected_name_length: identifiedAlias.length,
              source: accountNameSource || null,
            });
          }
          this.#syncRpaAccounts();
          this.#publishState();
        },
      }),
    };
    this.collectors.set(accountId, collector);
    return collector;
  }

  #writeDiagnostic(accountId, stage, details = {}, level = 'info') {
    this.diagnosticLogger?.write(accountId, {
      type: 'diagnostic',
      level,
      stage,
      details,
      observed_at: new Date().toISOString(),
    });
  }

  #requireUser() {
    if (!this.userId) throw new Error('拼多多工作区尚未绑定当前用户');
  }
}
