import { BrowserWindow, WebContentsView, session, dialog } from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { DOUYIN_LOGIN_URL, DOUYIN_PROBE_SCRIPT, isDouyinUrl } from './page-client.js';
import { configureDouyinSession, guardDouyinNavigation } from './navigation-policy.js';
import { observerScript } from './observer.js';
import { DouyinObservationBuffer } from './observation-buffer.js';
import { mapDouyinMessage, isDouyinLiveReply } from './mapper.js';
import { StoreActor } from '../store-actor.js';
import { senderScript } from './sender.js';
import { DouyinSendJournal } from './send-journal.js';
import { productProbeScript } from './product-probe.js';
import { buildProductProbeReport } from './product-probe-report.js';
import { mapDouyinProducts } from './products.js';
import { buildProductDetailProbeReport } from './product-detail-probe-report.js';
import { mapDouyinProductDetail } from './product-details.js';
import { DouyinOrderProbeController } from './order-probe-controller.js';
import { DouyinTransferProbeController } from './transfer-probe-controller.js';
import { DouyinTransferObservationController } from './transfer-observation-controller.js';
import { DouyinTransferController } from './transfer-controller.js';

export const DOUYIN_PENDING_ALIAS = '待登录抖店';

export class DouyinWorkspaceManager {
  constructor({ registry, rendererPath, preloadPath, devServerUrl = null,
    rendererAdditionalArguments = [], rpaManager = null,
    homeUrl = DOUYIN_LOGIN_URL, loadWorkspaceShell = true, probeIntervalMs = 15000 }) {
    Object.assign(this, { registry, rendererPath, preloadPath, devServerUrl,
      rendererAdditionalArguments, rpaManager, homeUrl, loadWorkspaceShell, probeIntervalMs });
    this.userId = null;
    this.window = null;
    this.hostWindow = false;
    this.hostLayout = null;
    this.hostVisible = true;
    this.activeAccountId = null;
    this.views = new Map();
    this.runtime = new Map();
    this.popups = new Map();
    this.probes = new Map();
    this.generations = new Map();
    this.configuredSessions = new WeakSet();
    this.overlayOpen = false;
    this.opening = null;
    this.closing = null;
    this.timer = null;
    this.observations = new Map();
    this.productProbes = new Map();
    this.productProbeReports = new Map();
    this.productDetailProbeReports = new Map();
    this.orderProbe = new DouyinOrderProbeController(this);
    this.transferProbe = new DouyinTransferProbeController(this);
    this.transferObservation = new DouyinTransferObservationController(this);
    this.transfer = new DouyinTransferController(this);
    this.orderTasks = new Map();
    this.orderQueues = new Map();
    this.detailTasks = new Map();
    this.detailQueues = new Map();
    this.collectors = new Map();
    this.sendActors = new Map();
    this.sendTasks = new Map();
    this.pendingSends = new Map();
    this.sendJournal = null;
    this.rpaWasOnline = false;
    rpaManager?.on('task', (task) => {
      if (task.platform_code === 'douyin') void (task.task_type === 'refresh_product_details'
        ? this.handleProductDetailTask(task) : task.task_type === 'refresh_customer_orders'
          ? this.handleOrderTask(task) : ['douyin_transfer_prepare', 'douyin_transfer_execute'].includes(task.task_type)
            ? this.transfer.handleTask(task) : this.handleSendTask(task)).catch((error) => {
        console.error('抖店任务处理失败:', error.message);
      });
    });
    rpaManager?.on('bindings', (bindings) => {
      if (!this.userId) return;
      for (const binding of bindings) {
        if (binding.platform_code !== 'douyin' || !this.registry.get(this.userId, binding.local_account_id)) continue;
        // Server bindings must not overwrite live page readiness or mismatch state.
        this.registry.bindPlatformAccount(this.userId, binding.local_account_id, binding.platform_account_id);
        if (this.runtime.get(binding.local_account_id)?.imReady) void this.startCollector(binding.local_account_id);
      }
      this.publish();
    });
    rpaManager?.on('state-changed', () => {
      const online = rpaManager.getState().status === 'online';
      if (online && !this.rpaWasOnline && this.userId && !this.closing && this.sendJournal) {
        for (const entry of this.sendJournal.entries()) rpaManager.enqueueEvent(this.sendJournal.event(entry));
      }
      this.rpaWasOnline = online;
      this.publish();
    });
  }

  async bindUser(userId) {
    if (!userId) throw new Error('请先登录本系统');
    if (this.closing) await this.closing;
    if (this.userId && this.userId !== userId) await this.closeForLogout();
    if (this.userId !== userId) {
      this.userId = userId;
      this.sendJournal = new DouyinSendJournal(this.registry.directory, userId);
      for (const account of this.registry.list(userId)) {
        this.registry.update(userId, account.id, { loginStatus: account.paused ? 'paused' : 'unknown' });
      }
    }
  }

  async open(userId) {
    if (this.userId !== userId) throw new Error('请先登录本系统再打开抖店工作区');
    if (this.closing) throw new Error('工作区正在关闭，请稍后重试');
    if (!this.opening) {
      this.opening = this.ensureWindow().finally(() => { this.opening = null; });
    }
    await this.opening;
    if (!this.window || this.userId !== userId || this.closing) return;
    if (this.window.isMinimized()) this.window.restore();
    this.window.show();
    this.window.focus();
    const accounts = this.registry.list(userId).filter((item) => !item.paused)
      .sort((a, b) => (b.lastOpenedAt || '').localeCompare(a.lastOpenedAt || ''));
    for (const account of accounts) this.ensureView(account);
    if (!this.activeAccountId && accounts[0]) this.selectAccount(accounts[0].id);
    if (!this.timer) this.timer = setInterval(() => {
      for (const id of this.views.keys()) void this.probeAccount(id);
    }, this.probeIntervalMs);
    this.timer?.unref();
    this.layout();
    for (const child of this.popups.get(this.activeAccountId) || []) child.show();
    this.syncAccounts();
    this.publish();
  }

  attachHostWindow(window) {
    if (!window || window.isDestroyed()) throw new Error('聚合工作台宿主窗口无效');
    if (this.window && this.window !== window && !this.window.isDestroyed()) {
      if (this.hostWindow) throw new Error('抖店工作区已经绑定到其它窗口');
      const previousWindow = this.window;
      for (const view of this.views.values()) {
        try {
          previousWindow.contentView.removeChildView(view);
        } catch {
          // The standalone workspace may already be closing.
        }
      }
      previousWindow.hide();
    }
    this.window = window;
    this.hostWindow = true;
    this.hostVisible = false;
    for (const view of this.views.values()) this.window.contentView.addChildView(view);
    this.layout();
  }

  detachHostWindow() {
    if (!this.hostWindow) return;
    this.hostWindow = false;
    this.hostLayout = null;
    this.hostVisible = true;
    this.window = null;
  }

