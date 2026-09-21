'use strict';
function installIdentityProbe(env, config, createProtocol) {
  if (env.__qnOrderIdentityProbeV1) return;
  const protocol = createProtocol();
  const pageId = 'identity-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  const owned = new Set(), used = new Set();
  let stopped = false, registered = false, pending = null, previous;
  const state = () => ({ shopUid: String(env._vs?.loginID?.targetId || ''),
    mainUid: String(env._vs?.loginID?.havMainId || ''), cid: env._vs?.conversationID?.ccode || '' });
  async function exchange(route, data) {
    const response = await env.fetch(config.base + route, { method: 'POST', signal: AbortSignal.timeout(5000),
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...data, token: config.token, pageId }) });
    if (!response.ok) throw Error('Identity receiver unavailable');
    return response.json();
  }
  function callback(sid, status, raw) {
    if (!owned.has(sid)) return previous && previous.apply(this, arguments);
    if (pending?.sid !== sid) return;
    const task = pending; pending = null; clearTimeout(task.timer);
    if (status !== 0 || typeof raw !== 'string' || raw.length > 1024 * 1024) task.reject(Error('Identity bridge response failed'));
    else task.resolve(raw);
  }
  async function execute(job) {
    const before = state(); protocol.assertContext(before);
    const request = protocol.request(job);
    if (used.has(job.stage) || pending || used.size >= 4) throw Error('Probe stage already used');
    if (job.stage !== ['summary', 'forward', 'reverse', 'trade'][used.size]) throw Error('Probe stage out of order');
    if (!registered) {
      previous = env.onInvokeNotify; callback.qnPreviousCallback = previous;
      env.onInvokeNotify = callback; registered = true;
    }
    let handler = env.onInvokeNotify;
    for (let depth = 0; handler !== callback && handler?.qnPreviousCallback && depth < 16; depth++) handler = handler.qnPreviousCallback;
    if (handler !== callback) throw Error('Identity callback chain changed');
    used.add(job.stage);
    const wb = env.workbench, sid = wb.createSequenceId(); owned.add(sid);
    const raw = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending = null; reject(Error('Identity callback timeout')); }, 12000);
      pending = { sid, resolve, reject, timer };
      try { wb.application.invoke(sid, 'invokeMTopChannelService', JSON.stringify(request), wb.jdy ? 'qn.pcCommon.0.0' : ''); }
      catch { clearTimeout(timer); pending = null; reject(Error('Identity bridge invocation failed')); }
    });
    const after = state();
    if (JSON.stringify(before) !== JSON.stringify(after)) throw Error('Context changed during identity query');
    return { raw, before, after };
  }
  async function tick() {
    try {
      const current = state();
      if (current.shopUid === protocol.shopUid && current.mainUid === protocol.mainUid && env.workbench?.application) {
        const response = await exchange('/poll', { state: current });
        if (response.stop) { stopped = true; return; }
        if (response.job) {
          let result;
          try { result = { ok: true, ...await execute(response.job) }; }
          catch (error) { result = { ok: false, error: error.message }; }
          await exchange('/result', { id: response.job.id, result });
        }
      }
    } catch { /* Optional probe failures must not interrupt the chat page. */ }
    finally { if (!stopped) setTimeout(tick, 500); }
  }
  env.__qnOrderIdentityProbeV1 = { stop() { stopped = true; } };
  tick();
}
module.exports = { installIdentityProbe };
