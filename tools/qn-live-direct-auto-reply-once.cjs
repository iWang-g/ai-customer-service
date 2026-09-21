'use strict';

const fs = require('node:fs');
const { parseWake, readWithRetry } = require('./qn-live-read-observer.cjs');
const { sendText } = require('./qn-direct-send-service.cjs');

const DEFAULT_SHOP_UID = '2222303856223';
const DEFAULT_CID = '2214525969878.1-2216058631944.1#11001@cntaobao';
const DEFAULT_BUYER = 'tb4947894539';
const DEFAULT_BUYER_UID = '2214525969878';
const DEFAULT_REPLY = '您好，消息已收到，这边马上为您处理。';
const DEFAULT_LOG = process.env.QN_APP_LOG || 'D:/AliWorkbenchData/System/log/app.log';

function findCompleteLine(fd, offset) {
  const stat = fs.fstatSync(fd);
  if (stat.size <= offset) return { offset, lines: [] };
  const length = stat.size - offset;
  const buffer = Buffer.alloc(length);
  fs.readSync(fd, buffer, 0, length, offset);
  const text = buffer.toString('utf8');
  const lastNewline = text.lastIndexOf('\n');
  if (lastNewline < 0) return { offset, lines: [] };
  const complete = text.slice(0, lastNewline + 1);
  return {
    offset: offset + Buffer.byteLength(complete),
    lines: complete.split(/\r?\n/).filter(Boolean),
  };
}

function authorizedMessage(wake, message, expected) {
  return wake.loginTargetId === expected.shopUid &&
    wake.cid === expected.cid &&
    wake.senderUid === expected.buyerUid &&
    message.cid === expected.cid &&
    message.direction === 'incoming' &&
    message.fromId === expected.buyerUid;
}

async function runOnce({
  logPath = DEFAULT_LOG,
  shopUid = DEFAULT_SHOP_UID,
  cid = DEFAULT_CID,
  buyerUid = DEFAULT_BUYER_UID,
  reply = DEFAULT_REPLY,
  timeoutMs = 120000,
  sendTimeoutMs = 30000,
  pollMs = 100,
  log = console.log,
} = {}) {
  const expected = { shopUid, cid, buyerUid: buyerUid || DEFAULT_BUYER_UID };
  if (expected.shopUid !== DEFAULT_SHOP_UID || expected.cid !== DEFAULT_CID ||
      expected.buyerUid !== DEFAULT_BUYER_UID) {
    throw new Error('only the authorized test conversation is allowed');
  }
  const fd = fs.openSync(logPath, 'r');
  let offset = fs.fstatSync(fd).size;
  const seen = new Set();
  const startedAt = Date.now();
  log(JSON.stringify({ event: 'direct_auto_reply_started', logPath, ...expected, offset, timeoutMs }));
  try {
    while (Date.now() - startedAt < timeoutMs) {
      const result = findCompleteLine(fd, offset);
      offset = result.offset;
      for (const line of result.lines) {
        const wake = parseWake(line);
        if (!wake) continue;
        const key = `${wake.loginTargetId}|${wake.cid}|${wake.mid || line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        log(JSON.stringify({
          event: 'notification',
          shopUid: wake.loginTargetId,
          cid: wake.cid,
          messageId: wake.mid,
          senderUid: wake.senderUid,
        }));
        if (wake.loginTargetId !== expected.shopUid || wake.cid !== expected.cid ||
            (expected.buyerUid && wake.senderUid !== expected.buyerUid)) {
          log(JSON.stringify({ event: 'notification_skipped', reason: 'allowlist_mismatch' }));
          continue;
        }
        if (!wake.mid) {
          log(JSON.stringify({ event: 'notification_skipped', reason: 'message_id_missing' }));
          continue;
        }
        try {
          const read = await readWithRetry(wake.loginTargetId, wake.cid, wake.mid);
          const message = read.match;
          log(JSON.stringify({
            event: 'message_read',
            attempt: read.attempt,
            shopUid: wake.loginTargetId,
            cid: wake.cid,
            messageId: message.messageId,
            direction: message.direction,
            fromId: message.fromId,
            fromNick: message.fromNick,
            text: message.text,
            currentCidBefore: read.value.currentCidBefore,
            currentCidAfter: read.value.currentCidAfter,
            selectedConversationUntouched:
              read.value.currentCidBefore === read.value.currentCidAfter,
          }));
          if (!authorizedMessage(wake, message, expected)) {
            log(JSON.stringify({ event: 'message_skipped', reason: 'message_identity_mismatch' }));
            continue;
          }
          const sent = sendText(expected.shopUid, expected.cid, reply, { timeoutMs: sendTimeoutMs });
          log(JSON.stringify({
            event: 'reply_sent',
            shopUid: expected.shopUid,
            cid: expected.cid,
            triggerMessageId: message.messageId,
            reply,
            requestId: sent.requestId,
            messageId: sent.native.messageId,
            clientId: sent.native.clientId,
            status: sent.result.status,
          }));
          return { wake, message, sent, selectedConversationUntouched:
            read.value.currentCidBefore === read.value.currentCidAfter };
        } catch (error) {
          log(JSON.stringify({
            event: 'processing_failed',
            shopUid: wake.loginTargetId,
            cid: wake.cid,
            messageId: wake.mid,
            error: error.message,
            retryAllowed: false,
          }));
          return null;
        }
      }
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
    log(JSON.stringify({ event: 'direct_auto_reply_timeout', seen: seen.size }));
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function parseArgs(argv) {
  const args = { logPath: DEFAULT_LOG, timeoutMs: 120000, reply: DEFAULT_REPLY };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--app-log') args.logPath = argv[++i];
    else if (arg === '--timeout-ms') args.timeoutMs = Number(argv[++i]);
    else if (arg === '--reply') args.reply = argv[++i];
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isInteger(args.timeoutMs) || args.timeoutMs < 1000 || args.timeoutMs > 600000)
    throw new Error('--timeout-ms must be between 1000 and 600000');
  return args;
}

if (require.main === module) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log('Usage: node tools/qn-live-direct-auto-reply-once.cjs [--timeout-ms 120000] [--reply text]');
    } else {
      runOnce(args).then(result => {
        if (!result) process.exitCode = 1;
      }).catch(error => {
        console.error(error.stack || error.message);
        process.exitCode = 1;
      });
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

module.exports = { findCompleteLine, authorizedMessage, parseArgs, runOnce };
