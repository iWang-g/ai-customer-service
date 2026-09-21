import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { app, BrowserWindow, ipcMain, session, dialog } from 'electron';
import { DouyinAccountRegistry } from '../electron/platform-workspace/douyin/account-registry.js';
import { DouyinWorkspaceManager } from '../electron/platform-workspace/douyin/workspace-manager.js';
import { registerDouyinWorkspaceIpc } from '../electron/platform-workspace/douyin/ipc.js';
import { registerDouyinOrderProbeIpc } from '../electron/platform-workspace/douyin/order-probe-controller.js';
import { registerDouyinTransferIpc } from '../electron/platform-workspace/douyin/transfer-controller.js';
import { PddAccountRegistry } from '../electron/platform-workspace/account-registry.js';
import { PddWorkspaceManager } from '../electron/platform-workspace/workspace-manager.js';

const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-douyin-m0-'));
const liveLogin = process.argv.includes('--live-login');
app.setPath('userData', userDataPath);
const root = path.resolve(import.meta.dirname, '..');
const fixtures = new Map();
const screenshotDirectory = path.join(root, '..', '..', '.tmp', 'douyin-m0-qa');
fs.mkdirSync(screenshotDirectory, { recursive: true });
let fixtureIndex = 0;

function installFixture(accountSession) {
  if (fixtures.has(accountSession)) return;
  const fixture = { shopId: String(++fixtureIndex), expired: false, waitIdentity: null };
  fixtures.set(accountSession, fixture);
  accountSession.protocol.handle('https', async (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/backstage/currentuser') {
      if (fixture.waitIdentity) await fixture.waitIdentity;
      return Response.json(fixture.expired ? { code: 10005 } : { code: 0, data: {
        ShopId: fixture.shopId, ShopName: `测试抖店 ${fixture.shopId}`,
        CustomerServiceInfo: { id: fixture.staffId || 'staff-1', screen_name: '测试客服' },
      } }, { headers: { 'Access-Control-Allow-Origin': 'https://im.jinritemai.com', 'Access-Control-Allow-Credentials': 'true' } });
    }
    if (url.pathname.endsWith('/get_current_conversation_list')) return Response.json({ code: 0, data: fixture.messages ? [{ msgList: fixture.messages.map((messageBody) => ({ messageBody })) }] : [], total: fixture.messages ? 1 : 0 },
      { headers: { 'Access-Control-Allow-Origin': 'https://im.jinritemai.com', 'Access-Control-Allow-Credentials': 'true' } });
    if (url.pathname === '/backstage/getCanAssignStaffList') {
      fixture.staffCalls = (fixture.staffCalls || 0) + 1;
      assert.equal(request.method, 'GET');
      if (fixture.waitStaff) await fixture.waitStaff;
      return Response.json({ code: 0, data: [{ staffId: '9007199254740993111', staffName: '候选客服甲',
        staff_username: 'private-staff-account', status: fixture.staffStatus ?? 1, online_status: 1, mobile: 'private-staff-mobile' }] },
      { headers: { 'Access-Control-Allow-Origin': 'https://im.jinritemai.com', 'Access-Control-Allow-Credentials': 'true' } });
    }
    if (url.pathname === '/backstage/cmpoent/order/query') {
      fixture.orderCalls = (fixture.orderCalls || 0) + 1;
      fixture.orderBody = await request.json();
      if (fixture.waitOrders) await fixture.waitOrders;
      return Response.json({ code: 0, data: [{ order_id: '9007199254740993999', shop_id: fixture.shopId,
        security_user_id: fixture.orderBody.security_user_id, order_status_desc: '待发货', actual_pay_amount: 99,
        mobile: 'private-mobile', sku_order_list: [
          { product_id: '1', sku_id: '11', sku_order_id: '21', buy_num: 2, product_name: '订单模拟商品甲', sku_space_text: '模拟规格甲' },
          { product_id: '2', sku_id: '12', sku_order_id: '22', buy_num: 1, product_name: '订单模拟商品乙', sku_space_text: '模拟规格乙' },
        ] }] }, { headers: { 'Access-Control-Allow-Origin': 'https://im.jinritemai.com', 'Access-Control-Allow-Credentials': 'true' } });
    }
    if (url.pathname.endsWith('/get_product_list')) {
      fixture.productCalls = (fixture.productCalls || 0) + 1;
      fixture.productBody = await request.json();
      if (fixture.waitProducts) await fixture.waitProducts;
      return new Response('{"code":0,"total":1,"data":[{"product_item":{"product_id":3830227192483283126,"product_base_info":{"title":"private-product-title"},"marketing_info":{"show_product_marketing_info":{"show_sku_info":{"show_price":{"show_price":{"show_amount":"155.00","price_prefix":"¥","price_suffix":""}}}}}}}]}',
        { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'https://im.jinritemai.com', 'Access-Control-Allow-Credentials': 'true' } });
    }
    if (url.pathname.endsWith('/get_skuinfo_list') || url.pathname.endsWith('/pack/detail/')) {
      fixture.detailCalls = (fixture.detailCalls || 0) + 1;
      if (fixture.waitDetails) await fixture.waitDetails;
      const detail = url.pathname.endsWith('/get_skuinfo_list')
        ? { code: 0, data: { product_info: { product_id: '3830227192483283126', spec_detail_info: [
          { name: '模拟尺寸', spec_details: [{ id: '1', name: '40×120' }, { id: '2', name: '50×150' }] },
        ] }, items: [{ product_id: '3830227192483283126', sku_id: '11', spec_detail_id1: '1',
          spec_name1: '模拟尺寸', spec_detail_name1: '40×120' }] } }
        : { status_code: 0, detail_info: { jump_url: 'sslocal://detail?promotion_id=3830227192483283126', product_format: [
          { format: [{ name: '模拟材质', message: [{ desc: '棉' }] },
            ...Array.from({ length: 8 }, (_, i) => ({ name: `模拟属性${i + 2}`, message: [{ desc: '模拟值' }] }))] },
        ] } };
      return Response.json(detail, { headers: { 'Access-Control-Allow-Origin': request.headers.get('Origin') || 'https://pigeon.jinritemai.com',
        'Access-Control-Allow-Credentials': 'true' } });
    }
    if (url.pathname === '/backend') return new Response('<html><body><p>当前账号暂无权限，请主账号调整您的权限</p><a id="customer-service" target="_blank" href="https://im.jinritemai.com/pc_seller_v2/main/workspace">客服</a></body></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
    if (url.pathname === '/home') return new Response('<html><body><iframe src="https://pigeon.jinritemai.com/im"></iframe></body></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
    const login = url.pathname.startsWith('/login');
    return new Response(`<!doctype html><html><body style="font:20px sans-serif;padding:32px;background:#f8fafc">
      <h1>${login ? '抖店登录测试页面' : '抖店客服测试页面'}</h1>
      <p>这是本地测试页面，不会连接平台或发送消息。</p>
      <a href="https://pigeon.jinritemai.com/im">进入客服工作台</a>
      <script>window.sendCalls=0; ${login ? '' : 'window.__PLATFORM_VARIABLES_IN_BENCH__={extra:{im:{sendText(){window.sendCalls++}}}};'}</script>
      </body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  });
}
if (!liveLogin) app.on('session-created', installFixture);

async function waitFor(predicate, label, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${label}`);
}

app.whenReady().then(async () => {
  const keeper = new BrowserWindow({ show: false });
  const rpa = new EventEmitter();
  rpa.accounts = new Map();
  rpa.events = [];
  rpa.completions = [];
  rpa.completeTask = (...args) => rpa.completions.push(args);
  rpa.enqueueEvent = (event) => rpa.events.push(event);
  rpa.getState = () => ({ status: 'online' });
  rpa.setPlatformAccounts = (platform, accounts) => rpa.accounts.set(platform, accounts);
  const registry = new DouyinAccountRegistry(userDataPath);
  const config = { registry, rendererPath: path.join(root, 'dist', 'index.html'),
    preloadPath: path.join(root, 'electron', 'preload.cjs'), rpaManager: rpa, probeIntervalMs: 60000 };
  const manager = new DouyinWorkspaceManager(config);
  // Business API is independently covered by backend tests; guard transport is mocked here.
  manager.transfer.api = async (_user, url) => {
    if (url.startsWith('/conversations/douyin/send-guard/')) return { allowed: true };
    throw new Error('unexpected transfer API request');
  };
  const handlers = new Map();
  registerDouyinWorkspaceIpc({ handle: (name, fn) => { handlers.set(name, fn); ipcMain.handle(name, fn); } }, manager);
  registerDouyinOrderProbeIpc({ handle: (name, fn) => { handlers.set(name, fn); } }, manager, () => keeper);
  registerDouyinTransferIpc({ handle: (name, fn) => { handlers.set(name, fn); } }, manager, () => keeper);
  await manager.bindUser('user-a');
  await Promise.all([manager.open('user-a'), manager.open('user-a')]);
  assert.equal(BrowserWindow.getAllWindows().length, 2, 'repeated open uses a single shell');
  const shell = manager.window.webContents;
  const uiErrors = [];
  shell.on('console-message', (event) => { if (event.level === 'error') uiErrors.push(event.message); });
  await waitFor(() => shell.executeJavaScript('document.body.innerText.includes("抖店工作区")'), 'workspace shell');
  // Exercise the actual renderer button, preload and IPC rather than just manager methods.
  await shell.executeJavaScript('[...document.querySelectorAll("button")].find(b=>b.textContent.includes("添加店铺")).click()');
  await waitFor(() => registry.list('user-a').length === 1, 'add account through shell');
  const a = registry.list('user-a')[0];
  if (liveLogin) {
    const loginContents = manager.views.get(a.id).webContents;
    await waitFor(async () => !loginContents.isLoading() && await loginContents.executeJavaScript(
      'document.body.innerText.includes("登录") && document.body.innerText.length > 50',
    ), 'live login form', 45000);
    await manager.probeAccount(a.id);
    assert.equal(registry.get('user-a', a.id).loginStatus, 'login_required');
    const page = await loginContents.executeJavaScript('({ title: document.title, path: location.origin + location.pathname, hasLogin: document.body.innerText.includes("登录") })');
    fs.writeFileSync(path.join(screenshotDirectory, 'live-login.png'), (await loginContents.capturePage()).toPNG());
    await manager.closeForLogout();
    keeper.destroy();
    console.log(JSON.stringify({ status: 'passed', scope: 'live login page only; no authentication or messages', page, screenshotDirectory }));
    app.quit();
    return;
  }
  await waitFor(() => manager.getState().accounts[0]?.loginStatus === 'login_required', 'login detected');
  const viewA = manager.views.get(a.id);
  assert.equal(viewA.webContents.getLastWebPreferences().nodeIntegration, false);
  assert.equal(viewA.webContents.getLastWebPreferences().webSecurity, true);
  assert.equal(await viewA.webContents.executeJavaScript('typeof window.desktopBridge'), 'undefined');
  assert.throws(() => handlers.get('douyin-workspace:add-account')({
    sender: viewA.webContents, senderFrame: viewA.webContents.mainFrame,
  }), /无效/);
  await viewA.webContents.loadURL('https://fxg.jinritemai.com/backend');
  await manager.probeAccount(a.id);
  assert.equal(manager.getState().accounts[0].loginStatus, 'unknown');
  assert.match(manager.getState().accounts[0].statusDetail, /耳机按钮/);
  assert.equal(registry.get('user-a', a.id).externalAccountId, null, 'backend text cannot bind an identity');
  await viewA.webContents.executeJavaScript('document.getElementById("customer-service").click()');
  await waitFor(() => viewA.webContents.getURL().includes('im.jinritemai.com'), 'in-page customer service entry');
  assert.equal(manager.views.get(a.id), viewA);
  assert.equal(manager.popups.get(a.id).size, 0);
  assert.equal(BrowserWindow.getAllWindows().length, 2, 'no second platform window');
  await waitFor(async () => { await manager.probeAccount(a.id); return manager.getState().accounts[0]?.imReady; }, 'im.jinritemai.com identity');
  assert.equal(manager.getState().accounts[0].loginStatus, 'online');
  assert.equal(await viewA.webContents.executeJavaScript('window.sendCalls'), 0);
  assert.equal(manager.getState().navigation.canGoBack, true);
  manager.goBack();
  await waitFor(() => viewA.webContents.getURL().endsWith('/backend') && !viewA.webContents.isLoading(), 'back to backend');
  assert.equal(manager.getState().navigation.canGoForward, true);
  manager.goForward();
  await waitFor(() => viewA.webContents.getURL().includes('im.jinritemai.com') && !viewA.webContents.isLoading(), 'forward to customer service');
  await viewA.webContents.loadURL('https://fxg.jinritemai.com/home');
  await waitFor(async () => { await manager.probeAccount(a.id); return manager.getState().accounts[0]?.imReady; }, 'nested IM frame');
  assert.equal(registry.get('user-a', a.id).alias, `测试抖店 ${fixtures.get(viewA.webContents.session).shopId}`);
  assert.equal(manager.getState().accounts[0].collectionStatus, 'idle');
  assert.equal(rpa.accounts.get('douyin')[0].metadataJson.message_send_enabled, true);
  await viewA.webContents.loadURL('https://pigeon.jinritemai.com/im?ticket=secret#secret');
  await manager.probeAccount(a.id);
  assert.equal(registry.get('user-a', a.id).lastUrl, 'https://pigeon.jinritemai.com/im');
  assert.equal(await viewA.webContents.executeJavaScript('window.sendCalls'), 0);
  await viewA.webContents.executeJavaScript('localStorage.setItem("store-marker","A")');
  await viewA.webContents.executeJavaScript(`
    window.fixtureNext = function () { return 123; };
    window.__PLATFORM_VARIABLES_IN_BENCH__.extra.im._message$ = { next: window.fixtureNext };
    undefined;
  `);
  await manager.startObservation(a.id);
  assert.equal(manager.observations.get(a.id).active, true);
  assert.equal(await viewA.webContents.executeJavaScript(`window.__PLATFORM_VARIABLES_IN_BENCH__.extra.im._message$.next({
    conversationId:'buyer:${fixtures.get(viewA.webContents.session).shopId}::2:1:pigeon',
    senderRole:'1', messageId:'9007199254740993', content:'fixture-private-body'
  })`), 123);
  await manager.pollObservation(a.id);
  const samples = manager.observations.get(a.id).buffer;
  assert.ok(samples.records.some((entry) => entry.kind === 'message'));
  assert.ok(!JSON.stringify(samples.export()).includes('fixture-private-body'));
  assert.equal(await viewA.webContents.executeJavaScript('window.sendCalls'), 0, 'observer never sends');
  await manager.stopObservation(a.id);
  assert.equal(await viewA.webContents.executeJavaScript('window.__PLATFORM_VARIABLES_IN_BENCH__.extra.im._message$.next === window.fixtureNext'), true);
  assert.ok(manager.observations.get(a.id).buffer.records.length, 'stopped samples remain exportable');
  await manager.startObservation(a.id);
  await viewA.webContents.loadURL('https://pigeon.jinritemai.com/im');
  assert.equal(manager.observations.get(a.id).active, false, 'navigation stops observer');
  await manager.probeAccount(a.id);
  await viewA.webContents.session.cookies.set({ url: 'https://pigeon.jinritemai.com', name: 'fixture-login', value: 'A', expirationDate: Date.now() / 1000 + 86400 });
  manager.addAccount();
  const b = registry.list('user-a')[1];
  const viewB = manager.views.get(b.id);
  await viewB.webContents.loadURL('https://pigeon.jinritemai.com/im');
  await manager.probeAccount(b.id);
  assert.match(b.partition, /^persist:douyin-/);
  assert.notEqual(a.partition, b.partition);
  assert.equal(await viewB.webContents.executeJavaScript('localStorage.getItem("store-marker")'), null);
  assert.equal((await viewB.webContents.session.cookies.get({ name: 'fixture-login' })).length, 0);
  manager.renameAccount(a.id, '我的抖店');
  await manager.probeAccount(a.id);
  assert.equal(registry.get('user-a', a.id).alias, '我的抖店');
  const aFixture = fixtures.get(viewA.webContents.session);
  const originalId = aFixture.shopId;
  aFixture.shopId = 'different-shop';
  await manager.probeAccount(a.id);
  assert.equal(registry.get('user-a', a.id).loginStatus, 'account_mismatch');
  assert.equal(registry.get('user-a', a.id).externalAccountId, originalId);
  aFixture.shopId = originalId;
  await manager.probeAccount(a.id);
  const bFixture = fixtures.get(viewB.webContents.session);
  const bShopId = bFixture.shopId;
  bFixture.shopId = originalId;
  await manager.probeAccount(b.id);
  assert.equal(registry.get('user-a', b.id).loginStatus, 'account_mismatch');
  bFixture.shopId = bShopId;
  await manager.probeAccount(b.id);
  aFixture.expired = true;
  await manager.probeAccount(a.id);
  assert.equal(registry.get('user-a', a.id).loginStatus, 'login_required');
  assert.equal(manager.getState().accounts[0].imReady, false);
  aFixture.expired = false;
  await manager.probeAccount(a.id);
  // Exercise automatic reception through a real Electron frame and server account binding.
  await viewA.webContents.executeJavaScript(`
    window.__PLATFORM_VARIABLES_IN_BENCH__.extra.im._message$ = { next() { return 123; } };
    undefined;
  `);
  const rawCustomer = { securityConversationId: `buyer:${originalId}::2:1:pigeon`,
    serverId: '9007199254740993', type: 1000, content: 'same text', createdAt: '2026-09-11T07:30:00.000Z',
    ext: { 's:sender_biz_role': 'Buyer', shop_id: originalId, type: 'text', attention: 'true', nickname: '测试买家' } };
  rpa.emit('bindings', [{ platform_code: 'douyin', local_account_id: a.id, platform_account_id: 'server-account-a' }]);
  await waitFor(() => manager.collectors.get(a.id)?.frames.size > 0 && !manager.collectors.get(a.id)?.busy, 'automatic collection bound');
  // Product diagnostics use the bound shop frame without stopping its collector.
  const collectorBeforeProducts = manager.collectors.get(a.id);
  const productSample = await manager.probeProducts(a.id);
  assert.equal(productSample.report.outcome, 'candidate_success');
  assert.match(productSample.preview[0], /3830227192483283126/);
  assert.equal(aFixture.productBody.page_no, 0);
  assert.equal(aFixture.productCalls, 1);
  assert.equal(manager.collectors.get(a.id), collectorBeforeProducts);
  assert.equal(collectorBeforeProducts.active, true);
  assert.equal(rpa.events.length, 0, 'diagnostic query never creates product or message events');
  assert.ok(!JSON.stringify(manager.productProbeReports.get(a.id)).includes('private-product-title'));
  const originalSaveDialog = dialog.showSaveDialog;
  const samplePath = path.join(userDataPath, 'product-probe.json');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: samplePath });
  try { await manager.exportProductProbe(a.id); } finally { dialog.showSaveDialog = originalSaveDialog; }
  const exportedProducts = JSON.parse(fs.readFileSync(samplePath, 'utf8'));
  assert.equal(exportedProducts.kind, 'douyin_product_list_probe');
  assert.ok(!JSON.stringify(exportedProducts).includes('3830227192483283126'));
  manager.selectAccount(b.id);
  await manager.probeProducts(a.id);
  assert.equal(aFixture.productCalls, 2, 'hidden shop remains the query target');
  assert.equal(fixtures.get(manager.views.get(b.id).webContents.session).productCalls, undefined);
  // A pending response is cancelled and discarded on explicit navigation.
  let releaseProducts;
  aFixture.waitProducts = new Promise((resolve) => { releaseProducts = resolve; });
  const staleProducts = manager.probeProducts(a.id).then(() => 'unexpected', () => 'discarded');
  await waitFor(() => aFixture.productCalls === 3, 'product request in flight');
  await assert.rejects(manager.probeProducts(a.id), /正在运行/);
  await viewA.webContents.loadURL('https://pigeon.jinritemai.com/im?after-products');
  releaseProducts();
  aFixture.waitProducts = null;
  assert.equal(await staleProducts, 'discarded');
  assert.equal(manager.productProbeReports.has(a.id), false);
  await manager.probeAccount(a.id);
  await manager.stopCollector(a.id);
  await viewA.webContents.executeJavaScript('window.__PLATFORM_VARIABLES_IN_BENCH__.extra.im._message$ = { next() { return 123; } }; undefined;');
  await manager.startCollector(a.id);
  await waitFor(async () => { await manager.pollCollector(a.id); return manager.collectors.get(a.id)?.frames.size > 0 && !manager.collectors.get(a.id)?.busy; }, 'collector after product navigation');
  await manager.refreshStoreProducts({ platformAccountId: 'server-account-a' });
  const productEvent = rpa.events.pop();
  assert.equal(productEvent.event_type, 'store_products_snapshot');
  assert.equal(productEvent.platform_account_id, 'server-account-a');
  assert.equal(productEvent.payload_json.products[0].product_id, '3830227192483283126');
  assert.equal(productEvent.payload_json.products[0].price, undefined);
  assert.equal(productEvent.payload_json.products[0].price_label, '¥155.00');
  assert.deepEqual(productEvent.payload_json.products[0].raw_payload, {});
  assert.equal(productEvent.payload_json.page_summary.has_more, false);
  assert.equal(manager.collectors.get(a.id).active, true);
  await assert.rejects(manager.refreshStoreProducts({ platformAccountId: 'unknown-shop' }), /未找到/);
  // Detail diagnostics use the same bound frame and never create business events.
  const eventsBeforeDetails = rpa.events.length;
  const detailSample = await manager.probeProducts(a.id, { productId: '3830227192483283126' });
  assert.equal(detailSample.report.sources.specifications.outcome, 'candidate_success');
  assert.equal(detailSample.report.sources.attributes.outcome, 'candidate_pending_review');
  assert.equal(detailSample.report.sources.attributes.requestAssociation, 'matched');
  assert.equal(detailSample.report.sources.attributes.responseIdentity, 'not_returned');
  assert.equal(detailSample.report.sources.attributes.entryCount, 9);
  assert.equal(detailSample.report.sources.attributes.previewTruncated, false);
  assert.match(detailSample.preview.join('\n'), /模拟尺寸：40×120 \/ 50×150/);
  assert.match(detailSample.preview.join('\n'), /模拟材质：棉/);
  assert.match(detailSample.preview.join('\n'), /模拟属性9：模拟值/);
  assert.match(detailSample.preview.join('\n'), /待原平台核对/);
  assert.equal(rpa.events.length, eventsBeforeDetails);
  assert.equal(manager.collectors.get(a.id).active, true);
  const detailPath = path.join(userDataPath, 'detail-probe.json');
  const originalMessageBox = dialog.showMessageBox;
  dialog.showMessageBox = async (_parent, options) => {
    assert.match(options.detail, /模拟尺寸/);
    return { response: 0 };
  };
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: detailPath });
  try {
    await manager.showProductDetailProbe({ platformAccountId: 'server-account-a', productId: '3830227192483283126' });
  } finally { dialog.showSaveDialog = originalSaveDialog; dialog.showMessageBox = originalMessageBox; }
  const detailExport = JSON.parse(fs.readFileSync(detailPath, 'utf8'));
  assert.equal(detailExport.kind, 'douyin_product_detail_probe');
  assert.equal(detailExport.version, 2);
  assert.equal(detailExport.sources.attributes.responseIdentity, 'not_returned');
  assert.ok(!JSON.stringify(detailExport).includes('模拟尺寸'));
  assert.ok(!JSON.stringify(detailExport).includes('3830227192483283126'));
  assert.equal(rpa.events.length, eventsBeforeDetails);
  // T1 queries staff and inspects SDK capability without calling it.
  await viewA.webContents.executeJavaScript('window.transferCalls=0; window.__PLATFORM_VARIABLES_IN_BENCH__.extra.im.pigeonIM={transferConversation(){window.transferCalls++}}; undefined;');
  const transferExportPath = path.join(userDataPath, 'transfer-probe.json');
  let transferDialogs = 0;
  dialog.showMessageBox = async (_parent, info) => {
    transferDialogs++;
    assert.match(info.detail, /候选客服甲/); assert.match(info.detail, /尚未验证执行/);
    assert.ok(!info.detail.includes('private-staff-mobile'));
    return { response: 0 };
  };
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: transferExportPath });
  try {
    await manager.transferProbe.show(a.id);
    const exported = fs.readFileSync(transferExportPath, 'utf8');
    assert.equal(JSON.parse(exported).kind, 'douyin_transfer_probe');
    assert.equal(JSON.parse(exported).previewCount, 1);
    for (const secret of ['候选客服甲', 'private-staff-account', 'private-staff-mobile', '9007199254740993111'])
      assert.ok(!exported.includes(secret));
    assert.equal(await viewA.webContents.executeJavaScript('window.transferCalls'), 0);
    assert.equal(rpa.events.length, eventsBeforeDetails);
    let releaseStaff;
    aFixture.waitStaff = new Promise((resolve) => { releaseStaff = resolve; });
    const cancelled = manager.transferProbe.show(a.id).then(() => 'unexpected', () => 'discarded');
    await waitFor(() => aFixture.staffCalls === 2, 'staff request in flight');
    await assert.rejects(manager.transferProbe.show(a.id), /正在运行/);
    manager.transferProbe.clear(a.id);
    releaseStaff(); aFixture.waitStaff = null;
    assert.equal(await cancelled, 'discarded');
    assert.equal(transferDialogs, 1);
    assert.equal(manager.transferProbe.reports.size, 0);
    assert.equal(await viewA.webContents.executeJavaScript('window.transferCalls'), 0);
  } finally { dialog.showMessageBox = originalMessageBox; dialog.showSaveDialog = originalSaveDialog; }
  // T2 observes a simulated native transfer, with the business collector still active.
  const transferObservationPath = path.join(userDataPath, 'transfer-observation.json');
  dialog.showMessageBox = async () => ({ response: 0 });
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: transferObservationPath });
  try {
    await viewA.webContents.executeJavaScript(`window.transferOriginal=window.__PLATFORM_VARIABLES_IN_BENCH__.extra.im.pigeonIM.transferConversation=function(){
      window.transferCalls++; window.transferPromise=Promise.resolve(null);
      return window.transferPromise;
    }; undefined;`);
    await manager.transferObservation.start(a.id);
    await assert.rejects(manager.transferObservation.start(a.id), /正在运行/);
    assert.equal(await viewA.webContents.executeJavaScript('window.transferCalls'), 0);
    const testCid = `transfer-test-buyer:${aFixture.shopId}::2:1:pigeon`;
    assert.equal(await viewA.webContents.executeJavaScript(`window.__PLATFORM_VARIABLES_IN_BENCH__.extra.im.pigeonIM.transferConversation('2',${JSON.stringify(testCid)},'9007199254740993111')===window.transferPromise`), true);
    await viewA.webContents.executeJavaScript(`window.__PLATFORM_VARIABLES_IN_BENCH__.extra.im._message$.next({conversationId:${JSON.stringify(testCid)},
      createdAt:new Date('2026-09-19T06:12:02.075Z'),type:9001,__internal_ctx:{privateInternal:'private-context'},
      ext:{type:'fixture_transfer_event',transfer_type:'3',to_trans_uid:'9007199254740993111',
        flow_extra:'{"target":"9007199254740993111","content":"private-flow"}'}});undefined;`);
    await manager.transferObservation.export(a.id);
    const exported = fs.readFileSync(transferObservationPath, 'utf8');
    const sample = JSON.parse(exported);
    assert.equal(sample.kind, 'douyin_transfer_observation'); assert.equal(sample.calls, 1);
    assert.equal(sample.version, 2);
    assert.ok(sample.records.some((r) => r.kind === 'transfer_resolved' && r.shape.type === 'null'));
    const eventSample = sample.records.find((r) => r.kind === 'conversation_event');
    assert.equal(eventSample.truncated, false);
    assert.equal(eventSample.eventProtocol[0].fields['ext.type'], 'fixture_transfer_event');
    assert.equal(eventSample.eventProtocol[0].times.createdAt, '2026-09-19T06:12:02.075Z');
    assert.equal(eventSample.eventProtocol[0].flowExtra.parsing, 'json');
    for (const secret of ['transfer-test-buyer', 'staff-1', '9007199254740993111', 'private-flow', 'private-context', '__internal_ctx']) assert.ok(!exported.includes(secret));
    assert.equal(await viewA.webContents.executeJavaScript('window.__PLATFORM_VARIABLES_IN_BENCH__.extra.im.pigeonIM.transferConversation===window.transferOriginal'), true);
    assert.equal(await viewA.webContents.executeJavaScript('window.__acsDouyinTransferObservationV1===undefined'), true);
    await manager.transferObservation.export(a.id); // Exporting the cached sample is repeatable.
    assert.equal(rpa.events.length, eventsBeforeDetails);
    await manager.transferObservation.start(a.id);
    aFixture.expired = true;
    await assert.rejects(manager.transferObservation.stop(a.id), /无法核验/);
    aFixture.expired = false;
    assert.equal(manager.transferObservation.sessions.size, 0);
    assert.equal(await viewA.webContents.executeJavaScript('window.__PLATFORM_VARIABLES_IN_BENCH__.extra.im.pigeonIM.transferConversation===window.transferOriginal'), true);
    let releaseObservationIdentity;
    aFixture.waitIdentity = new Promise((resolve) => { releaseObservationIdentity = resolve; });
    const interruptedObservation = manager.transferObservation.start(a.id).then(() => 'unexpected', () => 'cancelled');
    await waitFor(() => viewA.webContents.executeJavaScript('Boolean(window.__acsDouyinTransferObservationV1)'), 'observation startup');
    manager.transferObservation.clear(a.id);
    releaseObservationIdentity(); aFixture.waitIdentity = null;
    assert.equal(await interruptedObservation, 'cancelled');
    assert.equal(await viewA.webContents.executeJavaScript('window.__PLATFORM_VARIABLES_IN_BENCH__.extra.im.pigeonIM.transferConversation===window.transferOriginal'), true);
  } finally { aFixture.expired = false; dialog.showMessageBox = originalMessageBox; dialog.showSaveDialog = originalSaveDialog; }
  // T3 uses the real main-process controller and embedded SDK; API persistence is mocked.
  const transferApi = manager.transfer.api;
  const manualCid = `manual-transfer-buyer:${aFixture.shopId}::2:1:pigeon`, manualConversationId = 'c'.repeat(32);
  let manualOperation = null, manualFinish = null;
  aFixture.staffId = '9007199254740993555'; await manager.probeAccount(a.id);
  manager.transfer.api = async (_user, url, body) => {
    if (url.endsWith('/transfer-context') || url.includes('/douyin/auto-transfer/')) return { conversationId: manualConversationId, platformAccountId:'server-account-a',
      localAccountId:a.id, shopId:aFixture.shopId, staffId:aFixture.staffId, cid:manualCid, transfer:manualOperation };
    if (url.endsWith('/transfer/begin')) {
      assert.equal(body.target_id,'9007199254740993111');assert.equal(body.source_id,aFixture.staffId);
      manualOperation={id:body.auto_task_id ? manualOperation.id : 'b'.repeat(32),status:'transferring'}; return manualOperation;
    }
    if (url.endsWith('/transfer/finish')) { manualFinish=body; manualOperation.status=body.outcome; return manualOperation; }
    return transferApi(_user,url,body);
  };
  try {
    await viewA.webContents.executeJavaScript(`window.manualTransfers=0;
      window.__PLATFORM_VARIABLES_IN_BENCH__.extra.im.pigeonIM.transferConversation=function(...args){window.manualTransfers++;
        if(args.length!==3)throw new Error('argument mismatch');
        const im=window.__PLATFORM_VARIABLES_IN_BENCH__.extra.im;
        im._message$.next({securityConversationId:args[1],createdAt:new Date(),serverId:'7777777777777777777',
          originSender:${JSON.stringify(aFixture.staffId)},serverStatus:0,isOffline:false,pullSource:1,
          ext:{security_biz_conversation_id:args[1],shop_id:${JSON.stringify(aFixture.shopId)},
            src_user_id:${JSON.stringify(aFixture.staffId)},to_trans_uid:args[2]}});
        return Promise.resolve(null);
      };undefined;`);
    assert.throws(()=>handlers.get('douyin-workspace:list-transfer-targets')({sender:viewA.webContents,senderFrame:viewA.webContents.mainFrame},
      {conversationId:manualConversationId}),/无效/);
    const event={sender:keeper.webContents,senderFrame:keeper.webContents.mainFrame};
    const roster=await handlers.get('douyin-workspace:list-transfer-targets')(event,{conversationId:manualConversationId});
    assert.equal(roster.cs_list.length,1);assert.equal(roster.cs_list[0].onlineLabel,'在线');
    aFixture.staffStatus=0;
    await assert.rejects(manager.transfer.transfer({conversationId:manualConversationId,targetCsid:roster.cs_list[0].csid}),/不在线/);
    assert.equal(manualOperation,null);assert.equal(await viewA.webContents.executeJavaScript('window.manualTransfers'),0);
    aFixture.staffStatus=1;
    const result=await handlers.get('douyin-workspace:transfer-conversation')(event,
      {conversationId:manualConversationId,targetCsid:roster.cs_list[0].csid,reason:'人工转接'});
    assert.equal(result.status,'transferred');assert.equal(manualFinish.outcome,'transferred');
    assert.equal(manualFinish.evidence.conversation_id,manualCid);assert.equal(manualFinish.evidence.sdk_resolved,true);
    assert.equal(await viewA.webContents.executeJavaScript('window.manualTransfers'),1);
    await assert.rejects(manager.transfer.list({conversationId:manualConversationId}),/勿重复/);
    manager.transfer.running.add(a.id);
    await assert.rejects(manager.transfer.validateSend({user_id:'user-a',platform_account_id:'server-account-a'}),/暂停发送/);
    manager.transfer.running.delete(a.id);
    // T4: real page roster + automatic controller, using an isolated mock operation.
    manualOperation = { id: 'd'.repeat(32), status: 'preparing' };
    const autoTask = { id: 'e'.repeat(32), user_id: 'user-a', platform_account_id: 'server-account-a',
      conversation_id: manualConversationId, task_type: 'douyin_transfer_prepare',
      payload_json: { douyin_auto_operation_id: manualOperation.id } };
    aFixture.staffStatus = 0;
    assert.equal((await manager.transfer.automatic(autoTask)).status, 'no_online_target');
    assert.equal(await viewA.webContents.executeJavaScript('window.manualTransfers'), 1);
    aFixture.staffStatus = 1;
    const prepared = await manager.transfer.automatic(autoTask);
    assert.equal(prepared.target.id, '9007199254740993111');
    manualOperation = { ...manualOperation, status: 'ready', target_id: prepared.target.id };
    const automated = await manager.transfer.automatic({ ...autoTask, task_type: 'douyin_transfer_execute' });
    assert.equal(automated.status, 'transferred');
    assert.equal(manualFinish.outcome, 'transferred');
    assert.equal(await viewA.webContents.executeJavaScript('window.manualTransfers'), 2);
  } finally { manager.transfer.api=transferApi; aFixture.staffStatus=1; }
  const detailTask = { id: 'detail-task', user_id: 'user-a', platform_code: 'douyin',
    platform_account_id: 'server-account-a', task_type: 'refresh_product_details',
    payload_json: { platform_account_id: 'server-account-a', product_ids: ['3830227192483283126'] } };
  const beforeDetailCalls = aFixture.detailCalls;
  await Promise.all([manager.handleProductDetailTask(detailTask), manager.handleProductDetailTask(detailTask)]);
  assert.equal(aFixture.detailCalls, beforeDetailCalls + 2, 'duplicate dispatch shares one read');
  assert.equal(rpa.completions.length, 1);
  assert.equal(rpa.completions[0][1], 'completed');
  const persistedDetail = rpa.completions[0][2].product_details[0];
  assert.equal(persistedDetail.attributes.response_identity, 'not_returned');
  assert.equal(persistedDetail.attributes.entries.length, 9);
  assert.equal(persistedDetail.specifications.skus.length, 1);
  assert.equal(rpa.events.length, eventsBeforeDetails, 'formal read never emits messages');
  assert.equal(await viewA.webContents.executeJavaScript('window.sendCalls'), 0);
  await manager.handleProductDetailTask({ ...detailTask, id: 'wrong-detail',
    payload_json: { ...detailTask.payload_json, platform_account_id: 'other-shop' } });
  assert.equal(rpa.completions.at(-1)[1], 'failed');
  assert.equal(aFixture.detailCalls, beforeDetailCalls + 2);

  const callsBeforeUnowned = aFixture.detailCalls;
  const unowned = await manager.probeProducts(a.id, { productId: '999' });
  assert.equal(unowned.report.ownership.error, 'ownership_unverified');
  assert.equal(aFixture.detailCalls, callsBeforeUnowned);
  let releaseDetails;
  aFixture.waitDetails = new Promise((resolve) => { releaseDetails = resolve; });
  const staleDetails = manager.probeProducts(a.id, { productId: '3830227192483283126' }).then(() => 'unexpected', () => 'discarded');
  await waitFor(() => aFixture.detailCalls === callsBeforeUnowned + 2, 'detail requests in flight');
  await viewA.webContents.loadURL('https://pigeon.jinritemai.com/im?after-details');
  releaseDetails(); aFixture.waitDetails = null;
  assert.equal(await staleDetails, 'discarded');
  assert.equal(manager.productDetailProbeReports.has(a.id), false);
  await manager.probeAccount(a.id);
  await manager.stopCollector(a.id);
  await viewA.webContents.executeJavaScript('window.__PLATFORM_VARIABLES_IN_BENCH__.extra.im._message$ = { next() { return 123; } }; undefined;');
  await manager.startCollector(a.id);
  await waitFor(async () => { await manager.pollCollector(a.id); return manager.collectors.get(a.id)?.frames.size > 0 && !manager.collectors.get(a.id)?.busy; }, 'collector after details');
  rawCustomer.createdAt = new Date().toISOString();
  for (const message of [rawCustomer, rawCustomer, { ...rawCustomer, serverId: '9007199254740994' },
    { ...rawCustomer, serverId: 'wrong-shop', securityConversationId: 'buyer:wrong::2:1:pigeon' }]) {
    assert.equal(await viewA.webContents.executeJavaScript(`window.__PLATFORM_VARIABLES_IN_BENCH__.extra.im._message$.next(${JSON.stringify(message)})`), 123);
  }
  manager.selectAccount(b.id);
  await manager.pollCollector(a.id);
  assert.equal(rpa.events.length, 2, 'same ID merges, identical bodies with distinct IDs survive, wrong shop rejected');
  assert.ok(rpa.events.every((event) => event.platform_account_id === 'server-account-a' && event.payload_json.automation_mode === 'trigger'));
  // Order diagnostics are driven by a customer identity observed by the main process.
  const orderPayload = { platformAccountId: 'server-account-a', externalConversationId: rawCustomer.securityConversationId, requestId: 'order-test' };
  const orderCaller = { sender: keeper.webContents, senderFrame: keeper.webContents.mainFrame };
  const orderHandler = handlers.get('douyin-workspace:probe-orders');
  assert.throws(() => orderHandler({ sender: viewA.webContents, senderFrame: viewA.webContents.mainFrame }, orderPayload), /请求无效/);
  await assert.rejects(manager.orderProbe.show({ ...orderPayload, externalConversationId: `stranger:${originalId}::2:1:pigeon` }, keeper), /尚未采集/);
  assert.equal(aFixture.orderCalls, undefined);
  const orderExport = path.join(userDataPath, 'orders-probe.json');
  let orderDialogs = 0;
  dialog.showMessageBox = async (_parent, info) => {
    orderDialogs++;
    assert.match(info.detail, /模拟规格甲/); assert.match(info.detail, /模拟规格乙/);
    assert.match(info.detail, /actual_pay_amount：99/); assert.ok(!info.detail.includes('private-mobile'));
    return { response: 0 };
  };
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: orderExport });
  try {
    await orderHandler(orderCaller, orderPayload);
    assert.equal(orderDialogs, 1);
    assert.equal(aFixture.orderBody.security_user_id, 'buyer');
    assert.equal(aFixture.orderBody.page_size, 5);
    const exported = fs.readFileSync(orderExport, 'utf8');
    assert.equal(JSON.parse(exported).kind, 'douyin_orders_probe');
    for (const secret of ['9007199254740993999', 'private-mobile', '模拟规格甲', '订单模拟商品甲']) assert.ok(!exported.includes(secret));
    assert.equal(rpa.events.length, 2, 'order diagnostics never create business events');
    assert.equal(await viewA.webContents.executeJavaScript('window.sendCalls'), 0);
    let releaseOrders;
    aFixture.waitOrders = new Promise((resolve) => { releaseOrders = resolve; });
    const cancelled = orderHandler(orderCaller, { ...orderPayload, requestId: 'cancel-order' }).then(() => 'unexpected', () => 'discarded');
    await waitFor(() => aFixture.orderCalls === 2, 'order request in flight');
    handlers.get('douyin-workspace:cancel-order-probe')(orderCaller, { requestId: 'cancel-order' });
    releaseOrders(); aFixture.waitOrders = null;
    assert.equal(await cancelled, 'discarded');
    assert.equal(orderDialogs, 1, 'changing the message-center conversation suppresses the old dialog');
    assert.equal(manager.orderProbe.reports.has(a.id), false);
  } finally { dialog.showMessageBox = originalMessageBox; dialog.showSaveDialog = originalSaveDialog; }
  // Formal reads use the same real frame and collected identity, without dialogs,
  // messaging events, or the text send actor. Duplicate delivery shares one read.
  const orderTask = { id: 'formal-orders', user_id: manager.userId, platform_code: 'douyin',
    platform_account_id: 'server-account-a', task_type: 'refresh_customer_orders', payload_json: {
      source: 'douyin_orders_v1', platform_account_id: 'server-account-a', shop_id: originalId,
      external_conversation_id: rawCustomer.securityConversationId } };
  const orderCallsBefore = aFixture.orderCalls;
  const completedBefore = rpa.completions.length;
  dialog.showMessageBox = async () => { throw new Error('formal read must not open a dialog'); };
  try {
    await Promise.all([manager.handleOrderTask(orderTask), manager.handleOrderTask(orderTask)]);
    assert.equal(aFixture.orderCalls, orderCallsBefore + 1);
    assert.equal(rpa.completions.length, completedBefore + 1);
    assert.equal(rpa.completions.at(-1)[1], 'completed');
    const snapshot = rpa.completions.at(-1)[2].orders_snapshot;
    assert.equal(snapshot.orders[0].products.length, 2);
    assert.equal(snapshot.orders[0].products[0].quantity, 2);
    assert.equal(snapshot.buyer_id, 'buyer');
    assert.ok(!JSON.stringify(snapshot).includes('private-mobile'));
    assert.ok(!JSON.stringify(snapshot).includes('actual_pay_amount'));
    assert.equal(rpa.events.length, 2);
    assert.equal(await viewA.webContents.executeJavaScript('window.sendCalls'), 0);
    await manager.handleOrderTask({ ...orderTask, id: 'wrong-order-target', payload_json: {
      ...orderTask.payload_json, external_conversation_id: `stranger:${originalId}::2:1:pigeon` } });
    assert.equal(rpa.completions.at(-1)[1], 'failed');
    assert.equal(aFixture.orderCalls, orderCallsBefore + 1);
  } finally { dialog.showMessageBox = originalMessageBox; }
  aFixture.messages = [{ ...rawCustomer, serverId: undefined, serverMessageId: rawCustomer.serverId,
    type: undefined, msgType: 1000, createTime: '1789111800000' }];
  await manager.stopCollector(a.id);
  await manager.startCollector(a.id);
  await waitFor(async () => { await manager.pollCollector(a.id); return rpa.events.length > 2; }, 'compensation received after collector restart');
  assert.equal(rpa.events[0].dedup_key, rpa.events[2].dedup_key, 'cross-source dedup is stable');
  assert.notEqual(rpa.events[0].event_id, rpa.events[2].event_id, 'changed envelope can safely pass durable queue');
  assert.equal(rpa.events[2].payload_json.automation_mode, 'ignore', 'startup compensation never triggers AI');
  aFixture.messages = null;
  // Real-frame non-text collection uses the same normalized payload as text.
  for (const [id, ext, content] of [
    ['product-live', {type:'template_card', goods_id:'9007199254740993001',
      static_data:JSON.stringify({sale_goods:[{product_id:'9007199254740993001',product_name_two_lines:'模拟商品',
        img:'https://cdn.example.test/product.jpg',current_price:{prefix:'¥',price:'155.00'}}]})}, '[商品]'],
    ['photo-live', {type:'file_image',imageUrl:'https://cdn.example.test/photo.jpg'}, '[图片]'],
  ]) {
    const message = {...rawCustomer,serverId:id,content,createdAt:new Date().toISOString(),ext:{...rawCustomer.ext,...ext}};
    await viewA.webContents.executeJavaScript(`window.__PLATFORM_VARIABLES_IN_BENCH__.extra.im._message$.next(${JSON.stringify(message)})`);
    await waitFor(async () => { await manager.pollCollector(a.id); return rpa.events.some(event => event.platform_message_id === id); }, id);
    const payload = rpa.events.find(event => event.platform_message_id === id).payload_json;
    assert.equal(payload.automation_mode, 'trigger');
    assert.equal(payload.message_type, id === 'product-live' ? 'product' : 'image');
    assert.equal(payload.display_mode, id === 'product-live' ? 'card' : 'bubble');
    assert.ok(payload.structured_payload.image_url.startsWith('https://cdn.example.test/'));
    assert.equal(payload.diagnosticPayloads, undefined);
    if (id === 'product-live') assert.equal(payload.structured_payload.title, '模拟商品');
  }
  const unknownCard = {...rawCustomer,serverId:'unknown-live',content:'[订单卡片]',createdAt:new Date().toISOString(),
    ext:{...rawCustomer.ext,type:'template_card',static_data:JSON.stringify({title:'模拟未知卡片',order_id:'1234567890123456789',
      buttons:[{text:'申请退款'}],token:'secret-token',receiver_address:'secret-address'})}};
  await viewA.webContents.executeJavaScript(`window.__PLATFORM_VARIABLES_IN_BENCH__.extra.im._message$.next(${JSON.stringify(unknownCard)})`);
  await waitFor(async () => { await manager.pollCollector(a.id); return rpa.events.some(e=>e.platform_message_id==='unknown-live'); },'unknown core');
  const unknownPayload = rpa.events.find(e=>e.platform_message_id==='unknown-live').payload_json;
  assert.equal(unknownPayload.message_type,'unknown');
  assert.equal(unknownPayload.automation_mode,'trigger');
  assert.ok(JSON.stringify(unknownPayload.structured_payload.message_core).includes('模拟未知卡片'));
  assert.ok(!JSON.stringify(unknownPayload).includes('secret-'));
  assert.ok(!JSON.stringify(unknownPayload).includes('申请退款'));
  // Exercise actual frame serialization, durable task results and store routing.
  await viewA.webContents.executeJavaScript(`window.__PLATFORM_VARIABLES_IN_BENCH__.extra.im.sendText = async function(cid, content) {
    window.sendCalls++; window.lastSend = {cid,content};
    return {securityConversationId:cid,content,serverId:'991',serverStatus:0,createdAt:new Date(),
      ext:{'s:sender_biz_role':'CurrentServer','s:send_response_status':'0','s:send_response_check_code':'0'}};
  }; undefined;`);
  const sendTask = { id: 'send-fixture-1', user_id: 'user-a', platform_code: 'douyin', task_type: 'send_message',
    platform_account_id: 'server-account-a', payload_json: { source: 'desktop', platform_account_id: 'server-account-a',
      external_conversation_id: rawCustomer.securityConversationId, content: '测试文本\n第二行' } };
  await manager.handleSendTask(sendTask);
  await waitFor(() => rpa.events.some((event) => event.event_type === 'douyin_send_result'
    && event.payload_json.task_id === sendTask.id && event.payload_json.status === 'completed'), 'send confirmed');
  assert.equal(await viewA.webContents.executeJavaScript('window.sendCalls'), 1);
  assert.equal(await viewB.webContents.executeJavaScript('window.sendCalls'), 0, 'inactive store receives its own task only');
  await manager.handleSendTask(sendTask);
  assert.equal(await viewA.webContents.executeJavaScript('window.sendCalls'), 1, 'task replay does not send twice');
  await manager.handleSendTask({ ...sendTask, id: 'wrong-shop-send', payload_json: {
    ...sendTask.payload_json, external_conversation_id: 'buyer:wrong::2:1:pigeon' } });
  assert.equal(await viewA.webContents.executeJavaScript('window.sendCalls'), 1);
  assert.ok(rpa.events.some((event) => event.payload_json.task_id === 'wrong-shop-send' && event.payload_json.status === 'failed'));
  await viewA.webContents.executeJavaScript(`window.__PLATFORM_VARIABLES_IN_BENCH__.extra.im.sendText = async function(cid, content) {
    window.sendCalls++;
    return {securityConversationId:cid, content, serverId:'992',
      ext:{'s:sender_biz_role':'CurrentServer','s:client_message_id':'client-992'}};
  }; undefined;`);
  const correlationTask = { ...sendTask, id: 'send-fixture-correlation' };
  await manager.handleSendTask(correlationTask);
  await waitFor(() => rpa.events.some((event) => event.payload_json.task_id === correlationTask.id
    && event.payload_json.sdk_platform_message_id === '992'), 'pending SDK identity persisted for echo reconciliation');
  assert.equal(manager.sendJournal.get(correlationTask.id).result.sdk_client_message_id, 'client-992');
  assert.equal(await viewA.webContents.executeJavaScript('window.sendCalls'), 2);
  // Automatic text uses the same SDK/journal, with a fresh server authorization check.
  const realFetch = globalThis.fetch;
  rpa.userId = 'user-a';
  rpa.accessToken = 'fixture-only';
  rpa.apiBaseUrl = 'http://fixture.invalid';
  let allowAuto = true;
  let validations = 0;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /\/automation\/douyin-tasks\/auto-fixture/);
    validations++;
    return Response.json({ allowed: allowAuto, reason: '机器人已暂停' });
  };
  try {
    const autoTask = { ...sendTask, id: 'auto-fixture', payload_json: { ...sendTask.payload_json, source: 'automation' } };
    await manager.handleSendTask(autoTask);
    assert.equal(await viewA.webContents.executeJavaScript('window.sendCalls'), 3);
    await manager.handleSendTask(autoTask);
    assert.equal(await viewA.webContents.executeJavaScript('window.sendCalls'), 3, 'auto task replay cannot resend');
    assert.equal(validations, 1);
    allowAuto = false;
    await manager.handleSendTask({ ...autoTask, id: 'auto-fixture-disabled' });
    assert.equal(await viewA.webContents.executeJavaScript('window.sendCalls'), 3, 'disabled robot never calls SDK');
    assert.ok(rpa.events.some((event) => event.payload_json.task_id === 'auto-fixture-disabled' && event.payload_json.status === 'failed'));
    globalThis.fetch = async () => { throw new Error('fixture offline'); };
    await manager.handleSendTask({ ...autoTask, id: 'auto-fixture-offline' });
    assert.equal(await viewA.webContents.executeJavaScript('window.sendCalls'), 3, 'validation failure never calls SDK');
    const collector = manager.collectors.get(a.id);
    manager.enqueueDouyinMessage(a.id, 'server-account-a', { ...rawCustomer, serverId: 'old-live', createdAt: '2026-01-01T00:00:00.000Z' },
      viewA.webContents.getURL(), collector);
    assert.equal(rpa.events.at(-1).payload_json.automation_mode, 'ignore', 'old live delivery cannot trigger AI');
    manager.enqueueDouyinMessage(a.id, 'server-account-a', { ...rawCustomer, serverId: 'image-live', type: 2000 },
      viewA.webContents.getURL(), collector);
    assert.equal(rpa.events.at(-1).payload_json.automation_mode, 'ignore', 'non-text delivery cannot trigger AI');
  } finally { globalThis.fetch = realFetch; }
  manager.selectAccount(a.id);
  // A delayed old-page identity must not turn a newly navigated login page online.
  let releaseIdentity;
  aFixture.waitIdentity = new Promise((resolve) => { releaseIdentity = resolve; });
  const oldProbe = manager.probeAccount(a.id);
  await viewA.webContents.loadURL('https://fxg.jinritemai.com/login/common');
  releaseIdentity();
  await oldProbe;
  aFixture.waitIdentity = null;
  await manager.probeAccount(a.id);
  assert.equal(registry.get('user-a', a.id).loginStatus, 'login_required');
  await viewA.webContents.loadURL('https://pigeon.jinritemai.com/im');
  await manager.probeAccount(a.id);
  manager.selectAccount(a.id);
  manager.setOverlayOpen(true);
  assert.equal(viewA.getVisible(), false);
  manager.setOverlayOpen(false);
  assert.equal(viewA.getVisible(), true);
  await viewA.webContents.executeJavaScript('window.open("https://pigeon.jinritemai.com/im?from=window-open", "fixture-popup"); undefined');
  await waitFor(() => viewA.webContents.getURL().includes('from=window-open') && !viewA.webContents.isLoading(), 'window.open navigates inside shop');
  assert.equal(manager.popups.get(a.id).size, 0);
  assert.equal(manager.views.get(a.id), viewA);
  assert.equal(await viewA.webContents.executeJavaScript('localStorage.getItem("store-marker")'), 'A');
  assert.equal((await viewA.webContents.session.cookies.get({ name: 'fixture-login' }))[0].value, 'A');
  manager.window.close();
  assert.equal(manager.window.isVisible(), false);
  assert.equal(viewA.webContents.isDestroyed(), false);
  await manager.open('user-a');
  assert.equal(manager.window.isVisible(), true);
  assert.equal(viewA.getVisible(), true);
  const contentsBeforePause = viewA.webContents;
  await manager.setAccountPaused(a.id, true);
  assert.equal(contentsBeforePause.isDestroyed(), true);
  assert.equal(manager.views.has(a.id), false);
  await manager.setAccountPaused(a.id, false);
  assert.equal(await manager.views.get(a.id).webContents.executeJavaScript('localStorage.getItem("store-marker")'), 'A');
  await manager.removeAccount(b.id, false);
  assert.equal(registry.list('user-a', { archived: true }).length, 1);
  manager.restoreAccount(b.id);
  await manager.removeAccount(b.id, true);
  assert.equal(registry.get('user-a', b.id), null);
  assert.equal((await session.fromPartition(b.partition).cookies.get({})).length, 0);

  // Coexist with a real PDD manager, with its network replaced by a local page.
  const pddRegistry = new PddAccountRegistry(userDataPath);
  const pdd = new PddWorkspaceManager({ registry: pddRegistry, preloadPath: config.preloadPath,
    rendererPath: config.rendererPath, homeUrl: 'data:text/html,PDD fixture', loadWorkspaceShell: false });
  await pdd.open('user-a');
  await pdd.addAccount();
  assert.match(pddRegistry.list('user-a')[0].partition, /^persist:pdd-/);
  assert.notEqual(pdd.window, manager.window);
  assert.notEqual(pddRegistry.filePath, registry.filePath);
  await pdd.closeForLogout();
  await waitFor(() => manager.views.get(a.id)?.webContents.isLoading() === false, 'resumed page');
  await manager.probeAccount(a.id);
  if (!process.argv.includes('--skip-screenshots')) {
    fs.writeFileSync(path.join(screenshotDirectory, 'workspace.png'), (await manager.window.webContents.capturePage()).toPNG());
    fs.writeFileSync(path.join(screenshotDirectory, 'platform-page.png'), (await manager.views.get(a.id).webContents.capturePage()).toPNG());
  }
  assert.deepEqual(uiErrors, []);
  await manager.closeForLogout();
  assert.equal(manager.views.size, 0);
  assert.equal(manager.orderProbe.identities.size, 0);
  assert.equal(manager.orderProbe.reports.size, 0);
  assert.equal(manager.transferProbe.reports.size, 0);
  assert.equal(manager.transferProbe.pending.size, 0);
  assert.equal(manager.transferObservation.sessions.size, 0);
  assert.equal(manager.timer, null);
  await manager.bindUser('user-b');
  assert.equal(manager.getState().accounts.length, 0);
  assert.throws(() => manager.selectAccount(a.id), /不存在/);
  await manager.closeForLogout();
  const restoredRegistry = new DouyinAccountRegistry(userDataPath);
  const restored = new DouyinWorkspaceManager({ ...config, registry: restoredRegistry, loadWorkspaceShell: false });
  await restored.bindUser('user-a');
  assert.equal(restoredRegistry.get('user-a', a.id).loginStatus, 'unknown');
  await restored.open('user-a');
  const restoredView = restored.views.get(a.id);
  await waitFor(() => !restoredView.webContents.isLoading(), 'restored page');
  await restored.handleSendTask(sendTask);
  assert.equal(await restoredView.webContents.executeJavaScript('window.sendCalls'), 0, 'process recovery replays the result, never the send');
  assert.equal(await restoredView.webContents.executeJavaScript('localStorage.getItem("store-marker")'), 'A');
  assert.equal((await restoredView.webContents.session.cookies.get({ name: 'fixture-login' }))[0].value, 'A');
  await restored.prepareToQuit();
  keeper.destroy();
    console.log(JSON.stringify({ status: 'passed', scope: 'M0/M1/M2/D2/O1/O2/T1/T2/T3/T4 local workspace, reception, manual/AI sends, product details, orders, manual/automatic transfers; no live merchant messages',
    screenshotsSkipped: process.argv.includes('--skip-screenshots'), screenshotDirectory, userDataPath }));
  app.quit();
}).catch((error) => { console.error(error); app.exit(1); });
