'use strict';

const TARGET = Object.freeze({
  shopUid: '2222303856223',
  mainUid: '2216058631944',
  sourceNick: '有求必应羊羊:王刚',
  buyerNick: 'tb542952183',
  contactId: 'cntaobaotb542952183',
  buyerUid: '2208903307549',
  cid: '2208903307549.1-2216058631944.1#11001@cntaobao',
  targetNick: '有求必应羊羊:城堡',
  targetContactId: 'cntaobao有求必应羊羊:城堡',
  targetUid: '2223061545705',
  bizDomain: 'taobao',
  reason: '测试转接'
});

function validateIdentity(input = {}) {
  for (const key of ['shopUid', 'mainUid', 'buyerUid', 'cid', 'targetUid']) {
    if (String(input[key] ?? '') !== TARGET[key]) throw new Error('Transfer target mismatch: ' + key);
  }
  if (input.sourceNick !== TARGET.sourceNick || input.buyerNick !== TARGET.buyerNick ||
      input.targetNick !== TARGET.targetNick) throw new Error('Transfer name mismatch');
  return true;
}

// Ability-layer fields are kept separate from the lower-level MTOP fields.
function buildAbilityParam(input = {}) {
  validateIdentity(input);
  return {
    contactID: TARGET.contactId,
    targetID: TARGET.targetContactId,
    contactSecurityUID: '',
    contactBizDomain: TARGET.bizDomain,
    reason: TARGET.reason,
    options: '',
    tagName: ''
  };
}

function buildAbilityInvocation(input = {}) {
  return { cmd: 'transferContact', param: buildAbilityParam(input) };
}

function validateSource(state) {
  if (!state || state.shopUid !== TARGET.shopUid || state.mainUid !== TARGET.mainUid ||
      state.nick !== TARGET.sourceNick || typeof state.cid !== 'string') throw new Error('Source context mismatch');
}

function requireOnlineTarget(summary) {
  if (!summary?.paginationComplete || !summary.contextUnchanged) throw new Error('Incomplete staff preflight');
  const target = summary.accounts.find(a => a.accountId === TARGET.targetUid);
  if (!target?.onlineCandidate || target.nick !== TARGET.targetNick || target.mainAccountId !== TARGET.mainUid ||
      target.suspend !== false) throw new Error('Authorized receiving agent is not an available online candidate');
  return target;
}

// Callback success is transport evidence, not proof of reception ownership.
function summarizeCallback(result) {
  const allowed = /^(?:code|errorCode|error_code|success|status|module|data|result|ret)$/;
  function project(value, depth = 0) {
    if (depth > 6) return '[depth-limit]';
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string') {
      try { return project(JSON.parse(value), depth + 1); } catch { return '[string omitted]'; }
    }
    if (Array.isArray(value)) return value.slice(0, 10).map(v => project(v, depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
      .filter(([k]) => allowed.test(k)).map(([k, v]) => [k, project(v, depth + 1)]));
    return null;
  }
  return { invoked: result.invoked === true, callbackSuccess: result.ok === true,
    outcome: result.invoked ? 'attempted-unconfirmed' : 'not-invoked', ownershipConfirmed: false,
    callback: project(result.value), error: typeof result.error === 'string' ? result.error.slice(0, 160) : null };
}

module.exports = { TARGET, validateIdentity, validateSource, buildAbilityParam, buildAbilityInvocation,
  requireOnlineTarget, summarizeCallback };
