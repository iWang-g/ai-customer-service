import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { resolveProductBuyer } from './product-detail-identity.js';
import { QianniuWorkerManager } from './worker-manager.js';
const require = createRequire(import.meta.url);
const { summarizeDetail, API } = require('./product-detail-protocol.cjs');
const { verifyOwnership, API: OWNERSHIP_API } = require('./product-ownership-protocol.cjs');
const { installProductsPage } = require('./products-page.cjs');

test('detail identity must belong to exact account, CID and API, rejects conflicts', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qn-detail-test-'));
  const folder = path.join(root, '3123', 'Cache', 'Cache_Data'); await fs.mkdir(folder, { recursive: true });
  const cid = '456.1-789.1#11001@cntaobao';
  const url = (encryptId, requestCid = cid, api = API) => 'https://h5api.m.taobao.com/h5/' + api + '/1.0/?data=' +
    encodeURIComponent(JSON.stringify({ encryptId, isNewCustomer: true, _message_cid: requestCid })) + '\0';
  try {
    await fs.writeFile(path.join(folder, 'data_1'), url('synthetic-one') + url('unrelated-identity', 'other') + url('wrong-api-identity', cid, 'write.api'));
    assert.deepEqual(await resolveProductBuyer('123', cid, '789', root), { encryptId: 'synthetic-one', isNewCustomer: true });
    await assert.rejects(resolveProductBuyer('999', cid, '789', root));
    await assert.rejects(resolveProductBuyer('123', cid, '000', root));
    await fs.appendFile(path.join(folder, 'data_1'), url('synthetic-two'));
    await assert.rejects(resolveProductBuyer('123', cid, '789', root));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('worker detail task publishes only successful projections, never invokes sendText', async () => {
  const worker = new QianniuWorkerManager({ enabled: true, sendText: () => { throw new Error('Must never send'); } });
  worker.applyBindings([{ platform_code: 'qianniu', local_account_id: 'qianniu-123', platform_account_id: 'account' }]);
  const events = [], completed = [], ids = [];
  worker.on('event', e => events.push(e)); worker.on('task-complete', (...a) => completed.push(a));
  worker.productsReader = { readDetail: async (shopUid, cid, productId, options) => {
    assert.equal(shopUid, '123'); assert.equal(cid, '456.1-789.1#11001@cntaobao'); ids.push(productId);
    assert.equal(options.ownershipVerified, productId === '1');
    if (productId === '2') throw new Error('Missing detail');
    return { product_id: productId, observed_at: new Date().toISOString() };
  } };
  const task = { id: 'task', platform_code: 'qianniu', platform_account_id: 'account', task_type: 'refresh_product_details',
    payload_json: { platform_account_id: 'account', external_conversation_id: '456.1-789.1#11001@cntaobao',
      product_ids: ['1', '2', '3'], ownership_verified_product_ids: ['1'] } };
  await worker.handleTask(task);
  assert.deepEqual(ids, ['1', '2', '3']); assert.equal(events.length, 2);
  assert.ok(events.every(e => e.event_type === 'store_product_detail_snapshot' && !e.conversation_external_id));
  assert.equal(completed[0][1], 'failed'); assert.deepEqual(completed[0][2].collected, ['1', '3']);
  assert.equal(await worker.handleTask({ ...task, platform_code: 'pinduoduo' }), false);
  await worker.handleTask({ ...task, platform_account_id: 'other' });
  assert.deepEqual(ids, ['1', '2', '3']);
});

test('formal detail page uses fixed read-only method and keeps unselected context', async () => {
  async function run(overrides = {}) {
    let finish, calls = 0, unrelated = 0;
    const done = new Promise(resolve => { finish = resolve; });
    const env = { _vs: { loginID: { targetId: '123', havMainId: '789' }, conversationID: { ccode: 'unselected' } },
      onInvokeNotify: () => { unrelated++; }, workbench: { createSequenceId: () => 'sid', application: {
        invoke(sid, command, raw) {
          calls++; const data = JSON.parse(raw);
          assert.equal(command, 'invokeMTopChannelService'); assert.equal(data.method, API); assert.equal(data.httpMethod, 'get');
          assert.equal(JSON.parse(data.param).itemId, '123456');
          queueMicrotask(() => { env.onInvokeNotify('other', 0, '{}'); env.onInvokeNotify(sid, 0, '{}'); });
        } } }, fetch: async (url, options) => {
          if (url.endsWith('/poll')) {
            assert.equal(JSON.parse(options.body).deliveryVersion, 1);
            return { ok: true, json: async () => ({ job: { id: 'job', kind: 'detail',
            shopUid: '123', mainUid: '789', cid: '456.1-789.1#11001@cntaobao', productId: '123456',
            encryptId: 'synthetic-id', isNewCustomer: true, ...overrides } }) };
          }
          env.__qianniuProductsV3.stop(); finish({ result: JSON.parse(options.body).result, calls, unrelated });
          return { ok: true, json: async () => ({}) };
        } };
    installProductsPage(env, { base: 'http://test', token: 'test' }); return done;
  }
  const value = await run(); assert.equal(value.result.ok, true); assert.equal(value.unrelated, 1);
  assert.deepEqual(value.result.before, value.result.after); assert.equal(value.result.before.cid, 'unselected');
  for (const bad of [{ method: 'write.api' }, { shopUid: '999' }, { cid: 'other' }, { productId: 'abc' }, { encryptId: '' }]) {
    const rejected = await run(bad); assert.equal(rejected.calls, 0); assert.equal(rejected.result.ok, false);
  }
});

test('ownership query and parser require the current shop seller', async () => {
  const raw = JSON.stringify({ api: OWNERSHIP_API, v: '1.0', ret: ['SUCCESS::ok'], data: { code: '0', data: [{
    itemId: 123456, sellerId: 789, itemName: 'Pillow', itemPicUrl: '//img.example/p.jpg',
    itemUrl: 'https://item.taobao.com/item.htm?id=123456', actualPriceYuan: 64, quantity: 8, hasSku: true,
  }] } });
  const item = verifyOwnership(raw, '123456', '789');
  assert.equal(item.seller_uid, '789'); assert.equal(item.image_url, 'https://img.example/p.jpg');
  assert.throws(() => verifyOwnership(raw, '123456', '999'));

  let finish;
  const done = new Promise(resolve => { finish = resolve; });
  const env = { _vs: { loginID: { targetId: '123', havMainId: '789' }, conversationID: { ccode: 'unselected' } },
    workbench: { createSequenceId: () => 'sid', application: { invoke(sid, command, body) {
      const request = JSON.parse(body); assert.equal(command, 'invokeMTopChannelService');
      assert.equal(request.method, OWNERSHIP_API); assert.deepEqual(JSON.parse(JSON.parse(request.param).query).itemIds, [123456]);
      queueMicrotask(() => env.onInvokeNotify(sid, 0, raw));
    } } }, fetch: async (url, options) => {
      if (url.endsWith('/poll')) {
        assert.equal(JSON.parse(options.body).deliveryVersion, 1);
        return { ok: true, json: async () => ({ job: { id: 'ownership', kind: 'ownership',
        shopUid: '123', mainUid: '789', cid: '456.1-789.1#11001@cntaobao', productId: '123456' } }) };
      }
      env.__qianniuProductsV3.stop(); finish(JSON.parse(options.body).result);
      return { ok: true, json: async () => ({}) };
    } };
  installProductsPage(env, { base: 'http://test', token: 'test' });
  assert.equal((await done).ok, true);
});

test('formal detail parser retains negative option codes and rejects wrong product', () => {
  const raw = JSON.stringify({ api: API, v: '1.0', ret: ['SUCCESS::ok'], data: {
    item: { itemId: '123', title: 'Pillow' }, skuList: [{ skuId: '1234567890123456789',
      price: '25.00', propsName: '-1:-2:Style:Cover only', quantity: 1 }],
    itemServiceList: [{ serviceName: 'Return', description: 'Only if unused' }], deliveryTimeData: { ipInfo: 'omit' },
  } });
  const detail = summarizeDetail(raw, '123');
  assert.equal(detail.skus[0].attributes[0].valueId, '-2'); assert.equal(detail.skus[0].price, '25.00');
  assert.equal(detail.services[0].description, 'Only if unused'); assert.equal(JSON.stringify(detail).includes('omit'), false);
  assert.throws(() => summarizeDetail(raw, '999'));
});
