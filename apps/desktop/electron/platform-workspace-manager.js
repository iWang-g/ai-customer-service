import { BrowserWindow } from 'electron';

const PLATFORMS = {
  pinduoduo: { name: '拼多多', managerKey: 'pdd' },
  douyin: { name: '抖店', managerKey: 'douyin' },
};

function accountState(platformCode, platformName, account) {
  return {
    id: account.id,
    platformCode,
    platformName,
    alias: account.alias || account.platformAccountName || account.id,
    paused: Boolean(account.paused),
    loginStatus: account.loginStatus || 'unknown',
    runtimeStatus: account.runtimeStatus || 'idle',
    collectionStatus: account.collectionStatus || 'idle',
    statusDetail: account.statusDetail || null,
    platformAccountId: account.platformAccountId || null,
    platformAccountLogoUrl: account.platformAccountLogoUrl || null,
    lastOpenedAt: account.lastOpenedAt || null,
  };
}

export class PlatformWorkspaceManager {
  constructor({ pddManager, douyinManager, devServerUrl, rendererPath, preloadPath, rendererAdditionalArguments = [] }) {
    this.pddManager = pddManager;
    this.douyinManager = douyinManager;
    this.devServerUrl = devServerUrl;
    this.rendererPath = rendererPath;
    this.preloadPath = preloadPath;
    this.rendererAdditionalArguments = rendererAdditionalArguments;
    this.window = null;
    this.userId = null;
    this.activePlatform = null;
    this.activeAccountKey = null;
    this.platformFilter = 'all';
    this.hostBounds = null;
    this.overlayOpen = false;
    this.publishTimer = null;
  }

  manager(platformCode) {
    if (platformCode === 'pinduoduo') return this.pddManager;
    if (platformCode === 'douyin') return this.douyinManager;
    throw new Error('不支持的平台');
  }

  async open(userId, initial = {}) {
    if (!userId) throw new Error('请先登录本系统');
    if (this.userId && this.userId !== userId) await this.closeForLogout();
    this.userId = userId;
    await this.#ensureWindow();
    const reused = this.window.isVisible();
    this.pddManager.attachHostWindow(this.window);
    this.douyinManager.attachHostWindow(this.window);
    await Promise.allSettled([this.pddManager.open(userId), this.douyinManager.open(userId)]);
    const requested = initial.platformCode && initial.accountId
      ? `${initial.platformCode}:${initial.accountId}` : null;
    const accounts = this.#accounts();
    const fallback = accounts.find((item) => item.id === this.activeAccountKey && !item.paused)
      || (requested ? accounts.find((item) => item.id === requested && !item.paused) : null)
      || accounts.filter((item) => !item.paused).sort((a, b) => (b.lastOpenedAt || '').localeCompare(a.lastOpenedAt || ''))[0];
    if (fallback) await this.selectAccount(fallback.platformCode, fallback.id);
    this.#layout();
    this.window.show();
    this.window.focus();
    if (!this.publishTimer) this.publishTimer = setInterval(() => this.#publish(), 1000);
    this.#publish();
    return { opened: true, reused };
  }

  async #ensureWindow() {
    if (this.window && !this.window.isDestroyed()) return false;
    const window = new BrowserWindow({
      width: 1480,
      height: 920,
      minWidth: 1050,
      minHeight: 680,
      title: '多平台工作台 - AI智能客服',
      show: false,
      autoHideMenuBar: true,
      backgroundColor: '#f8fafc',
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        additionalArguments: this.rendererAdditionalArguments,
      },
    });
    this.window = window;
    window.on('resize', () => this.#layout());
    window.on('close', (event) => {
      if (!this.isClosing) {
        event.preventDefault();
        this.#hideViews();
        window.hide();
      }
    });
    window.on('closed', () => {
      if (this.window === window) this.window = null;
    });
    try {
      if (this.devServerUrl) {
        const url = new URL(this.devServerUrl);
        url.searchParams.set('view', 'platform-workspace');
        await window.loadURL(url.toString());
      } else {
        await window.loadFile(this.rendererPath, { query: { view: 'platform-workspace' } });
      }
    } catch (error) {
      window.destroy();
      this.window = null;
      throw error;
    }
    return true;
  }

