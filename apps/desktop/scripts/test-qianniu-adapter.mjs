import assert from 'node:assert/strict';
import { once } from 'node:events';
import {
  buyerUidFromCid,
  normalizeQianniuMessage,
  qianniuAccountFromBridgeClient,
  qianniuEventsForIncomingMessage,
  sendTargetFromTask,
} from '../electron/qianniu/message-mapper.js';
import { projectMessageParts } from '../electron/qianniu/message-parts.js';
import { parseQianniuWake, QianniuWorkerManager } from '../electron/qianniu/worker-manager.js';

const shopUid = '2222303856223';
const cid = '2214525969878.1-2216058631944.1#11001@cntaobao';

assert.equal(buyerUidFromCid(cid), '2214525969878');

const account = qianniuAccountFromBridgeClient({
  clientId: 'client-1',
  page: 'recent.html',
  readMessagesVersion: 1,
  abilityMode: 'workbench.application',
  state: {
    loginID: {
      targetId: shopUid,
      display: '有求必应羊羊:王刚',
    },
  },
});
assert.equal(account.id, `qianniu-${shopUid}`);
assert.equal(account.platform_code, 'qianniu');
assert.equal(account.metadata_json.shop_uid, shopUid);

const message = normalizeQianniuMessage({
  shopUid,
  cid,
  direction: 'incoming',
  fromId: '2214525969878',
  fromNick: 'tb4947894539',
  messageId: '4289878779774.PNM',
  clientId: 'client-message-1',
  text: '哈喽',
});
assert.equal(message.senderRole, 'customer');
assert.equal(message.text, '哈喽');

const transferRaw = { shopUid, cid, templateId: 101, direction: 'incoming',
  fromId: '2214525969878', fromNick: 'tb4947894539', toId: shopUid, toNick: '有求必应羊羊:王刚',
  messageId: 'transfer-notice', text: '由 方和 转交给 王刚', sendTime: '1789441550868' };
const transferMessage = normalizeQianniuMessage(transferRaw);
assert.equal(transferMessage.senderRole, 'platform');
assert.equal(transferMessage.projection.display_mode, 'separator');
assert.equal(transferMessage.text, transferRaw.text);
assert.equal(transferMessage.transferNotice.source_nick, '有求必应羊羊:方和');
const transferEvents = qianniuEventsForIncomingMessage({ platformAccountId: 'server-account-1', shopUid, cid, message: transferMessage });
assert.equal(transferEvents.length, 1);
assert.equal(transferEvents[0].event_type, 'message_received');
assert.equal(transferEvents[0].payload_json.sender_role, 'platform');
assert.equal(transferEvents[0].payload_json.automation_mode, 'trigger');
assert.equal(qianniuEventsForIncomingMessage({ platformAccountId: 'server-account-1', shopUid, cid,
  message: transferMessage, snapshot: true })[0].payload_json.automation_mode, 'ignore');
for (const change of [{ templateId: 1 }, { toId: '999' }, { text: '由 方和 转交给 别人' },
  { text: '由 其他店铺:方和 转交给 王刚' }, { direction: 'outgoing' }]) {
  assert.equal(normalizeQianniuMessage({ ...transferRaw, ...change }).transferNotice, null);
}

const events = qianniuEventsForIncomingMessage({
  platformAccountId: 'server-account-1',
  shopUid,
  cid,
  message,
  observedAt: '2026-09-08T03:30:00.000Z',
});
assert.equal(events.length, 2);
assert.equal(events[0].event_type, 'conversation_snapshot');
assert.equal(events[1].event_type, 'customer_message');
assert.equal(events[1].platform_code, 'qianniu');
assert.equal(events[1].platform_account_id, 'server-account-1');
assert.equal(events[1].conversation_external_id, cid);
assert.equal(events[1].payload_json.content, '哈喽');
assert.equal(events[1].payload_json.customer_name, 'tb4947894539');

const productMessage = { ...message, messageId: 'product-fixture', parts: [
  { index: 0, kind: 'product', product_id: '123', title: '角色主题键帽', price_label: '¥155.00' },
] };
for (const [snapshot, direction] of [[false, 'incoming'], [true, 'incoming'], [false, 'outgoing']]) {
  const productEvents = qianniuEventsForIncomingMessage({ platformAccountId: 'server-account-1', shopUid, cid,
    message: { ...productMessage, direction }, snapshot, observedAt: new Date().toISOString() });
  const productEvent = productEvents.at(-1);
  assert.equal(productEvent.payload_json.message_type, 'product');
  assert.equal(productEvent.payload_json.structured_payload.product_id, '123');
  assert.equal(productEvent.payload_json.automation_mode, !snapshot && direction === 'incoming' ? 'trigger' : 'ignore');
  assert.equal(productEvent.event_type, !snapshot && direction === 'incoming' ? 'customer_message' : 'qianniu_message_snapshot');
}

