'use strict';

const TARGET = Object.freeze({ shopUid: '2222303856223', mainUid: '2216058631944',
  cid: '2214525969878.1-2216058631944.1#11001@cntaobao' });
const SAMPLE_IDS = Object.freeze(['4297459394501.PNM', '4297463483501.PNM', '4299631672227.PNM']);

function snapshot(env) {
  const state = env._vs || {}, login = state.loginID || {};
  return { shopUid: String(login.targetId || ''), mainUid: String(login.havMainId || ''),
    cid: state.conversationID && state.conversationID.ccode || '' };
}

function assertTarget(state) {
  if (state.shopUid !== TARGET.shopUid || state.mainUid !== TARGET.mainUid)
    throw new Error('media probe account mismatch');
}

function parse(value) { return typeof value === 'string' ? JSON.parse(value) : value; }

function validateMessageIds(ids) {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 6 || new Set(ids).size !== ids.length ||
      ids.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9._-]{1,100}$/.test(id)))
    throw new Error('expected one to six distinct message IDs');
  return ids;
}

// Keep selected native data intact or reject it; never truncate serialized JSON.
function boundedClone(value) {
  const text = JSON.stringify(value);
  if (text.length > 64000) throw new Error('native sample exceeds 64000 characters');
  return JSON.parse(text);
}

function createInspector(createReader, env) {
  let busy = false;
  return async function inspect(options = {}) {
    if (busy) throw new Error('media inspection already in progress');
    busy = true;
    try {
      const before = snapshot(env); assertTarget(before);
      const requested = options.messageIds == null ? null : validateMessageIds(options.messageIds);
      const requireUnselected = !!requested || options.requireUnselected === true;
      if (requireUnselected && before.cid === TARGET.cid) throw new Error('target conversation is selected');
      let nativeRows;
      // Wrap only this reader's environment; leave the client's imsdk and callbacks unchanged.
      const isolated = { get _vs() { return env._vs; }, imsdk: {
        invoke(method, param, timeout) {
          if (method !== 'im.singlemsg.GetLocalHisMsg' || param.cid.ccode !== TARGET.cid)
            throw new Error('media probe method/cid mismatch');
          return env.imsdk.invoke(method, param, timeout).then(value => {
            const response = parse(value);
            const result = parse(response.result == null ? response : response.result);
            nativeRows = Array.isArray(result) ? result : result && result.msgs;
            return value;
          });
        }
      } };
      const history = await createReader(isolated)({ shopUid: TARGET.shopUid, cid: TARGET.cid, count: 20 });
      const after = snapshot(env); assertTarget(after);
      if (before.cid !== after.cid) throw new Error('selected conversation changed during inspection');
      let textControlSelected = false;
      const samples = [];
      history.messages.forEach((message, index) => {
        const known = (requested || SAMPLE_IDS).includes(message.messageId);
        const control = !requested && !known && !textControlSelected && message.direction === 'incoming' && !!message.text && !!message.messageId;
        if (!known && !control) return;
        if (control) textControlSelected = true;
        const raw = nativeRows[index], scalarFields = {};
        // Enumerate unknown field names, but retain values only for native type/status metadata.
        for (const key of Object.keys(raw)) {
          if (/^(templateId|type|msgtype|messageType|subType|contentType|source|status)$/i.test(key) &&
              ['string', 'number', 'boolean'].includes(typeof raw[key])) scalarFields[key] = raw[key];
        }
        samples.push({ message, role: requested ? 'requested' : known ? 'historical-sample' : 'text-control',
          nativeKeys: Object.keys(raw), nativeFields: scalarFields,
          originalData: boundedClone(raw.originalData == null ? null : raw.originalData) });
      });
      const output = { version: requested ? 2 : 1, target: TARGET, method: history.method, count: history.count,
        before, after, samples, missingSampleIds: (requested || SAMPLE_IDS).filter(id => !samples.some(s => s.message.messageId === id)) };
      if (requested) { output.requestedMessageIds = requested; output.requireUnselected = true; }
      if (JSON.stringify(output).length > 256000) throw new Error('inspection exceeds output limit');
      return output;
    } finally { busy = false; }
  };
}

module.exports = { TARGET, SAMPLE_IDS, snapshot, assertTarget, validateMessageIds, createInspector };
