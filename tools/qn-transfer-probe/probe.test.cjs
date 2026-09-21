'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { TARGET, validateIdentity, buildAbilityParam, buildAbilityInvocation } = require('./protocol.cjs');

test('only the authorized shop, buyer, and online target are accepted', () => {
  assert.equal(validateIdentity(TARGET), true);
  for (const key of ['shopUid', 'buyerUid', 'targetUid', 'cid']) {
    assert.throws(() => validateIdentity({ ...TARGET, [key]: 'other' }), /Transfer target mismatch/);
  }
});

test('ability and MTOP parameters remain separate', () => {
  const ability = buildAbilityParam(TARGET);
  assert.deepEqual(ability, {
    contactID: TARGET.contactId, targetID: TARGET.targetContactId, contactSecurityUID: '',
    contactBizDomain: 'taobao', reason: '测试转接', options: '', tagName: ''
  });
  assert.deepEqual(buildAbilityInvocation(TARGET), { cmd: 'transferContact', param: ability });
});

test('target cannot be omitted or replaced by a nick', () => {
  assert.throws(() => buildAbilityParam({ ...TARGET, targetUid: '' }), /targetUid/);
  assert.throws(() => buildAbilityParam({ ...TARGET, targetUid: TARGET.targetNick }), /targetUid/);
});
