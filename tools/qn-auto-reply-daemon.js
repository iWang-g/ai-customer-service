const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { spawn } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const args = {
    hookLog: path.join(repoRoot, 'qn-im-bridge-hook-events.ndjson'),
    state: path.join(repoRoot, 'qn-auto-reply-state.jsonl'),
    logFile: path.join(repoRoot, 'qn-auto-reply-daemon.log'),
    reply: '您好，消息已收到，这边马上为您处理。',
    live: false,
    listen: false,
    port: 18082,
    controlMode: 'Ability',
    bridgeBase: 'http://127.0.0.1:18082/qn-bridge',
    submitScript: path.join(repoRoot, 'tools', 'qn-win32-submit-current.ps1'),
    replayLast: 0,
    once: false,
    idleExitMs: 0,
    timeoutSec: 30,
    heartbeatSec: 15,
    uiaMode: 'Scheduled',
    helperDir: path.join(repoRoot, 'qn-uia-helper'),
    coalesceMs: 5000,
    shop: '',
    conversation: '',
    cid: '',
    appLog: 'D:\\AliWorkbenchData\\System\\log\\app.log',
    wakeFromAppLog: true,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const readValue = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return argv[i];
    };

    if (arg === '--hook-log') args.hookLog = path.resolve(readValue());
    else if (arg === '--state') args.state = path.resolve(readValue());
    else if (arg === '--log-file') args.logFile = path.resolve(readValue());
    else if (arg === '--reply') args.reply = readValue();
    else if (arg === '--live') args.live = true;
    else if (arg === '--dry-run') args.live = false;
    else if (arg === '--listen') args.listen = true;
    else if (arg === '--no-listen') args.listen = false;
    else if (arg === '--port') args.port = Number(readValue());
    else if (arg === '--control-mode') args.controlMode = readValue();
    else if (arg === '--bridge-base') args.bridgeBase = readValue().replace(/\/$/, '');
    else if (arg === '--submit-script') args.submitScript = path.resolve(readValue());
    else if (arg === '--replay-last') args.replayLast = Number(readValue());
    else if (arg === '--once') args.once = true;
    else if (arg === '--idle-exit-ms') args.idleExitMs = Number(readValue());
    else if (arg === '--timeout-sec') args.timeoutSec = Number(readValue());
    else if (arg === '--heartbeat-sec') args.heartbeatSec = Number(readValue());
    else if (arg === '--uia-mode') args.uiaMode = readValue();
    else if (arg === '--helper-dir') args.helperDir = path.resolve(readValue());
    else if (arg === '--coalesce-ms') args.coalesceMs = Number(readValue());
    else if (arg === '--shop') args.shop = readValue();
    else if (arg === '--conversation') args.conversation = readValue();
    else if (arg === '--cid') args.cid = readValue();
    else if (arg === '--app-log') args.appLog = path.resolve(readValue());
    else if (arg === '--wake-from-app-log') args.wakeFromAppLog = true;
    else if (arg === '--no-wake-from-app-log') args.wakeFromAppLog = false;
    else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!['Direct', 'Scheduled', 'Helper'].includes(args.uiaMode)) {
    throw new Error(`Invalid --uia-mode: ${args.uiaMode}. Use Direct, Scheduled, or Helper.`);
  }
  if (!['Ability', 'UIA'].includes(args.controlMode)) {
    throw new Error(`Invalid --control-mode: ${args.controlMode}. Use Ability or UIA.`);
  }

  return args;
}

function printHelp() {
  console.log(`Usage:
  node tools/qn-auto-reply-daemon.js [options]

Options:
  --dry-run                 Parse and queue, but do not send. Default.
  --live                    Actually switch, insert, and send replies.
  --control-mode <mode>     Ability (default) or legacy UIA.
  --bridge-base <url>       Ability bridge base URL. Default http://127.0.0.1:18082/qn-bridge.
  --submit-script <path>    Win32 foreground Enter controller script.
  --listen                  Start the legacy hook receiver. Disabled by default.
  --no-listen               Tail the bridge server hook log. Default.
  --port <n>                Legacy HTTP receiver port. Default 18082.
  --reply <text>            Fixed reply text.
  --shop <name>             Only handle messages for this shop/login display.
  --conversation <name>     Only handle this visible conversation display.
  --cid <ccode>             Conversation ccode. Used for app.log wake when context is not loaded yet.
  --app-log <path>          Qianniu native app.log path. Default D:\\AliWorkbenchData\\System\\log\\app.log.
  --wake-from-app-log       Watch app.log and open known conversations on native message arrival. Default.
  --no-wake-from-app-log    Disable native app.log wake detection.
  --hook-log <path>         Hook NDJSON path.
  --state <path>            Processed-state JSONL path.
  --log-file <path>         Daemon text log path. Default qn-auto-reply-daemon.log.
  --replay-last <n>         Process the last n existing lines before tailing.
  --once                    Exit after first handled incoming message.
  --idle-exit-ms <n>        Exit after this idle time. Useful with replay tests.
  --timeout-sec <n>         Timeout passed to PowerShell send script.
  --heartbeat-sec <n>       Print alive status every n seconds. Default 15. Use 0 to disable.
  --uia-mode <mode>         Legacy UIA execution mode: Direct, Scheduled, or Helper.
  --helper-dir <path>       Legacy UIA Helper queue directory.
  --coalesce-ms <n>         Suppress duplicate replies for the same cid inside this window. Default 5000.
`);
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function hashText(value) {
  return crypto.createHash('sha1').update(String(value || ''), 'utf8').digest('hex').slice(0, 16);
}

function readJsonLine(line) {
  if (!line.trim()) return null;
  return JSON.parse(line);
}

function stripBom(text) {
  return String(text || '').replace(/^\uFEFF/, '');
}

function readJsonFile(filePath) {
  return JSON.parse(stripBom(fs.readFileSync(filePath, 'utf8')));
}

function parseHookBody(event) {
  if (!event || typeof event.body !== 'string' || !event.body.trim()) return null;
  return JSON.parse(event.body);
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

function parseAppLogChatPrefix(line) {
  const match = line.match(/\[(?:APP)?CHAT ([^\]]+)\]/);
  if (!match) return {};

  const parts = match[1].trim().split('#');
  return {
    display: (parts[0] || '').trim(),
    targetType: (parts[1] || '').trim(),
    targetId: (parts[2] || '').trim(),
  };
}

function normalizeContextShape(context) {
  const conversation = context && context.conversation ? context.conversation : {};
  const login = context && context.login ? context.login : {};
  return {
    conversation: {
      ccode: conversation.ccode || '',
      display: conversation.display || conversation.nick || '',
      nick: conversation.nick || '',
      targetId: conversation.targetId || '',
    },
    login: {
      display: login.display || login.nick || '',
      nick: login.nick || '',
      targetId: login.targetId || '',
      havMainId: login.havMainId || '',
    },
  };
}

function mergeContext(base, patch) {
  const left = normalizeContextShape(base);
  const right = normalizeContextShape(patch);
  return {
    conversation: {
      ccode: left.conversation.ccode || right.conversation.ccode || '',
      display: left.conversation.display || right.conversation.display || '',
      nick: left.conversation.nick || right.conversation.nick || '',
      targetId: left.conversation.targetId || right.conversation.targetId || '',
    },
    login: {
      display: left.login.display || right.login.display || '',
      nick: left.login.nick || right.login.nick || '',
      targetId: left.login.targetId || right.login.targetId || '',
      havMainId: left.login.havMainId || right.login.havMainId || '',
    },
  };
}

function contextSignature(context) {
  const normalized = normalizeContextShape(context);
  return [
    normalized.conversation.ccode,
    normalized.conversation.display,
    normalized.conversation.nick,
    normalized.conversation.targetId,
    normalized.login.display,
    normalized.login.nick,
    normalized.login.targetId,
    normalized.login.havMainId,
  ].join('|');
}

function extractAppLogContexts(line) {
  const contexts = [];
  const login = parseAppLogChatPrefix(line);
  const loginContext = login.display
    ? {
        display: login.display,
        nick: login.display,
        targetId: login.targetId || '',
      }
    : {};

  const pushContext = (conversation, updateLatest = false) => {
    if (!conversation || !conversation.ccode) return;
    contexts.push({
      context: {
        conversation: {
          ccode: conversation.ccode,
          display: conversation.display || conversation.nick || '',
          nick: conversation.nick || conversation.display || '',
          targetId: conversation.targetId || '',
        },
        login: loginContext,
      },
      updateLatest,
    });
  };

  const extractConversation = (value) => {
    if (!value || typeof value !== 'object') return null;
    const cid = value.cid && typeof value.cid === 'object' ? value.cid : {};
    const ccode = cid.ccode || value.ccode || '';
    if (!ccode) return null;
    return {
      ccode,
      display: cid.nick || value.display || value.nick || '',
      nick: cid.nick || value.nick || value.display || '',
      targetId: cid.targetId || value.targetId || '',
    };
  };

  const payloadText =
    extractJsonAfter(line, 'w_json_str=') ||
    extractJsonAfter(line, 'jsonStr=') ||
    extractJsonAfter(line, 'json=');

  if (payloadText) {
    try {
      const payload = JSON.parse(payloadText);
      const values = Array.isArray(payload) ? payload : [payload];
      for (const value of values) {
        if (!value || typeof value !== 'object') continue;
        if (Array.isArray(value.newmsgs)) {
          const conversation = extractConversation(value);
          if (conversation) pushContext(conversation, false);
          continue;
        }

        const conversation = extractConversation(value);
        if (conversation) {
          pushContext(conversation, /onConversationChange|OnBenchActiveConversationChange/.test(line));
        }
      }
    } catch {
      // Ignore malformed app.log payloads.
    }
  }

  const directCcode =
    /newConversation\.GetcCode\(\)=([^,\]\s]+)/.exec(line)?.[1] ||
    /oldConversion\.GetcCode\(\)=([^,\]\s]+)/.exec(line)?.[1] ||
    /AppConversation::ToUniqueID\(appConversationInfo\)=\d+\|([^,\]\s]+)/.exec(line)?.[1] ||
    /dmsg\.cid=([^,\]\s]+)/.exec(line)?.[1] ||
    '';

  if (directCcode) {
    pushContext(
      {
        ccode: directCcode,
        display: '',
        nick: '',
        targetId: '',
      },
      false,
    );
  }

  return contexts;
}

