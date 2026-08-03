import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const REGISTRY_VERSION = 3;

function normalizeAccount(account) {
  return {
    ...account,
    platformAccountId: account.platformAccountId || null,
    externalAccountId: account.externalAccountId || null,
    platformAccountName: account.platformAccountName || null,
    loginStatus: account.loginStatus || (account.paused ? 'paused' : 'unknown'),
  };
}

function normalizeAlias(value) {
  const alias = String(value || '').trim();
  if (!alias) throw new Error('店铺名称不能为空');
  if (alias.length > 64) throw new Error('店铺名称不能超过 64 个字符');
  return alias;
}

function userPartitionKey(userId) {
  return createHash('sha256').update(userId).digest('hex').slice(0, 12);
}

export class PddAccountRegistry {
  constructor(userDataPath) {
    this.directory = path.join(userDataPath, 'platform-workspaces');
    this.filePath = path.join(this.directory, 'pinduoduo-accounts.json');
    this.data = this.#load();
  }

  #load() {
    fs.mkdirSync(this.directory, { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      return { version: REGISTRY_VERSION, accounts: [] };
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (!parsed || !Array.isArray(parsed.accounts)) throw new Error('账号注册表格式无效');
      return { version: REGISTRY_VERSION, accounts: parsed.accounts.map(normalizeAccount) };
    } catch (error) {
      const backupPath = `${this.filePath}.invalid-${Date.now()}`;
      fs.copyFileSync(this.filePath, backupPath);
      console.error('[PDD Workspace] 账号注册表损坏，已备份并重建:', error);
      return { version: REGISTRY_VERSION, accounts: [] };
    }
  }

  #save() {
    fs.writeFileSync(this.filePath, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
  }

  list(userId, { archived = false } = {}) {
    return this.data.accounts
      .filter((account) => account.userId === userId && Boolean(account.archivedAt) === archived)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((account) => ({ ...account }));
  }

  get(userId, accountId) {
    const account = this.data.accounts.find((item) => item.userId === userId && item.id === accountId);
    return account ? { ...account } : null;
  }

  create(userId, alias) {
    const id = randomUUID();
    const now = new Date().toISOString();
    const account = {
      id,
      userId,
      alias: normalizeAlias(alias),
      partition: `persist:pdd-${userPartitionKey(userId)}-${id}`,
      paused: false,
      platformAccountId: null,
      externalAccountId: null,
      platformAccountName: null,
      loginStatus: 'unknown',
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
      lastOpenedAt: null,
    };
    this.data.accounts.push(account);
    this.#save();
    return { ...account };
  }

  update(userId, accountId, updates) {
    const account = this.data.accounts.find((item) => item.userId === userId && item.id === accountId);
    if (!account) throw new Error('店铺账号不存在');
    if (updates.alias !== undefined) account.alias = normalizeAlias(updates.alias);
    if (updates.paused !== undefined) account.paused = Boolean(updates.paused);
    if (updates.archivedAt !== undefined) account.archivedAt = updates.archivedAt;
    if (updates.lastOpenedAt !== undefined) account.lastOpenedAt = updates.lastOpenedAt;
    if (updates.platformAccountId !== undefined) account.platformAccountId = updates.platformAccountId;
    if (updates.externalAccountId !== undefined) account.externalAccountId = updates.externalAccountId;
    if (updates.platformAccountName !== undefined) account.platformAccountName = updates.platformAccountName;
    if (updates.loginStatus !== undefined) account.loginStatus = updates.loginStatus;
    account.updatedAt = new Date().toISOString();
    this.#save();
    return { ...account };
  }

  remove(userId, accountId) {
    const index = this.data.accounts.findIndex((item) => item.userId === userId && item.id === accountId);
    if (index === -1) throw new Error('店铺账号不存在');
    const [removed] = this.data.accounts.splice(index, 1);
    this.#save();
    return { ...removed };
  }

  bindPlatformAccount(userId, localAccountId, platformAccountId, loginStatus) {
    return this.update(userId, localAccountId, {
      platformAccountId,
      ...(loginStatus ? { loginStatus } : {}),
    });
  }
}
