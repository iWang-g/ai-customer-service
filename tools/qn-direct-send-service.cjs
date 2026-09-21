'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { ReceiptCorrelator } = require('./qn-native-submit-probe/receipt-correlator.cjs');

const root = path.resolve(__dirname, '..');
const probe = path.join(__dirname, 'qn-native-submit-probe', 'build', 'qn_direct_general_probe_v3.exe');
const MAX_TEXT_BYTES = 4095;
const interactiveController = path.join(__dirname, 'qn-native-submit-probe', 'run-general-send-controller.ps1');
const logPath = process.env.QN_APP_LOG || 'D:/AliWorkbenchData/System/log/app.log';
const bridgeBase = process.env.QN_BRIDGE_BASE || 'http://127.0.0.1:18082/qn-bridge';
const journalDir = path.join(root, '.tmp', 'qn-native-submit-probe', 'direct-general');
const runDir = path.join(root, '.tmp', 'qn-native-submit-probe');
const interactiveRequestPath = path.join(runDir, 'general-send-request.json');
const lockPath = path.join(journalDir, 'send.lock');
const cidPattern = /^(\d+)\.1-(\d+)\.1#11001@cntaobao$/;

function validateRequest(shopUid, cid, text) {
  if (typeof shopUid !== 'string' || !/^\d+$/.test(shopUid)) throw new TypeError('invalid shopUid');
  if (typeof cid !== 'string' || !cidPattern.test(cid)) throw new TypeError('invalid single Taobao cid');
  if (typeof text !== 'string' || !text.trim() || !text.isWellFormed() || /[\0\r]/.test(text))
    throw new TypeError('千牛发送正文必须是有效文本，不能包含回车或空字符');
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_TEXT_BYTES) throw new TypeError(`千牛发送正文为 ${bytes} 个 UTF-8 字节，超过当前上限 ${MAX_TEXT_BYTES} 字节`);
  return { shopUid, cid, text };
}

