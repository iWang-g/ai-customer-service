'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { authorizedMessage, parseArgs } = require('./qn-live-direct-auto-reply-once.cjs');

const expected = {
  shopUid: '2222303856223',
  cid: '2214525969878.1-2216058631944.1#11001@cntaobao',
  buyerUid: '2214525969878',
};

test('allowlist accepts only the authorized incoming message', () => {
  const wake = { loginTargetId: expected.shopUid, cid: expected.cid, senderUid: expected.buyerUid };
  const message = { cid: expected.cid, direction: 'incoming', fromId: expected.buyerUid };
  assert.equal(authorizedMessage(wake, message, expected), true);
  assert.equal(authorizedMessage(wake, message, { ...expected, cid: 'other' }), false);
  assert.equal(authorizedMessage(wake, { ...message, direction: 'outgoing' }, expected), false);
  assert.equal(authorizedMessage({ ...wake, senderUid: 'other' }, message, expected), false);
});

test('CLI parser keeps the bounded one-shot timeout', () => {
  assert.equal(parseArgs(['--timeout-ms', '60000']).timeoutMs, 60000);
  assert.throws(() => parseArgs(['--timeout-ms', '0']), /between/);
  assert.throws(() => parseArgs(['--timeout-ms', '700000']), /between/);
});
