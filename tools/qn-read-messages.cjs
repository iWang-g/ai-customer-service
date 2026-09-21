'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const base = 'http://127.0.0.1:18082/qn-bridge';
async function json(url, body) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000), ...(body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${result.error || 'bridge request failed'}`);
  return result;
}
async function readMessages(shopUid, cid, { count = 20, timeoutMs = 30000 } = {}) {
  assert.match(shopUid, /^\d+$/); assert.match(cid, /^\d+\.1-\d+\.1#11001@cntaobao$/);
  assert.ok(Number.isInteger(count) && count >= 1 && count <= 20);
  const { clients } = await json(`${base}/clients`);
  const matches = clients.filter(c => c.state?.loginID?.targetId === shopUid && c.readMessagesVersion === 1 &&
    (c.waiting || Date.now() - Date.parse(c.lastSeen) < 30000));
  assert.equal(matches.length, 1, 'expected one live updated page for shop');
  const clientId = matches[0].clientId;
  const { command } = await json(`${base}/command`, { clientId, cmd: 'readMessages', param: { shopUid, cid, count } });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
    const { result } = await json(`${base}/results?commandId=${encodeURIComponent(command.id)}`);
    if (!result) continue;
    if (!result.ok) throw new Error(`readMessages failed: ${JSON.stringify(result.value)}`);
    assert.equal(result.clientId, clientId); assert.equal(result.state?.loginID?.targetId, shopUid);
    const value = result.value;
    assert.equal(value.shopUid, shopUid); assert.equal(value.cid, cid);
    assert.ok(Array.isArray(value.messages)); assert.equal(value.count, value.messages.length);
    for (const msg of value.messages) { assert.equal(msg.cid, cid); assert.equal(msg.shopUid, shopUid); }
    return { ...value, clientId, commandId: command.id, readAt: result.at };
  }
  throw new Error('readMessages timed out; current conversation was not opened or changed');
}
if (require.main === module) {
  const [shopUid, cid, out] = process.argv.slice(2);
  if (!shopUid || !cid || process.argv.length > 5) {
    console.error('Usage: node tools/qn-read-messages.cjs <shopUid> <cid> [output.json]'); process.exitCode = 2;
  } else readMessages(shopUid, cid).then(result => {
    if (out) {
      fs.writeFileSync(path.resolve(out), JSON.stringify(result, null, 2), { flag: 'wx' });
      console.log(JSON.stringify({ shopUid, cid, count: result.count, currentCidBefore: result.currentCidBefore,
        currentCidAfter: result.currentCidAfter, output: path.resolve(out) }));
    } else console.log(JSON.stringify(result, null, 2));
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { readMessages };
