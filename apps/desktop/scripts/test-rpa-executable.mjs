import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { serializeRpaCommand } from '../electron/rpa/process-manager.js';

const desktopDirectory = path.resolve(import.meta.dirname, '..');
const executablePath = path.resolve(desktopDirectory, '..', '..', 'agents', 'rpa', 'dist', 'rpa-agent.exe');
assert.ok(fs.existsSync(executablePath), `RPA executable is missing: ${executablePath}`);

const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-rpa-exe-smoke-'));
const secret = 'release-smoke-secret';
let syncedAccount = null;
const server = http.createServer((request, response) => {
  let body = '';
  request.setEncoding('utf8');
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (request.url === '/api/v1/rpa/nodes/register') {
      response.end(JSON.stringify({
        node: { id: 'smoke-node' },
        node_token: 'smoke-node-token',
        heartbeat_interval_seconds: 30,
      }));
      return;
    }
    if (request.url === '/api/v1/rpa/platform-accounts/sync') {
      const payload = JSON.parse(body);
      if (payload.accounts.length === 0) {
        response.end('[]');
        return;
      }
      syncedAccount = payload.accounts[0];
      response.end(JSON.stringify([{
        id: 'smoke-platform-account',
        local_account_id: syncedAccount.local_account_id,
        login_status: syncedAccount.login_status,
      }]));
      return;
    }
    if (request.url?.startsWith('/api/v1/rpa/tasks/pending')) {
      response.end('[]');
      return;
    }
    response.statusCode = 404;
    response.end('{}');
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address === 'object');
const child = spawn(executablePath, [], {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
  env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
});
let stdoutBuffer = '';
let stderrBuffer = '';

const result = new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error(`RPA smoke test timed out. stderr: ${stderrBuffer}`)), 15000);
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderrBuffer += chunk; });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      assert.equal(message.secret, secret);
      if (message.type === 'agent_started') {
        child.stdin.write(`${serializeRpaCommand({
          type: 'sync_accounts',
          secret,
          accounts: [{
            id: 'local-account',
            platform_code: 'pinduoduo',
            alias: '中文店铺',
            account_name: '主账号',
            login_status: 'online',
            metadata_json: {},
          }],
        })}\n`, 'ascii');
      }
      if (message.type === 'accounts_synced') {
        child.stdin.write(`${serializeRpaCommand({ type: 'shutdown', secret })}\n`, 'ascii');
      }
    }
  });
  child.once('error', reject);
  child.once('exit', (code) => {
    clearTimeout(timeout);
    if (code === 0) resolve();
    else reject(new Error(`RPA exited with ${code}. stderr: ${stderrBuffer}`));
  });
});

child.stdin.write(`${JSON.stringify({
  type: 'bootstrap',
  secret,
  api_base_url: `http://127.0.0.1:${address.port}/api/v1`,
  access_token: 'release-smoke-access-token',
  user_id: 'release-smoke-user',
  data_dir: dataDirectory,
  app_version: '1.0.0-smoke',
})}\n`);

try {
  await result;
  assert.ok(fs.existsSync(path.join(dataDirectory, 'events.db')));
  assert.equal(syncedAccount?.account_name, '主账号');
  assert.equal(syncedAccount?.account_alias, '中文店铺');
  console.log('RPA executable smoke test passed');
} finally {
  if (!child.killed) child.kill();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dataDirectory, { recursive: true, force: true });
}
