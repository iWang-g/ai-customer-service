'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createReader, installNewMessageListener, installSendReceiptListener, noticeItems,
  sendReceiptItems, NEW_MESSAGE_EVENT, SEND_RECEIPT_EVENT } = require('./qn-read-messages-page.js');
const shopUid = '2222303856223', main = '2216058631944', buyer = '2214525969878';
const cid = `${buyer}.1-${main}.1#11001@cntaobao`;
function setup(response, change) {
  const calls = [];
  const env = { _vs: { loginID: { targetId: shopUid, havMainId: main }, conversationID: { ccode: 'different-current-cid' } },
    imsdk: { invoke(method, param, timeout) {
      calls.push({ method, param, timeout }); if (change) change(env); return Promise.resolve(response);
    } } };
  return { env, calls, read: createReader(env) };
}
function message(extra = {}) {
  return { cid: { ccode: cid }, fromid: { targetId: buyer, nick: 'customer' }, toid: { targetId: main },
    mcode: { clientId: '7502615584203341922', messageId: '4294243318049.PNM' },
    originalData: { text: '\u6d4b\u8bd5'.repeat(1500) }, sendTime: 1788762947, ...extra };
}
test('reads explicit unselected cid with exact text and string IDs, using only history method', async () => {
  const { read, calls } = setup({ code: 0, result: { msgs: [message()], hasMore: true } });
  const result = await read({ shopUid, cid });
  assert.equal(result.messages[0].text.length, 3000); assert.equal(result.messages[0].direction, 'incoming');
  assert.equal(result.messages[0].clientId, '7502615584203341922');
  assert.equal(result.currentCidBefore, result.currentCidAfter); assert.notEqual(result.currentCidBefore, cid);
  assert.equal(calls.length, 1); assert.equal(calls[0].method, 'im.singlemsg.GetLocalHisMsg');
  assert.deepEqual(calls[0].param, { cid: { ccode: cid, ctype: 0, targetType: '3', targetId: buyer, bizeType: '11001' }, gohistory: 1, count: 20 });
});
test('rejects wrong account, cross-shop cid and invalid counts before bridge call', async () => {
  const { read, calls } = setup({ msgs: [] });
  for (const param of [{ shopUid: '123', cid }, { shopUid, cid: `${buyer}.1-123.1#11001@cntaobao` },
    { shopUid, cid, count: 0 }, { shopUid, cid, count: 21 }, { shopUid, cid, count: '20' }]) await assert.rejects(read(param));
  assert.equal(calls.length, 0);
});
test('failure, wrong response cid and changing shop cannot become successful reads', async () => {
  for (const response of [{ code: 7 }, { result: {} }, { msgs: [message({ cid: { ccode: 'wrong' } })] },
    { msgs: [message({ mcode: { clientId: 7502615584203341922 } })] }])
    await assert.rejects(setup(response).read({ shopUid, cid }));
  await assert.rejects(setup({ msgs: [] }, env => { env._vs.loginID.targetId = '123'; }).read({ shopUid, cid }));
});
test('main account and subaccount outgoing messages are normalized', async () => {
  const msgs = [main, shopUid].map(id => message({ fromid: { targetId: id }, toid: { targetId: buyer } }));
  const result = await setup(JSON.stringify({ code: 0, result: { msgs } })).read({ shopUid, cid });
  assert.deepEqual(result.messages.map(m => m.direction), ['outgoing', 'outgoing']);
  assert.equal((await setup({ msgs: [] }).read({ shopUid, cid })).count, 0);
});

test('media projection retains known nodes and template ID without local paths or unrelated native data', async () => {
  const originalData = { width: 720, height: 1280, secret: 'not-for-storage',
    jsview: [{ type: 7, value: { url: 'https://img.alicdn.com/a.webp', pic: 'local-private-path' } }] };
  const result = await setup({ msgs: [message({ originalData, templateId: 102 })] }).read({ shopUid, cid });
  assert.equal(result.mediaVersion, 1);
  assert.equal(result.messages[0].templateId, 102);
  assert.equal(result.messages[0].originalData.jsview[0].value.url, 'https://img.alicdn.com/a.webp');
  assert.ok(!JSON.stringify(result).includes('not-for-storage'));
  assert.ok(!JSON.stringify(result).includes('local-private-path'));
});
test('oversized payload fails explicitly rather than silently truncating JSON', async () => {
  await assert.rejects(setup({ msgs: [message({ originalData: { text: 'x'.repeat(81000) } })] }).read({ shopUid, cid }), /too large/);
});