const unknownMessage = { ...message, messageId: 'unknown-fixture', text: '',
  mediaVersion: 1, originalData: {}, parts: undefined, templateId: 147001 };
const unknownEvents = qianniuEventsForIncomingMessage({ platformAccountId: 'server-account-1', shopUid, cid,
  message: unknownMessage, observedAt: new Date().toISOString() });
assert.equal(unknownEvents.at(-1).event_type, 'customer_message');
assert.equal(unknownEvents.at(-1).payload_json.message_type, 'unknown');
assert.equal(unknownEvents.at(-1).payload_json.automation_mode, 'trigger');
assert.equal(unknownEvents.at(-1).payload_json.service_obligation, undefined);
assert.equal(unknownEvents.at(-1).payload_json.context_eligible, true);
assert.equal(unknownEvents.at(-1).payload_json.qianniu_raw.template_id, 147001);
assert.equal(qianniuEventsForIncomingMessage({ platformAccountId: 'server-account-1', shopUid, cid,
  message: unknownMessage, snapshot: true })[0].payload_json.automation_mode, 'ignore');
const unknownOutgoing = qianniuEventsForIncomingMessage({ platformAccountId: 'server-account-1', shopUid, cid,
  message: { ...unknownMessage, messageId: 'unknown-outgoing', direction: 'outgoing', fromId: shopUid, toId: '2214525969878' } });
assert.equal(unknownOutgoing.at(-1).payload_json.automation_mode, 'ignore');

const mixedProjection = projectMessageParts([
  { kind: 'text', text: '修改地址' },
  { kind: 'unsupported', text: '[暂不支持的消息]' },
]);
assert.equal(mixedProjection.message_type, 'unknown');
assert.match(mixedProjection.content, /修改地址/);
assert.match(mixedProjection.content, /暂不支持/);

const wake = parseQianniuWake(
  `[09-08 11:30:00 0 37708 27344 INFO] app [MessageSDK ][3#${shopUid}] OnMessageArrive dmsg.cid=${cid},dmsg.mid=4289878779774.PNM,dmsg.sender.uid=2214525969878 ]`,
);
assert.equal(wake.shopUid, shopUid);
assert.equal(wake.cid, cid);
assert.equal(wake.messageId, '4289878779774.PNM');
assert.equal(wake.senderUid, '2214525969878');

const target = sendTargetFromTask({
  id: 'task-1',
  task_type: 'send_message',
  platform_code: 'qianniu',
  platform_account_id: 'server-account-1',
  payload_json: {
    external_conversation_id: cid,
    content: '您好',
  },
}, new Map([['server-account-1', shopUid]]));
assert.deepEqual(target, { shopUid, cid, text: '您好' });

const multilineTarget = sendTargetFromTask({
  platform_account_id: 'server-account-1',
  payload_json: {
    external_conversation_id: cid,
    content: '  第一行\n第二行  保留连续空格  ',
  },
}, new Map([['server-account-1', shopUid]]));
assert.deepEqual(multilineTarget, {
  shopUid,
  cid,
  text: '第一行\n第二行  保留连续空格',
});

const emittedEvents = [];
const diagnostics = [];
const sendCalls = [];
const worker = new QianniuWorkerManager({
  enabled: true,
  readMessages: async () => ({
    messages: [{
      shopUid,
      cid,
      direction: 'incoming',
      fromId: '2214525969878',
      fromNick: 'tb4947894539',
      messageId: '4289878779774.PNM',
      text: '哈喽',
    }],
  }),
  sendText: (...args) => {
    sendCalls.push(args);
    return {
    requestId: 'request-1',
    native: { messageId: 'send-1', clientId: 'native-client-1' },
    result: { status: 'confirmed' },
    };
  },
  now: () => '2026-09-08T03:30:00.000Z',
  diagnosticLogger: {
    write: (accountId, payload) => diagnostics.push({ accountId, payload }),
  },
});
worker.applyBindings([{
  platform_code: 'qianniu',
  local_account_id: `qianniu-${shopUid}`,
  platform_account_id: 'server-account-1',
}]);
worker.on('event', (event) => emittedEvents.push(event));

