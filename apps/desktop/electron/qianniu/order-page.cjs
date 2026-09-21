'use strict';
function installOrderPage(env, config, createOrderIdentityProtocol) {
  if (env.__qianniuOrdersV1) return;
  const identityProtocol = createOrderIdentityProtocol();
  const allowed = {
    'mtop.taobao.qianniu.airisland.reception.detail.get': '2.0',
    'mtop.taobao.qianniu.cs.trade.query': '1.0',
    [identityProtocol.api]: '1.0',
  };
  const pageId = 'orders-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  let stopped = false, previous, registered = false;
  const pending = new Map(), owned = new Set();
  function state() {
    const s = env._vs || {}, login = s.loginID || {};
    return { shopUid: String(login.targetId || ''), mainUid: String(login.havMainId || ''), cid: s.conversationID?.ccode || '' };
  }
  async function exchange(route, body) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await env.fetch(config.base + route, { method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, token: config.token, pageId }) });
      if (!response.ok) throw new Error('order receiver unavailable');
      return await response.json();
    } finally { clearTimeout(timer); }
  }
  function callback(sid, status, raw) {
    if (!owned.has(sid)) return previous && previous.apply(this, arguments);
    const task = pending.get(sid);
    if (!task) return;
    pending.delete(sid); clearTimeout(task.timer);
    if (status !== 0 || typeof raw !== 'string' || raw.length > 1024 * 1024) task.reject(new Error('订单响应失败或超过读取上限'));
    else task.resolve(raw);
  }
  async function execute(job) {
    const before = state();
    if (job.shopUid !== before.shopUid || job.mainUid !== before.mainUid) throw new Error('订单查询账号变化');
    if (job.contextCid !== before.cid) throw new Error('订单读取期间千牛上下文发生变化');
    identityProtocol.validateBase(job);
    if (!allowed[job.method] || allowed[job.method] !== job.version) throw new Error('订单查询接口不允许');
    const params = job.params || {};
    if (job.method === identityProtocol.api) {
      identityProtocol.validateParams(job, params);
    } else if (job.version === '2.0') {
      const buyer = JSON.parse(params.buyerInfo || 'null');
      if (Object.keys(params).sort().join(',') !== 'buyerInfo,sellerNick' || !Array.isArray(buyer) || buyer.length !== 1 ||
          buyer[0].decryptId !== job.buyerUid || buyer[0].bizDomain !== 'taobao') throw new Error('订单摘要参数无效');
    } else if (Object.keys(params).sort().join(',') !== '_message_cid,securityBuyerUid' || params._message_cid !== job.cid ||
      typeof params.securityBuyerUid !== 'string' || !/^[a-zA-Z0-9_-]{8,256}$/.test(params.securityBuyerUid)) throw new Error('订单详情参数无效');
    const wb = env.workbench;
    if (!registered) { previous = env.onInvokeNotify; callback.qnPreviousCallback = previous; env.onInvokeNotify = callback; registered = true; }
    let handler = env.onInvokeNotify;
    // Product callbacks forward unrelated sequences through this explicit chain.
    for (let depth = 0; handler !== callback && handler?.qnPreviousCallback && depth < 8; depth++) handler = handler.qnPreviousCallback;
    if (handler !== callback) throw new Error('订单回调通道变化');
    const sid = wb.createSequenceId(); owned.add(sid);
    const raw = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(sid); reject(new Error('千牛订单查询超时')); }, 12000);
      pending.set(sid, { resolve, reject, timer });
      try { wb.application.invoke(sid, 'invokeMTopChannelService', JSON.stringify({ method: job.method, version: job.version,
        httpMethod: job.method === identityProtocol.api ? 'post' : 'get', param: JSON.stringify(params) }), wb.jdy ? 'qn.pcCommon.0.0' : ''); }
      catch { pending.delete(sid); clearTimeout(timer); reject(new Error('千牛订单 bridge 调用失败')); }
    });
    const after = state();
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('订单读取期间千牛上下文发生变化');
    return { raw, before, after };
  }
  async function tick() {
    try {
      const s = state();
      if (s.shopUid && env.workbench?.application && env.workbench?.createSequenceId) {
        const response = await exchange('/poll', { state: s, identityVersion: 1 });
        if (response.job) {
          let result;
          try { result = { ok: true, ...await execute(response.job) }; }
          catch (error) { result = { ok: false, error: error.message }; }
          await exchange('/result', { id: response.job.id, result });
        }
      }
    } catch { /* Orders are optional; receiver failures must not affect chat. */ }
    finally { if (!stopped) setTimeout(tick, 500); }
  }
  env.__qianniuOrdersV1 = { stop() { stopped = true; } };
  tick();
}
module.exports = { installOrderPage };
