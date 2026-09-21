import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  qianniuAccountFromBridgeClient,
  qianniuEventsForIncomingMessage,
  sendTargetFromTask,
  normalizeQianniuMessage,
} from './message-mapper.js';
import { mergeMessageParts, needsMediaCompletion } from './message-parts.js';
import { QianniuDirectSendClient } from './direct-send-client.js';
import { QianniuOrderReader } from './order-reader.js';
import { QianniuProductsReader } from './products-reader.js';
import { installMessageReader } from './install-message-reader.js';
import { randomUUID } from 'node:crypto';
import { QianniuTransferChannel } from './transfer-channel.js';
import { QianniuTransferService } from './transfer-service.js';

const require = createRequire(import.meta.url);
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDirectory, '..', '..', '..', '..');
const DEFAULT_APP_LOG = 'D:\\AliWorkbenchData\\System\\log\\app.log';
const DEFAULT_BRIDGE_BASE = 'http://127.0.0.1:18082/qn-bridge';
const DEFAULT_POLL_MS = 250;
const DEFAULT_CLIENT_REFRESH_MS = 5000;

export function findCompleteLine(fd, offset) {
  const stat = fs.fstatSync(fd);
  if (stat.size < offset) offset = 0;
  if (stat.size === offset) return { offset, lines: [] };
  const length = stat.size - offset;
  const buffer = Buffer.alloc(length);
  fs.readSync(fd, buffer, 0, length, offset);
  const text = buffer.toString('utf8');
  const lastNewline = text.lastIndexOf('\n');
  if (lastNewline < 0) return { offset, lines: [] };
  const complete = text.slice(0, lastNewline + 1);
  return {
    offset: offset + Buffer.byteLength(complete),
    lines: complete.split(/\r?\n/).filter(Boolean),
  };
}

export function parseQianniuWake(line) {
  if (!String(line || '').includes('OnMessageArrive')) return null;
  const cid = /dmsg\.cid=([^,\]\s]+)/.exec(line)?.[1] ||
    /msg\.msg\.conversationCode=([^,\]\s]+)/.exec(line)?.[1] || '';
  if (!cid) return null;
  return {
    cid,
    messageId: /dmsg\.mid=([^,\]\s]+)/.exec(line)?.[1] ||
      /msg\.msg\.code\.messageId=([^,\]\s]+)/.exec(line)?.[1] || '',
    shopUid: /MessageSDK.*?\[3#(\d+)\]/.exec(line)?.[1] ||
      /\[CHAT [^\]#]+#3#(\d+)\]/.exec(line)?.[1] || '',
    senderUid: /dmsg\.sender\.uid=([^,\]\s]+)/.exec(line)?.[1] ||
      /msg\.sendProfile->target\.targetId=([^,\]\s]+)/.exec(line)?.[1] || '',
  };
}

export class QianniuWorkerManager extends EventEmitter {
  constructor({
    enabled = false,
    appLogPath = DEFAULT_APP_LOG,
    bridgeBase = DEFAULT_BRIDGE_BASE,
    toolsRoot = path.join(repoRoot, 'tools'),
    nodePath = process.env.QIANNIU_NODE_PATH || 'node',
    diagnosticLogger = null,
    readMessages = null,
    sendText = null,
    directSendClient = null,
    useDirectSendHelper = true,
    now = () => new Date().toISOString(),
    pollMs = DEFAULT_POLL_MS,
    clientRefreshMs = DEFAULT_CLIENT_REFRESH_MS,
    orderDataPath = path.join(repoRoot, '.tmp', 'qianniu-orders'),
    businessApi = null,
    sendGuard = null,
  } = {}) {
    super();
    this.enabled = Boolean(enabled);
    this.appLogPath = appLogPath;
    this.bridgeBase = bridgeBase.replace(/\/$/, '');
    this.toolsRoot = toolsRoot;
    this.nodePath = nodePath;
    this.diagnosticLogger = diagnosticLogger;
    this.readMessages = readMessages;
    this.sendText = sendText;
    this.injectedSendText = typeof sendText === 'function';
    this.directSendClient = directSendClient;
    this.useDirectSendHelper = useDirectSendHelper;
    this.now = now;
    this.pollMs = pollMs;
    this.clientRefreshMs = clientRefreshMs;
    this.orderReader = new QianniuOrderReader({ dataPath: orderDataPath, bridgeBase });
    this.productsReader = new QianniuProductsReader({ dataPath: path.join(orderDataPath, '..', 'qianniu-products') });
    this.shopProfiles = new Map(); this.shopProfileAttempts = new Map(); this.shopProfileReads = new Set();
    this.businessApi = businessApi;
    this.sendGuard = sendGuard;
    this.activeSends = new Map(); this.transferLocks = new Set();
    this.transferChannel = new QianniuTransferChannel({ dataPath: path.join(orderDataPath, '..', 'qianniu-transfer') });
    this.transferService = new QianniuTransferService({ channel: this.transferChannel,
      diagnostic: (...args) => this.#diagnostic(...args),
      api: (...args) => { if (!this.businessApi) throw new Error('千牛转接业务服务未就绪'); return this.businessApi(...args); },
      binding: id => this.platformAccountBindings.get(id), appLogPath,
      busy: key => this.activeSends.has(key) || this.transferLocks.has(key),
      lock: key => this.transferLocks.add(key), unlock: key => this.transferLocks.delete(key) });
    this.productReads = new Map();
    this.productSyncStates = new Map();
    this.messageDataPath = path.join(orderDataPath, '..', 'qianniu-messages');
    this.resourceInstallation = null;
    this.orderReads = new Map();
    this.bridgeProcess = null;
    this.logFd = null;
    this.logOffset = 0;
    this.pollTimer = null;
    this.clientTimer = null;
    this.processing = false;
    this.bridgeNoticeInstanceId = '';
    this.bridgeNoticeSeq = 0;
    this.lastBridgeNoticeErrorAt = 0;
    this.seen = new Set();
    this.pendingBindings = new Map();
    this.bindingReplay = Promise.resolve();
    this.messageCache = new Map();
    this.mediaTimers = new Map();
    this.readQueue = Promise.resolve();
    this.historyReads = new Map();
    this.generation = 0;
    this.platformAccountBindings = new Map();
    this.accounts = [];
    this.directSendClientState = {
      status: 'stopped',
      pending: 0,
    };
    this.state = {
      status: this.enabled ? 'stopped' : 'disabled',
      detail: null,
      bridgeClientCount: 0,
      lastEventAt: null,
    };
  }

