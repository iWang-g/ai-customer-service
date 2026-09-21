import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { transferClientScript } from '../electron/platform-workspace/douyin/transfer-client.js';
import { observerScript } from '../electron/platform-workspace/douyin/observer.js';

const cid = 'buyer:123::2:1:pigeon', self = '9007199254740993111', target = '9007199254740993222';
const operationId = 'a'.repeat(32);
async function harness() {
  const h = { shop:'123', staff:self, rows:[{staffId:self,staffName:'本人',status:1},{staffId:target,staffName:'目标',status:1}] };
  const context = vm.createContext({ window:{}, location:{hostname:'im.jinritemai.com'}, setTimeout, clearTimeout,
    AbortController, AbortSignal, TextDecoder, fetch: async (url) => {
      if (url.includes('getCanAssignStaffList') && h.wait) await h.wait;
      return Response.json(url.includes('currentuser') ? {code:0,data:{ShopId:h.shop,CustomerServiceInfo:{id:h.staff}}}
        : url.includes('getCanAssignStaffList') ? {code:0,data:h.rows} : {code:0,data:[]});
    } });
  h.eval = (s) => vm.runInContext(s,context);
  h.eval(`window.calls=0; window.__PLATFORM_VARIABLES_IN_BENCH__={extra:{im:{_message$:{next(){return 18}},sendText(){},
    pigeonIM:{transferConversation(...args){window.calls++;window.args=args; if(window.throws) throw new Error('unknown');return Promise.resolve(null)}}}}};`);
  h.run = (action='submit', extra={}) => h.eval(transferClientScript({action,token:'token',shopId:'123',staffId:self,targetId:target,cid,operationId,...extra}));
  h.event = (changes={}, extChanges={}) => h.eval(`window.__PLATFORM_VARIABLES_IN_BENCH__.extra.im._message$.next({
    securityConversationId:${JSON.stringify(cid)},createdAt:new Date(),serverId:'1234567890123456789',serverStatus:0,isOffline:false,pullSource:1,
    originSender:${JSON.stringify(self)},...${JSON.stringify(changes)},ext:{security_biz_conversation_id:${JSON.stringify(cid)},
    shop_id:'123',src_user_id:${JSON.stringify(self)},to_trans_uid:${JSON.stringify(target)},...${JSON.stringify(extChanges)}}})`);
  h.close = () => h.eval(observerScript({action:'stop',token:'collector'}));
  await h.eval(observerScript({action:'poll',token:'collector',mode:'collector'}));
  return h;
}

test('manual list excludes self, nonnumeric online, duplicate IDs and cross-shop staff', async () => {
  const h=await harness();
  h.rows.push({staffId:'3',status:'1'},{staffId:'4',status:0},{staffId:'5',status:1,shop_id:'456'},
    {staffId:'6',status:1},{staffId:'6',status:1});
  const r=await h.run('list');assert.deepEqual(Array.from(r.targets,t=>t.id),[target]);
  assert.equal(h.eval('window.calls'),0); await h.close();
});

test('three arguments and null SDK receipt require independent matching live transfer event', async () => {
  const h=await harness();
  h.event();
  assert.equal((await h.run()).status,'confirmation_pending');
  assert.equal((await h.run('poll')).status,'confirmation_pending');
  assert.equal(h.eval('window.args.length'),3); assert.equal(h.eval('window.args[0]'),'2');
  assert.equal(h.event(),18);
  const r=await h.run('poll');assert.equal(r.status,'transferred');assert.equal(r.evidence.sdk_resolved,true);
  assert.equal(r.evidence.target_staff_id,target);assert.equal(r.evidence.source_staff_id,self);
  assert.equal((await h.run()).status,'transferred');assert.equal(h.eval('window.calls'),1);
  await h.close();
});

test('wrong target, source, conversation, old/offline/snapshot messages never confirm', async () => {
  const h=await harness();await h.run();
  for (const [root,ext] of [[{}, {to_trans_uid:'other'}],[{originSender:'other'},{}],
    [{securityConversationId:'other'},{}],[{createdAt:new Date(Date.now()-60000).toISOString()},{}],
    [{isOffline:true},{}],[{pullSource:0},{}],[{serverStatus:1},{}],[{serverId:'0'},{}],[{}, {shop_id:'456'}]]) {
    h.event(root,ext); assert.equal((await h.run('poll')).status,'confirmation_pending');
  }
  h.event(); assert.equal((await h.run('poll')).status,'transferred'); await h.close();
});

test('recheck offline/self/changed identity before submission fails without SDK side effects', async () => {
  for (const change of [h=>{h.rows[1].status=0},h=>{h.staff='333'},h=>{h.shop='456'}]) {
    const h=await harness();await h.run('list');change(h);
    const r=await h.run();assert.equal(r.status,'failed');assert.equal(r.evidence.submitted,false);
    assert.equal(h.eval('window.calls'),0);await h.close();
  }
  const h=await harness();assert.equal((await h.run('submit',{targetId:self})).status,'failed');
  assert.equal(h.eval('window.calls'),0);await h.close();
});

test('concurrent duplicate submit and repeated polls invoke SDK only once', async () => {
  const h=await harness();let release;
  h.wait=new Promise(resolve=>{release=resolve});
  const first=h.run();
  assert.equal((await h.run()).status,'confirmation_pending');
  release();await first;await h.run('poll');assert.equal(h.eval('window.calls'),1);
  await h.close();
});

test('SDK throw and lost frame remain pending, missing message hook prevents invocation', async () => {
  const h=await harness();h.eval('window.throws=true');
  assert.equal((await h.run()).status,'confirmation_pending');h.event();
  assert.equal((await h.run('poll')).status,'confirmation_pending');assert.equal(h.eval('window.calls'),1);
  await h.close();
  const missing=await harness();await missing.close();
  assert.equal((await missing.run()).status,'failed');assert.equal(missing.eval('window.calls'),0);
  const changed=await harness();await changed.run();
  changed.eval('window.__PLATFORM_VARIABLES_IN_BENCH__.extra.im={pigeonIM:{transferConversation(){throw new Error("must not repeat")}}}');
  assert.equal((await changed.run('poll')).status,'confirmation_pending');assert.equal(changed.eval('window.calls'),1);
  await changed.close();
});
