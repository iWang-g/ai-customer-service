import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMessageParts, mergeMessageParts } from './message-parts.js';
import { normalizeQianniuMessage, qianniuEventsForIncomingMessage } from './message-mapper.js';
import { QianniuWorkerManager } from './worker-manager.js';
const shopUid = '123', cid = '456.1-789.1#11001@cntaobao';
const link = { type: 1, value: { url: 'https://item.taobao.com/item.htm?id=123456' } };
const card = { type: 5, value: { ...link.value, urlinfo: JSON.stringify({ title: '商品标题', imageUrl: '//img.alicdn.com/a.png', price: '30.0' }) } };
const raw = (nodes, extra = {}) => ({ shopUid, cid, direction: 'incoming', fromId: '456', messageId: 'm1', mediaVersion: 1,
  originalData: { jsview: nodes }, ...extra });

test('media parts retain order, remote images and partial product identity', () => {
  const parts = parseMessageParts(raw([{ type: 0, value: { text: '看看这个' } }, { type: 7, value: { url: 'https://img.alicdn.com/image.webp', pic: 'private-cache-path' } }, link]));
  assert.deepEqual(parts.map(p => p.kind), ['text', 'image', 'product']);
  assert.equal(parts[2].product_id, '123456');
  assert.equal(parts[2].title, null);
  assert.ok(!JSON.stringify(parts).includes('private-cache-path'));
  assert.equal(parseMessageParts(raw([{ type: 1, value: { url: 'https://fake.test/item.htm?id=123456' } }]))[0].kind, 'text');
  assert.equal(parseMessageParts(raw([{ type: 7, value: { url: 'file:///C:/private' } }]))[0].url, null);
});

test('rich text email uses complete original text instead of unsupported link fragments', () => {
  const email = raw([], { originalData: { text: '2796263815@qq.com', jsview: [
    { type: 0, value: { text: '2796263815@' } },
    { type: 1, value: { url: 'qq.com' } },
  ] } });
  const normalized = normalizeQianniuMessage(email);
  assert.equal(normalized.text, '2796263815@qq.com');
  assert.deepEqual(normalized.parts, [{ index: 0, kind: 'text', text: '2796263815@qq.com' }]);
  assert.equal(normalized.projection.structured_payload.parts_complete, true);
  assert.ok(!JSON.stringify(normalized).includes('暂不支持'));
});

test('completion and stale reread preserve filled fields and never change product identity', () => {
  const first = parseMessageParts(raw([link]));
  const complete = mergeMessageParts(first, parseMessageParts(raw([card])));
  assert.equal(complete[0].title, '商品标题');
  assert.deepEqual(mergeMessageParts(complete, first), complete);
  assert.deepEqual(mergeMessageParts(complete, complete), complete);
  assert.deepEqual(mergeMessageParts(complete, [{ ...first[0], product_id: 'other' }]), complete);
});

test('seller messages are synchronized without customer triggers and keep the seller name', async () => {
  const rows = [raw([card], { direction: 'outgoing', fromId: shopUid, toId: shopUid,
    fromNick: 'seller', toNick: 'buyer' })];
  const events = [];
  const worker = new QianniuWorkerManager({ enabled: true, readMessages: async () => ({ mediaVersion: 1, messages: rows }),
    sendText: () => { throw Error('must not send'); } });
  worker.applyBindings([{ platform_code: 'qianniu', local_account_id: 'qianniu-123', platform_account_id: 'account' }]);
  worker.on('event', e => events.push(e));
  const line = 'OnMessageArrive MessageSDK [3#123] dmsg.cid=' + cid + ',dmsg.mid=m1,';
  await worker.ingestLogLine(line);
  await worker.ingestLogLine(line);
  assert.equal(events.length, 1);
  assert.equal(events[0].event_type, 'qianniu_message_snapshot');
  assert.equal(events[0].payload_json.sender_role, 'agent');
  assert.equal(events[0].payload_json.sender_name, 'seller');
  assert.equal(events[0].payload_json.customer_id, '456');
  assert.equal(events[0].payload_json.automation_mode, 'ignore');
  assert.equal(events[0].payload_json.message_type, 'product');
  await worker.stop();
});

test('system events and history do not become customer triggers; empty images remain messages', () => {
  const message = normalizeQianniuMessage(raw([{ type: 7, value: {} }]));
  assert.equal(message.text, '[图片]');
  const args = { platformAccountId: 'account', shopUid, cid };
  const incoming = qianniuEventsForIncomingMessage({ ...args, message });
  assert.equal(incoming[1].payload_json.message_type, 'image');
  const history = qianniuEventsForIncomingMessage({ ...args, message, snapshot: true });
  assert.equal(history.length, 1); assert.equal(history[0].event_type, 'qianniu_message_snapshot');
  const system = qianniuEventsForIncomingMessage({ ...args, message: raw([], { templateId: 129,
    templateData: { dynamicContent: [{ templateId: 332001, platform: 1 }] } }) });
  assert.equal(system[0].payload_json.sender_role, 'platform');
  assert.equal(system[0].payload_json.automation_mode, 'ignore');
  assert.equal(normalizeQianniuMessage(raw([], { direction: 'unknown' })), null);
});

