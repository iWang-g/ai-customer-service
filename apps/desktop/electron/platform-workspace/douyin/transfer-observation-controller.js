import { dialog } from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { transferObserverScript } from './transfer-observer.js';
import { DouyinTransferObservationBuffer } from './transfer-observation-buffer.js';

export class DouyinTransferObservationController {
  constructor(manager) { this.manager = manager; this.sessions = new Map(); }
  valid(id, s) {
    if (!s) return false;
    const m = this.manager, a = m.registry.get(s.userId, id);
    return this.sessions.get(id) === s && m.userId === s.userId && !m.closing && a && !a.paused && !a.archivedAt
      && a.loginStatus === 'online' && a.externalAccountId === s.shopId && a.platformAccountCsId === s.staffId
      && a.platformAccountId === s.platformAccountId && m.views.get(id) === s.view
      && !s.view.webContents.isDestroyed() && m.generations.get(id) === s.generation
      && (!s.frame || (!s.frame.detached && s.frame.url === s.frameUrl));
  }
  async execute(s, action) {
    let timer;
    try {
      return await Promise.race([
        s.frame.executeJavaScript(transferObserverScript({ action, token: s.token, shopId: s.shopId, staffId: s.staffId })),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('页面观察超时')), 10000); }),
      ]);
    } finally { clearTimeout(timer); }
  }
  clear(id) {
    const s = this.sessions.get(id); this.sessions.delete(id);
    if (!s) return;
    s.active = false; clearInterval(s.timer); clearTimeout(s.expiry);
    if (s.frame && !s.frame.detached) void this.execute(s, 'clear').catch(() => {});
  }
  async start(id) {
    const m = this.manager, a = m.account(id);
    if (this.sessions.get(id)?.active || this.sessions.get(id)?.finishing) throw new Error('该店铺转接观察正在运行');
    this.clear(id);
    const s = { token: randomUUID(), userId: m.userId, shopId: a.externalAccountId, staffId: a.platformAccountCsId,
      platformAccountId: a.platformAccountId, generation: m.generations.get(id), view: m.views.get(id),
      frame: null, frameUrl: null, active: true, buffer: new DouyinTransferObservationBuffer(), pending: null };
    this.sessions.set(id, s);
    try {
      if (!s.view || !s.staffId || !this.valid(id, s) || !m.runtime.get(id)?.imReady) throw new Error('请先登录并进入已识别客服身份的飞鸽接待页');
      const frames = s.view.webContents.mainFrame.framesInSubtree.filter((f) => /^https:\/\/(im|pigeon)\.jinritemai\.com\//.test(f.url)).slice(0, 4);
      let started = false;
      for (const frame of frames) {
        s.frame = frame; s.frameUrl = frame.url;
        const batch = await this.execute(s, 'start');
        if (!this.valid(id, s)) throw new Error('店铺页面已变化');
        if (batch?.error === 'im_not_ready') continue;
        if (batch?.error || !batch?.active || batch?.token !== s.token) throw new Error('无法建立转接观察，请刷新飞鸽页面并确认登录客服未变化');
        s.buffer.ingest(batch); started = true; break;
      }
      if (!started) throw new Error('未找到可观察转接方法的飞鸽页面');
      s.timer = setInterval(() => { void this.poll(id).catch(() => {}); }, 2000); s.timer.unref();
      s.expiry = setTimeout(() => { void this.stop(id).catch(() => {}); }, 10 * 60 * 1000); s.expiry.unref();
      await dialog.showMessageBox(m.window, { type: 'info', title: '转接观察已开始',
        message: '请在飞鸽原页面手动转接一个测试客户会话',
        detail: '选择除自己以外的在线客服。观察绑定首次转接的客户会话，最长 10 分钟。\n完成后选择店铺菜单“停止转接观察并导出”。正常返回不等于转接成功，请同时核对原平台提示和目标客服接收情况。', buttons: ['知道了'] });
    } catch (error) { if (this.sessions.get(id) === s) this.clear(id); throw error; }
  }
  async poll(id) {
    const s = this.sessions.get(id);
    if (!s?.active) return;
    if (s.pending) return s.pending;
    s.pending = (async () => {
      try {
        if (!this.valid(id, s)) throw new Error('店铺身份或页面已变化');
        const batch = await this.execute(s, 'poll');
        if (!this.valid(id, s) || batch?.error || batch?.token !== s.token) throw new Error('店铺身份或页面已变化');
        s.buffer.ingest(batch);
        if (!batch.active) { s.active = false; clearInterval(s.timer); }
      } catch (error) {
        if (this.sessions.get(id) === s) {
          this.clear(id);
          if (mWindow(this.manager)) void dialog.showMessageBox(this.manager.window, { type: 'warning', message: '转接观察已停止，店铺身份无法核验或页面已变化，样本已丢弃。' }).catch(() => {});
        }
        throw error;
      }
    })();
    try { await s.pending; } finally { s.pending = null; }
  }
  async stop(id) {
    const s = this.sessions.get(id); if (!s) throw new Error('暂无转接观察，请先开始');
    if (s.finishing) return s.finishing;
    s.finishing = this.finish(id, s);
    try { await s.finishing; } finally { s.finishing = null; }
  }
  async finish(id, s) {
    if (s.pending) await s.pending;
    if (!this.valid(id, s)) {
      if (this.sessions.get(id) === s) this.clear(id);
      throw new Error('店铺页面已变化，样本已丢弃');
    }
    if (s.finalized) return;
    s.active = false; clearInterval(s.timer); clearTimeout(s.expiry);
    try {
      const batch = await this.execute(s, 'stop');
      if (!this.valid(id, s) || batch?.error || batch?.token !== s.token) throw new Error('无法核验结束时的店铺身份，样本已丢弃');
      s.buffer.ingest(batch);
      await this.execute(s, 'clear');
      if (!this.valid(id, s)) throw new Error('店铺页面已变化，样本已丢弃');
      s.finalized = true;
    } catch (error) { if (this.sessions.get(id) === s) this.clear(id); throw error; }
  }
  async export(id) {
    const s = this.sessions.get(id);
    await this.stop(id);
    if (!this.valid(id, s) || !s.finalized) throw new Error('店铺页面已变化，无法导出');
    const choice = await dialog.showSaveDialog(this.manager.window, { title: '导出转接观察脱敏样本',
      defaultPath: `douyin-transfer-observation-${Date.now()}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (!choice.canceled && choice.filePath && this.valid(id, s)) await fs.writeFile(choice.filePath, JSON.stringify(s.buffer.export(), null, 2), 'utf8');
  }
}

function mWindow(m) { return m.window && !m.window.isDestroyed() && !m.closing; }
