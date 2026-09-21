'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TARGET, buildReadRequest, summarize, mergeStaff, diagnostic } = require('./protocol.cjs');
const { installStaffProbe } = require('./page.cjs');
const { createProbe } = require('./cli.cjs');
const state = { shopUid: TARGET.shopUid, mainUid: TARGET.mainUid, nick: TARGET.shopNick, cid: 'unselected-test' };
const job = { id: 'one', kind: 'list', shopUid: TARGET.shopUid, mainUid: TARGET.mainUid };
const listData = { error: false, result: [{ subUserId: '1234567890123456789', userId: TARGET.mainUid,
  subNick: TARGET.mainNick + ':test-agent', subName: 'private-person-name', subStatus: 2, dispatchStatus: 1, token: 'secret', mobile: 'private' }] };
const statusData = { errorCode: 0, errorMap: {}, module: [{ accountId: TARGET.shopUid, mainAccountId: TARGET.mainUid,
  nick: 'test-agent', pcOnline: true, pcClientOnlineStatus: 2, clientSuspendStatus: 1, suspend: false,
  mobileOnline: false, mobileClientOnlineStatus: -1 }] };
const raw = (j = job, data) => JSON.stringify({ api: buildReadRequest(j, state).method, v: '1.0', ret: ['SUCCESS::ok'],
  data: data || (j.kind === 'list' ? listData : statusData) });
