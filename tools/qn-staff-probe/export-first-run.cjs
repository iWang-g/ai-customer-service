'use strict';
// Offline reconciliation of the first live run; never invokes Qianniu or the receiver.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { TARGET, summarize, parse } = require('./protocol.cjs');
const root = path.resolve(__dirname, '../..');
const source = path.join(root, '.tmp/qn-staff-probe/run-2026-09-14T08-02-16-470Z.ndjson');
const records = fs.readFileSync(source, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
assert.equal(records.length, 2);
const list = records.find(r => r.kind === 'list'), status = records.find(r => r.kind === 'status');
assert.equal(list.id, '52fee659-95c4-4dd3-8c91-1bf706ac15b4');
assert.equal(status.id, 'c5e727e5-a114-457b-a73d-fbfc756044a7');
for (const r of records) {
  assert.equal(r.shopUid, TARGET.shopUid); assert.equal(r.mainUid, TARGET.mainUid);
  assert.equal(r.contextUnchanged, true); assert.equal(r.apiSuccess, true);
}
const matches = [];
const lines = fs.readFileSync('D:/AliWorkbenchData/System/log/app.log', 'utf8').split(/\r?\n/);
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (!/^\[09-14 16:04:37 \d+ 32392 /.test(line) || !line.includes('[MTOP 有求必应羊羊:王刚#3#2222303856223 ]') ||
      !line.includes('[response.') || !line.includes('"api":"mtop.taobao.mmp.subuser.page.get"')) continue;
  const start = line.indexOf('[ data=');
  if (start < 0 || !line.endsWith('},')) continue;
  const raw = line.slice(start + 7, -1);
  try { if (parse(raw).api === list.api) matches.push({ raw, line: i + 1 }); } catch { /* Ignore truncated log records. */ }
}
assert.equal(matches.length, 1, 'Expected a unique complete log record');
const state = { shopUid: TARGET.shopUid, mainUid: TARGET.mainUid, nick: TARGET.shopNick,
  cid: '2207408968472.1-2216058631944.1#11001@cntaobao' };
const enriched = summarize(matches[0].raw, { id: list.id, kind: 'list', shopUid: TARGET.shopUid, mainUid: TARGET.mainUid }, state);
assert.deepEqual(enriched.data.result.map(a => String(a.subUserId)), list.data.result.map(a => String(a.subUserId)));
assert.equal(status.data.errorCode, 0); assert.deepEqual(status.data.errorMap, {});
const rows = status.data.module;
assert.equal(new Set(rows.map(a => String(a.accountId))).size, rows.length);
assert.ok(rows.every(a => String(a.mainAccountId) === TARGET.mainUid && typeof a.suspend === 'boolean'));
const accounts = rows.map(a => ({ accountId: String(a.accountId), mainAccountId: String(a.mainAccountId),
  nick: a.nick, role: String(a.accountId) === TARGET.mainUid ? 'main' : 'sub',
  suspend: a.suspend, pcOnline: null, pcOnlineEvidence: 'omitted-by-first-run-projection', transferEligible: null }));
const ids = new Set(accounts.map(a => a.accountId));
const result = { source: 'offline-enrichment-of-live-probe', shop: TARGET,
  capturedAt: { list: list.at, status: status.at }, contextUnchanged: true, context: state,
  list: { ...enriched, evidence: { file: 'D:/AliWorkbenchData/System/log/app.log', line: matches[0].line, pid: 32392 } },
  status: { accountCount: accounts.length, subAccountCount: accounts.filter(a => a.role === 'sub').length,
    errorCode: 0, accounts },
  listIdsMissingFromStatus: enriched.data.result.filter(a => !ids.has(String(a.subUserId))).map(a => String(a.subUserId)),
  limitations: ['Only the first five list records were requested; no complete-list total was returned.',
    'The first receiver projection omitted pcOnline, client status enums and list nicknames.',
    'List nicknames and subStatus were recovered from a unique complete log record for the same request.',
    'The status log is truncated; omitted online fields remain unknown and were not reconstructed.',
    'List and status membership can differ; absence is not proof of offline/disabled status.',
    'Numeric status enums and actual transfer eligibility remain unverified. No transfer was attempted.'] };
const file = path.join(root, 'qianniu-test/staff-readonly-20260914.json');
fs.writeFileSync(file, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ file, listCount: enriched.accountCount, statusCount: accounts.length,
  subAccountCount: result.status.subAccountCount, listIdsMissingFromStatus: result.listIdsMissingFromStatus }));