  setHostLayout(bounds) {
    this.hostLayout = bounds && Number.isFinite(bounds.width) && Number.isFinite(bounds.height)
      ? { x: Math.round(bounds.x || 0), y: Math.round(bounds.y || 0), width: Math.max(1, Math.round(bounds.width)), height: Math.max(1, Math.round(bounds.height)) }
      : null;
    this.layout();
  }

  setHostVisible(visible) {
    this.hostVisible = Boolean(visible);
    this.layout();
  }

  async ensureWindow() {
    if (this.window && !this.window.isDestroyed()) return;
    const window = new BrowserWindow({
      width: 1320, height: 860, minWidth: 960, minHeight: 640,
      title: '抖店原平台工作区 - AI智能客服', show: false, autoHideMenuBar: true,
      backgroundColor: '#f8fafc',
      webPreferences: { preload: this.preloadPath, contextIsolation: true,
        nodeIntegration: false, sandbox: true, additionalArguments: this.rendererAdditionalArguments },
    });
    this.window = window;
    window.on('resize', () => this.layout());
    window.on('close', (event) => {
      if (!this.closing) {
        event.preventDefault();
        window.hide();
        for (const children of this.popups.values()) for (const child of children) child.hide();
      }
    });
    window.on('closed', () => { if (this.window === window) this.window = null; });
    try {
      if (this.loadWorkspaceShell) {
        if (this.devServerUrl) {
          const url = new URL(this.devServerUrl);
          url.searchParams.set('view', 'douyin-workspace');
          await window.loadURL(url.toString());
        } else await window.loadFile(this.rendererPath, { query: { view: 'douyin-workspace' } });
      }
    } catch (error) {
      window.destroy();
      throw error;
    }
  }

  account(accountId, { archived = false } = {}) {
    if (!this.userId || this.closing) throw new Error('请先打开工作区');
    const account = this.registry.get(this.userId, accountId);
    if (!account || Boolean(account.archivedAt) !== archived) throw new Error('店铺账号不存在');
    return account;
  }

  getState() {
    const project = (account) => ({ ...account,
      runtimeStatus: account.paused ? 'paused' : 'idle',
      collectionStatus: account.paused ? 'paused' : 'idle', lastCollectedAt: null,
      statusDetail: account.paused ? '已暂停' : '待打开店铺页面', imReady: false,
      ...this.runtime.get(account.id),
    });
    const contents = this.views.get(this.activeAccountId)?.webContents;
    return {
      accounts: this.userId ? this.registry.list(this.userId).map(project) : [],
      archivedAccounts: this.userId ? this.registry.list(this.userId, { archived: true }).map(project) : [],
      activeAccountId: this.activeAccountId,
      navigation: contents && !contents.isDestroyed() ? {
        canGoBack: contents.navigationHistory.canGoBack(), canGoForward: contents.navigationHistory.canGoForward(),
        isLoading: contents.isLoading(),
      } : {}, rpa: this.rpaManager?.getState() || { status: 'stopped' },
    };
  }

  publish() {
    if (this.window && !this.window.isDestroyed()) this.window.webContents.send('douyin-workspace:state-changed', this.getState());
  }

  syncAccounts() {
    if (!this.userId) return;
    this.rpaManager?.setPlatformAccounts('douyin', [
      ...this.registry.list(this.userId), ...this.registry.list(this.userId, { archived: true }),
    ].map((account) => ({ ...account, metadataJson: {
      workspace_only: false, message_receive_enabled: true, message_send_enabled: true,
      ai_text_reply_enabled: true,
      im_ready: this.runtime.get(account.id)?.imReady === true,
    } })));
  }

  patch(accountId, values) {
    this.runtime.set(accountId, { ...this.runtime.get(accountId), ...values });
    this.publish();
  }

  addAccount() {
    if (!this.userId || !this.window || this.closing) throw new Error('请先打开抖店工作区');
    const account = this.registry.create(this.userId, DOUYIN_PENDING_ALIAS);
    this.selectAccount(account.id);
    this.syncAccounts();
    return this.getState();
  }

  selectAccount(accountId) {
    const account = this.account(accountId);
    if (account.paused) throw new Error('请先恢复店铺运行');
    this.ensureView(account);
    this.activeAccountId = accountId;
    this.registry.update(this.userId, accountId, { lastOpenedAt: new Date().toISOString() });
    this.layout();
    for (const child of this.popups.get(accountId) || []) child.show();
    this.publish();
    return this.getState();
  }

  ensureView(account) {
    if (this.views.has(account.id)) return this.views.get(account.id);
    if (!this.window) throw new Error('工作区窗口尚未打开');
    const view = new WebContentsView({ webPreferences: {
      partition: account.partition, contextIsolation: true, nodeIntegration: false,
      sandbox: true, spellcheck: false,
    } });
    this.views.set(account.id, view);
    this.generations.set(account.id, (this.generations.get(account.id) || 0) + 1);
    this.popups.set(account.id, new Set());
    this.window.contentView.addChildView(view);
    view.setVisible(false);
    view.webContents.setBackgroundThrottling(false);
    if (!this.configuredSessions.has(view.webContents.session)) {
      configureDouyinSession(view.webContents.session);
      this.configuredSessions.add(view.webContents.session);
    }
    this.bindContents(account, view.webContents);
    this.patch(account.id, { runtimeStatus: 'loading', statusDetail: '正在加载抖店页面', imReady: false });
    const url = isDouyinUrl(account.lastUrl) ? account.lastUrl : this.homeUrl;
    void view.webContents.loadURL(url).catch(() => {
      if (this.views.get(account.id) === view) this.patch(account.id, { runtimeStatus: 'error', statusDetail: '页面加载失败，请刷新重试' });
    });
    return view;
  }