function getCcodeFromParam(param) {
  if (!param) return '';
  if (typeof param === 'string') return param;
  if (typeof param.ccode === 'string') return param.ccode;
  if (param.cid && typeof param.cid.ccode === 'string') return param.cid.ccode;
  if (param.ccode && typeof param.ccode.ccode === 'string') return param.ccode.ccode;
  if (Array.isArray(param)) {
    for (const item of param) {
      const ccode = getCcodeFromParam(item && (item.cid || item.ccode || item));
      if (ccode) return ccode;
    }
  }
  return '';
}

function normalizeContext(state) {
  return normalizeContextShape({
    conversation: state && state.conversationID ? state.conversationID : {},
    login: state && state.loginID ? state.loginID : {},
  });
}

function loadProcessed(statePath) {
  const processed = new Set();
  if (!fs.existsSync(statePath)) return processed;

  const content = fs.readFileSync(statePath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record && record.key) processed.add(record.key);
    } catch {
      // Ignore malformed old state lines.
    }
  }
  return processed;
}

function appendState(statePath, record) {
  ensureDir(statePath);
  fs.appendFileSync(statePath, JSON.stringify(record) + '\n', 'utf8');
}

function makeMessageKey(context, message) {
  const stableMessageId = message.messageId || message.clientId || '';
  const fallback = `${message.sendTime || ''}:${message.sortTimeMicrosecond || ''}:${hashText(message.text || '')}`;
  return [
    context.login.targetId || context.login.display || message.toNick || '',
    message.cid || context.conversation.ccode || '',
    stableMessageId || fallback,
  ].join('|');
}

function makeMessageRef(cid, messageIdOrClientId) {
  if (!cid || !messageIdOrClientId) return '';
  return `${cid}|${messageIdOrClientId}`;
}

function getIncomingMessageRef(message, context) {
  const cid = message.cid || context.conversation.ccode || '';
  const messageIdOrClientId = message.messageId || message.clientId || '';
  if (cid && messageIdOrClientId) {
    return makeMessageRef(cid, messageIdOrClientId);
  }
  if (!cid) return '';
  const fallback = `${message.sendTime || ''}:${message.sortTimeMicrosecond || ''}:${hashText(message.text || '')}`;
  return makeMessageRef(cid, fallback);
}

function inferTaskContext(contextByCid, latestContext, message) {
  const fromCid = contextByCid.get(message.cid || '') || {};
  const context = {
    conversation: {
      ccode: message.cid || fromCid.conversation?.ccode || latestContext.conversation?.ccode || '',
      display: fromCid.conversation?.display || message.fromNick || '',
      nick: fromCid.conversation?.nick || message.fromNick || '',
      targetId: fromCid.conversation?.targetId || message.fromId || '',
    },
    login: {
      display: fromCid.login?.display || message.toNick || latestContext.login?.display || '',
      nick: fromCid.login?.nick || message.toNick || latestContext.login?.nick || '',
      targetId: fromCid.login?.targetId || message.toId || latestContext.login?.targetId || '',
      havMainId: fromCid.login?.havMainId || latestContext.login?.havMainId || '',
    },
  };

  if (!context.conversation.display && message.fromNick) context.conversation.display = message.fromNick;
  if (!context.login.display && message.toNick) context.login.display = message.toNick;
  return context;
}

function shouldHandleMessage(args, context, message) {
  if (message.direction !== 'incoming') return false;
  if (!message.text && message.text !== '') return false;
  if (args.cid && context.conversation.ccode !== args.cid) return false;
  if (args.shop && context.login.display !== args.shop) return false;
  if (args.conversation && context.conversation.display !== args.conversation) return false;
  if (!context.conversation.ccode || !context.conversation.display || !context.login.display) return false;
  return true;
}

function extractAppLogWake(line) {
  if (!line.includes('OnMessageArrive')) return null;
  if (!line.includes('dmsg.cid=') && !line.includes('msg.msg.conversationCode=')) return null;

  const cid =
    /dmsg\.cid=([^,\]\s]+)/.exec(line)?.[1] ||
    /msg\.msg\.conversationCode=([^,\]\s]+)/.exec(line)?.[1] ||
    '';
  if (!cid) return null;

  return {
    cid,
    mid:
      /dmsg\.mid=([^,\]\s]+)/.exec(line)?.[1] ||
      /msg\.msg\.code\.messageId=([^,\]\s]+)/.exec(line)?.[1] ||
      '',
    loginTargetId:
      /MessageSDK \[\]\[3#(\d+)\]/.exec(line)?.[1] ||
      parseAppLogChatPrefix(line).targetId ||
      '',
    senderUid:
      /dmsg\.sender\.uid=([^,\]\s]+)/.exec(line)?.[1] ||
      /msg\.sendProfile->target\.targetId=([^,\]\s]+)/.exec(line)?.[1] ||
      '',
    line,
  };
}

