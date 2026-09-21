import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { transferProbeScript } from '../electron/platform-workspace/douyin/transfer-probe.js';
import { buildTransferProbeReport } from '../electron/platform-workspace/douyin/transfer-probe-report.js';

const options = { shopId: '123', requestToken: 'token', frameOrigin: 'https://im.jinritemai.com' };
const staffId = '9007199254740993123';
const body = `{"code":0,"data":[{"staffId":${staffId},"staffName":"private-name","staff_username":"private-account","online_status":1,"mobile":"private-phone"},
  {"staffId":"22","staffName":"private-name","staff_username":"account-two","staff_9007199254740993123":"private-value"}]}`;
const envelope = (text = body) => ({ body: text, httpStatus: 200, elapsedMs: 4,
  capability: { pigeonIM: true, transferConversation: true }, currentStaff: { shopId: '123', staffId, staffName: 'private-current' },
  requestBinding: { token: 'token', shopId: '123', staffId } });
const report = (input = envelope()) => buildTransferProbeReport(input, options);

test('preview shows exact long staff ID, duplicate names, unknown status and current-ID comparison', () => {
  const { report: r, preview } = report();
  assert.equal(r.previewCount, 2); assert.equal(r.requestAssociation, 'matched');
  assert.ok(r.staff.every((s) => s.duplicateName));
  assert.equal(r.staff[0].sameIdAsCurrent, true);
  assert.equal(r.staff[0].staffId.fingerprint, r.currentStaff.id.fingerprint);
  assert.match(preview.join(''), new RegExp(staffId));
  assert.match(preview.join(''), /含义待核验/);
  for (const secret of [staffId, 'private-name', 'private-current', 'private-account', 'private-phone', 'private-value', 'account-two'])
    assert.ok(!JSON.stringify(r).includes(secret), secret);
  assert.ok(!preview.join('').includes('private-phone'));
});

test('empty, business failure, HTTP failure, malformed structure and binding mismatch remain distinct', () => {
  assert.equal(report(envelope('{"code":0,"data":[]}')).report.outcome, 'candidate_empty');
  for (const [input, expected] of [[envelope('{"code":9,"data":[]}'), 'business_error'],
    [{ ...envelope(), httpStatus: 403 }, 'http_error'], [envelope('{"code":0,"data":{}}'), 'invalid_shape'],
    [envelope('no-json'), 'invalid_json'], [{ ...envelope(), requestBinding: undefined }, 'request_binding_mismatch']]) {
    const output = report(input); assert.equal(output.report.error, expected); assert.deepEqual(output.preview, []);
  }
  const changed = envelope(); changed.requestBinding.staffId = 'other';
  assert.equal(report(changed).report.error, 'request_binding_mismatch');
});

test('conflicting shop hides candidates, duplicates remain diagnostic and preview is bounded', () => {
  const data = { code: 0, data: [{ staffId: '1', staffName: 'wrong-person', shopId: 'wrong' },
    { staffId: '2', staffName: '同名' }, { staffId: '2', staffName: '同名' }, { staffId: {} }] };
  const r = report(envelope(JSON.stringify(data)));
  assert.ok(!r.preview.join('').includes('wrong-person'));
  assert.equal(r.report.previewCount, 2); assert.equal(r.report.staff[1].duplicateId, true);
  data.shop_id = 'wrong';
  assert.equal(report(envelope(JSON.stringify(data))).report.outcome, 'identity_conflict');
  data.shop_id = '123'; data.data = Array.from({ length: 105 }, (_, i) => ({ staffId: String(i), staffName: '长'.repeat(150) }));
  const large = report(envelope(JSON.stringify(data)));
  assert.equal(large.report.staff.length, 100); assert.equal(large.report.receivedCount, 105);
  assert.equal(large.report.previewTruncated, true);
});

function harness(fetcher, ready = true, capable = true) {
  let transferred = 0;
  const window = ready ? { __PLATFORM_VARIABLES_IN_BENCH__: { extra: { im: { pigeonIM: capable
    ? { transferConversation() { transferred++; throw new Error('must not execute'); } } : {} } } } } : {};
  const calls = [];
  const context = vm.createContext({ window, location: { hostname: 'im.jinritemai.com' },
    AbortController, TextDecoder, setTimeout, clearTimeout,
    fetch: async (url, init) => { calls.push({ url, init }); return fetcher(url, init, calls.length); } });
  return { calls, get transferred() { return transferred; }, run: (change = {}) => vm.runInContext(transferProbeScript({
    action: 'read', token: 'token', shopId: '123', ...change }), context) };
}
const identity = (shop = '123', staff = staffId) => Response.json({ code: 0, data: {
  ShopId: shop, CustomerServiceInfo: { id: staff, screen_name: 'private-current' } } });
const ok = (url) => url.includes('currentuser') ? identity() : new Response(body);

test('exact GET between identity checks; capability check never invokes SDK transfer', async () => {
  const h = harness(ok); const output = await h.run();
  assert.equal(h.calls.length, 3); assert.equal(h.transferred, 0);
  assert.equal(h.calls[1].url, 'https://pigeon.jinritemai.com/backstage/getCanAssignStaffList');
  assert.equal(h.calls[1].init.method, 'GET'); assert.equal(h.calls[1].init.credentials, 'include');
  assert.equal(h.calls[1].init.redirect, 'error'); assert.equal(h.calls[1].init.body, undefined);
  assert.equal(output.capability.transferConversation, true); assert.equal(output.body, body);
  const absent = await harness(ok, true, false).run();
  assert.equal(absent.capability.transferConversation, false); assert.equal(absent.body, body);
});

test('invalid command and missing IM make no request; changed shop or current staff discards body', async () => {
  const notReady = harness(ok, false); assert.equal((await notReady.run()).error, 'im_not_ready');
  assert.equal(notReady.calls.length, 0);
  const invalid = harness(ok); assert.equal((await invalid.run({ shopId: 'wrong' })).error, 'invalid_command');
  assert.equal(invalid.calls.length, 0);
  for (const [shop, staff] of [['456', staffId], ['123', 'other']]) {
    const h = harness((url, _init, n) => n === 3 ? identity(shop, staff) : ok(url));
    const r = await h.run(); assert.equal(r.error, 'identity_mismatch'); assert.equal(r.body, undefined);
  }
  const missing = harness(() => identity('123', ''));
  assert.equal((await missing.run()).error, 'identity_unavailable'); assert.equal(missing.calls.length, 1);
});

test('cancel and busy prevent concurrent reads; excessive response fails without retaining raw text', async () => {
  let entered; const start = new Promise((resolve) => { entered = resolve; });
  const h = harness((url, init) => {
    if (url.includes('currentuser')) return identity();
    entered(); return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('abort'))));
  });
  const pending = h.run(); await start;
  assert.equal((await h.run()).error, 'busy');
  await h.run({ action: 'cancel', token: 'wrong' });
  assert.equal((await h.run()).error, 'busy');
  await h.run({ action: 'cancel' });
  assert.equal((await pending).error, 'cancelled_or_timeout'); assert.equal(h.transferred, 0);
  const oversized = harness((url) => url.includes('currentuser') ? identity() : new Response('x'.repeat(512 * 1024 + 1)));
  const output = await oversized.run(); assert.equal(output.error, 'response_too_large'); assert.equal(output.body, undefined);
});
