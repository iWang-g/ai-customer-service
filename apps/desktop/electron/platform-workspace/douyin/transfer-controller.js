import { randomUUID } from 'node:crypto';
import { transferClientScript } from './transfer-client.js';

export class DouyinTransferController {
  constructor(manager) {
    this.manager = manager; this.choices = new Map(); this.running = new Set();
    this.autoTasks = new Map(); this.autoQueues = new Map(); this.lastSelected = new Map();
  }
  async api(userId, path, body) {
    const m = this.manager, rpa = m.rpaManager;
    if (m.userId !== userId || m.closing || rpa?.userId !== userId || !rpa.accessToken) throw new Error('请重新登录本系统');
    const response = await fetch(`${rpa.apiBaseUrl}${path}`, { method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${rpa.accessToken}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000) });
    const result = await response.json();
    if (m.userId !== userId || m.closing) throw new Error('登录用户已变化');
    if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : '转接状态请求失败');
    return result;
  }
  async context(conversationId, autoTaskId = null) {
    if (!/^[a-f0-9]{32}$/.test(conversationId || '')) throw new Error('会话参数无效');
    const m = this.manager, userId = m.userId;
    const c = await this.api(userId, autoTaskId
      ? `/conversations/${conversationId}/douyin/auto-transfer/${autoTaskId}`
      : `/conversations/${conversationId}/douyin/transfer-context`);
    if ((!autoTaskId && ['preparing', 'ack_queued', 'ready'].includes(c.transfer?.status))
      || ['transferring', 'transferred', 'confirmation_pending'].includes(c.transfer?.status)) throw new Error('会话正在转接、已转出或待核对，请勿重复转接');
    const account = m.registry.get(userId, c.localAccountId), view = m.views.get(c.localAccountId);
    if (!account || !view || account.platformAccountId !== c.platformAccountId || account.externalAccountId !== c.shopId
      || account.platformAccountCsId !== c.staffId) throw new Error('店铺或当前客服身份尚未同步，请重新进入飞鸽');
    return { ...c, userId, view, generation: m.generations.get(c.localAccountId) };
  }
  valid(c) {
    const m = this.manager, a = m.registry.get(c.userId, c.localAccountId);
    return m.userId === c.userId && !m.closing && a && !a.paused && !a.archivedAt && a.loginStatus === 'online'
      && a.platformAccountId === c.platformAccountId && a.externalAccountId === c.shopId && a.platformAccountCsId === c.staffId
      && m.views.get(c.localAccountId) === c.view && !c.view.webContents.isDestroyed()
      && m.generations.get(c.localAccountId) === c.generation;
  }
  async frame(c) {
    if (!this.valid(c)) throw new Error('店铺页面已变化');
    for (const frame of c.view.webContents.mainFrame.framesInSubtree.slice(0, 8)) {
      if (!/^https:\/\/(im|pigeon)\.jinritemai\.com\//.test(frame.url)) continue;
      if (await frame.executeJavaScript('Boolean(window.__PLATFORM_VARIABLES_IN_BENCH__?.extra?.im?.pigeonIM?.transferConversation)')) {
        if (!this.valid(c)) throw new Error('店铺页面已变化');
        return frame;
      }
    }
    throw new Error('请先打开已登录的飞鸽接待页');
  }
  async execute(c, frame, action, extra = {}) {
    if (!this.valid(c) || frame.detached) throw new Error('店铺页面已变化');
    let timer;
    try {
      const result = await Promise.race([
        frame.executeJavaScript(transferClientScript({ action, token: randomUUID(), shopId: c.shopId, staffId: c.staffId, cid: c.cid, ...extra })),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('平台转接请求超时，请在飞鸽核对')), 18000); }),
      ]);
      if (!this.valid(c) || frame.detached) throw new Error('店铺页面已变化');
      return result;
    } finally { clearTimeout(timer); }
  }
  async list({ conversationId }) {
    const c = await this.context(conversationId);
    const result = await this.execute(c, await this.frame(c), 'list');
    const now = Date.now();
    for (const [key, choice] of this.choices) if (choice.until < now || choice.c.userId !== c.userId) this.choices.delete(key);
    return { status: 'collected', cs_list: result.targets.map((target) => {
      const csid = randomUUID(); this.choices.set(csid, { c, target, until: now + 120000 });
      return { csid, nickname: target.name, accountName: target.name, remark: '', unreplyNum: 0,
        recvUser: null, bindWechat: false, onlineLabel: '在线' };
    }), trans_reason: [{ code: null, desc: '人工转接' }] };
  }
  handleTask(task) {
    if (task.user_id !== this.manager.userId || this.manager.closing) return Promise.resolve();
    if (this.autoTasks.has(task.id)) return this.autoTasks.get(task.id);
    const key = `${task.user_id}:${task.platform_account_id}`;
    const run = async () => {
      try {
        const result = await this.automatic(task);
        if (this.manager.userId === task.user_id && !this.manager.closing)
          this.manager.rpaManager.completeTask(task.id, 'completed', result);
      } catch (error) {
        if (this.manager.userId === task.user_id && !this.manager.closing)
          this.manager.rpaManager.completeTask(task.id, 'failed', {}, String(error.message || '自动转接失败').slice(0, 500));
      }
    };
    const operation = (this.autoQueues.get(key) || Promise.resolve()).then(run);
    this.autoTasks.set(task.id, operation); this.autoQueues.set(key, operation);
    void operation.finally(() => {
      this.autoTasks.delete(task.id);
      if (this.autoQueues.get(key) === operation) this.autoQueues.delete(key);
    });
    return operation;
  }
  async automatic(task) {
    const execute = task.task_type === 'douyin_transfer_execute';
    if (!execute && task.task_type !== 'douyin_transfer_prepare') throw new Error('无效的自动转接任务');
    const conversationId = task.conversation_id;
    const c = await this.context(conversationId, task.id);
    if (task.user_id !== c.userId || task.platform_account_id !== c.platformAccountId
      || task.payload_json?.douyin_auto_operation_id !== c.transfer?.id) throw new Error('自动转接任务身份不匹配');
    const result = await this.execute(c, await this.frame(c), 'list');
    const targets = [...result.targets].sort((a, b) => a.id.localeCompare(b.id));
    if (!targets.length) return { status: 'no_online_target' };
    const key = `${c.userId}:${c.shopId}`;
    const previous = this.lastSelected.get(key);
    const target = execute ? targets.find(t => t.id === c.transfer.target_id)
      : targets[(targets.findIndex(t => t.id === previous) + 1) % targets.length];
    if (!target) throw new Error('所选客服已不在线，本次未转接');
    if (!execute) { this.lastSelected.set(key, target.id); return { target: { id: target.id, name: target.name } }; }
    const token = randomUUID();
    this.choices.set(token, { c, target, until: Date.now() + 120000 });
    return this.transfer({ conversationId, targetCsid: token, reason: '自动转接', autoTaskId: task.id });
  }
  async transfer({ conversationId, targetCsid, reason = '人工转接', autoTaskId = null }) {
    const choice = this.choices.get(targetCsid);
    if (!choice || choice.until < Date.now() || choice.c.conversationId !== conversationId || !this.valid(choice.c))
      throw new Error('客服名单已过期或店铺变化，请刷新后重新选择');
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 200) throw new Error('转接原因无效');
    const accountId = choice.c.localAccountId;
    if (this.running.has(accountId)) throw new Error('该店铺正在转接，请稍候');
    this.running.add(accountId);
    let c, operation, result;
    try {
      c = await this.context(conversationId, autoTaskId);
      if (['shopId', 'staffId', 'cid', 'platformAccountId', 'generation'].some((k) => c[k] !== choice.c[k])) throw new Error('会话或登录客服变化，请重新选择');
      const frame = await this.frame(c);
      // Verify before establishing the durable barrier, then recheck again immediately before SDK submission.
      const refreshed = await this.execute(c, frame, 'list');
      const target = refreshed.targets.find((t) => t.id === choice.target.id);
      if (!target) throw new Error('所选客服已不在线，请刷新列表');
      operation = await this.api(c.userId, `/conversations/${conversationId}/douyin/transfer/begin`, {
        target_id: target.id, target_name: target.name, source_id: c.staffId, reason,
        ...(autoTaskId ? { auto_task_id: autoTaskId } : {}),
      });
      this.choices.delete(targetCsid);
      try {
        result = await this.execute(c, frame, 'submit', { operationId: operation.id, targetId: target.id });
        const deadline = Date.now() + 20000;
        while (result.status === 'confirmation_pending' && Date.now() < deadline && this.valid(c)) {
          await new Promise((resolve) => setTimeout(resolve, 300));
          result = await this.execute(c, frame, 'poll', { operationId: operation.id, targetId: target.id });
        }
      } catch { result = { status: 'confirmation_pending', error: '转接结果待核对，请在飞鸽确认，勿重复提交' }; }
      await this.api(c.userId, `/conversations/${conversationId}/douyin/transfer/finish`, {
        operation_id: operation.id, outcome: result.status, evidence: result.evidence || {}, error: result.error || null,
      });
      if (result.status !== 'transferred') throw new Error(result.error || '转接结果待核对');
      return { status: 'transferred', target_cs_id: target.id, target_cs_username: target.name, target_cs_nickname: target.name };
    } catch (error) {
      if (operation && result?.status === 'transferred') throw new Error('平台已确认转出，但结果保存未完成，请刷新会话核对，勿重复转接');
      throw error;
    } finally { this.running.delete(accountId); }
  }
  async validateSend(task) {
    const a = this.manager.registry.list(task.user_id).find((item) => item.platformAccountId === task.platform_account_id);
    if (a && this.running.has(a.id)) throw new Error('店铺正在转接，已暂停发送');
    const result = await this.api(task.user_id, `/conversations/douyin/send-guard/${encodeURIComponent(task.id)}`);
    if (!result.allowed) throw new Error('会话已转出、正在转接或发送任务已失效');
  }
}

export function registerDouyinTransferIpc(ipcMain, manager, getMainWindow) {
  for (const [name, method] of [['list-transfer-targets', 'list'], ['transfer-conversation', 'transfer']])
    ipcMain.handle(`douyin-workspace:${name}`, (event, payload) => {
      const parent = getMainWindow();
      if (!parent || event.sender !== parent.webContents || event.senderFrame !== parent.webContents.mainFrame
        || !manager.userId || manager.closing || typeof payload?.conversationId !== 'string') throw new Error('转接请求无效');
      return manager.transfer[method](payload);
    });
}
