'use strict';
function installProductsPage(env, config, createOrderIdentityProtocol) {
  if (env.__qianniuProductsV3) return;
  if (env.__qianniuProductsV2?.stop) env.__qianniuProductsV2.stop();
  if (env.__qianniuProductsV1?.stop) env.__qianniuProductsV1.stop();
  const pageId = 'products-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  const identityProtocol = createOrderIdentityProtocol ? createOrderIdentityProtocol() : null;
  const owned = new Set();
  let stopped = false, pending = null, previous, registered = false;
  function validCid(cid, mainUid) {
    const match = /^(\d+)\.1-(\d+)\.1#11001@cntaobao$/.exec(cid || '');
    return match && [match[1], match[2]].includes(mainUid);
  }
  function state() {
    const s = env._vs || {}, login = s.loginID || {};
    return { shopUid: String(login.targetId || ''), mainUid: String(login.havMainId || ''), cid: s.conversationID?.ccode || '' };
  }
  async function exchange(route, body) {
    const response = await env.fetch(config.base + route, { method: 'POST',
      signal: AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/json' },
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
    if (job.shopUid !== before.shopUid || job.mainUid !== before.mainUid) throw new Error('Wrong shop');
    const profile = job.kind === 'profile';
    if (profile) {
      if (Object.keys(job).sort().join(',') !== 'id,kind,mainUid,nick,shopUid' ||
          !job.nick || job.nick !== env._vs?.loginID?.nick) throw new Error('Invalid shop profile job');
    } else if (!validCid(job.cid, before.mainUid)) throw new Error('Invalid conversation');
    const detail = job.kind === 'detail';
    const ownership = job.kind === 'ownership';
    const identity = job.kind === 'identity';
    if (identity) {
      if (!identityProtocol || typeof job.buyerUid !== 'string' || typeof job.key !== 'string' ||
          Object.keys(job).sort().join(',') !== 'buyerUid,cid,id,key,kind,mainUid,shopUid') throw new Error('Invalid identity job');
      identityProtocol.validateBase(job);
    } else if (detail) {
      if (typeof job.productId !== 'string' || !/^\d{1,30}$/.test(job.productId) || typeof job.encryptId !== 'string' ||
          !/^[a-zA-Z0-9_-]{8,256}$/.test(job.encryptId) || typeof job.isNewCustomer !== 'boolean' ||
          Object.keys(job).sort().join(',') !== 'cid,encryptId,id,isNewCustomer,kind,mainUid,productId,shopUid') throw new Error('Invalid detail job');
    } else if (ownership) {
      const numericId = Number(job.productId);
      if (typeof job.productId !== 'string' || !/^\d{1,30}$/.test(job.productId)
          || !Number.isSafeInteger(numericId) || numericId <= 0
          || Object.keys(job).sort().join(',') !== 'cid,id,kind,mainUid,productId,shopUid')
        throw new Error('Invalid ownership job');
    } else if (!profile && (!Number.isInteger(job.pageNo) || job.pageNo < 1 || job.pageNo > 1000 || job.pageSize !== 5 ||
        Object.keys(job).sort().join(',') !== 'cid,id,mainUid,pageNo,pageSize,shopUid')) throw new Error('Invalid read-only job');
    const wb = env.workbench;
    if (!registered) { previous = env.onInvokeNotify; callback.qnPreviousCallback = previous; env.onInvokeNotify = callback; registered = true; }
    if (pending || owned.size >= 4096) throw new Error('Probe callback unavailable');
    const sid = wb.createSequenceId(); owned.add(sid);
    const raw = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending = null; reject(new Error('Product callback timeout')); }, 12000);
      pending = { sid, resolve, reject, timer };
      try {
        wb.application.invoke(sid, 'invokeMTopChannelService', JSON.stringify({
          method: profile ? 'mtop.taobao.jdy.resource.shop.info.get' : identity ? identityProtocol.api
            : ownership ? 'mtop.taobao.airisland.material.item.query'
              : (detail ? 'mtop.taobao.qianniu.cs.item.detail.query' : 'mtop.taobao.qianniu.cs.item.onsale.query'),
          version: '1.0', httpMethod: identity || profile ? 'post' : 'get',
          param: JSON.stringify(profile ? {} : identity ? identityProtocol.params(job, job.key)
            : ownership ? { query: JSON.stringify({ itemIds: [Number(job.productId)] }) }
              : (detail ? { itemId: job.productId, encryptId: job.encryptId, isNewCustomer: job.isNewCustomer, _message_cid: job.cid }
            : { pageNo: job.pageNo, pageSize: 5, _message_cid: job.cid })),
        }), wb.jdy ? 'qn.pcCommon.0.0' : '');
      } catch { clearTimeout(timer); pending = null; reject(new Error('Product bridge failed')); }
    });
    const after = state();
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Context changed during query');
    if (profile && job.nick !== env._vs?.loginID?.nick) throw new Error('Operator changed during query');
    return { raw, before, after };
  }
  async function tick() {
    let retryDelay = 0;
    try {
      const current = state();
      if (/^\d+$/.test(current.shopUid) && /^\d+$/.test(current.mainUid) && env.workbench?.application) {
        const response = await exchange('/poll', { state: current, shopProfileVersion: 1, deliveryVersion: 1 });
        if (response.stop) { stopped = true; return; }
        if (response.job) {
          let result;
          try { result = { ok: true, ...await execute(response.job) }; }
          catch (error) { result = { ok: false, error: error.message }; }
          await exchange('/result', { id: response.job.id, result });
        }
      }
    } catch { retryDelay = 1000; /* A stopped receiver must not interrupt Qianniu. */ }
    finally { if (!stopped) setTimeout(tick, retryDelay); }
  }
  env.__qianniuProductsV3 = { stop() { stopped = true; } };
  tick();
}
module.exports = { installProductsPage };
