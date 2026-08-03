import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const REDACTED_KEY = /token|cookie|authorization|storage|secret|password/i;

function sanitize(value, depth = 0) {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') return value.slice(0, 500);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= 4) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => sanitize(item, depth + 1));
  if (typeof value !== 'object') return String(value).slice(0, 500);
  const result = {};
  for (const [key, item] of Object.entries(value).slice(0, 50)) {
    result[key] = REDACTED_KEY.test(key) ? '[redacted]' : sanitize(item, depth + 1);
  }
  return result;
}

export class PddDiagnosticLogger {
  constructor(directory, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
    this.directory = directory;
    this.maxBytes = maxBytes;
    this.filePath = path.join(directory, 'pinduoduo-collector.log');
    this.rotatedFilePath = `${this.filePath}.1`;
    this.pending = Promise.resolve();
    fs.mkdirSync(directory, { recursive: true });
  }

  write(accountId, payload) {
    const record = {
      timestamp: typeof payload?.observed_at === 'string'
        ? payload.observed_at.slice(0, 64)
        : new Date().toISOString(),
      level: ['debug', 'info', 'warn', 'error'].includes(payload?.level)
        ? payload.level
        : 'info',
      account_id: String(accountId || 'unknown').slice(0, 128),
      stage: String(payload?.stage || 'unknown').slice(0, 128),
      details: sanitize(payload?.details || {}),
    };
    const line = `${JSON.stringify(record)}\n`;
    this.pending = this.pending
      .then(() => this.#append(line))
      .catch((error) => console.error('[PDD diagnostic logger]', error));
  }

  async flush() {
    await this.pending;
  }

  async #append(line) {
    let size = 0;
    try {
      size = (await fs.promises.stat(this.filePath)).size;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (size + Buffer.byteLength(line) > this.maxBytes) {
      await fs.promises.rm(this.rotatedFilePath, { force: true });
      try {
        await fs.promises.rename(this.filePath, this.rotatedFilePath);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    await fs.promises.appendFile(this.filePath, line, 'utf8');
  }
}
