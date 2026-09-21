import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, ipcMain, screen } from 'electron';
import { MessageNoticeWindow } from '../electron/message-notice-window.js';

const desktop = path.resolve(import.meta.dirname, '..');
const output = path.join(desktop, '.tmp', 'message-notice-smoke');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(output, 'profile-')));
let manager;
const errors = [];
const waitFor = async (predicate) => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error('Notification smoke timed out');
};

app.whenReady().then(async () => {
  const opened = [];
  manager = new MessageNoticeWindow({ BrowserWindow, screen,
    preload: path.join(desktop, 'electron', 'message-notice-preload.cjs'),
    rendererPath: path.join(desktop, 'dist', 'index.html'),
    onOpen: (...args) => opened.push(args),
  });
  ipcMain.handle('message-notice:get-state', () => manager.state);
  ipcMain.handle('message-notice:collapse', (_event, value) => manager.setCollapsed(value));
  ipcMain.handle('message-notice:open', (_event, id) => manager.open(id));
  manager.create();
  const window = manager.window;
  window.webContents.on('console-message', (_event, level, message) => { if (level === 3) errors.push(message); });
  window.webContents.on('render-process-gone', (_event, details) => errors.push(JSON.stringify(details)));
  const read = (script) => window.webContents.executeJavaScript(script);
  await waitFor(() => read('Boolean(document.querySelector(".notice-empty"))'));
  const owner = manager.setOwner('smoke-user');
  const now = Date.now();
  const fixture = (id, platform, customer, shop, text, seconds, reply = null) => ({
    conversation_id: id, platform_code: platform, message_id: `message-${id}`, customer_name: customer,
    shop_name: shop, message_text: text, customer_message_at: new Date(now - seconds * 1000).toISOString(),
    reply_kind: reply, replied_at: reply ? new Date(now).toISOString() : null,
  });
  const items = [
    fixture('1', 'qianniu', '念忘', '元喵创意社 YMiao', '亲，这款键帽是原厂印象款吗？', 5),
    fixture('2', 'pinduoduo', '小王', '机械键盘旗舰店', '刚拍下的订单今天可以发货吗？', 185),
    fixture('3', 'douyin', '夏天的风', '数码生活专营店', '这个套装有白色的吗？', 68, 'ai'),
    fixture('4', 'wechat', '小陈', '客服服务店', '[图片]', 100, 'manual'),
    fixture('5', 'qianniu', '这是一个用于测试超长客户名称的用户', '这是一家名称特别长的键盘配件及数码生活用品专营店', '这是很长的消息预览，应该只显示一行并用省略号结束，不应撑出通知窗口。', 179),
  ];
  manager.publish({ sessionId: owner.sessionId, status: 'connected', items, clockOffset: 0 });
  await waitFor(() => read('document.querySelectorAll(".notice-card").length === 5'));
  assert.equal(window.isAlwaysOnTop(), true);
  assert.equal(await read('document.body.scrollWidth <= window.innerWidth'), true);
  assert.equal(await read('typeof window.desktopBridge'), 'undefined', 'isolated notice preload must not expose account or send APIs');
  fs.writeFileSync(path.join(output, 'notice-all.png'), (await window.webContents.capturePage()).toPNG());
  await read('document.querySelectorAll(".notice-tabs button")[3].click()');
  await waitFor(() => read('document.querySelectorAll(".notice-card").length === 1'));
  assert.equal(await read('document.querySelector(".notice-status").textContent'), 'AI已回复');
  await read('document.querySelector(".notice-card").click()');
  await waitFor(() => opened.length === 1);
  assert.deepEqual(opened[0], ['3', 'douyin']);
  await read('document.querySelectorAll(".notice-tabs button")[0].click()');
  await read('document.querySelector(".notice-titlebar button").click()');
  await waitFor(() => manager.state.collapsed);
  await waitFor(() => read('Boolean(document.querySelector(".is-collapsed"))'));
  assert.equal(window.getBounds().height, 40);
  assert.equal(await read('Boolean(document.querySelector(".notice-new-message-dot"))'), false);
  items[0] = { ...items[0], message_id: 'new-customer-message', customer_message_at: new Date().toISOString() };
  manager.publish({ sessionId: owner.sessionId, status: 'connected', items });
  await waitFor(() => read('Boolean(document.querySelector(".notice-new-message-dot"))'));
  assert.equal(await read('getComputedStyle(document.querySelector(".notice-new-message-dot")).animationDuration'), '1.2s');
  assert.equal(await read('getComputedStyle(document.querySelector(".notice-new-message-dot")).backgroundColor'), 'rgb(255, 51, 79)');
  items[0] = { ...items[0], reply_kind: 'ai', message_text: '已为您查询，请稍等。' };
  manager.publish({ sessionId: owner.sessionId, status: 'connected', items });
  window.webContents.reload();
  await new Promise((resolve) => window.webContents.once('did-finish-load', resolve));
  await waitFor(() => read('Boolean(document.querySelector(".notice-new-message-dot"))'));
  fs.writeFileSync(path.join(output, 'notice-collapsed.png'), (await window.webContents.capturePage()).toPNG());
  await read('document.querySelector(".notice-titlebar button").click()');
  await waitFor(() => !manager.state.collapsed);
  await waitFor(() => read('!document.querySelector(".notice-new-message-dot")'));
  await waitFor(() => read('document.querySelectorAll(".notice-card").length === 5'));
  await waitFor(() => read('document.querySelectorAll(".notice-card.timeout").length === 2'));
  // Render reload rehydrates the in-memory run state.
  window.webContents.reload();
  await new Promise((resolve) => window.webContents.once('did-finish-load', resolve));
  await waitFor(() => read('document.querySelectorAll(".notice-card").length === 5'));
  manager.setOwner(null);
  await waitFor(() => read('document.querySelectorAll(".notice-card").length === 0'));
  assert.deepEqual(errors, []);
  console.log(`Message notice Electron smoke passed; screenshots: ${output}`);
  manager.dispose();
  app.quit();
}).catch((error) => {
  console.error(error);
  manager?.dispose();
  app.exit(1);
});
