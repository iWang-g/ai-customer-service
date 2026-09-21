'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { TARGET } = require('./inspect.js');
const { run } = require('./client.cjs');
const { parseWake } = require('../qn-live-read-observer.cjs');
const { parseRecord } = require('./parse.cjs');
const LOG = 'D:/AliWorkbenchData/System/log/app.log';

function incoming(line) {
  const wake = parseWake(line);
  if (!wake || wake.cid !== TARGET.cid || wake.loginTargetId !== TARGET.shopUid ||
      wake.senderUid !== '2214525969878' || !wake.mid) return null;
  return { messageId: wake.mid, senderUid: wake.senderUid };
}
function mediaUpdate(line) {
  if (!line.includes('strEvent=im.media.onJSViewUpdate,jsonStr=') || !line.includes('#3#' + TARGET.shopUid + ' ]')) return null;
  const match = /jsonStr=(\{.*\}) \]\[WebEventCenter/.exec(line);
  if (!match || match[1].length > 64000) return null;
  try {
    const value = JSON.parse(match[1]);
    if (value.ccode !== TARGET.cid || typeof value.mcode?.messageId !== 'string' ||
        !Number.isInteger(value.index) || value.index < 0 || !value.update) return null;
    return value;
  } catch { return null; }
}
function livePage(status) {
  const live = status.pages.filter(p => p.ready && p.probeVersion === 2 && Date.now() - p.lastSeen < 10000);
  if (live.length !== 1) throw new Error('expected one ready v2 media page; reload Qianniu first');
  const page = live[0];
  if (page.state.shopUid !== TARGET.shopUid || page.state.mainUid !== TARGET.mainUid || !page.state.cid || page.state.cid === TARGET.cid)
    throw new Error('keep a different conversation selected before observing');
  return page;
}

async function observe(durationMs = 120000) {
  if (!Number.isInteger(durationMs) || durationMs < 5000 || durationMs > 300000) throw new Error('invalid observation duration');
  const baseline = livePage(await run('status'));
  const dir = path.resolve(__dirname, '../../.tmp/qn-media-probe/live-' + new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const output = path.join(dir, 'events.ndjson');
  const emit = (event, details = {}) => {
    const value = { at: new Date().toISOString(), event, ...details };
    fs.appendFileSync(output, JSON.stringify(value) + '\n');
    if (event !== 'media_update') console.log(JSON.stringify(value));
  };
  const fd = fs.openSync(LOG, 'r'), initial = fs.fstatSync(fd);
  let offset = initial.size, active = null, fatal = null, stopped = false, lastStatus = 0;
  const queue = new Map(), updateSeen = new Set(), delays = [0, 3000, 10000];
  const onStop = () => { stopped = true; };
  process.once('SIGINT', onStop);
  const start = Date.now(), deadline = start + durationMs;
  emit('observer_started', { durationMs, output, baseline: baseline.state, pageId: baseline.pageId });
  async function readDue(due) {
    const requestedAt = Date.now(), ids = due.map(item => item.messageId);
    const job = await run('read', { messageIds: ids });
    const record = JSON.parse(fs.readFileSync(job.output, 'utf8'));
    if (!record.ok) throw new Error(record.error || 'history inspection failed');
    const parsed = parseRecord(record);
    if (JSON.stringify(parsed.before) !== JSON.stringify(baseline.state) || JSON.stringify(parsed.after) !== JSON.stringify(baseline.state))
      throw new Error('selected context changed from observation baseline');
    const file = path.join(dir, job.id + '.parsed.json');
    fs.writeFileSync(file, JSON.stringify(parsed, null, 2), { flag: 'wx' });
    for (const item of due) {
      const message = parsed.messages.find(m => m.messageId === item.messageId);
      emit('history_sample', { messageId: item.messageId, attempt: item.attempt + 1,
        requestedAfterArrivalMs: requestedAt - item.arrivedAt, completedAfterArrivalMs: Date.now() - item.arrivedAt,
        present: !!message, kinds: message?.parts.map(p => p.kind),
        nativeFields: record.value.samples.find(s => s.message.messageId === item.messageId)?.nativeFields,
        parts: message?.parts.map(p => ({ index: p.index, kind: p.kind, hasUrl: !!p.url,
          hasCachePath: !!p.localPath, hasTitle: !!p.title, productId: p.productId, metadataState: p.metadataState })),
        rawFile: job.output, parsedFile: file });
      item.attempt++;
    }
  }
  try {
    while (!stopped && !fatal && Date.now() < deadline) {
      const current = fs.statSync(LOG), stat = fs.fstatSync(fd);
      if (current.ino !== initial.ino || stat.size < offset) throw new Error('log rotated; restart observation');
      if (stat.size > offset) {
        const buffer = Buffer.alloc(Math.min(stat.size - offset, 1024 * 1024));
        const bytes = fs.readSync(fd, buffer, 0, buffer.length, offset);
        const end = buffer.subarray(0, bytes).lastIndexOf(10);
        if (end < 0 && bytes === buffer.length && buffer.length === 1024 * 1024) throw new Error('log line exceeds limit');
        if (end >= 0) {
          offset += end + 1;
          for (const line of buffer.subarray(0, end + 1).toString('utf8').split(/\r?\n/)) {
            const wake = incoming(line);
            if (wake && !queue.has(wake.messageId)) {
              if (queue.size >= 6) { emit('message_limit_reached'); stopped = true; break; }
              queue.set(wake.messageId, { ...wake, arrivedAt: Date.now(), attempt: 0 }); emit('new_message', wake);
            }
            const update = mediaUpdate(line);
            if (update) {
              const hash = crypto.createHash('sha256').update(JSON.stringify(update)).digest('hex');
              if (!updateSeen.has(hash)) { updateSeen.add(hash); emit('media_update', { update }); }
            }
          }
        }
      }
      if (!active) {
        if (Date.now() - lastStatus > 2000) {
          const page = livePage(await run('status')); lastStatus = Date.now();
          if (page.pageId !== baseline.pageId || JSON.stringify(page.state) !== JSON.stringify(baseline.state))
            throw new Error('page or selected context changed during observation');
        }
        const due = [...queue.values()].filter(item => item.attempt < delays.length && Date.now() >= item.arrivedAt + delays[item.attempt]);
        if (due.length) active = readDue(due).catch(error => { fatal = error; }).finally(() => { active = null; });
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (active) await active;
    if (fatal) throw fatal;
    emit('observer_finished', { messages: [...queue.values()].map(item => ({ messageId: item.messageId, reads: item.attempt })),
      mediaUpdates: updateSeen.size, stoppedBySignal: stopped });
  } catch (error) {
    if (active) await active;
    emit('observer_failed', { error: error.message }); throw error;
  } finally { fs.closeSync(fd); process.removeListener('SIGINT', onStop); }
  return output;
}
if (require.main === module) observe(process.argv[2] == null ? undefined : Number(process.argv[2]))
  .catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { incoming, mediaUpdate, livePage, observe };