test('template reader retains dynamic recommendation data with bounded size', async () => {
  const dynamic = [{ platform: 3, templateId: 295001, templateData: { E2_items: [{ itemId: '123', title: 'item' }] } }];
  const row = message({ templateId: 129, originalData: {}, ext: { dynamic_msg_content: dynamic, secret: 'excluded' } });
  const result = await setup({ msgs: [row] }).read({ shopUid, cid });
  assert.deepEqual(result.messages[0].templateData.dynamicContent, dynamic);
  assert.ok(!JSON.stringify(result).includes('excluded'));
  row.ext.dynamic_msg_content = ['x'.repeat(65000)];
  await assert.rejects(setup({ msgs: [row] }).read({ shopUid, cid }), /template message too large/);
});
test('entire PowerShell-generated hook parses as JavaScript', () => {
  const ps = fs.readFileSync(require.resolve('./install-qn-bridge-hook.ps1'), 'utf8');
  const embedded = /return @"([\s\S]*?)\r?\n"@/.exec(ps)[1]
    .replace('$marker', 'codex-qn-bridge-hook-v8')
    .replace('$readerScript', fs.readFileSync(require.resolve('./qn-read-messages-page.js'), 'utf8'))
    .replace('$safeEndpoint', 'http://127.0.0.1:18082/qn-bridge')
    .replace(/^\s*<script>/, '').replace(/<\/script>\s*$/, '');
  new vm.Script(embedded);
});

test('new message listener posts only bounded routing fields and installs once', async () => {
  let callback;
  const requests = [];
  const env = {
    __codexQnBridgeHookV8: { clientId: 'qnpage-fixture' },
    imsdk: { on(event, fn) { assert.equal(event, NEW_MESSAGE_EVENT); callback = fn; } },
    fetch(url, options) { requests.push({ url, options }); return Promise.resolve(); },
  };
  assert.equal(installNewMessageListener(env, { endpoint: 'http://127.0.0.1/notice' }), true);
  assert.equal(installNewMessageListener(env), false);
  callback(JSON.stringify([{ cid: { ccode: cid, nick: 'customer', targetId: buyer }, newmsgs: [{
    mcode: { messageId: 'message-1', clientId: 'client-1' }, sendTime: 123,
    fromId: { targetId: buyer, secret: 'excluded' }, toId: { targetId: shopUid }, originalData: { text: 'excluded' },
  }], latestmsg: { originalData: { text: 'excluded' } } }]));
  assert.equal(requests.length, 1);
  const body = JSON.parse(requests[0].options.body);
  assert.deepEqual(body.items, [{ cid, buyerNick: 'customer', buyerUid: buyer, messageId: 'message-1',
    messageClientId: 'client-1', sendTime: '123', fromId: buyer, toId: shopUid }]);
  assert.ok(!requests[0].options.body.includes('excluded'));
});

test('notice projection rejects malformed payloads and caps batches', () => {
  assert.deepEqual(noticeItems('not-json'), []);
  const rows = [{ cid: { ccode: cid, targetId: buyer }, newmsgs: Array.from({ length: 30 }, (_, index) => ({
    mcode: { messageId: `message-${index}` }, fromId: { targetId: buyer }, toId: { targetId: shopUid },
  })) }];
  assert.equal(noticeItems(rows).length, 20);
});

test('send receipt listener forwards bounded completion evidence without unrelated fields', async () => {
  let callback;
  const requests = [];
  const env = {
    __codexQnBridgeHookV8: { clientId: 'qnpage-fixture' },
    imsdk: { on(event, fn) { assert.equal(event, SEND_RECEIPT_EVENT); callback = fn; } },
    fetch(url, options) { requests.push({ url, options }); return Promise.resolve(); },
  };
  assert.equal(installSendReceiptListener(env, { endpoint: 'http://127.0.0.1/send-receipt' }), true);
  assert.equal(installSendReceiptListener(env), false);
  callback([{ cid: { ccode: cid }, mcode: { clientId: 'client-1', messageId: 'message-1' },
    originalData: { text: 'reply', secret: 'excluded' }, sendStatus: 0, progress: 100,
    sendTime: 123, delta: { secret: 'excluded' } }]);
  assert.equal(requests.length, 1);
  const body = JSON.parse(requests[0].options.body);
  assert.deepEqual(body.items, [{ cid, clientId: 'client-1', messageId: 'message-1', text: 'reply',
    sendStatus: 0, progress: 100, sendTime: '123' }]);
  assert.ok(!requests[0].options.body.includes('excluded'));
  assert.deepEqual(sendReceiptItems('invalid'), []);
});