test('template 295001 recommendations differ from 332001 system messages and unknown templates', () => {
  const item = { itemId: '123456', actionUrl: 'https://item.taobao.com/item.htm?id=123456',
    pic: '//img.alicdn.com/a.png', title: '商品标题', price: '65.50' };
  const templateData = { dynamicContent: [{ templateId: 295001, platform: 3, templateData: { E2_items: [item, item] } }] };
  const seller = normalizeQianniuMessage(raw([], { direction: 'outgoing', templateId: 129, templateData }));
  assert.equal(seller.senderRole, 'agent');
  assert.deepEqual(seller.parts.map(p => p.kind), ['product', 'product']);
  assert.equal(seller.parts[0].price_label, '¥65.50');
  assert.equal(normalizeQianniuMessage(raw([], { templateId: 129 })).projection.message_type, 'unknown');
  const upgraded = mergeMessageParts([{ index: 0, kind: 'unsupported' }], seller.parts);
  assert.equal(upgraded[0].kind, 'product');
  item.itemId = '999';
  assert.equal(normalizeQianniuMessage(raw([], { templateId: 129, templateData })).projection.message_type, 'text');
  assert.equal(parseMessageParts(raw([], { templateId: 129, templateData }))[0].kind, 'unsupported');
});

test('unknown messages retain bounded sanitized evidence without becoming reply triggers', () => {
  const unknown = raw([{ type: 88, value: {
    title: '未知卡片',
    actionUrl: 'https://example.test/card?id=1&token=private-token',
    localPath: 'C:\\private\\cache.bin',
  } }], {
    templateId: 429005,
    templateData: { label: '卡片说明', sessionToken: 'private-session' },
  });
  const normalized = normalizeQianniuMessage(unknown);
  assert.equal(normalized.projection.message_type, 'unknown');
  assert.equal(normalized.qianniuRaw.template_id, 429005);
  assert.match(normalized.qianniuRaw.structure_hash, /^[0-9a-f]{64}$/);
  const args = { platformAccountId: 'account', shopUid, cid, message: normalized };
  const event = qianniuEventsForIncomingMessage(args).at(-1);
  assert.equal(event.payload_json.automation_mode, 'ignore');
  assert.equal(event.payload_json.context_eligible, true);
  assert.equal(event.payload_json.qianniu_raw.original_data.jsview[0].value.title, '未知卡片');
  assert.equal(event.payload_json.qianniu_raw.template_data.label, '卡片说明');
  assert.ok(JSON.stringify(event.payload_json.qianniu_raw).length < 32768);
  assert.ok(!JSON.stringify(event.payload_json.qianniu_raw).includes('private-token'));
  assert.ok(!JSON.stringify(event.payload_json.qianniu_raw).includes('private-session'));
  assert.ok(!JSON.stringify(event.payload_json.qianniu_raw).includes('private\\\\cache'));
});

test('worker history sync is read-only, isolates conversations, merges rereads, and cleans timers', async () => {
  let rows = [raw([card])];
  const events = [];
  const worker = new QianniuWorkerManager({ enabled: true, readMessages: async () => ({ mediaVersion: 1, messages: rows }),
    sendText: () => { throw new Error('must never send'); } });
  worker.applyBindings([{ platform_code: 'qianniu', local_account_id: 'qianniu-123', platform_account_id: 'account' }]);
  worker.on('event', e => events.push(e));
  const target = { platformAccountId: 'account', externalConversationId: cid };
  await worker.syncRecentMessages(target);
  rows = [raw([link])];
  await worker.syncRecentMessages(target);
  assert.equal(events.length, 1);
  assert.equal(events[0].event_type, 'qianniu_message_snapshot');
  rows = [raw([link], { cid: '999.1-789.1#11001@cntaobao' })];
  await worker.syncRecentMessages(target);
  assert.equal(events.length, 1);
  rows = [raw([link], { messageId: 'm2' })];
  await worker.syncRecentMessages(target);
  assert.equal(worker.mediaTimers.size, 1);
  await worker.stop();
  assert.equal(worker.mediaTimers.size, 0);
});

test('media reread stays coalesced while in flight and emits only a completion snapshot', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let finishRead, reads = 0;
  const events = [];
  const worker = new QianniuWorkerManager({ enabled: true,
    readMessages: async () => {
      reads++;
      if (reads === 2) return new Promise(resolve => { finishRead = resolve; });
      return { mediaVersion: 1, messages: [raw([link])] };
    }, sendText: () => { throw Error('must not send'); } });
  t.after(() => worker.stop());
  worker.applyBindings([{ platform_code: 'qianniu', local_account_id: 'qianniu-123', platform_account_id: 'account' }]);
  worker.on('event', event => events.push(event));
  await worker.ingestLogLine('OnMessageArrive MessageSDK [3#123] dmsg.cid=' + cid + ',dmsg.mid=m1,');
  assert.equal(events.filter(e => e.event_type === 'customer_message').length, 1);
  t.mock.timers.tick(3000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 2);
  assert.equal(worker.mediaTimers.size, 1);
  const sync = worker.syncRecentMessages({ platformAccountId: 'account', externalConversationId: cid });
  finishRead({ mediaVersion: 1, messages: [raw([card])] });
  await sync;
  assert.equal(worker.mediaTimers.size, 0);
  assert.equal(events.filter(e => e.event_type === 'customer_message').length, 1);
  assert.equal(events.filter(e => e.event_type === 'qianniu_message_snapshot').length, 1);
  assert.equal(events.at(-1).payload_json.structured_payload.parts[0].title, '商品标题');
});