await worker.ingestLogLine(
  `[09-08 11:30:00 0 37708 27344 INFO] app [MessageSDK ][3#${shopUid}] OnMessageArrive dmsg.cid=${cid},dmsg.mid=4289878779774.PNM,dmsg.sender.uid=2214525969878 ]`,
);
assert.equal(emittedEvents.length, 2);
assert.equal(emittedEvents[1].event_type, 'customer_message');

const taskComplete = once(worker, 'task-complete');
await worker.handleTask({
  id: 'send-task-1',
  task_type: 'send_message',
  platform_code: 'qianniu',
  platform_account_id: 'server-account-1',
  payload_json: {
    external_conversation_id: cid,
    content: '测试回复',
  },
});
const [taskId, status, resultJson] = await taskComplete;
assert.equal(taskId, 'send-task-1');
assert.equal(status, 'completed');
assert.equal(resultJson.platform_message_id, 'send-1');

const manualSendResult = worker.sendMessage({
  platformAccountId: 'server-account-1',
  externalConversationId: cid,
  content: '手动回复',
  timeoutMs: 12345,
});
const resolvedManualSendResult = await manualSendResult;
assert.equal(resolvedManualSendResult.status, 'sent');
assert.equal(resolvedManualSendResult.method, 'qianniu_direct_send');
assert.equal(resolvedManualSendResult.shop_uid, shopUid);
assert.equal(resolvedManualSendResult.conversation_key, cid);
assert.equal(resolvedManualSendResult.msg_id, 'send-1');
assert.deepEqual(sendCalls.at(-1), [shopUid, cid, '手动回复', { timeoutMs: 12345 }]);

const helperCalls = [];
const helperWorker = new QianniuWorkerManager({
  enabled: true,
  sendText: (...args) => {
    throw new Error(`fallback should not run: ${args.length}`);
  },
  directSendClient: {
    getState: () => ({ status: 'online', pending: 0 }),
    sendText: async (...args) => {
      helperCalls.push(args);
      return {
        requestId: 'helper-request-1',
        native: { messageId: 'helper-send-1', clientId: 'helper-client-1' },
        result: { status: 'confirmed' },
      };
    },
  },
});
helperWorker.applyBindings([{
  platform_code: 'qianniu',
  local_account_id: `qianniu-${shopUid}`,
  platform_account_id: 'server-account-1',
}]);
const helperSendResult = await helperWorker.sendMessage({
  platformAccountId: 'server-account-1',
  externalConversationId: cid,
  content: 'helper 回复',
});
assert.equal(helperSendResult.msg_id, 'helper-send-1');
assert.deepEqual(helperCalls.at(-1), [shopUid, cid, 'helper 回复', { timeoutMs: 30000 }]);
await helperWorker.sendMessage({
  platformAccountId: 'server-account-1',
  externalConversationId: cid,
  content: '第一行\n第二行  保留连续空格',
});
assert.deepEqual(helperCalls.at(-1), [shopUid, cid, '第一行\n第二行  保留连续空格', { timeoutMs: 30000 }]);

const fallbackDiagnostics = [];
const fallbackCalls = [];
const fallbackWorker = new QianniuWorkerManager({
  enabled: true,
  sendText: (...args) => {
    fallbackCalls.push(args);
    return {
      requestId: 'fallback-request-1',
      native: { messageId: 'fallback-send-1', clientId: 'fallback-client-1' },
      result: { status: 'confirmed' },
    };
  },
  directSendClient: {
    getState: () => ({ status: 'stopped', pending: 0 }),
    sendText: async () => {
      const error = new Error('helper refused before submit');
      error.submitted = false;
      throw error;
    },
  },
  diagnosticLogger: {
    write: (accountId, payload) => fallbackDiagnostics.push({ accountId, payload }),
  },
});
fallbackWorker.applyBindings([{
  platform_code: 'qianniu',
  local_account_id: `qianniu-${shopUid}`,
  platform_account_id: 'server-account-1',
}]);
const fallbackSendResult = await fallbackWorker.sendMessage({
  platformAccountId: 'server-account-1',
  externalConversationId: cid,
  content: 'fallback 回复',
});
assert.equal(fallbackSendResult.msg_id, 'fallback-send-1');
assert.deepEqual(fallbackCalls.at(-1), [shopUid, cid, 'fallback 回复', { timeoutMs: 30000 }]);
assert.ok(fallbackDiagnostics.some((item) => item.payload.stage === 'direct_send_helper_fallback'));

assert.ok(diagnostics.length >= 0);
console.log('qianniu adapter tests passed');
