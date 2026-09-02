const fs = require('fs');

const file = process.argv[2] || 'qn-im-bridge-hook-v2.ndjson';
const textFilter = process.argv[3] || '';

function parseJson(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function contains(value, needle) {
  if (!needle) return true;
  try {
    return JSON.stringify(value).includes(needle);
  } catch {
    return false;
  }
}

const rows = [];
for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
  if (!line.trim()) continue;
  const outer = parseJson(line);
  const body = parseJson(outer && outer.body);
  if (!body || !contains(body, textFilter)) continue;

  if (body.kind === 'bridge.hook.installed') {
    rows.push({
      serverTime: outer.time,
      kind: body.kind,
      page: body.page,
      version: body.version,
      chatType: body.state && body.state.chatType,
      cid: body.state && body.state.conversationID && body.state.conversationID.ccode,
      keys: body.workbenchKeys,
    });
    continue;
  }

  if (body.kind === 'workbench.invoke.call') {
    rows.push({
      serverTime: outer.time,
      kind: body.kind,
      namespace: body.namespace,
      cmd: body.cmd,
      id: body.id,
      cid: body.state && body.state.conversationID && body.state.conversationID.ccode,
      param: body.param,
      other: body.other,
    });
    continue;
  }

  if (body.kind === 'bridge.invoke.result' || body.kind === 'bridge.invoke.error') {
    rows.push({
      serverTime: outer.time,
      kind: body.kind,
      method: body.method,
      paramCid: body.paramCid,
      resultCode: body.resultCode,
      messages: body.messages,
      error: body.error,
    });
  }
}

console.log(JSON.stringify(rows, null, 2));
console.error(`rows=${rows.length}`);
