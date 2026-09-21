import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QianniuWorkerManager, findCompleteLine } from './worker-manager.js';

const shopUid = '2222303856223';
const cid = '2214525969878.1-2216058631944.1#11001@cntaobao';
const line = `MessageSDK [][3#${shopUid}] OnMessageArrive dmsg.cid=${cid},dmsg.mid=message-1,dmsg.sender.uid=2214525969878`;
const binding = { platform_code: 'qianniu', local_account_id: `qianniu-${shopUid}`, platform_account_id: 'account-1' };
function fixture() {
  let reads = 0;
  const events = [];
  const worker = new QianniuWorkerManager({ enabled: true, sendText: () => { throw new Error('no send'); },
    readMessages: async () => { reads++; return { messages: [{ shopUid, cid, messageId: 'message-1',
      direction: 'incoming', fromId: '2214525969878', fromNick: 'test', text: 'test', sendTime: '1789380298000' }] }; } });
  worker.refreshClients = async () => [];
  worker.on('event', event => events.push(event));
  return { worker, events, reads: () => reads };
}
test('binding arriving after a wake replays once, including duplicate notifications', async () => {
  const { worker, events, reads } = fixture();
  await worker.ingestLogLine(line);
  await worker.ingestLogLine(line);
  assert.equal(reads(), 0);
  assert.equal(worker.pendingBindings.size, 1);
  assert.equal(worker.seen.size, 0);
  worker.applyBindings([{ ...binding, local_account_id: 'qianniu-999' }]);
  await worker.bindingReplay;
  assert.equal(reads(), 0);
  worker.applyBindings([binding]);
  worker.applyBindings([binding]);
  await worker.bindingReplay;
  await worker.ingestLogLine(line);
  assert.equal(reads(), 1);
  assert.equal(events.filter(e => e.event_type === 'customer_message').length, 1);
  assert.equal(worker.pendingBindings.size, 0);
});
test('old buffered messages recover as history without auto reply', async () => {
  const { worker, events } = fixture();
  await worker.ingestLogLine(line);
  for (const pending of worker.pendingBindings.values()) pending.at -= 61000;
  worker.applyBindings([binding]);
  await worker.bindingReplay;
  assert.equal(events.length, 1);
  assert.equal(events[0].event_type, 'qianniu_message_snapshot');
  assert.equal(events[0].payload_json.automation_mode, 'ignore');
});
test('bridge notice and app log fallback for the same message are processed once', async () => {
  const { worker, events, reads } = fixture();
  worker.applyBindings([binding]);
  await worker.ingestBridgeNotice({ shopUid, cid, messageId: 'message-1', buyerUid: '2214525969878' });
  await worker.ingestLogLine(line);
  assert.equal(reads(), 1);
  assert.equal(events.filter(e => e.event_type === 'customer_message').length, 1);
});
test('failed bridge read can recover from the later app log fallback', async () => {
  let calls = 0;
  const worker = new QianniuWorkerManager({ enabled: true, sendText: () => {}, readMessages: async () => {
    calls += 1;
    if (calls <= 5) return { messages: [] };
    return { messages: [{ shopUid, cid, messageId: 'message-1', direction: 'incoming',
      fromId: '2214525969878', fromNick: 'test', text: 'test', sendTime: '1789380298000' }] };
  } });
  worker.applyBindings([binding]);
  await worker.ingestBridgeNotice({ shopUid, cid, messageId: 'message-1', buyerUid: '2214525969878' });
  assert.equal(worker.seen.size, 0);
  await worker.ingestLogLine(line);
  assert.equal(calls, 6); assert.equal(worker.seen.size, 1);
});
test('stop invalidates scheduled binding replay and clears account state', async () => {
  const { worker, reads } = fixture();
  await worker.ingestLogLine(line);
  worker.applyBindings([binding]);
  await worker.stop();
  await worker.bindingReplay;
  assert.equal(reads(), 0);
  assert.equal(worker.pendingBindings.size, 0);
  assert.equal(worker.platformAccountBindings.size, 0);
});
test('truncated log reads new lines from zero and retains partial UTF-8 line', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qn-log-test-'));
  const file = path.join(directory, 'app.log');
  fs.writeFileSync(file, 'previous-log'.repeat(20));
  const fd = fs.openSync(file, 'r');
  try {
    const before = fs.fstatSync(fd).size;
    fs.writeFileSync(file, '新消息\n下一条');
    const first = findCompleteLine(fd, before);
    assert.deepEqual(first.lines, ['新消息']);
    assert.equal(first.offset, Buffer.byteLength('新消息\n'));
    fs.appendFileSync(file, '\n');
    assert.deepEqual(findCompleteLine(fd, first.offset).lines, ['下一条']);
  } finally { fs.closeSync(fd); fs.rmSync(directory, { recursive: true }); }
});

test('automatic send uses the node-authenticated guard instead of the renderer business token', async () => {
  const guardCalls = [], businessCalls = [], sends = [], completions = [];
  const worker = new QianniuWorkerManager({
    enabled: true,
    useDirectSendHelper: false,
    sendGuard: async (payload) => { guardCalls.push(payload); return { blocked: false }; },
    businessApi: async (...args) => { businessCalls.push(args); throw new Error('stale renderer token'); },
    sendText: async (...args) => {
      sends.push(args);
      return { native: { messageId: 'sent-1', clientId: 'client-1' }, result: { status: 'success' } };
    },
  });
  worker.applyBindings([binding]);
  worker.on('task-complete', (...args) => completions.push(args));

  const handled = await worker.handleTask({
    id: 'task-1',
    task_type: 'send_message',
    platform_code: 'qianniu',
    platform_account_id: 'account-1',
    conversation_id: 'conversation-1',
    payload_json: {
      platform_account_id: 'account-1',
      shop_uid: shopUid,
      external_conversation_id: cid,
      content: '测试回复',
      source: 'automation',
    },
  });

  assert.equal(handled, true);
  assert.deepEqual(guardCalls, [{ taskId: 'task-1', platformAccountId: 'account-1', cid }]);
  assert.equal(businessCalls.length, 0);
  assert.equal(sends.length, 1);
  assert.equal(completions[0][1], 'completed');
  assert.equal(completions[0][2].platform_message_id, 'sent-1');
});
