import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { preparePddTransfer } from '../electron/platform-workspace/pinduoduo/auto-transfer.js';
const require = createRequire(import.meta.url);
const { mapPddMessage } = require('../electron/platform-workspace/pinduoduo/api-mapper.cjs');
const { pddMessageCore } = require('../electron/platform-workspace/pinduoduo/message-core.cjs');

const unknown = mapPddMessage({ type: 999, msg_id: '123', from: { role: 'user' },
  content: { title: '订单问题', details: [{ label: '收货地址', value: 'private-address' }],
    description: '退款规则是什么', buttons: [{ text: '帮我退款' }], token: 'secret' } });
assert.equal(unknown.content, '[非文本消息，请在原平台查看]');
assert.equal(unknown.automation_mode, 'trigger');
assert.match(JSON.stringify(unknown.structured_payload.message_core), /退款规则是什么/);
assert.doesNotMatch(JSON.stringify(unknown), /private-address|secret|帮我退款/);
const core = pddMessageCore({ info: { get title() { throw new Error('getter must not run'); },
  description: 'x'.repeat(10000), list: Array.from({ length: 50 }, () => ({ text: 'y'.repeat(500) })) } });
assert.equal(core.truncated, true); assert.ok(JSON.stringify(core).length <= 4096);
assert.equal(mapPddMessage({ type: 1, content: 'https://image.test/a', from: { role: 'user' } }).content, '[图片]');
assert.equal(mapPddMessage({ type: 24, content: '转接通知', from: { role: 'user' } }).automation_mode, 'ignore');
assert.equal(preparePddTransfer({ status: 'collected', identity_verified: true, cs_list: [
  { csid: 'self', recvUser: 1, isCurrent: true }, { csid: 'rest', recvUser: 0, isCurrent: false },
] }).status, 'no_online_target');
assert.throws(() => preparePddTransfer({ status: 'failed', cs_list: [] }));
assert.equal(preparePddTransfer({ status: 'collected', identity_verified: true, cs_list: [
  { csid: 'other', recvUser: 1, isCurrent: false },
] }).target_cs_id, 'other');

// Execute the actual main-world transfer branch with a fake platform transport.
const source = fs.readFileSync(new URL('../electron/platform-workspace/pinduoduo/preload.cjs', import.meta.url), 'utf8');
const helpers = source.slice(source.indexOf('  const mapTransferCsListInPage ='), source.indexOf('  const buildSendImageMessageRequest ='));
const start = source.indexOf("    if (command.command === 'transfer-conversation'");
const branch = source.slice(start, source.indexOf("    if (command.command === 'send-image'", start));
async function transfer({ roster = {}, success = true, moveError = false, identity = { csId: 'self' } } = {}) {
  let moves = 0;
  let done;
  const result = new Promise((resolve) => { done = resolve; });
  const context = {
    command: { command: 'transfer-conversation', requestId: 'request', customerUid: 'buyer', targetCsid: 'other', autoTransfer: true },
    clientState: { latestIdentity: identity, antiContentHeader: 'test', topAntiContent: 'test' },
    textInPage: (v) => v == null ? '' : String(v),
    buildAssignCsListRequest: () => ({ url: 'assign', init: {} }),
    buildMoveConversationRequest: () => ({ url: 'move', init: {} }),
    postApiClientResult: done,
    window: { fetch: async (url) => {
      if (url === 'assign') return { ok: true, json: async () => ({ success, result: { csList: roster } }) };
      moves++; if (moveError) throw new Error('connection lost');
      return { ok: true, json: async () => ({ success: true, result: { result: 'ok' } }) };
    } },
  };
  vm.runInNewContext(`(() => { ${helpers}
    ${branch}
  })()`, context);
  return { result: await result, moves };
}
let run = await transfer();
assert.equal(run.result.status, 'no_online_target'); assert.equal(run.moves, 0);
run = await transfer({ success: false });
assert.equal(run.result.status, 'failed'); assert.equal(run.moves, 0);
run = await transfer({ roster: null });
assert.equal(run.result.status, 'failed'); assert.equal(run.moves, 0);
run = await transfer({ roster: { self: { recvUser: 1 }, other: { recvUser: 0 } } });
assert.equal(run.result.status, 'no_online_target'); assert.equal(run.moves, 0);
run = await transfer({ roster: { another: { recvUser: 1 } } });
assert.equal(run.result.status, 'failed'); assert.equal(run.moves, 0);
run = await transfer({ roster: { other: { recvUser: 1 } }, identity: null });
assert.equal(run.result.status, 'failed'); assert.equal(run.moves, 0);
run = await transfer({ roster: { other: { recvUser: 1 } } });
assert.equal(run.result.status, 'transferred'); assert.equal(run.moves, 1);
run = await transfer({ roster: { other: { recvUser: 1 } }, moveError: true });
assert.equal(run.result.status, 'confirmation_pending'); assert.equal(run.result.submitted, true); assert.equal(run.moves, 1);
console.log('PDD core context, target selection and 8 native transfer scenarios passed');

// The workspace bridge must retain the distinction and receipt, not flatten it to failure.
const workspaceSource = fs.readFileSync(new URL('../electron/platform-workspace/workspace-manager.js', import.meta.url), 'utf8');
const bridgeStart = workspaceSource.indexOf("      if (payload?.type === 'api_conversation_transfer_result')");
const bridge = workspaceSource.slice(bridgeStart, workspaceSource.indexOf("      if (payload?.type === 'api_image_send_result')", bridgeStart))
  .replaceAll('this.#writeDiagnostic', 'this.writeDiagnostic').replaceAll('this.#markSessionActivity', 'this.markSessionActivity');
function forward(payload) {
  let output;
  const pending = { accountId: 'shop', timer: null, resolve: (value) => { output = value; } };
  const manager = { pendingConversationTransfers: new Map([['req', pending]]), pendingTransferCsLists: new Map([['req', pending]]),
    writeDiagnostic() {}, markSessionActivity() {} };
  vm.runInNewContext(`(function () { ${bridge} }).call(manager)`, { manager, accountId: 'shop',
    payload: { request_id: 'req', ...payload }, clearTimeout() {} });
  return output;
}
const unavailable = forward({ type: 'api_conversation_transfer_result', status: 'no_online_target', submitted: false });
assert.equal(unavailable.submitted, false); assert.equal(unavailable.status, 'no_online_target');
const transferred = forward({ type: 'api_conversation_transfer_result', status: 'transferred', submitted: true,
  target_cs_id: 'other', result: { result: 'ok' } });
assert.equal(transferred.submitted, true); assert.equal(transferred.result.result, 'ok');
assert.equal(transferred.target_cs_id, 'other');
const roster = forward({ type: 'api_transfer_cs_list_result', status: 'collected', identity_verified: true,
  cs_list: [{ csid: 'other', recvUser: 1, isCurrent: false }] });
assert.equal(preparePddTransfer(roster).target_cs_id, 'other');
console.log('PDD workspace forwarding preserves target eligibility and transfer receipts');
