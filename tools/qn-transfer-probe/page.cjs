'use strict';
function installTransferProbe(env, config) {
  if (env.__qnTransferProbeOnce) return;
  const pageId = 'transfer-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  let stopped = false, timer, previous;
  const state = () => { const s = env._vs || {}, l = s.loginID || {}; return {
    shopUid: String(l.targetId || ''), mainUid: String(l.havMainId || ''), nick: String(l.nick || ''),
    cid: String(s.conversationID?.ccode || '') }; };
  function sameSource(s) { return s.shopUid === config.shopUid && s.mainUid === config.mainUid && s.nick === config.sourceNick; }
  function callback(sid, status, raw) {
    if (sid !== callback.sid) return previous && previous.apply(this, arguments);
    callback.resolve(status === 0 && typeof raw === 'string' ? { ok: true, raw } : { ok: false, error: 'bridge callback failed' });
  }
  function invokeRead(request) { return new Promise(resolve => {
    const wb = env.workbench, sid = wb.createSequenceId(); callback.sid = sid; callback.resolve = resolve;
    const old = env.onInvokeNotify; previous = old; callback.qnPreviousCallback = old; env.onInvokeNotify = callback;
    const timeout = setTimeout(() => resolve({ ok: false, error: 'read timeout' }), 12000);
    const done = resolve; callback.resolve = value => { clearTimeout(timeout); done(value); };
    try { wb.application.invoke(sid, 'invokeMTopChannelService', JSON.stringify(request), wb.jdy ? 'qn.pcCommon.0.0' : ''); }
    catch (e) { clearTimeout(timeout); resolve({ ok: false, error: String(e.message || e) }); }
  }); }
  async function post(body) { await env.fetch(config.base + '/result', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({token:config.token,pageId,...body}) }); }
  async function tick() { try {
    const s = state(), p = await env.fetch(config.base + '/poll', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({token:config.token,pageId,state:s}) });
    const job = await p.json(); if (job.stop) { stopped = true; return; }
    if (!job.job || !sameSource(s)) return;
    let result;
    if (job.job.kind === 'read') result = await invokeRead(job.job.request);
    else if (job.job.kind === 'transfer') {
      const before = state();
      try { if (!sameSource(before)) throw new Error('source changed');
        const ability = env.QNAbilityCenter?.ability;
        if (ability && typeof ability.invoke === 'function') {
          ability.invoke({cmd:'transferContact', param:config.param,
            success: value => post({kind:'transfer', result:{invoked:true,ok:true,before,after:state(),value}}),
            error: value => post({kind:'transfer', result:{invoked:true,ok:false,before,after:state(),error:String(value||'rejected')}})});
        } else {
          const invoke = env.imsdk?.invoke;
          if (typeof invoke !== 'function') throw new Error('No supported transfer bridge');
          const pending = invoke.call(env.imsdk, 'application.transferContact', config.param, 15000);
          if (!pending || typeof pending.then !== 'function') throw new Error('application transfer did not return a Promise');
          pending.then(value => post({kind:'transfer', result:{invoked:true,ok:true,before,after:state(),value}}))
            .catch(value => post({kind:'transfer', result:{invoked:true,ok:false,before,after:state(),error:String(value||'rejected')}}));
        }
        return;
      } catch (e) { result={invoked:false,ok:false,before,after:state(),error:String(e.message||e)}; }
    }
    await post({kind:job.job.kind,result});
  } catch (_) {} finally { if (!stopped) timer=setTimeout(tick,500); } }
  env.__qnTransferProbeOnce={stop:()=>{stopped=true;clearTimeout(timer);}}; tick();
}
module.exports={installTransferProbe};