test('fixed target and exactly two read-only APIs; pagination is bounded', () => {
  assert.deepEqual(JSON.parse(buildReadRequest(job, state).param), { nick: TARGET.shopNick, page_no: '1', page_size: '5' });
  assert.deepEqual(JSON.parse(buildReadRequest({ ...job, kind: 'status' }, state).param), { main_account_id: TARGET.mainUid });
  assert.equal(JSON.parse(buildReadRequest({ ...job, pageNo: 2 }, state).param).page_no, '2');
  for (const patch of [{ method: 'forward' }, { kind: 'transfer' }, { pageNo: 21 }, { pageNo: 0 }, { pageNo: '2' },
    { pageSize: 200 }, { kind: 'status', pageNo: 1 }, { shopUid: '1' }, { mainUid: '1' }])
    assert.throws(() => buildReadRequest({ ...job, ...patch }, state));
  for (const patch of [{ shopUid: '1' }, { mainUid: '1' }, { nick: TARGET.mainNick }])
    assert.throws(() => buildReadRequest(job, { ...state, ...patch }));
});
test('preserves exact IDs/status values without declaring transfer eligibility or retaining sensitive fields', () => {
  const r = summarize(raw().replace('"subUserId":"1234567890123456789"', '"subUserId":1234567890123456789'), job, state);
  assert.equal(r.data.result[0].subUserId, '1234567890123456789');
  assert.equal(r.data.result[0].subStatus, 2);
  assert.equal(r.data.result[0].subNick, TARGET.mainNick + ':test-agent');
  assert.equal(r.interpretation, 'observed-schema-status-enums-unverified');
  assert.equal(JSON.stringify(r).includes('secret'), false);
  assert.equal(JSON.stringify(r).includes('private'), false);
  for (const bad of [raw().replace('SUCCESS::ok', 'FAIL::denied'), raw().replace('1.0', '2.0'), raw({ ...job, kind: 'status' })])
    assert.throws(() => summarize(bad, job, state));
});
test('observed business schema rejects cross-shop, missing online state, duplicates and business errors', () => {
  const s = { ...job, kind: 'status' };
  const value = summarize(raw(s), s, state).data.module[0];
  assert.equal(value.pcOnline, true); assert.equal(value.mobileOnline, false);
  assert.equal(value.mobileClientOnlineStatus, -1);
  for (const data of [{ ...listData, error: true }, { ...listData, result: [...listData.result, ...listData.result] },
    { ...listData, result: [{ ...listData.result[0], userId: '99' }] }]) assert.throws(() => summarize(raw(job, data), job, state));
  for (const data of [{ ...statusData, errorCode: 1 }, { ...statusData, errorMap: { fail: 'denied' } },
    { ...statusData, module: [{ ...statusData.module[0], mainAccountId: '99' }] },
    { ...statusData, module: [{ ...statusData.module[0], pcOnline: undefined }] },
    { ...statusData, module: [...statusData.module, ...statusData.module] }]) assert.throws(() => summarize(raw(s, data), s, state));
});
test('offline accounts may omit client enum fields; diagnostic preserves sanitized evidence on schema failures', () => {
  const j = { ...job, kind: 'status' };
  const data = { ...statusData, module: [{ ...statusData.module[0], pcOnline: false,
    clientSuspendStatus: undefined, pcClientOnlineStatus: undefined, token: 'secret' }] };
  const r = summarize(raw(j, data), j, state);
  assert.equal(r.businessSuccess, true);
  assert.equal(r.data.module[0].pcOnline, false);
  const bad = { ...data, module: [{ ...data.module[0], pcOnline: undefined }] };
  assert.throws(() => summarize(raw(j, bad), j, state));
  const d = diagnostic(raw(j, bad), j, state);
  assert.equal(d.schemaValidated, false); assert.equal(d.data.module[0].accountId, TARGET.shopUid);
  assert.equal(JSON.stringify(d).includes('secret'), false);
});
async function pageRun(patch = {}, mutate = false, loseAck = false) {
  let done, calls = 0, unrelated = 0, posts = 0, served = false;
  const complete = new Promise(resolve => { done = resolve; });
  const env = { _vs: { loginID: { targetId: TARGET.shopUid, havMainId: TARGET.mainUid, nick: TARGET.shopNick },
    conversationID: { ccode: state.cid } }, onInvokeNotify: () => { unrelated++; },
    workbench: { createSequenceId: () => 'sid-one', application: { invoke(sid, cmd, data) {
      calls++; assert.equal(cmd, 'invokeMTopChannelService'); assert.equal(JSON.parse(data).method, buildReadRequest(job, state).method);
      env.onInvokeNotify('someone-else', 0, '{}');
      if (mutate) env._vs.conversationID.ccode = 'changed';
      queueMicrotask(() => env.onInvokeNotify(sid, 0, raw()));
    } } }, fetch: async (url, options) => {
      if (url.endsWith('/poll')) { if (served) return { ok: true, json: async () => ({ stop: true }) }; served = true;
        return { ok: true, json: async () => ({ job: { ...job, ...patch } }) }; }
      posts++;
      if (loseAck && posts === 1) throw new Error('Lost delivery acknowledgement');
      const body = JSON.parse(options.body); env.__qnStaffReadProbeV2.stop();
      done({ result: body.result, calls, unrelated, posts }); return { ok: true, json: async () => ({}) };
    } };
  installStaffProbe(env, { ...TARGET, base: 'http://127.0.0.1:18091', token: 'test' }, buildReadRequest);
  return complete;
}
test('page registers callback before invoking and preserves unrelated callbacks/context', async () => {
  const r = await pageRun(); assert.equal(r.result.ok, true); assert.equal(r.calls, 1); assert.equal(r.unrelated, 1);
  assert.deepEqual(r.result.before, r.result.after);
});
test('invalid jobs never invoke; changed context fails; lost result acknowledgement never repeats native query', async () => {
  const rejected = await pageRun({ kind: 'forward' }); assert.equal(rejected.calls, 0); assert.equal(rejected.result.ok, false);
  assert.equal((await pageRun({}, true)).result.ok, false);
  const retry = await pageRun({}, false, true); assert.equal(retry.calls, 1); assert.equal(retry.posts, 2);
});
test('receiver requires explicit run, validates identity/origin/token and acknowledges duplicate results', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qn-staff-test-'));
  const server = createProbe({ token: 'test' }, dir);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + server.address().port;
  async function request(route, body = {}, headers = {}) {
    const r = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ token: 'test', ...body }) });
    return { status: r.status, body: await r.json() };
  }
  const poll = { pageId: 'staff-test-one', state, protocolVersion: 2 };
  assert.equal((await request('/poll', { ...poll, protocolVersion: 1 })).status, 400);
  assert.equal((await request('/status', { token: 'wrong' })).status, 403);
  assert.equal((await request('/run', {}, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await request('/poll', { ...poll, state: { ...state, mainUid: 'bad' } })).status, 400);
  assert.deepEqual((await request('/poll', poll)).body, {});
  assert.equal((await request('/run')).status, 202);
  const first = (await request('/poll', poll)).body.job;
  assert.equal(first.kind, 'list'); assert.deepEqual((await request('/poll', poll)).body, {});
  const result = { pageId: poll.pageId, id: first.id, result: { ok: true, before: state, after: state, raw: raw(first) } };
  assert.equal((await request('/result', { ...result, pageId: 'staff-wrong' })).status, 409);
  assert.equal((await request('/result', result)).status, 200);
  assert.equal((await request('/result', result)).body.duplicate, true);
  const second = (await request('/poll', poll)).body.job; assert.equal(second.kind, 'status');
  await request('/result', { ...result, id: second.id, result: { ok: true, before: state, after: state, raw: raw(second) } });
  const status = (await request('/status')).body;
  assert.equal(status.phase, 'finished'); assert.equal(status.results.length, 2);
  assert.equal(status.results.every(r => r.contextUnchanged), true);
  assert.equal(status.summary.paginationComplete, true);
  assert.equal(fs.existsSync(status.snapshotFile), true);
  assert.equal((await request('/run')).status, 409);
  assert.equal(fs.readFileSync(status.resultFile, 'utf8').includes('secret'), false);
});

