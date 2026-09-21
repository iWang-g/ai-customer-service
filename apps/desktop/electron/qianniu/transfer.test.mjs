import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { QianniuTransferService } from './transfer-service.js';
import { parseTransferReceipt } from './transfer-receipt.js';
import { QianniuWorkerManager } from './worker-manager.js';
import { QianniuTransferChannel } from './transfer-channel.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { createTransferProtocol } = require('./transfer-protocol.cjs');
const { installTransferPage } = require('./transfer-page.cjs');
const p = createTransferProtocol();
const s = { shopUid: '123', mainUid: '789', nick: '店铺:甲' };
const c = { ...s, conversationId: 'a'.repeat(32), platformAccountId: 'account', cid: '456.1-789.1#11001@cntaobao', buyerUid: '456', buyerNick: '买家' };
test('independent channel authenticates page, delivers once and rejects mismatched results', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qn-transfer-test-'));
  const channel = new QianniuTransferChannel({ dataPath: dir, install: false, port: 0 });
  try {
    await channel.start();
    const post = (route, data, origin = 'https://alires-webui') => fetch(`http://127.0.0.1:${channel.port}${route}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ token: channel.token, version: 1, pageId: 'fixture', ...data }),
    });
    assert.equal((await post('/poll', { state: s }, 'https://example.org')).status, 403);
    assert.equal((await post('/poll', { state: s, token: 'wrong' })).status, 403);
    assert.equal((await post('/poll', { state: s })).status, 200);
    const run = channel.run(c, 'list');
    await new Promise(resolve => setImmediate(resolve));
    const job = (await (await post('/poll', { state: s })).json()).job;
    assert.ok(job);
    assert.equal((await (await post('/poll', { state: s })).json()).job, null);
    const failed = assert.rejects(run, /身份不匹配/);
    await post('/result', { id: job.id, result: { ok: true, invoked: false, before: s, after: { ...s, shopUid: '999' } } });
    await failed;
    assert.equal((await post('/result', { id: job.id, result: {} })).status, 409);
  } finally { await channel.stop(); await fs.rm(dir, { recursive: true, force: true }); }
});
const staff = (id, nick = '店铺:' + id) => ({ subUserId: id, userId: '789', subNick: nick });
const status = (id, extra = {}) => ({ accountId: id, mainAccountId: '789', nick: '店铺:' + id, pcOnline: true, suspend: false, ...extra });
const envelope = (api, data) => JSON.stringify({ api, v: '1.0', ret: ['SUCCESS::ok'], data });
function queryFixture(roster, statuses) {
  return async request => {
    if (request.method === p.STATUS) return envelope(p.STATUS, { errorCode: 0, errorMap: {}, module: statuses });
    const n = Number(JSON.parse(request.param).page_no);
    return envelope(p.LIST, { error: false, result: roster.slice((n - 1) * 5, n * 5) });
  };
}
test('complete pages, online boolean evidence, same shop and exclusion rules', async () => {
  const roster = ['123', '789', '1', '2', '3', '4', '5'].map(id => staff(id));
  const statuses = [status('123'), status('789'), status('1'), status('2', { pcOnline: false, mobileOnline: true }),
    status('3', { suspend: true }), status('4', { pcOnline: false, mobileOnline: false }), status('99')];
  const targets = await p.collect(queryFixture(roster, statuses), s);
  assert.deepEqual(targets.map(x => x.uid), ['1', '2']);
  assert.equal(targets[1].contactId, 'cntaobao店铺:2');
  await assert.rejects(p.collect(queryFixture([staff('1'), staff('1')], []), s), /重复/);
  await assert.rejects(p.collect(queryFixture([staff('1')], [status('1', { mainAccountId: '999' })]), s), /归属/);
  await assert.rejects(p.collect(async () => ({}), s), /回执/);
});
test('status short names join by account IDs and retain roster full names for transfer', async () => {
  const source = { shopUid: '2222303856223', mainUid: '2216058631944', nick: '有求必应羊羊:王刚' };
  const roster = [
    { subUserId: 2216111005027, userId: 2216058631944, subNick: '有求必应羊羊:元元' },
    { subUserId: 2222303856223, userId: 2216058631944, subNick: '有求必应羊羊:王刚' },
    { subUserId: 2223061545705, userId: 2216058631944, subNick: '有求必应羊羊:城堡' },
  ];
  const statuses = roster.map(a => ({ accountId: a.subUserId, mainAccountId: a.userId,
    nick: a.subNick.split(':')[1], suspend: false, pcOnline: a.subUserId !== 2216111005027, mobileOnline: false }));
  const expected = [{ uid: '2223061545705', nick: '有求必应羊羊:城堡', contactId: 'cntaobao有求必应羊羊:城堡',
    pcOnline: true, mobileOnline: false }];
  assert.deepEqual(await p.collect(queryFixture(roster, statuses), source), expected);
  assert.deepEqual(await p.collect(queryFixture(roster, statuses.map((a, i) => ({ ...a, nick: roster[i].subNick }))), source), expected);
  for (const patch of [{ nick: '其他客服' }, { nick: '其他店铺:城堡' }]) {
    const diagnostics = [];
    assert.deepEqual(await p.collect(queryFixture(roster, statuses.map((a, i) => i === 2 ? { ...a, ...patch } : a)), source, diagnostics), []);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].uid, '2223061545705');
    assert.equal(diagnostics[0].rosterNick, '有求必应羊羊:城堡');
    assert.equal(diagnostics[0].statusNick, patch.nick);
  }
  await assert.rejects(p.collect(queryFixture(roster, statuses.map((a, i) => i === 2 ? { ...a, mainAccountId: '999' } : a)), source), /归属/);
  assert.deepEqual(await p.collect(queryFixture(roster, [
    ...statuses.slice(0, 2), { ...statuses[2], accountId: '999' },
  ]), source), []);
});

test('nickname conflicts exclude only affected staff, including offline and current accounts', async () => {
  const roster = ['123', '1', '2', '3', '4'].map(id => staff(id));
  const statuses = [status('123', { nick: '旧名' }), status('1', { nick: '冲突' }),
    status('2'), status('3', { nick: '离线旧名', pcOnline: false }),
    status('4', { nick: '4', pcOnline: false, mobileOnline: true })];
  const diagnostics = [];
  const targets = await p.collect(queryFixture(roster, statuses), s, diagnostics);
  assert.deepEqual(targets.map(t => t.uid), ['2', '4']);
  assert.deepEqual(diagnostics.map(d => d.uid), ['123', '1', '3']);
  assert.ok(diagnostics.every(d => d.code === 'staff_nick_mismatch' && d.mainUid === '789'));
  await assert.rejects(p.collect(queryFixture(roster, [...statuses, status('2')]), s), /归属/);
  await assert.rejects(p.collect(queryFixture([{ ...staff('2'), userId: '999' }], statuses), s), /归属/);
});

test('business failure and full final page do not become an empty successful roster', async () => {
  await assert.rejects(p.collect(async () => envelope(p.LIST, { error: true, result: [] }), s));
  await assert.rejects(p.collect(async req => {
    const n = Number(JSON.parse(req.param).page_no);
    return envelope(p.LIST, { error: false, result: Array.from({ length: 5 }, (_, i) => staff(String(n * 10 + i))) });
  }, s), /完整/);
  assert.throws(() => p.identity(s, '456.1-999.1#11001@cntaobao'));
});
function receiptLines(patch = {}) {
  const body = { api: p.FORWARD, v: '3.0', data: { errorCode: 0, errorMap: {}, module: true }, ret: ['SUCCESS::ok'], ...patch };
  const pre = '[09-14 17:48:38 418513734 28428 18656 INFO]';
  const options = JSON.stringify({ appCid: c.cid, buyerDomain: 'cntaobao', loginDomain: 'cntaobao' });
  return [`${pre} qnmodel [QNSDK 3#123 ][ fromNumberId=456,cid=${c.cid},toNumberId=2 ][QNEServiceService.cpp(1001) ForwardContact]`,
    `${pre} UnifiedMtop [MTOP 店铺:甲#3#123 ][ data=${JSON.stringify(body)},nTaskID=264,action=${p.FORWARD},resultCode.ToString()=ResultCode=[0:0__],requestParam=${JSON.stringify({ buyerId: 456, toId: 2, options })} ][MTopChannel.cpp(441) HandleMtopResponse]`];
}
test('business receipt requires account, PID, buyer, cid, receiver and complete success', () => {
  assert.equal(parseTransferReceipt(receiptLines(), c, '2').status, 'transferred');
  assert.equal(parseTransferReceipt(receiptLines(), c, '3'), null);
  assert.equal(parseTransferReceipt(receiptLines().map((l, i) => i ? l.replace('28428', '99999') : l), c, '2'), null);
  assert.equal(parseTransferReceipt(receiptLines({ data: { errorCode: 1, errorMap: { target: 'offline' }, module: false } }), c, '2').status, 'failed');
  assert.equal(parseTransferReceipt([receiptLines()[0]], c, '2'), null);
  assert.equal(parseTransferReceipt(receiptLines({ data: {} }), c, '2'), null);
  assert.equal(parseTransferReceipt([...receiptLines(), receiptLines()[0]], c, '2').status, 'confirmation_pending');
});

test('page refreshes online status before transfer and never invokes for offline or mismatched buyers', async () => {
  for (const variant of ['online', 'unrelated-conflict', 'target-conflict', 'offline', 'wrong-buyer', 'expired']) {
    let finish, nativeCalls = 0, sequence = 0;
    const done = new Promise(resolve => { finish = resolve; });
    const canSubmit = ['online', 'unrelated-conflict'].includes(variant);
    const query = queryFixture([staff('2'), staff('3')], [
      status('2', { nick: variant === 'target-conflict' ? '旧名' : '2', pcOnline: variant !== 'offline' }),
      status('3', { nick: variant === 'unrelated-conflict' ? '旧名' : '3' }),
    ]);
    const job = { id: 'job', kind: 'transfer', shopUid: '123', cid: c.cid, buyerUid: '456', buyerNick: '买家',
      targetUid: '2', targetNick: '店铺:2', reason: '人工转接', expiresAt: Date.now() + (variant === 'expired' ? -1000 : 10000) };
    const env = { _vs: { loginID: { targetId: '123', havMainId: '789', nick: '店铺:甲' } },
      imsdk: { invoke: async (method, param) => {
        if (method === 'application.transferContact') {
          nativeCalls++; assert.equal(param.contactID, 'cntaobao买家'); assert.equal(param.targetID, 'cntaobao店铺:2'); return {};
        }
        assert.equal(method, 'im.singlemsg.GetLocalHisMsg');
        return { msgs: [{ cid: c.cid, fromid: { targetId: '456', nick: variant === 'wrong-buyer' ? '不同买家' : '买家' } }] };
      } },
      workbench: { createSequenceId: () => ++sequence, application: { invoke: (sid, method, raw) => {
        assert.equal(method, 'invokeMTopChannelService'); void query(JSON.parse(raw)).then(v => env.onInvokeNotify(sid, 0, v));
      } } },
      fetch: async (url, options) => {
        if (url.endsWith('/result')) { env.__qianniuTransferV1.stop(); finish(JSON.parse(options.body).result); }
        return { ok: true, json: async () => ({ job }) };
      } };
    installTransferPage(env, { base: 'local', token: 'test' }, createTransferProtocol);
    const result = await done;
    assert.equal(nativeCalls, canSubmit ? 1 : 0);
    assert.equal(result.invoked, canSubmit);
    if (variant.includes('conflict')) {
      assert.equal(result.diagnostics.length, 1);
      assert.equal(result.diagnostics[0].uid, variant === 'target-conflict' ? '2' : '3');
    }
  }
});
function serviceFixture(outcome = { status: 'transferred', evidence: {} }) {
  const calls = [], locks = new Set(); let transferResult = { ok: true, invoked: true };
  const service = new QianniuTransferService({ appLogPath: 'unused',
    channel: { run: async (_c, kind) => { calls.push(kind); return kind === 'list' ? { ok: true, targets: [{ uid: '2', nick: '店铺:乙', pcOnline: true }] } : transferResult; } },
    api: async (route, body) => { calls.push({ route, body }); if (route.endsWith('/begin')) return { id: 'op' }; return c; },
    binding: () => '123', busy: key => locks.has(key), lock: key => locks.add(key), unlock: key => locks.delete(key),
    openLog: async () => ({ confirm: async () => outcome, close: async () => {} }),
  });
  return { service, calls, locks, result: v => { transferResult = v; } };
}
test('selection token binds conversation, success persisted before returning, no replay', async () => {
  const { service, calls, locks } = serviceFixture();
  const targets = await service.list({ conversationId: c.conversationId });
  const targetCsid = targets.cs_list[0].csid;
  await assert.rejects(service.transfer({ conversationId: 'b'.repeat(32), targetCsid }));
  const value = await service.transfer({ conversationId: c.conversationId, targetCsid });
  assert.equal(value.status, 'transferred'); assert.equal(locks.size, 0);
  assert.equal(calls.filter(x => x === 'transfer').length, 1);
  assert.equal(calls.at(-1).body.outcome, 'transferred');
  await assert.rejects(service.transfer({ conversationId: c.conversationId, targetCsid }));
});

test('staff conflict diagnostics reach the worker logger without raw response fields', async () => {
  const diagnostics = [];
  const worker = new QianniuWorkerManager({ enabled: true,
    diagnosticLogger: { write: (accountId, entry) => diagnostics.push({ account_id: accountId, ...entry }) } });
  worker.applyBindings([{ platform_code: 'qianniu', local_account_id: 'qianniu-123', platform_account_id: 'account' }]);
  worker.businessApi = async () => c;
  worker.transferChannel.run = async () => ({ ok: true, before: s,
    targets: [{ uid: '2', nick: '店铺:2', pcOnline: true }],
    diagnostics: [{ code: 'staff_nick_mismatch', uid: '3', mainUid: '789',
      rosterNick: '店铺:3', statusNick: '旧名', pcOnline: false, mobileOnline: true, suspended: false,
      raw: 'must-not-be-logged' }] });
  const result = await worker.listTransferTargets({ conversationId: c.conversationId });
  assert.equal(result.cs_list.length, 1);
  const logged = diagnostics.find(d => d.stage === 'transfer_staff_excluded');
  assert.ok(logged);
  assert.equal(logged.account_id, '123');
  assert.equal(logged.details.staff_uid, '3');
  assert.equal(logged.details.roster_nick, '店铺:3');
  assert.equal(logged.details.status_nick, '旧名');
  assert.equal(JSON.stringify(logged).includes('must-not-be-logged'), false);
});
test('transport success alone stays pending; known non-invocation is failed', async () => {
  for (const invoked of [true, false]) {
    const f = serviceFixture({ status: 'confirmation_pending', reason: 'pending' });
    f.result({ ok: true, invoked });
    const list = await f.service.list({ conversationId: c.conversationId });
    await assert.rejects(f.service.transfer({ conversationId: c.conversationId, targetCsid: list.cs_list[0].csid }));
    assert.equal(f.calls.at(-1).body.outcome, invoked ? 'confirmation_pending' : 'failed');
    assert.equal(f.calls.filter(x => x === 'transfer').length, 1);
  }
});
test('active sends block transfer and durable guard blocks manual/automatic send', async () => {
  const f = serviceFixture(); const list = await f.service.list({ conversationId: c.conversationId });
  f.locks.add('123|' + c.cid);
  await assert.rejects(f.service.transfer({ conversationId: c.conversationId, targetCsid: list.cs_list[0].csid }), /发送/);
  assert.equal(f.calls.includes('transfer'), false);
  let sends = 0;
  const worker = new QianniuWorkerManager({ enabled: true, sendText: async () => { sends++; }, businessApi: async () => ({ blocked: true }) });
  worker.applyBindings([{ platform_code: 'qianniu', local_account_id: 'qianniu-123', platform_account_id: 'account' }]);
  await assert.rejects(worker.sendMessage({ platformAccountId: 'account', externalConversationId: c.cid, content: 'text' }), /阻止发送/);
  let completion;
  worker.on('task-complete', (...args) => { completion = args; });
  await worker.handleTask({ id: 't', platform_code: 'qianniu', task_type: 'send_message', platform_account_id: 'account',
    payload_json: { platform_account_id: 'account', external_conversation_id: c.cid, content: 'text' } });
  assert.equal(sends, 0); assert.equal(completion[1], 'failed');
});
test('page executes actual roster/status APIs and checks buyer identity without opening chat', async () => {
  let finish; const done = new Promise(resolve => { finish = resolve; });
  let served = false, sequence = 0; const methods = [];
  const query = queryFixture([staff('2')], [status('2')]);
  const env = { _vs: { loginID: { targetId: '123', havMainId: '789', nick: '店铺:甲' } },
    imsdk: { invoke: async method => {
      methods.push(method);
      return { msgs: [{ cid: c.cid, fromid: { targetId: '456', nick: '买家' } }] };
    } },
    workbench: { createSequenceId: () => ++sequence, application: { invoke: (sid, method, raw) => {
      methods.push(method); void query(JSON.parse(raw)).then(value => env.onInvokeNotify(sid, 0, value));
    } } },
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      if (url.endsWith('/result')) { env.__qianniuTransferV1.stop(); finish(body.result); return { ok: true, json: async () => ({}) }; }
      const job = served ? null : { id: 'job', kind: 'list', shopUid: '123', cid: c.cid, buyerUid: '456', buyerNick: '买家', expiresAt: Date.now() + 5000 };
      served = true; return { ok: true, json: async () => ({ job }) };
    } };
  installTransferPage(env, { base: 'local', token: 'test' }, createTransferProtocol);
  const result = await done;
  assert.equal(result.ok, true); assert.equal(result.invoked, false); assert.equal(result.targets[0].uid, '2');
  assert.deepEqual(methods, ['im.singlemsg.GetLocalHisMsg', 'invokeMTopChannelService', 'invokeMTopChannelService']);
});

test('automatic preparation rotates online targets and execution refreshes before transfer', async () => {
  const f = serviceFixture();
  const op = { id: 'operation', status: 'preparing' };
  const identity = { ...c, shopName: '店铺:甲', transfer: op };
  const task = { id: 'auto-task', conversation_id: c.conversationId, platform_account_id: 'account',
    payload_json: { qianniu_auto_operation_id: op.id } };
  f.service.api = async (route, body) => {
    f.calls.push({ route, body });
    return route.endsWith('/begin') ? { id: op.id } : identity;
  };
  let roster = [{ uid: '2', nick: '店铺:乙', pcOnline: true }, { uid: '3', nick: '店铺:丙', mobileOnline: true }];
  f.service.channel.run = async (_context, kind, args) => {
    f.calls.push({ kind, args });
    return kind === 'list' ? { ok: true, targets: roster } : { ok: true, invoked: true };
  };
  assert.equal((await f.service.automatic(task)).target.uid, '2');
  assert.equal((await f.service.automatic(task)).target.uid, '3');
  assert.equal(f.calls.filter(x => x.kind === 'transfer').length, 0);
  op.status = 'ready'; op.target_uid = '2';
  roster = [roster[1]];
  await f.service.automatic(task, true);
  assert.equal(f.calls.find(x => x.kind === 'transfer').args.targetUid, '3');
  assert.equal(f.calls.find(x => x.route?.endsWith('/begin')).body.auto_task_id, task.id);
  assert.equal(f.calls.at(-1).body.outcome, 'transferred');
});

test('automatic empty roster or wrong binding cannot call transfer', async () => {
  const f = serviceFixture();
  f.service.api = async () => ({ ...c, shopName: '店铺:甲', transfer: { id: 'op', status: 'preparing' } });
  f.service.channel.run = async () => ({ ok: true, targets: [] });
  const task = { id: 'task', conversation_id: c.conversationId, platform_account_id: 'account',
    payload_json: { qianniu_auto_operation_id: 'op' } };
  assert.deepEqual(await f.service.automatic(task), { status:'no_online_target', submitted:false });
  assert.deepEqual(await f.service.automatic(task,true), { status:'no_online_target', submitted:false });
  f.service.channel.run = async () => ({ok:false,error:'名单查询失败',targets:[]});
  await assert.rejects(f.service.automatic(task), /查询失败/);
  f.service.channel.run = async () => ({ok:true});
  await assert.rejects(f.service.automatic(task), /查询失败/);
  await assert.rejects(f.service.automatic({ ...task, platform_account_id: 'wrong' }), /身份/);
  assert.equal(f.calls.length, 0);
});

test('automatic no-online result is completed by worker without invoking transfer', async () => {
  let completion;
  const worker = new QianniuWorkerManager({enabled:true});
  worker.applyBindings([{platform_code:'qianniu',local_account_id:'qianniu-123',platform_account_id:'account'}]);
  worker.transferService.automatic = async () => ({status:'no_online_target',submitted:false});
  worker.on('task-complete',(...args)=>{completion=args;});
  await worker.handleTask({id:'empty-roster',platform_code:'qianniu',task_type:'qianniu_transfer_prepare',
    platform_account_id:'account',payload_json:{}});
  assert.equal(completion[1],'completed');
  assert.deepEqual(completion[2],{status:'no_online_target',submitted:false});
});

test('automatic notice uncertain native send reports pending, not failure', async () => {
  let calls = 0, completion;
  const worker = new QianniuWorkerManager({ enabled: true,
    sendText: async () => { calls++; throw Object.assign(new Error('timeout'), { submitted: true }); },
    businessApi: async route => { assert.match(route, /task_id=notice/); return { blocked: false }; } });
  worker.applyBindings([{ platform_code: 'qianniu', local_account_id: 'qianniu-123', platform_account_id: 'account' }]);
  worker.on('task-complete', (...args) => { completion = args; });
  await worker.handleTask({ id: 'notice', platform_code: 'qianniu', task_type: 'send_message', platform_account_id: 'account',
    payload_json: { platform_account_id: 'account', external_conversation_id: c.cid, content: '为您转接中', qianniu_auto_operation_id: 'op' } });
  assert.equal(calls, 1); assert.equal(completion[1], 'confirmation_pending');
});
