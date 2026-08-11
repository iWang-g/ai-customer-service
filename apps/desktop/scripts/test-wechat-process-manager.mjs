import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WechatProcessManager } from '../electron/wechat/process-manager.js';
import { WechatAccountRegistry, isDisposableUnidentifiedAccount } from '../electron/wechat/account-registry.js';
import { createWechatExternalAccountId, normalizeWechatIdentity } from '../electron/wechat/identity-detector.js';

const normalizedIdentity = normalizeWechatIdentity({
  wechat_name: '  测试  名称 ',
  wechat_id: ' test-id ',
});
assert.equal(normalizedIdentity.wechatName, '测试 名称');
assert.equal(normalizedIdentity.wechatId, 'test-id');
assert.equal(
  normalizedIdentity.externalAccountId,
  createWechatExternalAccountId('测试 名称', 'test-id'),
);

assert.equal(isDisposableUnidentifiedAccount({
  healthStatus: 'offline', processId: null, windowHandle: null,
  wechatName: null, wechatId: null, externalAccountId: null,
}), true);
assert.equal(isDisposableUnidentifiedAccount({
  healthStatus: 'offline', processId: null, windowHandle: null,
  wechatName: '历史账号', wechatId: 'history-id', externalAccountId: 'wechat:history',
}), false);
assert.equal(isDisposableUnidentifiedAccount({
  healthStatus: 'online', processId: 10, windowHandle: 100,
  wechatName: null, wechatId: null, externalAccountId: null,
}), false);

const registryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-registry-test-'));
fs.writeFileSync(path.join(registryDirectory, 'wechat-accounts.json'), JSON.stringify({
  accounts: [
    {
      localAccountId: 'wechat-disposable',
      alias: '微信账号 123',
      healthStatus: 'offline',
      loginStatus: 'offline',
      processId: null,
      windowHandle: null,
    },
    {
      localAccountId: 'wechat-history',
      alias: '历史账号',
      wechatName: '历史账号',
      wechatId: 'history-id',
      externalAccountId: 'wechat:history',
      identityStatus: 'identified',
      healthStatus: 'offline',
      loginStatus: 'offline',
      processId: null,
      windowHandle: null,
    },
    {
      localAccountId: 'wechat-pending',
      alias: '未识别窗口',
      healthStatus: 'online',
      loginStatus: 'online',
      processId: 10,
      windowHandle: 100,
    },
  ],
}, null, 2), 'utf8');
const cleanupRegistry = new WechatAccountRegistry(registryDirectory);
assert.deepEqual(
  cleanupRegistry.list().map((account) => account.localAccountId),
  ['wechat-history', 'wechat-pending'],
);
assert.equal(
  fs.readdirSync(registryDirectory).filter((name) => name.startsWith('wechat-accounts.pre-cleanup-')).length,
  1,
);
cleanupRegistry.replace([
  ...cleanupRegistry.list(),
  {
    localAccountId: 'wechat-later-disposable',
    alias: '微信',
    healthStatus: 'offline',
    loginStatus: 'offline',
    processId: null,
    windowHandle: null,
  },
]);
assert.equal(cleanupRegistry.list().some((account) => account.localAccountId === 'wechat-later-disposable'), false);
assert.equal(
  fs.readdirSync(registryDirectory).filter((name) => name.startsWith('wechat-accounts.pre-cleanup-')).length,
  2,
);
fs.rmSync(registryDirectory, { recursive: true, force: true });

let knownIdentityCalls = 0;
const knownAccount = [{
  localAccountId: 'wechat-known-online',
  externalAccountId: 'wechat:known-online',
  wechatName: '已识别账号',
  wechatId: 'known-online-id',
  processId: 90,
  windowHandle: 900,
  loginStatus: 'online',
  healthStatus: 'online',
  identityStatus: 'identified',
  createdAt: '2026-01-01T00:00:00.000Z',
}];
const knownManager = new WechatProcessManager({
  registry: {
    list: () => structuredClone(knownAccount),
    replace: (accounts) => {
      knownAccount.splice(0, knownAccount.length, ...structuredClone(accounts));
      return structuredClone(knownAccount);
    },
  },
  detector: async () => [{ pid: 90, hwnd: 900, title: '微信', loginStatus: 'online' }],
  identityDetector: async () => {
    knownIdentityCalls += 1;
    return { status: 'identified', identity: normalizedIdentity };
  },
});
await knownManager.refreshAccounts();
assert.equal(knownIdentityCalls, 0);
const skippedKnown = await knownManager.identifyAccounts();
assert.equal(skippedKnown.results[0].status, 'skipped_identified');
assert.equal(knownIdentityCalls, 0);
await knownManager.identifyAccounts({ localAccountId: 'wechat-known-online', force: true });
assert.equal(knownIdentityCalls, 1);

