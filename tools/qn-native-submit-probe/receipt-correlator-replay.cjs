'use strict';

// Read an existing capture only. No live process access or send capability.
const fs = require('node:fs');
const path = require('node:path');
const { ReceiptCorrelator } = require('./receipt-correlator.cjs');

function replayCapture(file, { account, cid, text }) {
  const bytes = fs.readFileSync(file);
  const metadata = JSON.parse(fs.readFileSync(`${file}.json`, 'utf8'));
  if (metadata.status !== 'complete' || metadata.copiedBytes !== bytes.length ||
      metadata.finalOffset - metadata.initialOffset !== bytes.length ||
      bytes.length > 32 * 1024 * 1024) {
    throw new Error('Incomplete or inconsistent capture');
  }
  const startedAt = Date.parse(metadata.startedAt);
  const deadline = Date.parse(metadata.endedAt);
  const streamIdentity = path.basename(file);
  const correlator = new ReceiptCorrelator({ requestId: 'offline-unbound-replay',
    account, cid, text, cursor: metadata.initialOffset, startedAt, deadline, streamIdentity });
  let start = 0;
  while (start < bytes.length) {
    const newline = bytes.indexOf(10, start);
    if (newline === -1) throw new Error('Capture ends with incomplete line');
    const end = newline + 1;
    const line = bytes.subarray(start, newline).toString('utf8').replace(/\r$/, '');
    // Capture did not persist per-line arrival times. Replay uses synthetic
    // monotonic time and must not claim to validate timing or late delivery.
    correlator.observe({ line, start: metadata.initialOffset + start,
      end: metadata.initialOffset + end, observedAt: startedAt, streamIdentity });
    start = end;
  }
  correlator.advanceTime(deadline);
  return { capture: path.resolve(file), timingValidated: false,
    requestBindingValidated: false, ...correlator.snapshot() };
}

if (require.main === module) {
  if (process.argv.length !== 6) {
    console.error('Usage: node receipt-correlator-replay.cjs <capture.log> <account> <cid> <text>');
    process.exitCode = 2;
  } else {
    try {
      const [, , file, account, cid, text] = process.argv;
      console.log(JSON.stringify(replayCapture(file, { account, cid, text }), null, 2));
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}

module.exports = { replayCapture };
