'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { once } = require('node:events');
const { spawn } = require('node:child_process');

test('read RPC rejects old pages, wrong accounts and browser origins; Node results preserve text', async t => {
  const reservation = net.createServer().listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'qn-read-test-'));
  const log = path.join(folder, 'events.ndjson');
  const child = spawn(process.execPath, [path.resolve(__dirname, '../qn-im-bridge-hook-server.js')], {
    windowsHide: true, env: { ...process.env, QN_BRIDGE_HOOK_PORT: String(port), QN_BRIDGE_HOOK_LOG: log },
    stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    if (child.exitCode == null) { const ended = once(child, 'exit'); child.kill(); await ended; }
    if (fs.existsSync(log)) fs.unlinkSync(log); fs.rmdirSync(folder);
  });
  await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw new Error('server failed to start'); })]);
  const base = `http://127.0.0.1:${port}/qn-bridge`;
  async function post(route, body, headers = {}) {
    return fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body), signal: AbortSignal.timeout(3000) });
  }
  const heartbeat = { clientId: 'fixture', kind: 'bridge.page.heartbeat', abilityReady: true,
    state: { loginID: { targetId: '123' } } };
  const request = { clientId: 'fixture', cmd: 'readMessages', param: { shopUid: '123', cid: '456.1-789.1#11001@cntaobao' } };
  await post('', heartbeat);
  assert.equal((await post('/command', request)).status, 409);
  await post('', { ...heartbeat, readMessagesVersion: 1 });
  assert.equal((await post('/command', { ...request, param: { ...request.param, shopUid: '999' } })).status, 400);
  assert.equal((await post('/command', request, { Origin: 'https://untrusted.example' })).status, 403);
  const queued = await post('/command', request); assert.equal(queued.status, 202);
  const { command } = await queued.json();
  const value = { text: '\u6d4b\u8bd5'.repeat(2000) };
  await post('', { kind: 'bridge.command.result', cmd: 'readMessages', clientId: 'fixture', commandId: command.id, ok: true, value });
  const url = `${base}/results?commandId=${command.id}`;
  assert.equal((await fetch(url, { headers: { Origin: 'https://untrusted.example' } })).status, 403);
  assert.deepEqual((await (await fetch(url)).json()).result.value, value);
});

test('new message notices are account-bound, deduplicated and Node-only', async t => {
  const reservation = net.createServer().listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'qn-notice-test-'));
  const log = path.join(folder, 'events.ndjson');
  const child = spawn(process.execPath, [path.resolve(__dirname, '../qn-im-bridge-hook-server.js')], {
    windowsHide: true, env: { ...process.env, QN_BRIDGE_HOOK_PORT: String(port), QN_BRIDGE_HOOK_LOG: log },
    stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { if (child.exitCode == null) { const ended = once(child, 'exit'); child.kill(); await ended; }
    fs.rmSync(folder, { recursive: true, force: true }); });
  await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw new Error('server failed to start'); })]);
  const base = `http://127.0.0.1:${port}/qn-bridge`;
  const post = (route, body) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const shopUid = '2222303856223', mainUid = '2216058631944', buyerUid = '2214525969878';
  const cid = `${buyerUid}.1-${mainUid}.1#11001@cntaobao`;
  await post('', { clientId: 'fixture', kind: 'bridge.page.heartbeat', readMessagesVersion: 1,
    state: { loginID: { targetId: shopUid, havMainId: mainUid } } });
  const body = { kind: 'bridge.message.notice', eventName: 'im.singlemsg.onShopRobotReceriveNewMsgs', clientId: 'fixture',
    items: [{ cid, buyerUid, buyerNick: 'customer', messageId: 'message-1', messageClientId: 'client-1',
      sendTime: '123', fromId: buyerUid, toId: shopUid }] };
  assert.equal((await post('/notice', { ...body, items: [{ ...body.items[0], toId: '999' }] })).status, 400);
  assert.equal((await post('/notice', body)).status, 202);
  assert.equal((await post('/notice', body)).status, 202);
  assert.equal((await fetch(base + '/notices?after=0', { headers: { Origin: 'https://alires-webui' } })).status, 403);
  const first = await (await fetch(base + '/notices?after=0')).json();
  assert.equal(first.notices.length, 1); assert.equal(first.notices[0].shopUid, shopUid);
  assert.equal(first.notices[0].buyerUid, buyerUid); assert.equal(first.notices[0].messageId, 'message-1');
  const reset = await (await fetch(base + `/notices?after=999&instance=old-instance`)).json();
  assert.equal(reset.notices.length, 1); assert.equal(reset.serverInstanceId, first.serverInstanceId);
});

test('send receipts are page-bound, validated, deduplicated and Node-only', async t => {
  const reservation = net.createServer().listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'qn-send-receipt-test-'));
  const log = path.join(folder, 'events.ndjson');
  const child = spawn(process.execPath, [path.resolve(__dirname, '../qn-im-bridge-hook-server.js')], {
    windowsHide: true, env: { ...process.env, QN_BRIDGE_HOOK_PORT: String(port), QN_BRIDGE_HOOK_LOG: log },
    stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { if (child.exitCode == null) { const ended = once(child, 'exit'); child.kill(); await ended; }
    fs.rmSync(folder, { recursive: true, force: true }); });
  await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw new Error('server failed to start'); })]);
  const base = `http://127.0.0.1:${port}/qn-bridge`;
  const post = (route, body) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const shopUid = '2222303856223', mainUid = '2216058631944', buyerUid = '2214525969878';
  const cid = `${buyerUid}.1-${mainUid}.1#11001@cntaobao`;
  await post('', { clientId: 'fixture', kind: 'bridge.page.heartbeat', readMessagesVersion: 1,
    sendReceiptVersion: 1, state: { loginID: { targetId: shopUid, havMainId: mainUid } } });
  const body = { kind: 'bridge.send.receipt', eventName: 'im.singlemsg.onMsgSendUpdate', clientId: 'fixture',
    items: [{ cid, clientId: '111', messageId: 'message-1', text: 'reply', sendStatus: 0,
      progress: 100, sendTime: '123' }] };
  assert.equal((await post('/send-receipt', { ...body, items: [{ ...body.items[0], cid: '1.1-2.1#11001@cntaobao' }] })).status, 400);
  assert.equal((await post('/send-receipt', body)).status, 202);
  assert.equal((await post('/send-receipt', body)).status, 202);
  assert.equal((await fetch(base + '/send-receipts?after=0', { headers: { Origin: 'https://alires-webui' } })).status, 403);
  const first = await (await fetch(base + '/send-receipts?after=0')).json();
  assert.equal(first.receipts.length, 1);
  assert.deepEqual(first.receipts[0], { shopUid, cid, clientId: '111', messageId: 'message-1',
    text: 'reply', sendStatus: 0, progress: 100, sendTime: '123', seq: 1,
    observedAt: first.receipts[0].observedAt });
});
