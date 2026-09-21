import { EventEmitter } from 'node:events';
import { fork } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDirectory, '..', '..', '..', '..');
const DEFAULT_HELPER_PATH = path.join(currentDirectory, 'direct-send-helper.cjs');
const DEFAULT_TOOLS_ROOT = path.join(repoRoot, 'tools');

function submittedError(error, submitted) {
  if (error && typeof error === 'object') {
    error.submitted = submitted;
    return error;
  }
  const next = new Error(String(error || '千牛发送 helper 异常'));
  next.submitted = submitted;
  return next;
}

export class QianniuDirectSendClient extends EventEmitter {
  constructor({
    nodePath = process.env.QIANNIU_NODE_PATH || 'node',
    helperPath = DEFAULT_HELPER_PATH,
    toolsRoot = DEFAULT_TOOLS_ROOT,
    appLogPath = 'D:\\AliWorkbenchData\\System\\log\\app.log',
    sendMode = process.env.QIANNIU_DIRECT_SEND_MODE || 'direct',
    requestTimeoutMs = 80000,
    now = () => Date.now(),
  } = {}) {
    super();
    this.nodePath = nodePath;
    this.helperPath = helperPath;
    this.toolsRoot = toolsRoot;
    this.appLogPath = appLogPath;
    this.sendMode = sendMode;
    this.requestTimeoutMs = requestTimeoutMs;
    this.now = now;
    this.child = null;
    this.sequence = 0;
    this.pending = new Map();
  }

  getState() {
    return {
      status: this.child && !this.child.killed ? 'online' : 'stopped',
      pending: this.pending.size,
    };
  }

  stop() {
    const child = this.child;
    this.child = null;
    if (child && !child.killed) {
      try { child.send({ type: 'shutdown' }); } catch {}
      child.kill();
    }
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(submittedError(new Error('千牛发送 helper 已停止'), pending.submitted));
      this.pending.delete(requestId);
    }
  }

  async sendText(shopUid, cid, text, { timeoutMs = 30000 } = {}) {
    const child = this.#ensureStarted();
    const requestId = `QnDirectHelper-${this.now()}-${process.pid}-${++this.sequence}`;
    const startedAt = this.now();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(requestId);
        if (!pending) return;
        this.pending.delete(requestId);
        reject(submittedError(new Error('千牛发送 helper 等待超时'), pending.submitted));
      }, Math.max(this.requestTimeoutMs, timeoutMs + 50000));
      this.pending.set(requestId, {
        resolve,
        reject,
        timer,
        submitted: false,
        startedAt,
      });
      child.send({
        type: 'send',
        requestId,
        shopUid,
        cid,
        text,
        timeoutMs,
      }, (error) => {
        const pending = this.pending.get(requestId);
        if (!pending) return;
        if (error) {
          this.pending.delete(requestId);
          clearTimeout(timer);
          reject(submittedError(error, false));
          return;
        }
        pending.submitted = true;
      });
    });
  }

  #ensureStarted() {
    if (this.child && !this.child.killed) return this.child;
    const child = fork(this.helperPath, [], {
      execPath: this.nodePath,
      cwd: repoRoot,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: {
        ...process.env,
        QN_DIRECT_SEND_MODE: this.sendMode,
        QIANNIU_TOOLS_ROOT: this.toolsRoot,
        QN_APP_LOG: this.appLogPath,
      },
    });
    this.child = child;
    child.on('message', (message) => this.#handleMessage(message));
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = null;
      this.emit('exit', { code, signal });
      for (const [requestId, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(submittedError(
          new Error(`千牛发送 helper 已退出: ${code ?? signal ?? 'unknown'}`),
          pending.submitted,
        ));
        this.pending.delete(requestId);
      }
    });
    child.on('error', (error) => {
      this.emit('error', error);
    });
    return child;
  }

  #handleMessage(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'ready') {
      this.emit('ready', message);
      return;
    }
    if (message.type !== 'result' || typeof message.requestId !== 'string') return;
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    clearTimeout(pending.timer);
    if (message.ok) {
      pending.resolve({
        ...message.result,
        helper: {
          mode: 'node_rpc',
          duration_ms: message.durationMs ?? null,
          queue_wait_ms: message.queueWaitMs ?? null,
        },
      });
      return;
    }
    pending.reject(submittedError(new Error(message.error || '千牛发送 helper 执行失败'), true));
  }
}
