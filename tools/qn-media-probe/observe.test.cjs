'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { incoming, mediaUpdate, livePage } = require('./observe.cjs');
const { TARGET } = require('./inspect.js');

test('only target buyer incoming events are accepted', () => {
  const line = 'MessageSDK [][3#' + TARGET.shopUid + '] [OnMessageArrive] dmsg.cid=' + TARGET.cid +
    ',dmsg.mid=123.PNM,dmsg.sender.uid=2214525969878,';
  assert.equal(incoming(line).messageId, '123.PNM');
  assert.equal(incoming(line.replace('dmsg.sender.uid=2214525969878', 'dmsg.sender.uid=' + TARGET.mainUid)), null);
  assert.equal(incoming(line.replace('3#' + TARGET.shopUid, '3#1')), null);
});
test('media update extraction is scoped and retains exact message and node identity', () => {
  const update = { ccode: TARGET.cid, mcode: { messageId: '123.PNM', clientId: '7503334336012222559' },
    index: 0, update: { type: 7, value: { pic: 'pic:impicture|fixture' } } };
  const line = '[CHAT test#3#' + TARGET.shopUid + ' ][onEventNotify][ strEvent=im.media.onJSViewUpdate,jsonStr=' +
    JSON.stringify(update) + ' ][WebEventCenter.cpp(10) PostEventNotify]';
  assert.deepEqual(mediaUpdate(line), update);
  assert.equal(mediaUpdate(line.replace(TARGET.cid, 'other-cid')), null);
  assert.equal(mediaUpdate(line.replace('3#' + TARGET.shopUid, '3#1')), null);
});
test('observation refuses old pages and a selected target', () => {
  const page = { pageId: 'test', ready: true, probeVersion: 2, lastSeen: Date.now(), state: { ...TARGET, cid: 'other' } };
  assert.equal(livePage({ pages: [page] }), page);
  assert.throws(() => livePage({ pages: [{ ...page, probeVersion: 1 }] }), /v2/);
  assert.throws(() => livePage({ pages: [{ ...page, state: TARGET }] }), /different conversation/);
});