const recorded = [];
let detectionIndex = 0;
const detections = [
  [{ pid: 100, hwnd: 1000, title: '微信', loginStatus: 'online' }],
  [{ pid: 100, hwnd: 1000, title: '微信', loginStatus: 'online' }],
  [
    { pid: 100, hwnd: 1000, title: '微信', loginStatus: 'online' },
    { pid: 200, hwnd: 2000, title: '', loginStatus: 'login_required' },
  ],
];
const manager = new WechatProcessManager({
  executablePath: 'C:\\Program Files\\Tencent\\Weixin\\Weixin.exe',
  registry: {
    upsert: (account) => {
      recorded.push(account);
      return account;
    },
    list: () => recorded,
  },
  detector: async () => detections[Math.min(detectionIndex++, detections.length - 1)],
  launcher: () => ({ pid: 200, unref() {} }),
  pollIntervalMs: 0,
  launchTimeoutMs: 100,
  identityDetector: async () => ({ status: 'login_required', identity: null }),
});

const result = await manager.openLogin();
assert.equal(result.processId, 200);
assert.equal(result.windowHandle, 2000);
assert.equal(result.loginStatus, 'login_required');
assert.equal(recorded.length, 1);
assert.match(recorded[0].localAccountId, /^wechat-[0-9a-f-]{36}$/);

let launches = 0;
const noNewInstance = new WechatProcessManager({
  executablePath: 'C:\\Program Files\\Tencent\\Weixin\\Weixin.exe',
  detector: async () => [{ pid: 100, hwnd: 1000, title: '微信', loginStatus: 'online' }],
  launcher: () => ({ pid: 300, unref() { launches += 1; } }),
  pollIntervalMs: 1,
  launchTimeoutMs: 10,
  identityDetector: async () => ({ status: 'unavailable', identity: null }),
});
const noNewResult = await noNewInstance.openLogin();
assert.equal(launches, 1);
assert.equal(noNewResult.status, 'no_new_instance');
assert.equal(noNewResult.localAccountId, null);

