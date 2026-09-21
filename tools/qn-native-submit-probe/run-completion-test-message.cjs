'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseReceiptLine } = require('./receipt-correlator.cjs');
const root = path.resolve(__dirname, '../..');
const out = path.join(root, '.tmp/qn-native-submit-probe');
const base = 'http://127.0.0.1:18082/qn-bridge';
const shop = '2222303856223';
const target = '2214525969878';
const cid = '2214525969878.1-2216058631944.1#11001@cntaobao';
const log = 'D:/AliWorkbenchData/System/log/app.log';
const nativeNew = process.argv[2] === 'QN_NATIVE_NEW_TEST_ONCE';
const metadataPath = path.join(out, nativeNew ? 'completion-test-message-3.json' : 'completion-test-message.json');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function json(url, body) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000),
    ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
function context(result) {
  const state = result.state;
  if (state?.loginID?.targetId !== shop || state?.conversationID?.targetId !== target ||
      state?.conversationID?.ccode !== cid) throw new Error('Target context mismatch');
}
async function command(clientId, cmd, param = {}) {
  const queued = await json(`${base}/command`, { clientId, cmd, param });
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    await sleep(100);
    const { result } = await json(`${base}/results?commandId=${encodeURIComponent(queued.command.id)}`);
    if (!result) continue;
    if (!result.ok) throw new Error(`${cmd} failed: ${JSON.stringify(result.value)}`);
    context(result); return result;
  }
  throw new Error(`${cmd} timeout; do not retry automatically`);
}
async function main() {
  const resume = process.argv[2] === 'QN_NATIVE_SUBMIT_EXISTING_DRAFT';
  if ((!resume && !nativeNew && process.argv[2] !== 'QN_UI_TEST_ONCE') || process.argv.length !== 3) throw new Error('Explicit one-test confirmation required');
  if (!resume && fs.existsSync(metadataPath)) throw new Error('Test metadata already exists; refusing repeat');
  const prior = resume ? JSON.parse(fs.readFileSync(metadataPath, 'utf8')) : null;
  if (resume && (prior.shop !== shop || prior.target !== target || prior.cid !== cid || prior.receipt || prior.nativeSubmitAttempted))
    throw new Error('Existing draft retry identity/state refused');
  const { clients } = await json(`${base}/clients`);
  const matches = clients.filter(c => c.state?.loginID?.targetId === shop && c.abilityReady);
  if (matches.length !== 1) throw new Error('Expected one live target-shop bridge client');
  const clientId = matches[0].clientId;
  if (matches[0].state?.conversationID?.ccode !== cid) await command(clientId, 'openChat', { targetId: target, bizDomain: 'taobao' });
  const active = await command(clientId, 'getActiveUser');
  if (active.value.securityUID !== target || active.value.cid !== cid) throw new Error('Active recipient mismatch');
  const empty = await command(clientId, 'isInputboxEmpty');
  if (!resume && !empty.value.isEmpty) throw new Error('Unexpected draft state');
  const stat = resume ? { size: prior.offset, dev: prior.dev, ino: prior.ino } : fs.statSync(log);
  const text = resume ? prior.text : `CodexCompletionProbe-${new Date().toISOString().replace(/[^0-9]/g, '')}`;
  const metadata = prior || { text, shop, target, cid, clientId, log, offset: stat.size, dev: stat.dev, ino: stat.ino,
    startedAt: new Date().toISOString(), submitAttempted: false };
  if (resume) {
    if (prior.clientId !== clientId) throw new Error('Bridge client changed');
    const now = fs.statSync(log);
    if (now.dev !== stat.dev || now.ino !== stat.ino || now.size < stat.size || now.size - stat.size > 8 * 1024 * 1024)
      throw new Error('Log epoch changed');
    const fd = fs.openSync(log, 'r'); const buffer = Buffer.alloc(now.size - stat.size);
    try { fs.readSync(fd, buffer, 0, buffer.length, stat.size); } finally { fs.closeSync(fd); }
    for (const line of buffer.toString('utf8').split(/\r?\n/)) {
      const entries = parseReceiptLine(line, `3#${shop}`);
      if (entries.some(item => item?.cid?.ccode === cid && item?.originalData?.text === text))
        throw new Error('A prior send event exists; refusing duplicate submission');
    }
    if (empty.value.isEmpty) {
      await command(clientId, 'insertText2Inputbox', { uid: active.value.uid, securityUID: active.value.securityUID,
        bizDomain: active.value.bizDomain || 'taobao', type: 0, text });
      if ((await command(clientId, 'isInputboxEmpty')).value.isEmpty) throw new Error('Restored test draft is empty');
    }
  } else {
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), { flag: 'wx' });
  await command(clientId, 'insertText2Inputbox', { uid: active.value.uid, securityUID: active.value.securityUID,
    bizDomain: active.value.bizDomain || 'taobao', type: 0, text });
  const inserted = await command(clientId, 'isInputboxEmpty');
  if (inserted.value.isEmpty) throw new Error('Draft is empty after insertion');
  }
  metadata.submitAttempted = true;
  if (resume || nativeNew) metadata.nativeSubmitAttempted = true;
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
  const submit = (resume || nativeNew) ? spawnSync(path.join(__dirname, 'build/qn_native_submit_probe.exe'),
    ['--submit-onclick', '--confirm', 'QN_NATIVE_SUBMIT_ONCE'],
    { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 20000 }) : spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(root, 'tools/qn-win32-submit-enter.ps1'), '-OutFile', path.join(out, 'completion-test-enter.log'),
    '-ClientId', clientId, '-ExpectedShopTargetId', shop, '-ExpectedTargetId', target, '-ExpectedCid', cid],
  { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 20000 });
  process.stdout.write(submit.stdout || ''); process.stderr.write(submit.stderr || '');
  if (submit.error || submit.status !== 0) throw new Error('UI submit failed or unknown; no automatic retry');
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await sleep(250);
    const after = fs.statSync(log);
    if (after.dev !== stat.dev || after.ino !== stat.ino || after.size < stat.size || after.size - stat.size > 8 * 1024 * 1024)
      throw new Error('Log epoch changed or capture limit exceeded');
    const fd = fs.openSync(log, 'r');
    const data = Buffer.alloc(after.size - stat.size);
    let length;
    try { length = fs.readSync(fd, data, 0, data.length, stat.size); } finally { fs.closeSync(fd); }
    const capture = data.subarray(0, length).toString('utf8');
    fs.writeFileSync(path.join(out, nativeNew ? 'completion-test-appended-3.log' : 'completion-test-appended.log'), capture);
    const receipts = [];
    for (const line of capture.split(/\r?\n/)) {
      if (!line) continue;
      let entries;
      try { entries = parseReceiptLine(line, `3#${shop}`); } catch { continue; }
      for (const item of entries) if (item?.cid?.ccode === cid && item?.originalData?.text === text &&
          item.sendStatus === 0 && item.progress === 100) receipts.push(item);
    }
    const unique = new Map(receipts.map(item => [item.mcode?.clientId, item]));
    if (unique.size > 1) throw new Error('Ambiguous send receipts');
    if (unique.size === 1) {
      const receipt = [...unique.values()][0];
      const afterEmpty = await command(clientId, 'isInputboxEmpty');
      if (!afterEmpty.value.isEmpty) throw new Error('Input still nonempty after success receipt');
      metadata.receipt = receipt; metadata.finishedAt = new Date().toISOString();
      fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
      console.log(JSON.stringify({ result: 'ui_test_send_confirmed', text, cid, mcode: receipt.mcode, sendStatus: 0 }));
      return;
    }
  }
  throw new Error('Receipt timeout; do not retry');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
