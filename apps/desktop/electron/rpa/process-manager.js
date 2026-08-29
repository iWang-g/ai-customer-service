import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

function userDirectoryKey(userId) {
  return createHash('sha256').update(userId).digest('hex').slice(0, 16);
}

export function serializeRpaCommand(payload) {
  // Keep the pipe protocol ASCII-only so Windows console code pages cannot corrupt Unicode.
  return JSON.stringify(payload).replace(/[\u007f-\uffff]/g, (character) => (
    `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
  ));
}

export class RpaProcessManager extends EventEmitter {
  constructor({
    userDataPath,
    executablePath,
    executableArgs = [],
    requiredFilePath = null,
    apiBaseUrl,
    appVersion = '0.1.0',
    logPath = null,
  }) {
    super();
    this.userDataPath = userDataPath;
    this.executablePath = executablePath;
    this.executableArgs = [...executableArgs];
    this.requiredFilePath = requiredFilePath;
    this.apiBaseUrl = apiBaseUrl.replace(/\/$/, '');
    this.appVersion = appVersion;
    this.logPath = logPath;
    this.process = null;
    this.secret = null;
    this.userId = null;
    this.accessToken = null;
    this.accounts = [];
    this.accountsByPlatform = new Map();
    this.pendingEvents = new Map();
    this.pendingConversationClears = new Map();
    this.buffer = '';
    this.stopping = false;
    this.restartTimer = null;
    this.state = { status: 'stopped', nodeId: null, detail: null, lastHeartbeatAt: null };
  }

  getState() {
    return { ...this.state };
  }

  async start({ userId, accessToken }) {
    this.#writeLog('start_requested', {
      user_id_present: Boolean(userId),
      access_token_present: Boolean(accessToken),
      has_existing_process: Boolean(this.process),
    });
    if (this.process && this.userId === userId) {
      this.accessToken = accessToken;
      this.#send({ type: 'update_access_token', access_token: accessToken });
      return this.getState();
    }
    await this.stop();
    this.userId = userId;
    this.accessToken = accessToken;
    this.stopping = false;
    this.#spawn();
    return this.getState();
  }

  setAccounts(accounts) {
    this.setPlatformAccounts('pinduoduo', accounts);
  }

  setPlatformAccounts(platformCode, accounts) {
    const normalized = accounts.map((account) => ({
      id: account.id,
      platform_code: platformCode,
      alias: account.alias,
      partition: account.partition,
      paused: Boolean(account.paused || account.archivedAt),
      archived: Boolean(account.archivedAt),
      external_account_id: account.externalAccountId || null,
      account_name: account.platformAccountName || account.alias,
      login_status: account.paused || account.archivedAt
        ? 'paused'
        : account.loginStatus === 'account_mismatch' ? 'error' : account.loginStatus || 'unknown',
      metadata_json: {
        ...(account.metadataJson || {
          process_id: account.processId || null,
          window_handle: account.windowHandle || null,
          wechat_name: account.wechatName || null,
          wechat_id: account.wechatId || null,
          identity_source: account.identitySource || null,
        }),
        logo_url: account.platformAccountLogoUrl || account.metadataJson?.logo_url || null,
        cs_username: account.platformAccountServiceUsername || account.metadataJson?.cs_username || null,
        cs_id: account.platformAccountCsId || account.metadataJson?.cs_id || null,
        cs_uid: account.platformAccountCsUid || account.metadataJson?.cs_uid || null,
        is_mall_owner: account.platformAccountIsMallOwner === true,
      },
    }));
    this.accountsByPlatform.set(platformCode, normalized);
    this.accounts = [...this.accountsByPlatform.values()].flat();
    this.#send({ type: 'sync_accounts', accounts: this.accounts });
  }

  enqueueEvent(event) {
    if (!event?.event_id) return;
    this.pendingEvents.set(event.event_id, event);
    if (this.pendingEvents.size > 2000) {
      const oldest = this.pendingEvents.keys().next().value;
      this.pendingEvents.delete(oldest);
    }
    this.#send({ type: 'enqueue_event', event });
  }

  async stop() {
    this.#writeLog('stop_requested', { has_process: Boolean(this.process) });
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const child = this.process;
    this.process = null;
    if (child && !child.killed) {
      try {
        this.#write(child, { type: 'shutdown', secret: this.secret });
      } catch {
        child.kill();
      }
      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          if (!child.killed) child.kill();
          resolve();
        }, 3000);
        child.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
    this.secret = null;
    this.userId = null;
    this.accessToken = null;
    this.pendingEvents.clear();
    this.accounts = [];
    this.accountsByPlatform.clear();
    for (const pending of this.pendingConversationClears.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('RPA process stopped before conversation events were cleared'));
    }
    this.pendingConversationClears.clear();
    this.#setState({ status: 'stopped', nodeId: null, detail: null, lastHeartbeatAt: null });
  }

  #spawn() {
    if (!this.userId || !this.accessToken) return;
    if (this.requiredFilePath && !fs.existsSync(this.requiredFilePath)) {
      this.#setState({ status: 'error', detail: `RPA 程序不存在: ${this.requiredFilePath}` });
      return;
    }
    this.secret = randomBytes(32).toString('hex');
    this.buffer = '';
    this.#setState({ status: 'starting', detail: null });
    this.#writeLog('process_spawning', {
      executable_path: this.executablePath,
      executable_args: this.executableArgs,
      required_file_path: this.requiredFilePath,
      api_base_url: this.apiBaseUrl,
    });
    const child = spawn(this.executablePath, this.executableArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });
    this.process = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.#consume(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      console.error('[RPA]', chunk.trimEnd());
      this.#writeLog('process_stderr', { text: chunk.trimEnd().slice(0, 4000) });
    });
    child.on('error', (error) => {
      this.#writeLog('process_error', { error: error?.message || String(error) });
      this.#setState({ status: 'error', detail: error.message });
    });
    child.on('exit', (code) => {
      if (this.process === child) this.process = null;
      if (this.stopping) return;
      this.#writeLog('process_exited', { code: code ?? null });
      this.#setState({ status: 'offline', detail: `RPA 进程已退出 (${code ?? 'unknown'})` });
      this.restartTimer = setTimeout(() => this.#spawn(), 5000);
    });

    const dataDir = path.join(this.userDataPath, 'rpa', userDirectoryKey(this.userId));
    this.#write(child, {
      type: 'bootstrap',
      secret: this.secret,
      api_base_url: this.apiBaseUrl,
      access_token: this.accessToken,
      user_id: this.userId,
      data_dir: dataDir,
      app_version: this.appVersion,
    });
  }

  #consume(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line);
        if (message.secret !== this.secret) continue;
        this.#handleMessage(message);
      } catch (error) {
        console.error('[RPA] 无法解析节点消息:', error);
        this.#writeLog('message_parse_failed', {
          error: error?.message || String(error),
          line: line.slice(0, 1000),
        });
      }
    }
  }

  #handleMessage(message) {
    if (message.type === 'agent_started') {
      this.#writeLog('agent_started', { pid: message.pid || null });
      this.#send({ type: 'sync_accounts', accounts: this.accounts });
      for (const event of this.pendingEvents.values()) {
        this.#send({ type: 'enqueue_event', event });
      }
      return;
    }
    if (message.type === 'registered') {
      this.#writeLog('registered', { node_id: message.node_id || null });
      this.#setState({ status: 'online', nodeId: message.node_id, detail: null });
      return;
    }
    if (message.type === 'heartbeat') {
      this.#setState({
        status: 'online',
        nodeId: message.node_id,
        detail: null,
        lastHeartbeatAt: new Date().toISOString(),
      });
      return;
    }
    if (message.type === 'command_error') {
      this.#writeLog(message.type, { detail: message.detail || null });
      this.#setState({ detail: message.detail || 'RPA command error' });
      return;
    }
    if (message.type === 'offline') {
      this.#writeLog(message.type, { detail: message.detail || null });
      this.#setState({ status: 'offline', detail: message.detail || 'RPA 节点离线' });
      return;
    }
    if (message.type === 'accounts_synced') {
      this.emit('bindings', message.bindings || []);
      return;
    }
    if (message.type === 'task') {
      this.emit('task', message.task);
      return;
    }
    if (message.type === 'event_queued') {
      this.pendingEvents.delete(message.event_id);
      return;
    }
    if (message.type === 'conversation_events_cleared') {
      const pending = this.pendingConversationClears.get(message.request_id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pendingConversationClears.delete(message.request_id);
      pending.resolve(Number(message.deleted_count) || 0);
    }
  }

  completeTask(taskId, status = 'completed', resultJson = {}, errorMessage = null) {
    return this.#send({
      type: 'complete_task',
      task_id: taskId,
      status,
      result_json: resultJson,
      error_message: errorMessage,
    });
  }

  clearConversationEvents(platformAccountId, conversationExternalId) {
    for (const [eventId, event] of this.pendingEvents) {
      if (
        event.platform_account_id === platformAccountId
        && event.conversation_external_id === conversationExternalId
      ) this.pendingEvents.delete(eventId);
    }
    if (!this.process || this.process.killed || !this.secret) {
      return Promise.reject(new Error('RPA process is not available'));
    }
    const requestId = randomBytes(16).toString('hex');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingConversationClears.delete(requestId);
        reject(new Error('Timed out clearing local RPA conversation events'));
      }, 15000);
      this.pendingConversationClears.set(requestId, { resolve, reject, timer });
      const sent = this.#send({
        type: 'clear_conversation_events',
        request_id: requestId,
        platform_account_id: platformAccountId,
        conversation_external_id: conversationExternalId,
      });
      if (!sent) {
        clearTimeout(timer);
        this.pendingConversationClears.delete(requestId);
        reject(new Error('Failed to request local RPA conversation event cleanup'));
      }
    });
  }

  #send(payload) {
    if (!this.process || this.process.killed || !this.secret) return false;
    try {
      this.#write(this.process, { ...payload, secret: this.secret });
      return true;
    } catch {
      return false;
    }
  }

  #write(child, payload) {
    child.stdin.write(`${serializeRpaCommand(payload)}\n`, 'ascii');
  }

  #setState(changes) {
    this.state = { ...this.state, ...changes };
    this.#writeLog('state_changed', this.state);
    this.emit('state-changed', this.getState());
  }

  #writeLog(stage, details = {}) {
    if (!this.logPath) return;
    try {
      fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
      fs.appendFileSync(this.logPath, `${JSON.stringify({
        timestamp: new Date().toISOString(),
        stage,
        details,
      })}\n`, 'utf8');
    } catch {
      // RPA lifecycle must not depend on diagnostic logging.
    }
  }
}
