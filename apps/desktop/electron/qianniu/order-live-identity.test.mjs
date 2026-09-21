import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readVerifiedOrders } from './order-reader.js';
import { SUMMARY_API, TRADE_API } from './order-mapper.js';
import { QianniuWorkerManager } from './worker-manager.js';
const require = createRequire(import.meta.url);
const { createOrderIdentityProtocol } = require('./order-identity-protocol.cjs');
const { installOrderPage } = require('./order-page.cjs');
const p = createOrderIdentityProtocol();
const base = { shopUid: '123', mainUid: '789', buyerUid: '456', cid: '456.1-789.1#11001@cntaobao' };
const secure = 'fixture-security-id', orderId = '5127248019328012543';
function identityResponse(job) {
  const [entry] = JSON.parse(job.params.userSecurityQueryListStr);
  const reverse = entry.from.type === 'internal';
  return { api: p.api, v: '1.0', ret: ['SUCCESS::ok'], data: { code: '0', data: {
    [entry.identifyKey]: { appkey: reverse ? '' : p.appkey, type: reverse ? 'decryptUserId' : 'internal',
      bizDomain: 'taobao', userDomain: 'cntaobao', ...(reverse ? { decryptId: job.buyerUid } : { encryptId: secure }) },
  } } };
}
function fakeQuery(calls, { empty = false, mutate = () => {} } = {}) {
  return async job => {
    calls.push(job);
    let response;
    if (job.method === SUMMARY_API) response = { api: SUMMARY_API, ret: ['SUCCESS::ok'], data: { data: [
      { buyerId: job.buyerUid, bizDomain: 'taobao', tradeSimpleList: empty ? [] : [{ bizOrderId: orderId }] },
    ] } };
    else if (job.method === p.api) response = identityResponse(job);
    else {
      assert.equal(job.method, TRADE_API); assert.equal(job.params.securityBuyerUid, secure);
      assert.equal(job.params._message_cid, job.cid);
      response = { api: TRADE_API, ret: ['SUCCESS::ok'], data: { orders: [{ bizOrderId: orderId, itemList: [] }] } };
    }
    mutate(response, job); return JSON.stringify(response);
  };
}
test('default order path uses live round trip for multiple shops and both CID orientations', async () => {
  for (const scope of [base, { shopUid: '222', mainUid: '333', buyerUid: '444', cid: '333.1-444.1#11001@cntaobao' }]) {
    const calls = [];
    const result = await readVerifiedOrders(scope, 'cntaobao店铺', fakeQuery(calls));
    assert.deepEqual(calls.map(j => j.method), [SUMMARY_API, p.api, p.api, TRADE_API]);
    assert.ok(calls.every(j => j.shopUid === scope.shopUid && j.cid === scope.cid));
    const [forward] = JSON.parse(calls[1].params.userSecurityQueryListStr);
    const [reverse] = JSON.parse(calls[2].params.userSecurityQueryListStr);
    assert.equal(forward.from.decryptId, scope.buyerUid); assert.equal(reverse.from.encryptId, secure);
    assert.notEqual(forward.identifyKey, reverse.identifyKey);
    assert.equal(result.identity_source, 'verified_live_conversion');
    assert.equal(result.orders[0].platform_order_id, orderId);
    assert.equal(JSON.stringify(result).includes(secure), false);
  }
});
test('empty summary avoids identity queries and invalid buyer scope makes no request', async () => {
  const calls = [];
  assert.equal((await readVerifiedOrders(base, 'seller', fakeQuery(calls, { empty: true }))).collection_status, 'empty');
  assert.equal(calls.length, 1);
  await assert.rejects(readVerifiedOrders({ ...base, buyerUid: '999' }, 'seller', fakeQuery(calls)), /身份不匹配/);
  assert.equal(calls.length, 1);
});
test('conversion failure, wrong app/correlation and reverse mismatch never query details', async () => {
  for (const mode of ['failure', 'scope', 'correlation', 'reverse']) {
    const calls = [];
    await assert.rejects(readVerifiedOrders(base, 'seller', fakeQuery(calls, { mutate(response, job) {
      if (job.method !== p.api) return;
      const value = Object.values(response.data.data)[0];
      if (mode === 'failure') response.data.code = '1';
      if (mode === 'scope') value.appkey = 'other';
      if (mode === 'correlation') response.data.data = { another: value };
      if (mode === 'reverse' && value.type === 'decryptUserId') value.decryptId = '999';
    } })), /已查询到 1 笔订单.*原有数据未更新/);
    assert.ok(calls.every(j => j.method !== TRADE_API));
  }
});
test('verified identity does not permit unrelated or absent order details', async () => {
  for (const orders of [[], [{ bizOrderId: '999', itemList: [] }]]) {
    await assert.rejects(readVerifiedOrders(base, 'seller', fakeQuery([], { mutate(response, job) {
      if (job.method === TRADE_API) response.data.orders = orders;
    } })), /摘要不一致/);
  }
});
test('page rejects altered conversion shape, app, buyer and arbitrary extra fields', () => {
  for (const mutate of [e => { e.from.decryptId = '999'; }, e => { e.to.appkey = 'other'; },
    e => { e.to.type = 'other'; }, e => { e.ext = { unsafe: true }; },
    e => { e.from.nick = 'other-buyer'; }, e => { e.extra = 'unexpected'; }]) {
    const params = p.params(base, 'key'); const list = JSON.parse(params.userSecurityQueryListStr);
    mutate(list[0]); params.userSecurityQueryListStr = JSON.stringify(list);
    assert.throws(() => p.validateParams(base, params));
  }
  assert.throws(() => p.validateParams(base, { ...p.params(base, 'key'), method: 'other' }));
  assert.throws(() => p.validateParams(base, { userSecurityQueryListStr: '[]' }));
  p.validateParams(base, p.params(base, 'key'));
  p.validateParams(base, p.params(base, 'key', secure));
});
async function runPage(job, mutateContext = false) {
  let finish, delegated = 0;
  const done = new Promise(resolve => { finish = resolve; }), calls = [];
  const env = { _vs: { loginID: { targetId: base.shopUid, havMainId: base.mainUid }, conversationID: { ccode: 'unselected' } },
    onInvokeNotify() { delegated++; }, workbench: { createSequenceId: () => 'seq', application: {
      invoke(sid, command, request) {
        calls.push({ command, ...JSON.parse(request) });
        env.onInvokeNotify('foreign', 0, '{}');
        if (mutateContext) env._vs.conversationID.ccode = 'changed';
        env.onInvokeNotify(sid, 0, '{}');
      },
    } }, fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      if (url.endsWith('/poll')) {
        assert.equal(body.identityVersion, 1);
        return { ok: true, json: async () => ({ job: { ...base, contextCid: 'unselected', id: 'job',
          method: p.api, version: '1.0', params: p.params(base, 'key'), ...job } }) };
      }
      env.__qianniuOrdersV1.stop(); finish({ result: body.result, calls, delegated });
      return { ok: true, json: async () => ({}) };
    } };
  // Exercise the actual serialized page bundle, including its protocol dependency.
  new Function('window', '(' + installOrderPage.toString() + ')(window,{base:"http://fixture",token:"test"},' +
    createOrderIdentityProtocol.toString() + ');')(env);
  return done;
}
test('serialized page uses POST for identity and forwards callbacks without switching context', async () => {
  for (const params of [p.params(base, 'key'), p.params(base, 'key', secure)]) {
    const value = await runPage({ params });
    assert.equal(value.result.ok, true); assert.equal(value.delegated, 1);
    assert.equal(value.calls[0].httpMethod, 'post'); assert.equal(value.calls[0].method, p.api);
    assert.equal(value.calls[0].command, 'invokeMTopChannelService');
    assert.deepEqual(value.result.before, value.result.after);
  }
});
test('page rejects stale context, other account and out-of-scope API before calling MTOP', async () => {
  for (const job of [{ contextCid: 'stale' }, { shopUid: '999' }, { method: 'write.api' },
    { params: p.params({ ...base, buyerUid: '999', cid: '789.1-999.1#11001@cntaobao' }, 'key') }]) {
    const value = await runPage(job); assert.equal(value.result.ok, false); assert.equal(value.calls.length, 0);
  }
  assert.equal((await runPage({}, true)).result.ok, false);
});

