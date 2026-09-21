'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { correlate, sendText } = require('./direct-send-once.cjs');
const metadata = { requestId: 'fixture', shopUid: '123', cid: 'fixture-cid', text: 'fixture-text',
  dev: 1, ino: 2, cursor: 0, startedAt: 1000 };
const native = 'RESULT phase=4 error=0 resident=1 admitted=1 arguments=1 caller_released=1 entered=1 returned=1 ' +
  'callbacks=1 destroyed=1 invalid=0 conflicts=0 snapshot_status=0 result_valid=1 result=0 messageId=server-1 clientId=123';
function line(clientId = '123', messageId = 'server-1', shop = '123') {
  const receipt = { cid: { ccode: metadata.cid }, originalData: { text: metadata.text },
    mcode: { clientId, messageId }, sendStatus: 0, progress: 100 };
  return `[09-07 14:18:50 INFO] app [CHAT fixture#3#${shop} ][onEventNotify][ strEvent=im.singlemsg.onMsgSendUpdate,jsonStr=` +
    `${JSON.stringify([receipt])} ][WebEventCenter.cpp(10) PostEventNotify]\n`;
}
test('new orchestrator requires native and independent business receipt', () => {
  const result = correlate(metadata, native, Buffer.from(line()), 1100);
  assert.equal(result.status, 'confirmed'); assert.equal(result.retryAllowed, false);
  assert.notEqual(correlate(metadata, native, Buffer.from(line('124')), 1100).status, 'confirmed');
  assert.notEqual(correlate(metadata, native, Buffer.from(line('123', 'server-1', '124')), 1100).status, 'confirmed');
});
test('new orchestrator rejects callback anomalies and conflicting IDs', () => {
  for (const bad of [native.replace('callbacks=1', 'callbacks=0'), native.replace('conflicts=0', 'conflicts=1'),
    native.replace('result=0 ', 'result=7 '), native.replace('destroyed=1', 'destroyed=0')])
    assert.throws(() => correlate(metadata, bad, Buffer.from(line()), 1100));
  assert.throws(() => correlate(metadata, native, Buffer.from(line('123', 'wrong-id')), 1100));
  assert.notEqual(correlate(metadata, native, Buffer.from(line() + line('124')), 1100).status, 'confirmed');
});
test('incomplete final log line is not confirmation', () => {
  assert.notEqual(correlate(metadata, native, Buffer.from(line().trimEnd()), 1100).status, 'confirmed');
});
test('unauthorized parameters reject before any network or native invocation', async () => {
  await assert.rejects(sendText('123', 'wrong', 'text'), /authorized test shop/);
  await assert.rejects(sendText('2222303856223', 'wrong', 'text'), /authorized test conversation/);
  await assert.rejects(sendText('2222303856223', '2214525969878.1-2216058631944.1#11001@cntaobao', 'text'));
});
