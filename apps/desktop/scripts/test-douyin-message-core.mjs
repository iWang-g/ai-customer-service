import assert from 'node:assert/strict';
import { douyinMessageCore } from '../electron/platform-workspace/douyin/message-core.js';
import { mapDouyinMessage, isDouyinLiveReply } from '../electron/platform-workspace/douyin/mapper.js';

const now = '2026-09-19T09:00:00Z';
const raw = { type: 1000, serverId: '123', securityConversationId: 'buyer:shop::2:1:pigeon',
  createdAt: now, content: '[订单卡片]', ext: { type: 'template_card', 's:sender_biz_role': 'Buyer',
    static_data: JSON.stringify({ order_id: '13800138000', title: '测试订单',
      nested: { status: 7, description: '请帮忙看看' }, buttons: [{ text: '申请退款', action: 'private-action' }],
      receiver_address: 'private-address', token: 'private-token', image_url: 'https://private.example/img',
      arbitrary: { password: 'private-password' } }) } };
const mapped = mapDouyinMessage(raw, 'shop');
assert.equal(mapped.messageType, 'unknown');
assert.equal(isDouyinLiveReply(mapped, now, now), true);
const encoded = JSON.stringify(mapped.structuredPayload.message_core);
assert.ok(encoded.includes('13800138000'), 'IDs are strings, not phone numbers');
assert.ok(encoded.includes('测试订单'));
assert.ok(!encoded.includes('private-'));
assert.ok(!encoded.includes('申请退款'), 'template actions are not a buyer request');
assert.equal(mapped.content, '[非文本消息，请在原平台查看]', 'raw card text cannot run through text rules');
for (const [type, role, protocol, source] of [
  ['transfer_event', 'Buyer', 1000, 'live'], ['system', 'Buyer', 1000, 'live'],
  ['template_card', 'Buyer', 2000, 'live'], ['template_card', 'Robot', 1000, 'live'],
  ['template_card', 'CurrentServer', 1000, 'live'], ['template_card', 'Buyer', 1000, 'compensation'],
]) {
  const message = mapDouyinMessage({...raw, type:protocol, ext:{...raw.ext,type,'s:sender_biz_role':role}},'shop',source);
  assert.equal(isDouyinLiveReply(message,now,now), false);
}
for (const static_data of ['{bad', 'x'.repeat(65537), JSON.stringify({ content:'x'.repeat(5000),
  items:Array.from({length:50},(_,i)=>({title:'y'.repeat(512),order_id:String(i)})) })]) {
  const core = douyinMessageCore({...raw,ext:{...raw.ext,static_data}});
  assert.ok(JSON.stringify(core).length <= 4096);
  assert.ok(core.omitted || core.truncated);
}
let calls = 0;
const cyclic = {title:'安全文字',get content(){ calls++; return 'secret'; },toJSON(){calls++;}};
cyclic.child = cyclic;
const core = douyinMessageCore({ext:{static_data:cyclic}});
assert.equal(calls,0,'no getters/toJSON');
assert.ok(core.omitted);
assert.ok(JSON.stringify(core).includes('安全文字'));
const addressCard = douyinMessageCore({ext:{static_data:{title:'修改地址申请',description:'请帮我修改地址',
  details:[{label:'收货地址',value:'private-home'},{label:'联系电话',value:'13800138000'}]}}});
assert.ok(JSON.stringify(addressCard).includes('修改地址申请'));
assert.ok(!JSON.stringify(addressCard).includes('private-home'));
const empty = mapDouyinMessage({...raw,content:'',ext:{...raw.ext,static_data:'{bad'}},'shop');
assert.equal(isDouyinLiveReply(empty,now,now),true,'empty buyer cards can ask for clarification');
console.log('Douyin unknown message core: semantic projection, bounds, privacy, chat identity and live gating passed');
