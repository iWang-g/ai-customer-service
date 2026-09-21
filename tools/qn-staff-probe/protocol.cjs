'use strict';
const TARGET = Object.freeze({ shopUid: '2222303856223', mainUid: '2216058631944',
  shopNick: '有求必应羊羊:王刚', mainNick: '有求必应羊羊' });

// Kept self-contained so the exact allowlist also runs in the isolated page script.
function buildReadRequest(job, state) {
  const keys = job && Object.keys(job).sort().join(',');
  if (!job || !['id,kind,mainUid,shopUid', 'id,kind,mainUid,pageNo,shopUid'].includes(keys) ||
      typeof job.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(job.id) ||
      job.shopUid !== '2222303856223' || job.mainUid !== '2216058631944' ||
      state.shopUid !== job.shopUid || state.mainUid !== job.mainUid ||
      state.nick !== '有求必应羊羊:王刚' || typeof state.cid !== 'string') throw new Error('Target account mismatch');
  if (!['list', 'status'].includes(job.kind)) throw new Error('Only staff reads are allowed');
  if (job.kind === 'status' && 'pageNo' in job || job.kind === 'list' &&
      (!Number.isInteger(job.pageNo ?? 1) || (job.pageNo ?? 1) < 1 || (job.pageNo ?? 1) > 20)) throw new Error('Invalid page');
  return { method: job.kind === 'list' ? 'mtop.taobao.mmp.subuser.page.get'
    : 'mtop.taobao.qianniu.cloudkefu.accountstatus.getbyid', version: '1.0', httpMethod: 'get',
    param: JSON.stringify(job.kind === 'list' ? { nick: state.nick, page_no: String(job.pageNo ?? 1), page_size: '5' }
      : { main_account_id: state.mainUid }) };
}

function sameContext(a, b) {
  return !!a && !!b && ['shopUid', 'mainUid', 'nick', 'cid'].every(k => typeof a[k] === 'string' && a[k] === b[k]);
}

function parse(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 2 * 1024 * 1024) throw new Error('Invalid response size');
  const text = raw.trim(), jsonp = /^mtopjsonp\d+\(([\s\S]*)\);?$/.exec(text);
  return JSON.parse(jsonp ? jsonp[1] : text, (_key, value, context) => {
    if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) {
      if (!context?.source || !/^-?\d+$/.test(context.source)) throw new Error('Unsafe numeric identifier');
      return context.source;
    }
    return value;
  });
}

