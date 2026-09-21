'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createReader } = require('../qn-read-messages-page.js');
const { TARGET, SAMPLE_IDS, createInspector } = require('./inspect.js');
const { buildPage, validateResult, createServer } = require('./server.cjs');
const { start } = require('./page.js');

function row(id, originalData) {
  return { cid: { ccode: TARGET.cid }, fromid: { targetId: '2214525969878' },
    toid: { targetId: TARGET.mainUid }, mcode: { messageId: id, clientId: '7503334336012222559' },
    type: 100, originalData };
}
function setup(rows, change) {
  const calls = [];
  const env = { _vs: { loginID: { targetId: TARGET.shopUid, havMainId: TARGET.mainUid },
    conversationID: { ccode: 'unselected-conversation' } },
    imsdk: { invoke(method, param) {
      calls.push({ method, param }); if (change) change(env);
      return Promise.resolve({ code: 0, result: { msgs: rows } });
    } } };
  return { env, calls, inspect: createInspector(createReader, env) };
}

test('retains ordered non-text nodes and unknown fields without changing the SDK or context', async () => {
  const product = { jsview: [{ type: 5, value: { url: 'https://item.taobao.com/item.htm?id=730328029364',
    urlinfo: '{"title":"sample","price":"30.0"}' } }] };
  const unknown = { customType: 22, jsview: [{ type: 991, value: { custom: 'unclassified' } }] };
  const image = { jsview: [{ type: 7, value: { pic: 'pic:impicture|sample', width: 720, height: 1280 } }] };
  const { inspect, env, calls } = setup([row(SAMPLE_IDS[0], product), row(SAMPLE_IDS[1], unknown),
    row(SAMPLE_IDS[2], image), row('text-control', { text: 'hello' }), row('unrelated', { text: 'excluded' })]);
  const invoke = env.imsdk.invoke;
  const result = await inspect(); validateResult(result);
  assert.equal(result.samples.length, 4); assert.deepEqual(result.missingSampleIds, []);
  assert.deepEqual(result.samples.slice(0, 3).map(x => x.originalData), [product, unknown, image]);
  assert.equal(result.samples[2].message.text, '');
  assert.deepEqual(result.before, result.after); assert.notEqual(result.before.cid, TARGET.cid);
  assert.equal(env.imsdk.invoke, invoke);
  assert.deepEqual(calls.map(c => c.method), ['im.singlemsg.GetLocalHisMsg']);
  assert.equal(calls[0].param.cid.ccode, TARGET.cid);
});

test('missing historical samples stay missing, not inferred from empty text', async () => {
  const result = await setup([row('unknown-unrelated', {})]).inspect();
  assert.deepEqual(result.samples, []); assert.deepEqual(result.missingSampleIds, SAMPLE_IDS);
});

test('new IDs are scoped explicitly, preserve templateId, and reject a selected target', async () => {
  const fresh = row('new-image.PNM', { jsview: [{ type: 7, value: { url: 'https://img.alicdn.com/test.jpg' } }] });
  fresh.templateId = 'fixture-template';
  const { inspect, env, calls } = setup([fresh, row(SAMPLE_IDS[0], {})]);
  const result = await inspect({ messageIds: ['new-image.PNM', 'not-arrived.PNM'] });
  validateResult(result); assert.equal(result.version, 2); assert.equal(result.samples.length, 1);
  assert.equal(result.samples[0].nativeFields.templateId, 'fixture-template');
  assert.deepEqual(result.missingSampleIds, ['not-arrived.PNM']);
  const foreign = structuredClone(result); foreign.samples[0].message.messageId = 'unrequested.PNM';
  assert.throws(() => validateResult(foreign), /requested IDs/);
  env._vs.conversationID.ccode = TARGET.cid;
  await assert.rejects(inspect({ messageIds: ['new-image.PNM'] }), /selected/);
  assert.equal(calls.length, 1);
  for (const messageIds of [[], ['a', 'a'], ['../secret'], Array.from({ length: 7 }, (_, i) => String(i))])
    await assert.rejects(inspect({ messageIds }), /message IDs/);
});

