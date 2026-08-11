import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export class WechatAccountRegistry {
  constructor(userDataPath) {
    this.filePath = path.join(userDataPath, 'wechat-accounts.json');
    const state = this.#load();
    this.accounts = state.accounts.map(normalizeAccount);
    this.executablePath = state.executablePath;
    const disposableAccounts = this.accounts.filter(isDisposableUnidentifiedAccount);
    if (disposableAccounts.length > 0) {
      this.#backupBeforeCleanup();
      const disposableIds = new Set(disposableAccounts.map((account) => account.localAccountId));
      this.accounts = this.accounts.filter((account) => !disposableIds.has(account.localAccountId));
      this.#persist();
    } else if (this.accounts.some((account, index) => account.localAccountId !== state.accounts[index]?.localAccountId)) {
      this.#persist();
    }
  }

  #load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (Array.isArray(parsed)) return { accounts: parsed, executablePath: null };
      return { accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [], executablePath: parsed.executablePath || null };
    } catch {
      return { accounts: [], executablePath: null };
    }
  }

  #persist() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify({ accounts: this.accounts, executablePath: this.executablePath }, null, 2)}\n`, 'utf8');
    fs.renameSync(tempPath, this.filePath);
  }

  #backupBeforeCleanup() {
    if (!fs.existsSync(this.filePath)) return;
    const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
    const backupPath = path.join(
      path.dirname(this.filePath),
      `wechat-accounts.pre-cleanup-${timestamp}-${randomUUID()}.json`,
    );
    fs.copyFileSync(this.filePath, backupPath, fs.constants.COPYFILE_EXCL);
  }

  upsert(account) {
    const index = this.accounts.findIndex((item) => item.localAccountId === account.localAccountId);
    if (index === -1) this.accounts.push(normalizeAccount(account));
    else this.accounts[index] = normalizeAccount({ ...this.accounts[index], ...account });
    this.#persist();
    return clone(index === -1 ? this.accounts.at(-1) : this.accounts[index]);
  }

  getExecutablePath() {
    return this.executablePath || null;
  }

  setExecutablePath(executablePath) {
    this.executablePath = executablePath;
    this.#persist();
  }

  list() {
    return clone(this.accounts);
  }

  replace(accounts) {
    const normalized = accounts.map(normalizeAccount);
    const disposableAccounts = normalized.filter(isDisposableUnidentifiedAccount);
    if (disposableAccounts.length > 0) this.#backupBeforeCleanup();
    this.accounts = normalized.filter((account) => !isDisposableUnidentifiedAccount(account));
    this.#persist();
    return this.list();
  }

  bindPlatformAccount(localAccountId, platformAccountId, loginStatus) {
    const account = this.accounts.find((item) => item.localAccountId === localAccountId);
    if (!account) return null;
    return this.upsert({
      ...account,
      platformAccountId,
      ...(loginStatus ? { loginStatus } : {}),
    });
  }
}

export function createWechatLocalAccountId() {
  return `wechat-${randomUUID()}`;
}

export function isDisposableUnidentifiedAccount(account) {
  return account?.healthStatus === 'offline'
    && !account?.processId
    && !account?.windowHandle
    && !account?.wechatName
    && !account?.wechatId
    && !account?.externalAccountId;
}

function normalizeAccount(account) {
  const legacyPidId = /^wechat-pid-\d+$/.test(String(account?.localAccountId || ''));
  return {
    ...account,
    platformCode: 'wechat',
    localAccountId: !account?.localAccountId || legacyPidId
      ? createWechatLocalAccountId()
      : account.localAccountId,
    externalAccountId: account?.externalAccountId || null,
    platformAccountId: account?.platformAccountId || null,
    wechatName: account?.wechatName || null,
    wechatId: account?.wechatId || null,
    identityStatus: account?.identityStatus || (account?.externalAccountId ? 'identified' : 'unknown'),
    identitySource: account?.identitySource || null,
    identityDetail: account?.identityDetail || null,
    identityLastCheckedAt: account?.identityLastCheckedAt || null,
    identityProbeStatus: account?.identityProbeStatus || null,
    processId: Number(account?.processId) > 0 ? Number(account.processId) : null,
    lastKnownProcessId: Number(account?.lastKnownProcessId) > 0
      ? Number(account.lastKnownProcessId)
      : (Number(account?.processId) > 0 ? Number(account.processId) : null),
    windowHandle: Number(account?.windowHandle) > 0 ? Number(account.windowHandle) : null,
    loginStatus: account?.loginStatus || 'unknown',
    healthStatus: account?.healthStatus || (account?.processId ? 'online' : 'offline'),
    createdAt: account?.createdAt || new Date().toISOString(),
    lastSeenAt: account?.lastSeenAt || null,
    disconnectedAt: account?.disconnectedAt || null,
  };
}