  bindContents(account, contents) {
    guardDouyinNavigation(contents);
    const current = () => this.userId === account.userId && !this.closing && (
      this.views.get(account.id)?.webContents === contents
      || [...(this.popups.get(account.id) || [])].some((child) => !child.isDestroyed() && child.webContents === contents)
    );
    contents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (!current() || isInPlace) return;
      this.cancelProductProbe(account.id);
      this.orderProbe.clear(account.id);
      this.transferProbe.clear(account.id);
      this.transferObservation.clear(account.id);
      void this.stopObservation(account.id);
      void this.stopCollector(account.id);
      this.generations.set(account.id, (this.generations.get(account.id) || 0) + 1);
      if (!isMainFrame) return;
      this.registry.update(this.userId, account.id, { loginStatus: 'unknown' });
      this.patch(account.id, { runtimeStatus: 'loading', imReady: false, statusDetail: '正在加载抖店页面' });
    });
    contents.on('did-navigate', (_event, url) => {
      if (!current()) return;
      if (contents === this.views.get(account.id)?.webContents && isDouyinUrl(url)) {
        // Persist only the page route, never SSO tickets or query credentials.
        const route = new URL(url);
        route.search = '';
        route.hash = '';
        this.registry.update(this.userId, account.id, { lastUrl: route.toString() });
      }
    });
    contents.on('did-frame-finish-load', () => { if (current()) void this.probeAccount(account.id); });
    contents.on('did-stop-loading', () => {
      if (!current()) return;
      if (this.runtime.get(account.id)?.runtimeStatus !== 'error') this.patch(account.id, { runtimeStatus: 'ready' });
      void this.probeAccount(account.id);
    });
    contents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
      if (!current() || !isMainFrame || code === -3) return;
      this.patch(account.id, { runtimeStatus: 'error', imReady: false, statusDetail: '页面加载失败，请刷新重试' });
    });
    contents.on('render-process-gone', () => {
      if (current()) {
        this.registry.update(this.userId, account.id, { loginStatus: 'error' });
        this.patch(account.id, { runtimeStatus: 'error', imReady: false, statusDetail: '页面进程已退出，请刷新重试' });
        this.syncAccounts();
      }
    });
    contents.setWindowOpenHandler(({ url, referrer, postBody }) => {
      // target=_blank/window.open should navigate this shop's existing view.
      // Preserve request context for platform links and form redirects.
      if (!current() || !/^https:\/\//i.test(url)) return { action: 'deny' };
      const options = { ...(referrer ? { httpReferrer: referrer } : {}) };
      if (postBody) {
        options.postData = postBody.data;
        options.extraHeaders = `Content-Type: ${postBody.contentType}${postBody.boundary ? `; boundary=${postBody.boundary}` : ''}`;
      }
      setImmediate(() => {
        if (!current() || contents.isDestroyed()) return;
        void contents.loadURL(url, options).catch((error) => {
          if (!current() || error.code === 'ERR_ABORTED') return;
          this.patch(account.id, { runtimeStatus: 'error', imReady: false, statusDetail: '页面跳转失败，请重试' });
        });
      });
      return { action: 'deny' };
    });
    contents.on('did-create-window', (child) => {
      if (!current()) { child.destroy(); return; }
      this.popups.get(account.id).add(child);
      child.on('closed', () => { this.popups.get(account.id)?.delete(child); });
      this.bindContents(account, child.webContents);
    });
  }

  async probeAccount(accountId) {
    if (this.probes.has(accountId)) return this.probes.get(accountId);
    const view = this.views.get(accountId);
    const userId = this.userId;
    const generation = this.generations.get(accountId);
    if (!view || this.closing) return null;
    const operation = (async () => {
      const contentsList = [view.webContents, ...[...(this.popups.get(accountId) || [])]
        .filter((child) => !child.isDestroyed()).map((child) => child.webContents)];
      const results = [];
      for (const contents of contentsList) {
        if (contents.isDestroyed()) continue;
        let frames;
        try { frames = contents.mainFrame.framesInSubtree; }
        catch { continue; }
        for (const frame of frames) {
          try {
            if (!isDouyinUrl(frame.url)) continue;
            const result = await frame.executeJavaScript(DOUYIN_PROBE_SCRIPT);
            if (!contents.isDestroyed() && !frame.detached) results.push(result);
          } catch { /* Navigation can destroy a frame while the read is pending. */ }
        }
      }
      if (this.userId !== userId || this.views.get(accountId) !== view || this.closing
        || this.generations.get(accountId) !== generation) return null;
      const identified = results.filter((result) => result?.state === 'identified');
      const identity = identified.find((result) => result.imReady) || identified[0];
      if (new Set(identified.map((result) => result.shopId)).size > 1) {
        return this.applyProbe(accountId, { state: 'mismatch' });
      }
      return this.applyProbe(accountId, identity || results.find((result) => result?.state === 'login_required')
        || results.find((result) => result?.state === 'error')
        || results.find((result) => result?.state === 'backend') || { state: 'waiting', imReady: false });
    })();
    this.probes.set(accountId, operation);
    try { return await operation; }
    catch {
      if (this.userId === userId && this.views.get(accountId) === view && !this.closing) {
        this.patch(accountId, { imReady: false, statusDetail: '页面状态检查暂时失败，请刷新重试' });
      }
      return null;
    }
    finally { if (this.probes.get(accountId) === operation) this.probes.delete(accountId); }
  }

  applyProbe(accountId, result) {
    const account = this.account(accountId);
    let loginStatus = 'unknown';
    let detail = '请登录并进入抖店客服工作台';
    let imReady = false;
    if (result.state === 'identified') {
      const duplicate = this.registry.list(this.userId).find((item) => item.id !== accountId
        && !item.paused && item.externalAccountId === result.shopId);
      if ((account.externalAccountId && account.externalAccountId !== result.shopId) || duplicate) {
        loginStatus = 'account_mismatch';
        detail = duplicate ? '此店铺已在另一标签登录，请暂停或移除重复标签' : '登录店铺与绑定店铺不匹配，请登录原店铺或添加新店铺';
      } else {
        loginStatus = 'online';
        imReady = result.imReady === true;
        detail = imReady ? '消息接收与人工文本发送已启用' : '已登录 · 等待进入客服工作台';
        this.registry.update(this.userId, accountId, {
          externalAccountId: result.shopId, platformAccountName: result.shopName || null,
          platformAccountLogoUrl: /^https:\/\//i.test(result.logoUrl || '') ? result.logoUrl : null,
          platformAccountCsId: result.staffId || null, platformAccountServiceUsername: result.staffName || null,
          ...(account.alias === DOUYIN_PENDING_ALIAS && result.shopName ? { alias: result.shopName } : {}),
        });
      }
    } else if (result.state === 'login_required') {
      loginStatus = 'login_required'; detail = '请在原平台页面完成登录';
    } else if (result.state === 'backend') {
      detail = '当前为商家后台，请点击平台右上角耳机按钮进入客服工作台';

    } else if (result.state === 'mismatch') {
      loginStatus = 'account_mismatch'; detail = '不同页面返回了不同店铺身份，请重新登录';
    } else if (result.state === 'error') {
      loginStatus = 'error'; detail = result.detail;
    }
    this.registry.update(this.userId, accountId, { loginStatus });
    if (!imReady) {
      void this.stopObservation(accountId);
      void this.stopCollector(accountId);
    }
    const observation = this.observations.get(accountId);
    this.patch(accountId, { statusDetail: observation?.active
      ? `只读观察中 · 已采集 ${observation.buffer.records.length} 条样本` : detail, imReady,
      collectionStatus: this.collectors.get(accountId)?.active ? 'watching' : 'idle' });
    if (imReady && loginStatus === 'online') void this.startCollector(accountId);
    this.syncAccounts();
    return { ...result, loginStatus };
  }

  async detectAccountName(accountId) {
    const account = this.account(accountId);
    if (account.paused) throw new Error('请先恢复店铺运行');
    const result = await this.probeAccount(accountId);
    if (result?.loginStatus !== 'online' || !result.shopName) throw new Error('请先登录并进入抖店客服工作台后重试');
    return { accountName: result.shopName, source: 'douyin_currentuser' };
  }

  renameAccount(accountId, alias) {
    this.account(accountId);
    this.registry.update(this.userId, accountId, { alias });
    this.syncAccounts(); this.publish(); return this.getState();
  }

  async disposeView(accountId) {
    this.cancelProductProbe(accountId);
    this.orderProbe.clear(accountId);
    this.transferProbe.clear(accountId);
    this.transferObservation.clear(accountId);
    this.sendActors.get(accountId)?.cancel('店铺页面已关闭，已提交消息请核对发送状态');
    this.sendActors.delete(accountId);
    await this.stopObservation(accountId);
    await this.stopCollector(accountId);
    const view = this.views.get(accountId);
    this.views.delete(accountId);
    this.generations.set(accountId, (this.generations.get(accountId) || 0) + 1);
    this.probes.delete(accountId);
    for (const child of this.popups.get(accountId) || []) child.destroy();
    this.popups.delete(accountId);
    if (!view || view.webContents.isDestroyed()) return;
    const accountSession = view.webContents.session;
    this.window?.contentView.removeChildView(view);
    view.webContents.close();
    await accountSession.cookies.flushStore();
    accountSession.flushStorageData();
  }

  async setAccountPaused(accountId, paused) {
    const account = this.account(accountId);
    this.registry.update(this.userId, accountId, { paused, loginStatus: paused ? 'paused' : 'unknown' });
    if (paused) {
      await this.disposeView(accountId);
      if (this.userId !== account.userId || this.closing) return this.getState();
      this.runtime.delete(accountId);
      if (this.activeAccountId === accountId) this.activeAccountId = null;
      this.selectFallback();
    } else this.selectAccount(accountId);
    this.syncAccounts(); this.publish(); return this.getState();
  }

  selectFallback() {
    const next = this.registry.list(this.userId).find((account) => !account.paused);
    if (!this.activeAccountId && next) this.selectAccount(next.id);
    this.layout();
  }

  async removeAccount(accountId, clearStorage) {
    const account = this.account(accountId);
    await this.disposeView(accountId);
    this.observations.delete(accountId);
    if (this.userId !== account.userId || this.closing) return this.getState();
    if (clearStorage) {
      const accountSession = session.fromPartition(account.partition);
      await accountSession.clearStorageData();
      await accountSession.clearCache();
      if (this.userId !== account.userId || this.closing) return this.getState();
      this.registry.remove(this.userId, accountId);
    } else this.registry.update(this.userId, accountId, { archivedAt: new Date().toISOString(), paused: true, loginStatus: 'paused' });
    this.runtime.delete(accountId);
    if (this.activeAccountId === accountId) this.activeAccountId = null;
    this.selectFallback(); this.syncAccounts(); this.publish(); return this.getState();
  }

  restoreAccount(accountId) {
    this.account(accountId, { archived: true });
    this.registry.update(this.userId, accountId, { archivedAt: null, paused: false, loginStatus: 'unknown' });
    this.selectAccount(accountId); this.syncAccounts(); return this.getState();
  }

  setOverlayOpen(open) { this.overlayOpen = open; this.layout(); return this.getState(); }
  layout() {
    if (!this.window || this.window.isDestroyed()) return;
    const [width, height] = this.window.getContentSize();
    for (const [id, view] of this.views) {
      view.setBounds(this.hostLayout || { x: 0, y: 72, width, height: Math.max(0, height - 72) });
      view.setVisible(id === this.activeAccountId && !this.overlayOpen && this.hostVisible);
    }
  }
  navigate(action) {
    const contents = this.views.get(this.activeAccountId)?.webContents;
    if (contents && !contents.isDestroyed()) {
      if (action === 'reload') contents.reload();
      else if (action === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
      else if (action === 'forward' && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
    }
    return this.getState();
  }
  goBack() { return this.navigate('back'); }
  goForward() { return this.navigate('forward'); }
  reload() { return this.navigate('reload'); }

  async startObservation(accountId) {
    const account = this.account(accountId);
    const view = this.views.get(accountId);
    const generation = this.generations.get(accountId);
    if (this.observations.get(accountId)?.active) return this.getState();
    if (account.paused) throw new Error('请先恢复店铺运行');
    await this.probeAccount(accountId);
    if (this.account(accountId).loginStatus !== 'online' || !this.runtime.get(accountId)?.imReady) {
      throw new Error('请先进入飞鸽客服接待页面');
    }
    await this.stopObservation(accountId);
    await this.stopCollector(accountId);
    if (this.userId !== account.userId || this.closing || !view || this.views.get(accountId) !== view
      || this.generations.get(accountId) !== generation || this.account(accountId).paused) {
      throw new Error('店铺页面已变化，请重新开始观察');
    }
    const observation = { token: randomUUID(), buffer: new DouyinObservationBuffer(), active: true,
      frames: new Set(), busy: false, expiresAt: Date.now() + 10 * 60 * 1000, timer: null };
    this.observations.set(accountId, observation);
    observation.timer = setInterval(() => { void this.pollObservation(accountId); }, 2000);
    observation.timer.unref();
    await this.pollObservation(accountId);
    return this.getState();
  }

  async pollObservation(accountId) {
    const observation = this.observations.get(accountId);
    if (!observation?.active || observation.busy) return;
    if (Date.now() >= observation.expiresAt) { await this.stopObservation(accountId); return; }
    observation.busy = true;
    const view = this.views.get(accountId);
    const generation = this.generations.get(accountId);
    const valid = () => observation.active && this.observations.get(accountId) === observation
      && !this.closing && this.views.get(accountId) === view && this.generations.get(accountId) === generation
      && this.registry.get(this.userId, accountId)?.loginStatus === 'online' && this.runtime.get(accountId)?.imReady;
    try {
      if (!view || !valid()) return;
      let frames;
      try { frames = view.webContents.mainFrame.framesInSubtree; } catch { return; }
      for (const frame of frames) {
        if (!valid() || !/^https:\/\/(im|pigeon)\.jinritemai\.com\//.test(frame.url)) continue;
        if (!observation.frames.has(frame)) {
          const identity = await frame.executeJavaScript(DOUYIN_PROBE_SCRIPT);
          if (!valid() || !identity?.imReady || identity.shopId !== this.account(accountId).externalAccountId) continue;
          observation.frames.add(frame);
        }
        const batch = await frame.executeJavaScript(observerScript({ action: 'poll', token: observation.token }));
        if (valid() && !frame.detached) observation.buffer.ingest(batch, frame.url);
      }
      if (valid()) this.patch(accountId, { observationActive: true, observationCount: observation.buffer.records.length,
        statusDetail: `只读观察中 · 已采集 ${observation.buffer.records.length} 条样本` });
    } catch {
      if (valid()) this.patch(accountId, { statusDetail: '消息观察暂不可用，等待客服页面恢复' });
    } finally { observation.busy = false; }
  }

  async stopObservation(accountId) {
    const observation = this.observations.get(accountId);
    if (!observation?.active) return;
    observation.active = false;
    clearInterval(observation.timer);
    for (const frame of observation.frames) {
      try {
        if (!frame.detached) {
          const url = frame.url;
          const batch = await frame.executeJavaScript(observerScript({ action: 'stop', token: observation.token }));
          observation.buffer.ingest(batch, url);
        }
      } catch { /* frame gone */ }
    }
    observation.frames.clear();
    if (this.runtime.has(accountId)) this.patch(accountId, { observationActive: false,
      statusDetail: `观察已停止 · ${observation.buffer.records.length} 条样本可导出` });
  }

  async startCollector(accountId) {
    const account = this.account(accountId);
    if (account.paused || !account.platformAccountId || account.loginStatus !== 'online' || !this.runtime.get(accountId)?.imReady) return;
    if (this.collectors.get(accountId)?.active || this.observations.get(accountId)?.active) return;
    const collector = { token: randomUUID(), active: true, frames: new Set(), busy: false,
      emitted: new Set(), timer: null, startedAt: new Date().toISOString() };
    this.collectors.set(accountId, collector);
    collector.timer = setInterval(() => { void this.pollCollector(accountId); }, 1200);
    collector.timer.unref();
    this.patch(accountId, { collectionStatus: 'watching', lastCollectedAt: null,
      statusDetail: '消息接收与人工文本发送已启用' });
    await this.pollCollector(accountId);
  }

  async pollCollector(accountId) {
    const collector = this.collectors.get(accountId);
    if (!collector?.active || collector.busy) return;
    collector.busy = true;
    const view = this.views.get(accountId);
    const generation = this.generations.get(accountId);
    const valid = () => collector.active && this.collectors.get(accountId) === collector && !this.closing
      && this.views.get(accountId) === view && this.generations.get(accountId) === generation
      && this.registry.get(this.userId, accountId)?.loginStatus === 'online'
      && this.runtime.get(accountId)?.imReady;
    try {
      if (!view || !valid()) return;
      let frames;
      try { frames = view.webContents.mainFrame.framesInSubtree; } catch { return; }
      for (const frame of frames) {
        if (!valid() || !/^https:\/\/(im|pigeon)\.jinritemai\.com\//.test(frame.url)) continue;
        if (!collector.frames.has(frame)) {
          const identity = await frame.executeJavaScript(DOUYIN_PROBE_SCRIPT);
          if (!valid() || !identity?.imReady || identity.shopId !== this.account(accountId).externalAccountId) continue;
          collector.frames.add(frame);
        }
        const batch = await frame.executeJavaScript(observerScript({ action: 'poll', token: collector.token, mode: 'collector' }));
        if (valid() && !frame.detached) this.consumeCollectorBatch(accountId, batch, frame.url, collector);
      }
    } catch { /* page can be replaced while an IPC read is in flight */ }
    finally { collector.busy = false; }
  }

  consumeCollectorBatch(accountId, batch, frameUrl, collector) {
    if (!batch || !Array.isArray(batch.records)) return;
    const account = this.registry.get(this.userId, accountId);
    const platformAccountId = account?.platformAccountId || null;
    if (!account || !platformAccountId) return;
    for (const record of batch.records) {
      if (record?.kind === 'message' && Array.isArray(record.value)) {
        for (const message of record.value) this.enqueueDouyinMessage(accountId, platformAccountId, message, frameUrl, collector);
      }
      if (record?.kind === 'compensation_conversation' && record.value && typeof record.value === 'object') {
        const list = Array.isArray(record.value.msgList) ? record.value.msgList : [];
        for (const item of list) {
          const message = item?.messageBody || item;
          const ext = message?.ext && typeof message.ext === 'object' ? message.ext : {};
          // Compensation is intentionally limited to the platform's attention Buyer rows.
          if (ext['s:sender_biz_role'] === 'Buyer' && ext.attention === 'true') {
            this.enqueueDouyinMessage(accountId, platformAccountId, message, frameUrl, collector, 'compensation');
          }
        }
      }
    }
  }

  enqueueDouyinMessage(accountId, platformAccountId, rawMessage, frameUrl, collector, source = 'live') {
    const account = this.registry.get(this.userId, accountId);
    if (!account || account.paused || account.loginStatus !== 'online' || !this.rpaManager?.enqueueEvent) return;
    const message = mapDouyinMessage(rawMessage, account.externalAccountId, source);
    if (!message) return;
    this.orderProbe.observe(account, message, rawMessage);
    const { conversationId, platformMessageId, senderRole, content, messageType } = message;
    const dedupKey = `douyin:${platformAccountId}:${conversationId}:${platformMessageId}`;
    if (collector.emitted.has(dedupKey)) return;
    const observedAt = new Date().toISOString();
    const event = {
      // A fresh envelope may carry a later observation time; queue IDs cannot be reused with different payloads.
      event_id: `douyin_${randomUUID()}`, dedup_key: dedupKey,
      event_type: senderRole === 'customer' ? 'customer_message' : 'agent_message', platform_code: 'douyin',
      platform_account_id: platformAccountId, platform_message_id: platformMessageId,
      conversation_external_id: conversationId, received_at: observedAt,
      payload_json: {
        ...(message.customerName ? { customer_name: message.customerName, title: message.customerName } : {}),
        content, sender_role: senderRole, message_type: messageType, display_mode: message.displayMode,
        automation_mode: isDouyinLiveReply(message, collector.startedAt, observedAt) ? 'trigger' : 'ignore',
        collector_started_at: collector.startedAt, observed_at: observedAt,
        platform_message_id: platformMessageId, platform_sent_at: message.platformSentAt,
        structured_payload: message.structuredPayload,
        conversation_metadata: { local_account_id: accountId, frame_origin: new URL(frameUrl).origin,
          security_conversation_id: conversationId, history_scope: 'live_and_limited_compensation' },
      },
    };
    this.rpaManager.enqueueEvent(event);
    collector.emitted.add(dedupKey);
    if (collector.emitted.size > 10000) collector.emitted.delete(collector.emitted.values().next().value);
    this.patch(accountId, { collectionStatus: 'watching', lastCollectedAt: observedAt });
  }

  async stopCollector(accountId) {
    const collector = this.collectors.get(accountId);
    if (!collector?.active) return;
    collector.active = false;
    clearInterval(collector.timer);
    for (const frame of collector.frames) {
      try {
        if (!frame.detached) {
          const url = frame.url;
          const batch = await frame.executeJavaScript(observerScript({ action: 'stop', token: collector.token }));
          this.consumeCollectorBatch(accountId, batch, url, collector);
        }
      } catch { /* frame gone */ }
    }
    collector.frames.clear();
    if (this.collectors.get(accountId) === collector) this.collectors.delete(accountId);
  }

  async exportObservation(accountId) {
    this.account(accountId);
    await this.pollObservation(accountId);
    const observation = this.observations.get(accountId);
    if (!observation?.buffer.records.length) throw new Error('暂无样本，请先开始消息观察');
    const userId = this.userId;
    const result = await dialog.showSaveDialog(this.window, { title: '导出抖店脱敏样本',
      defaultPath: `douyin-observation-${Date.now()}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (result.canceled || !result.filePath) return;
    if (this.userId !== userId || this.closing || this.observations.get(accountId) !== observation) return;
    await fs.writeFile(result.filePath, JSON.stringify(observation.buffer.export(), null, 2), 'utf8');
  }

  cancelProductProbe(accountId) {
    const probe = this.productProbes.get(accountId);
    this.productProbes.delete(accountId);
    this.productProbeReports.delete(accountId);
    this.productDetailProbeReports.delete(accountId);
    if (probe?.frame && !probe.frame.detached) {
      void probe.frame.executeJavaScript(productProbeScript({ action: 'cancel', token: probe.token })).catch(() => {});
    }
  }

  async probeProducts(accountId, { collect = false, productId } = {}) {
    if (productId !== undefined && (typeof productId !== 'string' || !/^\d{1,40}$/.test(productId)))
      throw new Error('商品详情探测参数无效');
    const account = this.account(accountId);
    const userId = this.userId;
    const view = this.views.get(accountId);
    const generation = this.generations.get(accountId);
    if (this.productProbes.has(accountId)) throw new Error('该店铺商品探测正在运行，请稍候');
    const valid = () => {
      const current = this.registry.get(userId, accountId);
      return this.userId === userId && !this.closing && current && !current.paused && !current.archivedAt
        && current.loginStatus === 'online' && current.externalAccountId === account.externalAccountId
        && current.platformAccountId === account.platformAccountId
        && this.runtime.get(accountId)?.imReady && view && !view.webContents.isDestroyed()
        && this.views.get(accountId) === view && this.generations.get(accountId) === generation;
    };
    if (!valid()) throw new Error('请先打开并登录该店铺的飞鸽客服接待页面');
    const probe = { token: randomUUID(), frame: null };
    this.productProbes.set(accountId, probe);
    const reports = productId ? this.productDetailProbeReports : this.productProbeReports;
    reports.delete(accountId);
    try {
      const frames = view.webContents.mainFrame.framesInSubtree.filter((frame) =>
        /^https:\/\/(im|pigeon)\.jinritemai\.com\//.test(frame.url))
        .sort((a, b) => Number(b.url.startsWith('https://pigeon.')) - Number(a.url.startsWith('https://pigeon.'))).slice(0, 4);
      for (const frame of frames) {
        if (!valid() || this.productProbes.get(accountId) !== probe) throw new Error('店铺页面已变化，请重新探测');
        probe.frame = frame;
        const frameOrigin = new URL(frame.url).origin;
        let timer;
        let result;
        try {
          result = await Promise.race([
            frame.executeJavaScript(productProbeScript({ action: 'read', token: probe.token, shopId: account.externalAccountId, productId })),
            new Promise((resolve) => { timer = setTimeout(() => resolve({ error: 'cancelled_or_timeout' }), productId ? 23000 : 15000); }),
          ]);
        } catch { result = { error: 'execution_error' }; }
        finally { clearTimeout(timer); }
        if (!valid() || this.productProbes.get(accountId) !== probe || frame.detached
          || new URL(frame.url).origin !== frameOrigin) throw new Error('店铺页面已变化，探测结果已丢弃');
        if (result?.error === 'im_not_ready') continue;
        if (result?.error === 'identity_mismatch') throw new Error('店铺身份已变化，探测结果已丢弃');
        if (collect) return productId ? mapDouyinProductDetail(result, {
          frameOrigin, productId, shopId: account.externalAccountId, requestToken: probe.token,
        }) : mapDouyinProducts(result);
        const output = productId ? buildProductDetailProbeReport(result, { frameOrigin, productId, shopId: account.externalAccountId, requestToken: probe.token })
          : buildProductProbeReport(result, { frameOrigin });
        reports.set(accountId, { userId, shopId: account.externalAccountId, report: output.report });
        return output;
      }
      throw new Error('未找到已就绪的飞鸽客服页面');
    } finally {
      if (this.productProbes.get(accountId) === probe) this.productProbes.delete(accountId);
      if (probe.frame && !probe.frame.detached) {
        void probe.frame.executeJavaScript(productProbeScript({ action: 'cancel', token: probe.token })).catch(() => {});
      }
    }
  }

  async showProductProbe(accountId) {
    const output = await this.probeProducts(accountId);
    const sample = this.productProbeReports.get(accountId);
    if (!sample || sample.userId !== this.userId || this.closing) return;
    const result = await dialog.showMessageBox(this.window, {
      type: output.report.error ? 'warning' : 'info', title: `抖店商品列表探测 · ${this.account(accountId).alias}`, message: output.summary,
      detail: [`HTTP：${output.report.httpStatus ?? '未取得'}；业务码：${output.report.code ?? '未取得'}`,
        ...output.preview, '请与原平台商品列表核对。此次结果未写入商品库；导出文件不包含上述标题和商品 ID 原文。'].join('\n\n'),
      buttons: ['导出脱敏样本', '关闭'], defaultId: 0, cancelId: 1,
    });
    if (result.response === 0 && this.productProbeReports.get(accountId) === sample) await this.exportProductProbe(accountId);
  }

  async refreshStoreProducts({ platformAccountId }) {
    if (!this.userId || this.closing || !this.rpaManager) throw new Error('请先登录本系统');
    const userId = this.userId;
    const account = this.registry.list(userId).find((item) => item.platformAccountId === platformAccountId);
    if (!account) throw new Error('未找到本机绑定的抖店，请先打开原平台工作区');
    const generation = this.generations.get(account.id);
    const observedAt = new Date().toISOString();
    const result = await this.probeProducts(account.id, { collect: true });
    const current = this.registry.get(userId, account.id);
    if (this.userId !== userId || this.closing || !current || current.paused || current.archivedAt
      || current.platformAccountId !== platformAccountId || current.externalAccountId !== account.externalAccountId
      || this.generations.get(account.id) !== generation) throw new Error('店铺状态已变化，商品结果已丢弃');
    const eventId = `douyin_products_${randomUUID()}`;
    this.rpaManager.enqueueEvent({ event_id: eventId, dedup_key: eventId,
      event_type: 'store_products_snapshot', platform_code: 'douyin', platform_account_id: platformAccountId,
      received_at: observedAt, payload_json: { ...result, source: 'douyin_products_v1',
        shop_id: account.externalAccountId, observed_at: observedAt } });
    return { status: 'collected', observed_at: observedAt };
  }

  handleOrderTask(task) {
    if (task.user_id !== this.userId || this.closing) return Promise.resolve();
    if (this.orderTasks.has(task.id)) return this.orderTasks.get(task.id);
    const userId = this.userId;
    const account = this.registry.list(userId).find((item) => item.platformAccountId === task.platform_account_id);
    const generation = account && this.generations.get(account.id);
    const valid = () => account && this.userId === userId && !this.closing
      && this.generations.get(account.id) === generation
      && this.registry.get(userId, account.id)?.externalAccountId === account.externalAccountId
      && this.registry.get(userId, account.id)?.platformAccountId === task.platform_account_id;
    const run = async () => {
      try {
        const payload = task.payload_json;
        if (!valid() || payload?.platform_account_id !== task.platform_account_id
          || payload?.source !== 'douyin_orders_v1' || payload?.shop_id !== account.externalAccountId
          || typeof payload?.external_conversation_id !== 'string') throw new Error('无效的订单读取任务');
        const snapshot = await this.orderProbe.show({ platformAccountId: task.platform_account_id,
          externalConversationId: payload.external_conversation_id, requestId: `task-${task.id}` }, undefined, { collect: true });
        if (!valid()) throw new Error('店铺页面已变化');
        this.rpaManager.completeTask(task.id, 'completed', { orders_snapshot: snapshot });
      } catch {
        if (this.userId === userId && !this.closing)
          this.rpaManager.completeTask(task.id, 'failed', {}, '订单读取失败，请确认飞鸽已登录且已采集到该客户消息；可使用订单探测检查');
      }
    };
    // Per-shop reads share a queue, independent of the text send actor.
    const key = `${userId}:${task.platform_account_id}`;
    const operation = (this.orderQueues.get(key) || Promise.resolve()).then(run);
    this.orderQueues.set(key, operation);
    this.orderTasks.set(task.id, operation);
    void operation.finally(() => {
      this.orderTasks.delete(task.id);
      if (this.orderQueues.get(key) === operation) this.orderQueues.delete(key);
    });
    return operation;
  }

  handleProductDetailTask(task) {
    if (task.user_id !== this.userId || this.closing) return Promise.resolve();
    if (this.detailTasks.has(task.id)) return this.detailTasks.get(task.id);
    const userId = this.userId;
    const account = this.registry.list(userId).find((item) => item.platformAccountId === task.platform_account_id);
    const generation = account && this.generations.get(account.id);
    const valid = () => account && this.userId === userId && !this.closing
      && this.generations.get(account.id) === generation
      && this.registry.get(userId, account.id)?.externalAccountId === account.externalAccountId
      && this.registry.get(userId, account.id)?.platformAccountId === task.platform_account_id;
    const run = async () => {
      try {
        const ids = task.payload_json?.product_ids;
        if (!valid() || task.payload_json?.platform_account_id !== task.platform_account_id
          || !Array.isArray(ids) || ids.length !== 1 || !/^\d{1,40}$/.test(ids[0]))
          throw new Error('无效的商品详情任务');
        const detail = await this.probeProducts(account.id, { collect: true, productId: ids[0] });
        if (!valid()) throw new Error('店铺状态已变化，详情已丢弃');
        this.rpaManager.completeTask(task.id, 'completed', { product_details: [detail] });
      } catch {
        if (this.userId === userId && !this.closing)
          this.rpaManager.completeTask(task.id, 'failed', {}, '商品详情采集失败或店铺页面未就绪');
      }
    };
    // Details have their own queue and never delay the store's text send actor.
    const key = `${userId}:${task.platform_account_id}`;
    const operation = (this.detailQueues.get(key) || Promise.resolve()).then(run);
    this.detailQueues.set(key, operation);
    this.detailTasks.set(task.id, operation);
    void operation.finally(() => {
      this.detailTasks.delete(task.id);
      if (this.detailQueues.get(key) === operation) this.detailQueues.delete(key);
    });
    return operation;
  }

  async showProductDetailProbe({ platformAccountId, productId }) {
    if (!this.userId || this.closing) throw new Error('请先登录本系统');
    const account = this.registry.list(this.userId).find((item) => item.platformAccountId === platformAccountId);
    if (!account) throw new Error('未找到本机绑定的抖店，请先打开原平台工作区');
    const output = await this.probeProducts(account.id, { productId });
    const sample = this.productDetailProbeReports.get(account.id);
    if (!sample || sample.userId !== this.userId || this.closing) return;
    const result = await dialog.showMessageBox(this.window, { type: 'info',
      title: `抖店商品详情探测 · ${account.alias}`, message: output.summary,
      detail: [...output.preview, '请与原平台规格和属性核对。此次仅预览，不保存到商品库、不触发回复。导出文件不含上述商品资料原文。'].join('\n\n'),
      buttons: ['导出脱敏样本', '关闭'], defaultId: 0, cancelId: 1 });
    if (result.response === 0 && this.productDetailProbeReports.get(account.id) === sample)
      await this.exportProductProbe(account.id, { detail: true });
  }

  async exportProductProbe(accountId, { detail = false } = {}) {
    const reports = detail ? this.productDetailProbeReports : this.productProbeReports;
    const sample = reports.get(accountId);
    const valid = () => sample && reports.get(accountId) === sample && this.userId === sample.userId
      && !this.closing && this.registry.get(sample.userId, accountId)?.externalAccountId === sample.shopId;
    if (!valid()) throw new Error(detail ? '暂无详情探测样本，请先在商品列表探测详情' : '暂无商品探测样本，请先探测商品列表');
    const result = await dialog.showSaveDialog(this.window, { title: detail ? '导出抖店商品详情探测样本' : '导出抖店商品列表探测样本',
      defaultPath: `douyin-${detail ? 'product-detail' : 'products'}-probe-${Date.now()}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (result.canceled || !result.filePath || !valid()) return;
    await fs.writeFile(result.filePath, JSON.stringify(sample.report, null, 2), 'utf8');
  }

  handleSendTask(task) {
    if (task.user_id !== this.userId || this.closing || !this.sendJournal) return Promise.resolve();
    if (this.sendTasks.has(task.id)) return this.sendTasks.get(task.id);
    const journal = this.sendJournal;
    const previous = journal.get(task.id);
    if (previous) {
      this.rpaManager?.enqueueEvent(journal.event(previous));
      return Promise.resolve();
    }
    const payload = task.payload_json || {};
    const account = this.registry.list(this.userId).find((item) => item.platformAccountId === task.platform_account_id);
    const operation = async () => {
      let entry;
      const report = (result) => {
        entry ||= journal.begin(task, account?.id || null);
        if (JSON.stringify(entry.result) !== JSON.stringify(result)) entry = journal.finish(entry, result);
        if (this.userId === task.user_id && !this.closing) this.rpaManager?.enqueueEvent(journal.event(entry));
      };
      try {
        if (task.task_type !== 'send_message' || !['desktop', 'automation'].includes(payload.source) || payload.follow_up
          || payload.follow_up_products || payload.quote_message_id) throw new Error('抖店当前仅支持纯文本发送');
        if (!account || payload.platform_account_id !== account.platformAccountId) throw new Error('发送店铺未绑定到本机');
        const valid = () => {
          const current = this.registry.get(this.userId, account.id);
          return this.userId === task.user_id && !this.closing && current && !current.paused && !current.archivedAt
            && current.platformAccountId === task.platform_account_id && current.externalAccountId === account.externalAccountId
            && current.loginStatus === 'online' && this.runtime.get(account.id)?.imReady;
        };
        if (!valid()) throw new Error('请先打开并登录对应的飞鸽客服工作台，确认店铺未暂停');
        if ([...this.pendingSends.values()].some((item) => item.accountId === account.id
          && !item.entry.result.sdk_platform_message_id && !item.entry.result.sdk_client_message_id)) throw new Error('该店铺仍有发送结果待确认，请稍后重试');
        const generation = this.generations.get(account.id);
        const view = this.views.get(account.id);
        const frames = view?.webContents.mainFrame.framesInSubtree || [];
        let target;
        for (const frame of frames) {
          if (!/^https:\/\/(im|pigeon)\.jinritemai\.com\//.test(frame.url)) continue;
          const identity = await frame.executeJavaScript(DOUYIN_PROBE_SCRIPT);
          if (identity?.imReady && identity.shopId === account.externalAccountId) { target = frame; break; }
        }
        if (!target || !valid() || this.generations.get(account.id) !== generation) throw new Error('客服页面状态变化，请重新检查店铺登录');
        const suffix = `:${account.externalAccountId}::2:1:pigeon`;
        const buyer = payload.external_conversation_id?.slice(0, -suffix.length);
        if (!payload.external_conversation_id?.endsWith(suffix) || !buyer || buyer.includes(':')) throw new Error('目标会话与店铺不匹配');
        if (typeof payload.content !== 'string' || !payload.content.trim() || payload.content.length > 4000) throw new Error('消息内容无效');
        if (payload.source === 'automation') {
          await this.validateAutomaticSend(task);
          if (!valid() || this.generations.get(account.id) !== generation) throw new Error('店铺状态已变化');
        }
        await this.transfer.validateSend(task);
        if (!valid() || this.generations.get(account.id) !== generation) throw new Error('店铺状态已变化');
        entry = journal.begin(task, account.id);
        // This durable pending result also covers process exit during executeJavaScript.
        this.rpaManager?.enqueueEvent(journal.event(entry));
        const result = await target.executeJavaScript(senderScript({ action: 'send', taskId: task.id,
          shopId: account.externalAccountId, conversationId: payload.external_conversation_id, content: payload.content }));
        if (result.status !== 'confirmation_pending') { report(result); return; }
        report(result);
        const pending = { target, entry, journal, generation, accountId: account.id, expiresAt: Date.now() + 10 * 60 * 1000, busy: false };
        this.pendingSends.set(task.id, pending);
        pending.timer = setInterval(() => { void this.pollSendResult(task.id); }, 1000);
        pending.timer.unref();
        await this.pollSendResult(task.id);
        // Keep this shop's actor occupied while the ordinary SDK response is in flight.
        const deadline = Date.now() + 15000;
        while (this.pendingSends.has(task.id) && !pending.entry.result.sdk_platform_message_id
          && !pending.entry.result.sdk_client_message_id && Date.now() < deadline && valid()) {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      } catch (error) {
        // Once SDK submission may have begun, an exception cannot prove non-delivery.
        report(entry ? entry.result : { status: 'failed', error: error.message,
          ...(error.autoSendSuppressed ? { auto_send_suppressed: true } : {}) });
      }
    };
    let actor = this.sendActors.get(account?.id);
    if (account && !actor) {
      actor = new StoreActor({ accountId: account.id, rescan: async () => {} });
      this.sendActors.set(account.id, actor);
    }
    const promise = actor ? actor.enqueue('send_message', operation, { rescanAfter: false }) : operation();
    this.sendTasks.set(task.id, promise);
    return promise.catch((error) => {
      // Queued work cancelled before submission is safe to fail; started work stays pending.
      const entry = journal.get(task.id) || journal.finish(journal.begin(task, account?.id || null), { status: 'failed', error: error.message });
      if (this.userId === task.user_id && !this.closing) this.rpaManager?.enqueueEvent(journal.event(entry));
    });
  }

  async validateAutomaticSend(task) {
    const rpa = this.rpaManager;
    if (rpa?.userId !== task.user_id || !rpa.accessToken) throw new Error('请重新登录本系统');
    const response = await fetch(`${rpa.apiBaseUrl}/automation/douyin-tasks/${encodeURIComponent(task.id)}/validate`, {
      headers: { Authorization: `Bearer ${rpa.accessToken}` }, signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error('无法确认机器人当前发送条件');
    const result = await response.json();
    if (result.allowed !== true) {
      const error = new Error(result.reason || '自动回复已停止');
      error.autoSendSuppressed = true;
      throw error;
    }
  }

  async pollSendResult(taskId) {
    const pending = this.pendingSends.get(taskId);
    if (!pending || pending.busy) return;
    const stop = () => { clearInterval(pending.timer); this.pendingSends.delete(taskId); };
    if (this.closing || pending.entry.userId !== this.userId || pending.target.detached
      || this.generations.get(pending.accountId) !== pending.generation || Date.now() > pending.expiresAt) { stop(); return; }
    pending.busy = true;
    try {
      const result = await pending.target.executeJavaScript(senderScript({ action: 'poll', taskId }));
      if (result?.status === 'confirmation_pending' && this.userId === pending.entry.userId && !this.closing
        && this.generations.get(pending.accountId) === pending.generation
        && JSON.stringify(result) !== JSON.stringify(pending.entry.result)) {
        pending.entry = pending.journal.finish(pending.entry, result);
        this.rpaManager?.enqueueEvent(pending.journal.event(pending.entry));
      }
      if (result?.status !== 'confirmation_pending' && this.userId === pending.entry.userId && !this.closing
        && this.generations.get(pending.accountId) === pending.generation) {
        const updated = pending.journal.finish(pending.entry, result);
        this.rpaManager?.enqueueEvent(pending.journal.event(updated));
        stop();
      }
    } catch { stop(); }
    finally { pending.busy = false; }
  }

  async closeForLogout() {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      clearInterval(this.timer); this.timer = null;
      for (const pending of this.pendingSends.values()) clearInterval(pending.timer);
      this.pendingSends.clear();
      if (this.opening) await this.opening.catch(() => {});
      await Promise.allSettled([...this.views.keys()].map((id) => this.disposeView(id)));
      this.runtime.clear(); this.activeAccountId = null; this.overlayOpen = false;
      this.observations.clear();
      this.productProbes.clear(); this.productProbeReports.clear();
      this.productDetailProbeReports.clear();
      this.collectors.clear();
      this.sendActors.clear(); this.sendTasks.clear(); this.sendJournal = null; this.rpaWasOnline = false;
      if (!this.hostWindow) this.window?.destroy();
      this.window = null; this.hostWindow = false; this.hostLayout = null; this.hostVisible = true; this.userId = null;
      this.rpaManager?.setPlatformAccounts('douyin', []);
    })();
    try { await this.closing; } finally { this.closing = null; }
  }
  prepareToQuit() { return this.closeForLogout(); }
}
