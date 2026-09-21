'use strict';
const fs = require('node:fs');
const path = require('node:path');

async function run(action = 'status', options = {}) {
  if (!['status', 'read'].includes(action)) throw new Error('Usage: node tools/qn-media-probe/client.cjs [status|read]');
  const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../.tmp/qn-media-probe/config.json'), 'utf8'));
  async function request(route, body = {}) {
    const response = await fetch(config.base + route, { method: 'POST', signal: AbortSignal.timeout(5000),
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, token: config.token }) });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || 'probe request failed');
    return value;
  }
  if (action === 'status') return request('/status');
  const { job } = await request('/arm', options);
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 250));
    const state = await request('/status');
    if (state.job?.id !== job.id) throw new Error('probe job changed');
    if (state.job.state === 'done') return state.job;
  }
  throw new Error('probe result timeout; inspect status before starting another read');
}
if (require.main === module) run(process.argv[2]).then(value => console.log(JSON.stringify(value, null, 2)))
  .catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { run };
