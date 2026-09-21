'use strict';

// Shared by the page and desktop; no native method names are accepted from callers.
function createTransferProtocol() {
  const LIST = 'mtop.taobao.mmp.subuser.page.get';
  const STATUS = 'mtop.taobao.qianniu.cloudkefu.accountstatus.getbyid';
  const FORWARD = 'mtop.taobao.qianniu.cloudkefu.forward';
  const id = v => typeof v === 'string' && /^\d{1,30}$/.test(v);
  const nick = v => typeof v === 'string' && v.length > 0 && v.length <= 128 && !/[\x00-\x1f|]/.test(v);
  function identity(s, cid) {
    const m = /^(\d+)\.1-(\d+)\.1#11001@cntaobao$/.exec(cid || '');
    if (!id(s?.shopUid) || !id(s.mainUid) || !nick(s.nick) || !m || ![m[1], m[2]].includes(s.mainUid))
      throw new Error('千牛账号与会话不匹配');
    return m[1] === s.mainUid ? m[2] : m[1];
  }
  function unwrap(raw, api, version = '1.0') {
    function parse(v) {
      if (typeof v !== 'string') return v;
      if (v.length > 2 * 1024 * 1024) throw new Error('千牛回包过大');
      const jsonp = /^mtopjsonp\d+\(([\s\S]*)\);?$/.exec(v.trim());
      return JSON.parse(jsonp ? jsonp[1] : v);
    }
    let v = parse(raw);
    for (let n = 0; n < 5 && v && !v.api; n++) v = parse(v.result ?? v.data);
    if (v?.api?.toLowerCase() !== api || v.v !== version || !Array.isArray(v.ret) || !v.ret.length ||
        !v.ret.every(x => typeof x === 'string' && x.startsWith('SUCCESS::')) || !v.data)
      throw new Error('千牛接口未返回有效业务回执');
    return v.data;
  }
  function business(d) {
    return d?.errorCode === 0 && d.errorMap && typeof d.errorMap === 'object' && !Array.isArray(d.errorMap) && !Object.keys(d.errorMap).length;
  }
  function numberId(v) {
    if (typeof v === 'number' && !Number.isSafeInteger(v)) throw new Error('千牛账号数字精度丢失');
    if (!id(String(v))) throw new Error('千牛账号 ID 无效');
    return String(v);
  }
  async function collect(query, s, diagnostics = []) {
    const roster = new Map(); let complete = false;
    for (let page = 1; page <= 20; page++) {
      const d = unwrap(await query({ method: LIST, version: '1.0', httpMethod: 'get',
        param: JSON.stringify({ nick: s.nick, page_no: String(page), page_size: '5' }) }), LIST);
      if (d.error !== false || !Array.isArray(d.result) || d.result.length > 5) throw new Error('千牛客服分页读取失败');
      for (const a of d.result) {
        const uid = numberId(a.subUserId);
        if (numberId(a.userId) !== s.mainUid || !nick(a.subNick) || !a.subNick.includes(':') || roster.has(uid))
          throw new Error('千牛客服名单归属或分页重复');
        roster.set(uid, a);
      }
      if (d.result.length < 5) { complete = true; break; }
    }
    if (!complete) throw new Error('千牛客服名单未读取完整');
    const d = unwrap(await query({ method: STATUS, version: '1.0', httpMethod: 'get',
      param: JSON.stringify({ main_account_id: s.mainUid }) }), STATUS);
    if (!business(d) || !Array.isArray(d.module) || d.module.length > 5000) throw new Error('千牛在线状态读取失败');
    const seen = new Set(), targets = [];
    for (const a of d.module) {
      const uid = numberId(a.accountId);
      if (numberId(a.mainAccountId) !== s.mainUid || seen.has(uid) || !nick(a.nick)) throw new Error('千牛在线名单归属无效');
      seen.add(uid);
      const member = roster.get(uid);
      // Status nick can be a short name; only compare after matching both account IDs.
      if (member && member.subNick !== a.nick && member.subNick.slice(member.subNick.indexOf(':') + 1) !== a.nick) {
        diagnostics.push({ code: 'staff_nick_mismatch', uid, mainUid: s.mainUid,
          rosterNick: member.subNick, statusNick: a.nick,
          pcOnline: a.pcOnline === true, mobileOnline: a.mobileOnline === true,
          suspended: a.suspend === true });
        continue;
      }
      if (member && uid !== s.shopUid && uid !== s.mainUid && a.suspend === false &&
          (a.pcOnline === true || a.mobileOnline === true)) {
        targets.push({ uid, nick: member.subNick, contactId: 'cntaobao' + member.subNick,
          pcOnline: a.pcOnline === true, mobileOnline: a.mobileOnline === true });
      }
    }
    return targets;
  }
  return { LIST, STATUS, FORWARD, identity, unwrap, business, collect, id, nick };
}
module.exports = { createTransferProtocol };
