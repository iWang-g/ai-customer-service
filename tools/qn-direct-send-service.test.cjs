'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateRequest, parseAdmission, parseResult, parseNativeTiming, nativeFailureDetail,
  correlate, matchBridgeReceipt } = require('./qn-direct-send-service.cjs');

test('truncated bridge receipt requires exact native-bound SDK completion, never retries', () => {
  const metadata = { requestId: 'test-long', shopUid: '123', cid: '456.1-789.1#11001@cntaobao',
    text: '中'.repeat(200), pid: '30704', cursor: 50, dev: 1, ino: 2, startedAt: 1000 };
  const native = { clientId: '123456', messageId: '987.PNM', result: '0', arguments: '1', result_valid: '1' };
  const truncated = '[09-14 13:59:39 404774984 30704 14252 INFO] app [CHAT 测试#3#123 ][onEventNotify][ strEvent=im.singlemsg.onMsgSendUpdate,jsonStr=[{"delta":\n';
  const sdk = '[09-14 13:59:39 404775000 30704 32068 INFO] MessageSDK [][INFO:aim_msg_service_impl.cpp(1598)] [ark][im]update send result success, cid=456.1-789.1#11001@cntaobao,localid=123456,mid=987.PNM,delta=4\n';
  const confirmed = correlate(metadata, native, truncated + sdk, 1100);
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.confirmationSource, 'native_callback_and_sdk_log');
  assert.equal(confirmed.sdkEvidence.offset, 50 + Buffer.byteLength(truncated));
  assert.deepEqual(confirmed.logIssues, ['malformed_target_receipt']);
  assert.equal(confirmed.retryAllowed, false);
  for (const delta of ['0', '1', '3', '4', '15', '1234']) {
    assert.equal(correlate(metadata, native, truncated + sdk.replace('delta=4', 'delta=' + delta), 1100).status, 'confirmed');
  }
  for (const invalid of [sdk.replace('30704', '999'), sdk.replace('456.1', '111.1'),
    sdk.replace('123456', '999'), sdk.replace('987.PNM', 'other.PNM'), sdk.replace('delta=4', 'delta=invalid'),
    sdk.replace('update send result success', 'update send result failed'),
    sdk.trimEnd(), 'prefix ' + sdk]) {
    assert.notEqual(correlate(metadata, native, truncated + invalid, 1100).status, 'confirmed');
  }
  assert.notEqual(correlate(metadata, native, truncated, 1100).status, 'confirmed');
  assert.notEqual(correlate(metadata, { ...native, result: '1' }, truncated + sdk, 1100).status, 'confirmed');
  assert.notEqual(correlate(metadata, native, truncated + sdk, 62000).status, 'confirmed');
  const conflict = { cid: { ccode: metadata.cid }, mcode: { clientId: native.clientId, messageId: native.messageId }, originalData: { text: 'different' } };
  const full = '[09-14 13:59:39 404774984 30704 14252 INFO] app [CHAT 测试#3#123 ][onEventNotify][ strEvent=im.singlemsg.onMsgSendUpdate,jsonStr=' + JSON.stringify([conflict]) + ' ][WebEventCenter.cpp(10) PostEventNotify]\n';
  assert.notEqual(correlate(metadata, native, full + sdk, 1100).status, 'confirmed');
});

test('long and multiline text accepts UTF-8 bytes through 4095 without truncation', () => {
  const validate = text => validateRequest('2222303856223', '2214525969878.1-2216058631944.1#11001@cntaobao', text);
  for (const text of ['中'.repeat(122), 'a'.repeat(4095), '中'.repeat(1365), '😀'.repeat(1023) + '中',
    '第一行\n第二行', '前文\n\n后文'])
    assert.equal(validate(text).text, text);
  for (const text of ['', ' \n ', 'a'.repeat(4096), '中'.repeat(1366), '😀'.repeat(1024), 'a\0b', '\ud800', 'a\rb'])
    assert.throws(() => validate(text));
});

test('direct service validates single Taobao request identity and plain text', () => {
  assert.deepEqual(validateRequest('2222303856223', '2214525969878.1-2216058631944.1#11001@cntaobao', '你好').shopUid,
    '2222303856223');
  for (const args of [
    ['x', '2214525969878.1-2216058631944.1#11001@cntaobao', 'x'],
    ['2222303856223', 'wrong', 'x'],
    ['2222303856223', '2214525969878.1-2216058631944.1#11001@cntaobao', 'a\rb'],
  ]) assert.throws(() => validateRequest(...args));
});

test('direct service parses and checks native admission and callback receipt', () => {
  assert.equal(parseAdmission('ADMISSION pid=1 tid=2 created=3 account=3#2222303856223').account, '3#2222303856223');
  const receipt = 'RESULT phase=4 error=0 resident=1 admitted=1 arguments=1 caller_released=1 entered=1 returned=1 ' +
    'callbacks=1 destroyed=1 invalid=0 conflicts=0 callback_created=1 cleanup_ack=1 snapshot_status=0 ' +
    'result_valid=1 result=0 messageId=m clientId=123';
  assert.equal(parseResult(receipt).clientId, '123');
  assert.throws(() => parseResult(receipt.replace('cleanup_ack=1', 'cleanup_ack=0')));
  assert.throws(() => parseResult('RESULT phase=4 error=1 result=0'));
  assert.deepEqual(parseNativeTiming('NATIVE_TIMING select_ms=12 admit_ms=3 execute_ms=45 total_ms=60 cache=1'),
    { selectMs: 12, admitMs: 3, executeMs: 45, totalMs: 60, cacheHit: true });
  assert.equal(parseNativeTiming('NATIVE_TIMING select_ms=x'), null);
});

test('native refusal keeps diagnostic gate and exit code without message command line', () => {
  const detail = nativeFailureDetail({ status: 2, stdout: 'INTENT text=private-message\nREFUSE unsupported_native_layout pid=123 sdk_send=0\n' });
  assert.match(detail, /exit=2/);
  assert.match(detail, /unsupported_native_layout/);
  assert.ok(!detail.includes('private-message'));
  assert.match(nativeFailureDetail({ code: 'ETIMEDOUT', signal: 'SIGTERM' }), /ETIMEDOUT/);
});

test('bridge receipt requires native-bound account, cid, text and message identity', () => {
  const metadata = { requestId: 'request-1', shopUid: '123', cid: '456.1-789.1#11001@cntaobao', text: 'reply' };
  const native = { clientId: '111', messageId: '222.PNM' };
  const state = { instance: 'server-1', after: 3 };
  const receipt = { seq: 4, shopUid: '123', cid: metadata.cid, clientId: '111', messageId: '222.PNM',
    text: 'reply', sendStatus: 0, progress: 100 };
  const confirmed = matchBridgeReceipt(metadata, native, state,
    { serverInstanceId: 'server-1', receipts: [receipt] });
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.result.confirmationSource, 'bridge_send_receipt');
  assert.equal(confirmed.nextAfter, 4);
  for (const changed of [
    { shopUid: '999' }, { cid: '1.1-2.1#11001@cntaobao' }, { text: 'other' }, { messageId: '333.PNM' },
  ]) {
    const result = matchBridgeReceipt(metadata, native, state,
      { serverInstanceId: 'server-1', receipts: [{ ...receipt, ...changed }] });
    assert.equal(result.status, 'unknown');
  }
  assert.equal(matchBridgeReceipt(metadata, native, state,
    { serverInstanceId: 'server-2', receipts: [receipt] }).status, 'unavailable');
});
