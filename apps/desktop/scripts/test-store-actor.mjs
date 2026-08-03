import assert from 'node:assert/strict';
import { SerialTaskQueue } from '../electron/platform-workspace/serial-task-queue.js';
import { StoreActor } from '../electron/platform-workspace/store-actor.js';

const sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration));

const serialEvents = [];
const actor = new StoreActor({
  accountId: 'store-a',
  rescan: async () => serialEvents.push('rescan'),
});
const first = actor.enqueue('collect_unread', async () => {
  serialEvents.push('first:start');
  await sleep(20);
  serialEvents.push('first:end');
});
const second = actor.enqueue('send_reply_bundle', async () => {
  serialEvents.push('second:start');
  await sleep(5);
  serialEvents.push('second:end');
});
await Promise.all([first, second]);
assert.deepEqual(serialEvents, [
  'first:start',
  'first:end',
  'rescan',
  'second:start',
  'second:end',
  'rescan',
]);

let releaseStoreA;
const storeAGate = new Promise((resolve) => { releaseStoreA = resolve; });
const concurrencyEvents = [];
const storeA = new StoreActor({ accountId: 'store-a', rescan: async () => {} });
const storeB = new StoreActor({ accountId: 'store-b', rescan: async () => {} });
const storeATask = storeA.enqueue('send_message', async () => {
  concurrencyEvents.push('a:start');
  await storeAGate;
  concurrencyEvents.push('a:end');
});
const storeBTask = storeB.enqueue('send_message', async () => {
  concurrencyEvents.push('b:start');
  concurrencyEvents.push('b:end');
});
await sleep(5);
assert.deepEqual(concurrencyEvents, ['a:start', 'b:start', 'b:end']);
releaseStoreA();
await Promise.all([storeATask, storeBTask]);

let rescanCount = 0;
let releaseBusyTask;
const busyGate = new Promise((resolve) => { releaseBusyTask = resolve; });
const rescanActor = new StoreActor({
  accountId: 'store-rescan',
  rescan: async () => { rescanCount += 1; },
});
const busyTask = rescanActor.enqueue('send_reply_bundle', async () => {
  await busyGate;
});
await sleep(1);
rescanActor.requestRescan('mutation-1');
rescanActor.requestRescan('mutation-2');
rescanActor.requestRescan('interval');
releaseBusyTask();
await busyTask;
assert.equal(rescanCount, 1, 'busy-period rescans and post-task rescan must coalesce');

let collectRuns = 0;
let releaseCollect;
const collectGate = new Promise((resolve) => { releaseCollect = resolve; });
const coalescingActor = new StoreActor({ accountId: 'store-coalesce', rescan: async () => {} });
const collectOne = coalescingActor.enqueue('collect_unread', async () => {
  collectRuns += 1;
  await collectGate;
  return 'collected';
}, { coalesceKey: 'collect_unread' });
await sleep(1);
const collectTwo = coalescingActor.enqueue(
  'collect_unread',
  async () => { collectRuns += 1; },
  { coalesceKey: 'collect_unread' },
);
assert.equal(collectOne, collectTwo);
releaseCollect();
assert.equal(await collectTwo, 'collected');
assert.equal(collectRuns, 1);

let releaseCurrentTask;
const currentGate = new Promise((resolve) => { releaseCurrentTask = resolve; });
const cancelledActor = new StoreActor({ accountId: 'store-cancel', rescan: async () => {} });
const currentTask = cancelledActor.enqueue('send_message', () => currentGate);
const queuedTask = cancelledActor.enqueue('send_image', async () => {});
await sleep(1);
cancelledActor.cancel('view destroyed');
await assert.rejects(currentTask, /view destroyed/);
await assert.rejects(queuedTask, /view destroyed/);
releaseCurrentTask();

const clipboardQueue = new SerialTaskQueue();
let clipboardOwners = 0;
const clipboardEvents = [];
const clipboardTask = (store, duration) => clipboardQueue.run(async () => {
  clipboardOwners += 1;
  assert.equal(clipboardOwners, 1, 'clipboard critical sections must not overlap');
  clipboardEvents.push(`${store}:start`);
  await sleep(duration);
  clipboardEvents.push(`${store}:end`);
  clipboardOwners -= 1;
});
await Promise.all([clipboardTask('a', 10), clipboardTask('b', 1)]);
assert.deepEqual(clipboardEvents, ['a:start', 'a:end', 'b:start', 'b:end']);

console.log(JSON.stringify({ status: 'passed', scenarios: 6 }));
