'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { identity, validateUnselected, windowEvidence } = require('./direct-send-unselected-once.cjs');
test('unselected proof must agree with native bridge recipient', () => {
  const login = { state: { loginID: { targetId: '2222303856223' } } };
  const active = { state: { ...login.state, conversationID: { targetId: 'other', ccode: 'other-cid' } },
    value: { securityUID: 'other', cid: 'other-cid' } };
  validateUnselected(login, active);
  assert.throws(() => validateUnselected(login, { ...active, value: { securityUID: '2214525969878', cid: 'other-cid' } }));
  assert.throws(() => validateUnselected(login, { ...active, value: { securityUID: 'other', cid: 'mismatch' } }));
  assert.throws(() => validateUnselected({ state: {} }, active));
});
test('minimized verification refuses restoration or incomplete observation', () => {
  const good = 'WINDOW_WATCH ready=1 baseline_minimized=1 final_minimized=1 samples=100 ' +
    'not_minimized_samples=0 invalid_window_samples=0 restore_events=0 target_foreground_events=0 foreground_changed_samples=0 interval_ms=5';
  assert.equal(windowEvidence(good).samples, 100);
  for (const field of ['restore_events', 'not_minimized_samples', 'invalid_window_samples', 'target_foreground_events'])
    assert.throws(() => windowEvidence(good.replace(`${field}=0`, `${field}=1`)));
  assert.throws(() => windowEvidence(good.replace('baseline_minimized=1', 'baseline_minimized=0')));
  assert.throws(() => windowEvidence(good.replace('samples=100', 'samples=1')));
  assert.throws(() => windowEvidence(''));
});
test('process creation identity is lossless and required', () => {
  assert.deepEqual(identity('ADMISSION pid=36124 tid=29752 created=134330727293831632 hwnd=0xaa0a4c'),
    { pid: '36124', tid: '29752', created: '134330727293831632' });
  assert.throws(() => identity('RESULT success=1'));
});
