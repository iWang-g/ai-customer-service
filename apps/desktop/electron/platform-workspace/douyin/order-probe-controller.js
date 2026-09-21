import { dialog } from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { orderProbeScript } from './order-probe.js';
import { buildOrderProbeReport } from './order-probe-report.js';
import { mapDouyinOrders } from './orders.js';

export class DouyinOrderProbeController {
  constructor(manager) {
    this.manager = manager;
    this.identities = new Map();
    this.pending = new Map();
    this.reports = new Map();
  }

  observe(account, message, raw) {
    if (message.senderRole !== 'customer') return;
    const buyers = this.identities.get(account.id) || new Map();
    const buyerId = message.structuredPayload.buyer_id;
    const src = raw?.ext?.security_src_user_id;
    const previous = buyers.get(message.conversationId);
    buyers.delete(message.conversationId);
    buyers.set(message.conversationId, { userId: this.manager.userId, shopId: account.externalAccountId,
      platformAccountId: account.platformAccountId, buyerId,
      evidence: src == null || src === '' ? previous?.evidence || 'collected_conversation'
        : (typeof src === 'string' || Number.isSafeInteger(src)) && String(src) === buyerId
          ? 'security_src_user_id_matches' : 'conflict' });
    if (buyers.size > 500) buyers.delete(buyers.keys().next().value);
    this.identities.set(account.id, buyers);
  }

  cancel(requestId) {
    for (const [accountId, probe] of this.pending) {
      if (probe.requestId !== requestId) continue;
      this.pending.delete(accountId);
      if (probe.frame && !probe.frame.detached)
        void probe.frame.executeJavaScript(orderProbeScript({ action: 'cancel', token: probe.token })).catch(() => {});
    }
  }

  clear(accountId) {
    const probe = this.pending.get(accountId);
    if (probe) this.cancel(probe.requestId);
    this.identities.delete(accountId);
    this.reports.delete(accountId);
  }

