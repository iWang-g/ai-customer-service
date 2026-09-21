import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import ts from 'typescript';
import { MessageNoticeWindow } from '../electron/message-notice-window.js';

const source = fs.readFileSync(new URL('../src/message-notice/types.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022 } });
const { elapsedSeconds, noticeStatus, filterNotices } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
const time = Date.now();
const item = { conversation_id: 'c1', platform_code: 'qianniu', message_id: 'm1', customer_message_at: new Date(time).toISOString(), reply_kind: null };
assert.equal(elapsedSeconds(item, time), 1);
assert.equal(elapsedSeconds(item, time + 179000), 179);
assert.equal(noticeStatus(item, time + 180000), 'pending');
assert.equal(noticeStatus(item, time + 181000), 'timeout');
assert.equal(noticeStatus({ ...item, reply_kind: 'ai' }, time + 3600000), 'ai');
assert.equal(noticeStatus({ ...item, reply_kind: 'manual' }, time + 3600000), 'manual');
assert.equal(filterNotices([item], 'pending', 'douyin', time).length, 0);
assert.equal(filterNotices([{ ...item, reply_kind: 'manual' }], 'ai', 'all', time).length, 0);

class FakeWindow extends EventEmitter {
  constructor(options) {
    super(); this.options = options; this.bounds = options; this.webContents = new EventEmitter();
    this.webContents.setWindowOpenHandler = () => {};
    this.webContents.send = (_channel, state) => { this.lastState = state; };
  }
  setMenu() {}
  getBounds() { return this.bounds; }
  setBounds(bounds) { this.bounds = bounds; }
  isDestroyed() { return false; }
  loadURL(url) { this.url = url; return Promise.resolve(); }
  showInactive() { this.visible = true; }
  destroy() { this.destroyed = true; this.emit('closed'); }
}
const screen = new EventEmitter();
let area = { x: -1280, y: 0, width: 1280, height: 720 };
screen.getDisplayNearestPoint = screen.getDisplayMatching = () => ({ workArea: area });
screen.getCursorScreenPoint = () => ({ x: -100, y: 100 });
const opened = [];
const manager = new MessageNoticeWindow({ BrowserWindow: FakeWindow, screen, preload: 'test', devServerUrl: 'http://localhost:9527', onOpen: (...args) => opened.push(args) });
manager.create();
const window = manager.window;
window.emit('ready-to-show');
assert.equal(window.options.alwaysOnTop, true);
assert.equal(window.options.webPreferences.nodeIntegration, false);
assert.equal(window.visible, true);
const first = manager.setOwner('user1');
manager.publish({ sessionId: first.sessionId, status: 'connected', items: [item] });
manager.setCollapsed(true);
assert.equal(window.bounds.height, 40);
assert.equal(manager.state.items.length, 1);
assert.equal(manager.state.hasUnseenCustomerMessage, false, 'collapsing existing messages does not alert');
const publishItems = (items) => manager.publish({ sessionId: first.sessionId, status: 'connected', items });
publishItems([{ ...item, reply_kind: 'ai', message_text: 'AI reply' }]);
assert.equal(manager.state.hasUnseenCustomerMessage, false, 'reply-only updates do not alert');
publishItems([{ ...item, message_id: 'history', customer_message_at: new Date(manager.collapsedAt - 10000).toISOString() }]);
assert.equal(manager.state.hasUnseenCustomerMessage, false, 'late history does not alert');
const newMessage = { ...item, message_id: 'm2', customer_message_at: new Date(manager.collapsedAt + 100).toISOString() };
publishItems([newMessage]);
assert.equal(manager.state.hasUnseenCustomerMessage, true);
manager.publish({ sessionId: first.sessionId, status: 'disconnected' });
publishItems([{ ...newMessage, reply_kind: 'ai', message_text: 'AI reply' }]);
manager.setCollapsed(true);
assert.equal(manager.state.hasUnseenCustomerMessage, true, 'AI reply and repeated collapse preserve the alert');
assert.equal(manager.state.collapsed, true, 'new messages must not force expansion');
manager.open('c1');
assert.deepEqual(opened, [['c1', 'qianniu']]);
assert.equal(manager.open('foreign-conversation'), false);
area = { x: 0, y: 0, width: 800, height: 600 };
screen.emit('display-removed');
assert.ok(window.bounds.x >= 0);
manager.setCollapsed(false);
assert.equal(manager.state.hasUnseenCustomerMessage, false, 'expansion acknowledges the alert');
manager.setCollapsed(true);
publishItems([]);
publishItems([newMessage]);
assert.equal(manager.state.hasUnseenCustomerMessage, false, 'replayed snapshots cannot re-alert an acknowledged message');
publishItems([{ ...newMessage, message_id: 'm3', customer_message_at: new Date(manager.collapsedAt + 200).toISOString() }]);
assert.equal(manager.state.hasUnseenCustomerMessage, true, 'another customer message alerts again');
assert.ok(window.bounds.y + window.bounds.height <= 600);
manager.setOwner(null);
assert.equal(manager.state.items.length, 0);
assert.equal(manager.state.hasUnseenCustomerMessage, false, 'logout clears the alert');
assert.equal(manager.publish({ sessionId: first.sessionId, status: 'connected', items: [item] }), false, 'late old-session results cannot repopulate data');
manager.setOwner('user2');
assert.equal(manager.state.items.length, 0);
manager.dispose();
assert.equal(window.destroyed, true);
assert.equal(screen.listenerCount('display-removed'), 0);
console.log('Message notice: timer boundaries, filters, session isolation, collapse, display recovery and navigation passed');
