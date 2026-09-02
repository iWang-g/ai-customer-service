const fs = require('fs');

const file = process.argv[2] || 'qn-im-hook-events.ndjson';
const limit = Number(process.argv[3] || 50);

function parseJson(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function visit(value, out) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) visit(item, out);
    return;
  }

  const text = value.originalData && value.originalData.text;
  const ccode = value.cid && value.cid.ccode;
  const mcode = value.mcode || {};
  if (text || ccode || mcode.clientId || mcode.messageId) {
    out.push({
      text: text || '',
      cid: ccode || '',
      clientId: mcode.clientId || '',
      messageId: mcode.messageId || '',
      sendTime: value.sendTime || '',
      fromNick: value.fromid && value.fromid.nick || '',
      fromId: value.fromid && value.fromid.targetId || '',
      toNick: value.toid && value.toid.nick || '',
      toId: value.toid && value.toid.targetId || '',
      loginNick: value.loginid && value.loginid.nick || '',
      loginId: value.loginid && value.loginid.targetId || '',
    });
  }

  for (const child of Object.values(value)) visit(child, out);
}

const seen = new Set();
const rows = [];
for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
  if (!line.trim()) continue;
  const event = parseJson(line);
  const body = parseJson(event && event.body);
  if (!body) continue;

  const args = Array.isArray(body.args) ? body.args : [];
  for (const arg of args) {
    const parsed = parseJson(arg);
    if (!parsed) continue;
    const found = [];
    visit(parsed, found);
    for (const row of found) {
      const key = [row.cid, row.clientId, row.messageId, row.sendTime, row.text].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ hookTime: event.time, kind: body.kind, ...row });
    }
  }
}

console.log(JSON.stringify(rows.slice(0, limit), null, 2));
console.error(`extracted=${rows.length}`);
