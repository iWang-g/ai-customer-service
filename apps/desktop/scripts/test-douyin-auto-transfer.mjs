import test from 'node:test';
import assert from 'node:assert/strict';
import { DouyinTransferController } from '../electron/platform-workspace/douyin/transfer-controller.js';

function fixture() {
  const reports = [], calls = [];
  const manager = { userId: 'u', closing: false,
    rpaManager: { completeTask: (...args) => reports.push(args) } };
  const controller = new DouyinTransferController(manager);
  const task = { id: 't', user_id: 'u', platform_account_id: 'a', conversation_id: 'c',
    task_type: 'douyin_transfer_prepare', payload_json: { douyin_auto_operation_id: 'op' } };
  const c = { userId: 'u', platformAccountId: 'a', shopId: '123', conversationId: 'c',
    localAccountId: 'local', transfer: { id: 'op', target_id: '222' } };
  controller.context = async (id, autoTask) => { calls.push(['context', id, autoTask]); return c; };
  controller.frame = async () => ({});
  controller.execute = async () => ({ targets: [{ id: '222', name: '盼盼' }, { id: '333', name: '隐居' }] });
  return { controller, task, c, reports, calls };
}

test('no online staff completes without transfer or notice, allowing backend nonblocking outcome', async () => {
  const f = fixture();
  f.controller.execute = async () => ({ targets: [] });
  f.controller.transfer = () => assert.fail('must not transfer');
  await f.controller.handleTask(f.task);
  assert.deepEqual(f.reports, [['t', 'completed', { status: 'no_online_target' }]]);
});

test('preparation rotates verified staff and execution keeps the saved target', async () => {
  const f = fixture();
  assert.equal((await f.controller.automatic(f.task)).target.id, '222');
  assert.equal((await f.controller.automatic(f.task)).target.id, '333');
  f.controller.transfer = async args => {
    assert.equal(args.autoTaskId, 't');
    assert.equal(f.controller.choices.get(args.targetCsid).target.id, '222');
    return { status: 'transferred' };
  };
  assert.equal((await f.controller.automatic({ ...f.task, task_type: 'douyin_transfer_execute' })).status, 'transferred');
});

test('target offline after notice never silently selects another staff member', async () => {
  const f = fixture();
  f.controller.execute = async () => ({ targets: [{ id: '333', name: '隐居' }] });
  f.controller.transfer = () => assert.fail('must not transfer');
  await assert.rejects(f.controller.automatic({ ...f.task, task_type: 'douyin_transfer_execute' }), /不在线/);
  f.controller.execute = async () => ({ targets: [] });
  assert.equal((await f.controller.automatic({ ...f.task, task_type: 'douyin_transfer_execute' })).status, 'no_online_target');
});

test('duplicate tasks in flight share one operation and one completion', async () => {
  const f = fixture();
  let release;
  f.controller.execute = async () => { await new Promise(resolve => { release = resolve; }); return { targets: [] }; };
  const first = f.controller.handleTask(f.task), second = f.controller.handleTask(f.task);
  assert.equal(first, second);
  await new Promise(resolve => setImmediate(resolve));
  release(); await first;
  assert.equal(f.reports.length, 1);
});

test('mismatched operation and account are rejected before page execution', async () => {
  for (const patch of [{ platform_account_id: 'wrong' }, { payload_json: { douyin_auto_operation_id: 'old' } }]) {
    const f = fixture();
    f.controller.execute = () => assert.fail('must not read page');
    await assert.rejects(f.controller.automatic({ ...f.task, ...patch }), /身份不匹配/);
  }
});