function contextFromArgsForCid(args, wake) {
  if (!args.cid || wake.cid !== args.cid) return null;
  if (!args.shop || !args.conversation) return null;

  const targetId = wake.senderUid || /^([^.]+)/.exec(wake.cid)?.[1] || '';
  return {
    conversation: {
      ccode: wake.cid,
      display: args.conversation,
      nick: args.conversation,
      targetId,
    },
    login: {
      display: args.shop,
      nick: args.shop,
      targetId: wake.loginTargetId || '',
      havMainId: '',
    },
  };
}

function shouldWakeForContext(args, context, wake) {
  return getWakeContextStatus(args, context, wake).ok;
}

function getWakeContextStatus(args, context, wake) {
  if (!context) return { ok: false, reason: 'no_context', pending: true };
  if (args.cid && wake.cid !== args.cid) return { ok: false, reason: 'filtered_cid', pending: false };
  if (args.shop && context.login.display && context.login.display !== args.shop) {
    return { ok: false, reason: 'filtered_shop', pending: false };
  }
  if (args.conversation && context.conversation.display && context.conversation.display !== args.conversation) {
    return { ok: false, reason: 'filtered_conversation', pending: false };
  }
  if (!context.conversation.ccode || !context.conversation.display || !context.login.display) {
    return { ok: false, reason: 'incomplete_context', pending: true };
  }
  if (args.shop && !context.login.display) return { ok: false, reason: 'incomplete_context', pending: true };
  if (args.conversation && !context.conversation.display) return { ok: false, reason: 'incomplete_context', pending: true };
  return { ok: true, reason: 'ok', pending: false };
}

function makeWakeKey(context, wake) {
  return [
    'wake',
    context?.login?.targetId || context?.login?.display || wake.loginTargetId || '',
    wake.cid,
    wake.mid || hashText(wake.line),
  ].join('|');
}

function getTaskCid(task) {
  return task?.expectedCid || task?.nativeMessage?.cid || '';
}

function isProcessRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function splitLines(buffer) {
  const lines = buffer.split(/\r?\n/);
  const rest = lines.pop() || '';
  return { lines, rest };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestJson(method, urlValue, body, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlValue);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const request = http.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method,
      timeout: timeoutMs,
      headers: payload
        ? {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': payload.length,
          }
        : {},
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let value;
        try {
          value = text ? JSON.parse(text) : {};
        } catch (error) {
          reject(new Error(`${method} ${urlValue} returned invalid JSON: ${error.message}`));
          return;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`${method} ${urlValue} failed with HTTP ${response.statusCode}: ${text.slice(0, 500)}`));
          return;
        }
        resolve(value);
      });
    });
    request.on('timeout', () => request.destroy(new Error(`${method} ${urlValue} timed out`)));
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

async function invokeBridgeCommand(bridgeBase, clientId, cmd, param = {}, timeoutMs = 15000) {
  const queued = await requestJson('POST', `${bridgeBase}/command`, { clientId, cmd, param }, Math.min(timeoutMs, 5000));
  const commandId = queued?.command?.id;
  if (!commandId) throw new Error(`Bridge did not return a command id for ${cmd}.`);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await delay(100);
    const response = await requestJson(
      'GET',
      `${bridgeBase}/results?commandId=${encodeURIComponent(commandId)}`,
      undefined,
      Math.min(timeoutMs, 5000),
    );
    if (!response.result) continue;
    if (!response.result.ok) {
      throw new Error(`${cmd} failed: ${JSON.stringify(response.result.value || {})}`);
    }
    return response.result;
  }
  throw new Error(`Bridge command ${cmd} timed out after ${timeoutMs}ms.`);
}

function selectAbilityClient(clients, expectedLoginTargetId, expectedLoginDisplay = '') {
  const now = Date.now();
  return (Array.isArray(clients) ? clients : [])
    .filter((client) => {
      const login = client?.state?.loginID || {};
      const fresh = Number.isFinite(Date.parse(client.lastSeen)) && now - Date.parse(client.lastSeen) <= 30000;
      const identityMatches = expectedLoginTargetId
        ? String(login.targetId || '') === String(expectedLoginTargetId)
        : Boolean(expectedLoginDisplay && login.display === expectedLoginDisplay);
      return client.waiting && client.abilityReady && fresh && identityMatches;
    })
    .sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen))[0] || null;
}

function assertAbilityContext(result, task, step) {
  const state = result?.state || {};
  const login = state.loginID || {};
  const conversation = state.conversationID || {};
  const mismatches = [];
  if (task.expectedLoginTargetId && String(login.targetId || '') !== String(task.expectedLoginTargetId)) {
    mismatches.push(`shopTargetId=${login.targetId || ''}`);
  }
  if (task.expectedLoginDisplay && login.display !== task.expectedLoginDisplay) {
    mismatches.push(`shop=${login.display || ''}`);
  }
  if (task.expectedTargetId && String(conversation.targetId || '') !== String(task.expectedTargetId)) {
    mismatches.push(`targetId=${conversation.targetId || ''}`);
  }
  if (task.conversationName && conversation.display !== task.conversationName) {
    mismatches.push(`conversation=${conversation.display || ''}`);
  }
  if (task.expectedCid && conversation.ccode !== task.expectedCid) {
    mismatches.push(`cid=${conversation.ccode || ''}`);
  }
  if (mismatches.length) {
    throw new Error(`${step} context mismatch: ${mismatches.join(', ')}`);
  }
}

function parseSendReceiptLine(line, expectedCid, expectedText) {
  if (!line.includes('onMsgSendUpdate')) return null;
  const payloadText = extractJsonAfter(line, 'jsonStr=') || extractJsonAfter(line, 'utf8JsonStr=');
  if (!payloadText) return null;
  let payload;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    return null;
  }
  const item = (Array.isArray(payload) ? payload : [payload]).find((value) => (
    value?.cid?.ccode === expectedCid && value?.originalData?.text === expectedText
  ));
  if (!item) return null;
  return {
    sendStatus: item.sendStatus,
    progress: item.progress,
    clientId: item.mcode?.clientId || '',
    messageId: item.mcode?.messageId || '',
    cid: item.cid?.ccode || '',
    text: item.originalData?.text || '',
  };
}

class AutoReplyDaemon {
  constructor(args) {
    this.args = args;
    this.processed = loadProcessed(args.state);
    this.contextByCid = new Map();
    this.contextSignatureByCid = new Map();
    this.pendingIncomingByCid = new Map();
    this.pendingIncomingKeys = new Set();
    this.pendingWakeByCid = new Map();
    this.pendingWakeKeys = new Set();
    this.latestContext = { conversation: {}, login: {} };
    this.queue = [];
    this.processing = false;
    this.processingTask = null;
    this.handledCount = 0;
    this.offset = 0;
    this.partial = '';
    this.appLogOffset = 0;
    this.appLogPartial = '';
    this.wakeProcessed = new Set();
    this.wakeCooldownByCid = new Map();
    this.replyCooldownByCid = new Map();
    this.seenIncomingMessages = new Set();
    this.lastActivityAt = Date.now();
    this.server = null;
  }

  log(message, details = {}) {
    const suffix = Object.keys(details).length ? ` ${JSON.stringify(details)}` : '';
    const line = `[${new Date().toISOString()}] ${message}${suffix}`;
    console.log(line);
    if (this.args.logFile) {
      try {
        ensureDir(this.args.logFile);
        fs.appendFileSync(this.args.logFile, line + '\n', 'utf8');
      } catch {
        // Logging must not break packet/message handling.
      }
    }
  }

