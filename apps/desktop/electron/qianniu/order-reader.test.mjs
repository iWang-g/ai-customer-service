import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { resolveOrderBuyer } from './order-identity.js';
import { parseOrderJson, verifyOrderSummary, readVerifiedOrders } from './order-reader.js';
import { SUMMARY_API } from './order-mapper.js';
const require = createRequire(import.meta.url);
const { installOrderPage } = require('./order-page.cjs');
const { createOrderIdentityProtocol } = require('./order-identity-protocol.cjs');

test('verified empty summary needs no cached security ID; missing list is not empty', async () => {
  const base = { shopUid: '123', mainUid: '789', cid: '456.1-789.1#11001@cntaobao', buyerUid: '456' };
  const query = async job => {
    assert.equal(job.method, SUMMARY_API);
    return JSON.stringify({ api: SUMMARY_API, ret: ['SUCCESS::ok'], data: { data: [
      { buyerId: '456', bizDomain: 'taobao', tradeSimpleList: [] },
    ] } });
  };
  const snapshot = await readVerifiedOrders(base, 'cntaobao店铺', query, () => { throw Error('must not inspect cache'); });
  assert.equal(snapshot.collection_status, 'empty');
  assert.deepEqual(snapshot.orders, []);
  await assert.rejects(readVerifiedOrders(base, 'seller', async () => {
    const raw = JSON.parse(await query({ method: SUMMARY_API }));
    delete raw.data.data[0].tradeSimpleList;
    return JSON.stringify(raw);
  }, () => {}), /未明确/);
});

test('nonempty summary with missing identity reports unavailable details without querying trade', async () => {
  const base = { shopUid: '123', mainUid: '789', cid: '456.1-789.1#11001@cntaobao', buyerUid: '456' };
  let queries = 0;
  const query = async job => {
    queries++; assert.equal(job.method, SUMMARY_API);
    return JSON.stringify({ api: SUMMARY_API, ret: ['SUCCESS::ok'], data: { data: [
      { buyerId: '456', bizDomain: 'taobao', tradeSimpleList: [{ bizOrderId: '123456789' }] },
    ] } });
  };
  await assert.rejects(readVerifiedOrders(base, 'seller', query, async () => {
    throw Error('该买家尚无可验证的订单身份缓存');
  }), /已查询到 1 笔订单.*明细暂未获取/);
  assert.equal(queries, 1);
});

test('lossless raw JSON preserves numeric 19-digit order IDs', () => {
  assert.equal(parseOrderJson('{"id":2145790274051222188}').id, '2145790274051222188');
  const summary = { api: SUMMARY_API, ret: ['SUCCESS::ok'], data: { data: [{ buyerId: '456', bizDomain: 'taobao',
    tradeSimpleList: [{ bizOrderId: '2145790274051222188' }] }] } };
  assert.ok(verifyOrderSummary(summary, '456').has('2145790274051222188'));
  assert.throws(() => verifyOrderSummary(summary, '999'), /不匹配/);
  assert.throws(() => verifyOrderSummary({ ...summary, data: {} }, '456'), /无法确认/);
});

test('identity cache requires exact account/CID/API and refuses conflicting identifiers', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qn-order-identity-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, '3123', 'Cache', 'Cache_Data'); await fs.mkdir(dir, { recursive: true });
  const cid = '456.1-789.1#11001@cntaobao';
  const url = (id, target = cid) => 'https://h5api.m.taobao.com/h5/mtop.taobao.qianniu.cs.trade.query/1.0/?data=' +
    encodeURIComponent(JSON.stringify({ securityBuyerUid: id, _message_cid: target }));
  await fs.writeFile(path.join(dir, 'data_1'), url('fixtureTarget') + '\0' + url('fixtureOther', '999.1-789.1#11001@cntaobao'));
  assert.deepEqual(await resolveOrderBuyer('123', cid, '789', root), { buyerUid: '456', securityBuyerUid: 'fixtureTarget' });
  await assert.rejects(resolveOrderBuyer('124', cid, '789', root), /身份缓存/);
  await assert.rejects(resolveOrderBuyer('123', cid, '777', root), /不属于/);
  await fs.appendFile(path.join(dir, 'data_1'), '\0' + url('fixtureConflict'));
  await assert.rejects(resolveOrderBuyer('123', cid, '789', root), /冲突/);
});

test('page delegates unrelated callbacks and invokes only the fixed read-only query', async () => {
  let calls = 0, delegated = 0, finish;
  const done = new Promise(resolve => { finish = resolve; });
  const env = { _vs: { loginID: { targetId: '123', havMainId: '789' }, conversationID: { ccode: 'other' } },
    onInvokeNotify() { delegated++; }, workbench: { createSequenceId: () => 'own', application: { invoke(sid, method, raw) {
      calls++; assert.equal(method, 'invokeMTopChannelService');
      assert.equal(JSON.parse(raw).method, 'mtop.taobao.qianniu.cs.trade.query');
      env.onInvokeNotify('unrelated', 0, '{}'); env.onInvokeNotify(sid, 0, '{"rawId":2145790274051222188}');
    } } }, fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      if (url.endsWith('/poll')) return { ok: true, json: async () => ({ job: { id: 'test', shopUid: '123', mainUid: '789', contextCid: 'other',
        buyerUid: '456', cid: '456.1-789.1#11001@cntaobao', method: 'mtop.taobao.qianniu.cs.trade.query', version: '1.0',
        params: { securityBuyerUid: 'fixtureIdentity', _message_cid: '456.1-789.1#11001@cntaobao' } } }) };
      env.__qianniuOrdersV1.stop(); finish(body.result); return { ok: true, json: async () => ({}) };
    } };
  installOrderPage(env, { base: 'http://test', token: 'test' }, createOrderIdentityProtocol);
  const result = await done;
  assert.equal(result.ok, true); assert.equal(calls, 1); assert.equal(delegated, 1);
  assert.deepEqual(result.before, result.after); assert.equal(parseOrderJson(result.raw).rawId, '2145790274051222188');
});

test('page refuses a write API or another account CID before calling the bridge', async () => {
  for (const invalid of [
    { method: 'mtop.trade.modify', version: '1.0' },
    { cid: '456.1-777.1#11001@cntaobao' },
  ]) {
    let invoked = false, finish;
    const done = new Promise(resolve => { finish = resolve; });
    const job = { id: 'invalid', shopUid: '123', mainUid: '789', buyerUid: '456', contextCid: '',
      cid: '456.1-789.1#11001@cntaobao', method: 'mtop.taobao.qianniu.cs.trade.query', version: '1.0',
      params: { securityBuyerUid: 'fixtureIdentity', _message_cid: '456.1-789.1#11001@cntaobao' }, ...invalid };
    const env = { _vs: { loginID: { targetId: '123', havMainId: '789' } },
      workbench: { createSequenceId: () => 'unused', application: { invoke() { invoked = true; } } },
      fetch: async (url, options) => {
        if (url.endsWith('/poll')) return { ok: true, json: async () => ({ job }) };
        env.__qianniuOrdersV1.stop(); finish(JSON.parse(options.body).result);
        return { ok: true, json: async () => ({}) };
      } };
    installOrderPage(env, { base: 'http://test', token: 'test' }, createOrderIdentityProtocol);
    const result = await done;
    assert.equal(result.ok, false);
    assert.equal(invoked, false);
  }
});
