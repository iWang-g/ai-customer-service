'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const log = path.join(root, '.tmp/qn-native-submit-probe/completion-once-v3-live-20260907.log');
if (process.argv[2] !== 'QN_OBSERVE_AND_UI_SEND_ONCE' || process.argv.length !== 3) process.exit(2);
const fd = fs.openSync(log, 'wx');
const observer = spawn(path.join(__dirname, 'build/qn_completion_once_probe_v3.exe'),
  ['--observe-once', 'QN_COMPLETION_OBSERVE_ONCE'], { cwd: root, windowsHide: true });
let pending = '', sendPromise = null, output = '';
observer.stdout.on('data', data => {
  fs.writeSync(fd, data); process.stdout.write(data); output += data; pending += data;
  const lines = pending.split(/\r?\n/); pending = lines.pop();
  for (const line of lines) if (line.startsWith('ARMED ') && !sendPromise) {
    sendPromise = new Promise(resolve => {
      const child = spawn(process.execPath, [path.join(__dirname, 'run-completion-test-message.cjs'), 'QN_NATIVE_NEW_TEST_ONCE'],
        { cwd: root, windowsHide: true, stdio: 'inherit' });
      child.on('error', () => resolve(1)); child.on('close', code => resolve(code ?? 1));
    });
  }
});
observer.stderr.on('data', data => { fs.writeSync(fd, data); process.stderr.write(data); });
observer.on('error', error => { console.error(error.message); process.exitCode = 1; });
observer.on('close', async code => {
  fs.closeSync(fd);
  const sendCode = sendPromise ? await sendPromise : 1;
  console.log(JSON.stringify({ observerExit: code, sendExit: sendCode, snapshotCaptured: /hits=1 snapshot_ready=1 snapshot_status=0 /.test(output) }));
  process.exitCode = code === 0 && sendCode === 0 && /hits=1 snapshot_ready=1 snapshot_status=0 /.test(output) ? 0 : 1;
});
