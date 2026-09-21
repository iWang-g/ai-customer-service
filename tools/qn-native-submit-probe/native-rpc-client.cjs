'use strict';

const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const path = require('node:path');

const defaultExecutable = path.join(__dirname, 'build', 'qn_direct_general_probe_v3.exe');

function requestFrame({ requestId, shopUid, cid, text }) {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(requestId)) throw new TypeError('invalid native RPC request id');
  return `SEND\t${requestId}\t${shopUid}\t${cid}\t${Buffer.from(text, 'utf8').toString('hex')}\n`;
}

function terminalFrame(line) {
  const match = /^RPC_RESULT id=([A-Za-z0-9._-]+) code=(\d+) duration_ms=(\d+) retry=0$/.exec(line);
  return match ? { requestId: match[1], code: Number(match[2]), durationMs: Number(match[3]) } : null;
}

class NativeRpcClient extends EventEmitter {
  constructor({ executable = defaultExecutable, timeoutMs = 30000, spawnProcess = spawn } = {}) {
    super();
    this.executable = executable;
    this.timeoutMs = timeoutMs;
    this.spawnProcess = spawnProcess;
    this.child = null;
    this.ready = false;
    this.buffer = '';
    this.queue = [];
    this.current = null;
  }

  getState() {
    return { status: this.child && !this.child.killed && this.ready ? 'online' : 'starting',
      queued: this.queue.length, inFlight: this.current ? 1 : 0 };
  }

  send(request, { timeoutMs = this.timeoutMs } = {}) {
    const frame = requestFrame(request);
    this.#start();
    return new Promise((resolve, reject) => {
      this.queue.push({ request, frame, timeoutMs, resolve, reject, submitted: false, output: [] });
      this.#pump();
    });
  }

  stop() {
    const child = this.child;
    this.child = null;
    this.ready = false;
    if (child && !child.killed) {
      try { child.stdin.write('QUIT\n'); } catch {}
      child.kill();
    }
    this.#rejectAll(new Error('native RPC stopped'));
  }

  #start() {
    if (this.child && !this.child.killed) return;
    const child = this.spawnProcess(this.executable, ['--stdio-rpc'], {
      cwd: path.resolve(__dirname, '..', '..'),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.ready = false;
    this.buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => this.#data(chunk));
    child.stderr.on('data', chunk => this.emit('diagnostic', String(chunk)));
    child.on('error', error => this.#failed(child, error));
    child.on('exit', (code, signal) => this.#failed(child,
      new Error(`native RPC exited: ${code ?? signal ?? 'unknown'}`)));
  }

  #data(chunk) {
    this.buffer += chunk;
    let end;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end).replace(/\r$/, '');
      this.buffer = this.buffer.slice(end + 1);
      if (/^RPC_READY pid=\d+ protocol=1$/.test(line)) {
        this.ready = true;
        this.emit('ready');
        this.#pump();
        continue;
      }
      const terminal = terminalFrame(line);
      if (terminal) {
        this.#complete(terminal);
        continue;
      }
      if (this.current) this.current.output.push(line);
    }
  }

  #pump() {
    if (!this.ready || this.current || !this.queue.length || !this.child || this.child.killed) return;
    const item = this.queue.shift();
    this.current = item;
    item.timer = setTimeout(() => {
      if (this.current !== item) return;
      const error = new Error('native RPC request timed out; retryAllowed=false');
      error.submitted = item.submitted;
      error.retryAllowed = false;
      item.reject(error);
      this.current = null;
      const child = this.child;
      this.child = null;
      this.ready = false;
      if (child && !child.killed) child.kill();
      this.#rejectAll(new Error('native RPC was terminated after timeout'));
    }, Math.max(1000, item.timeoutMs));
    this.child.stdin.write(item.frame, error => {
      if (this.current !== item) return;
      if (error) {
        clearTimeout(item.timer);
        this.current = null;
        error.submitted = false;
        item.reject(error);
        this.#pump();
      } else item.submitted = true;
    });
  }

  #complete(terminal) {
    const item = this.current;
    if (!item || terminal.requestId !== item.request.requestId) {
      const child = this.child;
      this.child = null;
      this.ready = false;
      if (child && !child.killed) child.kill();
      this.#rejectAll(new Error('native RPC response identity mismatch'));
      return;
    }
    clearTimeout(item.timer);
    this.current = null;
    const output = [...item.output].join('\n') + '\n';
    if (terminal.code === 0) item.resolve({ output, durationMs: terminal.durationMs });
    else {
      const error = new Error(`native RPC refused request: exit=${terminal.code}; retryAllowed=false`);
      error.status = terminal.code;
      error.stdout = output;
      error.submitted = true;
      error.retryAllowed = false;
      item.reject(error);
    }
    this.#pump();
  }

  #failed(child, error) {
    if (this.child !== child) return;
    this.child = null;
    this.ready = false;
    this.#rejectAll(error);
  }

  #rejectAll(error) {
    if (this.current) {
      const item = this.current;
      this.current = null;
      clearTimeout(item.timer);
      const currentError = new Error(`${error.message}; retryAllowed=false`);
      currentError.submitted = item.submitted;
      currentError.retryAllowed = false;
      item.reject(currentError);
    }
    for (const item of this.queue.splice(0)) {
      const queuedError = new Error(error.message);
      queuedError.submitted = false;
      queuedError.retryAllowed = false;
      item.reject(queuedError);
    }
  }
}

module.exports = { NativeRpcClient, requestFrame, terminalFrame };
