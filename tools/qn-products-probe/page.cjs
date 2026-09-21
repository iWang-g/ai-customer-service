'use strict';
function installProductsProbe(env, config) {
  const detail = config.kind === 'detail';
  const marker = detail ? '__qnProductDetailsProbeV1' : '__qnProductsProbeV1';
  if (env[marker]) return;
  const pageId = 'products-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  const owned = new Set();
  let stopped = false, pending = null, previous, registered = false;
  function state() {
    const s = env._vs || {}, login = s.loginID || {};
    return { shopUid: String(login.targetId || ''), mainUid: String(login.havMainId || ''), cid: s.conversationID?.ccode || '' };
  }
  async function exchange(route, body) {
    const response = await env.fetch(config.base + route, { method: 'POST',
      signal: AbortSignal.timeout(5000), headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, token: config.token, pageId }) });
    if (!response.ok) throw new Error('Probe receiver unavailable');
    return response.json();
  }
  function callback(sid, status, raw) {
    if (!owned.has(sid)) return previous && previous.apply(this, arguments);
    if (!pending || pending.sid !== sid) return;
    const task = pending; pending = null; clearTimeout(task.timer);
    if (status !== 0 || typeof raw !== 'string' || raw.length > 2 * 1024 * 1024) task.reject(new Error('Product callback failed'));
    else task.resolve(raw);
  }
  async function execute(job) {
    const before = state();
    if (before.shopUid !== config.shopUid || before.mainUid !== config.mainUid ||
        job.shopUid !== config.shopUid || job.mainUid !== config.mainUid) throw new Error('Wrong shop');
    if (job.cid !== config.cid) throw new Error('Wrong test conversation');
    if (detail) {
      if (!['730328029364', '835010203895', '730114688994'].includes(job.productId) ||
          typeof job.encryptId !== 'string' || !/^[a-zA-Z0-9_-]{8,256}$/.test(job.encryptId) || job.isNewCustomer !== true ||
          Object.keys(job).sort().join(',') !== 'cid,encryptId,id,isNewCustomer,mainUid,productId,shopUid') throw new Error('Invalid detail job');
    } else if (![1, 2].includes(job.pageNo) || job.pageSize !== 5 ||
        Object.keys(job).sort().join(',') !== 'cid,id,mainUid,pageNo,pageSize,shopUid') throw new Error('Invalid read-only job');
    const wb = env.workbench;
    if (!registered) { previous = env.onInvokeNotify; callback.qnPreviousCallback = previous; env.onInvokeNotify = callback; registered = true; }
    let handler = env.onInvokeNotify;
    for (let depth = 0; handler !== callback && handler?.qnPreviousCallback && depth < 8; depth++) handler = handler.qnPreviousCallback;
    if (pending || handler !== callback || owned.size >= 10) throw new Error('Probe callback unavailable');
    const sid = wb.createSequenceId(); owned.add(sid);
    const raw = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending = null; reject(new Error('Product callback timeout')); }, 12000);
      pending = { sid, resolve, reject, timer };
      try {
        wb.application.invoke(sid, 'invokeMTopChannelService', JSON.stringify({
          method: detail ? 'mtop.taobao.qianniu.cs.item.detail.query' : 'mtop.taobao.qianniu.cs.item.onsale.query', version: '1.0', httpMethod: 'get',
          param: JSON.stringify(detail ? { itemId: job.productId, encryptId: job.encryptId, isNewCustomer: true, _message_cid: config.cid }
            : { pageNo: job.pageNo, pageSize: 5, _message_cid: config.cid }),
        }), wb.jdy ? 'qn.pcCommon.0.0' : '');
      } catch { clearTimeout(timer); pending = null; reject(new Error('Product bridge failed')); }
    });
    const after = state();
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Context changed during query');
    return { raw, before, after };
  }
  async function tick() {
    try {
      const current = state();
      if (current.shopUid === config.shopUid && current.mainUid === config.mainUid && env.workbench?.application) {
        const response = await exchange('/poll', { state: current });
        if (response.stop) { stopped = true; return; }
        if (response.job) {
          let result;
          try { result = { ok: true, ...await execute(response.job) }; }
          catch (error) { result = { ok: false, error: error.message }; }
          await exchange('/result', { id: response.job.id, result });
        }
      }
    } catch { /* A stopped receiver must not interrupt Qianniu. */ }
    finally { if (!stopped) setTimeout(tick, 1000); }
  }
  env[marker] = { stop() { stopped = true; } };
  tick();
}
module.exports = { installProductsProbe };
