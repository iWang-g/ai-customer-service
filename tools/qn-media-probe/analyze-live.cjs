'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { parseRecord, verifyCache } = require('./parse.cjs');

function analyze(file) {
  const events = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const start = events.find(e => e.event === 'observer_started');
  const finish = events.find(e => e.event === 'observer_finished');
  if (!start || !finish || events.some(e => e.event === 'observer_failed')) throw new Error('observation did not finish successfully');
  const arrivals = events.filter(e => e.event === 'new_message');
  const media = events.filter(e => e.event === 'media_update');
  const messages = arrivals.map(arrival => {
    const reads = events.filter(e => e.event === 'history_sample' && e.messageId === arrival.messageId).map(event => {
      const record = JSON.parse(fs.readFileSync(event.rawFile, 'utf8'));
      const parsed = parseRecord(record);
      assert.deepEqual(parsed.before, start.baseline); assert.deepEqual(parsed.after, start.baseline);
      assert.notEqual(parsed.target.cid, parsed.before.cid);
      const message = parsed.messages.find(m => m.messageId === arrival.messageId);
      const sample = record.value.samples.find(s => s.message.messageId === arrival.messageId);
      return { attempt: event.attempt, requestedAfterArrivalMs: event.requestedAfterArrivalMs,
        completedAfterArrivalMs: event.completedAfterArrivalMs, nativeFields: sample?.nativeFields,
        present: !!message, message };
    });
    const updates = media.filter(e => e.update.mcode.messageId === arrival.messageId).map(e => ({
      observedAfterArrivalMs: Date.parse(e.at) - Date.parse(arrival.at), index: e.update.index,
      nativeNodeType: e.update.update.type, fields: Object.keys(e.update.update.value || {}) }));
    const latest = reads.filter(r => r.present).at(-1)?.message;
    if (latest) for (const part of latest.parts) if (part.kind === 'image') part.cache = verifyCache(part);
    return { messageId: arrival.messageId, arrivedAt: arrival.at, reads, updates, latest };
  });
  return { startedAt: start.at, finishedAt: finish.at, targetUnselected: true,
    contextUnchangedAcrossReads: true, messages, ignoredOlderMediaUpdates: media.filter(e =>
      !arrivals.some(a => a.messageId === e.update.mcode.messageId)).length };
}

if (require.main === module) {
  try {
    const [input, output] = process.argv.slice(2);
    if (!input || !output) throw new Error('Usage: node tools/qn-media-probe/analyze-live.cjs <events.ndjson> <summary.json>');
    const result = analyze(path.resolve(input));
    fs.writeFileSync(path.resolve(output), JSON.stringify(result, null, 2), { flag: 'wx' });
    console.log(JSON.stringify({ startedAt: result.startedAt, finishedAt: result.finishedAt,
      targetUnselected: result.targetUnselected, ignoredOlderMediaUpdates: result.ignoredOlderMediaUpdates,
      messages: result.messages.map(m => ({ messageId: m.messageId,
        reads: m.reads.map(r => ({ attempt: r.attempt, completedAfterArrivalMs: r.completedAfterArrivalMs,
          templateId: r.nativeFields?.templateId, parts: r.message?.parts.map(p => ({ kind: p.kind,
            nativeNodeType: p.nativeNodeType, representation: p.representation, hasTitle: !!p.title,
            hasUrl: !!p.url, hasCachePath: !!p.localPath })) })), updates: m.updates,
        final: m.latest?.parts.map(p => ({ kind: p.kind, productId: p.productId, title: p.title,
          displayPrice: p.displayPrice, width: p.width, height: p.height, cache: p.cache })) })) }, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { analyze };
