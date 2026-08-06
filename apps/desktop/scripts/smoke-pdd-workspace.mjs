import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { app, BrowserWindow, ipcMain } from 'electron';
import { PddAccountRegistry } from '../electron/platform-workspace/account-registry.js';
import {
  PDD_PENDING_ACCOUNT_ALIAS,
  PddWorkspaceManager,
} from '../electron/platform-workspace/workspace-manager.js';

const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-customer-service-pdd-smoke-'));
const desktopDirectory = path.resolve(import.meta.dirname, '..');
const preloadPath = path.join(desktopDirectory, 'electron', 'preload.cjs');
const rendererPath = path.join(desktopDirectory, 'dist', 'index.html');
let testServer;
const smokeUserId = 'pdd-workspace-smoke-user';

app.setPath('userData', userDataPath);

async function waitFor(predicate, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('等待拼多多店铺页面加载超时');
}

async function runSmokeTest() {
  const lifecycleKeeper = new BrowserWindow({ show: false });
  testServer = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<html><body>PDD workspace smoke page</body></html>');
  });
  await new Promise((resolve, reject) => {
    testServer.once('error', reject);
    testServer.listen(0, '127.0.0.1', resolve);
  });
  const address = testServer.address();
  const testPageUrl = `http://127.0.0.1:${address.port}/`;
  const registry = new PddAccountRegistry(userDataPath);
  const manager = new PddWorkspaceManager({
    registry,
    devServerUrl: null,
    rendererPath,
    preloadPath,
    homeUrl: testPageUrl,
    loadWorkspaceShell: false,
  });
  ipcMain.handle('pdd-workspace:get-state', () => manager.getState());
  ipcMain.handle('pdd-workspace:set-overlay-open', (_event, payload) =>
    manager.setOverlayOpen(Boolean(payload?.open)),
  );

  await manager.open(smokeUserId);
  await manager.addAccount();
  const pendingAccount = registry.list(smokeUserId)[0];
  assert.equal(pendingAccount.alias, PDD_PENDING_ACCOUNT_ALIAS);
  manager.collectors.get(pendingAccount.id)?.runtime.ingest({
    version: 1,
    type: 'identity',
    external_account_id: 'mall-smoke-a',
    account_name: '拼多多客服平台',
    observed_at: new Date().toISOString(),
  });
  assert.equal(registry.get(smokeUserId, pendingAccount.id)?.alias, PDD_PENDING_ACCOUNT_ALIAS);
  registry.update(smokeUserId, pendingAccount.id, { alias: '拼多多客服平台' });
  manager.collectors.get(pendingAccount.id)?.runtime.ingest({
    version: 1,
    type: 'identity',
    external_account_id: 'mall-smoke-a',
    account_name: 'Smoke detected store',
    observed_at: new Date().toISOString(),
  });
  assert.equal(registry.get(smokeUserId, pendingAccount.id)?.alias, 'Smoke detected store');
  manager.renameAccount(pendingAccount.id, 'Smoke manual store');
  manager.collectors.get(pendingAccount.id)?.runtime.ingest({
    version: 1,
    type: 'identity',
    external_account_id: 'mall-smoke-a',
    account_name: 'Changed platform store',
    observed_at: new Date().toISOString(),
  });
  assert.equal(registry.get(smokeUserId, pendingAccount.id)?.alias, 'Smoke manual store');
  assert.equal(registry.get(smokeUserId, pendingAccount.id)?.platformAccountName, 'Changed platform store');
  manager.collectors.get(pendingAccount.id)?.runtime.ingest({
    version: 1,
    type: 'identity',
    external_account_id: 'mall-smoke-wrong-account',
    account_name: 'Wrong smoke store',
    observed_at: new Date().toISOString(),
  });
  assert.equal(registry.get(smokeUserId, pendingAccount.id)?.externalAccountId, 'mall-smoke-a');
  assert.equal(registry.get(smokeUserId, pendingAccount.id)?.loginStatus, 'account_mismatch');

  await manager.addAccount();

  let state = manager.getState();
  assert.equal(state.accounts.length, 2);
  assert.equal(manager.views.size, 2);
  await waitFor(() =>
    manager.getState().accounts.every((account) => account.runtimeStatus === 'ready'),
  );

  const [accountA, accountB] = registry.list(smokeUserId);
  assert.equal(accountB.alias, PDD_PENDING_ACCOUNT_ALIAS);
  assert.notEqual(accountA.partition, accountB.partition);
  assert.match(accountA.partition, /^persist:pdd-/);
  assert.match(accountB.partition, /^persist:pdd-/);

  await manager.setAccountPaused(accountA.id, true);
  assert.equal(manager.getState().accounts.find((item) => item.id === accountA.id)?.paused, true);
  assert.equal(manager.views.has(accountA.id), false);

  await manager.setAccountPaused(accountA.id, false);
  assert.equal(manager.getState().activeAccountId, accountA.id);
  assert.equal(manager.views.has(accountA.id), true);

  await manager.removeAccount(accountB.id, false);
  state = manager.getState();
  assert.equal(state.accounts.length, 1);
  assert.equal(state.archivedAccounts.length, 1);

  await manager.restoreAccount(accountB.id);
  assert.equal(manager.getState().accounts.length, 2);

  await manager.closeForLogout();

  const restoredRegistry = new PddAccountRegistry(userDataPath);
  assert.equal(restoredRegistry.list(smokeUserId).length, 2);
  const restoredManager = new PddWorkspaceManager({
    registry: restoredRegistry,
    devServerUrl: null,
    rendererPath,
    preloadPath,
    homeUrl: testPageUrl,
    loadWorkspaceShell: false,
  });
  ipcMain.removeHandler('pdd-workspace:get-state');
  ipcMain.removeHandler('pdd-workspace:set-overlay-open');
  ipcMain.handle('pdd-workspace:get-state', () => restoredManager.getState());
  ipcMain.handle('pdd-workspace:set-overlay-open', (_event, payload) =>
    restoredManager.setOverlayOpen(Boolean(payload?.open)),
  );

  await restoredManager.open(smokeUserId);
  const restoredInitialState = restoredManager.getState();
  assert.equal(restoredInitialState.activeAccountId, accountB.id);
  assert.equal(restoredManager.views.size, 1);
  assert.equal(
    restoredInitialState.accounts.find((account) => account.id === accountA.id)?.runtimeStatus,
    'queued',
  );
  await waitFor(() => restoredManager.views.size === 2);
  await waitFor(() =>
    restoredManager.getState().accounts.every((account) => account.runtimeStatus === 'ready'),
  );
  await restoredManager.closeForLogout();
  await new Promise((resolve) => testServer.close(resolve));
  lifecycleKeeper.destroy();

  console.log(
    JSON.stringify({
      status: 'passed',
      accounts: restoredRegistry.list(smokeUserId).map((account) => ({
        id: account.id,
        alias: account.alias,
        partition: account.partition,
      })),
      userDataPath,
    }),
  );
  app.quit();
}

app.whenReady().then(runSmokeTest).catch((error) => {
  console.error(error);
  app.exit(1);
});
