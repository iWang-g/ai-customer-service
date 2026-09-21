'use strict';

// Offline research component. No network, timers, target access or send API.
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const identifier = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256;

function parseReceiptLine(line, account) {
  if (typeof line !== 'string') throw new TypeError('line must be a string');
  const header = /^\[[^\]\r\n]+\] app \[CHAT ([^\]\r\n]+) \]\[(onEventNotify|onMsgSendUpdate!)\]\[ /.exec(line);
  if (!header || !header[1].endsWith(`#${account}`)) return [];
  const body = line.slice(header[0].length);
  const marker = header[2] === 'onEventNotify'
    ? 'strEvent=im.singlemsg.onMsgSendUpdate,jsonStr='
    : 'utf8JsonStr=';
  if (header[2] === 'onEventNotify' && !body.startsWith(marker)) return [];
  const start = body.indexOf(marker);
  if (start < 0) throw new Error('missing receipt JSON');
  const trailer = / \]\[(?:WebEventCenter|BridgeChatMsg)\.cpp\(\d+\) [^\]\r\n]+\]\r?$/.exec(body);
  if (!trailer || trailer.index <= start) throw new Error('invalid receipt trailer');
  const raw = body.slice(start + marker.length, trailer.index);
  if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error('receipt JSON too large');
  const values = JSON.parse(raw);
  if (!Array.isArray(values) || values.length > 256) throw new Error('invalid receipt array');
  return values;
}

class ReceiptCorrelator {
  #request;
  #candidates = new Map();
  #issues = new Set();
  #binding = null;
  #lastEnd;
  #lastTime;
  #timedOut = false;
  #lateRecords = 0;

  constructor(request) {
    if (!request || !identifier(request.requestId) || !/^3#\d+$/.test(request.account) ||
        !identifier(request.cid) || typeof request.text !== 'string' || !request.text.length ||
        Buffer.byteLength(request.text) > 16384 || !identifier(request.streamIdentity) ||
        !integer(request.cursor) || !integer(request.startedAt) ||
        !integer(request.deadline) || request.deadline <= request.startedAt) {
      throw new TypeError('invalid request identity, cursor or observation window');
    }
    this.#request = Object.freeze({ ...request });
    this.#lastEnd = request.cursor;
    this.#lastTime = request.startedAt;
  }

  // Evidence is supplied by a trusted caller, not inferred from matching logs.
  bindClientId({ clientId, source, evidenceId } = {}) {
    if (!identifier(clientId) || !identifier(evidenceId) ||
        !['native_callback', 'reviewed_external_evidence'].includes(source)) {
      throw new TypeError('independent binding evidence required');
    }
    if (this.#binding && this.#binding.clientId !== clientId) {
      this.#issues.add('binding_conflict');
    } else if (!this.#binding) {
      this.#binding = { clientId, source, evidenceId };
    }
  }

  advanceTime(now) {
    if (!integer(now) || now < this.#lastTime) {
      this.#issues.add('clock_discontinuity');
      return;
    }
    this.#lastTime = now;
    if (now >= this.#request.deadline) this.#timedOut = true;
  }

  observe({ line, start, end, observedAt, streamIdentity }) {
    if (streamIdentity !== this.#request.streamIdentity) {
      this.#issues.add('stream_changed');
      return;
    }
    if (!integer(start) || !integer(end) || end <= start) {
      this.#issues.add('invalid_cursor');
      return;
    }
    // Entirely old records, including replayed records, cannot become candidates.
    if (end <= this.#lastEnd) return;
    if (start !== this.#lastEnd) {
      this.#issues.add('cursor_gap_or_overlap');
      return;
    }
    this.#lastEnd = end;
    this.advanceTime(observedAt);
    let values;
    try {
      values = parseReceiptLine(line, this.#request.account);
    } catch {
      this.#issues.add('malformed_target_receipt');
      return;
    }
    for (const item of values) {
      const clientId = item?.mcode?.clientId;
      const messageId = item?.mcode?.messageId;
      if (item?.cid?.ccode !== this.#request.cid) {
        if (this.#candidates.has(clientId) || this.#binding?.clientId === clientId) {
          this.#issues.add('client_cid_conflict');
        }
        continue;
      }
      if (item?.originalData?.text !== this.#request.text) {
        if (this.#candidates.has(clientId) || this.#binding?.clientId === clientId) {
          this.#issues.add('client_text_conflict');
        }
        continue;
      }
      if (!identifier(clientId) || typeof messageId !== 'string' || messageId.length > 256 ||
          !Number.isSafeInteger(item.sendStatus) || !Number.isSafeInteger(item.progress) ||
          item.progress < 0 || item.progress > 100) {
        this.#issues.add('invalid_matching_receipt');
        continue;
      }
      if (this.#timedOut) ++this.#lateRecords;
      let candidate = this.#candidates.get(clientId);
      if (!candidate) {
        if (this.#candidates.size >= 16) {
          this.#issues.add('candidate_limit');
          continue;
        }
        candidate = { clientId, messageId: '', records: 0, duplicates: 0,
          transitions: [], firstOffset: start, lastOffset: end, success: false };
        this.#candidates.set(clientId, candidate);
      }
      ++candidate.records;
      candidate.lastOffset = end;
      if (messageId) {
        if (candidate.messageId && candidate.messageId !== messageId) {
          this.#issues.add('client_message_id_conflict');
        }
        for (const other of this.#candidates.values()) {
          if (other.clientId !== clientId && other.messageId === messageId) {
            this.#issues.add('message_client_id_conflict');
          }
        }
        candidate.messageId ||= messageId;
      }
      const state = { sendStatus: item.sendStatus, progress: item.progress, messageId };
      const last = candidate.transitions.at(-1);
      if (last && JSON.stringify(last) === JSON.stringify(state)) {
        ++candidate.duplicates;
      } else if (candidate.transitions.length >= 64) {
        this.#issues.add('transition_limit');
      } else {
        candidate.transitions.push(state);
      }
      const success = item.sendStatus === 0 && item.progress === 100 && !!messageId;
      if (candidate.success && !success) this.#issues.add('status_regression');
      candidate.success ||= success;
    }
  }

  snapshot() {
    const candidates = [...this.#candidates.values()];
    let status = 'pending';
    const bound = this.#binding && this.#candidates.get(this.#binding.clientId);
    if (this.#issues.size) status = 'unknown';
    else if (!this.#binding && candidates.length > 1) status = 'ambiguous';
    else if (bound?.success) status = 'confirmed';
    else if (this.#timedOut) status = 'unknown';
    else if (!this.#binding && candidates[0]?.success) status = 'observed_success_unbound';
    return structuredClone({ requestId: this.#request.requestId, status,
      timedOut: this.#timedOut, lateRecords: this.#lateRecords,
      retryAllowed: false, binding: this.#binding, issues: [...this.#issues], candidates });
  }
}

module.exports = { parseReceiptLine, ReceiptCorrelator };