  markActivity() {
    this.lastActivityAt = Date.now();
  }

  hasQueuedTaskForCid(cid, predicate = () => true) {
    if (!cid) return false;
    if (this.processingTask && getTaskCid(this.processingTask) === cid && predicate(this.processingTask)) {
      return true;
    }
    return this.queue.some((task) => getTaskCid(task) === cid && predicate(task));
  }

  getReplyCoalesceReason(cid) {
    if (!cid) return '';
    if (this.hasQueuedTaskForCid(cid, (task) => task.type === 'reply')) {
      return 'reply_already_active';
    }
    const lastReplyAt = this.replyCooldownByCid.get(cid) || 0;
    if (this.args.coalesceMs > 0 && Date.now() - lastReplyAt < this.args.coalesceMs) {
      return 'reply_coalesce_window';
    }
    return '';
  }

  helperPaths() {
    const root = this.args.helperDir;
    return {
      root,
      requests: path.join(root, 'requests'),
      responses: path.join(root, 'responses'),
      status: path.join(root, 'status.json'),
    };
  }

  ensureHelperReady() {
    const paths = this.helperPaths();
    if (!fs.existsSync(paths.status)) {
      throw new Error(`UIA helper is not running. Start tools/qn-uia-helper.ps1 or use --uia-mode Scheduled.`);
    }
    let status;
    try {
      status = readJsonFile(paths.status);
    } catch (error) {
      throw new Error(`UIA helper status is unreadable: ${error.message}`);
    }
    if (status.stoppedAt) {
      throw new Error(`UIA helper is stopped. Start tools/qn-uia-helper.ps1 again or use --uia-mode Scheduled.`);
    }
    const heartbeatAt = Date.parse(status.heartbeatAt || status.startedAt || '');
    if (!heartbeatAt || Date.now() - heartbeatAt > 30000) {
      throw new Error(`UIA helper heartbeat is stale. Start tools/qn-uia-helper.ps1 again or use --uia-mode Scheduled.`);
    }
    if (status.pid && !isProcessRunning(Number(status.pid))) {
      throw new Error(`UIA helper process ${status.pid} is not running. Start tools/qn-uia-helper.ps1 again or use --uia-mode Scheduled.`);
    }
  }

  checkIdleExit() {
    if (!this.args.idleExitMs) return;
    if (Date.now() - this.lastActivityAt >= this.args.idleExitMs) {
      this.log('idle_exit');
      process.exit(0);
    }
  }

  rememberContext(context, options = {}) {
    const normalized = normalizeContextShape(context);
    if (!normalized.conversation.ccode) return null;

    const cid = normalized.conversation.ccode;
    const merged = mergeContext(this.contextByCid.get(cid) || {}, normalized);
    const signature = contextSignature(merged);
    const changed = this.contextSignatureByCid.get(cid) !== signature;

    this.contextByCid.set(cid, merged);
    this.contextSignatureByCid.set(cid, signature);

    if (options.updateLatest) {
      this.latestContext = mergeContext(merged, this.latestContext);
    }

    if (changed && (merged.login.display || merged.conversation.display)) {
      this.log('cid_context_updated', {
        cid,
        shopName: merged.login.display,
        conversationName: merged.conversation.display,
        source: options.source || '',
      });
    }

    this.replayPendingMessagesForCid(cid);
    this.replayPendingWakesForCid(cid);
    return merged;
  }

  replayPendingMessagesForCid(cid) {
    const pending = this.pendingIncomingByCid.get(cid);
    if (!pending || !pending.length) return;

    this.pendingIncomingByCid.delete(cid);
    this.log('pending_messages_replay', { cid, count: pending.length });
    for (const item of pending) {
      this.pendingIncomingKeys.delete(item.key);
      this.handleIncomingMessage(item.message, { source: 'pending' });
    }
  }

  bufferIncomingMessage(message, context, reason = 'await_context') {
    const cid = message.cid || context.conversation.ccode || '';
    const key = getIncomingMessageRef(message, context);
    if (!cid || !key || this.processed.has(key) || this.pendingIncomingKeys.has(key)) return false;

    const bucket = this.pendingIncomingByCid.get(cid) || [];
    bucket.push({
      key,
      message,
      bufferedAt: new Date().toISOString(),
    });
    this.pendingIncomingByCid.set(cid, bucket);
    this.pendingIncomingKeys.add(key);
    this.log('message_buffered', {
      cid,
      reason,
      fromNick: message.fromNick || '',
      textPreview: (message.text || '').slice(0, 40),
    });
    return true;
  }

  replayPendingWakesForCid(cid) {
    const pending = this.pendingWakeByCid.get(cid);
    if (!pending || !pending.length) return;

    this.pendingWakeByCid.delete(cid);
    this.log('pending_wakes_replay', { cid, count: pending.length });
    for (const item of pending) {
      this.pendingWakeKeys.delete(item.key);
      this.enqueueWakeFromAppLog(item.wake, { source: 'pending' });
    }
  }

  bufferWake(wake, reason) {
    if (!wake.cid) return false;
    const key = makeWakeKey(null, wake);
    if (this.pendingWakeKeys.has(key) || this.wakeProcessed.has(key)) return false;

    const bucket = this.pendingWakeByCid.get(wake.cid) || [];
    bucket.push({
      key,
      wake,
      bufferedAt: new Date().toISOString(),
    });
    this.pendingWakeByCid.set(wake.cid, bucket);
    this.pendingWakeKeys.add(key);
    this.log('app_log_wake_buffered', {
      cid: wake.cid,
      mid: wake.mid,
      reason,
    });
    return true;
  }

  handleIncomingMessage(message, options = {}) {
    const context = inferTaskContext(this.contextByCid, this.latestContext, message);
    const cid = message.cid || context.conversation.ccode || '';

    if (message.direction === 'incoming') {
      const messageRef = getIncomingMessageRef(message, context);
      if (messageRef) {
        this.seenIncomingMessages.add(messageRef);
        this.dropPendingWake(cid, message.messageId || message.clientId || '');
      }
    }

    if (shouldHandleMessage(this.args, context, message)) {
      const key = makeMessageKey(context, message);
      if (this.processed.has(key)) return 'ignored';

      const task = {
        type: 'reply',
        key,
        detectedAt: new Date().toISOString(),
        shopName: context.login.display,
        conversationName: context.conversation.display,
        expectedCid: context.conversation.ccode,
        expectedLoginDisplay: context.login.display,
        expectedLoginTargetId: message.toId || context.login.targetId || '',
        expectedTargetId: message.fromId || context.conversation.targetId || '',
        incoming: {
          text: message.text || '',
          fromNick: message.fromNick || '',
          fromId: message.fromId || '',
          toId: message.toId || '',
          clientId: message.clientId || '',
          messageId: message.messageId || '',
          sendTime: message.sendTime || '',
        },
        reply: this.args.reply,
      };

      const coalesceReason = this.getReplyCoalesceReason(task.expectedCid);
      if (coalesceReason) {
        this.processed.add(key);
        appendState(this.args.state, { ...task, status: 'coalesced', reason: coalesceReason, finishedAt: new Date().toISOString() });
        this.log('reply_coalesced', {
          cid: task.expectedCid,
          reason: coalesceReason,
          incomingText: task.incoming.text,
        });
        return 'coalesced';
      }

      this.processed.add(key);
      if (task.expectedCid) this.replyCooldownByCid.set(task.expectedCid, Date.now());
      appendState(this.args.state, { ...task, status: 'queued' });
      this.queue.push(task);
      this.markActivity();
      this.log('queued', {
        shopName: task.shopName,
        conversationName: task.conversationName,
        expectedCid: task.expectedCid,
        incomingText: task.incoming.text,
      });
      this.drainQueue();
      return 'queued';
    }

    const filtersConflict =
      (this.args.cid && cid && cid !== this.args.cid) ||
      (this.args.shop && context.login.display && context.login.display !== this.args.shop) ||
      (this.args.conversation && context.conversation.display && context.conversation.display !== this.args.conversation);

    const contextReady = Boolean(context.conversation.ccode && context.conversation.display && context.login.display);
    if (message.direction === 'incoming' && cid && !contextReady && !filtersConflict) {
      const buffered = this.bufferIncomingMessage(message, context, options.source || 'await_context');
      if (buffered) return 'buffered';
    }

    return 'ignored';
  }