function writeOnce(file, value) {
  const fd = fs.openSync(file, 'wx');
  try { fs.writeFileSync(fd, typeof value === 'string' ? value : JSON.stringify(value, null, 2)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

function acquireLock() {
  fs.mkdirSync(journalDir, { recursive: true });
  return fs.openSync(lockPath, 'wx');
}

function runNativeSend(requestId, request, timeoutMs) {
  if (process.env.QN_DIRECT_SEND_MODE === 'direct') {
    return execFileSync(probe, ['--send-once', 'QN_DIRECT_SEND_ONCE', request.shopUid, request.cid, request.text], {
      cwd: root, windowsHide: true, encoding: 'utf8', timeout: timeoutMs,
    });
  }
  if (!fs.existsSync(interactiveController)) throw new Error(`missing interactive controller: ${interactiveController}`);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(interactiveRequestPath, JSON.stringify({
    requestId,
    shopUid: request.shopUid,
    cid: request.cid,
    text: request.text,
  }, null, 2));
  return execFileSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', interactiveController,
  ], { cwd: root, windowsHide: true, encoding: 'utf8', timeout: timeoutMs + 30000 });
}

function parseAdmission(output) {
  const line = String(output).split(/\r?\n/).find(item => item.startsWith('ADMISSION '));
  if (!line) throw new Error('native admission missing');
  const fields = Object.fromEntries([...line.matchAll(/(\w+)=([^ ]*)/g)].map(match => [match[1], match[2]]));
  if (!/^\d+$/.test(fields.pid) || !/^\d+$/.test(fields.tid) || !/^\d+$/.test(fields.created))
    throw new Error('native admission identity invalid');
  return fields;
}

function nativeFailureDetail(error) {
  const lines = String(error.stdout || '').split(/\r?\n/)
    .filter(line => /^(REFUSE |SELECT_DIAG |OUTCOME |RESULT |CLEANUP |RECOVERY )/.test(line))
    .map(line => line.slice(0, 1000)).slice(-4);
  return `exit=${error.status ?? 'unknown'} code=${error.code || 'none'} signal=${error.signal || 'none'}` +
    (lines.length ? `; ${lines.join('; ')}` : '; native diagnostics unavailable');
}

function parseResult(output) {
  const line = String(output).split(/\r?\n/).find(item => item.startsWith('RESULT '));
  if (!line) throw new Error('native receipt missing');
  const fields = Object.fromEntries([...line.matchAll(/(\w+)=([^ ]*)/g)].map(match => [match[1], match[2]]));
  for (const key of ['error', 'invalid', 'conflicts', 'snapshot_status', 'result'])
    if (fields[key] !== '0') throw new Error(`native receipt ${key}=${fields[key]}`);
  for (const key of ['resident', 'admitted', 'arguments', 'caller_released', 'entered', 'returned', 'callbacks',
    'destroyed', 'callback_created', 'cleanup_ack', 'result_valid'])
    if (fields[key] !== '1') throw new Error(`native receipt ${key}=${fields[key]}`);
  if (!fields.messageId || !/^\d+$/.test(fields.clientId)) throw new Error('native message identity missing');
  return fields;
}

function parseNativeTiming(output) {
  const line = String(output).split(/\r?\n/).find(item => item.startsWith('NATIVE_TIMING '));
  if (!line) return null;
  const fields = Object.fromEntries([...line.matchAll(/(\w+)=([^ ]*)/g)].map(match => [match[1], match[2]]));
  for (const key of ['select_ms', 'admit_ms', 'execute_ms', 'total_ms', 'cache'])
    if (!/^\d+$/.test(fields[key] || '')) return null;
  return {
    selectMs: Number(fields.select_ms),
    admitMs: Number(fields.admit_ms),
    executeMs: Number(fields.execute_ms),
    totalMs: Number(fields.total_ms),
    cacheHit: fields.cache === '1',
  };
}

function readTail(fd, stat, offset) {
  if (stat.size <= offset) return { text: '', end: offset };
  const bytes = Buffer.alloc(stat.size - offset);
  const got = fs.readSync(fd, bytes, 0, bytes.length, offset);
  return { text: bytes.subarray(0, got).toString('utf8'), end: offset + got };
}

function correlate(metadata, native, receiptText, now) {
  const result = new ReceiptCorrelator({
    requestId: metadata.requestId,
    account: `3#${metadata.shopUid}`,
    cid: metadata.cid,
    text: metadata.text,
    streamIdentity: `${metadata.dev}:${metadata.ino}`,
    cursor: metadata.cursor,
    startedAt: metadata.startedAt,
    deadline: metadata.startedAt + 60000,
  });
  result.bindClientId({ clientId: native.clientId, source: 'native_callback', evidenceId: metadata.requestId });
  let start = 0;
  let offset = metadata.cursor;
  let sdkEvidence = null;
  for (let end = receiptText.indexOf('\n', start); end >= 0; end = receiptText.indexOf('\n', start)) {
    const line = receiptText.slice(start, end).replace(/\r$/, '');
    const nextOffset = offset + Buffer.byteLength(receiptText.slice(start, end + 1));
    result.observe({ line, start: offset,
      end: nextOffset, observedAt: now, streamIdentity: `${metadata.dev}:${metadata.ino}` });
    // Success is the event name; its variable delta field is not a status code.
    const sdk = /^\[\d{2}-\d{2} \d{2}:\d{2}:\d{2} \d+ (\d+) \d+ INFO\] MessageSDK \[\]\[INFO:aim_msg_service_impl\.cpp\(\d+\)\] \[ark\]\[im\]update send result success, cid=([^,\s]+),localid=(\d+),mid=([^,\s]+),delta=\d+$/.exec(line);
    if (sdk && sdk[1] === metadata.pid && sdk[2] === metadata.cid &&
        sdk[3] === native.clientId && sdk[4] === native.messageId) {
      sdkEvidence = { source: 'sdk_send_result_success', pid: sdk[1], cid: sdk[2], clientId: sdk[3], messageId: sdk[4], offset };
    }
    start = end + 1;
    offset = nextOffset;
  }
  const snapshot = result.snapshot();
  if (snapshot.status !== 'confirmed' && !snapshot.timedOut && sdkEvidence &&
      native.result === '0' && native.arguments === '1' && native.result_valid === '1' &&
      snapshot.issues.every(issue => issue === 'malformed_target_receipt')) {
    return { ...snapshot, status: 'confirmed', confirmationSource: 'native_callback_and_sdk_log',
      logIssues: snapshot.issues, issues: [], sdkEvidence };
  }
  return snapshot;
}

async function readBridgeReceipts(after = 0, instance = '', fetchFn = globalThis.fetch) {
  if (typeof fetchFn !== 'function') throw new Error('bridge fetch unavailable');
  const query = new URLSearchParams({ after: String(after) });
  if (instance) query.set('instance', instance);
  const response = await fetchFn(`${bridgeBase}/send-receipts?${query}`, {
    signal: AbortSignal.timeout(500),
  });
  if (!response.ok) throw new Error(`bridge receipt HTTP ${response.status}`);
  const payload = await response.json();
  if (!payload?.ok || typeof payload.serverInstanceId !== 'string' ||
      !Number.isSafeInteger(payload.latestSeq) || !Array.isArray(payload.receipts)) {
    throw new Error('invalid bridge receipt response');
  }
  return payload;
}

function matchBridgeReceipt(metadata, native, state, payload) {
  if (!state || !payload || payload.serverInstanceId !== state.instance) {
    return { status: 'unavailable', nextAfter: state?.after ?? 0, result: null };
  }
  let nextAfter = state.after;
  for (const receipt of payload.receipts) {
    if (Number.isSafeInteger(receipt?.seq)) nextAfter = Math.max(nextAfter, receipt.seq);
    if (receipt?.clientId !== native.clientId) continue;
    const issues = [];
    if (receipt.shopUid !== metadata.shopUid) issues.push('client_account_conflict');
    if (receipt.cid !== metadata.cid) issues.push('client_cid_conflict');
    if (receipt.text !== metadata.text) issues.push('client_text_conflict');
    if (receipt.messageId && receipt.messageId !== native.messageId) issues.push('client_message_id_conflict');
    if (issues.length) {
      return { status: 'unknown', nextAfter, result: {
        requestId: metadata.requestId, status: 'unknown', timedOut: false, lateRecords: 0,
        retryAllowed: false, confirmationSource: 'bridge_send_receipt',
        binding: { clientId: native.clientId, source: 'native_callback', evidenceId: metadata.requestId },
        issues, candidates: [],
      } };
    }
    if (receipt.sendStatus === 0 && receipt.progress === 100 && receipt.messageId === native.messageId) {
      return { status: 'confirmed', nextAfter, result: {
        requestId: metadata.requestId, status: 'confirmed', timedOut: false, lateRecords: 0,
        retryAllowed: false, confirmationSource: 'bridge_send_receipt',
        binding: { clientId: native.clientId, source: 'native_callback', evidenceId: metadata.requestId },
        issues: [], candidates: [{ clientId: native.clientId, messageId: native.messageId,
          records: 1, duplicates: 0, transitions: [{ sendStatus: 0, progress: 100,
            messageId: native.messageId }], success: true }],
      } };
    }
    if (receipt.progress === 100 && receipt.sendStatus !== 0) {
      return { status: 'unknown', nextAfter, result: {
        requestId: metadata.requestId, status: 'unknown', timedOut: false, lateRecords: 0,
        retryAllowed: false, confirmationSource: 'bridge_send_receipt',
        binding: { clientId: native.clientId, source: 'native_callback', evidenceId: metadata.requestId },
        issues: [`send_status_${receipt.sendStatus}`], candidates: [],
      } };
    }
  }
  return { status: 'pending', nextAfter, result: null };
}

function sendText(shopUid, cid, text, { timeoutMs = 30000 } = {}) {
  const request = validateRequest(shopUid, cid, text);
  if (!fs.existsSync(probe)) throw new Error(`missing native service: ${probe}`);
  const lock = acquireLock();
  const requestId = `CodexDirect-${Date.now()}-${process.pid}`;
  let metadata;
  try {
    const logFd = fs.openSync(logPath, 'r');
    try {
      const stat = fs.fstatSync(logFd);
      metadata = { requestId, ...request, cursor: stat.size, dev: stat.dev, ino: stat.ino,
        startedAt: Date.now(), retryAllowed: false };
      writeOnce(path.join(journalDir, `${requestId}.intent.json`), metadata);
      let output;
      const nativeStartedAt = Date.now();
      try {
        output = runNativeSend(requestId, request, timeoutMs);
      } catch (error) {
        throw new Error(`native send failed; retryAllowed=false: ${nativeFailureDetail(error)}`);
      }
      const nativeCompletedAt = Date.now();
      const admission = parseAdmission(output);
      if (admission.account !== `3#${shopUid}`) throw new Error('native account binding mismatch');
      Object.assign(metadata, { pid: admission.pid, tid: admission.tid, created: admission.created });
      const native = parseResult(output);
      const end = Date.now() + 15000;
      let capture = { text: '', end: stat.size }, result = null;
      while (Date.now() < end) {
        const current = fs.fstatSync(logFd);
        if (current.dev !== stat.dev || current.ino !== stat.ino || current.size - stat.size > 16 * 1024 * 1024)
          throw new Error('app log changed during receipt observation');
        capture = readTail(logFd, current, stat.size);
        result = correlate(metadata, native, capture.text, Date.now());
        if (result.status === 'confirmed') break;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      }
      const observedAt = Date.now();
      const timings = {
        nativeMs: nativeCompletedAt - nativeStartedAt,
        receiptMs: observedAt - nativeCompletedAt,
        totalMs: observedAt - metadata.startedAt,
      };
      writeOnce(path.join(journalDir, `${requestId}.result.json`), { metadata, native, result, timings, observedAt });
      if (result.status !== 'confirmed') throw new Error(`business receipt not confirmed: ${result.status}`);
      return { ...request, requestId, native, result, timings };
    } finally { fs.closeSync(logFd); }
  } catch (error) {
    if (metadata) {
      try { writeOnce(path.join(journalDir, `${requestId}.failure.json`), { metadata, error: error.message, retryAllowed: false }); }
      catch {}
    }
    throw error;
  } finally {
    fs.closeSync(lock);
    try { fs.unlinkSync(lockPath); } catch {}
  }
}

async function sendTextRpc(shopUid, cid, text, { timeoutMs = 30000, nativeClient } = {}) {
  const request = validateRequest(shopUid, cid, text);
  if (!nativeClient || typeof nativeClient.send !== 'function') throw new TypeError('native RPC client is required');
  const lock = acquireLock();
  const requestId = `CodexDirect-${Date.now()}-${process.pid}`;
  let metadata;
  try {
    const logFd = fs.openSync(logPath, 'r');
    try {
      const stat = fs.fstatSync(logFd);
      let bridgeState = null;
      try {
        const baseline = await readBridgeReceipts();
        bridgeState = { instance: baseline.serverInstanceId, after: baseline.latestSeq };
      } catch {}
      metadata = { requestId, ...request, cursor: stat.size, dev: stat.dev, ino: stat.ino,
        startedAt: Date.now(), retryAllowed: false, transport: 'native_stdio_rpc',
        bridgeReceiptInstance: bridgeState?.instance || null, bridgeReceiptCursor: bridgeState?.after ?? null };
      writeOnce(path.join(journalDir, `${requestId}.intent.json`), metadata);
      let execution;
      const nativeStartedAt = Date.now();
      try {
        execution = await nativeClient.send({ requestId, ...request }, { timeoutMs });
      } catch (error) {
        const wrapped = new Error(`native RPC send failed; retryAllowed=false: ${nativeFailureDetail(error)}`);
        wrapped.submitted = error?.submitted === true;
        wrapped.retryAllowed = false;
        throw wrapped;
      }
      const nativeCompletedAt = Date.now();
      const output = execution.output;
      const admission = parseAdmission(output);
      if (admission.account !== `3#${shopUid}`) throw new Error('native account binding mismatch');
      Object.assign(metadata, { pid: admission.pid, tid: admission.tid, created: admission.created });
      const native = parseResult(output);
      const end = Date.now() + 15000;
      let capture = { text: '', end: stat.size }, result = null;
      while (Date.now() < end) {
        if (bridgeState) {
          try {
            const payload = await readBridgeReceipts(bridgeState.after, bridgeState.instance);
            const matched = matchBridgeReceipt(metadata, native, bridgeState, payload);
            bridgeState.after = matched.nextAfter;
            if (matched.status === 'unavailable') bridgeState = null;
            else if (matched.status === 'confirmed') { result = matched.result; break; }
            else if (matched.status === 'unknown') {
              result = matched.result;
              throw new Error(`business receipt conflict: ${result.issues.join(',')}`);
            }
          } catch (error) {
            if (String(error?.message || '').startsWith('business receipt conflict:')) throw error;
            bridgeState = null;
          }
        }
        const current = fs.fstatSync(logFd);
        if (current.dev !== stat.dev || current.ino !== stat.ino || current.size - stat.size > 16 * 1024 * 1024)
          throw new Error('app log changed during receipt observation');
        capture = readTail(logFd, current, stat.size);
        result = correlate(metadata, native, capture.text, Date.now());
        if (result.status === 'confirmed') break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const observedAt = Date.now();
      const timings = {
        nativeMs: nativeCompletedAt - nativeStartedAt,
        nativeRpcMs: execution.durationMs ?? null,
        nativePhases: parseNativeTiming(output),
        receiptMs: observedAt - nativeCompletedAt,
        totalMs: observedAt - metadata.startedAt,
      };
      writeOnce(path.join(journalDir, `${requestId}.result.json`), { metadata, native, result, timings, observedAt });
      if (result.status !== 'confirmed') throw new Error(`business receipt not confirmed: ${result.status}`);
      return { ...request, requestId, native, result, timings };
    } finally { fs.closeSync(logFd); }
  } catch (error) {
    if (metadata) {
      try { writeOnce(path.join(journalDir, `${requestId}.failure.json`),
        { metadata, error: error.message, retryAllowed: false }); }
      catch {}
    }
    throw error;
  } finally {
    fs.closeSync(lock);
    try { fs.unlinkSync(lockPath); } catch {}
  }
}

module.exports = { MAX_TEXT_BYTES, validateRequest, parseAdmission, parseResult, parseNativeTiming,
  nativeFailureDetail, correlate, readBridgeReceipts, matchBridgeReceipt, sendText, sendTextRpc };
