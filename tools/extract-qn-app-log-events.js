const fs = require('fs');

const defaultFiles = [
  'D:\\AliWorkbenchData\\System\\log\\app.log',
  'D:\\AliWorkbenchData\\System\\log\\app.log.old',
];

const args = process.argv.slice(2);
const csv = args.includes('--csv');
const files = args.filter((arg) => arg !== '--csv');
if (!files.length) files.push(...defaultFiles);

function parseChat(chat) {
  const parts = String(chat || '').split('#');
  return {
    userNick: parts[0] || '',
    loginTargetType: parts[1] || '',
    loginId: parts[2] || '',
  };
}

function extractJsonAfter(line, marker) {
  const start = line.indexOf(marker);
  if (start < 0) return null;

  let i = start + marker.length;
  while (i < line.length && /\s/.test(line[i])) i += 1;
  const open = line[i];
  const close = open === '{' ? '}' : open === '[' ? ']' : '';
  if (!close) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let j = i; j < line.length; j += 1) {
    const ch = line[j];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === open) {
      depth += 1;
    } else if (ch === close) {
      depth -= 1;
      if (depth === 0) return line.slice(i, j + 1);
    }
  }
  return null;
}

function parseLine(line, lineNo, sourceFile) {
  if (!line.includes('[onEventNotify]') && !line.includes('[onInvokeNotify]')) return null;

  const timeMatch = line.match(/^\[(\d\d-\d\d \d\d:\d\d:\d\d)/);
  const chatMatch = line.match(/\[CHAT ([^\]]+)\]/);
  const eventMatch = line.match(/strEvent=([^,\]]+)/);
  const jsonText = extractJsonAfter(line, 'jsonStr=');
  if (!jsonText) return null;

  let payload;
  try {
    payload = JSON.parse(jsonText);
  } catch {
    return null;
  }

  return {
    sourceFile,
    lineNo,
    logTime: timeMatch ? timeMatch[1] : '',
    chat: chatMatch ? chatMatch[1].trim() : '',
    event: eventMatch ? eventMatch[1].trim() : '',
    payload,
  };
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.length) return value;
  }
  return '';
}

function textFromOriginalData(originalData) {
  if (!originalData || typeof originalData !== 'object') return '';
  const direct = firstText(originalData.text, originalData.message, originalData.content);
  if (direct) return direct;

  for (const view of asArray(originalData.jsview)) {
    const value = view && view.value;
    const text = value && firstText(value.text, value.content);
    if (text) return text;
  }
  return '';
}

function idObject(value) {
  return value && typeof value === 'object' ? value : {};
}

function cidCode(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return value.ccode || value.code || '';
}

function cidMeta(value) {
  if (!value || typeof value !== 'object') return {};
  return {
    cidNick: value.nick || '',
    cidDomain: value.domain || '',
    cidTargetId: value.targetId || '',
  };
}

function buildRow(item, base, messageOverride) {
  const hasMessageOverride = Boolean(messageOverride);
  const msg = messageOverride || item;
  const latest = idObject(item.latestmsg);
  const from = idObject(msg.fromId || msg.fromid || item.fromId || item.fromid);
  const to = idObject(msg.toId || msg.toid || item.toId || item.toid);
  const mcode = idObject(msg.mcode || item.mcode);
  const latestMcode = idObject(latest.mcode);
  const loginId = base.loginId || '';

  let direction = '';
  if (loginId && from.targetId === loginId) direction = 'outgoing';
  else if (loginId && to.targetId === loginId) direction = 'incoming';
  else if (/LocalSend|onSendNewMsg|onMsgSendUpdate/.test(base.event)) direction = 'outgoing';
  else if (/Receive|Recerive/.test(base.event)) direction = 'incoming';

  const other = direction === 'outgoing' ? to : direction === 'incoming' ? from : {};
  const cid = cidCode(item.cid || msg.cid) || item.ccode || msg.ccode || '';
  const meta = cidMeta(item.cid || msg.cid);
  const buyerNick = other.nick || meta.cidNick || item.nick || msg.nick || '';
  const buyerUid = other.targetId || meta.cidTargetId || item.targetId || msg.targetId || '';
  const text = firstText(
    textFromOriginalData(msg.originalData),
    textFromOriginalData(item.originalData),
    msg.text,
    msg.message,
    item.text,
    item.message,
  );

  return {
    source: base.sourceFile,
    lineNo: base.lineNo,
    logTime: base.logTime,
    userNick: base.userNick,
    loginId: base.loginId,
    cid,
    event: base.event,
    direction,
    buyerNick,
    buyerUid,
    bizType: item.bizType || item.bizeType || msg.bizType || msg.bizeType || '',
    clientId: mcode.clientId || msg.clientId || item.clientId || (!hasMessageOverride ? latestMcode.clientId : ''),
    messageId: mcode.messageId || msg.messageId || item.messageId || (!hasMessageOverride ? latestMcode.messageId : ''),
    sendTime: msg.sendTime || item.sendTime || latest.sendTime || '',
    text,
    fromNick: from.nick || '',
    fromId: from.targetId || '',
    toNick: to.nick || '',
    toId: to.targetId || '',
    unreadCount: item.unreadcount ?? '',
    value: typeof item.value === 'undefined' ? '' : item.value,
  };
}

function collectRows(event) {
  const chat = parseChat(event.chat);
  const base = {
    sourceFile: event.sourceFile,
    lineNo: event.lineNo,
    logTime: event.logTime,
    event: event.event,
    userNick: chat.userNick,
    loginId: chat.loginId,
  };

  const rows = [];
  for (const item of asArray(event.payload)) {
    if (!item || typeof item !== 'object') continue;

    if (Array.isArray(item.newmsgs) && item.newmsgs.length) {
      for (const message of item.newmsgs) rows.push(buildRow(item, base, message));
      continue;
    }

    if (item.result && Array.isArray(item.result.msgs)) {
      for (const message of item.result.msgs) rows.push(buildRow(message, base));
      continue;
    }

    rows.push(buildRow(item, base));
  }
  return rows;
}

function hasUsefulData(row) {
  return Boolean(row.cid || row.clientId || row.messageId || row.sendTime || row.text || row.buyerNick || row.buyerUid);
}

function csvEscape(value) {
  const s = String(value ?? '');
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

const columns = [
  'source',
  'lineNo',
  'logTime',
  'userNick',
  'loginId',
  'cid',
  'event',
  'direction',
  'buyerNick',
  'buyerUid',
  'bizType',
  'clientId',
  'messageId',
  'sendTime',
  'text',
  'fromNick',
  'fromId',
  'toNick',
  'toId',
  'unreadCount',
  'value',
];

const rows = [];
const seen = new Set();
for (const file of files) {
  if (!fs.existsSync(file)) continue;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    const event = parseLine(line, index + 1, file);
    if (!event) return;
    for (const row of collectRows(event)) {
      if (!hasUsefulData(row)) continue;
      const key = [
        row.source,
        row.lineNo,
        row.event,
        row.cid,
        row.clientId,
        row.messageId,
        row.sendTime,
        row.text,
        row.value,
      ].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }
  });
}

if (csv) {
  console.log(columns.join(','));
  for (const row of rows) console.log(columns.map((column) => csvEscape(row[column])).join(','));
} else {
  for (const row of rows) console.log(JSON.stringify(row));
}

console.error(`rows=${rows.length}`);
