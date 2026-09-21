'use strict';

function start(env, inspect, snapshot, config) {
  if (env.__qnMediaProbe) return;
  let stopped = false, timer;
  const completed = new Set();
  async function exchange(route, body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await env.fetch(config.base + route, { method: 'POST',
        signal: controller.signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ token: config.token }, body)) });
      if (!response.ok) throw new Error('media probe HTTP ' + response.status);
      return await response.json();
    } finally { clearTimeout(timeout); }
  }
  async function tick() {
    try {
      const state = snapshot(env);
      if (state.shopUid === '2222303856223' && state.mainUid === '2216058631944') {
        const response = await exchange('/poll', { pageId: config.pageId, state, probeVersion: 2,
          ready: !!(env.imsdk && typeof env.imsdk.invoke === 'function') });
        if (response.job && !completed.has(response.job.id) && !stopped) {
          completed.add(response.job.id);
          let result;
          try { result = { ok: true, value: await inspect(response.job) }; }
          catch (error) { result = { ok: false, error: String(error.message || error) }; }
          // Retrying delivery does not repeat the native history call.
          for (let attempt = 0; attempt < 3; attempt++) {
            try { await exchange('/result', { id: response.job.id, pageId: config.pageId, result }); break; }
            catch (error) { if (attempt === 2) throw error; }
          }
        }
      }
    } catch (_) { /* A disconnected research receiver must not affect the chat page. */ }
    finally { if (!stopped) timer = setTimeout(tick, 2000); }
  }
  config.pageId = 'media-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  env.__qnMediaProbe = { stop() { stopped = true; clearTimeout(timer); } };
  tick();
}

module.exports = { start };