  #accounts() {
    const result = [];
    for (const [platformCode, meta] of Object.entries(PLATFORMS)) {
      const state = this.manager(platformCode).getState();
      for (const account of state.accounts || []) result.push({
        ...accountState(platformCode, meta.name, account),
        id: `${platformCode}:${account.id}`,
        accountId: account.id,
      });
      for (const account of state.archivedAccounts || []) result.push({
        ...accountState(platformCode, meta.name, account),
        id: `${platformCode}:${account.id}`,
        accountId: account.id,
        archived: true,
      });
    }
    return result;
  }

  getState() {
    const accounts = this.#accounts();
    const active = accounts.find((account) => account.id === this.activeAccountKey) || null;
    const activeState = active ? this.manager(active.platformCode).getState() : null;
    const health = { pinduoduo: { accountCount: 0, onlineCount: 0, errorCount: 0 }, douyin: { accountCount: 0, onlineCount: 0, errorCount: 0 } };
    for (const account of accounts.filter((item) => !item.archived)) {
      const item = health[account.platformCode];
      item.accountCount += 1;
      if (['online', 'ready', 'watching'].includes(account.loginStatus) || account.runtimeStatus === 'ready') item.onlineCount += 1;
      if (['error', 'risk_control', 'account_mismatch'].includes(account.loginStatus) || account.runtimeStatus === 'error') item.errorCount += 1;
    }
    return {
      activePlatform: this.activePlatform,
      activeAccountKey: this.activeAccountKey,
      platformFilter: this.platformFilter,
      accounts: accounts.filter((item) => !item.archived),
      archivedAccounts: accounts.filter((item) => item.archived),
      navigation: activeState?.navigation || { canGoBack: false, canGoForward: false, isLoading: false },
      rpa: activeState?.rpa || { status: 'stopped' },
      platformHealth: health,
    };
  }

  async selectAccount(platformCode, accountId) {
    if (!this.userId) throw new Error('请先登录本系统');
    if (!PLATFORMS[platformCode] || typeof accountId !== 'string') throw new Error('店铺账号参数无效');
    const account = this.#accounts().find((item) => item.platformCode === platformCode && item.accountId === accountId && !item.archived);
    if (!account) throw new Error('店铺账号不存在');
    await this.manager(platformCode).selectAccount(accountId);
    this.activePlatform = platformCode;
    this.activeAccountKey = `${platformCode}:${accountId}`;
    this.#layout();
    this.#publish();
    return this.getState();
  }

  async addAccount(platformCode) {
    const result = await this.manager(platformCode).addAccount();
    const accountId = result?.activeAccountId || result?.accounts?.at(-1)?.id;
    if (accountId) await this.selectAccount(platformCode, accountId);
    return this.getState();
  }

  async callAccount(platformCode, method, accountId, ...args) {
    if (!PLATFORMS[platformCode] || typeof accountId !== 'string') throw new Error('店铺账号参数无效');
    const manager = this.manager(platformCode);
    const account = this.#accounts().find((item) => item.platformCode === platformCode && item.accountId === accountId);
    if (!account) throw new Error('店铺账号不存在');
    const result = await manager[method](accountId, ...args);
    const activeStillExists = this.#accounts().some((item) => item.id === this.activeAccountKey && !item.archived && !item.paused);
    if (!activeStillExists) {
      const fallback = this.#accounts().find((item) => !item.archived && !item.paused);
      if (fallback) {
        await this.selectAccount(fallback.platformCode, fallback.accountId);
      } else {
        this.activePlatform = null;
        this.activeAccountKey = null;
        this.#layout();
      }
    }
    this.#publish();
    return result;
  }

  setPageBounds(bounds) {
    if (!bounds || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) throw new Error('页面区域参数无效');
    this.hostBounds = { x: Math.round(bounds.x || 0), y: Math.round(bounds.y || 0), width: Math.max(1, Math.round(bounds.width)), height: Math.max(1, Math.round(bounds.height)) };
    this.#layout();
    return this.getState();
  }

  setOverlayOpen(open) {
    this.overlayOpen = Boolean(open);
    this.pddManager.setHostVisible(!this.overlayOpen && this.activePlatform === 'pinduoduo');
    this.douyinManager.setHostVisible(!this.overlayOpen && this.activePlatform === 'douyin');
    return this.getState();
  }

  setPlatformFilter(platformCode) {
    if (!['all', 'pinduoduo', 'douyin'].includes(platformCode)) throw new Error('平台筛选参数无效');
    this.platformFilter = platformCode;
    this.#publish();
    return this.getState();
  }

  goBack() { return this.activePlatform ? this.manager(this.activePlatform).goBack() : this.getState(); }
  goForward() { return this.activePlatform ? this.manager(this.activePlatform).goForward() : this.getState(); }
  reload() { return this.activePlatform ? this.manager(this.activePlatform).reload() : this.getState(); }

  #layout() {
    if (!this.window || this.window.isDestroyed()) return;
    const [width, height] = this.window.getContentSize();
    const bounds = this.hostBounds || { x: 320, y: 72, width: Math.max(1, width - 320), height: Math.max(1, height - 72) };
    this.pddManager.setHostLayout(bounds);
    this.douyinManager.setHostLayout(bounds);
    this.pddManager.setHostVisible(!this.overlayOpen && this.activePlatform === 'pinduoduo');
    this.douyinManager.setHostVisible(!this.overlayOpen && this.activePlatform === 'douyin');
  }

  #hideViews() {
    this.pddManager.setHostVisible(false);
    this.douyinManager.setHostVisible(false);
  }

  #publish() {
    if (this.window && !this.window.isDestroyed()) this.window.webContents.send('platform-workspace:state-changed', this.getState());
  }

  async closeForLogout() {
    this.isClosing = true;
    this.#hideViews();
    await Promise.allSettled([this.pddManager.closeForLogout(), this.douyinManager.closeForLogout()]);
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
    clearInterval(this.publishTimer);
    this.publishTimer = null;
    this.userId = null;
    this.activePlatform = null;
    this.activeAccountKey = null;
    this.hostBounds = null;
    this.isClosing = false;
  }

  prepareToQuit() { return this.closeForLogout(); }
}