const staff = (id, overrides = {}) => ({ ...listData.result[0], subUserId: String(id), subNick: TARGET.mainNick + ':agent' + id, ...overrides });
const statusRow = (id, overrides = {}) => ({ ...statusData.module[0], accountId: String(id), ...overrides });
function record(kind, data, pageNo) {
  const j = { ...job, kind, ...(pageNo ? { pageNo } : {}) };
  return { ...j, at: '2026-09-14T08:00:00Z', contextUnchanged: true, ...summarize(raw(j, data), j, state) };
}
test('merges by UID and separates main/source, PC/mobile online, offline and unknown states', () => {
  const all = ['11', '12', '13', '14', '15', TARGET.shopUid];
  const pages = [record('list', { error: false, result: all.slice(0, 5).map(id => staff(id)) }, 1),
    record('list', { error: false, result: [staff(TARGET.shopUid)] }, 2)];
  const status = record('status', { errorCode: 0, errorMap: {}, module: [
    statusRow('11'), statusRow('12', { pcOnline: false, mobileOnline: true }),
    statusRow('13', { pcOnline: false, mobileOnline: false }),
    statusRow('14', { pcOnline: false, mobileOnline: undefined }),
    statusRow(TARGET.shopUid), statusRow(TARGET.mainUid), statusRow('99')] });
  const r = mergeStaff([...pages, status]);
  assert.deepEqual(r.onlineCandidateIds, ['11', '12']);
  assert.equal(r.onlineAccountCount, 5); assert.equal(r.onlineSubAccountCount, 4);
  assert.equal(r.accounts.find(a => a.accountId === '14').online, null);
  assert.equal(r.accounts.find(a => a.accountId === '15').online, null);
  assert.equal(r.accounts.find(a => a.accountId === '13').online, false);
  assert.ok(r.accounts.every(a => a.transferEligible === null));
  assert.throws(() => mergeStaff([pages[0], status]), /not ended/);
  assert.throws(() => mergeStaff([pages[0], { ...pages[1], parameters: { page_no: '3' } }, status]), /contiguous/);
});
test('receiver paginates full pages, requires terminal short page and rejects repeated IDs', async t => {
  for (const duplicate of [false, true]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qn-staff-pages-'));
    const server = createProbe({ token: 'test' }, dir);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
    const base = 'http://127.0.0.1:' + server.address().port;
    const post = async (route, body = {}) => (await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'test', ...body }) })).json();
    const poll = { pageId: 'staff-pages', protocolVersion: 2, state };
    await post('/poll', poll); await post('/run');
    const respond = (j, data) => post('/result', { pageId: poll.pageId, id: j.id, result: { ok: true, before: state, after: state, raw: raw(j, data) } });
    const first = (await post('/poll', poll)).job; assert.equal(first.pageNo, 1);
    await respond(first, { error: false, result: [1, 2, 3, 4, 5].map(id => staff(id)) });
    const second = (await post('/poll', poll)).job; assert.equal(second.pageNo, 2);
    if (duplicate) {
      await respond(second, { error: false, result: [staff(1)] });
      const s = await post('/status'); assert.equal(s.phase, 'finished'); assert.match(s.results[1].error, /repeated/);
      assert.equal(s.summary, null); continue;
    }
    await respond(second, { error: false, result: [6, 7, 8, 9, 10].map(id => staff(id)) });
    const third = (await post('/poll', poll)).job; assert.equal(third.pageNo, 3);
    await respond(third, { error: false, result: [] });
    const last = (await post('/poll', poll)).job; assert.equal(last.kind, 'status');
    await respond(last, { errorCode: 0, errorMap: {}, module: [statusRow(1)] });
    const s = await post('/status'); assert.equal(s.summary.listedSubAccountCount, 10);
    assert.equal(s.summary.pageCount, 3); assert.deepEqual(s.summary.onlineCandidateIds, ['1']);
  }
});
