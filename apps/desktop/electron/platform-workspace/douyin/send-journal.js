import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Persist the attempt before touching the SDK. Recovery only replays results.
export class DouyinSendJournal {
  constructor(directory, userId) {
    this.directory = path.join(directory, 'douyin-sends', createHash('sha256').update(userId).digest('hex'));
    fs.mkdirSync(this.directory, { recursive: true });
  }
  file(taskId) {
    return path.join(this.directory, `${createHash('sha256').update(taskId).digest('hex')}.json`);
  }
  get(taskId) {
    const file = this.file(taskId);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  }
  begin(task, accountId) {
    const existing = this.get(task.id);
    if (existing) return existing;
    const entry = { taskId: task.id, accountId, userId: task.user_id,
      platformAccountId: task.platform_account_id, conversationId: task.payload_json.external_conversation_id,
      result: { status: 'confirmation_pending', error: '发送尝试已记录，等待平台确认' },
      updatedAt: new Date().toISOString() };
    fs.writeFileSync(this.file(task.id), JSON.stringify(entry), { flag: 'wx' });
    return entry;
  }
  finish(entry, result) {
    const updated = { ...entry, result, updatedAt: new Date().toISOString() };
    const file = this.file(entry.taskId);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(updated));
    fs.renameSync(`${file}.tmp`, file);
    return updated;
  }
  entries() {
    return fs.readdirSync(this.directory).filter((name) => name.endsWith('.json'))
      .map((name) => JSON.parse(fs.readFileSync(path.join(this.directory, name), 'utf8')));
  }
  event(entry) {
    const revision = createHash('sha256').update(JSON.stringify(entry.result)).digest('hex').slice(0, 16);
    return { event_id: `douyin-send:${entry.taskId}:${entry.result.status}:${revision}`,
      dedup_key: `douyin-send:${entry.taskId}:${entry.result.status}:${revision}`,
      event_type: 'douyin_send_result', platform_code: 'douyin',
      platform_account_id: entry.platformAccountId, conversation_external_id: entry.conversationId,
      received_at: entry.updatedAt, payload_json: { task_id: entry.taskId, ...entry.result } };
  }
}
