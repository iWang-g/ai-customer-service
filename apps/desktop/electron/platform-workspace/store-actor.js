export class StoreActor {
  constructor({ accountId, rescan, onStateChange = null }) {
    this.accountId = accountId;
    this.rescan = rescan;
    this.onStateChange = onStateChange;
    this.state = 'idle';
    this.queue = [];
    this.coalescedTasks = new Map();
    this.rescanRequired = false;
    this.rescanReasons = new Set();
    this.running = false;
    this.currentTask = null;
    this.cancelled = false;
    this.cancelError = null;
    this.abortController = new AbortController();
  }

  enqueue(type, operation, { coalesceKey = null, rescanAfter = true } = {}) {
    if (this.cancelled) return Promise.reject(this.cancelError);
    if (coalesceKey && this.coalescedTasks.has(coalesceKey)) {
      return this.coalescedTasks.get(coalesceKey).promise;
    }

    let resolveTask;
    let rejectTask;
    const promise = new Promise((resolve, reject) => {
      resolveTask = resolve;
      rejectTask = reject;
    });
    const task = {
      type,
      operation,
      coalesceKey,
      rescanAfter,
      promise,
      resolve: resolveTask,
      reject: rejectTask,
    };
    this.queue.push(task);
    if (coalesceKey) this.coalescedTasks.set(coalesceKey, task);
    this.#start();
    return promise;
  }

  requestRescan(reason = 'requested') {
    if (this.cancelled) return;
    this.rescanRequired = true;
    this.rescanReasons.add(String(reason || 'requested').slice(0, 128));
    this.#start();
  }

  cancel(reason = '店铺页面已关闭') {
    if (this.cancelled) return;
    this.cancelled = true;
    this.cancelError = reason instanceof Error ? reason : new Error(String(reason));
    this.abortController.abort(this.cancelError);
    this.rescanRequired = false;
    this.rescanReasons.clear();
    this.currentTask?.reject(this.cancelError);
    for (const task of this.queue.splice(0)) {
      if (task.coalesceKey) this.coalescedTasks.delete(task.coalesceKey);
      task.reject(this.cancelError);
    }
    if (!this.running) this.#setState('cancelled');
  }

  #start() {
    if (this.running || this.cancelled) return;
    this.running = true;
    queueMicrotask(() => void this.#drain());
  }

  async #drain() {
    try {
      while (!this.cancelled) {
        if (!this.queue.length) {
          if (!this.rescanRequired) break;
          await this.#runRescan();
          continue;
        }

        const task = this.queue.shift();
        this.currentTask = task;
        try {
          this.#setState(task.type);
          const result = await task.operation({
            accountId: this.accountId,
            signal: this.abortController.signal,
            setState: (state) => this.#setState(state),
          });
          if (!this.cancelled) task.resolve(result);
        } catch (error) {
          task.reject(error);
        } finally {
          if (task.coalesceKey) this.coalescedTasks.delete(task.coalesceKey);
          this.currentTask = null;
        }

        if (task.rescanAfter && !this.cancelled) this.requestRescan(`after:${task.type}`);
        if (this.rescanRequired && !this.cancelled) await this.#runRescan();
      }
    } finally {
      this.running = false;
      this.#setState(this.cancelled ? 'cancelled' : 'idle');
      if (!this.cancelled && (this.queue.length || this.rescanRequired)) this.#start();
    }
  }

  async #runRescan() {
    const reasons = [...this.rescanReasons];
    this.rescanRequired = false;
    this.rescanReasons.clear();
    this.#setState('scanning');
    try {
      await this.rescan({ accountId: this.accountId, reasons });
    } catch (error) {
      this.onStateChange?.({
        accountId: this.accountId,
        state: 'scan_failed',
        error: error?.message || String(error),
      });
    }
  }

  #setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.onStateChange?.({ accountId: this.accountId, state });
  }
}
