import { createHmac, randomBytes } from 'node:crypto';

// Store only pseudonymized diagnostic data; no message body, credentials or names on disk.
export class DouyinObservationBuffer {
  constructor() {
    this.salt = randomBytes(32);
    this.records = [];
    this.dropped = 0;
    this.startedAt = new Date().toISOString();
  }

  digest(value) { return createHmac('sha256', this.salt).update(String(value)).digest('hex').slice(0, 20); }

  // Preserve JSON field structure, never nested scalar values (even fields named
  // content/type/status). URL paths, signatures, titles and prices stay private.
  payloadShape(value, depth = 0) {
    if (depth > 8) return { type: 'depth-limit' };
    if (value === null) return { type: 'null' };
    if (Array.isArray(value)) return { type: 'array', items: value.slice(0, 30).map((item) => this.payloadShape(item, depth + 1)) };
    if (typeof value === 'object') return { type: 'object', fields: Object.fromEntries(
      Object.entries(value).slice(0, 70).map(([key, item]) => [
        /^[A-Za-z_$][A-Za-z0-9_$:]{0,63}$/.test(key) ? key : `key_${this.digest(key)}`,
        /token|cookie|authorization|password|secret|ticket|headers|stack/i.test(key)
          ? { type: 'redacted' } : this.payloadShape(item, depth + 1),
      ]),
    ) };
    const text = String(value);
    return { type: typeof value, length: text.length, fingerprint: this.digest(text),
      ...(typeof value === 'string' && /^https?:\/\//i.test(value) ? { format: 'http-url' } : {}) };
  }

  redactPayloads(value) {
    const result = {};
    for (const key of ['content', 'hintContent', 'ext.generic_search_keywords', 'ext.msg_render_model', 'ext.static_data', 'ext.imageUrl']) {
      const sample = value?.[key];
      if (!sample || typeof sample !== 'object') continue;
      result[key] = {
        valueType: ['null', 'string', 'number', 'boolean', 'object'].includes(sample.valueType) ? sample.valueType : 'unknown',
        parsing: ['json', 'not-json', 'invalid-json', 'size-limit'].includes(sample.parsing) ? sample.parsing : 'unknown',
        ...(Number.isSafeInteger(sample.originalLength) && sample.originalLength >= 0 ? { originalLength: sample.originalLength } : {}),
        ...(Object.hasOwn(sample, 'value') ? { shape: this.payloadShape(sample.value) } : {}),
      };
    }
    return result;
  }

  redact(value, name = '', depth = 0) {
    if (depth > 8) return '[depth-limit]';
    if (value == null) return null;
    if (name === 'diagnosticPayloads') return this.redactPayloads(value);
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    if (/token|cookie|authorization|password|secret|ticket|headers|stack/i.test(name)) return '[redacted]';
    if (/^(content|hintContent|text|message|msg|nickname|uname|screen_name|ShopName|staffName|name)$/i.test(name)) {
      const markers = new Set(['[商品]', '[图片]', '[订单卡片]', '[客服关闭会话]',
        '用户超时未回复，系统关闭会话', '从历史会话发起会话']);
      return { type: typeof value, length: text.length, fingerprint: this.digest(text),
        ...(['content', 'hintContent'].includes(name) && markers.has(value) ? { marker: value } : {}) };
    }
    if (Array.isArray(value)) return value.slice(0, 30).map((item) => this.redact(item, name, depth + 1));
    if (typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).slice(0, 70).map(([key, item]) => [
        // Map keys can themselves be user IDs. Preserve only static field names.
        /^[A-Za-z_$][A-Za-z0-9_$:]{0,63}$/.test(key) ? key : `key_${this.digest(key)}`,
        this.redact(item, key, depth + 1),
      ]));
    }
    if (/conversationId$/i.test(name) && typeof value === 'string') {
      return value.split(':').map((part, index) => !part ? ''
        : index >= 3 && /^(2|1|pigeon)$/.test(part) ? part : `id_${this.digest(part)}`).join(':');
    }
    if (/id$|sender$|^receiver$|^uid$|user_id|shop_id/i.test(name)) return `id_${this.digest(text)}`;
    if (name === 'createdAt' && typeof value === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(value)) return value;
    // Message protocol enum fields need their names for non-text classification.
    // Nested payload fields use payloadShape(), so arbitrary payload "type" values
    // do not get promoted to public protocol enums.
    if (/^(type|msgType|pigeonMsgType|displayType)$/.test(name)
      && typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(value)) return value;
    // Only known enum/status/time fields retain values; unknown primitives are fingerprints.
    if (/^(senderRole|pigeonMsgType|messageType|msgType|type|displayType|status|serverStatus|flightStatus|code|errorCode|createTime|updateTime|serverTime|count|total|countdown|countdown_time|attention|s:sender_biz_role|s:send_response_status|s:send_response_check_code|messageHook|sendHook|success|isSuccess)$/i.test(name)
      && /^(?:[0-9.\-]+|true|false|Buyer|Seller|CurrentServer|Server|System|Robot|text|robot|image|success|failed|pending)$/i.test(text)) return value;
    return { type: typeof value, length: text.length, fingerprint: this.digest(text) };
  }

  ingest(batch, frameUrl) {
    if (!batch || !Array.isArray(batch.records)) return;
    this.dropped += Number.isSafeInteger(batch.dropped) && batch.dropped > 0 ? batch.dropped : 0;
    for (const entry of batch.records.slice(0, 20)) {
      if (!['message', 'send_call', 'send_throw', 'send_resolved', 'send_rejected', 'send_returned',
        'capabilities', 'compensation_http', 'compensation_summary', 'compensation_conversation', 'compensation_error'].includes(entry?.kind)) continue;
      const record = { kind: entry.kind, observedAt: typeof entry.observedAt === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(entry.observedAt) ? entry.observedAt : null,
        frameOrigin: new URL(frameUrl).origin,
        call: Number.isSafeInteger(entry.call) ? entry.call : null, value: this.redact(entry.value) };
      if (JSON.stringify(record).length > 64000) { this.dropped++; continue; }
      if (this.records.length >= 300) { this.records.shift(); this.dropped++; }
      this.records.push(record);
    }
  }

  export() {
    return { version: 2, scope: 'Message field and payload shape verification only; not delivery confirmation', startedAt: this.startedAt,
      exportedAt: new Date().toISOString(), dropped: this.dropped, records: this.records };
  }
}
