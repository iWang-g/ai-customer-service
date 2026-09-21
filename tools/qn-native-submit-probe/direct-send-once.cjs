'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { ReceiptCorrelator } = require('./receipt-correlator.cjs');

const shop = '2222303856223';
const cid = '2214525969878.1-2216058631944.1#11001@cntaobao';
const target = '2214525969878';
const root = path.resolve(__dirname, '../..');
const folder = path.join(root, '.tmp/qn-native-submit-probe');
const intentPath = path.join(folder, 'direct-v1-intent.json');
const outputPath = path.join(folder, 'direct-v1-controller.log');
const capturePath = path.join(folder, 'direct-v1-appended.log');
const resultPath = path.join(folder, 'direct-v1-result.json');
const logPath = 'D:/AliWorkbenchData/System/log/app.log';
const exe = path.join(__dirname, 'build/qn_direct_once_probe_v1.exe');
const base = 'http://127.0.0.1:18082/qn-bridge';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function durable(file, value) {
  const fd = fs.openSync(file, 'wx');
  try { fs.writeFileSync(fd, typeof value === 'string' ? value : JSON.stringify(value, null, 2)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}
async function json(url, body) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000),
    ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
async function command(clientId, cmd) {
  // Deliberately no openChat, input insertion, Enter or UI automation.
  assert.ok(['getLoginuser', 'getActiveUser'].includes(cmd));
  const { command: queued } = await json(`${base}/command`, { clientId, cmd, param: {} });
  const deadline = Date.now() + 16000;
  while (Date.now() < deadline) {
    await sleep(100);
    const { result } = await json(`${base}/results?commandId=${encodeURIComponent(queued.id)}`);
    if (!result) continue;
    assert.equal(result.ok, true, `${cmd} failed`); return result;
  }
  throw new Error(`${cmd} timeout; no send issued by this read-only command`);
}
function context(state) {
  return { shop: state?.loginID?.targetId, target: state?.conversationID?.targetId, cid: state?.conversationID?.ccode };
}
function correlate(metadata, native, buffer, now, evidenceId = path.basename(outputPath)) {
  const line = native.split(/\r?\n/).find(item => item.startsWith('RESULT '));
  assert.ok(line, 'fresh native receipt required');
  const fields = Object.fromEntries([...line.matchAll(/(\w+)=([^ ]*)/g)].map(m => [m[1], m[2]]));
  for (const key of ['resident', 'admitted', 'arguments', 'caller_released', 'entered', 'returned', 'callbacks', 'destroyed', 'result_valid'])
    assert.equal(fields[key], '1', key);
  for (const key of ['error', 'invalid', 'conflicts', 'snapshot_status', 'result']) assert.equal(fields[key], '0', key);
  assert.match(fields.clientId, /^\d+$/); assert.ok(fields.messageId);
  const streamIdentity = `${metadata.dev}:${metadata.ino}`;
  const receipt = new ReceiptCorrelator({ requestId: metadata.requestId, account: `3#${metadata.shopUid}`,
    cid: metadata.cid, text: metadata.text, streamIdentity, cursor: metadata.cursor,
    startedAt: metadata.startedAt, deadline: metadata.startedAt + 60000 });
  receipt.bindClientId({ clientId: fields.clientId, source: 'native_callback', evidenceId });
  let start = 0;
  for (let end = buffer.indexOf(10, start); end !== -1; end = buffer.indexOf(10, start)) {
    receipt.observe({ line: buffer.subarray(start, end).toString('utf8'), start: metadata.cursor + start,
      end: metadata.cursor + end + 1, streamIdentity, observedAt: now });
    start = end + 1;
  }
  const result = receipt.snapshot();
  if (result.status === 'confirmed') {
    assert.deepEqual(result.issues, []); assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].messageId, fields.messageId);
  }
  return { ...result, native: fields };
}
async function sendText(shopUid, requestedCid, text) {
  assert.equal(shopUid, shop, 'only the authorized test shop is enabled');
  assert.equal(requestedCid, cid, 'only the authorized test conversation is enabled');
  assert.match(text, /^CodexDirectSend-\d{10,40}$/);
  assert.ok(!fs.existsSync(intentPath), 'one-shot intent already exists; use read-only evidence review, never retry');
  const { clients } = await json(`${base}/clients`);
  const matches = clients.filter(c => c.state?.loginID?.targetId === shop && c.abilityReady && c.waiting);
  assert.equal(matches.length, 1, 'unique live target-shop page');
  const clientId = matches[0].clientId;
  const login = await command(clientId, 'getLoginuser');
  const active = await command(clientId, 'getActiveUser');
  assert.equal(login.state?.loginID?.targetId, shop);
  assert.equal(login.state?.loginID?.nick, '\u6709\u6c42\u5fc5\u5e94\u7f8a\u7f8a:\u738b\u521a');
  assert.equal(active.state?.loginID?.targetId, shop);
  assert.equal(active.value.securityUID, target); assert.equal(active.value.cid, cid);
  assert.equal(active.state?.conversationID?.nick, 'tb4947894539');
  const preflight = spawnSync(exe, ['--preflight'], { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 30000 });
  assert.equal(preflight.status, 0, preflight.stdout + preflight.stderr);
  const logFd = fs.openSync(logPath, 'r');
  try {
    const stat = fs.fstatSync(logFd);
    // Align to the last complete line; a partially written record is not silently dropped.
    const tail = Buffer.alloc(Math.min(stat.size, 1024 * 1024));
    assert.equal(fs.readSync(logFd, tail, 0, tail.length, stat.size - tail.length), tail.length);
    const newline = tail.lastIndexOf(10); assert.ok(newline >= 0);
    const cursor = stat.size - tail.length + newline + 1;
    const metadata = { requestId: text, shopUid, cid, target, text, clientId, login, active,
      clientContextsBefore: clients.map(c => ({ clientId: c.clientId, ...context(c.state) })),
      startedAt: Date.now(), logPath, cursor, dev: stat.dev, ino: stat.ino, preflight: preflight.stdout, retryAllowed: false };
    durable(intentPath, metadata);
    const outputFd = fs.openSync(outputPath, 'wx');
    let execution;
    try {
      execution = spawnSync(exe, ['--send-once', 'QN_DIRECT_SEND_ONCE', text],
        { cwd: root, windowsHide: true, stdio: ['ignore', outputFd, outputFd], timeout: 45000 });
      fs.fsyncSync(outputFd);
    } finally { fs.closeSync(outputFd); }
    const native = fs.readFileSync(outputPath, 'utf8'); process.stdout.write(native);
    assert.equal(execution.status, 0, 'native result failed/unknown; no automatic retry');
    const deadline = Date.now() + 15000;
    let result = null, capture = Buffer.alloc(0);
    do {
      await sleep(500);
      const after = fs.statSync(logPath), retained = fs.fstatSync(logFd);
      assert.equal(after.dev, stat.dev); assert.equal(after.ino, stat.ino);
      assert.equal(retained.ino, stat.ino); assert.ok(after.size >= stat.size && after.size - cursor <= 16 * 1024 * 1024);
      capture = Buffer.alloc(after.size - cursor);
      assert.equal(fs.readSync(logFd, capture, 0, capture.length, cursor), capture.length);
      result = correlate(metadata, native, capture, Date.now());
    } while (result.status !== 'confirmed' && Date.now() < deadline);
    durable(capturePath, capture.toString('utf8'));
    const afterActive = await command(clientId, 'getActiveUser');
    const afterClients = await json(`${base}/clients`);
    const contextUnchanged = JSON.stringify(context(afterActive.state)) === JSON.stringify(context(active.state));
    result = { ...result, contextUnchanged, activeAfter: afterActive,
      clientContextsAfter: afterClients.clients.map(c => ({ clientId: c.clientId, ...context(c.state) })),
      observedAt: Date.now() };
    durable(resultPath, result);
    assert.equal(result.status, 'confirmed', 'no confirmed final receipt; do not retry');
    console.log(JSON.stringify({ status: result.status, text, shopUid, cid, messageId: result.native.messageId,
      clientId: result.native.clientId, callbackDestroyed: result.native.destroyed, contextUnchanged, retryAllowed: false }));
    return result;
  } finally { fs.closeSync(logFd); }
}
if (require.main === module) {
  if (process.argv.length !== 3 || process.argv[2] !== 'QN_DIRECT_SEND_ONCE') {
    console.error('Explicit QN_DIRECT_SEND_ONCE confirmation required; fixed authorized test destination only.'); process.exitCode = 2;
  } else sendText(shop, cid, `CodexDirectSend-${new Date().toISOString().replace(/\D/g, '')}`)
    .catch(error => { console.error(`${error.message}; retryAllowed=false`); process.exitCode = 1; });
}
module.exports = { sendText, correlate, durable, command, json, context };