  updateContext(body) {
    if (!body || !body.state) return;

    const context = normalizeContext(body.state);
    if (context.login.display || context.conversation.ccode) {
      this.latestContext = mergeContext(context, this.latestContext);
    }

    if (context.conversation.ccode) {
      this.rememberContext(context, { source: 'bridge.state' });
    }

    const paramCcode = getCcodeFromParam(body.param);
    if (paramCcode && (context.login.display || context.conversation.display)) {
      const merged = {
        conversation: {
          ...context.conversation,
          ccode: context.conversation.ccode || paramCcode,
        },
        login: context.login,
      };
      this.rememberContext(merged, { source: 'bridge.param' });
    }
  }

  handleEventLine(line) {
    let event;
    let body;
    try {
      event = readJsonLine(line);
      body = parseHookBody(event);
    } catch (error) {
      this.log('skip_malformed_line', { error: error.message });
      return;
    }

    if (!body) return;
    this.updateContext(body);

    if (body.kind !== 'bridge.invoke.result') return;
    if (body.method !== 'im.singlemsg.GetNewMsg') return;
    if (!Array.isArray(body.messages) || body.messages.length === 0) return;

    for (const message of body.messages) {
      this.handleIncomingMessage(message, { source: 'bridge' });
    }

    this.drainQueue();
  }

  dropPendingWake(cid, mid) {
    if (!cid || !mid || this.queue.length === 0) return;
    const before = this.queue.length;
    this.queue = this.queue.filter((task) => {
      if (task.type !== 'wake') return true;
      if (!task.nativeMessage) return true;
      return task.nativeMessage.cid !== cid || task.nativeMessage.mid !== mid;
    });
    const removed = before - this.queue.length;
    if (removed > 0) {
      this.log('wake_dropped_after_message_seen', { cid, mid, removed });
    }
  }

  drainQueue() {
    if (this.processing) return;
    const task = this.queue.shift();
    if (!task) return;
    this.processing = true;
    this.processingTask = task;
    const runner = task.type === 'wake' ? this.executeWakeTask(task) : this.executeTask(task);
    runner
      .catch((error) => {
        this.log('task_error', { key: task.key, error: error.message });
        appendState(this.args.state, { ...task, status: 'failed', error: error.message, finishedAt: new Date().toISOString() });
      })
      .finally(() => {
        this.processing = false;
        if (task.type === 'reply' && task.expectedCid) {
          this.replyCooldownByCid.set(task.expectedCid, Date.now());
        }
        this.processingTask = null;
        if (task.type !== 'wake') this.handledCount += 1;
        if (this.args.once && this.handledCount >= 1) {
          process.exit(0);
        }
        this.drainQueue();
      });
  }

  enqueueWakeFromAppLog(wake, options = {}) {
    const context = this.contextByCid.get(wake.cid) || contextFromArgsForCid(this.args, wake);
    const status = getWakeContextStatus(this.args, context, wake);
    if (!status.ok) {
      if (status.pending) {
        this.bufferWake(wake, status.reason);
        return;
      }
      this.log('app_log_wake_ignored', {
        cid: wake.cid,
        mid: wake.mid,
        reason: status.reason,
      });
      return;
    }

    const wakeRef = makeMessageRef(wake.cid, wake.mid);
    if (wakeRef && this.seenIncomingMessages.has(wakeRef)) {
      this.log('app_log_wake_suppressed_message_seen', { cid: wake.cid, mid: wake.mid });
      return;
    }

    const key = makeWakeKey(context, wake);
    if (this.wakeProcessed.has(key)) return;

    if (this.hasQueuedTaskForCid(wake.cid)) {
      this.log('app_log_wake_suppressed_active_task', { cid: wake.cid, mid: wake.mid });
      return;
    }

    const now = Date.now();
    const lastWakeAt = this.wakeCooldownByCid.get(wake.cid) || 0;
    if (now - lastWakeAt < 15000) {
      this.log('app_log_wake_suppressed', { cid: wake.cid, mid: wake.mid });
      return;
    }

    this.wakeProcessed.add(key);
    this.wakeCooldownByCid.set(wake.cid, now);

    const task = {
      type: 'wake',
      key,
      detectedAt: new Date().toISOString(),
      shopName: context.login.display,
      conversationName: context.conversation.display,
      expectedCid: context.conversation.ccode,
      expectedLoginDisplay: context.login.display,
      expectedLoginTargetId: wake.loginTargetId || context.login.targetId || '',
      expectedTargetId: wake.senderUid || context.conversation.targetId || /^([^.]+)/.exec(wake.cid)?.[1] || '',
      nativeMessage: {
        cid: wake.cid,
        mid: wake.mid,
        senderUid: wake.senderUid,
        loginTargetId: wake.loginTargetId,
      },
    };

    appendState(this.args.state, { ...task, status: 'wake_queued' });
    this.queue.push(task);
    this.markActivity();
    this.log('app_log_wake_queued', {
      shopName: task.shopName,
      conversationName: task.conversationName,
      expectedCid: task.expectedCid,
      mid: wake.mid,
      source: options.source || 'app.log',
    });
    this.drainQueue();
  }

