import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { transferObserverScript } from '../electron/platform-workspace/douyin/transfer-observer.js';
import { observerScript } from '../electron/platform-workspace/douyin/observer.js';
import { DouyinTransferObservationBuffer } from '../electron/platform-workspace/douyin/transfer-observation-buffer.js';

const cid = 'private-buyer:123::2:1:pigeon';
function harness() {
  const timers = new Map(); let next = 0;
  const h = { shopId: '123', staffId: '9007199254740993123', requests: [] };
  const context = vm.createContext({ location: { hostname: 'im.jinritemai.com' }, window: {}, AbortController, AbortSignal, TextDecoder,
    setTimeout: (fn) => { const id = ++next; timers.set(id, fn); return id; }, clearTimeout: (id) => timers.delete(id),
    fetch: async (url, init) => {
      h.requests.push({ url, init });
      return Response.json(url.includes('currentuser') ? { code: 0, data: { ShopId: h.shopId, CustomerServiceInfo: { id: h.staffId } } }
        : { code: 0, data: [] });
    } });
  h.eval = (s) => vm.runInContext(s, context);
  h.eval(`window.sdkCalls=0; window.original=function(...args){window.sdkCalls++; window.lastThis=this; window.lastArgs=args; return window.result;};
    window.__PLATFORM_VARIABLES_IN_BENCH__={extra:{im:{pigeonIM:{transferConversation:window.original},_message$:{next(){return 17}},sendText(){}}}};
    window.sdk=window.__PLATFORM_VARIABLES_IN_BENCH__.extra.im.pigeonIM;`);
  h.run = (action = 'start', change = {}) => h.eval(transferObserverScript({ action, token: 'test-token', shopId: '123', staffId: '9007199254740993123', ...change }));
  h.call = (conversation = cid) => h.eval(`window.sdk.transferConversation('2', ${JSON.stringify(conversation)}, '9007199254740993222', null)`);
  h.expire = () => { for (const fn of [...timers.values()]) fn(); };
  return h;
}

test('passive startup, exact this/arguments/value; first conversation scope and restoration', async () => {
  const h = harness(); const start = await h.run();
  assert.equal(start.active, true); assert.equal(h.eval('window.sdkCalls'), 0);
  h.eval('window.result={code:0, data:{owner:"9007199254740993222"}}');
  const result = h.call(); assert.equal(result, h.eval('window.result'));
  assert.equal(h.eval('window.lastThis===window.sdk'), true);
  assert.equal(h.eval('window.lastArgs[3]'), null);
  h.call('another-buyer:123::2:1:pigeon'); h.call('buyer:other-shop::2:1:pigeon');
  const batch = await h.run('stop');
  assert.equal(batch.calls, 1); assert.equal(batch.records.filter((r) => r.kind === 'scope_skipped').length, 2);
  assert.equal(h.eval('window.sdk.transferConversation===window.original'), true);
  assert.equal(batch.records.find((r) => r.kind === 'transfer_call').value.conversationId, cid);
  assert.ok(h.requests.every((r) => r.url.includes('currentuser') && r.init.method === 'GET'));
  assert.equal((await h.run('stop')).error, null, 'stopped observer can still verify identity');
  await h.run('clear');
});

test('exact Promise identity, fulfillment/rejection and exact thrown error; no late records after stop', async () => {
  for (const reject of [false, true]) {
    const h = harness(); await h.run();
    h.eval('window.result=new Promise((resolve,reject)=>{window.resolve=resolve;window.reject=reject})');
    const result = h.call(); assert.equal(result, h.eval('window.result'));
    h.eval(reject ? 'window.reject({code:19,message:"private-error"})' : 'window.resolve({code:0,success:true})');
    await result.catch(() => {});
    const batch = await h.run('stop');
    assert.ok(batch.records.some((r) => r.kind === (reject ? 'transfer_rejected' : 'transfer_resolved')));
    await h.run('clear');
  }
  const h = harness(); h.eval('window.error=new Error("private-error");window.original=window.sdk.transferConversation=function(){throw window.error}');
  await h.run(); assert.throws(() => h.call(), (e) => e === h.eval('window.error'));
  assert.ok((await h.run('stop')).records.some((r) => r.kind === 'transfer_throw')); await h.run('clear');
  const late = harness(); await late.run(); late.eval('window.result=new Promise(resolve=>{window.resolve=resolve})');
  const pending = late.call(); await late.run('stop'); late.eval('window.resolve({code:0})'); await pending;
  assert.equal((await late.run('poll')).records.length, 0); await late.run('clear');
});

