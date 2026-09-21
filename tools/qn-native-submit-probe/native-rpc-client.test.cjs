'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { requestFrame, terminalFrame } = require('./native-rpc-client.cjs');

test('native RPC frame preserves multiline UTF-8 without control delimiters', () => {
  const frame = requestFrame({ requestId: 'request-1', shopUid: '123',
    cid: '456.1-789.1#11001@cntaobao', text: '第一行\n第二行  两个空格' });
  const fields = frame.trimEnd().split('\t');
  assert.equal(fields.length, 5);
  assert.equal(Buffer.from(fields[4], 'hex').toString('utf8'), '第一行\n第二行  两个空格');
  assert.equal(frame.match(/\n/g).length, 1);
});

test('native RPC accepts only correlated non-retry terminal frames', () => {
  assert.deepEqual(terminalFrame('RPC_RESULT id=request-1 code=0 duration_ms=125 retry=0'),
    { requestId: 'request-1', code: 0, durationMs: 125 });
  for (const line of ['RPC_RESULT id=request-1 code=0 duration_ms=125 retry=1',
    'RPC_RESULT id=bad id code=0 duration_ms=1 retry=0', 'RESULT code=0'])
    assert.equal(terminalFrame(line), null);
});
