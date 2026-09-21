import { randomUUID } from 'node:crypto';

/** Owns notification data for one application run; never persists customer content. */
export class MessageNoticeWindow {
  constructor({ BrowserWindow, screen, preload, devServerUrl, rendererPath, onOpen }) {
    Object.assign(this, { BrowserWindow, screen, preload, devServerUrl, rendererPath, onOpen });
    this.startedAt = new Date().toISOString();
    this.window = null;
    this.disposed = false;
    this.state = { revision: 0, sessionId: '', since: this.startedAt, items: [], collapsed: false, hasUnseenCustomerMessage: false, status: 'signed_out', clockOffset: 0 };
    this.seenCustomerMessages = new Set();
    this.collapsedAt = null;
    this.ownerId = null;
    this.onDisplayChange = () => this.clampBounds();
  }

  create() {
    if (this.window || this.disposed) return;
    const { workArea } = this.screen.getDisplayNearestPoint(this.screen.getCursorScreenPoint());
    const width = Math.min(360, workArea.width);
    const height = Math.min(580, workArea.height);
    const window = new this.BrowserWindow({
      width, height, x: workArea.x + workArea.width - width - 16, y: workArea.y + workArea.height - height - 16,
      frame: false, resizable: false, maximizable: false, minimizable: false,
      alwaysOnTop: true, skipTaskbar: true, show: false, backgroundColor: '#ffffff',
      webPreferences: { preload: this.preload, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    this.window = window;
    window.setMenu(null);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.on('close', (event) => {
      if (this.disposed) return;
      event.preventDefault();
      this.setCollapsed(true);
    });
    window.once('ready-to-show', () => { this.clampBounds(); window.showInactive(); });
    window.on('closed', () => { this.window = null; });
    this.screen.on('display-removed', this.onDisplayChange);
    this.screen.on('display-metrics-changed', this.onDisplayChange);
    if (this.devServerUrl) {
      const url = new URL(this.devServerUrl);
      url.searchParams.set('view', 'message-notice');
      void window.loadURL(url.toString());
    } else {
      void window.loadFile(this.rendererPath, { query: { view: 'message-notice' } });
    }
  }

  clampBounds(bounds = this.window?.getBounds()) {
    if (!this.window || !bounds) return;
    const { workArea: area } = this.screen.getDisplayMatching(bounds);
    const width = Math.min(bounds.width, area.width);
    const height = Math.min(bounds.height, area.height);
    this.window.setBounds({ width, height,
      x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - width)),
      y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - height)),
    });
  }

  update(patch) {
    this.state = { ...this.state, ...patch, revision: this.state.revision + 1 };
    if (this.window && !this.window.isDestroyed()) this.window.webContents.send('message-notice:state', this.state);
    return this.state;
  }

  setOwner(userId) {
    if (this.ownerId === userId) return this.state;
    const firstLogin = !this.everOwned;
    this.ownerId = userId;
    this.seenCustomerMessages.clear();
    this.collapsedAt = this.state.collapsed ? Date.now() : null;
    if (userId) this.everOwned = true;
    return this.update({ sessionId: randomUUID(), since: firstLogin ? this.startedAt : new Date().toISOString(), items: [],
      status: userId ? 'connecting' : 'signed_out', clockOffset: 0, hasUnseenCustomerMessage: false });
  }

  publish(payload) {
    if (!this.ownerId || payload?.sessionId !== this.state.sessionId) return false;
    if (!['connected', 'connecting', 'disconnected', 'error'].includes(payload.status)) return false;
    const patch = { status: payload.status };
    if (Array.isArray(payload.items)) {
      // This channel accepts summaries only, from the trusted main renderer.
      patch.items = payload.items.filter((item) => item && typeof item.conversation_id === 'string'
        && typeof item.platform_code === 'string' && typeof item.message_id === 'string'
        && Number.isFinite(Date.parse(item.customer_message_at))
        && [null, 'ai', 'manual'].includes(item.reply_kind))
        .map((item) => ({ ...item, customer_name: String(item.customer_name || '').slice(0, 128),
          shop_name: String(item.shop_name || '').slice(0, 128), message_text: String(item.message_text || '').slice(0, 1000) }));
      const offset = Number.isFinite(payload.clockOffset) ? payload.clockOffset : this.state.clockOffset;
      for (const item of patch.items) {
        // message_id identifies the customer message even when the preview becomes an AI reply.
        const key = JSON.stringify([item.conversation_id, item.message_id]);
        if (this.state.collapsed && this.collapsedAt !== null && !this.seenCustomerMessages.has(key)
          && Date.parse(item.customer_message_at) >= this.collapsedAt + offset) {
          patch.hasUnseenCustomerMessage = true;
        }
        this.seenCustomerMessages.add(key);
      }
    }
    if (Number.isFinite(payload.clockOffset)) patch.clockOffset = payload.clockOffset;
    this.update(patch);
    return true;
  }

  setCollapsed(collapsed) {
    if (typeof collapsed !== 'boolean' || !this.window) return false;
    if (collapsed === this.state.collapsed) return true;
    this.collapsedAt = collapsed ? Date.now() : null;
    const bounds = this.window.getBounds();
    const width = collapsed ? 240 : 360;
    const height = collapsed ? 40 : 580;
    this.clampBounds({ width, height, x: bounds.x + bounds.width - width, y: bounds.y + bounds.height - height });
    this.update({ collapsed, hasUnseenCustomerMessage: false });
    return true;
  }

  open(conversationId) {
    const item = this.state.items.find((entry) => entry.conversation_id === conversationId);
    if (!item) return false;
    this.onOpen(item.conversation_id, item.platform_code);
    return true;
  }

  dispose() {
    this.disposed = true;
    this.screen.removeListener('display-removed', this.onDisplayChange);
    this.screen.removeListener('display-metrics-changed', this.onDisplayChange);
    this.state.items = [];
    this.state.hasUnseenCustomerMessage = false;
    this.seenCustomerMessages.clear();
    this.window?.destroy();
    this.window = null;
  }
}
