import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';
import { PddAccountRegistry } from '../electron/platform-workspace/account-registry.js';
import { PddWorkspaceManager } from '../electron/platform-workspace/workspace-manager.js';
import { StoreActor } from '../electron/platform-workspace/store-actor.js';

const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-customer-service-pdd-health-'));
const desktopDirectory = path.resolve(import.meta.dirname, '..');
const preloadPath = path.join(desktopDirectory, 'electron', 'preload.cjs');
const rendererPath = path.join(desktopDirectory, 'dist', 'index.html');
const userId = 'pdd-session-health-user';
let testServer;

app.setPath('userData', userDataPath);

async function waitFor(predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('等待拼多多登录健康检查结果超时');
}

async function runTest() {
  const lifecycleKeeper = new BrowserWindow({ show: false });
  let requestCount = 0;
  let pageStatus = 'online';
  testServer = http.createServer((_request, response) => {
    requestCount += 1;
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<html><body>PDD session health test page</body></html>');
  });
  await new Promise((resolve, reject) => {
    testServer.once('error', reject);
    testServer.listen(0, '127.0.0.1', resolve);
  });
  const address = testServer.address();
  const registry = new PddAccountRegistry(userDataPath);
  const manager = new PddWorkspaceManager({
    registry,
    devServerUrl: null,
    rendererPath,
    preloadPath,
    homeUrl: `http://127.0.0.1:${address.port}/`,
    loadWorkspaceShell: false,
    sessionHealthCheckIntervalMs: 50,
    sessionIdleRefreshIntervalMs: 250,
    sessionRefreshTimeoutMs: 5000,
    pageClassifier: () => pageStatus,
  });

  await manager.open(userId);
  await manager.addAccount();
  const account = registry.list(userId)[0];
  await waitFor(() => manager.getState().accounts[0]?.runtimeStatus === 'ready');
  assert.equal(registry.get(userId, account.id)?.loginStatus, 'online');

  let releaseBusyTask;
  const busyTask = new Promise((resolve) => { releaseBusyTask = resolve; });
  const actor = new StoreActor({ accountId: account.id, rescan: async () => {} });
  manager.storeActors.set(account.id, actor);
  const actorTask = actor.enqueue('send_message', () => busyTask, { rescanAfter: false });
  await waitFor(() => actor.state === 'send_message');
  const busyRequestCount = requestCount;
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(requestCount, busyRequestCount);

  releaseBusyTask();
  await actorTask;
  await waitFor(() => requestCount > busyRequestCount);
  const refreshedRequestCount = requestCount;

  pageStatus = 'login_required';
  await waitFor(() => registry.get(userId, account.id)?.loginStatus === 'login_required');
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(requestCount, refreshedRequestCount);

  await manager.closeForLogout();
  assert.equal(manager.sessionHealthTimer, null);
  assert.equal(manager.sessionHealthByAccount.size, 0);
  await new Promise((resolve) => testServer.close(resolve));
  lifecycleKeeper.destroy();

  console.log(JSON.stringify({ status: 'passed', requestCount, userDataPath }));
  app.quit();
}

app.whenReady().then(runTest).catch((error) => {
  console.error(error);
  app.exit(1);
});