test('worker emits one order snapshot for coalesced reads and never publishes failed or stale results', async () => {
  for (const mode of ['ok', 'failed', 'rebound', 'stopped']) {
    const manager = new QianniuWorkerManager({ enabled: true });
    manager.platformAccountBindings.set('account', base.shopUid);
    let release, reads = 0;
    const pending = new Promise(resolve => { release = resolve; });
    manager.orderReader = { async read() {
      reads++; await pending;
      if (mode === 'failed') throw Error('身份转换失败');
      return { observed_at: new Date().toISOString(), orders: [], identity_source: 'verified_live_conversion' };
    } };
    const events = []; manager.on('event', event => events.push(event));
    const args = { platformAccountId: 'account', externalConversationId: base.cid };
    const first = manager.refreshCustomerOrders(args), second = manager.refreshCustomerOrders(args);
    if (mode === 'rebound') manager.platformAccountBindings.set('account', '999');
    if (mode === 'stopped') manager.generation++;
    release();
    if (mode === 'ok') {
      await Promise.all([first, second]); assert.equal(events.length, 1);
      assert.equal(events[0].event_type, 'customer_orders_snapshot');
      assert.equal(events[0].platform_account_id, 'account');
    } else {
      const results = await Promise.allSettled([first, second]);
      assert.ok(results.every(r => r.status === 'rejected')); assert.equal(events.length, 0);
    }
    assert.equal(reads, 1); assert.equal(manager.orderReads.size, 0);
  }
});

test('background order task routes only Qianniu and validates account before reading', async () => {
  const manager = new QianniuWorkerManager({ enabled: true });
  let reads = 0;
  manager.refreshCustomerOrders = async args => { reads++; assert.equal(args.platformAccountId, 'account'); return { status: 'collected' }; };
  const completed = []; manager.on('task-complete', (...args) => completed.push(args));
  const task = { id: 'task', platform_code: 'qianniu', task_type: 'refresh_customer_orders', platform_account_id: 'account',
    payload_json: { platform_account_id: 'account', external_conversation_id: base.cid } };
  assert.equal(await manager.handleTask({ ...task, platform_code: 'pinduoduo' }), false);
  await manager.handleTask(task);
  assert.equal(completed[0][1], 'completed'); assert.equal(reads, 1);
  await manager.handleTask({ ...task, payload_json: { ...task.payload_json, platform_account_id: 'other' } });
  assert.equal(completed[1][1], 'failed'); assert.equal(reads, 1);
  manager.refreshCustomerOrders = async () => { throw Error('query failed'); };
  await manager.handleTask(task); assert.equal(completed[2][1], 'failed');
});
