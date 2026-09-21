import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { senderScript } from '../electron/platform-workspace/douyin/sender.js';
import { DouyinSendJournal } from '../electron/platform-workspace/douyin/send-journal.js';

const cid = 'buyer:shop::2:1:pigeon';
const context = vm.createContext({ window: {}, location: { hostname: 'im.jinritemai.com' }, AbortSignal,
  fetch: async () => ({ ok: true, json: async () => ({ code: 0, data: { ShopId: 'shop' } }) }),
});
const run = (script) => vm.runInContext(script, context);
run(`window.calls = []; window.im = {sendText(cid, text) {
  window.calls.push([cid, text]); return window.response;
}}; window.__PLATFORM_VARIABLES_IN_BENCH__ = {extra:{im:window.im}};`);
const send = (taskId, extra = {}) => run(senderScript({ action: 'send', taskId, shopId: 'shop', conversationId: cid,
  content: 'hello', ...extra }));
const poll = (taskId) => run(senderScript({ action: 'poll', taskId }));
run(`window.response = Promise.resolve({securityConversationId:'${cid}', content:'hello', serverId:'9007199254740993',
 serverStatus:0, createdAt:new Date('2026-09-11T08:00:00Z'), ext:{'s:sender_biz_role':'CurrentServer',
 's:send_response_status':'0','s:send_response_check_code':'0'}});`);
await Promise.all([send('one'), send('one')]);
assert.equal(run('window.calls.length'), 1, 'concurrent task replay sends once');
assert.equal((await poll('one')).status, 'completed');
assert.equal((await poll('one')).platform_message_id, '9007199254740993');
assert.equal((await poll('one')).platform_sent_at, '2026-09-11T08:00:00.000Z');
await send('one');
assert.equal(run('window.calls.length'), 1);
await assert.rejects(send('wrong', { conversationId: 'buyer:other::2:1:pigeon' }));
await assert.rejects(send('empty', { content: ' ' }));
assert.equal(run('window.calls.length'), 1);
run(`window.response = Promise.resolve({success:true});`);
await send('no-proof');
assert.equal((await poll('no-proof')).status, 'confirmation_pending', 'resolution alone is not confirmation');
run(`window.response = new Promise(resolve => window.resolveLate = resolve);`);
await send('late');
assert.equal((await poll('late')).status, 'confirmation_pending');
run(`window.resolveLate({securityConversationId:'${cid}', content:'hello', serverId:{low:1,high:2097152,unsigned:true}, serverStatus:0,
 ext:{'s:sender_biz_role':'CurrentServer','s:send_response_status':'0','s:send_response_check_code':'0'}});`);
await run('window.response');
assert.equal((await poll('late')).platform_message_id, '9007199254740993');
run(`window.response = Promise.resolve({securityConversationId:'${cid}', content:'hello',
 ext:{'s:sender_biz_role':'CurrentServer','s:send_response_status':'1','s:send_response_check_code':'403'}});`);
await send('rejected');
assert.equal((await poll('rejected')).status, 'failed');
run(`window.response = Promise.reject(new Error('network timeout'));`);
await send('network');
assert.equal((await poll('network')).status, 'confirmation_pending');
run(`window.response = Promise.resolve({securityConversationId:'other:shop::2:1:pigeon', content:'hello',serverId:'99',serverStatus:0,
 ext:{'s:sender_biz_role':'CurrentServer','s:send_response_status':'0','s:send_response_check_code':'0'}});`);
await send('other-buyer');
assert.equal((await poll('other-buyer')).status, 'confirmation_pending', 'another conversation cannot confirm');
assert.equal((await poll('other-buyer')).sdk_platform_message_id, undefined);
run(`window.response = Promise.resolve({securityConversationId:'${cid}', content:'hello',serverId:'99',
 ext:{'s:client_message_id':'sdk-99','s:sender_biz_role':'CurrentServer'}});`);
await send('echo-correlation');
const correlation = await poll('echo-correlation');
assert.equal(correlation.status, 'confirmation_pending');
assert.equal(correlation.sdk_platform_message_id, '99');
assert.equal(correlation.sdk_client_message_id, 'sdk-99');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-send-test-'));
const journal = new DouyinSendJournal(dir, 'user');
const task = { id: 'task', user_id: 'user', platform_account_id: 'account', payload_json: { external_conversation_id: cid } };
const first = journal.begin(task, 'local');
const recovered = new DouyinSendJournal(dir, 'user');
assert.deepEqual(recovered.get(task.id), first, 'interrupted send is persisted as pending');
assert.deepEqual(recovered.begin(task, 'local'), first, 'attempt cannot be restarted');
const completed = recovered.finish(first, { status: 'completed', platform_message_id: '99' });
assert.equal(new DouyinSendJournal(dir, 'user').get(task.id).result.status, 'completed');
assert.notEqual(journal.event(first).event_id, journal.event(completed).event_id);
assert.notEqual(journal.event(first).event_id, journal.event({ ...first, result: correlation }).event_id,
  'late SDK identity must not be dropped as a duplicate pending event');
assert.equal(new DouyinSendJournal(dir, 'other-user').entries().length, 0);
console.log('Douyin sender: success, duplicate, identity, rejection, timeout, late confirmation, journal recovery passed');