  async getAbilityClient(task) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const response = await requestJson('GET', `${this.args.bridgeBase}/clients`, undefined, 5000);
      const client = selectAbilityClient(
        response.clients,
        task.expectedLoginTargetId,
        task.expectedLoginDisplay,
      );
      if (client) return client;
      await delay(100);
    }
    throw new Error(
      `No fresh waiting Ability client for shopTargetId=${task.expectedLoginTargetId || ''} shop=${task.expectedLoginDisplay || ''}.`,
    );
  }

  async openAndVerifyAbilityContext(task, clientId) {
    if (!task.expectedTargetId) {
      throw new Error(`Cannot open ${task.expectedCid}: targetId is missing.`);
    }
    const timeoutMs = Math.max(this.args.timeoutSec * 1000, 15000);
    const opened = await invokeBridgeCommand(
      this.args.bridgeBase,
      clientId,
      'openChat',
      { targetId: String(task.expectedTargetId), bizDomain: 'taobao' },
      timeoutMs,
    );
    assertAbilityContext(opened, task, 'openChat');

    const active = await invokeBridgeCommand(
      this.args.bridgeBase,
      clientId,
      'getActiveUser',
      {},
      timeoutMs,
    );
    assertAbilityContext(active, task, 'getActiveUser');
    if (String(active.value?.securityUID || '') !== String(task.expectedTargetId)) {
      throw new Error(`getActiveUser securityUID mismatch: ${active.value?.securityUID || ''}`);
    }
    if (active.value?.cid !== task.expectedCid) {
      throw new Error(`getActiveUser cid mismatch: ${active.value?.cid || ''}`);
    }
    if (!active.value?.uid) {
      throw new Error('getActiveUser did not return uid.');
    }
    return active;
  }

  async waitForIncomingWake(task, timeoutMs = 10000) {
    const ref = makeMessageRef(task.expectedCid, task.nativeMessage?.mid || '');
    if (!ref) return;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.seenIncomingMessages.has(ref)) return;
      await delay(100);
    }
    throw new Error(`GetNewMsg plaintext was not observed after openChat for ${task.nativeMessage?.mid || task.expectedCid}.`);
  }

  runWin32Submit(task, clientId) {
    const taskName = `CodexQnWin32Submit-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
    const psArgs = [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      this.args.submitScript,
      '-TaskName',
      taskName,
      '-BridgeBase',
      this.args.bridgeBase,
      '-ClientId',
      clientId,
      '-ExpectedShopTargetId',
      String(task.expectedLoginTargetId || ''),
      '-ExpectedTargetId',
      String(task.expectedTargetId || ''),
      '-ExpectedCid',
      task.expectedCid,
      '-TimeoutSec',
      String(this.args.timeoutSec),
    ];
    const timeoutMs = Math.max(this.args.timeoutSec * 1000, 30000);

    return new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', psArgs, { cwd: repoRoot, windowsHide: true });
      let output = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);
      child.stdout.on('data', (chunk) => { output += chunk.toString('utf8'); });
      child.stderr.on('data', (chunk) => { output += chunk.toString('utf8'); });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const resultLine = output.split(/\r?\n/).find((line) => line.includes('RESULT ')) || '';
        if (timedOut) {
          reject(new Error(`Win32 submit timed out after ${timeoutMs}ms: ${resultLine || output.slice(-500)}`));
        } else if (code !== 0) {
          reject(new Error(`Win32 submit exited ${code}: ${resultLine || output.slice(-500)}`));
        } else if (!resultLine.includes('RESULT sent_enter')) {
          reject(new Error(`Win32 submit returned no success marker: ${output.slice(-500)}`));
        } else {
          resolve(resultLine.trim());
        }
      });
    });
  }

  async waitForSendReceipt(startOffset, task, timeoutMs) {
    let offset = startOffset;
    let partial = '';
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!fs.existsSync(this.args.appLog)) {
        throw new Error(`app.log does not exist: ${this.args.appLog}`);
      }
      const stat = fs.statSync(this.args.appLog);
      if (stat.size < offset) {
        offset = 0;
        partial = '';
      }
      if (stat.size > offset) {
        const fd = fs.openSync(this.args.appLog, 'r');
        let text;
        try {
          const length = stat.size - offset;
          const buffer = Buffer.alloc(length);
          fs.readSync(fd, buffer, 0, length, offset);
          offset = stat.size;
          text = partial + buffer.toString('utf8');
        } finally {
          fs.closeSync(fd);
        }
        const split = splitLines(text);
        partial = split.rest;
        for (const line of split.lines) {
          const receipt = parseSendReceiptLine(line, task.expectedCid, task.reply);
          if (!receipt) continue;
          if (receipt.sendStatus !== 0 || receipt.progress !== 100) {
            throw new Error(`Send failed with status=${receipt.sendStatus} progress=${receipt.progress}.`);
          }
          return receipt;
        }
      }
      await delay(100);
    }
    throw new Error(`No matching send receipt after ${timeoutMs}ms.`);
  }

  async executeAbilityWakeTask(task) {
    const client = await this.getAbilityClient(task);
    await this.openAndVerifyAbilityContext(task, client.clientId);
    await this.waitForIncomingWake(task, Math.max(this.args.timeoutSec * 1000, 10000));
    const result = `RESULT ability_wake clientId=${client.clientId} cid=${task.expectedCid}`;
    this.log('wake_ok', { result, controlMode: 'Ability' });
    appendState(this.args.state, {
      ...task,
      status: 'wake_ok',
      bridgeClientId: client.clientId,
      result,
      finishedAt: new Date().toISOString(),
    });
  }

  async executeAbilityReplyTask(task) {
    const client = await this.getAbilityClient(task);
    const active = await this.openAndVerifyAbilityContext(task, client.clientId);
    const timeoutMs = Math.max(this.args.timeoutSec * 1000, 15000);

    const emptyBefore = await invokeBridgeCommand(
      this.args.bridgeBase,
      client.clientId,
      'isInputboxEmpty',
      {},
      timeoutMs,
    );
    assertAbilityContext(emptyBefore, task, 'isInputboxEmpty(before)');
    if (!emptyBefore.value?.isEmpty) {
      throw new Error('Target input box already contains text; refusing to append or send.');
    }

    const inserted = await invokeBridgeCommand(
      this.args.bridgeBase,
      client.clientId,
      'insertText2Inputbox',
      {
        uid: active.value.uid,
        securityUID: active.value.securityUID,
        bizDomain: active.value.bizDomain || 'taobao',
        type: 0,
        text: task.reply,
      },
      timeoutMs,
    );
    assertAbilityContext(inserted, task, 'insertText2Inputbox');

    const emptyAfterInsert = await invokeBridgeCommand(
      this.args.bridgeBase,
      client.clientId,
      'isInputboxEmpty',
      {},
      timeoutMs,
    );
    assertAbilityContext(emptyAfterInsert, task, 'isInputboxEmpty(after insert)');
    if (emptyAfterInsert.value?.isEmpty) {
      throw new Error('Ability reported an empty input box after insertion.');
    }

    const appLogOffset = fs.existsSync(this.args.appLog) ? fs.statSync(this.args.appLog).size : 0;
    const enterResult = await this.runWin32Submit(task, client.clientId);
    const receipt = await this.waitForSendReceipt(appLogOffset, task, timeoutMs);

    const emptyAfterSend = await invokeBridgeCommand(
      this.args.bridgeBase,
      client.clientId,
      'isInputboxEmpty',
      {},
      timeoutMs,
    );
    assertAbilityContext(emptyAfterSend, task, 'isInputboxEmpty(after send)');
    if (!emptyAfterSend.value?.isEmpty) {
      throw new Error('Send receipt succeeded but the target input box is not empty.');
    }
    await this.openAndVerifyAbilityContext(task, client.clientId);

    const result = `RESULT sendStatus=${receipt.sendStatus} clientId=${receipt.clientId} messageId=${receipt.messageId} cid=${receipt.cid}`;
    this.log('send_ok', { result, controlMode: 'Ability', enterResult });
    appendState(this.args.state, {
      ...task,
      status: 'sent',
      bridgeClientId: client.clientId,
      result,
      receipt,
      finishedAt: new Date().toISOString(),
    });
  }

  executeViaHelper(task, options) {
    const { switchOnly, timeoutMs, successStatus, failedStatus, okLogName } = options;
    let id;
    let responsePath;
    try {
      this.ensureHelperReady();
      const paths = this.helperPaths();
      fs.mkdirSync(paths.requests, { recursive: true });
      fs.mkdirSync(paths.responses, { recursive: true });

      id = `${Date.now()}-${process.pid}-${hashText(task.key)}-${crypto.randomBytes(4).toString('hex')}`;
      const requestPath = path.join(paths.requests, `${id}.json`);
      const tmpPath = `${requestPath}.tmp`;
      responsePath = path.join(paths.responses, `${id}.json`);
      const command = {
        id,
        type: task.type,
        switchOnly: Boolean(switchOnly),
        shopName: task.shopName,
        conversationName: task.conversationName,
        expectedCid: task.expectedCid,
        expectedLoginDisplay: task.expectedLoginDisplay,
        text: task.reply || '',
        timeoutSec: this.args.timeoutSec,
        createdAt: new Date().toISOString(),
      };

      fs.writeFileSync(tmpPath, JSON.stringify(command, null, 2), 'utf8');
      fs.renameSync(tmpPath, requestPath);
    } catch (error) {
      return Promise.reject(error);
    }

    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (fn) => {
        if (done) return;
        done = true;
        clearInterval(interval);
        clearTimeout(timer);
        fn();
      };
      const readResponse = () => {
        if (!fs.existsSync(responsePath)) return;
        let result;
        try {
          result = readJsonFile(responsePath);
        } catch (error) {
          finish(() => reject(new Error(`helper response parse failed: ${error.message}`)));
          return;
        }

        const output = Array.isArray(result.output) ? result.output.join('\n') : String(result.output || '');
        const resultLine = output.split(/\r?\n/).find((line) => line.startsWith('RESULT ')) || '';
        if (result.ok) {
          this.log(okLogName, { result: resultLine, helperId: id });
          appendState(this.args.state, { ...task, status: successStatus, exitCode: result.exitCode, result: resultLine, helperId: id, finishedAt: new Date().toISOString() });
          finish(resolve);
        } else {
          appendState(this.args.state, { ...task, status: failedStatus, exitCode: result.exitCode, output, helperId: id, finishedAt: new Date().toISOString() });
          finish(() => reject(new Error(`helper command exited ${result.exitCode}: ${resultLine || output.slice(-500)}`)));
        }
      };
      const interval = setInterval(readResponse, 250);
      const timer = setTimeout(() => {
        finish(() => reject(new Error(`helper command timeout after ${timeoutMs}ms`)));
      }, timeoutMs);
      readResponse();
    });
  }

  executeWakeTask(task) {
    if (!this.args.live) {
      this.log('dry_run_wake', {
        shopName: task.shopName,
        conversationName: task.conversationName,
        expectedCid: task.expectedCid,
      });
      appendState(this.args.state, { ...task, status: 'wake_dry_run', finishedAt: new Date().toISOString() });
      return Promise.resolve();
    }

    appendState(this.args.state, { ...task, status: 'wake_start', startedAt: new Date().toISOString() });

    this.log('wake_start', {
      shopName: task.shopName,
      conversationName: task.conversationName,
      expectedCid: task.expectedCid,
      controlMode: this.args.controlMode,
      ...(this.args.controlMode === 'UIA' ? { uiaMode: this.args.uiaMode } : {}),
    });

    if (this.args.controlMode === 'Ability') {
      return this.executeAbilityWakeTask(task);
    }

    if (this.args.uiaMode === 'Helper') {
      return this.executeViaHelper(task, {
        switchOnly: true,
        timeoutMs: Math.max(this.args.timeoutSec * 4 * 1000, 90000),
        successStatus: 'wake_ok',
        failedStatus: 'wake_failed',
        okLogName: 'wake_ok',
      });
    }

    const script = path.join(repoRoot, 'tools', 'qn-send-visible-conversation.ps1');
    const psArgs = [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
      '-ShopName',
      task.shopName,
      '-ConversationName',
      task.conversationName,
      '-ExpectedCid',
      task.expectedCid,
      '-ExpectedLoginDisplay',
      task.expectedLoginDisplay,
      '-SwitchOnly',
      '-TimeoutSec',
      String(this.args.timeoutSec),
      '-UiaMode',
      this.args.uiaMode,
    ];

    return new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', psArgs, { cwd: repoRoot, windowsHide: true });
      let output = '';
      let timedOut = false;
      const timeoutMs = Math.max(this.args.timeoutSec * 4 * 1000, 90000);
      const timer = setTimeout(() => {
        timedOut = true;
        this.log('wake_timeout_kill', {
          key: task.key,
          timeoutMs,
        });
        child.kill();
      }, timeoutMs);
      child.stdout.on('data', (chunk) => {
        output += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk) => {
        output += chunk.toString('utf8');
      });
      child.on('error', reject);
      child.on('close', (code) => {
        clearTimeout(timer);
        const resultLine = output.split(/\r?\n/).find((line) => line.startsWith('RESULT ')) || '';
        if (timedOut) {
          appendState(this.args.state, { ...task, status: 'wake_failed', exitCode: code, output, error: `wake script timeout after ${timeoutMs}ms`, finishedAt: new Date().toISOString() });
          reject(new Error(`wake script timeout after ${timeoutMs}ms: ${resultLine || output.slice(-500)}`));
          return;
        }
        if (code === 0) {
          this.log('wake_ok', { result: resultLine });
          appendState(this.args.state, { ...task, status: 'wake_ok', exitCode: code, result: resultLine, finishedAt: new Date().toISOString() });
          resolve();
        } else {
          appendState(this.args.state, { ...task, status: 'wake_failed', exitCode: code, output, finishedAt: new Date().toISOString() });
          reject(new Error(`wake script exited ${code}: ${resultLine || output.slice(-500)}`));
        }
      });
    });
  }

  executeTask(task) {
    if (!this.args.live) {
      this.log('dry_run_reply', {
        shopName: task.shopName,
        conversationName: task.conversationName,
        expectedCid: task.expectedCid,
        reply: task.reply,
      });
      appendState(this.args.state, { ...task, status: 'dry_run', finishedAt: new Date().toISOString() });
      return Promise.resolve();
    }

    appendState(this.args.state, { ...task, status: 'sending', startedAt: new Date().toISOString() });

    this.log('send_start', {
      shopName: task.shopName,
      conversationName: task.conversationName,
      expectedCid: task.expectedCid,
      controlMode: this.args.controlMode,
      ...(this.args.controlMode === 'UIA' ? { uiaMode: this.args.uiaMode } : {}),
    });

    if (this.args.controlMode === 'Ability') {
      return this.executeAbilityReplyTask(task);
    }

    if (this.args.uiaMode === 'Helper') {
      return this.executeViaHelper(task, {
        switchOnly: false,
        timeoutMs: Math.max(this.args.timeoutSec * 6 * 1000, 120000),
        successStatus: 'sent',
        failedStatus: 'failed',
        okLogName: 'send_ok',
      });
    }

    const script = path.join(repoRoot, 'tools', 'qn-send-visible-conversation.ps1');
    const psArgs = [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
      '-ShopName',
      task.shopName,
      '-ConversationName',
      task.conversationName,
      '-ExpectedCid',
      task.expectedCid,
      '-ExpectedLoginDisplay',
      task.expectedLoginDisplay,
      '-Text',
      task.reply,
      '-TimeoutSec',
      String(this.args.timeoutSec),
      '-UiaMode',
      this.args.uiaMode,
    ];

    return new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', psArgs, { cwd: repoRoot, windowsHide: true });
      let output = '';
      let timedOut = false;
      const timeoutMs = Math.max(this.args.timeoutSec * 6 * 1000, 120000);
      const timer = setTimeout(() => {
        timedOut = true;
        this.log('send_timeout_kill', {
          key: task.key,
          timeoutMs,
        });
        child.kill();
      }, timeoutMs);
      child.stdout.on('data', (chunk) => {
        output += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk) => {
        output += chunk.toString('utf8');
      });
      child.on('error', reject);
      child.on('close', (code) => {
        clearTimeout(timer);
        const resultLine = output.split(/\r?\n/).find((line) => line.startsWith('RESULT ')) || '';
        if (timedOut) {
          appendState(this.args.state, { ...task, status: 'failed', exitCode: code, output, error: `send script timeout after ${timeoutMs}ms`, finishedAt: new Date().toISOString() });
          reject(new Error(`send script timeout after ${timeoutMs}ms: ${resultLine || output.slice(-500)}`));
          return;
        }
        if (code === 0) {
          this.log('send_ok', { result: resultLine });
          appendState(this.args.state, { ...task, status: 'sent', exitCode: code, result: resultLine, finishedAt: new Date().toISOString() });
          resolve();
        } else {
          appendState(this.args.state, { ...task, status: 'failed', exitCode: code, output, finishedAt: new Date().toISOString() });
          reject(new Error(`send script exited ${code}: ${resultLine || output.slice(-500)}`));
        }
      });
    });
  }

  processExistingTail() {
    if (!this.args.replayLast) {
      this.offset = fs.existsSync(this.args.hookLog) ? fs.statSync(this.args.hookLog).size : 0;
      return;
    }

    const content = fs.existsSync(this.args.hookLog) ? fs.readFileSync(this.args.hookLog, 'utf8') : '';
    const lines = content.split(/\r?\n/).filter(Boolean);
    const selected = lines.slice(-this.args.replayLast);
    this.log('replay_start', { lines: selected.length });
    if (selected.length) this.markActivity();
    for (const line of selected) this.handleEventLine(line);
    this.offset = fs.existsSync(this.args.hookLog) ? fs.statSync(this.args.hookLog).size : 0;
  }

  startAppLogTail() {
    if (!this.args.wakeFromAppLog) return;
    if (!this.args.appLog) return;
    if (!fs.existsSync(this.args.appLog)) {
      this.log('app_log_missing', { appLog: this.args.appLog });
      return;
    }
    this.appLogOffset = fs.statSync(this.args.appLog).size;
    this.log('app_log_tail_start', { appLog: this.args.appLog, offset: this.appLogOffset });
  }

  handleAppLogLine(line) {
    const contexts = extractAppLogContexts(line);
    for (const item of contexts) {
      this.rememberContext(item.context, {
        source: 'app.log',
        updateLatest: item.updateLatest,
      });
    }

    const wake = extractAppLogWake(line);
    if (!wake) return;
    this.log('app_log_wake_detected', {
      cid: wake.cid,
      mid: wake.mid,
      loginTargetId: wake.loginTargetId,
      senderUid: wake.senderUid,
    });
    this.enqueueWakeFromAppLog(wake);
  }

  pollAppLogAppended() {
    if (!this.args.wakeFromAppLog || !this.args.appLog || !fs.existsSync(this.args.appLog)) return;

    const stat = fs.statSync(this.args.appLog);
    if (stat.size < this.appLogOffset) {
      this.appLogOffset = 0;
      this.appLogPartial = '';
    }
    if (stat.size === this.appLogOffset) return;

    this.markActivity();

    const fd = fs.openSync(this.args.appLog, 'r');
    try {
      const length = stat.size - this.appLogOffset;
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, this.appLogOffset);
      this.appLogOffset = stat.size;
      const text = this.appLogPartial + buffer.toString('utf8');
      const { lines, rest } = splitLines(text);
      this.appLogPartial = rest;
      for (const line of lines) this.handleAppLogLine(line);
    } finally {
      fs.closeSync(fd);
    }
  }

  pollAppended() {
    if (!fs.existsSync(this.args.hookLog)) {
      this.checkIdleExit();
      return;
    }

    const stat = fs.statSync(this.args.hookLog);
    if (stat.size < this.offset) {
      this.offset = 0;
      this.partial = '';
    }
    if (stat.size === this.offset) {
      this.checkIdleExit();
      return;
    }

    this.markActivity();

    const fd = fs.openSync(this.args.hookLog, 'r');
    try {
      const length = stat.size - this.offset;
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, this.offset);
      this.offset = stat.size;
      const text = this.partial + buffer.toString('utf8');
      const { lines, rest } = splitLines(text);
      this.partial = rest;
      for (const line of lines) this.handleEventLine(line);
    } finally {
      fs.closeSync(fd);
    }

    this.checkIdleExit();
  }

  start() {
    ensureDir(this.args.state);
    ensureDir(this.args.hookLog);
    this.log('start', {
      mode: this.args.live ? 'live' : 'dry-run',
      hookLog: this.args.hookLog,
      state: this.args.state,
      logFile: this.args.logFile,
      reply: this.args.reply,
      shop: this.args.shop,
      conversation: this.args.conversation,
      cid: this.args.cid,
      listen: this.args.listen,
      port: this.args.port,
      controlMode: this.args.controlMode,
      bridgeBase: this.args.bridgeBase,
      submitScript: this.args.submitScript,
      heartbeatSec: this.args.heartbeatSec,
      ...(this.args.controlMode === 'UIA'
        ? { uiaMode: this.args.uiaMode, helperDir: this.args.helperDir }
        : {}),
      coalesceMs: this.args.coalesceMs,
      wakeFromAppLog: this.args.wakeFromAppLog,
      appLog: this.args.appLog,
    });

    if (this.args.listen) {
      this.startReceiver();
    }

    this.processExistingTail();
    this.startAppLogTail();
    this.markActivity();
    setInterval(() => {
      this.pollAppended();
      this.pollAppLogAppended();
    }, 500);
    if (this.args.heartbeatSec > 0) {
      setInterval(() => {
        this.log('heartbeat', {
          queue: this.queue.length,
          processing: this.processing,
          handledCount: this.handledCount,
          lastActivitySecondsAgo: Math.round((Date.now() - this.lastActivityAt) / 1000),
        });
      }, this.args.heartbeatSec * 1000);
    }
  }

  startReceiver() {
    const host = '127.0.0.1';
    const maxBodyBytes = 512 * 1024;
    const server = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method === 'GET') {
        this.log('receiver_get', { url: req.url });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          ok: true,
          service: 'qn-auto-reply-daemon',
          mode: this.args.live ? 'live' : 'dry-run',
          port: this.args.port,
          hookLog: this.args.hookLog,
        }));
        return;
      }

      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size <= maxBodyBytes) chunks.push(chunk);
      });
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const line = JSON.stringify({
          time: new Date().toISOString(),
          method: req.method,
          url: req.url,
          truncated: size > maxBodyBytes,
          body,
        });
        fs.appendFileSync(this.args.hookLog, line + '\n', 'utf8');
        this.log('receiver_post_written', {
          url: req.url,
          bytes: size,
          truncated: size > maxBodyBytes,
        });
        this.handleEventLine(line);
        this.markActivity();
        res.writeHead(204);
        res.end();
      });
      req.on('error', (error) => {
        this.log('receiver_request_error', { error: error.message });
      });
    });

    server.on('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        this.log('receiver_port_in_use', { port: this.args.port });
        process.exit(1);
      }
      this.log('receiver_error', { error: error.message });
      process.exit(1);
    });

    server.listen(this.args.port, host, () => {
      this.server = server;
      this.log('receiver_listening', {
        endpoint: `http://${host}:${this.args.port}/qn-bridge`,
      });
    });
  }
}

if (require.main === module) {
  process.on('uncaughtException', (error) => {
    console.error(`[${new Date().toISOString()}] uncaughtException ${error.stack || error.message}`);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    const error = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
    console.error(`[${new Date().toISOString()}] unhandledRejection ${error}`);
    process.exit(1);
  });

  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      printHelp();
      process.exit(0);
    }
    const daemon = new AutoReplyDaemon(args);
    daemon.start();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = {
  AutoReplyDaemon,
  assertAbilityContext,
  invokeBridgeCommand,
  parseArgs,
  parseSendReceiptLine,
  selectAbilityClient,
};
