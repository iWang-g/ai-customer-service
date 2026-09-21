import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_RETENTION_DAYS = 30;

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatLocalDate(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cutoffDateKey(retentionDays) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - Math.max(1, retentionDays));
  return formatLocalDate(cutoff);
}

export class DailyLogFile {
  constructor({
    directory,
    baseName,
    extension = '.log',
    maxBytes = DEFAULT_MAX_BYTES,
    retentionDays = DEFAULT_RETENTION_DAYS,
  }) {
    this.directory = path.resolve(directory);
    this.baseName = baseName;
    this.extension = extension.startsWith('.') ? extension : `.${extension}`;
    this.maxBytes = maxBytes;
    this.retentionDays = retentionDays;
    this.currentDateKey = null;
    this.currentSequence = 1;
    this.cleanupDateKey = null;
    fs.mkdirSync(this.directory, { recursive: true });
  }

  currentPath(date = new Date()) {
    const dateKey = formatLocalDate(date);
    return this.#filePath(dateKey, this.currentDateKey === dateKey ? this.currentSequence : 1);
  }

  async append(line) {
    const targetPath = await this.#resolveAppendPath(Buffer.byteLength(line), true);
    await fs.promises.appendFile(targetPath, line, 'utf8');
  }

  appendSync(line) {
    const targetPath = this.#resolveAppendPathSync(Buffer.byteLength(line));
    fs.appendFileSync(targetPath, line, 'utf8');
  }

  async #resolveAppendPath(lineBytes, runCleanup) {
    const dateKey = formatLocalDate();
    if (this.currentDateKey !== dateKey) {
      this.currentDateKey = dateKey;
      this.currentSequence = await this.#latestSequence(dateKey);
    }
    let targetPath = this.#filePath(dateKey, this.currentSequence);
    const size = await this.#fileSize(targetPath);
    if (size > 0 && size + lineBytes > this.maxBytes) {
      this.currentSequence += 1;
      targetPath = this.#filePath(dateKey, this.currentSequence);
    }
    if (runCleanup && this.cleanupDateKey !== dateKey) {
      this.cleanupDateKey = dateKey;
      await this.#cleanup();
    }
    return targetPath;
  }

  #resolveAppendPathSync(lineBytes) {
    const dateKey = formatLocalDate();
    if (this.currentDateKey !== dateKey) {
      this.currentDateKey = dateKey;
      this.currentSequence = this.#latestSequenceSync(dateKey);
      this.#cleanupSync();
      this.cleanupDateKey = dateKey;
    }
    let targetPath = this.#filePath(dateKey, this.currentSequence);
    const size = this.#fileSizeSync(targetPath);
    if (size > 0 && size + lineBytes > this.maxBytes) {
      this.currentSequence += 1;
      targetPath = this.#filePath(dateKey, this.currentSequence);
    }
    return targetPath;
  }

  async cleanupOldFiles() {
    await this.#cleanup();
  }

  #filePath(dateKey, sequence) {
    const suffix = sequence > 1 ? `.${sequence}` : '';
    return path.join(this.directory, `${this.baseName}-${dateKey}${suffix}${this.extension}`);
  }

  #fileRegex() {
    return new RegExp(
      `^${escapeRegExp(this.baseName)}-(\\d{4}-\\d{2}-\\d{2})(?:\\.(\\d+))?${escapeRegExp(this.extension)}$`,
    );
  }

  async #latestSequence(dateKey) {
    try {
      const entries = await fs.promises.readdir(this.directory);
      return this.#latestSequenceFromEntries(entries, dateKey);
    } catch (error) {
      if (error?.code === 'ENOENT') return 1;
      throw error;
    }
  }

  #latestSequenceSync(dateKey) {
    try {
      return this.#latestSequenceFromEntries(fs.readdirSync(this.directory), dateKey);
    } catch (error) {
      if (error?.code === 'ENOENT') return 1;
      throw error;
    }
  }

  #latestSequenceFromEntries(entries, dateKey) {
    const pattern = this.#fileRegex();
    let latest = 1;
    for (const entry of entries) {
      const match = pattern.exec(entry);
      if (!match || match[1] !== dateKey) continue;
      latest = Math.max(latest, Number(match[2] || 1));
    }
    return latest;
  }

  async #fileSize(targetPath) {
    try {
      return (await fs.promises.stat(targetPath)).size;
    } catch (error) {
      if (error?.code === 'ENOENT') return 0;
      throw error;
    }
  }

  #fileSizeSync(targetPath) {
    try {
      return fs.statSync(targetPath).size;
    } catch (error) {
      if (error?.code === 'ENOENT') return 0;
      throw error;
    }
  }

  async #cleanup() {
    const deleteBefore = cutoffDateKey(this.retentionDays);
    const pattern = this.#fileRegex();
    let entries = [];
    try {
      entries = await fs.promises.readdir(this.directory);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    await Promise.all(entries.map(async (entry) => {
      const match = pattern.exec(entry);
      if (!match || match[1] >= deleteBefore) return;
      await fs.promises.rm(path.join(this.directory, entry), { force: true });
    }));
  }

  #cleanupSync() {
    const deleteBefore = cutoffDateKey(this.retentionDays);
    const pattern = this.#fileRegex();
    let entries = [];
    try {
      entries = fs.readdirSync(this.directory);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const match = pattern.exec(entry);
      if (!match || match[1] >= deleteBefore) continue;
      fs.rmSync(path.join(this.directory, entry), { force: true });
    }
  }
}
