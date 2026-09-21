import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { collectProducts } from './products-reader.js';
import { QianniuWorkerManager } from './worker-manager.js';
const require = createRequire(import.meta.url);
const { API, summarize } = require('./products-protocol.cjs');
const { installProductsPage } = require('./products-page.cjs');
const { installOrderPage } = require('./order-page.cjs');
const { createOrderIdentityProtocol } = require('./order-identity-protocol.cjs');
function response(ids, total) {
  return JSON.stringify({ api: API, v: '1.0', ret: ['SUCCESS::ok'], data: { total, itemList: ids.map(id => ({
    itemId: String(id), title: 'Product ' + id, itemUrl: 'https://item.taobao.com/item.htm?id=' + id,
    pic: '//img.alicdn.com/a.png', price: '65.50', quantity: 10, soldQuantity: 3,
  })) } });
}
test('collects complete pages and empty lists, preserving decimal prices', async () => {
  const pages = [];
  const products = await collectProducts(async page => { pages.push(page); return page === 1 ? response([1, 2, 3, 4, 5], 8) : response([6, 7, 8], 8); });
  assert.deepEqual(pages, [1, 2]); assert.equal(products.length, 8);
  assert.equal(products[0].price_label, '¥65.50');
  assert.deepEqual(await collectProducts(async () => response([], 0)), []);
});
test('rejects partial, duplicate, changed totals, oversize and failed pages', async () => {
  for (const replies of [
    [response([1], 8)], [response([1, 2, 3, 4, 5], 8), response([5, 6, 7], 8)],
    [response([1, 2, 3, 4, 5], 8), response([6, 7], 7)], [response([1, 2, 3, 4, 5], 5001)],
    [response([1, 2, 3, 4, 5], 8), '{}'],
  ]) await assert.rejects(collectProducts(async page => replies[page - 1]));
  assert.throws(() => summarize(response([1, 1], 2), 1));
});
test('collects beyond 100 items with progress and rejects timed-out work before querying', async () => {
  const ids = Array.from({ length: 107 }, (_, i) => i + 1), progress = [];
  const products = await collectProducts(async page => response(ids.slice((page - 1) * 5, page * 5), ids.length),
    { onProgress: p => progress.push(p) });
  assert.equal(products.length, 107);
  assert.equal(new Set(products.map(p => p.product_id)).size, 107);
  assert.deepEqual(progress.at(-1), { collected: 107, total: 107, page: 22 });
  assert.ok(progress.every((p, i) => i === 0 || p.collected > progress[i - 1].collected));
  await assert.rejects(collectProducts(() => { throw Error('must not query'); }, { maxDurationMs: 0 }), /超时/);
});
test('worker coalesces store refreshes across conversations and emits one store-only snapshot', async () => {
  const worker = new QianniuWorkerManager({ enabled: true });
  worker.applyBindings([{ platform_code: 'qianniu', local_account_id: 'qianniu-123', platform_account_id: 'account' }]);
  let release, calls = 0;
  const snapshot = { shop_uid: '123', observed_at: new Date().toISOString(), products: [], collection_status: 'empty' };
  worker.productsReader = { read: () => { calls++; return new Promise(resolve => { release = () => resolve(snapshot); }); } };
  const events = []; worker.on('event', event => events.push(event));
  const first = worker.refreshStoreProducts({ platformAccountId: 'account', externalConversationId: 'a' });
  const second = worker.refreshStoreProducts({ platformAccountId: 'account', externalConversationId: 'b' });
  release(); await Promise.all([first, second]);
  assert.equal(calls, 1); assert.equal(events.length, 1);
  assert.equal(events[0].event_type, 'store_products_snapshot');
  assert.equal(events[0].conversation_external_id, undefined);
  assert.equal(worker.getProductSyncStatus('account').status, 'collected');
  assert.equal(worker.getProductSyncStatus('unknown'), null);
  await assert.rejects(worker.refreshStoreProducts({ platformAccountId: 'unknown' }));
});
test('failed later page leaves partial progress but never publishes an incomplete snapshot', async () => {
  const worker = new QianniuWorkerManager({ enabled: true });
  worker.applyBindings([{ platform_code: 'qianniu', local_account_id: 'qianniu-123', platform_account_id: 'account' }]);
  const events = []; worker.on('event', e => events.push(e));
  worker.productsReader = { read: async (_uid, _cid, progress) => {
    progress({ collected: 105, total: 110, page: 21 });
    assert.equal(worker.getProductSyncStatus('account').status, 'collecting');
    assert.equal(worker.getProductSyncStatus('other'), null);
    throw Error('page failed');
  } };
  await assert.rejects(worker.refreshStoreProducts({ platformAccountId: 'account', externalConversationId: 'c' }), /page failed/);
  assert.equal(events.length, 0);
  assert.equal(worker.getProductSyncStatus('account').status, 'failed');
  assert.equal(worker.getProductSyncStatus('account').collected, 105);
  assert.equal(worker.productReads.size, 0);
});
test('order and product callbacks coexist regardless of first query', async () => {
  for (const sequence of [['orders', 'products', 'orders', 'products'], ['products', 'orders', 'products', 'orders']]) {
    let sid = 0, step = 0, unrelated = 0, finish;
    const done = new Promise(resolve => { finish = resolve; });
    const base = { shopUid: '123', mainUid: '789', cid: '456.1-789.1#11001@cntaobao' };
    const jobs = {
      products: { ...base, pageNo: 22, pageSize: 5 },
      orders: { ...base, contextCid: 'unselected', buyerUid: '456', method: 'mtop.taobao.qianniu.airisland.reception.detail.get', version: '2.0',
        params: { sellerNick: 'seller', buyerInfo: JSON.stringify([{ decryptId: '456', bizDomain: 'taobao' }]) } },
    };
    const results = [];
    const env = { _vs: { loginID: { targetId: '123', havMainId: '789' }, conversationID: { ccode: 'unselected' } },
      onInvokeNotify: () => { unrelated++; },
      workbench: { createSequenceId: () => 'sid-' + (++sid), application: { invoke(sequenceId, command, params) {
        assert.equal(command, 'invokeMTopChannelService');
        const value = JSON.parse(params); assert.equal(value.httpMethod, 'get');
        if (value.method === API) assert.equal(JSON.parse(value.param).pageNo, 22);
        queueMicrotask(() => { env.onInvokeNotify('other', 0, '{}'); env.onInvokeNotify(sequenceId, 0, '{}'); });
      } } },
      fetch: async (url, options) => {
        const channel = url.startsWith('http://orders') ? 'orders' : 'products';
        if (url.endsWith('/poll')) return { ok: true, json: async () => ({ job: sequence[step] === channel ? { ...jobs[channel], id: 'job-' + step } : null }) };
        const result = JSON.parse(options.body).result; results.push(result); step++;
        if (step === sequence.length) { env.__qianniuOrdersV1.stop(); env.__qianniuProductsV3.stop(); finish(); }
        return { ok: true, json: async () => ({}) };
      } };
    installOrderPage(env, { base: 'http://orders', token: 'test' }, createOrderIdentityProtocol);
    installProductsPage(env, { base: 'http://products', token: 'test' });
    await done;
    assert.equal(results.length, 4); assert.ok(results.every(result => result.ok), JSON.stringify(results));
    assert.equal(unrelated, 4);
  }
});
