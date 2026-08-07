import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyPddPage } from '../electron/platform-workspace/pinduoduo/detector.js';
import { PddDiagnosticLogger } from '../electron/platform-workspace/pinduoduo/diagnostic-logger.js';
import { PddCollectionRuntime } from '../electron/platform-workspace/pinduoduo/runtime.js';

assert.equal(classifyPddPage('https://mms.pinduoduo.com/login/'), 'login_required');
assert.equal(classifyPddPage('https://mms.pinduoduo.com/chat-windows/index.html'), 'online');
assert.equal(classifyPddPage('https://example.com/chat-windows/index.html'), 'unsupported');

const snapshot = {
  version: 1,
  type: 'snapshot',
  snapshot_id: 'snapshot-100',
  observed_at: '2026-07-28T08:00:00.000Z',
  conversations: [
    {
      external_conversation_id: 'buyer-100',
      customer_name: '测试买家',
      latest_message_text: '请问有货吗',
      unread_count: 2,
      active: true,
      messages: [
        {
          platform_message_id: 'message-100',
          sender_role: 'customer',
          content: '请问有货吗',
          message_type: 'text',
          platform_sent_at: '2026-07-28T07:59:00.000Z',
          snapshot_sequence: 3,
          time_group_index: 1,
          time_label: '2026-07-28 15:59:00',
          has_explicit_time: true,
        },
      ],
    },
  ],
};

function createRuntime(localAccountId, binding, options = {}) {
  const events = [];
  const runtime = new PddCollectionRuntime({
    localAccountId,
    getPlatformAccountId: () => binding.value,
    enqueueEvent: (event) => events.push(event),
    ...options,
  });
  return { runtime, events };
}

const bindingA = { value: null };
const accountA = createRuntime('local-a', bindingA);
assert.equal(accountA.runtime.ingest(snapshot), true);
assert.equal(accountA.events.length, 0, '服务端账号绑定前不得产生无账号维度事件');

bindingA.value = 'platform-a';
accountA.runtime.accountBindingChanged();
assert.equal(accountA.events.length, 2);
assert.equal(accountA.events[0].event_type, 'conversation_snapshot');
assert.equal(accountA.events[1].event_type, 'message_received');
assert.equal(accountA.events[1].platform_account_id, 'platform-a');
assert.equal(accountA.events[1].received_at, snapshot.observed_at);
assert.equal(accountA.events[1].payload_json.platform_sent_at, '2026-07-28T07:59:00.000Z');
assert.equal(accountA.events[1].payload_json.snapshot_id, 'snapshot-100');
assert.equal(accountA.events[1].payload_json.snapshot_sequence, 3);
assert.match(accountA.events[1].dedup_key, /:message:v3:/);

const dualTrackSnapshot = structuredClone(snapshot);
dualTrackSnapshot.snapshot_id = 'snapshot-dual-track';
dualTrackSnapshot.conversations[0].snapshot_messages = [
  {
    dom_sequence: 0,
    platform_message_id: null,
    sender_role: 'customer',
    content: 'same customer message',
    message_type: 'text',
    image_url: null,
  },
  {
    dom_sequence: 1,
    platform_message_id: null,
    sender_role: 'customer',
    content: 'same customer message',
    message_type: 'text',
    image_url: null,
  },
  {
    dom_sequence: 2,
    platform_message_id: 'image-1',
    sender_role: 'agent',
    content: '[image]',
    message_type: 'image',
    image_url: 'https://img.example.com/image.png?token=temporary',
  },
];
const dualTrackAccount = createRuntime('local-dual-track', { value: 'platform-dual-track' });
dualTrackAccount.runtime.ingest(dualTrackSnapshot);
const messageSnapshot = dualTrackAccount.events.find((event) => event.event_type === 'message_snapshot');
assert.ok(messageSnapshot, 'dual-track snapshot event must be emitted');
assert.equal(messageSnapshot.payload_json.messages.length, 3);
assert.deepEqual(messageSnapshot.payload_json.messages.map((message) => message.dom_sequence), [0, 1, 2]);
assert.deepEqual(
  messageSnapshot.payload_json.messages.slice(0, 2).map((message) => message.content),
  ['same customer message', 'same customer message'],
  'identical occurrences must remain in the ordered snapshot',
);
assert.equal(messageSnapshot.payload_json.messages[0].platform_sent_at, undefined);
assert.equal(messageSnapshot.payload_json.messages[0].time_label, undefined);
assert.equal(messageSnapshot.payload_json.legacy_projection.message_count, 1);
const firstObservationId = messageSnapshot.payload_json.observation_id;
dualTrackAccount.runtime.ingest(dualTrackSnapshot);
assert.equal(
  dualTrackAccount.events.filter((event) => event.event_type === 'message_snapshot').length,
  1,
  'retrying the same adapter snapshot must preserve event idempotency',
);
assert.equal(messageSnapshot.payload_json.observation_id, firstObservationId);

const splitSnapshot = structuredClone(dualTrackSnapshot);
splitSnapshot.snapshot_id = 'snapshot-split';
splitSnapshot.conversations[0].snapshot_messages = Array.from({ length: 101 }, (_, index) => ({
  dom_sequence: index,
  platform_message_id: null,
  sender_role: index % 2 ? 'agent' : 'customer',
  content: `message ${index}`,
  message_type: 'text',
  image_url: null,
}));
const splitAccount = createRuntime('local-split', { value: 'platform-split' });
splitAccount.runtime.ingest(splitSnapshot);
const splitEvents = splitAccount.events.filter((event) => event.event_type === 'message_snapshot');
assert.equal(splitEvents.length, 3);
assert.deepEqual(splitEvents.map((event) => event.payload_json.message_offset), [0, 50, 100]);
assert.deepEqual(splitEvents.map((event) => event.payload_json.messages.length), [50, 50, 1]);
assert.equal(new Set(splitEvents.map((event) => event.payload_json.observation_id)).size, 1);
assert.equal(new Set(splitEvents.map((event) => event.payload_json.payload_hash)).size, 1);

