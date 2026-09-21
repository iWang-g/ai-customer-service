'use strict';
function installStaffProbe(env, config, buildReadRequest) {
  const marker = '__qnStaffReadProbeV2';
  if (env[marker]) return;
  const pageId = 'staff-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  const owned = new Set();
  let stopped = false, pending = null, previous, registered = false, delivery = null, timer = null;
  const now = () => Date.now();
  const deadline = now() + 30 * 60 * 1000;
  function state() {
    const s = env._vs || {}, login = s.loginID || {};
    return { shopUid: String(login.targetId || ''), mainUid: String(login.havMainId || ''),
      nick: String(login.nick || ''), cid: String(s.conversationID?.ccode || '') };
  }
  async function exchange(route, body) {
    const response = await env.fetch(config.base + route, { method: 'POST', signal: AbortSignal.timeout(5000),
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, token: config.token, pageId }) });
    if (!response.ok) throw new Error('Staff receiver unavailable');
    return response.json();
  }
  function callback(sid, status, raw) {
    if (!owned.has(sid)) return previous && previous.apply(this, arguments);
    if (!pending || pending.sid !== sid) return;
    const task = pending; pending = null; clearTimeout(task.timer);
    if (status !== 0 || typeof raw !== 'string' || raw.length > 2 * 1024 * 1024) task.reject(new Error('Staff callback failed'));
    else task.resolve(raw);
  }
  function attached() {
    let fn = env.onInvokeNotify;
    for (let i = 0; fn !== callback && fn?.qnPreviousCallback && i < 16; i++) fn = fn.qnPreviousCallback;
    return fn === callback;
  }
  async function execute(job) {
    const before = state(), request = buildReadRequest(job, before), wb = env.workbench;
    if (!registered) { previous = env.onInvokeNotify; callback.qnPreviousCallback = previous; env.onInvokeNotify = callback; registered = true; }
    if (pending || !attached() || owned.size >= 21) throw new Error('Staff callback unavailable');
    const sid = wb.createSequenceId();
    if (owned.has(sid)) throw new Error('Duplicate callback sequence');
    owned.add(sid);
    const raw = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { pending = null; reject(new Error('Staff query timed out')); }, 12000);
      pending = { sid, resolve, reject, timer: timeout };
      try { wb.application.invoke(sid, 'invokeMTopChannelService', JSON.stringify(request), wb.jdy ? 'qn.pcCommon.0.0' : ''); }
      catch { clearTimeout(timeout); pending = null; reject(new Error('Staff bridge failed')); }
    });
    const after = state();
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Account or conversation changed');
    return { raw, before, after };
  }
  function stop() {
    stopped = true; clearTimeout(timer);
    // Keep the small owned-SID filter for late callbacks until the page is unloaded.
  }
  async function tick() {
    try {
      if (stopped || now() > deadline) return stop();
      if (delivery) {
        await exchange('/result', delivery.body); delivery = null;
      }
      const current = state();
      if (current.shopUid !== config.shopUid || current.mainUid !== config.mainUid || current.nick !== config.shopNick || !env.workbench?.application) return;
      const response = await exchange('/poll', { state: current, protocolVersion: 2 });
      if (response.stop) return stop();
      if (response.job) {
        let result;
        try { result = { ok: true, ...await execute(response.job) }; }
        catch (error) { result = { ok: false, error: error.message }; }
        delivery = { body: { id: response.job.id, result } };
        await exchange('/result', delivery.body); delivery = null;
      }
    } catch { /* Retry only result delivery/polling; never repeat a native query. */ }
    finally { if (!stopped) timer = setTimeout(tick, 1000); }
  }
  env[marker] = { stop };
  tick();
}
module.exports = { installStaffProbe };