  async show({ platformAccountId, externalConversationId, requestId }, parent, { collect = false } = {}) {
    const m = this.manager;
    if (!m.userId || m.closing) throw new Error('请先登录本系统');
    const userId = m.userId;
    const account = m.registry.list(userId).find((item) => item.platformAccountId === platformAccountId);
    if (!account) throw new Error('未找到本机绑定的抖店');
    const identity = this.identities.get(account.id)?.get(externalConversationId);
    if (!identity || identity.userId !== userId || identity.shopId !== account.externalAccountId
      || identity.platformAccountId !== platformAccountId)
      throw new Error('尚未采集到该客户的会话身份，请先让测试买家发送一条消息，再探测订单');
    if (identity.evidence === 'conflict') throw new Error('客户会话与买家安全标识不一致，未查询订单');
    if (this.pending.has(account.id)) throw new Error('该店铺订单探测正在运行，请稍候');
    const view = m.views.get(account.id);
    const generation = m.generations.get(account.id);
    const probe = { requestId, token: randomUUID(), frame: null };
    const valid = () => {
      const current = m.registry.get(userId, account.id);
      return m.userId === userId && !m.closing && current && !current.paused && !current.archivedAt
        && current.loginStatus === 'online' && current.externalAccountId === identity.shopId
        && current.platformAccountId === platformAccountId && m.runtime.get(account.id)?.imReady
        && view && !view.webContents.isDestroyed() && m.views.get(account.id) === view
        && m.generations.get(account.id) === generation && this.pending.get(account.id) === probe
        && this.identities.get(account.id)?.get(externalConversationId)?.evidence !== 'conflict';
    };
    this.pending.set(account.id, probe);
    if (!collect) this.reports.delete(account.id);
    const observedAt = new Date().toISOString();
    try {
      if (!valid()) throw new Error('请先打开并登录该店铺的飞鸽客服接待页面');
      const frames = view.webContents.mainFrame.framesInSubtree.filter((frame) =>
        /^https:\/\/(im|pigeon)\.jinritemai\.com\//.test(frame.url)).slice(0, 4);
      for (const frame of frames) {
        if (!valid()) throw new Error('订单探测已取消或店铺页面已变化');
        probe.frame = frame;
        const frameOrigin = new URL(frame.url).origin;
        let timer, result;
        try {
          result = await Promise.race([
            frame.executeJavaScript(orderProbeScript({ action: 'read', token: probe.token,
              shopId: identity.shopId, buyerId: identity.buyerId, conversationId: externalConversationId })),
            new Promise((resolve) => { timer = setTimeout(() => resolve({ error: 'cancelled_or_timeout' }), 17000); }),
          ]);
        } catch { result = { error: 'execution_error' }; }
        finally { clearTimeout(timer); }
        if (!valid() || frame.detached || new URL(frame.url).origin !== frameOrigin)
          throw new Error('会话或店铺页面已变化，订单探测结果已丢弃');
        if (result?.error === 'im_not_ready') continue;
        if (collect) return mapDouyinOrders(result, { shopId: identity.shopId, buyerId: identity.buyerId,
          conversationId: externalConversationId, requestToken: probe.token, frameOrigin, observedAt });
        const output = buildOrderProbeReport(result, { shopId: identity.shopId, buyerId: identity.buyerId,
          conversationId: externalConversationId, requestToken: probe.token, frameOrigin, buyerEvidence: identity.evidence });
        // Only the sanitized report survives the dialog. No raw payload enters
        // RPA events, the order database, or AI reply context.
        const sample = { userId, shopId: identity.shopId, report: output.report };
        this.reports.set(account.id, sample);
        const choice = await dialog.showMessageBox(parent, { type: output.report.error ? 'warning' : 'info',
          title: `客户订单探测 · ${account.alias}`, message: output.summary,
          detail: [`目标客户标识：${identity.buyerId}`, '本次客户请求返回的候选资料，待原平台核对。未回显买家身份不等于已独立确认订单归属。',
            ...output.preview, ...(output.report.previewTruncated ? ['预览有省略，请以原平台为准。'] : []),
            '仅查询首页最多 5 单，排序及总数尚未确认。金额未经换算，时间候选以 UTC 显示。',
            '此次只预览，不保存订单、不触发回复；导出不含上述订单资料原文。'].join('\n\n'),
          buttons: ['导出脱敏样本', '关闭'], defaultId: 0, cancelId: 1 });
        if (choice.response === 0 && valid() && this.reports.get(account.id) === sample)
          await this.export(account.id, parent);
        return;
      }
      throw new Error('未找到已就绪的飞鸽客服页面');
    } finally { this.cancel(requestId); }
  }

  async export(accountId, parent = this.manager.window) {
    const m = this.manager, sample = this.reports.get(accountId);
    const valid = () => sample && this.reports.get(accountId) === sample && !m.closing
      && m.userId === sample.userId && m.registry.get(sample.userId, accountId)?.externalAccountId === sample.shopId;
    if (!valid()) throw new Error('暂无订单探测样本，请先在客户会话中探测');
    const result = await dialog.showSaveDialog(parent, { title: '导出客户订单探测样本',
      defaultPath: `douyin-orders-probe-${Date.now()}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (!result.canceled && result.filePath && valid())
      await fs.writeFile(result.filePath, JSON.stringify(sample.report, null, 2), 'utf8');
  }
}

export function registerDouyinOrderProbeIpc(ipcMain, manager, getMainWindow) {
  const validate = (event, payload) => {
    const parent = getMainWindow();
    if (!parent || event.sender !== parent.webContents || event.senderFrame !== parent.webContents.mainFrame
      || !manager.userId || manager.closing || typeof payload?.requestId !== 'string'
      || !/^[a-zA-Z0-9-]{1,80}$/.test(payload.requestId)) throw new Error('订单探测请求无效');
    return parent;
  };
  ipcMain.handle('douyin-workspace:probe-orders', (event, payload) => {
    const parent = validate(event, payload);
    if (typeof payload.platformAccountId !== 'string' || !payload.platformAccountId || payload.platformAccountId.length > 128
      || typeof payload.externalConversationId !== 'string' || payload.externalConversationId.length > 350)
      throw new Error('订单会话参数无效');
    return manager.orderProbe.show(payload, parent);
  });
  ipcMain.handle('douyin-workspace:cancel-order-probe', (event, payload) => {
    validate(event, payload);
    manager.orderProbe.cancel(payload.requestId);
  });
}