  getState() {
    return {
      ...this.state,
      directSendHelper: { ...this.directSendClientState },
    };
  }

  knownAccounts() {
    return this.accounts.map((account) => ({
      ...account,
      metadata_json: { ...(account.metadata_json || {}) },
    }));
  }

  applyBindings(bindings = []) {
    for (const binding of bindings) {
      if (binding?.platform_code !== 'qianniu') continue;
      const localId = String(binding.local_account_id || '');
      const match = /^qianniu-(\d+)$/.exec(localId);
      if (!match || !binding.platform_account_id) continue;
      this.platformAccountBindings.set(String(binding.platform_account_id), match[1]);
      this.platformAccountBindings.set(match[1], String(binding.platform_account_id));
    }
    const generation = this.generation;
    for (const [key, pending] of this.pendingBindings) {
      if (!this.platformAccountBindings.has(pending.shopUid)) continue;
      this.pendingBindings.delete(key);
      this.bindingReplay = this.bindingReplay.then(async () => {
        if (generation !== this.generation) return;
        await this.#processWake(pending.wake, Date.now() - pending.at > 60000, pending.source);
      }).catch(error => this.#diagnostic('system', 'binding_replay_failed', { error: error.message }, 'error'));
    }
  }

  async start() {
    if (!this.enabled) {
      this.#setState({ status: 'disabled', detail: null });
      return this.getState();
    }
    if (this.pollTimer) return this.getState();
    this.#loadTools();
    await this.#ensureBridge();
    if (fs.existsSync(this.appLogPath)) {
      this.logFd = fs.openSync(this.appLogPath, 'r');
      this.logOffset = fs.fstatSync(this.logFd).size;
    } else {
      this.#diagnostic('system', 'app_log_unavailable', { path: this.appLogPath }, 'warn');
    }
    this.pollTimer = setInterval(() => void this.#pollAppLog(), this.pollMs);
    this.clientTimer = setInterval(() => void this.refreshClients(), this.clientRefreshMs);
    this.#setState({ status: 'online', detail: null });
    await this.refreshClients();
    this.resourceInstallation = (async () => {
      await this.orderReader.start().catch(() => this.#diagnostic('system', 'orders_unavailable', {}, 'warn'));
      await this.productsReader.start().catch(() => this.#diagnostic('system', 'products_unavailable', {}, 'warn'));
      await this.transferChannel.start().catch(error => this.#diagnostic('system', 'transfer_unavailable', { error: error.message }, 'warn'));
      await installMessageReader({ toolsRoot: this.toolsRoot, dataPath: this.messageDataPath })
        .catch(() => this.#diagnostic('system', 'message_media_install_failed', {}, 'warn'));
    })();
    return this.getState();
  }

  async stop() {
    this.generation++;
    this.pendingBindings.clear();
    this.platformAccountBindings.clear();
    this.seen.clear();
    for (const timer of this.mediaTimers.values()) clearTimeout(timer);
    this.mediaTimers.clear();
    if (this.resourceInstallation) await this.resourceInstallation;
    if (this.orderReader.starting) await this.orderReader.starting.catch(() => {});
    await this.orderReader.stop();
    await this.productsReader.stop();
    await this.transferChannel.stop();
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.clientTimer) clearInterval(this.clientTimer);
    this.pollTimer = null;
    this.clientTimer = null;
    if (this.logFd !== null) {
      fs.closeSync(this.logFd);
      this.logFd = null;
    }
    if (this.bridgeProcess && !this.bridgeProcess.killed) this.bridgeProcess.kill();
    this.bridgeProcess = null;
    this.directSendClient?.stop?.();
    this.#setDirectSendClientState(this.directSendClient?.getState?.() || { status: 'stopped', pending: 0 });
    this.#setState({ status: this.enabled ? 'stopped' : 'disabled', detail: null });
  }

  async refreshClients() {
    try {
      const response = await fetch(`${this.bridgeBase}/clients`, { signal: AbortSignal.timeout(3000) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
      const accounts = (payload.clients || [])
        .map((client) => qianniuAccountFromBridgeClient(client, this.shopProfiles.get(String(client?.state?.loginID?.targetId || ''))))
        .filter(Boolean);
      this.accounts = [...new Map(accounts.map(account => [account.id, account])).values()];
      this.#setState({ bridgeClientCount: accounts.length });
      this.emit('accounts', this.knownAccounts());
      for (const account of this.accounts) this.#refreshShopProfile(account);
      this.#diagnostic('system', 'clients_refreshed', { account_count: accounts.length }, 'debug');
      return this.knownAccounts();
    } catch (error) {
      this.#setState({ status: 'bridge_unavailable', detail: error?.message || String(error) });
      this.#diagnostic('system', 'clients_refresh_failed', { error: error?.message || String(error) }, 'warn');
      return [];
    }
  }

  #refreshShopProfile(account) {
    const meta = account.metadata_json, uid = meta.service_account_uid;
    const key = `${uid}:${meta.main_account_uid}:${meta.service_account_name}`;
    const profile = this.shopProfiles.get(uid);
    if (!/^\d+$/.test(meta.main_account_uid) || !this.productsReader.server || this.shopProfileReads.has(key) ||
        Date.now() - (this.shopProfileAttempts.get(key) || 0) < 60000 ||
        (profile?.main_account_uid === meta.main_account_uid && profile?.service_account_name === meta.service_account_name &&
          Date.now() - Date.parse(profile.shop_profile_observed_at) < 6 * 60 * 60 * 1000)) return;
    const generation = this.generation;
    this.shopProfileAttempts.set(key, Date.now()); this.shopProfileReads.add(key);
    void this.productsReader.readShopProfile(uid, meta.main_account_uid, meta.service_account_name).then(value => {
      if (generation !== this.generation) return;
      this.shopProfiles.set(uid, value);
      this.accounts = this.accounts.map(current => current.metadata_json.service_account_uid === uid &&
        current.metadata_json.main_account_uid === value.main_account_uid &&
        current.metadata_json.service_account_name === value.service_account_name
        ? { ...current, alias: value.shop_name, metadata_json: { ...current.metadata_json, ...value } } : current);
      this.emit('accounts', this.knownAccounts());
      this.#diagnostic(uid, 'shop_profile_collected', value, 'info');
    }).catch(error => {
      if (generation === this.generation) this.#diagnostic(uid, 'shop_profile_unavailable', { reason: error.message }, 'warn');
    }).finally(() => this.shopProfileReads.delete(key));
  }

  async readHistory(shopUid, cid, options = {}) {
    this.#loadTools();
    const read = this.readQueue.then(() => this.readMessages(shopUid, cid, options));
    this.readQueue = read.catch(() => {});
    return read;
  }

  async syncRecentMessages({ platformAccountId, externalConversationId }) {
    if (!this.enabled) throw new Error('千牛未启用');
    const shopUid = this.platformAccountBindings.get(platformAccountId);
    if (!shopUid || !/^\d+$/.test(shopUid)) throw new Error('千牛账号未绑定');
    const key = shopUid + '|' + externalConversationId;
    if (!this.historyReads.has(key)) this.historyReads.set(key, (async () => {
      const generation = this.generation;
      const value = await this.readHistory(shopUid, externalConversationId, { count: 20 });
      if (value.mediaVersion !== 1) throw new Error('千牛消息模块需要更新并重启千牛');
      if (generation !== this.generation) throw new Error('千牛读取已停止');
      for (const message of [...value.messages].sort((a, b) => String(a.sendTime || '').localeCompare(String(b.sendTime || '')))) {
        const normalized = this.#publishMessage(platformAccountId, shopUid, externalConversationId, message, true);
        if (normalized && needsMediaCompletion(normalized)) this.#scheduleMedia(platformAccountId, normalized, 0);
      }
      return { count: value.messages.length, currentCidBefore: value.currentCidBefore, currentCidAfter: value.currentCidAfter };
    })().finally(() => this.historyReads.delete(key)));
    return this.historyReads.get(key);
  }

  #publishMessage(platformAccountId, shopUid, cid, raw, snapshot, source = 'qianniu_app_log') {
    const normalized = normalizeQianniuMessage(raw, { shopUid, cid });
    if (!normalized || normalized.shopUid !== shopUid || normalized.cid !== cid) return null;
    const key = `${shopUid}|${cid}|${normalized.messageId}`;
    const old = this.messageCache.get(key);
    normalized.parts = mergeMessageParts(old?.parts, normalized.parts);
    if (snapshot && old && old.senderRole === normalized.senderRole && JSON.stringify(old.parts) === JSON.stringify(normalized.parts)) return normalized;
    this.messageCache.set(key, normalized);
    if (this.messageCache.size > 2000) this.messageCache.delete(this.messageCache.keys().next().value);
    const events = qianniuEventsForIncomingMessage({ platformAccountId, shopUid, cid, message: normalized, snapshot,
      observedAt: this.now(), source });
    for (const event of events) this.emit('event', event);
    normalized.emittedEventCount = events.length;
    return normalized;
  }

  #scheduleMedia(platformAccountId, message, attempt) {
    const key = `${message.shopUid}|${message.cid}|${message.messageId}`;
    if (attempt >= 2 || this.mediaTimers.has(key) || message.senderRole === 'platform') return;
    const generation = this.generation;
    const timer = setTimeout(async () => {
      if (generation !== this.generation) return;
      let next = message;
      try {
        const value = await this.readHistory(message.shopUid, message.cid, { count: 20 });
        if (generation !== this.generation) return;
        const raw = value.messages.find(m => m.messageId === message.messageId);
        if (raw) next = this.#publishMessage(platformAccountId, message.shopUid, message.cid, raw, true) || message;
      } catch {
        this.#diagnostic(message.shopUid, 'media_completion_failed', { message_id: message.messageId }, 'warn');
      } finally {
        if (this.mediaTimers.get(key) === timer) this.mediaTimers.delete(key);
      }
      if (generation === this.generation && needsMediaCompletion(next)) this.#scheduleMedia(platformAccountId, next, attempt + 1);
    }, attempt === 0 ? 3000 : 7000);
    timer.unref?.();
    this.mediaTimers.set(key, timer);
  }

  async refreshCustomerOrders({ platformAccountId, externalConversationId, customerName = '' }) {
    if (!this.enabled) throw new Error('千牛未启用');
    const shopUid = this.platformAccountBindings.get(platformAccountId);
    if (!shopUid || !/^\d+$/.test(shopUid) || !/^\d+\.1-\d+\.1#11001@cntaobao$/.test(externalConversationId || ''))
      throw new Error('千牛订单账号或会话未绑定');
    const key = platformAccountId + '|' + externalConversationId;
    if (!this.orderReads.has(key)) {
      this.orderReads.set(key, (async () => {
        const generation = this.generation;
        if (this.resourceInstallation) await this.resourceInstallation;
        if (!this.enabled || generation !== this.generation || this.platformAccountBindings.get(platformAccountId) !== shopUid)
          throw new Error('千牛订单读取已停止或账号绑定已变化');
        const snapshot = await this.orderReader.read(shopUid, externalConversationId);
        if (!this.enabled || generation !== this.generation || this.platformAccountBindings.get(platformAccountId) !== shopUid)
          throw new Error('千牛订单读取已停止或账号绑定已变化');
        const id = randomUUID();
        this.emit('event', { event_id: 'qn-orders-' + id, dedup_key: 'qn-orders:' + id,
          event_type: 'customer_orders_snapshot', platform_code: 'qianniu', platform_account_id: platformAccountId,
          conversation_external_id: externalConversationId, received_at: snapshot.observed_at,
          payload_json: { ...snapshot, customer_name: customerName } });
        return { status: 'collected', conversation_key: externalConversationId, observed_at: snapshot.observed_at };
      })().finally(() => this.orderReads.delete(key)));
    }
    return this.orderReads.get(key);
  }

  async refreshStoreProducts({ platformAccountId, externalConversationId }) {
    if (!this.enabled) throw new Error('千牛未启用');
    const shopUid = this.platformAccountBindings.get(platformAccountId);
    if (!shopUid || !/^\d+$/.test(shopUid)) throw new Error('千牛商品账号未绑定');
    if (!this.productReads.has(platformAccountId)) this.productReads.set(platformAccountId, (async () => {
      const progress = { platformAccountId, shopUid, status: 'collecting', collected: 0, total: null, page: 0,
        startedAt: this.now(), observed_at: null, error: null };
      this.productSyncStates.set(platformAccountId, progress);
      try {
        if (this.resourceInstallation) await this.resourceInstallation;
        const generation = this.generation;
        const snapshot = await this.productsReader.read(shopUid, externalConversationId, value => Object.assign(progress, value));
        if (generation !== this.generation || this.platformAccountBindings.get(platformAccountId) !== shopUid)
          throw new Error('千牛商品读取已停止或账号绑定已变化');
        const id = randomUUID();
        this.emit('event', { event_id: 'qn-products-' + id, dedup_key: 'qn-products:' + id,
          event_type: 'store_products_snapshot', platform_code: 'qianniu', platform_account_id: platformAccountId,
          received_at: snapshot.observed_at, payload_json: snapshot });
        Object.assign(progress, { status: 'collected', collected: snapshot.products.length,
          total: snapshot.products.length, observed_at: snapshot.observed_at });
        return { status: 'collected', observed_at: snapshot.observed_at };
      } catch (error) {
        Object.assign(progress, { status: 'failed', error: error?.message || '商品同步失败，原有列表未更新' });
        this.#diagnostic(shopUid, 'products_sync_failed', { collected: progress.collected,
          total: progress.total, page: progress.page, error: progress.error }, 'warn');
        throw error;
      }
    })().finally(() => this.productReads.delete(platformAccountId)));
    return this.productReads.get(platformAccountId);
  }

  getProductSyncStatus(platformAccountId) {
    if (!this.enabled || !this.platformAccountBindings.get(platformAccountId)) return null;
    const state = this.productSyncStates.get(platformAccountId);
    return state?.shopUid === this.platformAccountBindings.get(platformAccountId) ? { ...state } : null;
  }

  async sendMessage({ platformAccountId, shopUid = null, externalConversationId, content, timeoutMs = 30000 } = {}) {
    if (!this.enabled) throw new Error('千牛后台 worker 未启用');
    this.#loadTools();
    const target = sendTargetFromTask({
      platform_account_id: platformAccountId,
      payload_json: {
        platform_account_id: platformAccountId,
        shop_uid: shopUid,
        external_conversation_id: externalConversationId,
        content,
      },
    }, this.platformAccountBindings);
    const sent = await this.#sendText(target.shopUid, target.cid, target.text, { timeoutMs });
    return {
      status: 'sent',
      method: 'qianniu_direct_send',
      platform_account_id: platformAccountId || null,
      shop_uid: target.shopUid,
      conversation_key: target.cid,
      msg_id: sent.native?.messageId || null,
      client_id: sent.native?.clientId || null,
      request_id: sent.requestId || null,
      receipt_status: sent.result?.status || null,
      timings: sent.timings || null,
    };
  }

  async listTransferTargets(payload) {
    if (!this.enabled) throw new Error('千牛未启用');
    if (this.resourceInstallation) await this.resourceInstallation;
    return this.transferService.list(payload);
  }

  async transferConversation(payload) {
    if (!this.enabled) throw new Error('千牛未启用');
    return this.transferService.transfer(payload);
  }

  async ingestLogLine(line) {
    const wake = parseQianniuWake(line);
    if (wake) return this.#processWake(wake, false, 'app_log');
  }

  async ingestBridgeNotice(notice, snapshot = false) {
    if (!notice || typeof notice !== 'object') return;
    const wake = {
      shopUid: String(notice.shopUid || ''),
      cid: String(notice.cid || ''),
      messageId: String(notice.messageId || ''),
      senderUid: String(notice.buyerUid || ''),
    };
    return this.#processWake(wake, snapshot, 'bridge_notice');
  }

  async handleTask(task) {
    if (task?.platform_code !== 'qianniu') return false;
    if (task.task_type === 'refresh_customer_orders') {
      try {
        const payload = task.payload_json || {};
        if (!task.platform_account_id || payload.platform_account_id !== task.platform_account_id)
          throw new Error('千牛订单任务账号不匹配');
        const result = await this.refreshCustomerOrders({ platformAccountId: task.platform_account_id,
          externalConversationId: payload.external_conversation_id, customerName: payload.customer_name || '' });
        this.emit('task-complete', task.id, 'completed', result);
      } catch (error) {
        this.emit('task-complete', task.id, 'failed', {}, error?.message || '千牛订单刷新失败');
      }
      return true;
    }
    if (['qianniu_transfer_prepare', 'qianniu_transfer_execute'].includes(task.task_type)) {
      try {
        if (!this.enabled) throw new Error('千牛未启用');
        if (this.resourceInstallation) await this.resourceInstallation;
        const result = await this.transferService.automatic(task, task.task_type === 'qianniu_transfer_execute');
        this.emit('task-complete', task.id, 'completed', result);
      } catch (error) {
        this.emit('task-complete', task.id, 'failed', {}, error?.message || '千牛自动转接失败');
      }
      return true;
    }
    if (task.task_type === 'refresh_product_details') {
      try {
        if (!this.enabled) throw new Error('千牛未启用');
        const payload = task.payload_json || {};
        const accountId = task.platform_account_id;
        const shopUid = this.platformAccountBindings.get(accountId);
        if (!shopUid || !/^\d+$/.test(shopUid) || payload.platform_account_id !== accountId ||
            !Array.isArray(payload.product_ids) || !payload.product_ids.length || payload.product_ids.length > 3 ||
            payload.product_ids.some(id => typeof id !== 'string' || !/^\d{1,30}$/.test(id)) ||
            new Set(payload.product_ids).size !== payload.product_ids.length) throw new Error('商品详情任务参数无效');
        const ownershipVerifiedIds = payload.ownership_verified_product_ids || [];
        if (!Array.isArray(ownershipVerifiedIds) || ownershipVerifiedIds.some(id => !payload.product_ids.includes(id)) ||
            new Set(ownershipVerifiedIds).size !== ownershipVerifiedIds.length)
          throw new Error('商品详情归属参数无效');
        if (this.resourceInstallation) await this.resourceInstallation;
        const generation = this.generation;
        const collected = [], failed = [], errors = {};
        for (const productId of payload.product_ids) {
          try {
            if (generation !== this.generation) throw new Error('千牛商品读取已停止');
            const snapshot = await this.productsReader.readDetail(shopUid, payload.external_conversation_id, productId,
              { ownershipVerified: ownershipVerifiedIds.includes(productId) });
            if (generation !== this.generation || this.platformAccountBindings.get(accountId) !== shopUid) throw new Error('千牛账号绑定变化');
            const id = randomUUID();
            this.emit('event', { event_id: 'qn-detail-' + id, dedup_key: 'qn-detail:' + id,
              event_type: 'store_product_detail_snapshot', platform_code: 'qianniu', platform_account_id: accountId,
              received_at: snapshot.observed_at, payload_json: snapshot });
            collected.push(productId);
          } catch (error) {
            failed.push(productId);
            errors[productId] = error?.message || '商品详情读取失败';
          }
        }
        this.emit('task-complete', task.id, failed.length ? 'failed' : 'completed',
          { method: 'qianniu_product_detail', collected, failed, errors }, failed.length ? '部分商品详情不可用，已保留原有资料' : null);
      } catch (error) {
        this.emit('task-complete', task.id, 'failed', {}, error?.message || '商品详情查询失败');
      }
      return true;
    }
    if (task.task_type !== 'send_message') {
      this.emit('task-complete', task.id, 'failed', {}, `Unsupported Qianniu task: ${task.task_type}`);
      return true;
    }
    try {
      this.#loadTools();
      const target = sendTargetFromTask(task, this.platformAccountBindings);
      const sent = await this.#sendText(target.shopUid, target.cid, target.text, { timeoutMs: 30000, taskId: task.id });
      this.emit('task-complete', task.id, 'completed', {
        method: 'qianniu_direct_send',
        text_sent: true,
        platform_message_id: sent.native?.messageId || null,
        client_id: sent.native?.clientId || null,
        request_id: sent.requestId || null,
        status: sent.result?.status || null,
        timings: sent.timings || null,
      });
      return true;
    } catch (error) {
      const pending = task.payload_json?.qianniu_auto_operation_id && error?.submitted;
      this.emit('task-complete', task.id, pending ? 'confirmation_pending' : 'failed', error?.resultJson || {}, error?.message || String(error));
      return true;
    }
  }

  async #pollAppLog() {
    if (this.processing) return;
    this.processing = true;
    try {
      await this.#pollBridgeNotices();
      if (this.logFd === null) return;
      const current = fs.statSync(this.appLogPath);
      const opened = fs.fstatSync(this.logFd);
      if (current.dev !== opened.dev || current.ino !== opened.ino) {
        const nextFd = fs.openSync(this.appLogPath, 'r');
        fs.closeSync(this.logFd);
        this.logFd = nextFd;
        this.logOffset = 0;
        this.#diagnostic('system', 'app_log_reopened', {}, 'info');
      }
      const result = findCompleteLine(this.logFd, this.logOffset);
      this.logOffset = result.offset;
      for (const line of result.lines) await this.ingestLogLine(line);
    } catch (error) {
      this.#setState({ status: 'error', detail: error?.message || String(error) });
      this.#diagnostic('system', 'app_log_poll_failed', { error: error?.message || String(error) }, 'error');
    } finally {
      this.processing = false;
    }
  }

  async #pollBridgeNotices() {
    try {
      const query = new URLSearchParams({ after: String(this.bridgeNoticeSeq) });
      if (this.bridgeNoticeInstanceId) query.set('instance', this.bridgeNoticeInstanceId);
      const response = await fetch(`${this.bridgeBase}/notices?${query}`, { signal: AbortSignal.timeout(1000) });
      const payload = await response.json();
      if (!response.ok || !payload?.serverInstanceId || !Array.isArray(payload.notices))
        throw new Error(payload?.error || `HTTP ${response.status}`);
      if (this.bridgeNoticeInstanceId && this.bridgeNoticeInstanceId !== payload.serverInstanceId) {
        this.#diagnostic('system', 'message_notice_bridge_restarted', {}, 'info');
        this.bridgeNoticeSeq = 0;
      }
      this.bridgeNoticeInstanceId = payload.serverInstanceId;
      for (const notice of payload.notices) {
        const old = Date.now() - Date.parse(notice.observedAt) > 60000;
        await this.ingestBridgeNotice(notice, old);
        if (Number.isSafeInteger(notice.seq)) this.bridgeNoticeSeq = Math.max(this.bridgeNoticeSeq, notice.seq);
      }
      if (!payload.notices.length && Number.isSafeInteger(payload.latestSeq))
        this.bridgeNoticeSeq = Math.max(this.bridgeNoticeSeq, payload.latestSeq);
    } catch (error) {
      if (Date.now() - this.lastBridgeNoticeErrorAt > 30000) {
        this.lastBridgeNoticeErrorAt = Date.now();
        this.#diagnostic('system', 'message_notice_poll_failed', { error: error?.message || String(error) }, 'warn');
      }
    }
  }

  async #processWake(wake, snapshot = false, source = 'app_log') {
    if (!wake?.shopUid || !wake.cid || !wake.messageId) return;
    const key = `${wake.shopUid}:${wake.cid}:${wake.messageId}`;
    if (this.seen.has(key)) return;
    this.#setState({ lastEventAt: this.now() });
    this.#diagnostic(wake.shopUid, 'message_arrive_detected', {
      cid: wake.cid,
      message_id: wake.messageId,
      sender_uid: wake.senderUid,
      source,
    });
    const platformAccountId = this.platformAccountBindings.get(wake.shopUid);
    if (!platformAccountId) {
      if (!this.pendingBindings.has(key)) {
        if (this.pendingBindings.size >= 2000) {
          this.pendingBindings.delete(this.pendingBindings.keys().next().value);
          this.#diagnostic('system', 'binding_buffer_overflow', {}, 'warn');
        }
        this.pendingBindings.set(key, { wake, source, shopUid: wake.shopUid, at: Date.now() });
      }
      await this.refreshClients();
      this.#diagnostic(wake.shopUid, 'message_waiting_account_binding', { cid: wake.cid, message_id: wake.messageId }, 'warn');
      return;
    }
    this.pendingBindings.delete(key);
    this.seen.add(key);
    if (this.seen.size > 2000) this.seen.delete(this.seen.values().next().value);
    try {
      const generation = this.generation;
      const read = await this.#readWithRetry(wake.shopUid, wake.cid, wake.messageId);
      if (generation !== this.generation) return;
      const eventSource = source === 'bridge_notice' ? 'qianniu_bridge_notice' : 'qianniu_app_log';
      const message = this.#publishMessage(platformAccountId, wake.shopUid, wake.cid, read.match, snapshot, eventSource);
      if (message && needsMediaCompletion(message)) this.#scheduleMedia(platformAccountId, message, 0);
      this.#diagnostic(wake.shopUid, message?.emittedEventCount ? 'message_events_emitted' : 'message_not_emitted', {
        cid: wake.cid,
        message_id: wake.messageId,
        message_type: message?.projection.message_type || 'skipped',
        event_count: message?.emittedEventCount || 0,
        source,
      });
    } catch (error) {
      this.seen.delete(key);
      this.#diagnostic(wake.shopUid, 'message_processing_failed', {
        cid: wake.cid,
        message_id: wake.messageId,
        source,
        error: error?.message || String(error),
      }, 'error');
    }
  }

  async #readWithRetry(shopUid, cid, messageId) {
    let lastError;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        const value = await this.readHistory(shopUid, cid, { count: 20, timeoutMs: 15000 });
        const match = value.messages.find((message) => message.messageId === messageId);
        if (match) return { attempt, value, match };
        lastError = new Error(`message ${messageId} is not in local history yet`);
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    throw lastError || new Error('read retry exhausted');
  }

  async #ensureBridge() {
    try {
      const response = await fetch(this.bridgeBase, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return;
    } catch {}
    const serverScript = path.join(repoRoot, 'qn-im-bridge-hook-server.js');
    if (!fs.existsSync(serverScript)) throw new Error(`千牛 bridge server 不存在: ${serverScript}`);
    this.bridgeProcess = spawn(this.nodePath, [serverScript], {
      cwd: repoRoot,
      windowsHide: true,
      stdio: 'ignore',
      detached: false,
    });
    this.bridgeProcess.on('exit', (code) => {
      this.bridgeProcess = null;
      if (this.pollTimer) this.#setState({ status: 'bridge_unavailable', detail: `bridge exited: ${code}` });
    });
    await new Promise((resolve) => setTimeout(resolve, 800));
  }

  #loadTools() {
    if (!this.readMessages) {
      this.readMessages = require(path.join(this.toolsRoot, 'qn-read-messages.cjs')).readMessages;
    }
    if (!this.sendText) {
      this.sendText = require(path.join(this.toolsRoot, 'qn-direct-send-service.cjs')).sendText;
    }
    if (!this.directSendClient && this.useDirectSendHelper && !this.injectedSendText) {
      this.directSendClient = new QianniuDirectSendClient({
        nodePath: this.nodePath,
        toolsRoot: this.toolsRoot,
        appLogPath: this.appLogPath,
        sendMode: process.env.QIANNIU_DIRECT_SEND_MODE || 'direct',
      });
      this.directSendClient.on('ready', () => this.#setDirectSendClientState(this.directSendClient.getState()));
      this.directSendClient.on('exit', () => this.#setDirectSendClientState(this.directSendClient.getState()));
      this.directSendClient.on('error', (error) => {
        this.#setDirectSendClientState(this.directSendClient.getState());
        this.#diagnostic('system', 'direct_send_helper_error', { error: error?.message || String(error) }, 'warn');
      });
      this.#setDirectSendClientState(this.directSendClient.getState());
    }
  }

  async #sendText(shopUid, cid, text, { timeoutMs = 30000, taskId = null } = {}) {
    const key = shopUid + '|' + cid, generation = this.generation;
    if (this.transferLocks.has(key)) throw new Error('会话正在转接，已阻止发送');
    this.activeSends.set(key, (this.activeSends.get(key) || 0) + 1);
    try {
      const platformAccountId = this.platformAccountBindings.get(shopUid);
      if (!platformAccountId) throw new Error('千牛发送账号未绑定');
      if (taskId && this.sendGuard) {
        let guard;
        try {
          guard = await this.sendGuard({ taskId, platformAccountId, cid });
        } catch (error) {
          this.#diagnostic(shopUid, 'send_guard_failed', {
            task_id: taskId,
            platform_account_id: platformAccountId,
            cid,
            error: error?.message || String(error),
          }, 'error');
          throw error;
        }
        if (guard.blocked !== false) throw new Error('会话正在转接、已转接或结果待确认，已阻止发送');
      } else if (this.businessApi) {
        const guard = await this.businessApi('/conversations/qianniu/send-guard?platform_account_id=' +
          encodeURIComponent(platformAccountId) + '&cid=' + encodeURIComponent(cid) +
          (taskId ? '&task_id=' + encodeURIComponent(taskId) : ''));
        if (guard.blocked !== false) throw new Error('会话正在转接、已转接或结果待确认，已阻止发送');
      }
      if (generation !== this.generation || this.transferLocks.has(key)) throw new Error('千牛会话状态变化，已阻止发送');
      try {
        return await this.#sendTextNow(shopUid, cid, text, { timeoutMs });
      } catch (error) {
        if (error && error.submitted === undefined) error.submitted = true;
        throw error;
      }
    } finally {
      const count = this.activeSends.get(key) - 1;
      if (count) this.activeSends.set(key, count); else this.activeSends.delete(key);
    }
  }

  async #sendTextNow(shopUid, cid, text, { timeoutMs = 30000 } = {}) {
    this.#loadTools();
    if (this.directSendClient) {
      try {
        const sent = await this.directSendClient.sendText(shopUid, cid, text, { timeoutMs });
        this.#setDirectSendClientState(this.directSendClient.getState());
        return sent;
      } catch (error) {
        this.#setDirectSendClientState(this.directSendClient.getState());
        if (error?.submitted) throw error;
        this.#diagnostic(shopUid, 'direct_send_helper_fallback', {
          cid,
          error: error?.message || String(error),
        }, 'warn');
      }
    }
    const sent = this.sendText(shopUid, cid, text, { timeoutMs });
    this.#setDirectSendClientState(this.directSendClient?.getState?.() || { status: 'stopped', pending: 0 });
    return sent;
  }

  #setState(changes) {
    this.state = { ...this.state, ...changes };
    this.emit('state-changed', this.getState());
  }

  #setDirectSendClientState(changes) {
    this.directSendClientState = { ...this.directSendClientState, ...changes };
    this.emit('state-changed', this.getState());
  }

  #diagnostic(accountId, stage, details = {}, level = 'info') {
    this.diagnosticLogger?.write(accountId, {
      level,
      stage,
      details,
      observed_at: this.now(),
    });
  }
}
