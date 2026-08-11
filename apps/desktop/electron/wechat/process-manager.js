import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { listWechatWindows } from './window-detector.js';
import { createWechatLocalAccountId } from './account-registry.js';
import { detectWechatIdentity } from './identity-detector.js';

const DEFAULT_RELATIVE_PATHS = [
  ['LOCALAPPDATA', 'Tencent', 'WeChat', 'Weixin.exe'],
  ['LOCALAPPDATA', 'Tencent', 'WeChat', 'WeChat.exe'],
  ['LOCALAPPDATA', 'Tencent', 'Weixin', 'Weixin.exe'],
  ['PROGRAMFILES', 'Tencent', 'WeChat', 'WeChat.exe'],
  ['PROGRAMFILES', 'Tencent', 'Weixin', 'Weixin.exe'],
  ['PROGRAMFILES(X86)', 'Tencent', 'WeChat', 'WeChat.exe'],
  ['PROGRAMFILES(X86)', 'Tencent', 'Weixin', 'Weixin.exe'],
];

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function isWechatExecutable(candidate) {
  if (!candidate || !/\.(exe)$/i.test(candidate)) return false;
  if (!/\\(?:weixin|wechat)\.exe$/i.test(candidate)) return false;
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

export function findWechatExecutable(env = process.env, persistedPath = null) {
  const candidates = unique([
    persistedPath,
    env.WECHAT_EXECUTABLE_PATH,
    ...DEFAULT_RELATIVE_PATHS.map(([root, ...parts]) => env[root] ? path.join(env[root], ...parts) : null),
  ]);
  return candidates.find(isWechatExecutable) || null;
}

export class WechatProcessManager {
  constructor({
    registry,
    executablePath = null,
    detector = listWechatWindows,
    launcher = spawn,
    pollIntervalMs = 250,
    launchTimeoutMs = 5000,
    healthIntervalMs = 2000,
    identityDetector = detectWechatIdentity,
    onAccountsChanged = null,
  } = {}) {
    this.registry = registry;
    this.executablePath = executablePath;
    this.detector = detector;
    this.launcher = launcher;
    this.pollIntervalMs = pollIntervalMs;
    this.launchTimeoutMs = launchTimeoutMs;
    this.healthIntervalMs = healthIntervalMs;
    this.identityDetector = identityDetector;
    this.onAccountsChanged = onAccountsChanged;
    this.accountsChangeSignature = null;
    this.launchQueue = Promise.resolve();
    this.refreshQueue = Promise.resolve();
    this.healthTimer = null;
  }

  getExecutablePath() {
    return this.executablePath || this.registry?.getExecutablePath?.() || null;
  }

  setExecutablePath(executablePath) {
    this.executablePath = executablePath;
    this.registry?.setExecutablePath?.(executablePath);
  }

  async openLogin() {
    const launch = this.launchQueue.then(() => this.#openLogin());
    this.launchQueue = launch.catch(() => {});
    return launch;
  }

  async #openLogin() {
    const existing = await this.detector();
    const executable = this.executablePath || findWechatExecutable(process.env, this.registry?.getExecutablePath?.());
    if (!executable) {
      const error = new Error('未找到微信安装路径');
      error.code = 'WECHAT_EXECUTABLE_NOT_FOUND';
      throw error;
    }
    const previousPids = new Set(existing.map((window) => Number(window.pid)).filter((pid) => pid > 0));
    const child = this.launcher(executable, [], { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    const deadline = Date.now() + this.launchTimeoutMs;
    let addedWindow = null;
    while (Date.now() < deadline) {
      const windows = await this.detector();
      addedWindow = windows.find(
        (window) => Number(window.hwnd) > 0 && !previousPids.has(Number(window.pid)),
      ) || null;
      if (addedWindow) break;
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
    if (!addedWindow) {
      return {
        status: 'no_new_instance',
        localAccountId: null,
        pid: child.pid || null,
        hwnd: null,
        executablePath: executable,
      };
    }
    return this.#record(addedWindow, executable);
  }

  listAccounts() {
    return this.registry?.list() || [];
  }

  async refreshAccounts() {
    const refresh = this.refreshQueue.then(() => this.#refreshAccounts());
    this.refreshQueue = refresh.catch(() => {});
    return refresh;
  }

  async identifyAccounts({ localAccountId = null, force = false } = {}) {
    const identify = this.refreshQueue.then(() => this.#identifyAccounts({ localAccountId, force }));
    this.refreshQueue = identify.catch(() => {});
    return identify;
  }

  async startMonitoring() {
    await this.refreshAccounts();
    if (this.healthTimer) return;
    this.healthTimer = setInterval(() => {
      void this.refreshAccounts().catch(() => {});
    }, this.healthIntervalMs);
    this.healthTimer.unref?.();
  }

  stopMonitoring() {
    if (!this.healthTimer) return;
    clearInterval(this.healthTimer);
    this.healthTimer = null;
  }

  async #refreshAccounts() {
    const now = new Date().toISOString();
    const windows = (await this.detector()).filter((window) => Number(window.hwnd) > 0);
    const previous = this.listAccounts();
    const livePids = new Set(windows.map((window) => Number(window.pid)));
    const accounts = new Map(previous.map((account) => [account.localAccountId,
      livePids.has(Number(account.processId)) ? account : offlineAccount(account, now),
    ]));

    for (const window of windows) {
      const pidAccount = previous.find((account) => Number(account.processId) === Number(window.pid));
      const target = pidAccount || {
          localAccountId: createWechatLocalAccountId(),
          externalAccountId: null,
          alias: window.title || `微信账号 ${window.pid}`,
          createdAt: now,
        };
      accounts.set(target.localAccountId, runtimeAccount(
        target,
        window,
        target.executablePath || this.getExecutablePath() || window.executablePath,
        now,
      ));
    }
    const next = [...accounts.values()];
    const stored = this.registry?.replace?.(next) || next;
    const signature = JSON.stringify(stored.map((account) => ({
      localAccountId: account.localAccountId,
      externalAccountId: account.externalAccountId,
      platformAccountId: account.platformAccountId,
      wechatName: account.wechatName,
      wechatId: account.wechatId,
      loginStatus: account.loginStatus,
      identityStatus: account.identityStatus,
    })));
    if (signature !== this.accountsChangeSignature) {
      this.accountsChangeSignature = signature;
      this.onAccountsChanged?.(stored);
    }
    return stored;
  }

  async #identifyAccounts({ localAccountId, force }) {
    await this.#refreshAccounts();
    const windows = (await this.detector()).filter(
      (window) => Number(window.hwnd) > 0 && window.loginStatus === 'online',
    );
    const accounts = this.listAccounts();
    const selected = localAccountId
      ? accounts.filter((account) => account.localAccountId === localAccountId)
      : accounts.filter((account) => Number(account.processId) > 0);
    const results = [];

    for (const account of selected) {
      const window = windows.find((item) => Number(item.pid) === Number(account.processId));
      if (!window) {
        results.push({ localAccountId: account.localAccountId, status: 'window_not_found' });
        continue;
      }
      if (!force && account.externalAccountId && account.identityStatus === 'identified') {
        results.push({ localAccountId: account.localAccountId, status: 'skipped_identified' });
        continue;
      }
      const probe = await this.identityDetector({ pid: Number(window.pid), hwnd: Number(window.hwnd) });
      results.push({ localAccountId: account.localAccountId, status: probe?.status || 'probe_failed' });
      this.#applyIdentityProbe(account.localAccountId, window, probe);
    }

    const refreshed = await this.#refreshAccounts();
    return { accounts: refreshed, results };
  }

  #applyIdentityProbe(localAccountId, window, probe) {
    const now = new Date().toISOString();
    const previous = this.listAccounts();
    const current = previous.find((account) => account.localAccountId === localAccountId);
    if (!current) return;
    const identity = probe?.identity || null;
    if (!identity) {
      this.registry?.upsert?.({
        ...current,
        identityStatus: probe?.status || 'probe_failed',
        identityProbeStatus: probe?.status || 'probe_failed',
        identityDetail: probe?.detail || null,
        identityLastCheckedAt: now,
      });
      return;
    }

    const historical = previous.find(
      (account) => account.externalAccountId === identity.externalAccountId
        && account.localAccountId !== localAccountId,
    );
    const historicalInUse = historical
      && Number(historical.processId) > 0
      && Number(historical.processId) !== Number(window.pid);
    if (historicalInUse) {
      this.registry?.upsert?.({
        ...current,
        identityStatus: 'conflict',
        identityProbeStatus: 'identified',
        identityDetail: '相同微信身份已绑定到另一个运行中窗口',
        identityLastCheckedAt: now,
      });
      return;
    }

    const currentIdentityChanged = Boolean(
      current.externalAccountId && current.externalAccountId !== identity.externalAccountId,
    );
    const target = historical || (currentIdentityChanged ? {
      localAccountId: createWechatLocalAccountId(),
      createdAt: now,
      executablePath: current.executablePath,
    } : current);
    const next = previous
      .filter((account) => account.localAccountId !== current.localAccountId && account.localAccountId !== target.localAccountId)
      .concat(currentIdentityChanged ? offlineAccount(current, now) : [])
      .concat(runtimeAccount({
        ...target,
        externalAccountId: identity.externalAccountId,
        wechatName: identity.wechatName,
        wechatId: identity.wechatId,
        alias: identity.wechatName,
        identitySource: identity.source,
        identityStatus: 'identified',
        identityProbeStatus: 'identified',
        identityDetail: null,
        identityLastCheckedAt: now,
      }, window, target.executablePath || current.executablePath, now));
    this.registry?.replace?.(next);
  }

  #record(window, executablePath) {
    const existing = this.listAccounts().find((account) => Number(account.processId) === Number(window.pid));
    const now = new Date().toISOString();
    const account = runtimeAccount(existing || {
      localAccountId: createWechatLocalAccountId(),
      externalAccountId: null,
      alias: window.title || `微信账号 ${window.pid}`,
      createdAt: now,
    }, window, executablePath, now);
    return this.registry ? this.registry.upsert(account) : account;
  }
}

function runtimeAccount(account, window, executablePath, now) {
  return {
    ...account,
    platformCode: 'wechat',
    alias: account.wechatName || account.alias || window.title || `微信账号 ${window.pid}`,
    processId: Number(window.pid),
    lastKnownProcessId: Number(window.pid),
    windowHandle: Number(window.hwnd) || null,
    executablePath: executablePath || account.executablePath || null,
    loginStatus: window.loginStatus || 'unknown',
    healthStatus: 'online',
    lastSeenAt: now,
    disconnectedAt: null,
  };
}

function offlineAccount(account, now) {
  if (!account.processId && account.healthStatus === 'offline') return account;
  return {
    ...account,
    lastKnownProcessId: account.processId || account.lastKnownProcessId || null,
    processId: null,
    windowHandle: null,
    loginStatus: 'offline',
    healthStatus: 'offline',
    disconnectedAt: account.disconnectedAt || now,
  };
}
