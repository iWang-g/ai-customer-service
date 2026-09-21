'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ReceiptCorrelator } = require('./receipt-correlator.cjs');
const folder = path.resolve(__dirname, '../../.tmp/qn-native-submit-probe');
const metadata = JSON.parse(fs.readFileSync(path.join(folder, 'completion-test-message-3.json'), 'utf8'));
const native = fs.readFileSync(path.join(folder, 'completion-once-v3-live-20260907.log'), 'utf8');
const match = /RESULT phase=3 hits=1 snapshot_ready=1 snapshot_status=0 result_valid=1 result=0 messageId=(\S+) clientId=(\d+) hit_tid=(\d+) .+ cleanup=1 worker_done=1 /.exec(native);
assert.ok(match, 'one native callback and verified cleanup required');
assert.equal(match[1], metadata.receipt.mcode.messageId);
assert.equal(match[2], metadata.receipt.mcode.clientId);
const streamIdentity = `${metadata.dev}:${metadata.ino}`;
const correlator = new ReceiptCorrelator({ requestId: metadata.text, account: `3#${metadata.shop}`,
  cid: metadata.cid, text: metadata.text, streamIdentity, cursor: metadata.offset,
  startedAt: Date.parse(metadata.startedAt), deadline: Date.parse(metadata.startedAt) + 60000 });
correlator.bindClientId({ clientId: match[2], source: 'native_callback', evidenceId: 'completion-once-v3-live-20260907.log' });
const buffer = fs.readFileSync(path.join(folder, 'completion-test-appended-3.log'));
let start = 0;
for (let end = buffer.indexOf(10, start); end !== -1; end = buffer.indexOf(10, start)) {
  correlator.observe({ line: buffer.subarray(start, end).toString('utf8'), start: metadata.offset + start,
    end: metadata.offset + end + 1, observedAt: Date.parse(metadata.finishedAt), streamIdentity });
  start = end + 1;
}
const result = correlator.snapshot();
assert.equal(result.status, 'confirmed');
assert.deepEqual(result.issues, []);
assert.equal(result.candidates.length, 1);
assert.equal(result.candidates[0].messageId, match[1]);
fs.writeFileSync(path.join(folder, 'completion-evidence-correlation.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ status: result.status, messageId: match[1], clientId: match[2],
  callbackTid: match[3], candidates: result.candidates.length, issues: result.issues, retryAllowed: false }));
