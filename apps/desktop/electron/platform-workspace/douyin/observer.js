import { douyinMessageCore } from './message-core.js';

// Serialized into the platform's main world. Never initiates a send.
export async function observeDouyinPage(command, extractCore = douyinMessageCore) {
  const key = '__acsDouyinObservationV1';
  if (!['im.jinritemai.com', 'pigeon.jinritemai.com'].includes(location.hostname)) return null;
  const im = window.__PLATFORM_VARIABLES_IN_BENCH__?.extra?.im;
  let state = window[key];
  if (command.action === 'stop') {
    if (state && command.token && state.token !== command.token) return null;
    const batch = state?.drain();
    if (batch) batch.dropped += state.records.length;
    state?.stop();
    delete window[key];
    return batch || null;
  }
  if (!im) return { ready: false, records: [] };
  if (state && (state.im !== im || state.token !== command.token)) {
    state.stop();
    state = null;
  }
  if (!state) {
    const records = [];
    let dropped = 0;
    let stopped = false;
    let calls = 0;
    const restores = [];
    // Read data properties only: SDK getters and arbitrary toJSON must not run.
    const copy = (value, depth = 0, seen = new WeakSet(), budget = { remaining: 600 }) => {
      if (--budget.remaining < 0) return '[size-limit]';
      if (value == null || typeof value === 'boolean') return value;
      if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
      if (typeof value === 'number') return Number.isSafeInteger(value) || !Number.isInteger(value) ? value : '[unsafe-number]';
      if (typeof value === 'bigint') return String(value);
      if (typeof value === 'string') return value.slice(0, 4096);
      if (typeof value !== 'object' || depth > 5 || seen.has(value)) return '[omitted]';
      seen.add(value);
      // protobuf Long values must be converted before Electron serialization.
      const d = Object.getOwnPropertyDescriptors(value);
      if (Number.isInteger(d.low?.value) && Number.isInteger(d.high?.value)) {
        const bits = (BigInt(d.high.value >>> 0) << 32n) | BigInt(d.low.value >>> 0);
        return String(d.unsigned?.value ? bits : BigInt.asIntN(64, bits));
      }
      if (Array.isArray(value)) return value.slice(0, 30).map((item) => copy(item, depth + 1, seen, budget));
      const result = {};
      for (const [name, descriptor] of Object.entries(d).slice(0, 70)) {
        if ('value' in descriptor && typeof descriptor.value !== 'function') result[name] = copy(descriptor.value, depth + 1, seen, budget);
      }
      return result;
    };
    const summarize = (value) => {
      const list = Array.isArray(value) ? value : [value];
      const fields = ['content', 'hintContent', 'conversationId', 'securityConversationId',
        'conversationShortId', 'subConversationShortId', 'originConversationId', 'originSender',
        'securitySender', 'securityOSender', 'serverId', 'serverStatus', 'serverMessageId',
        'messageId', 'sender', 'senderRole', 'type', 'msgType', 'pigeonMsgType', 'createdAt', 'createTime',
        'createTimestamp', 'indexInConversation', 'indexInConversationV2', 'orderInConversation',
        'version', 'status', 'messageBody', 'data', 'code', 'success', 'result'];
      const extFields = ['s:sender_biz_role', 's:client_message_id', 'b_temp_track_message_id',
        'message_logid', 'attention', 'nickname', 'uname', 'avatar_uri', 'security_src_user_id',
        'pigeon_cid', 'shop_id', 'type', 'displayType', 'order_id', 'goods_id', 'talk_id',
        's:send_response_status', 's:send_response_check_code', 's:send_response_check_msg'];
      return list.slice(0, 20).map((item) => {
        if (!item || typeof item !== 'object') return copy(item);
        const result = {};
        for (const name of fields) {
          const descriptor = Object.getOwnPropertyDescriptor(item, name);
          if (descriptor && 'value' in descriptor) result[name] = copy(descriptor.value, 0);
        }
        const ext = Object.getOwnPropertyDescriptor(item, 'ext')?.value;
        if (command.mode === 'collector' && ext && typeof ext === 'object'
            && !['text', 'file_image'].includes(Object.getOwnPropertyDescriptor(ext, 'type')?.value)) {
          // Project from original data before the generic collector truncates it.
          result.message_core = extractCore(item);
        }
        if (ext && typeof ext === 'object') {
          result.ext = {};
          for (const name of extFields) {
            const descriptor = Object.getOwnPropertyDescriptor(ext, name);
            if (descriptor && 'value' in descriptor) result.ext[name] = copy(descriptor.value, 0);
          }
          if (command.mode === 'collector') {
            // These fields were verified in observation v2. Parse bounded card JSON
            // before the generic string clip; mapper keeps only display fields.
            for (const name of ['static_data', 'generic_search_keywords', 'imageUrl']) {
              const descriptor = Object.getOwnPropertyDescriptor(ext, name);
              if (!descriptor || !('value' in descriptor)) continue;
              let value = descriptor.value;
              if (name !== 'imageUrl' && typeof value === 'string') {
                if (value.length > 65536) continue;
                try { value = JSON.parse(value); } catch { continue; }
              }
              result.ext[name] = copy(value);
            }
          }
        }
        if (command.mode !== 'collector') {
          // Keep diagnostics out of the business collector. Parse bounded JSON before
          // copy() clips strings; the main process exports only its redacted shape.
          result.diagnosticPayloads = {};
          const capture = (owner, name, path) => {
            const descriptor = owner && Object.getOwnPropertyDescriptor(owner, name);
            if (!descriptor || !('value' in descriptor)) return;
            const raw = descriptor.value;
            const sample = { valueType: raw === null ? 'null' : typeof raw, parsing: 'not-json' };
            let parsed = raw;
            if (typeof raw === 'string') {
              sample.originalLength = raw.length;
              if (raw.length > 65536) { sample.parsing = 'size-limit'; }
              else if (/^\s*[\[{]/.test(raw)) {
                try { parsed = JSON.parse(raw); sample.parsing = 'json'; }
                catch { sample.parsing = 'invalid-json'; }
              }
            }
            if (sample.parsing !== 'size-limit') sample.value = copy(parsed);
            result.diagnosticPayloads[path] = sample;
          };
          capture(item, 'content', 'content');
          capture(item, 'hintContent', 'hintContent');
          for (const name of ['generic_search_keywords', 'msg_render_model', 'static_data', 'imageUrl']) {
            capture(ext, name, `ext.${name}`);
          }
          if (!Object.keys(result.diagnosticPayloads).length) delete result.diagnosticPayloads;
        }
        // Some SDK responses wrap the message under data/message/result.
        if (!Object.keys(result).length) return copy(item, 0, new WeakSet(), { remaining: 80 });
        return result;
      });
    };
    const record = (kind, value, call = null) => {
      if (stopped) return;
      try {
        const compactKinds = new Set(['message', 'send_resolved', 'send_rejected', 'send_returned']);
        const entry = { kind, observedAt: new Date().toISOString(), call,
          value: compactKinds.has(kind) ? summarize(value) : copy(value) };
        if (JSON.stringify(entry).length > 64000) { dropped++; return; }
        if (records.length >= 100) { records.shift(); dropped++; }
        records.push(entry);
      } catch { dropped++; }
    };
    const wrap = (object, name, factory) => {
      const original = object?.[name];
      if (typeof original !== 'function') return false;
      const own = Object.getOwnPropertyDescriptor(object, name);
      const wrapped = factory(original);
      try { object[name] = wrapped; } catch { return false; }
      if (object[name] !== wrapped) return false;
      restores.push(() => {
        if (object[name] !== wrapped) return;
        if (own) Object.defineProperty(object, name, own);
        else delete object[name];
      });
      return true;
    };
    const messageHook = wrap(im._message$, 'next', (original) => function (...args) {
      // Preserve this, arguments, return value and thrown exception.
      try { return Reflect.apply(original, this, args); }
      finally {
        record('message', args);
        // Independent T2 diagnostics reuse this hook rather than layering wrappers.
        try {
          const transfer = window.__acsDouyinTransferObservationV1;
          if (!stopped && transfer?.im === im) transfer.receiveMessage(args);
        } catch { /* Observation cannot affect business collection. */ }
        try {
          const transfers = window.__acsDouyinTransfersV1;
          if (!stopped && transfers?.im === im) transfers.receiveMessage(args);
        } catch { /* Manual transfer receipts never change message delivery. */ }
      }
    });
    const sendHook = command.mode !== 'collector' && wrap(im, 'sendText', (original) => function (...args) {
      const call = ++calls;
      record('send_call', { conversationId: args[0], content: args[1] }, call);
      let result;
      try { result = Reflect.apply(original, this, args); }
      catch (error) { record('send_throw', error, call); throw error; }
      // Return the exact original Promise/value. Resolution is observation, not delivery proof.
      if (result instanceof Promise) {
        try {
          Promise.prototype.then.call(result,
            (value) => record('send_resolved', value, call),
            (error) => record('send_rejected', error, call));
        } catch { record('send_returned', { observationUnavailable: true }, call); }
      } else record('send_returned', result, call);
      return result;
    });
    const controller = new AbortController();
    state = { im, token: command.token, records, messageHook, sendHook,
      stop() { stopped = true; controller.abort(); for (const restore of restores.reverse()) { try { restore(); } catch { /* page replaced method */ } } records.length = 0; },
      drain() { const result = { ready: true, messageHook: Boolean(messageHook), sendHook: Boolean(sendHook), dropped, records: records.splice(0, 20) }; dropped = 0; return result; },
    };
    window[key] = state;
    record('capabilities', { messageHook, sendHook });
      // Read-only page-zero query. Diagnostics query once; collection polls every 30 seconds.
    state.lastQuery = 0;
    state.query = () => {
    if (stopped || state.querying) return;
    state.querying = true;
    state.lastQuery = Date.now();
    void fetch(`https://pigeon.jinritemai.com/chat/api/backstage/conversation/get_current_conversation_list?_ts=${Date.now()}&biz_type=4&PIGEON_BIZ_TYPE=2&pageNo=0&pageSize=200&_pms=1&FUSION=true`, {
      credentials: 'include', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
    }).then(async (response) => {
      record('compensation_http', { status: response.status });
      if (!response.ok) return;
      const body = await response.json();
      record('compensation_summary', { code: body.code, total: body.total, count: Array.isArray(body.data) ? body.data.length : null });
      if (body.code === 0 && Array.isArray(body.data)) {
        for (const conversation of body.data.slice(0, 20)) record('compensation_conversation', {
          msgList: (conversation.msgList || []).slice(0, 30).map((item) => ({ messageBody: summarize(item.messageBody || item)[0] })),
        });
      }
    }).catch((error) => record('compensation_error', { name: error.name }))
      .finally(() => { state.querying = false; });
    };
    state.query();
  }
  if (command.mode === 'collector' && Date.now() - state.lastQuery >= 30000) state.query();
  return state.drain();
}

export function observerScript(command) {
  return `(${observeDouyinPage.toString()})(${JSON.stringify(command)}, ${douyinMessageCore.toString()})`;
}
