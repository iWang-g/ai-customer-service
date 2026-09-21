// Serialized into Feige's main world. Only the native page/user initiates transfers.
export async function observeDouyinTransfer(command) {
  const key = '__acsDouyinTransferObservationV1';
  if (!['im.jinritemai.com', 'pigeon.jinritemai.com'].includes(location.hostname)) return { error: 'invalid_origin' };
  let state = window[key];
  if (command.action === 'clear') {
    if (state?.token === command.token) { state.cancel(); delete window[key]; }
    return null;
  }
  if (!['start', 'poll', 'stop'].includes(command.action) || !command.token) return { error: 'invalid_command' };
  if (state && state.token !== command.token) return { error: 'busy' };
  if (!state && command.action !== 'start') return { error: 'not_started' };
  if (!state) {
    const im = window.__PLATFORM_VARIABLES_IN_BENCH__?.extra?.im;
    const sdk = im?.pigeonIM;
    const original = sdk?.transferConversation;
    if (typeof original !== 'function') return { error: 'im_not_ready' };
    if (!command.shopId || !command.staffId) return { error: 'identity_unavailable' };
    const own = Object.getOwnPropertyDescriptor(sdk, 'transferConversation');
    let stopped = false, installed = false, calls = 0, dropped = 0, bytes = 0, timer, truncated = false;
    let conversationId = null, lastIdentity = 0, invalid = false, checking = null;
    const records = [], controller = new AbortController();
    // Read data descriptors only. Never invoke SDK getters, toJSON or arbitrary thenables.
    const copy = (value, depth = 0, seen = new WeakSet(), budget = { left: 800 }) => {
      if (--budget.left < 0 || depth > 7) { truncated = true; return { observationLimit: true }; }
      if (value === undefined) return { observationUndefined: true };
      if (value === null || typeof value === 'boolean') return value;
      if (typeof value === 'string') {
        if (value.length <= 4096) return value;
        truncated = true; return { observationStringLimit: value.length };
      }
      if (typeof value === 'number') return Number.isInteger(value) && !Number.isSafeInteger(value) ? { unsafeNumber: true } : value;
      if (typeof value === 'bigint') return String(value);
      if (typeof value !== 'object' || seen.has(value)) { truncated = true; return { observationOmitted: true }; }
      seen.add(value);
      if (value instanceof Date) {
        const time = Date.prototype.getTime.call(value);
        return Number.isFinite(time) ? Date.prototype.toISOString.call(value) : { observationInvalidDate: true };
      }
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (Number.isInteger(descriptors.low?.value) && Number.isInteger(descriptors.high?.value)) {
        const bits = (BigInt(descriptors.high.value >>> 0) << 32n) | BigInt(descriptors.low.value >>> 0);
        return String(descriptors.unsigned?.value ? bits : BigInt.asIntN(64, bits));
      }
      const output = Array.isArray(value) ? [] : Object.create(null);
      let count = 0;
      for (const [name, descriptor] of Object.entries(descriptors)) {
        if (name === 'length' && Array.isArray(value)) continue;
        if (++count > 50) { truncated = true; output.observationLimit = true; break; }
        if ('value' in descriptor && typeof descriptor.value !== 'function')
          Object.defineProperty(output, name, { value: copy(descriptor.value, depth + 1, seen, budget), enumerable: true });
      }
      return output;
    };
    const dataValue = (owner, name) => owner && typeof owner === 'object'
      ? Object.getOwnPropertyDescriptor(owner, name)?.value : undefined;
    const messageFields = ['conversationId', 'securityConversationId', 'originConversationId', 'conversationShortId',
      'subConversationShortId', 'serverId', 'serverMessageId', 'messageId', 'version', 'indexInConversation',
      'indexInConversationV2', 'orderInConversation', 'originSender', 'securitySender', 'sender', 'senderRole',
      'createdAt', 'createTime', 'createTimestamp', 'type', 'msgType', 'pigeonMsgType', 'serverStatus',
      'flightStatus', 'isOffline', 'pullSource', 'conversationBizType', 'pigeonBizType', 'content', 'hintContent'];
    const extFields = ['type', 'transfer_type', 'displayType', 'is_allocated_event', 'from_event_center', 'attention',
      'PIGEON_BIZ_TYPE', 'visibility_type', 'sender_role', 'im_sender_role', 's:sender_biz_role', 's:cur_sub_conv_status',
      's:cur_sub_conv_version', 's:base_scene', 's:do_not_increase_unread', 's:incr_unread_user', 's:security_incr_unread_user',
      'p:open_countdown', 'to_trans_uid', 'src_user_id', 'security_src_user_id', 'o_sender', 'pigeon_cid',
      'shop_id', 'talk_id', 'security_biz_conversation_id', 'receiver_id', 'security_receiver_id', 'security_user_id'];
    const summarizeMessage = (item) => {
      const ext = dataValue(item, 'ext');
      // Match only identity fields on this message, never text or an unrelated item in the same batch.
      if (![dataValue(item, 'conversationId'), dataValue(item, 'securityConversationId'),
        dataValue(ext, 'security_biz_conversation_id')].includes(conversationId)) return null;
      const sample = Object.create(null), budget = { left: 800 };
      for (const name of messageFields) {
        const value = dataValue(item, name);
        if (value !== undefined) sample[name] = copy(value, 0, new WeakSet(), budget);
      }
      sample.ext = Object.create(null);
      for (const name of extFields) {
        const value = dataValue(ext, name);
        if (value !== undefined) sample.ext[name] = copy(value, 0, new WeakSet(), budget);
      }
      const flow = dataValue(ext, 'flow_extra');
      if (flow !== undefined) {
        sample.flowExtra = { parsing: 'not-string', valueType: typeof flow };
        if (typeof flow === 'string') {
          sample.flowExtra.originalLength = flow.length;
          if (flow.length > 8192) { sample.flowExtra.parsing = 'size-limit'; truncated = true; }
          else {
            try {
              // Retain unsafe JSON integer lexemes when supported; never correlate rounded IDs.
              const parsed = JSON.parse(flow, (_key, value, context) =>
                typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)
                  ? context?.source ? { observationJsonInteger: context.source } : { observationUnsafeJsonNumber: true } : value);
              sample.flowExtra.parsing = 'json';
              sample.flowExtra.value = copy(parsed, 0, new WeakSet(), { left: 300 });
            } catch { sample.flowExtra.parsing = 'invalid-json'; }
          }
        }
      }
      return sample;
    };
    const record = (kind, value, call = null, alreadyTruncated = false) => {
      if (stopped || invalid) return;
      try {
        truncated = alreadyTruncated;
        const entry = { kind, call, observedAt: new Date().toISOString(), value: copy(value) };
        entry.truncated = truncated;
        const size = JSON.stringify(entry).length;
        if (size > 48000 || records.length >= 100 || bytes + size > 512000) { dropped++; return; }
        records.push(entry); bytes += size;
      } catch { dropped++; }
    };
    const identity = async () => {
      if (checking) return checking;
      checking = (async () => {
        try {
          const response = await fetch(`https://pigeon.jinritemai.com/backstage/currentuser?_ts=${Date.now()}&biz_type=4&_pms=1`, {
            method: 'GET', credentials: 'include', redirect: 'error', cache: 'no-store',
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
          });
          if (!response.ok) throw new Error();
          const reader = response.body?.getReader();
          if (!reader) throw new Error();
          let text = '', size = 0; const decoder = new TextDecoder();
          try {
            while (true) {
              const part = await reader.read(); if (part.done) break;
              size += part.value.byteLength; if (size > 128 * 1024) throw new Error();
              text += decoder.decode(part.value, { stream: true });
            }
          } finally { await reader.cancel().catch(() => {}); }
          const result = JSON.parse(text + decoder.decode());
          const asId = (v) => typeof v === 'string' ? v : Number.isSafeInteger(v) ? String(v) : null;
          if (result.code !== 0 || asId(result.data?.ShopId) !== command.shopId
            || asId(result.data?.CustomerServiceInfo?.id) !== command.staffId
            || window.__PLATFORM_VARIABLES_IN_BENCH__?.extra?.im !== im || im.pigeonIM !== sdk) throw new Error();
          lastIdentity = Date.now(); return true;
        } catch { invalid = true; records.length = 0; state.stop(); return false; }
        finally { checking = null; }
      })();
      return checking;
    };
    function wrapped(...args) {
      // Scope diagnostics to the first native transfer's full conversation ID.
      let call = null;
      try {
        const cid = args[1];
        const parts = typeof cid === 'string' && cid.length <= 512 ? cid.split(':') : [];
        const fresh = Date.now() - lastIdentity < 20000 && window.__PLATFORM_VARIABLES_IN_BENCH__?.extra?.im === im && im.pigeonIM === sdk;
        if (!stopped && !invalid && fresh && parts.length === 6 && parts[0] && parts[1] === command.shopId
          && parts[2] === '' && parts.slice(3).join(':') === '2:1:pigeon' && (!conversationId || conversationId === cid)) {
          conversationId = cid; call = ++calls;
          record('transfer_call', { args, conversationId, sourceStaffId: command.staffId, targetStaffId: args[2], shopId: command.shopId }, call);
        } else if (!stopped) record('scope_skipped', { reason: fresh ? 'other_or_unrecognized_conversation' : 'identity_stale' });
      } catch { /* Diagnostics must not change platform behavior. */ }
      let result;
      try { result = Reflect.apply(original, this, args); }
      catch (error) { if (call !== null) record('transfer_throw', error, call); throw error; }
      if (call !== null) {
        try {
          if (result instanceof Promise) Promise.prototype.then.call(result,
            (value) => record('transfer_resolved', value, call),
            (error) => record('transfer_rejected', error, call));
          else record('transfer_returned', result, call);
        } catch { record('transfer_returned', { promiseObservationUnavailable: true }, call); }
      }
      return result;
    }
    state = { token: command.token, im,
      cancel() { state.stop(); controller.abort(); records.length = 0; },
      stop() {
        stopped = true; clearTimeout(timer);
        if (installed && sdk.transferConversation === wrapped) {
          try { if (own) Object.defineProperty(sdk, 'transferConversation', own); else delete sdk.transferConversation; } catch { /* replaced SDK */ }
        }
      },
      receiveMessage(value) {
        if (!conversationId || stopped || invalid || Date.now() - lastIdentity >= 20000) return;
        try {
          // The shared hook passes its argument array; SDKs may put a message batch in an argument.
          let visited = 0;
          const visit = (item, depth = 0) => {
            if (++visited > 40 || depth > 2) { dropped++; return; }
            if (Array.isArray(item)) {
              const length = dataValue(item, 'length');
              if (length > 20) dropped += length - 20;
              for (let i = 0; i < Math.min(length, 20); i++) visit(dataValue(item, String(i)), depth + 1);
            } else if (item && typeof item === 'object') {
              truncated = false;
              const sample = summarizeMessage(item);
              if (sample) record('conversation_event', [sample], null, truncated);
            }
          };
          visit(value);
        } catch { dropped++; }
      },
      identity,
      async read(stop) {
        if (!invalid && (stop || Date.now() - lastIdentity >= 15000)) await identity();
        if (!stopped && (sdk.transferConversation !== wrapped || window.__PLATFORM_VARIABLES_IN_BENCH__?.extra?.im !== im)) {
          record('hook_replaced', {}); state.stop();
        }
        if (stop) state.stop();
        const batch = { error: invalid ? 'identity_changed_or_unavailable' : null, active: !stopped,
          transferHook: installed, messageTap: Boolean(window.__acsDouyinObservationV1?.messageHook),
          calls, dropped, records: records.splice(0), token: command.token };
        bytes = 0; dropped = 0; return batch;
      },
    };
    window[key] = state;
    if (!(await identity()) || stopped) return { error: 'identity_changed_or_unavailable' };
    try { sdk.transferConversation = wrapped; installed = sdk.transferConversation === wrapped; } catch { /* frozen SDK */ }
    if (!installed) { state.stop(); delete window[key]; return { error: 'hook_unavailable' }; }
    timer = setTimeout(() => state.stop(), 10 * 60 * 1000);
    record('observation_started', { shopId: command.shopId, sourceStaffId: command.staffId });
  }
  return state.read(command.action === 'stop');
}

export const transferObserverScript = (command) => `(${observeDouyinTransfer.toString()})(${JSON.stringify(command)})`;
