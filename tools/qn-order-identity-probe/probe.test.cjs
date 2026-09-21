'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createProtocol } = require('./protocol.cjs');
const { installIdentityProbe } = require('./page.cjs');
const p = createProtocol(), secureId = 'fixture-security-identity';
function conversion(reverse = false) {
  return { api: p.api, v: '1.0', ret: ['SUCCESS::ok'], data: { code: '0', data: { [p.key(reverse)]: {
    appkey: reverse ? '' : p.appkey, type: reverse ? 'decryptUserId' : 'internal',
    bizDomain: 'taobao', userDomain: 'cntaobao', ...(reverse ? { decryptId: p.buyerUid } : { encryptId: secureId }),
  } } } };
}
test('fixed conversion request scopes forward and reverse directions to one buyer/application', () => {
  const a = p.request({ id: 'one', stage: 'forward' });
  assert.equal(a.method, p.api); assert.equal(a.httpMethod, 'post');
  const data = JSON.parse(JSON.parse(a.param).userSecurityQueryListStr);
  assert.equal(data.length, 1); assert.equal(data[0].from.decryptId, p.buyerUid);
  assert.equal(data[0].to.appkey, '23436601'); assert.equal(data[0].to.type, 'internal');
  const b = p.request({ id: 'two', stage: 'reverse', securityBuyerUid: secureId });
  const reverse = JSON.parse(JSON.parse(b.param).userSecurityQueryListStr)[0];
  assert.equal(reverse.from.encryptId, secureId); assert.equal(reverse.to.type, 'decryptUserId');
  assert.equal(p.identity(conversion()), secureId); assert.equal(p.identity(conversion(true), true), p.buyerUid);
});
test('conversion refuses failure, ambiguous correlation, different applications and different buyers', () => {
  for (const mutate of [r => { r.data.code = '1'; }, r => { r.ret = ['FAIL::denied']; },
    r => { r.data.data.extra = {}; }, r => { r.data.data[p.key(false)].appkey = 'other'; },
    r => { r.data.data[p.key(false)].type = 'decryptUserId'; }, r => { r.data.data[p.key(false)].userDomain = 'other'; }]) {
    const raw = conversion(); mutate(raw); assert.throws(() => p.identity(raw));
  }
  const raw = conversion(true); raw.data.data[p.key(true)].decryptId = '999';
  assert.throws(() => p.identity(raw, true), /buyer UID/);
});
test('arbitrary API/account/CID overrides and malformed identity values cannot reach MTOP', () => {
  for (const job of [{ stage: 'send' }, { stage: 'forward', method: 'write' }, { stage: 'summary', shopUid: '999' },
    { stage: 'summary', cid: 'other' }, { stage: 'reverse', securityBuyerUid: '' },
    { stage: 'trade', securityBuyerUid: 'a&b=secret' }]) assert.throws(() => p.request({ id: 'test', ...job }));
});

async function pageRun(jobs, options = {}) {
  let finish, delegated = 0;
  const done = new Promise(resolve => { finish = resolve; }), calls = [], results = [];
  const env = { _vs: { loginID: { targetId: p.shopUid, havMainId: p.mainUid }, conversationID: { ccode: 'unselected' } },
    onInvokeNotify() { delegated++; }, workbench: { createSequenceId: () => 'seq-' + calls.length,
      application: { invoke(sid, command, data) {
        calls.push({ command, request: JSON.parse(data) });
        env.onInvokeNotify('foreign', 0, '{}');
        if (options.mutate) env._vs.conversationID.ccode = 'changed';
        env.onInvokeNotify(sid, 0, '{}');
      } } }, fetch: async (url, opt) => {
      if (url.endsWith('/poll')) return { ok: true, json: async () => {
        if (options.wrongShop) env._vs.loginID.targetId = '999';
        return { job: jobs.shift() };
      } };
      results.push(JSON.parse(opt.body).result);
      if (!jobs.length) { env.__qnOrderIdentityProbeV1.stop(); finish({ calls, results, delegated }); }
      return { ok: true, json: async () => ({}) };
    } };
  installIdentityProbe(env, { base: 'http://test', token: 'fixture' }, createProtocol);
  return done;
}
test('page preserves unrelated callbacks and unselected conversation through all four reads', async () => {
  const result = await pageRun(['summary', 'forward', 'reverse', 'trade'].map((stage, i) => ({ id: 'job-' + i, stage,
    ...(['reverse', 'trade'].includes(stage) ? { securityBuyerUid: secureId } : {}) })));
  assert.equal(result.calls.length, 4); assert.equal(result.delegated, 4);
  assert.deepEqual(result.calls.map(c => c.request.method), [p.summaryApi, p.api, p.api, p.tradeApi]);
  assert.ok(result.calls.every(c => c.command === 'invokeMTopChannelService'));
  for (const value of result.results) { assert.equal(value.ok, true); assert.deepEqual(value.before, value.after); }
});
test('page refuses repeated/out-of-order queries and account changes, and rejects context changes', async () => {
  const repeat = await pageRun([{ id: 'one', stage: 'summary' }, { id: 'two', stage: 'summary' }]);
  assert.equal(repeat.calls.length, 1); assert.equal(repeat.results[1].ok, false);
  const skipped = await pageRun([{ id: 'one', stage: 'trade', securityBuyerUid: secureId }]);
  assert.equal(skipped.calls.length, 0);
  const wrong = await pageRun([{ id: 'one', stage: 'summary' }], { wrongShop: true });
  assert.equal(wrong.calls.length, 0);
  const changed = await pageRun([{ id: 'one', stage: 'summary' }], { mutate: true });
  assert.equal(changed.results[0].ok, false);
});
test('independent identity resolver supplies verified trade query without reading existing cache', async () => {
  const { readVerifiedOrders } = await import('../../apps/desktop/electron/qianniu/order-reader.js');
  const orderId = '1234567890123456789', calls = [];
  const query = async job => {
    calls.push(job.method);
    if (job.method === p.summaryApi) return JSON.stringify({ api: p.summaryApi, ret: ['SUCCESS::ok'], data: { data: [
      { buyerId: p.buyerUid, bizDomain: 'taobao', tradeSimpleList: [{ bizOrderId: orderId }] },
    ] } });
    assert.equal(job.params.securityBuyerUid, secureId); assert.equal(job.params._message_cid, p.cid);
    return JSON.stringify({ api: p.tradeApi, ret: ['SUCCESS::ok'], data: { orders: [{ bizOrderId: orderId, itemList: [] }] } });
  };
  const result = await readVerifiedOrders(p, 'cntaobao欧金金赛高', query, async () => {
    const securityBuyerUid = p.identity(conversion()); p.identity(conversion(true), true);
    return { buyerUid: p.buyerUid, securityBuyerUid };
  });
  assert.equal(result.orders[0].platform_order_id, orderId);
  assert.deepEqual(calls, [p.summaryApi, p.tradeApi]);
  await assert.rejects(readVerifiedOrders(p, 'seller', query, () => {
    const r = conversion(true); r.data.data[p.key(true)].decryptId = '999'; p.identity(r, true);
  }), /buyer UID/);
  assert.equal(calls.length, 3);
});
