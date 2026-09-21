import { dialog } from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { transferProbeScript } from './transfer-probe.js';
import { buildTransferProbeReport } from './transfer-probe-report.js';

export class DouyinTransferProbeController {
  constructor(manager) {
    this.manager = manager;
    this.pending = new Map();
    this.reports = new Map();
  }

  cancel(accountId) {
    const probe = this.pending.get(accountId);
    this.pending.delete(accountId);
    if (probe?.frame && !probe.frame.detached)
      void probe.frame.executeJavaScript(transferProbeScript({ action: 'cancel', token: probe.token })).catch(() => {});
  }

  clear(accountId) { this.cancel(accountId); this.reports.delete(accountId); }

  async show(accountId) {
    const m = this.manager, userId = m.userId;
    const account = m.account(accountId);
    if (this.pending.has(accountId)) throw new Error('该店铺转接客服探测正在运行');
    const view = m.views.get(accountId), generation = m.generations.get(accountId);
    const probe = { token: randomUUID(), frame: null };
    const valid = () => {
      const current = m.registry.get(userId, accountId);
      return userId && m.userId === userId && !m.closing && current && !current.paused && !current.archivedAt
        && current.loginStatus === 'online' && current.externalAccountId === account.externalAccountId
        && current.platformAccountCsId === account.platformAccountCsId
        && current.platformAccountId === account.platformAccountId && m.runtime.get(accountId)?.imReady
        && view && !view.webContents.isDestroyed() && m.views.get(accountId) === view
        && m.generations.get(accountId) === generation && this.pending.get(accountId) === probe;
    };
    this.pending.set(accountId, probe); this.reports.delete(accountId);
    try {
      if (!valid()) throw new Error('请先打开并登录该店铺飞鸽客服接待页');
      const frames = view.webContents.mainFrame.framesInSubtree.filter((f) => /^https:\/\/(im|pigeon)\.jinritemai\.com\//.test(f.url)).slice(0, 4);
      for (const frame of frames) {
        if (!valid()) throw new Error('店铺页面已变化');
        probe.frame = frame;
        const frameOrigin = new URL(frame.url).origin;
        let timer, result;
        try {
          result = await Promise.race([
            frame.executeJavaScript(transferProbeScript({ action: 'read', token: probe.token, shopId: account.externalAccountId })),
            new Promise((resolve) => { timer = setTimeout(() => resolve({ error: 'cancelled_or_timeout' }), 17000); }),
          ]);
        } catch { result = { error: 'execution_error' }; }
        finally { clearTimeout(timer); }
        if (!valid() || frame.detached || new URL(frame.url).origin !== frameOrigin)
          throw new Error('店铺页面已变化，探测结果已丢弃');
        if (result?.error === 'im_not_ready') continue;
        const output = buildTransferProbeReport(result, { shopId: account.externalAccountId, requestToken: probe.token, frameOrigin });
        const sample = { userId, shopId: account.externalAccountId, staffId: account.platformAccountCsId, generation, report: output.report };
        this.reports.set(accountId, sample);
        const choice = await dialog.showMessageBox(m.window, { type: output.report.error ? 'warning' : 'info',
          title: `转接客服探测 · ${account.alias}`, message: output.summary,
          detail: [`转接 SDK 方法：${output.report.capability.transferConversation ? '存在（尚未验证执行）' : '未发现'}`,
            ...output.preview, ...(output.report.previewTruncated ? ['候选或字段预览有省略。'] : []),
            '列表不代表所有客服均在线或可立即接待；请与原平台核对。',
            '本次仅查询，没有转移会话；导出文件不含客服姓名、账号或 ID 原文。'].join('\n\n'),
          buttons: ['导出脱敏样本', '关闭'], defaultId: 0, cancelId: 1 });
        if (choice.response === 0 && valid() && this.reports.get(accountId) === sample) await this.export(accountId);
        return;
      }
      throw new Error('未找到已就绪的飞鸽页面');
    } finally { if (this.pending.get(accountId) === probe) this.cancel(accountId); }
  }

  async export(accountId) {
    const m = this.manager, sample = this.reports.get(accountId);
    const valid = () => sample && !m.closing && m.userId === sample.userId && this.reports.get(accountId) === sample
      && m.registry.get(sample.userId, accountId)?.externalAccountId === sample.shopId
      && m.registry.get(sample.userId, accountId)?.platformAccountCsId === sample.staffId
      && m.generations.get(accountId) === sample.generation;
    if (!valid()) throw new Error('暂无转接客服探测样本，请先探测');
    const choice = await dialog.showSaveDialog(m.window, { title: '导出转接客服探测样本',
      defaultPath: `douyin-transfer-probe-${Date.now()}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (!choice.canceled && choice.filePath && valid()) await fs.writeFile(choice.filePath, JSON.stringify(sample.report, null, 2), 'utf8');
  }
}