const OMIT = /token|cookie|session|secret|password|mobile|phone|email|address|portrait|avatar|permission|auth|security/i;
const omitted = key => OMIT.test(key) && !['mobileOnline', 'mobileClientOnlineStatus'].includes(key);
const KEEP = /^(?:id|uid|nick|name|user_?id|user_?nick|sub_?nick|sub_?status|sub_?user_?id|sub_?user_?nick|sub_?account_?id|account_?id|account_?nick|main_?account_?id|main_?user_?id|status|state|basic_?status|dispatch_?status|online|is_?online|pcOnline|mobileOnline|pcClientOnlineStatus|mobileClientOnlineStatus|clientSuspendStatus|suspend|is_?suspend|suspended|is_?suspended|group_?id|group_?name|department_?id|department_?name|total|total_?count|count|page_?no|page_?size|has_?next|has_?more|error|error_?code|code|success|module|buyer_?count|reception_?count|not_?response_?number)$/i;
function project(value, depth = 0, budget = { n: 0 }) {
  if (++budget.n > 20000 || depth > 12) throw new Error('Response structure limit exceeded');
  if (Array.isArray(value)) return value.map(v => v && typeof v === 'object' ? project(v, depth + 1, budget) : null);
  if (!value || typeof value !== 'object') return null;
  const result = Object.create(null);
  for (const [key, v] of Object.entries(value)) {
    if (omitted(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) continue;
    if (v && typeof v === 'object') result[key] = project(v, depth + 1, budget);
    else if (KEEP.test(key) || /^\d{1,30}$/.test(key)) {
      if (v === null || typeof v === 'boolean' || typeof v === 'number' && Number.isFinite(v) ||
          typeof v === 'string' && v.length <= 256 && !/[\r\n\x00]/.test(v)) result[key] = v;
    }
  }
  return result;
}
function shape(value, depth = 0) {
  if (depth > 5) return Array.isArray(value) ? 'array' : typeof value;
  if (Array.isArray(value)) return { length: value.length, first: value.length ? shape(value[0], depth + 1) : null };
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 80)
    .filter(([k]) => !omitted(k)).map(([k, v]) => [k, shape(v, depth + 1)]));
  return value === null ? 'null' : typeof value;
}
function summarize(raw, job, state) {
  const request = buildReadRequest(job, state);
  let value = parse(raw);
  for (let i = 0; !value?.api && i < 4; i++) {
    value = value?.result ?? value?.data;
    if (typeof value === 'string') value = parse(value);
  }
  if (value?.api?.toLowerCase() !== request.method || value.v !== '1.0') throw new Error('Unexpected response API/version');
  if (!Array.isArray(value.ret) || !value.ret.length || !value.ret.every(r => typeof r === 'string' && r.startsWith('SUCCESS::')))
    throw new Error('Staff API did not return success');
  if (!value.data || typeof value.data !== 'object') throw new Error('Missing staff response data');
  const data = value.data;
  let accounts;
  if (job.kind === 'list') {
    if (data.error !== false || !Array.isArray(data.result) || data.result.length > 5) throw new Error('Staff list business result failed');
    accounts = data.result;
    for (const item of accounts) {
      if (String(item.userId) !== TARGET.mainUid || !/^\d{1,30}$/.test(String(item.subUserId)) ||
          typeof item.subNick !== 'string' || !item.subNick.startsWith(TARGET.mainNick + ':') ||
          !Number.isInteger(item.subStatus) || !Number.isInteger(item.dispatchStatus)) throw new Error('Invalid staff account identity/status');
    }
    if (new Set(accounts.map(a => String(a.subUserId))).size !== accounts.length) throw new Error('Duplicate staff account');
  } else {
    if (data.errorCode !== 0 || !data.errorMap || typeof data.errorMap !== 'object' || Array.isArray(data.errorMap) ||
        Object.keys(data.errorMap).length || !Array.isArray(data.module) || data.module.length > 5000) throw new Error('Staff status business result failed');
    accounts = data.module;
    for (const item of accounts) {
      if (String(item.mainAccountId) !== TARGET.mainUid || !/^\d{1,30}$/.test(String(item.accountId)) ||
          typeof item.nick !== 'string' || typeof item.suspend !== 'boolean' || typeof item.pcOnline !== 'boolean' ||
          item.clientSuspendStatus !== undefined && !Number.isInteger(item.clientSuspendStatus) ||
          item.pcClientOnlineStatus !== undefined && !Number.isInteger(item.pcClientOnlineStatus) ||
          item.mobileOnline !== undefined && typeof item.mobileOnline !== 'boolean' ||
          item.mobileClientOnlineStatus !== undefined && !Number.isInteger(item.mobileClientOnlineStatus)) throw new Error('Invalid staff status identity/fields');
    }
    if (new Set(accounts.map(a => String(a.accountId))).size !== accounts.length) throw new Error('Duplicate status account');
  }
  return { api: request.method, version: request.version, parameters: JSON.parse(request.param),
    apiSuccess: true, businessSuccess: true, accountCount: accounts.length,
    interpretation: 'observed-schema-status-enums-unverified', structure: shape(data), data: project(data) };
}
function mergeStaff(records) {
  const pages = records.filter(r => r.kind === 'list');
  const statuses = records.filter(r => r.kind === 'status');
  if (!pages.length || statuses.length !== 1 || records.some(r => r.error || !r.businessSuccess || !r.contextUnchanged ||
      r.shopUid !== TARGET.shopUid || r.mainUid !== TARGET.mainUid)) throw new Error('Incomplete or invalid staff run');
  const listed = new Map();
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    if (Number(page.parameters.page_no) !== i + 1 || page.data.result.length > 5 ||
        i < pages.length - 1 && page.data.result.length !== 5) throw new Error('Non-contiguous staff pages');
    for (const a of page.data.result) {
      const id = String(a.subUserId);
      if (String(a.userId) !== TARGET.mainUid || listed.has(id)) throw new Error('Duplicate or cross-shop staff');
      listed.set(id, a);
    }
  }
  if (pages.at(-1).data.result.length === 5) throw new Error('Staff pagination has not ended');
  const statusMap = new Map();
  for (const a of statuses[0].data.module) {
    const id = String(a.accountId);
    if (String(a.mainAccountId) !== TARGET.mainUid || statusMap.has(id)) throw new Error('Duplicate or cross-shop status');
    statusMap.set(id, a);
  }
  const accounts = [...new Set([...listed.keys(), ...statusMap.keys()])].map(id => {
    const l = listed.get(id), s = statusMap.get(id);
    const pcOnline = typeof s?.pcOnline === 'boolean' ? s.pcOnline : null;
    const mobileOnline = typeof s?.mobileOnline === 'boolean' ? s.mobileOnline : null;
    const online = pcOnline === true || mobileOnline === true ? true : pcOnline === false && mobileOnline === false ? false : null;
    const exclusionReasons = [];
    if (id === TARGET.mainUid) exclusionReasons.push('main-account');
    if (id === TARGET.shopUid) exclusionReasons.push('source-account');
    if (!l) exclusionReasons.push('not-in-subaccount-list');
    if (online !== true) exclusionReasons.push(online === false ? 'offline' : 'online-unknown');
    return { accountId: id, mainAccountId: TARGET.mainUid, nick: l?.subNick || s?.nick || null,
      role: id === TARGET.mainUid ? 'main' : 'sub', isSource: id === TARGET.shopUid, listed: !!l, hasStatus: !!s,
      departmentId: l?.departmentId == null ? null : String(l.departmentId),
      subStatus: l?.subStatus ?? null, dispatchStatus: l?.dispatchStatus ?? null,
      pcOnline, mobileOnline, online, suspend: s?.suspend ?? null,
      clientSuspendStatus: s?.clientSuspendStatus ?? null, pcClientOnlineStatus: s?.pcClientOnlineStatus ?? null,
      mobileClientOnlineStatus: s?.mobileClientOnlineStatus ?? null,
      onlineCandidate: !exclusionReasons.length, exclusionReasons, transferEligible: null };
  });
  const online = accounts.filter(a => a.online === true);
  return { shop: TARGET, collectedAt: statuses[0].at, contextUnchanged: true, paginationComplete: true,
    pageCount: pages.length, listedSubAccountCount: listed.size, statusAccountCount: statusMap.size,
    unionAccountCount: accounts.length, onlineAccountCount: online.length,
    onlineSubAccountCount: online.filter(a => a.role === 'sub').length,
    onlineCandidateIds: accounts.filter(a => a.onlineCandidate).map(a => a.accountId), accounts,
    limitations: ['Online is based on pcOnline/mobileOnline booleans; missing state is not offline.',
      'Online candidates exclude the main account, source account and status-only accounts.',
      'Online does not establish transfer eligibility; permissions, suspension and numeric enums remain unverified.',
      'Pages and status are sequential snapshots, not an atomic roster. Recheck online state before any later transfer.',
      'Screenshot counts may include the main account or use a different timestamp/scope.'] };
}
function diagnostic(raw, job, state) {
  const request = buildReadRequest(job, state);
  let value = parse(raw);
  for (let i = 0; !value?.api && i < 4; i++) {
    value = value?.result ?? value?.data;
    if (typeof value === 'string') value = parse(value);
  }
  if (value?.api?.toLowerCase() !== request.method || value.v !== '1.0') return null;
  return { schemaValidated: false, structure: shape(value.data), data: project(value.data) };
}
module.exports = { TARGET, buildReadRequest, sameContext, parse, summarize, mergeStaff, diagnostic };
