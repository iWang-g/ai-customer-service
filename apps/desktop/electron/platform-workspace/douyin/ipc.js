import { Menu, dialog } from 'electron';

export function registerDouyinWorkspaceIpc(ipcMain, manager) {
  let mutations = Promise.resolve();
  const handle = (name, operation, { account = false, booleanField = null, mutate = false } = {}) => {
    ipcMain.handle(`douyin-workspace:${name}`, (event, payload = {}) => {
      const validate = () => {
        if (!manager.window || event.sender !== manager.window.webContents
          || event.senderFrame !== event.sender.mainFrame || !manager.userId || manager.closing) {
          throw new Error('无效的抖店工作区请求');
        }
        if (account && (typeof payload?.accountId !== 'string' || !/^[0-9a-f-]{36}$/i.test(payload.accountId))) {
          throw new Error('店铺账号参数无效');
        }
        if (booleanField && typeof payload?.[booleanField] !== 'boolean') throw new Error('工作区参数无效');
      };
      validate();
      if (!mutate) return operation(payload);
      const result = mutations.then(() => { validate(); return operation(payload); });
      mutations = result.catch(() => {});
      return result;
    });
  };
  handle('get-state', () => manager.getState());
  handle('add-account', () => manager.addAccount(), { mutate: true });
  handle('select-account', (p) => manager.selectAccount(p.accountId), { account: true, mutate: true });
  handle('rename-account', (p) => manager.renameAccount(p.accountId, p.alias), { account: true, mutate: true });
  handle('detect-account-name', (p) => manager.detectAccountName(p.accountId), { account: true });
  handle('set-account-paused', (p) => manager.setAccountPaused(p.accountId, p.paused), { account: true, booleanField: 'paused', mutate: true });
  handle('remove-account', (p) => manager.removeAccount(p.accountId, p.clearStorage), { account: true, booleanField: 'clearStorage', mutate: true });
  handle('restore-account', (p) => manager.restoreAccount(p.accountId), { account: true, mutate: true });
  handle('set-overlay-open', (p) => manager.setOverlayOpen(p.open), { booleanField: 'open' });
  handle('go-back', () => manager.goBack());
  handle('go-forward', () => manager.goForward());
  handle('reload', () => manager.reload());
  handle('show-account-menu', (p) => {
    const account = manager.account(p.accountId);
    const userId = manager.userId;
    const run = (operation) => {
      if (manager.userId !== userId || manager.closing) return;
      void operation().catch((error) => {
        if (manager.userId === userId && manager.window && !manager.window.isDestroyed()) {
          void dialog.showMessageBox(manager.window, { type: 'error', message: error.message });
        }
      });
    };
    return new Promise((resolve) => {
      let resolved = false;
      const finish = (action = null) => { if (!resolved) { resolved = true; resolve(action); } };
      Menu.buildFromTemplate([
        { label: '重命名', click: () => finish('rename') },
        { label: '店铺名称重识别', enabled: !account.paused, click: () => finish('reidentify') },
        { type: 'separator' },
        { label: '探测商品列表（前 20 条）', enabled: !account.paused && account.loginStatus === 'online'
            && !manager.productProbes.has(account.id),
          click: () => { finish(); run(() => manager.showProductProbe(account.id)); } },
        { label: '导出商品列表探测样本', enabled: manager.productProbeReports.has(account.id),
          click: () => { finish(); run(() => manager.exportProductProbe(account.id)); } },
        { label: '导出商品详情探测样本', enabled: manager.productDetailProbeReports.has(account.id),
          click: () => { finish(); run(() => manager.exportProductProbe(account.id, { detail: true })); } },
        { label: '导出客户订单探测样本', enabled: manager.orderProbe.reports.has(account.id),
          click: () => { finish(); run(() => manager.orderProbe.export(account.id)); } },
        { label: '探测转接客服', enabled: !account.paused && account.loginStatus === 'online'
            && !manager.transferProbe.pending.has(account.id),
          click: () => { finish(); run(() => manager.transferProbe.show(account.id)); } },
        { label: '导出转接客服探测样本', enabled: manager.transferProbe.reports.has(account.id),
          click: () => { finish(); run(() => manager.transferProbe.export(account.id)); } },
        { label: '开始转接观察（10 分钟）', enabled: !account.paused && account.loginStatus === 'online'
            && !manager.transferObservation.sessions.get(account.id)?.active,
          click: () => { finish(); run(() => manager.transferObservation.start(account.id)); } },
        { label: '停止转接观察并导出', enabled: manager.transferObservation.sessions.has(account.id),
          click: () => { finish(); run(() => manager.transferObservation.export(account.id)); } },
        { type: 'separator' },
        { label: '开始消息观察（10 分钟）', enabled: !account.paused && !manager.observations.get(account.id)?.active,
          click: () => { finish(); run(() => manager.startObservation(account.id)); } },
        { label: '停止消息观察', enabled: manager.observations.get(account.id)?.active === true,
          click: () => { finish(); run(() => manager.stopObservation(account.id)); } },
        { label: '导出脱敏样本', enabled: Boolean(manager.observations.get(account.id)?.buffer.records.length),
          click: () => { finish(); run(() => manager.exportObservation(account.id)); } },
        { type: 'separator' },
        { label: account.paused ? '恢复运行' : '暂停运行', click: () => finish('toggle_paused') },
        { type: 'separator' }, { label: '移除店铺', click: () => finish('remove') },
      ]).popup({ window: manager.window, callback: () => finish() });
    });
  }, { account: true });
}