const persisted = [
  {
    localAccountId: 'wechat-stable-a',
    processId: 400,
    windowHandle: 4000,
    alias: '账号 A',
    loginStatus: 'online',
    healthStatus: 'online',
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  {
    localAccountId: 'wechat-stable-b',
    externalAccountId: 'wechat:identity-b',
    wechatName: '账号 B',
    wechatId: 'wxid-b',
    processId: 500,
    windowHandle: 5000,
    alias: '账号 B',
    loginStatus: 'online',
    healthStatus: 'online',
    createdAt: '2026-01-01T00:00:00.000Z',
  },
];
let recoveryIdentityCalls = 0;
const recoveryManager = new WechatProcessManager({
  registry: {
    list: () => structuredClone(persisted),
    replace: (accounts) => {
      persisted.splice(0, persisted.length, ...structuredClone(accounts));
      return structuredClone(persisted);
    },
  },
  detector: async () => [
    { pid: 400, hwnd: 4444, title: '微信', loginStatus: 'online' },
    { pid: 600, hwnd: 6666, title: '微信', loginStatus: 'online' },
  ],
  identityDetector: async ({ pid }) => {
    recoveryIdentityCalls += 1;
    return pid === 600 ? {
        status: 'identified',
        identity: {
          wechatName: '账号 B',
          wechatId: 'wxid-b',
          externalAccountId: 'wechat:identity-b',
          source: 'wechat_profile_uia',
        },
      } : ({ status: 'unavailable', identity: null });
  },
});
const refreshedOnly = await recoveryManager.refreshAccounts();
const accountA = refreshedOnly.find((account) => account.localAccountId === 'wechat-stable-a');
const accountBBeforeIdentification = refreshedOnly.find((account) => account.localAccountId === 'wechat-stable-b');
const pendingWindow = refreshedOnly.find((account) => account.processId === 600);
assert.equal(accountA.windowHandle, 4444);
assert.equal(accountA.healthStatus, 'online');
assert.equal(accountBBeforeIdentification.healthStatus, 'offline');
assert.equal(pendingWindow.externalAccountId, null);
assert.equal(recoveryIdentityCalls, 0);

const recoveryResult = await recoveryManager.identifyAccounts({ localAccountId: pendingWindow.localAccountId });
const recovered = recoveryResult.accounts;
const reboundB = recovered.find((account) => account.processId === 600);
assert.equal(reboundB.localAccountId, 'wechat-stable-b');
assert.equal(reboundB.externalAccountId, 'wechat:identity-b');
assert.equal(reboundB.windowHandle, 6666);
assert.equal(reboundB.healthStatus, 'online');

const historical = [{
  localAccountId: 'wechat-history',
  externalAccountId: 'wechat:known',
  wechatName: '历史名称',
  wechatId: 'known-id',
  processId: null,
  windowHandle: null,
  loginStatus: 'offline',
  healthStatus: 'offline',
  createdAt: '2026-01-01T00:00:00.000Z',
}];
const identityRecovery = new WechatProcessManager({
  registry: {
    list: () => structuredClone(historical),
    replace: (accounts) => {
      historical.splice(0, historical.length, ...structuredClone(accounts));
      return structuredClone(historical);
    },
  },
  detector: async () => [{ pid: 700, hwnd: 7777, title: '微信', loginStatus: 'online' }],
  identityDetector: async () => ({
    status: 'identified',
    identity: {
      wechatName: '历史名称',
      wechatId: 'known-id',
      externalAccountId: 'wechat:known',
      source: 'wechat_profile_uia',
    },
  }),
});
const unidentifiedHistory = await identityRecovery.refreshAccounts();
assert.equal(unidentifiedHistory.some((account) => account.localAccountId === 'wechat-history' && account.healthStatus === 'offline'), true);
const pendingHistoricalWindow = unidentifiedHistory.find((account) => account.processId === 700);
const identityRecovered = (await identityRecovery.identifyAccounts({
  localAccountId: pendingHistoricalWindow.localAccountId,
})).accounts;
assert.equal(identityRecovered.length, 1);
assert.equal(identityRecovered[0].localAccountId, 'wechat-history');
assert.equal(identityRecovered[0].processId, 700);
assert.equal(identityRecovered[0].identityStatus, 'identified');

const changedIdentity = [{
  localAccountId: 'wechat-old-identity',
  externalAccountId: 'wechat:old',
  wechatName: '旧名称',
  wechatId: 'old-id',
  processId: 800,
  windowHandle: 8888,
  loginStatus: 'online',
  healthStatus: 'online',
  createdAt: '2026-01-01T00:00:00.000Z',
}];
const changedIdentityManager = new WechatProcessManager({
  registry: {
    list: () => structuredClone(changedIdentity),
    replace: (accounts) => {
      changedIdentity.splice(0, changedIdentity.length, ...structuredClone(accounts));
      return structuredClone(changedIdentity);
    },
  },
  detector: async () => [{ pid: 800, hwnd: 8888, title: '微信', loginStatus: 'online' }],
  identityDetector: async () => ({
    status: 'identified',
    identity: {
      wechatName: '新名称',
      wechatId: 'new-id',
      externalAccountId: 'wechat:new',
      source: 'wechat_profile_uia',
    },
  }),
});
const unchangedBeforeManualAction = await changedIdentityManager.refreshAccounts();
assert.equal(unchangedBeforeManualAction.length, 1);
assert.equal(unchangedBeforeManualAction[0].externalAccountId, 'wechat:old');
const changed = (await changedIdentityManager.identifyAccounts({
  localAccountId: 'wechat-old-identity',
  force: true,
})).accounts;
const oldIdentityAccount = changed.find((account) => account.localAccountId === 'wechat-old-identity');
const newIdentityAccount = changed.find((account) => account.externalAccountId === 'wechat:new');
assert.equal(oldIdentityAccount.healthStatus, 'offline');
assert.equal(oldIdentityAccount.processId, null);
assert.match(newIdentityAccount.localAccountId, /^wechat-[0-9a-f-]{36}$/);
assert.equal(newIdentityAccount.processId, 800);

console.log('WeChat process manager tests passed.');
