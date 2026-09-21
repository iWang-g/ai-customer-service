'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ReceiptCorrelator, parseReceiptLine } = require('./receipt-correlator.cjs');
const request = { requestId: 'test-1', account: '3#123', cid: 'test-cid', text: 'test-text',
  streamIdentity: 'pid-42-start-100-file-7', cursor: 100, startedAt: 1000, deadline: 2000 };
const receipt = (fields = {}) => ({ cid: { ccode: request.cid },
  originalData: { text: request.text }, mcode: { clientId: '100', messageId: 'server-1' },
  sendStatus: 0, progress: 100, ...fields });
function line(values = [receipt()], account = request.account, bridge = false) {
  return `[09-07 10:10:08 100 42 7 INFO] app [CHAT shop#${account} ][${bridge ? 'onMsgSendUpdate!' : 'onEventNotify'}][ ${bridge ? '#=123,utf8JsonStr=' : 'strEvent=im.singlemsg.onMsgSendUpdate,jsonStr='}${JSON.stringify(values)} ][${bridge ? 'BridgeChatMsg.cpp(263) operator ()' : 'WebEventCenter.cpp(10) PostEventNotify'}]`;
}
function setup(options = {}) {
  const c = new ReceiptCorrelator({ ...request, ...options });
  let cursor = request.cursor;
  return { c, feed(raw = line(), time = 1100) {
    const end = cursor + Buffer.byteLength(raw) + 1;
    const record = { line: raw, start: cursor, end, observedAt: time,
      streamIdentity: request.streamIdentity };
    c.observe(record);
    cursor = end;
    return record;
  } };
}
const bind = (c, clientId = '100') => c.bindClientId({ clientId,
  source: 'native_callback', evidenceId: 'synthetic-test-proof' });

test('one successful candidate is not request confirmation', () => {
  const { c, feed } = setup(); feed();
  assert.equal(c.snapshot().status, 'observed_success_unbound');
  c.advanceTime(2000);
  assert.equal(c.snapshot().status, 'unknown');
  assert.equal(c.snapshot().retryAllowed, false);
});
test('independently bound client and final receipt confirm', () => {
  const { c, feed } = setup(); bind(c); feed();
  assert.equal(c.snapshot().status, 'confirmed');
});
test('duplicate notifications are not additional sends', () => {
  const { c, feed } = setup(); feed(); feed(line([receipt()], request.account, true));
  const result = c.snapshot();
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].records, 2);
  assert.equal(result.candidates[0].duplicates, 1);
});
test('two identical texts with different clients are ambiguous', () => {
  const { c, feed } = setup(); feed();
  feed(line([receipt({ mcode: { clientId: '101', messageId: 'server-2' } })]));
  assert.equal(c.snapshot().status, 'ambiguous');
  c.advanceTime(2200);
  assert.equal(c.snapshot().status, 'ambiguous');
  bind(c, '101');
  assert.equal(c.snapshot().status, 'confirmed');
});
test('all items in a batch are examined', () => {
  const { c, feed } = setup();
  feed(line([receipt(), receipt({ mcode: { clientId: '101', messageId: 'server-2' } })]));
  assert.equal(c.snapshot().status, 'ambiguous');
});
test('wrong account including suffix match is ignored', () => {
  const { c, feed } = setup(); feed(line([receipt()], '3#9123'));
  feed(line([receipt()], '3#1234'));
  assert.equal(c.snapshot().candidates.length, 0);
});
test('wrong cid, body and receive event are not outgoing candidates', () => {
  const { c, feed } = setup();
  feed(line([receipt({ cid: { ccode: 'other' } })]));
  feed(line([receipt({ originalData: { text: 'other' } })]));
  feed(line().replace('strEvent=im.singlemsg.onMsgSendUpdate',
    'strEvent=im.singlemsg.onShopRobotReceriveNewMsgs'));
  assert.equal(c.snapshot().candidates.length, 0);
});
test('old records and replays cannot add candidates', () => {
  const { c, feed } = setup();
  c.observe({ line: line(), start: 0, end: 100, observedAt: 1000,
    streamIdentity: request.streamIdentity });
  assert.equal(c.snapshot().candidates.length, 0);
  const record = feed(); c.observe(record);
  assert.equal(c.snapshot().candidates[0].records, 1);
});
test('process/file epoch change and cursor gaps fail closed', () => {
  for (const override of [{ streamIdentity: 'new-process' }, { start: 101 }]) {
    const { c } = setup(); bind(c);
    c.observe({ line: line(), start: 100, end: 999, observedAt: 1100,
      streamIdentity: request.streamIdentity, ...override });
    assert.equal(c.snapshot().status, 'unknown');
  }
});
test('partial record overlapping the starting cursor fails closed', () => {
  const { c } = setup();
  c.observe({ line: line(), start: 99, end: 101, observedAt: 1100,
    streamIdentity: request.streamIdentity });
  assert.equal(c.snapshot().status, 'unknown');
});
test('late bound receipt resolves outcome without enabling retry', () => {
  const { c, feed } = setup(); bind(c); c.advanceTime(2000);
  assert.equal(c.snapshot().status, 'unknown'); feed(line(), 2100);
  assert.equal(c.snapshot().status, 'confirmed');
  assert.equal(c.snapshot().timedOut, true);
  assert.equal(c.snapshot().lateRecords, 1);
  assert.equal(c.snapshot().retryAllowed, false);
});
test('late unbound success stays unknown', () => {
  const { c, feed } = setup(); feed(line(), 2100);
  assert.equal(c.snapshot().status, 'unknown');
});
test('same client progression from local ID to server ID is one candidate', () => {
  const { c, feed } = setup(); bind(c);
  feed(line([receipt({ mcode: { clientId: '100', messageId: '' }, progress: 0, sendStatus: 1 })]));
  assert.equal(c.snapshot().status, 'pending'); feed();
  assert.equal(c.snapshot().status, 'confirmed');
  assert.equal(c.snapshot().candidates[0].transitions.length, 2);
});
test('nonzero status, missing server ID or incomplete progress cannot confirm', () => {
  for (const fields of [{ sendStatus: 1 }, { progress: 99 },
    { mcode: { clientId: '100', messageId: '' } }]) {
    const { c, feed } = setup(); bind(c); feed(line([receipt(fields)]));
    assert.equal(c.snapshot().status, 'pending');
  }
});
test('identity conflicts and post-success status regressions fail closed', () => {
  for (const fields of [{ mcode: { clientId: '100', messageId: 'changed' } },
    { mcode: { clientId: '101', messageId: 'server-1' } }, { sendStatus: 1 },
    { originalData: { text: 'changed' } }, { cid: { ccode: 'other-cid' } }]) {
    const { c, feed } = setup(); bind(c); feed(); feed(line([receipt(fields)]));
    assert.equal(c.snapshot().status, 'unknown');
  }
});