const disabledAccount = createRuntime(
  'local-disabled',
  { value: 'platform-disabled' },
  { snapshotShadowEnabled: false },
);
disabledAccount.runtime.ingest(dualTrackSnapshot);
assert.equal(disabledAccount.events.some((event) => event.event_type === 'message_snapshot'), false);

const imageSnapshot = structuredClone(snapshot);
imageSnapshot.snapshot_id = 'snapshot-image';
imageSnapshot.conversations[0].messages = [{
  platform_message_id: 'image-message-100',
  sender_role: 'customer',
  content: '[image]',
  message_type: 'image',
  image_url: 'https://img.example.com/customer-image.png',
  platform_sent_at: null,
  snapshot_sequence: 4,
  time_group_index: 1,
  time_label: null,
  has_explicit_time: false,
}];
const imageAccount = createRuntime('local-image', { value: 'platform-image' });
imageAccount.runtime.ingest(imageSnapshot);
assert.equal(imageAccount.events[1].payload_json.media_type, 'image');
assert.equal(imageAccount.events[1].payload_json.image_url, 'https://img.example.com/customer-image.png');

accountA.runtime.ingest(snapshot);
assert.equal(accountA.events.length, 2, '重复 DOM 快照必须在本机去重');

accountA.runtime.suppressConversation('platform-a', 'buyer-100');
const suppressedSnapshot = structuredClone(snapshot);
suppressedSnapshot.snapshot_id = 'snapshot-suppressed';
accountA.runtime.ingest(suppressedSnapshot);
assert.equal(accountA.events.length, 2, 'reset preparation must suppress target conversation events');
accountA.runtime.releaseConversation('platform-a', 'buyer-100');
accountA.runtime.ingest(suppressedSnapshot);
assert.equal(accountA.events.length, 4, 'released conversation must emit a fresh baseline');

const bindingB = { value: 'platform-b' };
const accountB = createRuntime('local-b', bindingB);
accountB.runtime.ingest(snapshot);
assert.equal(accountB.events.length, 2);
assert.notEqual(
  accountA.events[1].dedup_key,
  accountB.events[1].dedup_key,
  '两个店铺的相同平台会话和消息 ID 必须保持隔离',
);

const duplicateDomSnapshot = structuredClone(snapshot);
duplicateDomSnapshot.snapshot_id = 'snapshot-duplicate-dom';
duplicateDomSnapshot.conversations[0].messages = [
  {
    platform_message_id: null,
    sender_role: 'customer',
    content: 'same customer message',
    message_type: 'text',
    platform_sent_at: '2026-07-27T10:00:34.000Z',
    snapshot_sequence: 0,
    time_group_index: 0,
    time_label: null,
    has_explicit_time: false,
  },
  {
    platform_message_id: null,
    sender_role: 'customer',
    content: 'same customer message',
    message_type: 'text',
    platform_sent_at: '2026-07-27T10:00:34.000Z',
    snapshot_sequence: 1,
    time_group_index: 0,
    time_label: null,
    has_explicit_time: false,
  },
  {
    platform_message_id: 'middlePanel_list_100',
    sender_role: 'customer',
    content: 'same customer message',
    message_type: 'text',
    platform_sent_at: '2026-07-28T08:00:00.000Z',
    snapshot_sequence: 14,
    time_group_index: 2,
    time_label: '2026-07-28 16:00:00',
    has_explicit_time: true,
  },
];
const duplicateDomAccount = createRuntime('local-duplicate', { value: 'platform-duplicate' });
duplicateDomAccount.runtime.ingest(duplicateDomSnapshot);
const duplicateDomMessages = duplicateDomAccount.events.filter(
  (event) => event.event_type === 'message_received',
);
assert.equal(duplicateDomMessages.length, 2, 'identical fallback candidates must emit once');
assert.equal(duplicateDomMessages[1].platform_message_id, 'middlePanel_list_100');

const diagnosticDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'pdd-diagnostic-logger-'));
try {
  const logger = new PddDiagnosticLogger(diagnosticDirectory);
  logger.write('local-account-100', {
    observed_at: '2026-07-28T08:01:00.000Z',
    level: 'warn',
    stage: 'test_stage',
    details: {
      conversation_count: 2,
      token: 'must-not-be-written',
      nested: {
        cookie_value: 'must-not-be-written-either',
        active: true,
      },
    },
  });
  await logger.flush();

  const logPath = path.join(diagnosticDirectory, 'pinduoduo-collector.log');
  assert.equal(fs.existsSync(logPath), true, 'diagnostic log must be created after flush');
  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1, 'each diagnostic event must be stored as one JSON line');
  const record = JSON.parse(lines[0]);
  assert.equal(record.account_id, 'local-account-100');
  assert.equal(record.stage, 'test_stage');
  assert.equal(record.level, 'warn');
  assert.equal(record.details.conversation_count, 2);
  assert.equal(record.details.token, '[redacted]');
  assert.equal(record.details.nested.cookie_value, '[redacted]');
  assert.equal(record.details.nested.active, true);
  assert.equal(fs.readFileSync(logPath, 'utf8').includes('must-not-be-written'), false);
} finally {
  fs.rmSync(diagnosticDirectory, { recursive: true, force: true });
}

console.log(JSON.stringify({ status: 'passed', events_per_account: accountA.events.length }));
