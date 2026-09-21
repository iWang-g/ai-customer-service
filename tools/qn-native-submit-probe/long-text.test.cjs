'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { validateRequest } = require('../qn-direct-send-service.cjs');
const exe = path.join(__dirname, 'build/qn_direct_general_probe_v3.exe');
test('compiled native UTF-16 to UTF-8 boundary agrees with JS, without touching Qianniu', () => {
  for (const [text, valid] of [['中'.repeat(122), true], ['a'.repeat(4095), true], ['中'.repeat(1365), true],
    ['😀'.repeat(1023) + '中', true], ['a'.repeat(4096), false], ['中'.repeat(1366), false],
    ['😀'.repeat(1024), false], ['', false], ['a\nb', true], ['a\n\nb', true], ['a\rb', false]]) {
    const result = spawnSync(exe, ['--validate-text', text], { encoding: 'utf8', windowsHide: true });
    assert.ifError(result.error);
    assert.equal(result.status, valid ? 0 : 2, result.stdout + result.stderr);
    assert.match(result.stdout, /sdk_send=0/);
    if (valid) {
      assert.equal(validateRequest('123', '456.1-789.1#11001@cntaobao', text).text, text);
      assert.match(result.stdout, new RegExp('bytes=' + Buffer.byteLength(text) + ' capacity=4096'));
    } else assert.throws(() => validateRequest('123', '456.1-789.1#11001@cntaobao', text));
  }
});