test('transition capacity fails closed and does not erase earlier evidence', () => {
  const { c, feed } = setup(); bind(c);
  for (let i = 0; i < 65; ++i) feed(line([receipt({ progress: i % 2, sendStatus: 1 })]));
  assert.equal(c.snapshot().status, 'unknown');
  assert.ok(c.snapshot().issues.includes('transition_limit'));
  assert.equal(c.snapshot().candidates[0].transitions.length, 64);
});

test('target event content cannot spoof another account header', () => {
  const { c, feed } = setup();
  feed(line([receipt({ originalData: { text: `#${request.account} ${request.text}` } })], '3#999'));
  assert.equal(c.snapshot().candidates.length, 0);
});

test('offline capture replay rejects incomplete evidence', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { replayCapture } = require('./receipt-correlator-replay.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qn-receipt-test-'));
  const file = path.join(root, 'fixture.log');
  const bytes = Buffer.from(line() + '\n');
  const metadata = { status: 'complete', initialOffset: 100, finalOffset: 100 + bytes.length,
    copiedBytes: bytes.length, startedAt: '2026-09-07T00:00:00Z', endedAt: '2026-09-07T00:02:00Z' };
  try {
    fs.writeFileSync(file, bytes);
    fs.writeFileSync(`${file}.json`, JSON.stringify(metadata));
    const result = replayCapture(file, request);
    assert.equal(result.status, 'unknown');
    assert.equal(result.candidates[0].success, true);
    assert.equal(result.timingValidated, false);
    fs.writeFileSync(`${file}.json`, JSON.stringify({ ...metadata, status: 'interrupted' }));
    assert.throws(() => replayCapture(file, request), /Incomplete/);
  } finally {
    fs.unlinkSync(file);
    fs.unlinkSync(`${file}.json`);
    fs.rmdirSync(root);
  }
});
test('binding must not come from first log match and cannot be replaced', () => {
  const { c, feed } = setup();
  assert.throws(() => c.bindClientId({ clientId: '100', source: 'log_match', evidenceId: 'x' }));
  bind(c); bind(c, '101'); feed(); assert.equal(c.snapshot().status, 'unknown');
});
test('malformed receipt, lossy numeric IDs and malformed statuses fail closed', () => {
  for (const raw of [line().replace('jsonStr=[', 'jsonStr=[invalid'),
    line([receipt({ mcode: { clientId: 7502548731028308036, messageId: 'server-1' } })]),
    line([receipt({ sendStatus: '0' })]), line([null, receipt({ progress: -1 })])]) {
    const { c, feed } = setup(); bind(c); feed(raw);
    assert.equal(c.snapshot().status, 'unknown');
  }
});
test('JSON parser preserves escaped delimiters and exact Unicode body', () => {
  const text = '\u6d4b\u8bd5 " ] [ jsonStr= \\ \n';
  const value = receipt({ originalData: { text } });
  assert.deepEqual(parseReceiptLine(line([value]), request.account), [value]);
  const { c, feed } = setup({ text }); bind(c); feed(line([value]));
  assert.equal(c.snapshot().status, 'confirmed');
});
test('clock discontinuity and candidate capacity fail closed', () => {
  const { c, feed } = setup(); feed(line(), 999);
  assert.equal(c.snapshot().status, 'unknown');
  const other = setup();
  other.feed(line(Array.from({ length: 17 }, (_, i) => receipt({
    mcode: { clientId: `client-${i}`, messageId: `server-${i}` } }))));
  assert.ok(other.c.snapshot().issues.includes('candidate_limit'));
  assert.equal(other.c.snapshot().candidates.length, 16);
});
test('invalid initialization rejected and snapshots do not mutate internal state', () => {
  assert.throws(() => new ReceiptCorrelator({ ...request, cursor: -1 }));
  const { c, feed } = setup(); feed(); const result = c.snapshot();
  result.candidates[0].success = false; result.issues.push('injected');
  assert.equal(c.snapshot().status, 'observed_success_unbound');
});
