import { randomUUID } from 'node:crypto';
import { openTransferLog } from './transfer-receipt.js';

export class QianniuTransferService {
  constructor({ channel, api, binding, appLogPath, busy, lock, unlock, openLog = openTransferLog, diagnostic = () => {} }) {
    Object.assign(this, { channel, api, binding, appLogPath, busy, lock, unlock, openLog, diagnostic });
    this.choices = new Map(); this.running = false; this.lastSelected = new Map();
  }
  reportDiagnostics(context, result, phase) {
    if (!Array.isArray(result?.diagnostics)) return;
    for (const d of result.diagnostics.slice(0, 100)) {
      if (d?.code !== 'staff_nick_mismatch' || typeof d.uid !== 'string' || !/^\d{1,30}$/.test(d.uid) ||
          d.mainUid !== result.before?.mainUid ||
          ![d.rosterNick, d.statusNick].every(n => typeof n === 'string' && n.length <= 128 && !/[\x00-\x1f]/.test(n))) continue;
      try {
        this.diagnostic(context.shopUid, 'transfer_staff_excluded', { phase, reason: d.code,
          staff_uid: d.uid, main_uid: d.mainUid, roster_nick: d.rosterNick, status_nick: d.statusNick,
          pc_online: d.pcOnline === true, mobile_online: d.mobileOnline === true, suspended: d.suspended === true }, 'warn');
      } catch { /* A logging failure must not alter the transfer outcome. */ }
    }
  }
  async context(conversationId, autoTaskId = null) {
    if (typeof conversationId !== 'string' || !/^[a-f0-9]{32}$/.test(conversationId)) throw new Error('千牛会话 ID 无效');
    const context = await this.api(autoTaskId
      ? `/conversations/${conversationId}/qianniu/auto-transfer/${autoTaskId}`
      : `/conversations/${conversationId}/qianniu/transfer-context`);
    if (this.binding(context.platformAccountId) !== context.shopUid) throw new Error('千牛账号未绑定当前用户');
    if ((!autoTaskId && ['preparing', 'ack_queued', 'ready'].includes(context.transfer?.status)) ||
        ['transferring', 'transferred', 'confirmation_pending'].includes(context.transfer?.status))
      throw new Error('该会话正在转接、已转接或结果待确认，请在千牛核对');
    return context;
  }
  async automatic(task, execute = false) {
    const conversationId = task.conversation_id || task.payload_json?.conversation_id;
    const context = await this.context(conversationId, task.id);
    if (task.platform_account_id !== context.platformAccountId ||
        task.payload_json?.qianniu_auto_operation_id !== context.transfer?.id)
      throw new Error('千牛自动转接任务身份不一致');
    const result = await this.channel.run(context, 'list');
    this.reportDiagnostics(context, result, execute ? 'automatic_execute_list' : 'automatic_prepare');
    if (!result.ok || !Array.isArray(result.targets))
      throw new Error(result.error || '千牛客服名单查询失败');
    if (!result.targets.length) return { status: 'no_online_target', submitted: false };
    const targets = [...result.targets].sort((a, b) => a.uid.localeCompare(b.uid));
    const shop = context.shopName.split(':')[0];
    const previous = this.lastSelected.get(shop);
    const target = (execute && targets.find(t => t.uid === context.transfer.target_uid)) ||
      targets[(targets.findIndex(t => t.uid === previous) + 1) % targets.length];
    if (!execute) {
      this.lastSelected.set(shop, target.uid);
      return { target: { uid: target.uid, nick: target.nick } };
    }
    const token = randomUUID();
    this.choices.set(token, { context, target, until: Date.now() + 120000 });
    this.lastSelected.set(shop, target.uid);
    return this.transfer({ conversationId, targetCsid: token, reason: '自动转接', autoTaskId: task.id });
  }
  async list({ conversationId }) {
    const context = await this.context(conversationId);
    const r = await this.channel.run(context, 'list');
    this.reportDiagnostics(context, r, 'manual_list');
    if (!r.ok || !Array.isArray(r.targets)) throw new Error(r.error || '千牛客服名单未返回');
    const now = Date.now();
    for (const [key, value] of this.choices) if (value.until < now) this.choices.delete(key);
    return { status: 'collected', cs_list: r.targets.map(t => {
      const key = randomUUID();
      this.choices.set(key, { context, target: t, until: now + 120000 });
      return { csid: key, accountName: t.nick, nickname: t.nick, remark: '', unreplyNum: 0,
        recvUser: null, bindWechat: false, onlineLabel: [t.pcOnline && '电脑在线', t.mobileOnline && '手机在线'].filter(Boolean).join('、') };
    }), trans_reason: [{ code: null, desc: '人工转接' }] };
  }
  async transfer({ conversationId, targetCsid, reason = '人工转接', autoTaskId = null }) {
    const choice = this.choices.get(targetCsid);
    if (!choice || choice.until < Date.now() || choice.context.conversationId !== conversationId) throw new Error('客服名单已过期，请刷新后重新选择');
    if (this.running) throw new Error('千牛正在执行另一次转接');
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 200 || /[\x00-\x1f]/.test(reason)) throw new Error('转接原因无效');
    this.running = true;
    let key, operation, log, locked = false;
    try {
      const context = await this.context(conversationId, autoTaskId);
      for (const name of ['shopUid', 'cid', 'buyerUid', 'buyerNick', 'platformAccountId'])
        if (context[name] !== choice.context[name]) throw new Error('会话身份变化，请重新选择客服');
      key = context.shopUid + '|' + context.cid;
      if (this.busy(key)) throw new Error('该会话有消息正在发送，请稍后转接');
      this.lock(key);
      locked = true;
      log = await this.openLog(this.appLogPath);
      operation = await this.api(`/conversations/${conversationId}/qianniu/transfer/begin`, {
        target_uid: choice.target.uid, target_nick: choice.target.nick, reason,
        ...(autoTaskId ? { auto_task_id: autoTaskId } : {}),
      });
      this.choices.delete(targetCsid);
      let outcome;
      try {
        const result = await this.channel.run(context, 'transfer', { targetUid: choice.target.uid, targetNick: choice.target.nick, reason });
        this.reportDiagnostics(context, result, 'transfer_recheck');
        outcome = result.invoked === false ? { status: 'failed', reason: result.error || '千牛未执行转接' }
          : await log.confirm(context, choice.target.uid);
      } catch (error) { outcome = { status: error.invoked === false ? 'failed' : 'confirmation_pending', reason: error.message }; }
      await this.api(`/conversations/${conversationId}/qianniu/transfer/finish`, {
        operation_id: operation.id, outcome: outcome.status, evidence: outcome.evidence || {}, error: outcome.reason || null,
      });
      if (outcome.status !== 'transferred') throw new Error(outcome.reason || '转接未确认，请勿重复提交');
      return { status: 'transferred', target_cs_id: choice.target.uid, target_cs_username: choice.target.nick, target_cs_nickname: choice.target.nick };
    } finally {
      if (log) await log.close().catch(() => {});
      if (locked) this.unlock(key);
      this.running = false;
    }
  }
}