test('identity changes discard buffered results, token isolation and expiry restore hook', async () => {
  const h = harness(); await h.run();
  assert.equal((await h.run('start', { token: 'other' })).error, 'busy');
  await h.run('clear', { token: 'other' }); h.call();
  h.staffId = 'new-staff'; const batch = await h.run('stop');
  assert.equal(batch.error, 'identity_changed_or_unavailable'); assert.equal(batch.records.length, 0);
  assert.equal(h.eval('window.sdk.transferConversation===window.original'), true); await h.run('clear');
  const expired = harness(); await expired.run(); expired.expire();
  assert.equal(expired.eval('window.sdk.transferConversation===window.original'), true);
  assert.equal((await expired.run('stop')).active, false); await expired.run('clear');
  const wrong = harness(); wrong.shopId = '456';
  assert.equal((await wrong.run()).error, 'identity_changed_or_unavailable');
  assert.equal(wrong.eval('window.sdk.transferConversation===window.original'), true); await wrong.run('clear');
});

test('message collector shares event tap; unrelated conversations excluded and collector remains installed', async () => {
  const h = harness(); await h.eval(observerScript({ action: 'poll', token: 'collector', mode: 'collector' }));
  h.eval('window.collectorNext=window.__PLATFORM_VARIABLES_IN_BENCH__.extra.im._message$.next');
  assert.equal((await h.run()).messageTap, true); h.call();
  assert.equal(h.eval(`window.__PLATFORM_VARIABLES_IN_BENCH__.extra.im._message$.next({conversationId:${JSON.stringify(cid)},content:'private-message',ext:{owner:'9007199254740993222'}})`), 17);
  h.eval('window.__PLATFORM_VARIABLES_IN_BENCH__.extra.im._message$.next({conversationId:"other",content:"unrelated"})');
  const batch = await h.run('stop'); assert.equal(batch.records.filter((r) => r.kind === 'conversation_event').length, 1);
  assert.equal(h.eval('window.collectorNext===window.__PLATFORM_VARIABLES_IN_BENCH__.extra.im._message$.next'), true);
  await h.run('clear'); await h.eval(observerScript({ action: 'stop', token: 'collector' }));
});

test('getter/toJSON/thenables untouched, shape redaction and same-file correlations, bounded retention', async () => {
  const h = harness(); await h.run();
  h.eval(`window.result={code:0,success:true,content:'private-message', '9007199254740993222':'secret-dynamic-key',token:'secret-token',
    get dangerous(){throw new Error('getter invoked')},toJSON(){throw new Error('toJSON invoked')},then(){throw new Error('then invoked')}}`);
  assert.equal(h.call(), h.eval('window.result'));
  const batch = await h.run('stop'); const b = new DouyinTransferObservationBuffer(); b.ingest(batch);
  const report = b.export(), exported = JSON.stringify(report);
  for (const secret of [cid, '9007199254740993123', '9007199254740993222', 'private-message', 'secret-token', 'secret-dynamic-key']) assert.ok(!exported.includes(secret), secret);
  assert.equal(report.records.find((r) => r.kind === 'transfer_returned').protocolFields.code, 0);
  const call = report.records.find((r) => r.kind === 'transfer_call').shape.fields;
  assert.equal(call.args.items[2].fingerprint, call.targetStaffId.fingerprint);
  for (let n = 0; n < 400; n++) b.ingest(batch);
  assert.ok(b.records.length <= 300); assert.ok(b.dropped > 0); assert.ok(b.bytes <= 4 * 1024 * 1024);
  await h.run('clear');
});

test('page buffer bounds and zero-call exports do not claim successful transfer', async () => {
  const h = harness(); const start = await h.run();
  const b = new DouyinTransferObservationBuffer(); b.ingest(start);
  assert.equal(b.export().outcome, 'no_transfer_call_observed');
  for (let i = 0; i < 120; i++) h.call();
  const batch = await h.run('stop'); assert.ok(batch.records.length <= 100); assert.ok(batch.dropped > 0);
  await h.run('clear');
});

test('T2.1 three-argument null receipt and selected event fields preserve enums, dates and ID correlation', async () => {
  const h = harness(); await h.run();
  h.eval('window.result=Promise.resolve(null)');
  await h.eval(`window.sdk.transferConversation('2',${JSON.stringify(cid)},'9007199254740993222')`);
  h.eval(`window.date=new Date('2026-09-19T06:12:02.075Z');
    window.date.toISOString=()=>{throw new Error('overridden method must not run')};
    window.event={securityConversationId:${JSON.stringify(cid)},createdAt:window.date,type:9001,serverStatus:0,
      serverId:'private-server-id',subConversationShortId:'private-sub-id',version:'9007199254740993999',
      get __internal_ctx(){throw new Error('internal getter must not run')},
      get content(){throw new Error('content getter must not run')},
      ext:{type:'fixture_transfer_event',transfer_type:'3',to_trans_uid:'9007199254740993222',src_user_id:'9007199254740993123',
        's:cur_sub_conv_version':'9007199254740993888',flow_extra:'{"staffId":"9007199254740993222","status":"private-flow-status","token":"private-token"}'}};
    window.__acsDouyinTransferObservationV1.receiveMessage([window.event]);`);
  const batch = await h.run('stop');
  assert.equal(batch.records.find((r) => r.kind === 'transfer_call').value.args.length, 3);
  assert.equal(batch.records.find((r) => r.kind === 'transfer_resolved').value, null);
  const event = batch.records.find((r) => r.kind === 'conversation_event');
  assert.equal(event.truncated, false); assert.equal(event.value[0].__internal_ctx, undefined);
  assert.equal(event.value[0].createdAt, '2026-09-19T06:12:02.075Z');
  const b = new DouyinTransferObservationBuffer(); b.ingest(batch);
  const report = b.export(), row = report.records.find((r) => r.kind === 'conversation_event');
  assert.equal(report.version, 2); assert.equal(report.outcome, 'requires_review');
  assert.deepEqual(row.eventProtocol[0].fields, { type: 9001, serverStatus: 0, 'ext.type': 'fixture_transfer_event', 'ext.transfer_type': '3' });
  assert.equal(row.eventProtocol[0].times.createdAt, '2026-09-19T06:12:02.075Z');
  assert.equal(row.eventProtocol[0].flowExtra.parsing, 'json');
  const f = row.shape.items[0].fields;
  assert.equal(f.flowExtra.fields.value.fields.staffId.fingerprint, f.ext.fields.to_trans_uid.fingerprint);
  for (const secret of ['private-flow-status', 'private-token', 'private-server-id', 'private-sub-id', '9007199254740993222', '9007199254740993888'])
    assert.ok(!JSON.stringify(report).includes(secret), secret);
  await h.run('clear');
});