test('rejects wrong shop before invoking and rejects wrong response cid/account changes', async () => {
  const wrong = setup([]); wrong.env._vs.loginID.targetId = '1';
  await assert.rejects(wrong.inspect(), /account mismatch/); assert.equal(wrong.calls.length, 0);
  const bad = row(SAMPLE_IDS[0], {}); bad.cid.ccode = 'wrong';
  await assert.rejects(setup([bad]).inspect(), /different cid/);
  await assert.rejects(setup([], env => { env._vs.loginID.targetId = '1'; }).inspect(), /shop changed/);
  await assert.rejects(setup([], env => { env._vs.conversationID.ccode = 'changed'; }).inspect(), /conversation changed/);
});

test('bounds native data without truncation and releases the busy guard on failure', async () => {
  const { inspect } = setup([row(SAMPLE_IDS[2], { jsview: [{ value: { pic: 'x'.repeat(65000) } }] })]);
  await assert.rejects(inspect(), /64000/); await assert.rejects(inspect(), /64000/);
});

test('rejects simultaneous reads and preserves full precision IDs', async () => {
  const { inspect } = setup([row(SAMPLE_IDS[2], {})]);
  const first = inspect(); await assert.rejects(inspect(), /in progress/);
  assert.equal((await first).samples[0].message.clientId, '7503334336012222559');
  const unsafe = row(SAMPLE_IDS[2], {}); unsafe.mcode.clientId = Number('7503334336012222559');
  await assert.rejects(setup([unsafe]).inspect(), /lossy/);
});

test('bundled page loads without replacing production reader, SDK or callbacks', async () => {
  const sdk = { invoke() { throw new Error('must not invoke without an armed job'); } };
  const callback = () => {}, productionReader = () => {};
  const env = { imsdk: sdk, onInvokeNotify: callback, __codexQnReadMessages: productionReader };
  const context = vm.createContext({ window: env, setTimeout: () => 1, clearTimeout() {}, AbortController });
  new vm.Script(buildPage({ base: 'http://127.0.0.1:18085', token: 'test' })).runInContext(context);
  assert.equal(env.imsdk, sdk); assert.equal(env.onInvokeNotify, callback);
  assert.equal(env.__codexQnReadMessages, productionReader);
  assert.equal(typeof env.__qnMediaProbe.stop, 'function'); env.__qnMediaProbe.stop();
});

test('receiver refuses unauthenticated requests, wrong account and arming without a ready page', async t => {
  const server = createServer({ token: 'test-secret' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = (route, body) => fetch('http://127.0.0.1:' + server.address().port + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await request('/arm', {})).status, 403);
  assert.equal((await request('/arm', { token: 'test-secret' })).status, 400);
  assert.equal((await request('/poll', { token: 'test-secret', state: { shopUid: '1' } })).status, 400);
  const state = { ...TARGET }; delete state.cid;
  await request('/poll', { token: 'test-secret', state, pageId: 'page-1', ready: true });
  assert.equal((await request('/arm', { token: 'test-secret' })).status, 200);
  const job = await (await request('/poll', { token: 'test-secret', state, pageId: 'page-1', ready: true })).json();
  assert.ok(job.job.id);
  const next = await (await request('/poll', { token: 'test-secret', state, pageId: 'page-1', ready: true })).json();
  assert.equal(next.job, null);
});

test('retrying result delivery never repeats the native history read', async () => {
  let reads = 0, deliveries = 0, done;
  const finished = new Promise(resolve => { done = resolve; });
  const env = { imsdk: { invoke() {} }, fetch: async url => {
    if (url.endsWith('/poll')) return { ok: true, json: async () => ({ job: { id: 'once' } }) };
    deliveries++;
    if (deliveries === 1) throw new Error('connection interrupted');
    env.__qnMediaProbe.stop(); done(); return { ok: true, json: async () => ({ accepted: true }) };
  } };
  start(env, async () => { reads++; return {}; }, () => TARGET, { base: 'http://test', token: 'test' });
  await finished;
  assert.equal(reads, 1); assert.equal(deliveries, 2);
});
