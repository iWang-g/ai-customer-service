import { createHmac, randomBytes } from 'node:crypto';

export class DouyinTransferObservationBuffer {
  constructor() {
    this.salt = randomBytes(32); this.records = []; this.dropped = 0; this.bytes = 0;
    this.startedAt = new Date().toISOString(); this.calls = 0; this.messageTap = false;
  }
  digest(v) { return createHmac('sha256', this.salt).update(String(v)).digest('hex').slice(0, 20); }
  shape(value, depth = 0, budget = { left: 2000 }) {
    if (--budget.left < 0 || depth > 9) return { type: 'limit' };
    if (value === null) return { type: 'null' };
    if (Array.isArray(value)) return { type: 'array', length: value.length,
      items: value.slice(0, 50).map((v) => this.shape(v, depth + 1, budget)) };
    if (typeof value === 'object') return { type: 'object', fields: Object.fromEntries(Object.entries(value).slice(0, 60).map(([k, v]) => [
      /^[A-Za-z_$][A-Za-z_$:]{0,63}$/.test(k) ? k : `key_${this.digest(k)}`,
      /token|cookie|authorization|password|secret|ticket|headers|stack|mobile|phone|address|email/i.test(k)
        ? { type: 'redacted' } : this.shape(v, depth + 1, budget),
    ])) };
    return { type: typeof value, length: String(value).length, fingerprint: this.digest(value) };
  }
  eventProtocol(message) {
    const fields = {}, times = {};
    const scalar = (v, symbolic = false) => {
      if (typeof v === 'boolean' || (Number.isSafeInteger(v) && Math.abs(v) < 1000000)) return true;
      return typeof v === 'string' && (/^(?:-?\d{1,6}|true|false)$/.test(v)
        || (symbolic && /^[A-Za-z][A-Za-z_:.\-]{0,63}$/.test(v)));
    };
    const rootKeys = ['type', 'msgType', 'pigeonMsgType', 'senderRole', 'serverStatus', 'flightStatus',
      'isOffline', 'pullSource', 'conversationBizType', 'pigeonBizType'];
    const extKeys = ['type', 'transfer_type', 'displayType', 'is_allocated_event', 'from_event_center', 'attention',
      'PIGEON_BIZ_TYPE', 'visibility_type', 'sender_role', 'im_sender_role', 's:sender_biz_role',
      's:cur_sub_conv_status', 's:base_scene', 's:do_not_increase_unread', 'p:open_countdown'];
    for (const key of rootKeys) if (scalar(message?.[key])) fields[key] = message[key];
    for (const key of extKeys) if (scalar(message?.ext?.[key], ['type', 's:sender_biz_role', 's:base_scene'].includes(key)))
      fields[`ext.${key}`] = message.ext[key];
    for (const key of ['createdAt', 'createTime', 'createTimestamp']) {
      const v = message?.[key];
      if (typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)
        && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v) times[key] = v;
      else if ((Number.isSafeInteger(v) || (typeof v === 'string' && /^(?:\d{10}|\d{13})$/.test(v)))
        && ((Number(v) >= 946684800 && Number(v) < 4102444800)
          || (Number(v) >= 946684800000 && Number(v) < 4102444800000))) times[key] = v;
    }
    const flow = message?.flowExtra;
    return { fields, times, ...(flow ? { flowExtra: {
      parsing: ['json', 'invalid-json', 'size-limit', 'not-string'].includes(flow.parsing) ? flow.parsing : 'unknown',
      ...(Number.isSafeInteger(flow.originalLength) && flow.originalLength >= 0 ? { originalLength: flow.originalLength } : {}),
    } } : {}) };
  }
  ingest(batch) {
    if (!batch || batch.error || !Array.isArray(batch.records)) return;
    this.messageTap ||= batch.messageTap === true;
    if (Number.isSafeInteger(batch.calls)) this.calls = Math.max(this.calls, batch.calls);
    if (Number.isSafeInteger(batch.dropped) && batch.dropped > 0) this.dropped += batch.dropped;
    for (const entry of batch.records.slice(0, 100)) {
      if (!['observation_started', 'transfer_call', 'transfer_throw', 'transfer_resolved', 'transfer_rejected',
        'transfer_returned', 'conversation_event', 'scope_skipped', 'hook_replaced'].includes(entry?.kind)) continue;
      const r = { kind: entry.kind, call: Number.isSafeInteger(entry.call) ? entry.call : null,
        observedAt: typeof entry.observedAt === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(entry.observedAt) ? entry.observedAt : null,
        shape: this.shape(entry.value), truncated: entry.truncated === true, protocolFields: {} };
      // Only top-level numeric status/code and boolean flags are exposed; nested content is always shaped.
      for (const key of ['code', 'errorCode', 'status', 'success', 'isSuccess']) {
        const value = entry.value?.[key];
        if (typeof value === 'boolean' || (Number.isSafeInteger(value) && Math.abs(value) < 1000000)) r.protocolFields[key] = value;
      }
      // Exact paths only: nested flow_extra/content fields named type/status never become public enums.
      if (entry.kind === 'conversation_event' && Array.isArray(entry.value))
        r.eventProtocol = entry.value.slice(0, 20).map((message) => this.eventProtocol(message));
      if (entry.kind === 'scope_skipped') r.scopeReason = ['identity_stale', 'other_or_unrecognized_conversation'].includes(entry.value?.reason)
        ? entry.value.reason : 'unknown';
      const size = JSON.stringify(r).length;
      if (size > 96000 || this.records.length >= 300 || this.bytes + size > 4 * 1024 * 1024) { this.dropped++; continue; }
      this.bytes += size; this.records.push(r);
    }
  }
  export() {
    return { kind: 'douyin_transfer_observation', version: 2, startedAt: this.startedAt, exportedAt: new Date().toISOString(),
      scope: 'First native transfer conversation only; return/resolution is not proof of transfer or ownership.',
      calls: this.calls, outcome: this.calls ? 'requires_review' : 'no_transfer_call_observed',
      messageTap: this.messageTap, dropped: this.dropped,
      knownScalars: Object.fromEntries(['0', '1', '2', 'true', 'false'].map((v) => [v, this.digest(v)])), records: this.records };
  }
}
