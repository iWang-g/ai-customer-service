'use strict';

const path = require('node:path');

process.env.QN_DIRECT_SEND_MODE = process.env.QN_DIRECT_SEND_MODE || 'direct';

const toolsRoot = process.env.QIANNIU_TOOLS_ROOT ||
  path.resolve(__dirname, '..', '..', '..', '..', 'tools');
const { sendText, sendTextRpc } = require(path.join(toolsRoot, 'qn-direct-send-service.cjs'));
const { NativeRpcClient } = require(path.join(toolsRoot, 'qn-native-submit-probe', 'native-rpc-client.cjs'));

const nativeRpc = process.env.QN_NATIVE_STDIO_RPC === '0' ? null : new NativeRpcClient();

const queue = [];
let processing = false;

function respond(payload) {
  if (typeof process.send === 'function') process.send(payload);
}

function compactResult(sent) {
  return {
    shopUid: sent.shopUid,
    cid: sent.cid,
    text: sent.text,
    requestId: sent.requestId,
    native: {
      messageId: sent.native?.messageId || null,
      clientId: sent.native?.clientId || null,
    },
    result: {
      status: sent.result?.status || null,
      confirmationSource: sent.result?.confirmationSource || 'app_log',
      retryAllowed: sent.result?.retryAllowed === true,
      issues: Array.isArray(sent.result?.issues) ? sent.result.issues : [],
    },
    timings: sent.timings || null,
  };
}

async function drain() {
  if (processing) return;
  processing = true;
  while (queue.length > 0) {
    const item = queue.shift();
    const startedAt = Date.now();
    try {
      const sent = nativeRpc
        ? await sendTextRpc(item.shopUid, item.cid, item.text, { timeoutMs: item.timeoutMs, nativeClient: nativeRpc })
        : sendText(item.shopUid, item.cid, item.text, { timeoutMs: item.timeoutMs });
      respond({
        type: 'result',
        requestId: item.requestId,
        ok: true,
        result: compactResult(sent),
        durationMs: Date.now() - startedAt,
        queueWaitMs: startedAt - item.queuedAt,
      });
    } catch (error) {
      respond({
        type: 'result',
        requestId: item.requestId,
        ok: false,
        error: error?.message || String(error),
        durationMs: Date.now() - startedAt,
        queueWaitMs: startedAt - item.queuedAt,
      });
    }
  }
  processing = false;
}

process.on('message', (message) => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'shutdown') {
    nativeRpc?.stop();
    process.exit(0);
    return;
  }
  if (message.type !== 'send') return;
  queue.push({
    requestId: String(message.requestId || ''),
    shopUid: String(message.shopUid || ''),
    cid: String(message.cid || ''),
    text: String(message.text || ''),
    timeoutMs: Number.isFinite(Number(message.timeoutMs)) ? Number(message.timeoutMs) : 30000,
    queuedAt: Date.now(),
  });
  setImmediate(() => void drain());
});

respond({ type: 'ready', pid: process.pid, nativeMode: nativeRpc ? 'stdio_rpc' : 'one_shot' });
