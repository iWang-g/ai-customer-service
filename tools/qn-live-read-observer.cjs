'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readMessages } = require('./qn-read-messages.cjs');

const logPath = process.env.QN_APP_LOG || 'D:/AliWorkbenchData/System/log/app.log';
const limitMs = Number(process.env.QN_OBSERVER_MS || 120000);
const targetNick = process.env.QN_TARGET_NICK || 'tb4947894539';
const startedAt = Date.now();
const seen = new Set();

function parseWake(line) {
  if (!line.includes('OnMessageArrive')) return null;
  const cid = /dmsg\.cid=([^,\]\s]+)/.exec(line)?.[1] ||
    /msg\.msg\.conversationCode=([^,\]\s]+)/.exec(line)?.[1] || '';
  if (!cid) return null;
  const mid = /dmsg\.mid=([^,\]\s]+)/.exec(line)?.[1] ||
    /msg\.msg\.code\.messageId=([^,\]\s]+)/.exec(line)?.[1] || '';
  const loginTargetId = /MessageSDK \[\]\[3#(\d+)\]/.exec(line)?.[1] ||
    /\[CHAT [^\]#]+#3#(\d+)\]/.exec(line)?.[1] || '';
  const senderUid = /dmsg\.sender\.uid=([^,\]\s]+)/.exec(line)?.[1] ||
    /msg\.sendProfile->target\.targetId=([^,\]\s]+)/.exec(line)?.[1] || '';
  return { cid, mid, loginTargetId, senderUid, line };
}

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
  return { offset: offset + Buffer.byteLength(complete), lines: complete.split(/\r?\n/).filter(Boolean) };
}

async function readWithRetry(shopUid, cid, mid) {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const value = await readMessages(shopUid, cid, { count: 20, timeoutMs: 15000 });
      const match = value.messages.find(message => !mid || message.messageId === mid);
      if (match) return { attempt, value, match };
      lastError = new Error(`message ${mid || '<missing id>'} is not in local history yet`);
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  throw lastError || new Error('read retry exhausted');
}

async function main() {
  const fd = fs.openSync(logPath, 'r');
  let offset = fs.fstatSync(fd).size;
  console.log(JSON.stringify({ event: 'observer_started', logPath, targetNick, offset, limitMs }));
  try {
    while (Date.now() - startedAt < limitMs) {
      const result = findCompleteLine(fd, offset);
      offset = result.offset;
      for (const line of result.lines) {
        const wake = parseWake(line);
        if (!wake) continue;
        const key = `${wake.loginTargetId}|${wake.cid}|${wake.mid || line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        console.log(JSON.stringify({ event: 'notification', shopUid: wake.loginTargetId, cid: wake.cid,
          messageId: wake.mid, senderUid: wake.senderUid, selectedConversationUntouched: true }));
        if (!wake.loginTargetId) {
          console.log(JSON.stringify({ event: 'read_skipped', reason: 'shop_uid_not_in_notification', cid: wake.cid }));
          continue;
        }
        try {
          const read = await readWithRetry(wake.loginTargetId, wake.cid, wake.mid);
          const message = read.match;
          console.log(JSON.stringify({ event: 'message_read', attempt: read.attempt, shopUid: wake.loginTargetId,
            cid: wake.cid, messageId: message.messageId, direction: message.direction, text: message.text,
            fromId: message.fromId, fromNick: message.fromNick, currentCidBefore: read.value.currentCidBefore,
            currentCidAfter: read.value.currentCidAfter, selectedConversationUntouched:
              read.value.currentCidBefore === read.value.currentCidAfter }));
          if (targetNick && message.fromNick && message.fromNick !== targetNick)
            console.log(JSON.stringify({ event: 'target_mismatch', expected: targetNick, actual: message.fromNick }));
        } catch (error) {
          console.log(JSON.stringify({ event: 'read_failed', shopUid: wake.loginTargetId, cid: wake.cid,
            messageId: wake.mid, error: error.message }));
        }
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    console.log(JSON.stringify({ event: 'observer_finished', seen: seen.size }));
  } finally { fs.closeSync(fd); }
}

if (require.main === module) main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
module.exports = { parseWake, readWithRetry };