test('T2.1 array batches isolate messages by explicit conversation fields, never arbitrary content', async () => {
  const h = harness(); await h.run(); h.call();
  h.eval(`window.__acsDouyinTransferObservationV1.receiveMessage([[
    {securityConversationId:'other',content:${JSON.stringify(cid)},type:11},
    {securityConversationId:${JSON.stringify(cid)},type:22,ext:{to_trans_uid:'target'}},
    {ext:{security_biz_conversation_id:${JSON.stringify(cid)},type:'fixture_allocated',is_allocated_event:'1'}},
    {securityConversationId:'unrelated',type:33}
  ]]);`);
  const batch = await h.run('stop'), events = batch.records.filter((r) => r.kind === 'conversation_event');
  assert.equal(events.length, 2); assert.equal(events[0].value[0].type, 22);
  assert.equal(events[1].value[0].ext.is_allocated_event, '1');
  assert.ok(!JSON.stringify(events).includes('unrelated'));
  await h.run('clear');
});

test('T2.1 flow JSON limits, malformed input, unsafe integers and invalid dates remain explicit', async () => {
  const h = harness(); await h.run(); h.call();
  for (const flow of ['{bad', 'x'.repeat(8193), '{"staffId":9007199254740993999}', '{"type":"private-nested-type"}']) {
    h.eval(`window.__acsDouyinTransferObservationV1.receiveMessage([{conversationId:${JSON.stringify(cid)},
      createdAt:new Date(NaN),ext:{flow_extra:${JSON.stringify(flow)}}}]);`);
  }
  const batch = await h.run('stop'), events = batch.records.filter((r) => r.kind === 'conversation_event');
  assert.equal(events[0].value[0].flowExtra.parsing, 'invalid-json');
  assert.equal(events[1].value[0].flowExtra.parsing, 'size-limit'); assert.equal(events[1].truncated, true);
  const long = events[2].value[0].flowExtra.value.staffId;
  assert.ok(long.observationJsonInteger === '9007199254740993999' || long.observationUnsafeJsonNumber === true);
  const b = new DouyinTransferObservationBuffer(); b.ingest(batch);
  for (const row of b.records.filter((r) => r.kind === 'conversation_event')) assert.deepEqual(row.eventProtocol[0].times, {});
  assert.ok(!JSON.stringify(b.export()).includes('private-nested-type'));
  await h.run('clear');
});

test('T2.1 export exposes only bounded exact-path enums and valid time fields', () => {
  const b = new DouyinTransferObservationBuffer();
  b.ingest({ records: [{ kind: 'conversation_event', value: [{ type: 9007199254740992,
    createdAt:'2026-02-31T00:00:00.000Z', createTime:1789798322, createTimestamp:'1789798322075',
    ext:{type:'https://private.example',transfer_type:'private-name',is_allocated_event:'1',attention:'true',
      to_trans_uid:'private-staff',unknown:'private-unknown',nested:{type:'private-nested'}},
    flowExtra:{parsing:'private-parsing',originalLength:'private-length',value:{type:'private-flow-type'}} }] }] });
  const protocol = b.records[0].eventProtocol[0];
  assert.deepEqual(protocol.fields, {'ext.is_allocated_event':'1','ext.attention':'true'});
  assert.deepEqual(protocol.times,{createTime:1789798322,createTimestamp:'1789798322075'});
  assert.equal(protocol.flowExtra.parsing, 'unknown');
  for (const s of ['private.example','private-name','private-staff','private-unknown','private-nested','private-parsing','private-length','private-flow-type'])
    assert.ok(!JSON.stringify(b.export()).includes(s), s);
});
