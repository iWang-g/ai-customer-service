'use strict';
function installTransferPage(env, config, createProtocol) {
  if (env.__qianniuTransferV1) return;
  const p = createProtocol(), pageId = 'transfer-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  const owned = new Set(), executed = new Set();
  let pending, previous, registered = false, stopped = false;
  function state() {
    const l = env._vs?.loginID || {};
    return { shopUid: String(l.targetId || ''), mainUid: String(l.havMainId || ''), nick: String(l.nick || '') };
  }
  function same(s) { return JSON.stringify(state()) === JSON.stringify(s); }
  function callback(sid, status, raw) {
    if (!owned.has(sid)) return previous && previous.apply(this, arguments);
    if (pending?.sid !== sid) return;
    const t = pending; pending = null; clearTimeout(t.timer);
    if (status === 0 && typeof raw === 'string') t.resolve(raw); else t.reject(new Error('千牛客服读取回调失败'));
  }
  async function exchange(route, body) {
    const response = await env.fetch(config.base + route, { method: 'POST', signal: AbortSignal.timeout(5000),
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, token: config.token, pageId, version: 1 }) });
    if (!response.ok) throw new Error('千牛转接通道不可用');
    return response.json();
  }
  function query(request, s) {
    if (!same(s) || ![p.LIST, p.STATUS].includes(request.method)) throw new Error('千牛客服查询上下文变化');
    const wb = env.workbench;
    if (!registered) { previous = env.onInvokeNotify; callback.qnPreviousCallback = previous; env.onInvokeNotify = callback; registered = true; }
    if (pending || owned.size >= 4096) throw new Error('千牛客服通道繁忙或需要重启');
    const sid = wb.createSequenceId(); owned.add(sid);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending = null; reject(new Error('千牛客服读取超时')); }, 12000);
      pending = { sid, timer, resolve, reject };
      try { wb.application.invoke(sid, 'invokeMTopChannelService', JSON.stringify(request), wb.jdy ? 'qn.pcCommon.0.0' : ''); }
      catch (error) { clearTimeout(timer); pending = null; reject(error); }
    });
  }
  async function buyerNick(cid, uid, s) {
    let response = await env.imsdk.invoke('im.singlemsg.GetLocalHisMsg', {
      cid: { ccode: cid, ctype: 0, targetType: '3', targetId: uid, bizeType: '11001' }, gohistory: 1, count: 20,
    }, 15000);
    if (typeof response === 'string') response = JSON.parse(response);
    if (response?.code != null && Number(response.code) !== 0) throw new Error('买家历史读取失败');
    let body = response?.result ?? response;
    if (typeof body === 'string') body = JSON.parse(body);
    const rows = Array.isArray(body) ? body : body?.msgs;
    if (!Array.isArray(rows)) throw new Error('无法验证买家昵称');
    const names = new Set();
    for (const row of rows) {
      const actual = typeof row.cid === 'string' ? row.cid : row.cid?.ccode;
      if (actual && actual !== cid) throw new Error('买家历史会话不匹配');
      for (const a of [row.fromid || row.fromId, row.toid || row.toId])
        if (String(a?.targetId) === uid && p.nick(a.nick)) names.add(a.nick.replace(/^cntaobao/, ''));
    }
    if (!same(s) || names.size !== 1) throw new Error('买家昵称无唯一可信匹配，未执行转接');
    return [...names][0];
  }
  async function execute(job) {
    let invoked = false;
    const diagnostics = [];
    const before = state();
    try {
      if (!['list', 'transfer'].includes(job.kind) || job.shopUid !== before.shopUid ||
          Date.now() > job.expiresAt || executed.has(job.id) || executed.size >= 4096) throw new Error('转接命令过期或重复');
      executed.add(job.id);
      const buyerUid = p.identity(before, job.cid);
      if (job.buyerUid !== buyerUid) throw new Error('买家 UID 不匹配');
      const verifiedNick = await buyerNick(job.cid, buyerUid, before);
      if (verifiedNick !== job.buyerNick) throw new Error('平台买家昵称与项目会话不一致');
      const targets = await p.collect(request => query(request, before), before, diagnostics);
      if (!same(before)) throw new Error('客服查询期间店铺变化');
      if (job.kind === 'list') return { ok: true, invoked, before, after: state(), targets, diagnostics };
      const target = targets.find(t => t.uid === job.targetUid && t.nick === job.targetNick);
      if (!target || typeof job.reason !== 'string' || !job.reason.trim() || job.reason.length > 200 ||
          /[\x00-\x1f]/.test(job.reason) || Date.now() > job.expiresAt) throw new Error('目标客服已离线、暂停或身份变化');
      const param = { contactID: 'cntaobao' + verifiedNick, targetID: target.contactId, contactSecurityUID: '',
        contactBizDomain: 'taobao', reason: job.reason, options: '', tagName: '' };
      // Only this call mutates the platform; no retries after crossing this boundary.
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('转接回调超时，结果待确认')), 15000);
        const done = (ok, v) => { clearTimeout(timer); ok ? resolve(v) : reject(new Error('千牛转接回调失败，需核对业务结果')); };
        try {
          if (env.QNAbilityCenter?.ability?.invoke) {
            invoked = true;
            env.QNAbilityCenter.ability.invoke({ cmd: 'transferContact', param, success: v => done(true, v), error: v => done(false, v) });
          } else if (env.imsdk?.invoke) {
            invoked = true;
            Promise.resolve(env.imsdk.invoke('application.transferContact', param, 15000)).then(v => done(true, v), v => done(false, v));
          } else { clearTimeout(timer); reject(new Error('千牛转接接口未就绪')); }
        } catch (error) { clearTimeout(timer); reject(error); }
      });
      return { ok: true, invoked, before, after: state(), target, diagnostics };
    } catch (error) { return { ok: false, invoked, before, after: state(), error: error.message, diagnostics }; }
  }
  async function tick() {
    try {
      if (p.id(state().shopUid) && env.workbench?.application && env.imsdk?.invoke) {
        const { job } = await exchange('/poll', { state: state() });
        if (job) {
          const result = await execute(job);
          // Re-upload a result, never re-execute an operation after network failure.
          for (let attempt = 0; attempt < 3; attempt++) {
            try { await exchange('/result', { id: job.id, result }); break; } catch { /* Polling resumes without replay. */ }
          }
        }
      }
    } catch { /* Receiver downtime must not affect the client. */ }
    finally { if (!stopped) setTimeout(tick, 500); }
  }
  env.__qianniuTransferV1 = { stop() { stopped = true; } };
  tick();
}
module.exports = { installTransferPage };
