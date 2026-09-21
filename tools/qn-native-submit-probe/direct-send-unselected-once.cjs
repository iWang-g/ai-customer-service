'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { correlate, durable, command, json, context } = require('./direct-send-once.cjs');
const root = path.resolve(__dirname, '../..');
const folder = path.join(root, '.tmp/qn-native-submit-probe');
const shopUid = '2222303856223';
const cid = '2214525969878.1-2216058631944.1#11001@cntaobao';
const target = '2214525969878';
const base = 'http://127.0.0.1:18082/qn-bridge';
const exe = path.join(__dirname, 'build/qn_direct_once_probe_v2.exe');
const logPath = 'D:/AliWorkbenchData/System/log/app.log';
const intentPath = path.join(folder, 'direct-v2-intent.json');
const outputPath = path.join(folder, 'direct-v2-controller.log');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function readActive(clientId) {
  const deadline = Date.now() + 75000;
  while (true) {
    try { return await command(clientId, 'getActiveUser'); }
    catch (error) {
      // Only retry a rejected read-only request. This never dispatches a send.
      if (error.message !== 'HTTP 409' || Date.now() >= deadline) throw error;
      await sleep(1000);
    }
  }
}
function identity(output) {
  const m = /^ADMISSION pid=(\d+) tid=(\d+) created=(\d+) /m.exec(output);
  assert.ok(m, 'process identity missing');
  return { pid: m[1], tid: m[2], created: m[3] };
}
function validateUnselected(login, active) {
  assert.equal(login.state?.loginID?.targetId, shopUid);
  assert.equal(active.state?.loginID?.targetId, shopUid);
  assert.ok(active.value?.cid && active.value.securityUID, 'read-only current context required');
  assert.notEqual(active.value.cid, cid, 'target must not be selected in this experiment');
  assert.notEqual(active.value.securityUID, target, 'target customer must not be selected');
  assert.equal(active.state?.conversationID?.ccode, active.value.cid);
  assert.equal(active.state?.conversationID?.targetId, active.value.securityUID);
}
function windowEvidence(output) {
  const line = output.split(/\r?\n/).find(s => s.startsWith('WINDOW_WATCH '));
  assert.ok(line, 'window observation missing');
  const f = Object.fromEntries([...line.matchAll(/(\w+)=(\d+)/g)].map(m => [m[1], Number(m[2])]));
  for (const key of ['ready', 'baseline_minimized', 'final_minimized']) assert.equal(f[key], 1, key);
  for (const key of ['not_minimized_samples', 'invalid_window_samples', 'restore_events', 'target_foreground_events'])
    assert.equal(f[key], 0, key);
  assert.ok(f.samples >= 20, 'insufficient minimized observation');
  return f;
}
async function main() {
  assert.ok(!fs.existsSync(intentPath), 'V2 intent exists; never repeat an unknown send');
  const prior = JSON.parse(fs.readFileSync(path.join(folder, 'direct-v1-intent.json'), 'utf8'));
  const priorResult = JSON.parse(fs.readFileSync(path.join(folder, 'direct-v1-result.json'), 'utf8'));
  const priorNative = fs.readFileSync(path.join(folder, 'direct-v1-controller.log'), 'utf8');
  assert.equal(prior.shopUid, shopUid); assert.equal(prior.cid, cid); assert.equal(prior.target, target);
  const priorVerified = correlate(prior, priorNative, fs.readFileSync(path.join(folder, 'direct-v1-appended.log')), priorResult.observedAt);
  assert.equal(priorVerified.status, 'confirmed', 'prior account/cid mapping not independently confirmed');
  const beforeClients = await json(`${base}/clients`);
  const matches = beforeClients.clients.filter(c => c.state?.loginID?.targetId === shopUid && c.abilityReady && c.waiting);
  assert.equal(matches.length, 1, 'unique target-shop page required for read-only context evidence');
  const clientId = matches[0].clientId;
  const active = await readActive(clientId);
  const login = { state: active.state, source: 'getActiveUser.result.state.loginID' };
  validateUnselected(login, active);
  const preflight = spawnSync(exe, ['--preflight'], { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 30000 });
  assert.equal(preflight.status, 0, preflight.stdout + preflight.stderr);
  assert.match(preflight.stdout, /PREFLIGHT passed=1 hook=0 sdk_send=0 minimized=1 /);
  assert.deepEqual(identity(preflight.stdout), identity(priorNative), 'mapping cannot be carried across a process restart');
  const text = `CodexDirectSend-${new Date().toISOString().replace(/\D/g, '')}`;
  const logFd = fs.openSync(logPath, 'r');
  let metadata, native = '', capture = Buffer.alloc(0), outcome = null;
  try {
    const stat = fs.fstatSync(logFd);
    const tail = Buffer.alloc(Math.min(stat.size, 1024 * 1024));
    assert.equal(fs.readSync(logFd, tail, 0, tail.length, stat.size - tail.length), tail.length);
    const newline = tail.lastIndexOf(10); assert.ok(newline >= 0);
    const cursor = stat.size - tail.length + newline + 1;
    metadata = { requestId: text, shopUid, cid, target, text, clientId, login, active,
      mappingEvidence: { requestId: prior.requestId, clientId: priorVerified.native.clientId,
        messageId: priorVerified.native.messageId, process: identity(priorNative) },
      clientContextsBefore: beforeClients.clients.map(c => ({ clientId: c.clientId, ...context(c.state) })),
      startedAt: Date.now(), cursor, dev: stat.dev, ino: stat.ino, logPath, preflight: preflight.stdout,
      retryAllowed: false };
    durable(intentPath, metadata);
    const fd = fs.openSync(outputPath, 'wx'); let execution;
    try {
      execution = spawnSync(exe, ['--send-once', 'QN_DIRECT_SEND_ONCE', text],
        { cwd: root, windowsHide: true, timeout: 45000, stdio: ['ignore', fd, fd] });
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    native = fs.readFileSync(outputPath, 'utf8'); process.stdout.write(native);
    assert.deepEqual(identity(native), identity(preflight.stdout));
    const readCapture = () => {
      const current = fs.statSync(logPath), held = fs.fstatSync(logFd);
      assert.equal(current.dev, stat.dev); assert.equal(current.ino, stat.ino); assert.equal(held.ino, stat.ino);
      assert.ok(current.size >= stat.size && current.size - cursor <= 16 * 1024 * 1024);
      const bytes = Buffer.alloc(current.size - cursor);
      assert.equal(fs.readSync(logFd, bytes, 0, bytes.length, cursor), bytes.length); return bytes;
    };
    capture = readCapture();
    assert.equal(execution.status, 0, 'native outcome unknown; no retry');
    const window = windowEvidence(native);
    const deadline = Date.now() + 15000;
    do {
      await sleep(500); capture = readCapture();
      outcome = correlate(metadata, native, capture, Date.now(), 'direct-v2-controller.log');
    } while (outcome.status !== 'confirmed' && Date.now() < deadline);
    durable(path.join(folder, 'direct-v2-appended.log'), capture.toString('utf8'));
    durable(path.join(folder, 'direct-v2-delivery.json'), { ...outcome, window, observedAt: Date.now() });
    const afterActive = await readActive(clientId);
    const afterClients = await json(`${base}/clients`);
    const contextUnchanged = JSON.stringify(context(active.state)) === JSON.stringify(context(afterActive.state));
    outcome = { ...outcome, window, contextUnchanged, activeAfter: afterActive,
      clientContextsAfter: afterClients.clients.map(c => ({ clientId: c.clientId, ...context(c.state) })),
      observedAt: Date.now() };
    durable(path.join(folder, 'direct-v2-result.json'), outcome);
    assert.equal(outcome.status, 'confirmed'); assert.equal(contextUnchanged, true, 'current context changed');
    console.log(JSON.stringify({ status: outcome.status, text, shopUid, cid, messageId: outcome.native.messageId,
      clientId: outcome.native.clientId, contextUnchanged, window, retryAllowed: false }));
  } catch (error) {
    if (metadata) durable(path.join(folder, 'direct-v2-diagnostic.json'), {
      requestId: metadata.requestId, error: error.message, outcome, capturedBytes: capture.length, retryAllowed: false });
    if (metadata && capture.length && !fs.existsSync(path.join(folder, 'direct-v2-appended.log')))
      durable(path.join(folder, 'direct-v2-appended.log'), capture.toString('utf8'));
    throw error;
  } finally { fs.closeSync(logFd); }
}
if (require.main === module) {
  if (process.argv.length !== 3 || process.argv[2] !== 'QN_DIRECT_UNSELECTED_ONCE') process.exitCode = 2;
  else main().catch(error => { console.error(`${error.message}; retryAllowed=false`); process.exitCode = 1; });
}
module.exports = { identity, validateUnselected, windowEvidence };
