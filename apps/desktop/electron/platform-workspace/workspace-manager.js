import { preparePddTransfer } from './pinduoduo/auto-transfer.js';
import { BrowserWindow, WebContentsView, session, shell, nativeImage } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { classifyPddPage } from './pinduoduo/detector.js';
import { PddCollectionRuntime } from './pinduoduo/runtime.js';
import { serializedSelectorArgument } from './pinduoduo/selectors.js';
import { StoreActor } from './store-actor.js';
import { SerialTaskQueue } from './serial-task-queue.js';

const require = createRequire(import.meta.url);
const {
  mapChatListResponse,
  mapLatestConversationsResponse,
  mapPddRecommendGoodsResponse,
  mapPddRecommendGoodsSnapshot,
  mapPddUserAllOrderResponse,
  mapSendMessageResponse,
  mapSyncMessageResponse,
  summarizeMappedSnapshot,
} = require('./pinduoduo/api-mapper.cjs');

const PDD_HOME_URL = 'https://mms.pinduoduo.com/chat-windows/index.html';
const WORKSPACE_TOOLBAR_HEIGHT = 72;
const ACCOUNT_NAME_DETECTION_TIMEOUT_MS = 5000;
const ACCOUNT_NAME_PAGE_LOAD_TIMEOUT_MS = 15000;
const CONVERSATION_LIST_TIMEOUT_MS = 8000;
const CONVERSATION_COLLECTION_TIMEOUT_MS = 15000;
const CUSTOMER_ORDER_COLLECTION_TIMEOUT_MS = 15000;
const CUSTOMER_PRODUCT_COLLECTION_TIMEOUT_MS = 15000;
const PLATFORM_PHRASE_COLLECTION_TIMEOUT_MS = 20000;
const PRODUCT_SEND_CONFIRMATION_TIMEOUT_MS = 15000;
const MESSAGE_PREPARATION_TIMEOUT_MS = 15000;
const IMAGE_PREPARATION_TIMEOUT_MS = 15000;
const CONVERSATION_TRANSFER_TIMEOUT_MS = 20000;

function digestPayload(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
}
const IMAGE_SEND_CONFIRMATION_TIMEOUT_MS = 70000;
const STORE_SCAN_TIMEOUT_MS = 10000;
const UNREAD_COLLECTION_TIMEOUT_MS = 15000;
const BACKGROUND_ACCOUNT_LOAD_TIMEOUT_MS = 30000;
const SESSION_HEALTH_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const SESSION_IDLE_REFRESH_INTERVAL_MS = 30 * 60 * 1000;
const SESSION_REFRESH_TIMEOUT_MS = 30000;
const SYNC_GAP_BACKFILL_COOLDOWN_MS = 30000;
const SYNC_LATEST_UNREAD_BACKFILL_COOLDOWN_MS = 1500;
const API_UNREAD_BACKFILL_VERSION_RETRY_MS = 30000;
const API_LATEST_MESSAGE_PRESENCE_CACHE_MS = 1000;
const UNAVAILABLE_LOGIN_STATUSES = new Set(['login_required', 'risk_control', 'account_mismatch']);
const WEB_REQUEST_UPLOAD_DIAGNOSTIC_TTL_MS = 2 * 60 * 1000;
const WEB_REQUEST_INTERESTING_HEADERS = new Set([
  'accept',
  'content-length',
  'content-type',
  'origin',
  'referer',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
]);
const WEB_REQUEST_SENSITIVE_HEADERS = new Set([
  'anti-content',
  'authorization',
  'cookie',
  'mallid',
  'pdduid',
  'x-anti-content',
  'x-sign',
  'x-signature',
]);
const IMAGE_STORE_DEVTOOLS_RESPONSE_BODY_LIMIT = 4000;
export const PDD_PENDING_ACCOUNT_ALIAS = 'PDD pending account';
const GENERIC_ACCOUNT_ALIAS = /^(拼多多|拼多多商家后台|拼多多商家管理后台|拼多多客服平台|商家后台|客服平台)$/;
const NUMBERED_PDD_ACCOUNT_ALIAS = /^拼多多店铺\s*\d+$/;

function detectedAlias(value) {
  const alias = String(value || '').replace(/\s+/g, ' ').trim();
  return alias && !isAutoReplaceableAlias(alias) ? alias.slice(0, 64) : null;
}

function isAutoReplaceableAlias(value) {
  const normalized = String(value || '').trim();
  return value === PDD_PENDING_ACCOUNT_ALIAS
    || GENERIC_ACCOUNT_ALIAS.test(normalized)
    || NUMBERED_PDD_ACCOUNT_ALIAS.test(normalized);
}

function accountNameDetectionFailureMessage(result) {
  const error = String(result?.error || '');
  const diagnostics = result?.diagnostics && typeof result.diagnostics === 'object'
    ? result.diagnostics
    : {};
  if (error === 'runtime_anti_content_missing') {
    return '店铺名称识别失败：页面接口参数尚未就绪，请等待拼多多客服接待页加载完成后重试。';
  }
  if (error === 'page_not_online') {
    return '店铺名称识别失败：当前页面未处于拼多多客服接待页在线状态，请完成登录后重试。';
  }
  if (error === 'shop_identity_missing') {
    return '店铺名称识别失败：店铺信息接口未返回有效 mallId/mallName，请刷新拼多多客服页面后重试。';
  }
  if (Number(diagnostics.conversation_count || 0) > 0 && diagnostics.has_shop_identity === false) {
    return '店铺名称识别失败：latest_conversations 已返回会话，但响应中没有 mallName/mall_id，请刷新拼多多客服页面后重试。';
  }
  if (error) {
    return `店铺名称识别失败：${error}`;
  }
  return '当前页面未识别到有效店铺名称，请确认拼多多客服接待页面已加载完成后重试。';
}

function isAllowedPddUrl(value) {
  if (value === 'about:blank') return true;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      (url.hostname === 'pinduoduo.com' || url.hostname.endsWith('.pinduoduo.com'))
    );
  } catch {
    return false;
  }
}

function isSafeExternalUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function diagnosticPagePath(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`.slice(0, 512);
  } catch {
    return String(value || '').slice(0, 512);
  }
}

function diagnosticUrlSummary(value) {
  try {
    const url = new URL(value);
    return {
      origin: url.origin,
      host: url.host,
      pathname: url.pathname.slice(0, 256),
      query_keys: [...url.searchParams.keys()].slice(0, 20),
    };
  } catch {
    return { raw: String(value || '').slice(0, 256) };
  }
}

function headerValueSummary(name, value) {
  const normalized = String(name || '').toLowerCase();
  if (WEB_REQUEST_SENSITIVE_HEADERS.has(normalized) || normalized.includes('token')) {
    return '[redacted]';
  }
  const joined = Array.isArray(value) ? value.join(', ') : String(value || '');
  return joined.slice(0, 256);
}

function summarizeWebRequestHeaders(headers = {}) {
  const summary = {};
  for (const [name, value] of Object.entries(headers || {})) {
    const normalized = String(name || '').toLowerCase();
    if (!WEB_REQUEST_INTERESTING_HEADERS.has(normalized) && !WEB_REQUEST_SENSITIVE_HEADERS.has(normalized)) {
      continue;
    }
    summary[normalized] = headerValueSummary(normalized, value);
  }
  return summary;
}

function webRequestHeaderValue(headers = {}, name) {
  const target = String(name || '').toLowerCase();
  const entry = Object.entries(headers || {}).find(([key]) => String(key || '').toLowerCase() === target);
  if (!entry) return '';
  const value = entry[1];
  return Array.isArray(value) ? value.join(', ') : String(value || '');
}

function summarizeUploadData(uploadData = []) {
  let totalBytes = 0;
  let byteEntryCount = 0;
  const fileNames = [];
  for (const entry of uploadData || []) {
    if (entry?.bytes) {
      byteEntryCount += 1;
      totalBytes += Buffer.byteLength(entry.bytes);
    }
    if (entry?.file) {
      fileNames.push(path.basename(String(entry.file)).slice(0, 128));
    }
  }
  return {
    entry_count: Array.isArray(uploadData) ? uploadData.length : 0,
    byte_entry_count: byteEntryCount,
    total_bytes: totalBytes,
    file_count: fileNames.length,
    file_names: fileNames.slice(0, 5),
  };
}

function isPddImageUploadWebRequest(details) {
  const method = String(details?.method || '').toUpperCase();
  if (!['POST', 'PUT', 'PATCH'].includes(method)) return false;
  let url;
  try {
    url = new URL(details.url);
  } catch {
    return false;
  }
  const urlText = `${url.hostname}${url.pathname}`.toLowerCase();
  if (
    urlText.includes('pre_upload')
    || urlText.includes('store_image')
    || urlText.includes('image_upload')
    || urlText.includes('upload_image')
    || urlText.includes('chat-img')
    || urlText.includes('pddugc')
    || urlText.includes('pddpic')
  ) {
    return true;
  }
  const requestHeaders = details.requestHeaders || {};
  const referer = webRequestHeaderValue(requestHeaders, 'referer').toLowerCase();
  const contentType = webRequestHeaderValue(requestHeaders, 'content-type').toLowerCase();
  const fromPddChat = referer.includes('mms.pinduoduo.com') || referer.includes('pinduoduo.com/chat');
  const imageLikeBody = (
    contentType.includes('multipart/form-data')
    || contentType.includes('application/octet-stream')
    || contentType.includes('image/')
  );
  const uploadLikeUrl = (
    urlText.includes('upload')
    || urlText.includes('file')
    || urlText.includes('image')
    || urlText.includes('img')
  );
  return fromPddChat && (imageLikeBody || uploadLikeUrl);
}

function isPddStoreImageUrl(value) {
  try {
    const url = new URL(value);
    return url.hostname === 'file.pinduoduo.com' && url.pathname === '/v2/store_image';
  } catch {
    return false;
  }
}

function isSensitiveJsonKey(key) {
  const normalized = String(key || '').toLowerCase();
  return (
    normalized.includes('token')
    || normalized.includes('sign')
    || normalized.includes('secret')
    || normalized.includes('policy')
    || normalized.includes('credential')
    || normalized.includes('authorization')
  );
}

function isLargeImageLikeString(value) {
  const textValue = String(value || '').trim();
  return (
    textValue.length > 512
    || textValue.startsWith('data:image/')
    || /^[A-Za-z0-9+/=_-]{256,}$/.test(textValue)
  );
}

function summarizeJsonShape(value, { includeStringPreview = false, maxNodes = 80 } = {}) {
  const rootType = Array.isArray(value) ? 'array' : typeof value;
  const topKeys = value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value).slice(0, 30)
    : [];
  const fields = [];
  const queue = [{ path: '$', key: '', value }];
  let visited = 0;
  while (queue.length && visited < maxNodes) {
    const current = queue.shift();
    visited += 1;
    const currentValue = current.value;
    if (Array.isArray(currentValue)) {
      fields.push({ path: current.path, type: 'array', length: currentValue.length });
      currentValue.slice(0, 10).forEach((item, index) => {
        queue.push({ path: `${current.path}[${index}]`, key: String(index), value: item });
      });
      continue;
    }
    if (currentValue && typeof currentValue === 'object') {
      const keys = Object.keys(currentValue);
      fields.push({ path: current.path, type: 'object', keys: keys.slice(0, 20) });
      for (const [key, childValue] of Object.entries(currentValue).slice(0, 20)) {
        queue.push({ path: `${current.path}.${key}`, key, value: childValue });
      }
      continue;
    }
    if (typeof currentValue === 'string') {
      const sensitive = isSensitiveJsonKey(current.key);
      const largeImageLike = isLargeImageLikeString(currentValue);
      const field = {
        path: current.path,
        type: 'string',
        length: currentValue.length,
        redacted: sensitive || largeImageLike,
      };
      if (includeStringPreview && !field.redacted) {
        field.preview = currentValue.slice(0, 512);
      }
      fields.push(field);
      continue;
    }
    if (typeof currentValue === 'number' || typeof currentValue === 'boolean') {
      fields.push({ path: current.path, type: typeof currentValue, value: currentValue });
      continue;
    }
    fields.push({ path: current.path, type: currentValue === null ? 'null' : typeof currentValue });
  }
  return {
    root_type: rootType,
    top_keys: topKeys,
    field_count: fields.length,
    fields: fields.slice(0, maxNodes),
    truncated: queue.length > 0,
  };
}

function parseJsonObject(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function findFirstStringByJsonKey(value, keys, limit = 512) {
  const normalizedKeys = new Set(keys.map((item) => String(item).toLowerCase()));
  const queue = [{ key: '', value }];
  let visited = 0;
  while (queue.length && visited < 300) {
    const current = queue.shift();
    visited += 1;
    if (normalizedKeys.has(String(current.key || '').toLowerCase())
      && (typeof current.value === 'string' || typeof current.value === 'number')) {
      const result = String(current.value || '').trim();
      if (result) return result.slice(0, limit);
    }
    if (!current.value || typeof current.value !== 'object') continue;
    if (Array.isArray(current.value)) {
      current.value.forEach((item, index) => queue.push({ key: String(index), value: item }));
    } else {
      Object.entries(current.value).forEach(([key, child]) => queue.push({ key, value: child }));
    }
  }
  return null;
}

function findFirstImageUrlInJson(value) {
  const queue = [value];
  let visited = 0;
  while (queue.length && visited < 300) {
    const current = queue.shift();
    visited += 1;
    if (typeof current === 'string') {
      const candidate = current.trim();
      if (/^https?:\/\//i.test(candidate) && /(chat-img|pddugc|pddpic|\.jpe?g|\.png|\.webp)/i.test(candidate)) {
        return candidate.slice(0, 1000);
      }
    }
    if (!current || typeof current !== 'object') continue;
    if (Array.isArray(current)) queue.push(...current);
    else queue.push(...Object.values(current));
  }
  return null;
}

function summarizeStoreImageResponseJson(value) {
  const json = parseJsonObject(value);
  if (!json) return null;
  return {
    shape: summarizeJsonShape(json, { includeStringPreview: true, maxNodes: 80 }),
    success: json?.success === true,
    result_ok: json?.result === 'ok' || json?.result?.result === 'ok',
    image_url: findFirstImageUrlInJson(json),
    hash: findFirstStringByJsonKey(json, ['hash', 'image_hash', 'sha256', 'md5'], 128),
    width: Number(findFirstStringByJsonKey(json, ['width', 'w'], 32)) || null,
    height: Number(findFirstStringByJsonKey(json, ['height', 'h'], 32)) || null,
    image_size: Number(findFirstStringByJsonKey(json, ['image_size', 'size'], 32)) || null,
  };
}

function publicAccount(account, runtime, collector) {
  return {
    id: account.id,
    alias: account.alias,
    paused: account.paused,
    createdAt: account.createdAt,
    lastOpenedAt: account.lastOpenedAt,
    platformAccountId: account.platformAccountId || null,
    externalAccountId: account.externalAccountId || null,
    platformAccountName: account.platformAccountName || null,
    platformAccountLogoUrl: account.platformAccountLogoUrl || null,
    loginStatus: account.paused ? 'paused' : account.loginStatus || 'unknown',
    runtimeStatus: account.paused ? 'paused' : runtime?.status || 'idle',
    collectionStatus: account.paused ? 'paused' : collector?.status || 'idle',
    lastCollectedAt: collector?.lastCollectedAt || null,
  };
}

export class PddWorkspaceManager {
  constructor({
    registry,
    devServerUrl,
    rendererPath,
    preloadPath,
    pddPreloadPath = null,
    rpaManager = null,
    diagnosticLogger = null,
    knowledgeBaseUrl = 'http://127.0.0.1:8010',
    businessApiUrl = 'http://127.0.0.1:8001/api/v1',
    collectorRulesCachePath = null,
    rendererAdditionalArguments = [],
    homeUrl = PDD_HOME_URL,
    workspaceShellUrl = null,
    loadWorkspaceShell = true,
    sessionHealthCheckIntervalMs = SESSION_HEALTH_CHECK_INTERVAL_MS,
    sessionIdleRefreshIntervalMs = SESSION_IDLE_REFRESH_INTERVAL_MS,
    sessionRefreshTimeoutMs = SESSION_REFRESH_TIMEOUT_MS,
    pageClassifier = classifyPddPage,
    now = () => Date.now(),
  }) {
    this.registry = registry;
    this.devServerUrl = devServerUrl;
    this.rendererPath = rendererPath;
    this.preloadPath = preloadPath;
    this.pddPreloadPath = pddPreloadPath;
    this.rpaManager = rpaManager;
    this.diagnosticLogger = diagnosticLogger;
    this.knowledgeBaseOrigin = new URL(knowledgeBaseUrl).origin;
    this.businessApiUrl = businessApiUrl.replace(/\/$/, '');
    this.collectorRulesCachePath = collectorRulesCachePath;
    this.collectorRules = this.#loadCachedCollectorRules();
    this.rendererAdditionalArguments = [...rendererAdditionalArguments];
    this.homeUrl = homeUrl;
    this.workspaceShellUrl = workspaceShellUrl;
    this.loadWorkspaceShell = loadWorkspaceShell;
    this.sessionHealthCheckIntervalMs = sessionHealthCheckIntervalMs;
    this.sessionIdleRefreshIntervalMs = sessionIdleRefreshIntervalMs;
    this.sessionRefreshTimeoutMs = sessionRefreshTimeoutMs;
    this.pageClassifier = pageClassifier;
    this.now = now;
    this.window = null;
    this.userId = null;
    this.activeAccountId = null;
    this.views = new Map();
    this.runtime = new Map();
    this.collectors = new Map();
    this.pendingNameDetections = new Map();
    this.pendingConversationLists = new Map();
    this.pendingConversationCollections = new Map();
    this.pendingCustomerOrderCollections = new Map();
    this.pendingCustomerProductCollections = new Map();
    this.pendingPlatformPhraseCollections = new Map();
    this.pendingMessagePreparations = new Map();
    this.pendingProductSendPreparations = new Map();
    this.pendingImagePreparations = new Map();
    this.pendingTransferCsLists = new Map();
    this.pendingConversationTransfers = new Map();
    this.pendingStoreScans = new Map();
    this.pendingUnreadCollections = new Map();
    this.storeActors = new Map();
    this.syncGapBackfills = new Map();
    this.syncLatestUnreadBackfills = new Map();
    this.apiUnreadBackfillVersions = new Map();
    this.apiLatestMessagePresence = new Map();
    this.configuredPartitions = new Set();
    this.webRequestAccountsByPartition = new Map();
    this.pendingImageUploadWebRequests = new Map();
    this.imageUploadDevtoolsContents = new Set();
    this.imageUploadDevtoolsCleanups = new Map();
    this.pendingImageUploadDevtoolsRequests = new Map();
    this.viewEventCleanups = new Map();
    this.initialViewLoads = new Map();
    this.backgroundLoadQueue = [];
    this.queuedBackgroundAccounts = new Set();
    this.backgroundLoadRunning = false;
    this.backgroundLoadGeneration = 0;
    this.sessionHealthTimer = null;
    this.sessionHealthCheckRunning = false;
    this.sessionHealthGeneration = 0;
    this.sessionHealthByAccount = new Map();
    this.verifiedAccountIdentities = new Set();
    this.overlayOpen = false;
    this.isQuitting = false;
    this.rpaManager?.on('state-changed', () => this.#publishState());
    this.rpaManager?.on('bindings', (bindings) => {
      if (!this.userId) return;
      for (const binding of bindings) {
        if (this.registry.get(this.userId, binding.local_account_id)) {
          this.registry.bindPlatformAccount(
            this.userId,
            binding.local_account_id,
            binding.platform_account_id,
            binding.login_status,
          );
          this.collectors.get(binding.local_account_id)?.runtime.accountBindingChanged();
          const view = this.views.get(binding.local_account_id);
          if (view && !view.webContents.isDestroyed()) {
            view.webContents.send('pdd-adapter:command', { type: 'scan' });
          }
        }
      }
      this.#publishState();
    });
    this.rpaManager?.on('task', (task) => {
      this.#enqueueRpaTask(task);
    });
  }

  async open(userId) {
    if (!userId) throw new Error('缂哄皯褰撳墠鐢ㄦ埛淇℃伅');
    if (this.window && !this.window.isDestroyed() && this.userId !== userId) {
      await this.closeForLogout();
    }

    this.userId = userId;
    if (!this.window || this.window.isDestroyed()) {
      await this.#createWindow();
    }

    this.window.show();
    this.window.focus();
    this.syncRpaAccounts();
    await this.#ensureInitialAccount();
    this.#scheduleBackgroundAccountLoads();
    this.#startSessionHealthMonitor();
    this.#publishState();
  }

  async bindUser(userId, accessToken = null) {
    if (!userId) throw new Error('缂哄皯褰撳墠鐢ㄦ埛淇℃伅');
    if (this.userId && this.userId !== userId) await this.closeForLogout();
    this.userId = userId;
    await this.#refreshCollectorRules(accessToken);
    this.#startSessionHealthMonitor();
    this.syncRpaAccounts();
    this.#publishState();
  }

  async #refreshCollectorRules(providedAccessToken = null) {
    const accessToken = providedAccessToken || this.rpaManager?.accessToken;
    if (!accessToken) return;
    try {
      const response = await fetch(`${this.businessApiUrl}/collector-rules/pinduoduo`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const rules = await response.json();
      if (!rules || rules.platform !== 'pinduoduo' || typeof rules.version !== 'string') {
        throw new Error('invalid collector rules');
      }
      this.collectorRules = rules;
      this.#saveCollectorRules(rules);
      for (const view of this.views.values()) {
        if (!view.webContents.isDestroyed()) {
          view.webContents.send('pdd-adapter:command', { type: 'collector-rules', rules });
        }
      }
    } catch (error) {
      this.#writeDiagnostic('system', 'collector_rules_refresh_failed', {
        error: error instanceof Error ? error.message : String(error),
      }, 'warn');
    }
  }

  #loadCachedCollectorRules() {
    if (!this.collectorRulesCachePath) return null;
    try {
      const rules = JSON.parse(fs.readFileSync(this.collectorRulesCachePath, 'utf8'));
      return rules?.platform === 'pinduoduo' && typeof rules.version === 'string' ? rules : null;
    } catch {
      return null;
    }
  }

  #saveCollectorRules(rules) {
    if (!this.collectorRulesCachePath) return;
    try {
      fs.mkdirSync(path.dirname(this.collectorRulesCachePath), { recursive: true });
      fs.writeFileSync(this.collectorRulesCachePath, JSON.stringify(rules), 'utf8');
    } catch (error) {
      this.#writeDiagnostic('system', 'collector_rules_cache_failed', {
        error: error instanceof Error ? error.message : String(error),
      }, 'warn');
    }
  }

  async #createWindow() {
    this.window = new BrowserWindow({
      width: 1320,
      height: 860,
      minWidth: 960,
      minHeight: 640,
      title: '鎷煎澶氬師骞冲彴宸ヤ綔鍖?- AI鏅鸿兘瀹㈡湇',
      backgroundColor: '#f8fafc',
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        additionalArguments: this.rendererAdditionalArguments,
      },
    });

    this.window.on('resize', () => this.#layoutViews());
    this.window.on('close', (event) => {
      if (!this.isQuitting) {
        event.preventDefault();
        this.window?.hide();
      }
    });
    this.window.on('closed', () => {
      this.window = null;
    });

    if (!this.loadWorkspaceShell) {
      return;
    } else if (this.workspaceShellUrl) {
      await this.window.loadURL(this.workspaceShellUrl);
    } else if (this.devServerUrl) {
      const workspaceUrl = new URL(this.devServerUrl);
      workspaceUrl.searchParams.set('view', 'pinduoduo-workspace');
      await this.window.loadURL(workspaceUrl.toString());
    } else {
      await this.window.loadFile(this.rendererPath, { query: { view: 'pinduoduo-workspace' } });
    }
  }

  async #ensureInitialAccount() {
    if (!this.userId || this.activeAccountId) return;
    const account = this.registry
      .list(this.userId)
      .filter((item) => !item.paused)
      .sort((left, right) => {
        if (left.lastOpenedAt && right.lastOpenedAt) {
          return right.lastOpenedAt.localeCompare(left.lastOpenedAt);
        }
        if (left.lastOpenedAt) return -1;
        if (right.lastOpenedAt) return 1;
        return left.createdAt.localeCompare(right.createdAt);
      })[0];
    if (account) await this.selectAccount(account.id);
  }

  getState() {
    if (!this.userId) {
      return {
        accounts: [], archivedAccounts: [], activeAccountId: null, navigation: {},
        rpa: this.rpaManager?.getState() || { status: 'stopped' },
      };
    }
    const accounts = this.registry
      .list(this.userId)
      .map((account) => publicAccount(
        account,
        this.runtime.get(account.id),
        this.collectors.get(account.id),
      ));
    const archivedAccounts = this.registry
      .list(this.userId, { archived: true })
      .map((account) => publicAccount(
        account,
        this.runtime.get(account.id),
        this.collectors.get(account.id),
      ));
    const activeView = this.views.get(this.activeAccountId);
    const contents = activeView?.webContents;
    return {
      accounts,
      archivedAccounts,
      activeAccountId: this.activeAccountId,
      navigation: {
        canGoBack: Boolean(contents && !contents.isDestroyed() && contents.navigationHistory.canGoBack()),
        canGoForward: Boolean(contents && !contents.isDestroyed() && contents.navigationHistory.canGoForward()),
        isLoading: Boolean(contents && !contents.isDestroyed() && contents.isLoading()),
      },
      rpa: this.rpaManager?.getState() || { status: 'stopped' },
    };
  }

  addAccount() {
    this.#requireUser();
    const account = this.registry.create(this.userId, PDD_PENDING_ACCOUNT_ALIAS);
    this.syncRpaAccounts();
    return this.selectAccount(account.id);
  }

  async selectAccount(accountId) {
    this.#requireUser();
    const account = this.registry.get(this.userId, accountId);
    if (!account || account.archivedAt) throw new Error('PDD account not found');
    if (account.paused) throw new Error('请先恢复已暂停的店铺');

    this.#dequeueBackgroundAccount(accountId);
    const view = this.#ensureView(account);
    this.activeAccountId = accountId;
    this.registry.update(this.userId, accountId, { lastOpenedAt: new Date().toISOString() });
    for (const [id, candidate] of this.views) {
      candidate.setVisible(id === accountId && !this.overlayOpen);
    }
    view.webContents.focus();
    this.#layoutViews();
    this.#publishState();
    return this.getState();
  }

  renameAccount(accountId, alias) {
    this.#requireUser();
    this.registry.update(this.userId, accountId, { alias });
    this.syncRpaAccounts();
    this.#publishState();
    return this.getState();
  }

  async detectAccountName(accountId) {
    this.#requireUser();
    const account = this.registry.get(this.userId, accountId);
    if (!account || account.archivedAt) throw new Error('PDD account not found');
    if (account.paused) throw new Error('请先恢复已暂停的店铺');
    const view = this.#ensureView(account);
    const contents = view.webContents;
    await this.#waitForViewReady(contents);

    const requestId = randomUUID();
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingNameDetections.delete(requestId);
        reject(new Error('店铺名称识别超时，请确认拼多多客服接待页面已加载完成后重试'));
      }, ACCOUNT_NAME_DETECTION_TIMEOUT_MS);
      this.pendingNameDetections.set(requestId, { accountId, resolve, reject, timer });
      contents.send('pdd-adapter:command', {
        type: 'detect-account-name',
        requestId,
      });
      this.#writeDiagnostic(accountId, 'account_name_detection_requested');
    });
    if (!result?.accountName || !result?.source) throw new Error(accountNameDetectionFailureMessage(result));
    return result;
  }

  async listImportCandidates() {
    this.#requireUser();
    if (!this.window || this.window.isDestroyed()) await this.#createWindow();
    const accounts = this.registry.list(this.userId).filter((account) => !account.paused);
    const results = await Promise.all(accounts.map(async (account) => {
      const view = this.#ensureView(account);
      try {
        await this.#waitForViewReady(view.webContents);
        const requestId = randomUUID();
        const candidates = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            this.pendingConversationLists.delete(requestId);
            reject(new Error('PDD conversation list scan timeout'));
          }, CONVERSATION_LIST_TIMEOUT_MS);
          this.pendingConversationLists.set(requestId, { accountId: account.id, resolve, reject, timer });
          view.webContents.send('pdd-adapter:command', { type: 'list-conversations-api', requestId });
        });
        const currentAccount = this.registry.get(this.userId, account.id) || account;
        const shopName = candidates.find((candidate) => detectedAlias(candidate.shop_name))?.shop_name
          || detectedAlias(currentAccount.platformAccountName)
          || detectedAlias(currentAccount.alias)
          || currentAccount.alias;
        return candidates.map((candidate) => {
          const conversationKey = typeof candidate?.conversation_key === 'string'
            ? candidate.conversation_key.trim().slice(0, 128)
            : '';
          if (!conversationKey) return null;
          return {
            id: `${account.id}:${conversationKey}`,
            accountId: account.id,
            platformAccountId: currentAccount.platformAccountId || account.platformAccountId || null,
            platformCode: 'pinduoduo',
            platformName: 'pinduoduo',
            shopName: detectedAlias(candidate.shop_name) || shopName,
            conversationKey,
            externalConversationId: typeof candidate.external_conversation_id === 'string'
              ? candidate.external_conversation_id.slice(0, 128)
              : null,
            customerName: typeof candidate.customer_name === 'string' && candidate.customer_name.trim()
              ? candidate.customer_name.trim().slice(0, 128)
              : '鏈煡瀹㈡埛',
            previewText: typeof candidate.preview_text === 'string'
              ? candidate.preview_text.trim().slice(0, 4000) || null
              : null,
            unreadCount: Math.max(0, Math.min(Number(candidate.unread_count) || 0, 9999)),
            active: Boolean(candidate.active),
          };
        }).filter(Boolean);
      } catch (error) {
        this.#writeDiagnostic(account.id, 'conversation_candidates_failed', {
          error: error?.message || String(error),
        }, 'warn');
        return [];
      }
    }));
    return results.flat();
  }

  async importConversation(accountId, conversationKey) {
    this.#requireUser();
    if (typeof conversationKey !== 'string' || !conversationKey.trim() || conversationKey.length > 128) {
      throw new Error('浼氳瘽鍙傛暟鏃犳晥');
    }
    const account = this.registry.get(this.userId, accountId);
    if (!account || account.archivedAt || account.paused) throw new Error('PDD account unavailable');
    if (!this.#isAccountIdentityVerified(account)) throw new Error('店铺身份尚未确认，请等待页面识别完成');
    return this.#getStoreActor(account).enqueue('collect_unread', () => (
      this.#importConversationNow(account, conversationKey.trim().slice(0, 128))
    ));
  }

  async #importConversationNow(account, conversationKey) {
    if (!this.window || this.window.isDestroyed()) await this.#createWindow();
    const view = this.#ensureView(account);
    await this.#waitForViewReady(view.webContents);
    const apiResult = await this.#importConversationViaApi(account, view, conversationKey, {
      requireDirectIngest: true,
    });
    if (apiResult?.status === 'collected') return apiResult;
    this.#writeDiagnostic(account.id, 'api_chat_list_import_failed_no_dom_fallback', {
      conversation_key: conversationKey,
      api_status: apiResult?.status || 'failed',
      api_error: apiResult?.error || null,
      api_reason: apiResult?.reason || null,
    }, 'warn');
    throw new Error('PDD chat/list API import failed; DOM message fallback is disabled');
  }

  async #importConversationViaApi(
    account,
    view,
    conversationKey,
    {
      clearBeforeImport = true,
      directIngest = true,
      requireDirectIngest = false,
    } = {},
  ) {
    if (conversationKey.startsWith('name:')) {
      return { status: 'skipped', reason: 'conversation_key_without_uid' };
    }
    const platformAccountId = account.platformAccountId || null;
    if (platformAccountId && clearBeforeImport) {
      const deletedCount = this.collectors.get(account.id)?.runtime.clearConversationEmitted(
        platformAccountId,
        conversationKey,
      ) || 0;
      this.#writeDiagnostic(account.id, 'api_chat_list_import_dedup_cleared', {
        conversation_key: conversationKey,
        platform_account_id: platformAccountId,
        deleted_count: deletedCount,
      }, 'debug');
      try {
        const rpaDeletedCount = await this.rpaManager?.clearConversationEvents?.(
          platformAccountId,
          conversationKey,
        );
        this.#writeDiagnostic(account.id, 'api_chat_list_import_rpa_queue_cleared', {
          conversation_key: conversationKey,
          platform_account_id: platformAccountId,
          deleted_count: Number(rpaDeletedCount) || 0,
        }, 'debug');
      } catch (error) {
        this.#writeDiagnostic(account.id, 'api_chat_list_import_rpa_queue_clear_failed', {
          conversation_key: conversationKey,
          platform_account_id: platformAccountId,
          error: error?.message || String(error),
        }, 'warn');
      }
    }
    const requestId = randomUUID();
    this.#writeDiagnostic(account.id, 'api_chat_list_import_requested', {
      request_id: requestId,
      conversation_key: conversationKey,
    });
    try {
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingConversationCollections.delete(requestId);
          reject(new Error('鎷煎澶?chat/list 鎺ュ彛璇诲彇瓒呮椂'));
        }, CONVERSATION_COLLECTION_TIMEOUT_MS);
        this.pendingConversationCollections.set(requestId, {
          accountId: account.id,
          resolve,
          reject,
          timer,
          directIngest,
          requireDirectIngest,
        });
        view.webContents.send('pdd-adapter:command', {
          type: 'collect-conversation-api',
          requestId,
          conversationKey,
        });
      });
      if (result?.status === 'collected') return result;
      return {
        status: result?.status || 'failed',
        error: result?.error || null,
        reason: 'api_result_not_collected',
      };
    } catch (error) {
      return {
        status: 'failed',
        error: error?.message || String(error),
        reason: 'api_request_failed',
      };
    }
  }

  async #listApiConversationCandidates(account, view, purpose = 'import-candidates') {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingConversationLists.delete(requestId);
        reject(new Error('鎷煎澶?latest_conversations 鎺ュ彛璇诲彇瓒呮椂'));
      }, CONVERSATION_LIST_TIMEOUT_MS);
      this.pendingConversationLists.set(requestId, { accountId: account.id, resolve, reject, timer });
      view.webContents.send('pdd-adapter:command', {
        type: 'list-conversations-api',
        requestId,
        purpose,
      });
    });
  }

  #findApiCandidateForDomUnread(candidates, payload = {}, switchResult = {}) {
    const customerName = String(
      switchResult.resolved_customer_name
      || switchResult.customer_name
      || payload.customer_name
      || '',
    ).trim();
    const previewText = String(
      switchResult.preview_text
      || payload.preview_text
      || '',
    ).trim();
    const validCandidates = Array.isArray(candidates)
      ? candidates.filter((candidate) => typeof candidate?.conversation_key === 'string' && candidate.conversation_key.trim())
      : [];
    if (!validCandidates.length) return null;
    if (customerName && previewText) {
      const exact = validCandidates.find((candidate) => (
        String(candidate.customer_name || '').trim() === customerName
        && String(candidate.preview_text || '').trim() === previewText
      ));
      if (exact) return exact;
    }
    if (customerName) {
      const byName = validCandidates.filter((candidate) => (
        String(candidate.customer_name || '').trim() === customerName
      ));
      if (byName.length === 1) return byName[0];
      const unreadByName = byName.filter((candidate) => Number(candidate.unread_count || 0) > 0);
      if (unreadByName.length === 1) return unreadByName[0];
    }
    return null;
  }

  async #switchConversationOnly(account, view, conversationKey, customerName = '') {
    const requestId = randomUUID();
    this.#writeDiagnostic(account.id, 'dom_conversation_switch_requested_for_api_backfill', {
      request_id: requestId,
      conversation_key: conversationKey || null,
      customer_name: customerName || null,
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingConversationCollections.delete(requestId);
        reject(new Error('鎷煎澶?DOM 浼氳瘽鍒囨崲瓒呮椂'));
      }, CONVERSATION_COLLECTION_TIMEOUT_MS);
      this.pendingConversationCollections.set(requestId, { accountId: account.id, resolve, reject, timer });
      view.webContents.send('pdd-adapter:command', {
        type: 'switch-conversation',
        requestId,
        conversationKey,
        customerName,
      });
    });
  }

  #isSendTargetAvailable(account) {
    return Boolean(
      account
      && !account.paused
      && !account.archivedAt
      && !UNAVAILABLE_LOGIN_STATUSES.has(account.loginStatus)
      && this.#isAccountIdentityVerified(account),
    );
  }

  #resolveAccountForSend({ platformAccountId, localAccountId = null, operation }) {
    const requestedPlatformAccountId = String(platformAccountId || '').trim();
    const requestedLocalAccountId = String(localAccountId || '').trim();
    const accounts = this.registry.list(this.userId);
    const byLocal = requestedLocalAccountId
      ? accounts.find((candidate) => candidate.id === requestedLocalAccountId)
      : null;
    const byPlatform = requestedPlatformAccountId
      ? accounts.find((candidate) => candidate.platformAccountId === requestedPlatformAccountId)
      : null;
    const account = this.#isSendTargetAvailable(byLocal)
      ? byLocal
      : this.#isSendTargetAvailable(byPlatform) ? byPlatform : null;
    if (account) {
      this.#writeDiagnostic(account.id, 'pdd_send_account_resolved', {
        operation,
        matched_by: account === byLocal ? 'local_account_id' : 'platform_account_id',
        requested_platform_account_id: requestedPlatformAccountId || null,
        requested_local_account_id: requestedLocalAccountId || null,
        account_platform_account_id: account.platformAccountId || null,
        login_status: account.loginStatus || null,
        identity_verified: this.#isAccountIdentityVerified(account),
      }, 'debug');
      return account;
    }
    this.#writeDiagnostic('system', 'pdd_send_account_unavailable', {
      operation,
      requested_platform_account_id: requestedPlatformAccountId || null,
      requested_local_account_id: requestedLocalAccountId || null,
      account_count: accounts.length,
      candidates: accounts.slice(0, 20).map((candidate) => ({
        account_id: candidate.id,
        platform_account_id: candidate.platformAccountId || null,
        login_status: candidate.loginStatus || null,
        paused: Boolean(candidate.paused),
        archived: Boolean(candidate.archivedAt),
        identity_verified: this.#isAccountIdentityVerified(candidate),
        external_account_id_present: Boolean(candidate.externalAccountId),
      })),
    }, 'warn');
    return null;
  }

  async sendMessage({ platformAccountId, localAccountId = null, externalConversationId, customerName, content, quoteMessageId = null }) {
    this.#requireUser();
    const account = this.#resolveAccountForSend({
      platformAccountId,
      localAccountId,
      operation: 'send_message',
    });
    if (!account) throw new Error('未找到可发送消息的拼多多店铺，请确认店铺已登录且账号身份已识别');
    return this.#getStoreActor(account).enqueue('send_message', ({ setState }) => (
      this.#sendMessageNow(account, externalConversationId, customerName, content, setState, quoteMessageId)
    ));
  }

  async listTransferCs({ platformAccountId, localAccountId = null }) {
    this.#requireUser();
    const account = this.#resolveAccountForSend({
      platformAccountId,
      localAccountId,
      operation: 'list_transfer_cs',
    });
    if (!account) throw new Error('未找到可转移会话的拼多多店铺，请确认店铺已登录且账号身份已识别');
    return this.#getStoreActor(account).enqueue('list_transfer_cs', ({ setState }) => (
      this.#listTransferCsNow(account, setState)
    ));
  }

  async #listTransferCsNow(account, setState = () => {}) {
    if (!this.window || this.window.isDestroyed()) await this.#createWindow();
    const view = this.#ensureView(account);
    await this.#waitForViewReady(view.webContents);
    setState('listing_transfer_cs');
    return this.#listTransferCsViaApi(account, view);
  }

  async #listTransferCsViaApi(account, view) {
    const requestId = randomUUID();
    this.#writeDiagnostic(account.id, 'api_transfer_cs_list_requested', {
      request_id: requestId,
    });
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingTransferCsLists.delete(requestId);
        reject(new Error('PDD getAssignCsList API timeout'));
      }, CONVERSATION_TRANSFER_TIMEOUT_MS);
      this.pendingTransferCsLists.set(requestId, { accountId: account.id, resolve, reject, timer });
      view.webContents.send('pdd-adapter:command', {
        type: 'list-transfer-cs-api',
        requestId,
      });
    });
    if (result?.status === 'collected') return result;
    throw new Error(result?.error || 'PDD getAssignCsList API failed');
  }

  async transferConversation({ platformAccountId, localAccountId = null, externalConversationId, customerName, targetCsid, transReason = '无原因直接转移' }) {
    this.#requireUser();
    if (!String(targetCsid || '').trim()) throw new Error('请选择要转移给的客服账号');
    const account = this.#resolveAccountForSend({
      platformAccountId,
      localAccountId,
      operation: 'manual_transfer_conversation',
    });
    if (!account) throw new Error('未找到可转移会话的拼多多店铺，请确认店铺已登录且账号身份已识别');
    return this.#getStoreActor(account).enqueue('manual_transfer_conversation', ({ setState }) => (
      this.#transferConversationNow(
        account,
        externalConversationId,
        customerName,
        transReason,
        setState,
        String(targetCsid).trim(),
      )
    ));
  }

  async #sendMessageNow(account, externalConversationId, customerName, content, setState = () => {}, quoteMessageId = null) {
    if (!this.window || this.window.isDestroyed()) await this.#createWindow();
    const view = this.#ensureView(account);
    await this.#waitForViewReady(view.webContents);
    setState('sending_message_api');
    const apiResult = await this.#sendMessageViaApi(account, view, externalConversationId, customerName, content, quoteMessageId);
    if (apiResult?.status === 'sent') {
      if (externalConversationId) {
        try {
          const backfillResult = await this.#importConversationViaApi(account, view, externalConversationId, {
            clearBeforeImport: false,
          });
          this.#writeDiagnostic(account.id, 'api_message_send_chat_list_backfill_completed', {
            conversation_key: externalConversationId,
            status: backfillResult?.status || 'failed',
            message_count: backfillResult?.message_count || 0,
            has_more: Boolean(backfillResult?.has_more),
            error: backfillResult?.error || null,
          }, backfillResult?.status === 'collected' ? 'info' : 'warn');
        } catch (error) {
          this.#writeDiagnostic(account.id, 'api_message_send_chat_list_backfill_failed', {
            conversation_key: externalConversationId,
            error: error?.message || String(error),
          }, 'warn');
        }
      }
      setState('waiting_text_confirmation');
      return apiResult;
    }
    this.#writeDiagnostic(account.id, 'api_message_send_failed_no_dom_fallback', {
      conversation_key: externalConversationId || `name:${customerName}`,
      api_status: apiResult?.status || 'failed',
      api_error: apiResult?.error || null,
      api_reason: apiResult?.reason || null,
      response_preview: apiResult?.response_preview || null,
      diagnostics: apiResult?.diagnostics || {},
    }, apiResult?.reason === 'conversation_key_without_uid' ? 'debug' : 'warn');
    if (apiResult?.reason === 'conversation_key_without_uid') {
      throw new Error('PDD send_message API requires customer uid');
    }
    const error = new Error(apiResult?.error || 'PDD send_message API failed');
    error.resultJson = {
      method: 'api_send_message',
      text_sent: false,
      send_error: apiResult?.error || null,
      response_preview: apiResult?.response_preview || null,
      diagnostics: apiResult?.diagnostics || {},
    };
    throw error;
  }

  async #sendMessageViaApi(account, view, externalConversationId, customerName, content, quoteMessageId = null) {
    if (!externalConversationId) {
      return { status: 'skipped', reason: 'conversation_key_without_uid' };
    }
    const requestId = randomUUID();
    const conversationKey = externalConversationId.slice(0, 128);
    this.#writeDiagnostic(account.id, 'api_message_send_requested', {
      request_id: requestId,
      conversation_key: conversationKey,
      content_length: String(content || '').length,
      quote_msg_id_present: Boolean(quoteMessageId),
    });
    try {
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingMessagePreparations.delete(requestId);
          reject(new Error('PDD send_message API timeout'));
        }, MESSAGE_PREPARATION_TIMEOUT_MS);
        this.pendingMessagePreparations.set(requestId, { accountId: account.id, resolve, reject, timer });
        view.webContents.send('pdd-adapter:command', {
          type: 'send-message-api',
          requestId,
          conversationKey,
          customerName: customerName.slice(0, 128),
          content: content.slice(0, 4000),
          quoteMessageId: quoteMessageId ? String(quoteMessageId).slice(0, 128) : null,
        });
      });
      if (result?.status === 'sent') return result;
      return {
        status: result?.status || 'failed',
        error: result?.error || null,
        diagnostics: result?.diagnostics || {},
        response_preview: result?.response_preview || null,
        reason: 'api_result_not_sent',
      };
    } catch (error) {
      return {
        status: 'failed',
        error: error?.message || String(error),
        reason: 'api_request_failed',
      };
    }
  }

  async #transferConversationNow(account, externalConversationId, customerName, transReason, setState = () => {}, targetCsid = '', autoTransfer = false) {
    if (!this.window || this.window.isDestroyed()) await this.#createWindow();
    const view = this.#ensureView(account);
    await this.#waitForViewReady(view.webContents);
    setState('transferring_conversation_api');
    const apiResult = await this.#transferConversationViaApi(
      account,
      view,
      externalConversationId,
      customerName,
      transReason,
      targetCsid,
      autoTransfer,
    );
    if (autoTransfer) return apiResult;
    if (apiResult?.status === 'transferred') {
      this.#markSessionActivity(account.id);
      return apiResult;
    }
    this.#writeDiagnostic(account.id, 'api_conversation_transfer_failed_no_dom_fallback', {
      conversation_key: externalConversationId || `name:${customerName}`,
      api_status: apiResult?.status || 'failed',
      api_error: apiResult?.error || null,
      api_reason: apiResult?.reason || null,
    }, apiResult?.reason === 'conversation_key_without_uid' ? 'debug' : 'warn');
    if (apiResult?.reason === 'conversation_key_without_uid') {
      throw new Error('PDD move_conversation API requires customer uid');
    }
    throw new Error(apiResult?.error || 'PDD move_conversation API failed');
  }

  async #transferConversationViaApi(account, view, externalConversationId, customerName, transReason, targetCsid = '', autoTransfer = false) {
    if (!externalConversationId) {
      return { status: 'skipped', reason: 'conversation_key_without_uid' };
    }
    const requestId = randomUUID();
    const conversationKey = externalConversationId.slice(0, 128);
    this.#writeDiagnostic(account.id, 'api_conversation_transfer_requested', {
      request_id: requestId,
      conversation_key: conversationKey,
      target_csid_present: Boolean(targetCsid),
    });
    try {
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingConversationTransfers.delete(requestId);
          reject(new Error('PDD move_conversation API timeout'));
        }, CONVERSATION_TRANSFER_TIMEOUT_MS);
        this.pendingConversationTransfers.set(requestId, { accountId: account.id, resolve, reject, timer });
        view.webContents.send('pdd-adapter:command', {
          type: 'transfer-conversation-api',
          requestId,
          conversationKey,
          customerName: String(customerName || '').slice(0, 128),
          transReason: String(transReason || '无原因直接转移').slice(0, 128),
          targetCsid: String(targetCsid || '').slice(0, 128),
          autoTransfer,
        });
      });
      if (result?.status === 'transferred' || autoTransfer) return result;
      return {
        status: result?.status || 'failed',
        error: result?.error || null,
        reason: 'api_result_not_transferred',
      };
    } catch (error) {
      return {
        status: 'failed',
        error: error?.message || String(error),
        reason: 'api_request_failed',
      };
    }
  }

  async sendImage({ platformAccountId, localAccountId = null, externalConversationId, customerName, imageUrl, quoteMessageId = null }) {
    this.#requireUser();
    if (!/^https?:\/\//i.test(String(imageUrl || ''))) throw new Error('图片地址无效');
    const account = this.#resolveAccountForSend({
      platformAccountId,
      localAccountId,
      operation: 'send_image_url',
    });
    if (!account) throw new Error('未找到可发送图片的拼多多店铺，请确认店铺已登录且账号身份已识别');
    return this.#getStoreActor(account).enqueue('send_image', async ({ setState, signal }) => {
      const imagePayload = await this.#downloadImage(imageUrl, signal);
      return this.#sendImageNow(account, externalConversationId, customerName, imagePayload, setState, quoteMessageId);
    });
  }

  async #sendImageNow(account, externalConversationId, customerName, imagePayload, setState = () => {}, quoteMessageId = null) {
    if (!this.window || this.window.isDestroyed()) await this.#createWindow();
    const view = this.#ensureView(account);
    await this.#waitForViewReady(view.webContents);
    setState('sending_image_api');
    const apiResult = await this.#sendImageViaApi(
      account,
      view,
      externalConversationId,
      customerName,
      imagePayload,
      quoteMessageId,
    );
    if (apiResult?.status === 'sent') {
      if (externalConversationId) {
        try {
          const backfillResult = await this.#importConversationViaApi(account, view, externalConversationId, {
            clearBeforeImport: false,
          });
          this.#writeDiagnostic(account.id, 'api_image_send_chat_list_backfill_completed', {
            conversation_key: externalConversationId,
            status: backfillResult?.status || 'failed',
            message_count: backfillResult?.message_count || 0,
            has_more: Boolean(backfillResult?.has_more),
            error: backfillResult?.error || null,
          }, backfillResult?.status === 'collected' ? 'info' : 'warn');
        } catch (error) {
          this.#writeDiagnostic(account.id, 'api_image_send_chat_list_backfill_failed', {
            conversation_key: externalConversationId,
            error: error?.message || String(error),
          }, 'warn');
        }
      }
      return apiResult;
    }
    this.#writeDiagnostic(account.id, 'api_image_send_failed_no_dom_fallback', {
      conversation_key: externalConversationId || 'name:' + customerName,
      api_status: apiResult?.status || 'failed',
      api_error: apiResult?.error || null,
      api_reason: apiResult?.reason || null,
      response_preview: apiResult?.response_preview || null,
      diagnostics: apiResult?.diagnostics || {},
    }, apiResult?.reason === 'conversation_key_without_uid' ? 'debug' : 'warn');
    if (apiResult?.reason === 'conversation_key_without_uid') {
      throw new Error('PDD image send API requires customer uid. Import the conversation through latest_conversations/chat/list first.');
    }
    const error = new Error(apiResult?.error || 'PDD send_message image API failed');
    error.resultJson = {
      method: 'api_send_image',
      image_sent: false,
      image_error: apiResult?.error || null,
      response_preview: apiResult?.response_preview || null,
      diagnostics: apiResult?.diagnostics || {},
    };
    throw error;
  }

  async #sendImageViaApi(account, view, externalConversationId, customerName, imagePayload, quoteMessageId = null) {
    if (!externalConversationId) {
      return { status: 'skipped', reason: 'conversation_key_without_uid' };
    }
    if (!imagePayload?.imageDataUrl) {
      return { status: 'failed', reason: 'image_data_missing', error: 'image_data_missing' };
    }
    const requestId = randomUUID();
    const conversationKey = externalConversationId.slice(0, 128);
    this.#writeDiagnostic(account.id, 'api_image_send_requested', {
      request_id: requestId,
      conversation_key: conversationKey,
      image_bytes: Number(imagePayload.byteSize) || null,
      width: Number(imagePayload.width) || null,
      height: Number(imagePayload.height) || null,
      quote_msg_id_present: Boolean(quoteMessageId),
    });
    try {
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingImagePreparations.delete(requestId);
          reject(new Error('PDD send_message image API timeout'));
        }, IMAGE_SEND_CONFIRMATION_TIMEOUT_MS);
        this.pendingImagePreparations.set(requestId, { accountId: account.id, resolve, reject, timer });
        view.webContents.send('pdd-adapter:command', {
          type: 'send-image-api',
          requestId,
          conversationKey,
          customerName: customerName.slice(0, 128),
          imageDataUrl: imagePayload.imageDataUrl,
          width: Number(imagePayload.width) || null,
          height: Number(imagePayload.height) || null,
          byteSize: Number(imagePayload.byteSize) || null,
          quoteMessageId: quoteMessageId ? String(quoteMessageId).slice(0, 128) : null,
        });
      });
      if (result?.status === 'sent') return result;
      return {
        status: result?.status || 'failed',
        error: result?.error || null,
        diagnostics: result?.diagnostics || {},
        response_preview: result?.response_preview || null,
        reason: 'api_result_not_sent',
      };
    } catch (error) {
      return {
        status: 'failed',
        error: error?.message || String(error),
        reason: 'api_request_failed',
      };
    }
  }

  async refreshCustomerProducts({ platformAccountId, localAccountId = null, externalConversationId, customerName }) {
    this.#requireUser();
    const account = this.#resolveAccountForSend({
      platformAccountId,
      localAccountId,
      operation: 'refresh_customer_products',
    });
    if (!account) throw new Error('未找到可读取商品列表的拼多多店铺，请确认店铺已登录且账号身份已识别');
    return this.#getStoreActor(account).enqueue('refresh_customer_products', () => (
      this.#refreshCustomerProductsViaApi(
        account,
        externalConversationId ? externalConversationId.slice(0, 128) : '',
        customerName,
      )
    ));
  }

  async importPlatformPhrases({ accountId, source }) {
    this.#requireUser();
    const account = this.registry.get(this.userId, accountId);
    if (!account || account.archivedAt || account.paused) throw new Error('PDD account unavailable');
    if (!['personal', 'team'].includes(source)) throw new Error('PDD phrase source invalid');
    return this.#getStoreActor(account).enqueue('import_platform_phrases', () => (
      this.#importPlatformPhrasesViaApi(account, source)
    ));
  }

  async #importPlatformPhrasesViaApi(account, source) {
    if (!this.window || this.window.isDestroyed()) await this.#createWindow();
    const view = this.#ensureView(account);
    await this.#waitForViewReady(view.webContents);
    const requestId = randomUUID();
    this.#writeDiagnostic(account.id, 'api_platform_phrases_import_requested', {
      request_id: requestId,
      source,
    });
    try {
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingPlatformPhraseCollections.delete(requestId);
          reject(new Error('PDD platform phrase API timeout'));
        }, PLATFORM_PHRASE_COLLECTION_TIMEOUT_MS);
        this.pendingPlatformPhraseCollections.set(requestId, {
          accountId: account.id,
          resolve,
          reject,
          timer,
        });
        view.webContents.send('pdd-adapter:command', {
          type: 'collect-platform-phrases-api',
          requestId,
          source,
        });
      });
      if (result?.status === 'collected') return result;
      return {
        status: 'failed',
        account_id: account.id,
        source,
        records: [],
        raw_count: 0,
        error: result?.error || 'PDD platform phrase API import failed',
      };
    } catch (error) {
      this.#writeDiagnostic(account.id, 'api_platform_phrases_import_failed', {
        request_id: requestId,
        source,
        error: error?.message || String(error),
      }, 'warn');
      throw error;
    }
  }

  async #refreshCustomerProductsViaApi(account, conversationKey, customerName = '') {
    if (!this.window || this.window.isDestroyed()) await this.#createWindow();
    const view = this.#ensureView(account);
    await this.#waitForViewReady(view.webContents);
    const requestId = randomUUID();
    this.#writeDiagnostic(account.id, 'api_customer_products_import_requested', {
      request_id: requestId,
      conversation_key: conversationKey,
      customer_name: customerName || null,
    });
    try {
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingCustomerProductCollections.delete(requestId);
          reject(new Error('PDD recommendGoods API timeout'));
        }, CUSTOMER_PRODUCT_COLLECTION_TIMEOUT_MS);
        this.pendingCustomerProductCollections.set(requestId, {
          accountId: account.id,
          resolve,
          reject,
          timer,
        });
        view.webContents.send('pdd-adapter:command', {
          type: 'collect-customer-products-api',
          requestId,
          conversationKey,
          customerName: customerName || '',
        });
      });
      if (result?.status === 'collected') return result;
      throw new Error(result?.error || 'PDD recommendGoods API import failed');
    } catch (error) {
      this.#writeDiagnostic(account.id, 'api_customer_products_import_failed', {
        request_id: requestId,
        conversation_key: conversationKey,
        error: error?.message || String(error),
      }, 'warn');
      throw error;
    }
  }

  async sendProduct({ platformAccountId, localAccountId = null, externalConversationId, customerName, productId }) {
    this.#requireUser();
    const account = this.#resolveAccountForSend({
      platformAccountId,
      localAccountId,
      operation: 'send_product',
    });
    if (!account) throw new Error('未找到可发送商品的拼多多店铺，请确认店铺已登录且账号身份已识别');
    return this.#getStoreActor(account).enqueue('send_product', ({ setState }) => (
      this.#sendProductNow(account, externalConversationId, customerName, productId, setState)
    ));
  }

  async #sendProductNow(account, externalConversationId, customerName, productId, setState = () => {}) {
    if (!this.window || this.window.isDestroyed()) await this.#createWindow();
    const view = this.#ensureView(account);
    await this.#waitForViewReady(view.webContents);
    setState('sending_product_api');
    const apiResult = await this.#sendProductViaApi(account, view, externalConversationId, customerName, productId);
    if (apiResult?.status !== 'sent') {
      this.#writeDiagnostic(account.id, 'api_product_send_failed_no_dom_fallback', {
        conversation_key: externalConversationId || 'name:' + customerName,
        product_id: productId || null,
        api_status: apiResult?.status || 'failed',
        api_error: apiResult?.error || null,
        api_reason: apiResult?.reason || null,
      }, apiResult?.reason === 'conversation_key_without_uid' ? 'debug' : 'warn');
      if (apiResult?.reason === 'conversation_key_without_uid') {
        throw new Error('PDD mallGoodsCard API requires customer uid');
      }
      throw new Error(apiResult?.error || 'PDD mallGoodsCard API failed');
    }
    let backfillResult = null;
    if (externalConversationId) {
      try {
        backfillResult = await this.#importConversationViaApi(account, view, externalConversationId, {
          clearBeforeImport: false,
        });
        this.#writeDiagnostic(account.id, 'api_product_send_chat_list_backfill_completed', {
          conversation_key: externalConversationId,
          product_id: productId || null,
          status: backfillResult?.status || 'failed',
          message_count: backfillResult?.message_count || 0,
          has_more: Boolean(backfillResult?.has_more),
          error: backfillResult?.error || null,
        }, backfillResult?.status === 'collected' ? 'info' : 'warn');
      } catch (error) {
        this.#writeDiagnostic(account.id, 'api_product_send_chat_list_backfill_failed', {
          conversation_key: externalConversationId,
          product_id: productId || null,
          error: error?.message || String(error),
        }, 'warn');
      }
    }
    return {
      ...apiResult,
      backfill: backfillResult,
    };
  }

  async #sendProductViaApi(account, view, externalConversationId, customerName, productId) {
    if (!externalConversationId) {
      return { status: 'skipped', reason: 'conversation_key_without_uid' };
    }
    const normalizedProductId = String(productId || '').trim().slice(0, 128);
    if (!normalizedProductId) {
      return { status: 'failed', reason: 'product_id_missing', error: 'product_id_missing' };
    }
    const requestId = randomUUID();
    const conversationKey = externalConversationId.slice(0, 128);
    this.#writeDiagnostic(account.id, 'api_product_send_requested', {
      request_id: requestId,
      conversation_key: conversationKey,
      product_id: normalizedProductId,
    });
    try {
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingProductSendPreparations.delete(requestId);
          reject(new Error('PDD mallGoodsCard API timeout'));
        }, PRODUCT_SEND_CONFIRMATION_TIMEOUT_MS);
        this.pendingProductSendPreparations.set(requestId, { accountId: account.id, resolve, reject, timer });
        view.webContents.send('pdd-adapter:command', {
          type: 'send-product-api',
          requestId,
          conversationKey,
          customerName: String(customerName || '').slice(0, 128),
          productId: normalizedProductId,
        });
      });
      if (result?.status === 'sent') return result;
      return {
        status: result?.status || 'failed',
        error: result?.error || null,
        reason: 'api_result_not_sent',
      };
    } catch (error) {
      return {
        status: 'failed',
        error: error?.message || String(error),
        reason: 'api_request_failed',
      };
    }
  }

  async #downloadImage(imageUrl, signal = undefined) {
    if (!/^https?:\/\//i.test(String(imageUrl || ''))) throw new Error('鍥剧墖鍦板潃鏃犳晥');
    const headers = new Headers();
    if (new URL(imageUrl).origin === this.knowledgeBaseOrigin && this.rpaManager?.accessToken) {
      headers.set('Authorization', 'Bearer ' + this.rpaManager.accessToken);
    }
    const response = await fetch(imageUrl, { signal, headers });
    if (!response.ok) throw new Error('Image download failed: HTTP ' + response.status);
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) throw new Error('杩滅▼璧勬簮涓嶆槸鍥剧墖');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 10 * 1024 * 1024) throw new Error('鍥剧墖涓嶈兘瓒呰繃 10 MB');
    const image = nativeImage.createFromBuffer(bytes);
    if (image.isEmpty()) throw new Error('鍥剧墖鍐呭鏃犳晥');
    const size = image.getSize();
    const mimeType = contentType.split(';')[0].trim().toLowerCase();
    return {
      image,
      imageDataUrl: 'data:' + mimeType + ';base64,' + bytes.toString('base64'),
      mimeType,
      byteSize: bytes.length,
      width: Number(size.width) || null,
      height: Number(size.height) || null,
    };
  }

  #getStoreActor(account) {
    const existing = this.storeActors.get(account.id);
    if (existing) return existing;
    const actor = new StoreActor({
      accountId: account.id,
      rescan: ({ reasons }) => this.#scanStore(account.id, reasons),
      onStateChange: ({ state, error }) => {
        if (state !== 'idle' && state !== 'cancelled') this.#markSessionActivity(account.id);
        const view = this.views.get(account.id);
        if (view && !view.webContents.isDestroyed()) {
          view.webContents.send('pdd-adapter:command', {
            type: 'set-store-actor-state',
            state,
          });
        }
        this.#writeDiagnostic(account.id, 'store_actor_state_changed', {
          state,
          ...(error ? { error } : {}),
        }, error ? 'warn' : 'debug');
      },
    });
    this.storeActors.set(account.id, actor);
    return actor;
  }

  async #scanStore(accountId, reasons = []) {
    const view = this.views.get(accountId);
    if (!view || view.webContents.isDestroyed()) throw new Error('搴楅摵椤甸潰宸插叧闂紝鏃犳硶閲嶆柊鎵弿');
    const requestId = randomUUID();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingStoreScans.delete(requestId);
        reject(new Error('搴楅摵椤甸潰閲嶆柊鎵弿瓒呮椂'));
      }, STORE_SCAN_TIMEOUT_MS);
      this.pendingStoreScans.set(requestId, { accountId, resolve, reject, timer });
      view.webContents.send('pdd-adapter:command', {
        type: 'scan-current-page',
        requestId,
      });
    });
    this.#writeDiagnostic(accountId, 'store_actor_rescan_completed', { reasons });
  }

  async #collectNextUnread(account) {
    const view = this.views.get(account.id);
    if (!view || view.webContents.isDestroyed()) throw new Error('搴楅摵椤甸潰宸插叧闂紝鏃犳硶璇诲彇鏈浼氳瘽');
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingUnreadCollections.delete(requestId);
        reject(new Error('PDD unread collection timeout'));
      }, UNREAD_COLLECTION_TIMEOUT_MS);
      this.pendingUnreadCollections.set(requestId, { accountId: account.id, resolve, reject, timer });
      view.webContents.send('pdd-adapter:command', { type: 'collect-next-unread', requestId });
    });
  }

  async #collectUnreadViaApiBackfill(account, payload = {}) {
    const view = this.views.get(account.id);
    if (!view || view.webContents.isDestroyed()) throw new Error('搴楅摵椤甸潰宸插叧闂紝鏃犳硶璇诲彇鏈浼氳瘽');
    const conversationKey = typeof payload.conversation_key === 'string'
      ? payload.conversation_key.trim().slice(0, 128)
      : '';
    const customerName = typeof payload.customer_name === 'string'
      ? payload.customer_name.trim().slice(0, 128)
      : '';
    const previewText = typeof payload.preview_text === 'string'
      ? payload.preview_text.trim().slice(0, 4000)
      : '';
    if (!conversationKey || conversationKey.startsWith('name:')) {
      this.#writeDiagnostic(account.id, 'dom_unread_api_backfill_requires_dom_switch', {
        conversation_key: conversationKey || null,
        customer_name: customerName || null,
        preview_text_present: Boolean(previewText),
        reason: conversationKey ? 'conversation_key_without_uid' : 'conversation_key_missing',
      });
      let switchResult;
      try {
        await this.#waitForViewReady(view.webContents);
        switchResult = await this.#switchConversationOnly(account, view, conversationKey || 'name:' + customerName, customerName);
      } catch (error) {
        this.#writeDiagnostic(account.id, 'dom_unread_api_backfill_failed', {
          conversation_key: conversationKey || null,
          customer_name: customerName || null,
          reason: 'dom_switch_failed',
          error: error?.message || String(error),
        }, 'warn');
        return { status: 'failed', reason: 'dom_switch_failed', error: error?.message || String(error) };
      }
      if (switchResult?.status !== 'switched') {
        this.#writeDiagnostic(account.id, 'dom_unread_api_backfill_failed', {
          conversation_key: conversationKey || null,
          customer_name: customerName || null,
          switch_status: switchResult?.status || 'failed',
          reason: 'dom_switch_not_verified',
        }, 'warn');
        return { status: 'failed', reason: 'dom_switch_not_verified' };
      }
      let candidates = [];
      try {
        candidates = await this.#listApiConversationCandidates(account, view);
      } catch (error) {
        this.#writeDiagnostic(account.id, 'dom_unread_api_backfill_failed', {
          conversation_key: conversationKey || null,
          customer_name: customerName || null,
          reason: 'latest_conversations_failed',
          error: error?.message || String(error),
        }, 'warn');
        return { status: 'failed', reason: 'latest_conversations_failed', error: error?.message || String(error) };
      }
      const matched = this.#findApiCandidateForDomUnread(candidates, {
        ...payload,
        preview_text: previewText,
      }, switchResult);
      if (!matched?.conversation_key) {
        this.#writeDiagnostic(account.id, 'dom_unread_api_backfill_failed', {
          conversation_key: conversationKey || null,
          customer_name: customerName || null,
          preview_text_present: Boolean(previewText),
          reason: 'customer_uid_not_resolved_after_dom_switch',
          candidate_count: candidates.length,
        }, 'warn');
        return { status: 'failed', reason: 'customer_uid_not_resolved_after_dom_switch' };
      }
      this.#writeDiagnostic(account.id, 'dom_unread_api_backfill_uid_resolved', {
        original_conversation_key: conversationKey || null,
        resolved_conversation_key: matched.conversation_key,
        customer_name: matched.customer_name || customerName || null,
        matched_by_latest_conversations: true,
      });
      return this.#collectUnreadViaApiBackfill(account, {
        ...payload,
        dom_conversation_key: conversationKey || switchResult.resolved_conversation_key || null,
        conversation_key: matched.conversation_key,
        customer_name: matched.customer_name || customerName,
        preview_text: matched.preview_text || previewText,
      });
    }

    this.#writeDiagnostic(account.id, 'dom_unread_api_backfill_requested', {
      conversation_key: conversationKey,
      customer_name: customerName || null,
    });
    let apiResult;
    try {
      await this.#waitForViewReady(view.webContents);
      apiResult = await this.#importConversationViaApi(account, view, conversationKey, { clearBeforeImport: false });
    } catch (error) {
      apiResult = {
        status: 'failed',
        error: error?.message || String(error),
        reason: 'api_request_failed',
      };
    }
    if (apiResult?.status === 'collected') {
      this.#writeDiagnostic(account.id, 'dom_unread_api_backfill_succeeded', {
        conversation_key: conversationKey,
        customer_name: customerName || apiResult.customer_name || null,
        method: apiResult.method || 'api_chat_list',
        message_count: apiResult.message_count || 0,
        has_more: Boolean(apiResult.has_more),
      });
      view.webContents.send('pdd-adapter:command', {
        type: 'ack-unread-api-backfill',
        conversationKey,
        domConversationKey: typeof payload.dom_conversation_key === 'string'
          ? payload.dom_conversation_key.slice(0, 128)
          : '',
        customerName: customerName || apiResult.customer_name || '',
      });
      return {
        ...apiResult,
        source: 'dom_unread_api_backfill',
      };
    }

    this.#writeDiagnostic(account.id, 'dom_unread_api_backfill_failed_no_dom_message_fallback', {
      conversation_key: conversationKey,
      customer_name: customerName || null,
      api_status: apiResult?.status || 'failed',
      api_error: apiResult?.error || null,
      api_reason: apiResult?.reason || null,
    }, 'warn');
    return {
      status: apiResult?.status || 'failed',
      error: apiResult?.error || null,
      reason: apiResult?.reason || 'api_result_not_collected',
    };
  }

  #enqueueRpaTask(task) {
    if (!task?.id) return;
    if (task.platform_code && task.platform_code !== 'pinduoduo') return;
    const platformAccountId = task.platform_account_id || task.payload_json?.platform_account_id;
    const account = this.registry.list(this.userId).find(
      (candidate) => candidate.platformAccountId === platformAccountId
        && !candidate.paused
        && !UNAVAILABLE_LOGIN_STATUSES.has(candidate.loginStatus)
        && this.#isAccountIdentityVerified(candidate),
    );
    if (!account) {
      void this.#executeRpaTask(task, null);
      return;
    }
    let started = false;
    void this.#getStoreActor(account)
      .enqueue(
        task.task_type === 'send_message'
          ? 'send_reply_bundle'
          : ['transfer_conversation', 'pdd_transfer_prepare'].includes(task.task_type) ? 'transfer_conversation'
          : task.task_type === 'refresh_customer_orders' ? 'collect_unread' : 'send_image',
        ({ setState, signal }) => {
        started = true;
        return this.#executeRpaTask(task, account, setState, signal);
        },
      )
      .catch((error) => {
        if (!started) {
          this.rpaManager?.completeTask(task.id, 'failed', {}, error?.message || String(error));
        }
      });
  }

  async #sendReplyBundle(task, payload, account, setState = () => {}, signal = undefined) {
    if (!account) throw new Error('鏈壘鍒版秷鎭搴旂殑鎷煎澶氬簵閾猴紝璇风‘璁ゅ簵閾哄凡鐧诲綍');
    const followUp = payload.follow_up;
    const followUpProducts = Array.isArray(payload.follow_up_products)
      ? payload.follow_up_products.slice(0, 2)
      : [];
    const imagePayload = followUp?.type === 'image' && followUp.url
      ? await this.#downloadImage(followUp.url, signal)
      : null;
    if (!this.window || this.window.isDestroyed()) await this.#createWindow();
    const view = this.#ensureView(account);
    await this.#waitForViewReady(view.webContents);
    const textResult = await this.#sendMessageNow(
      account,
      payload.external_conversation_id,
      payload.customer_name || '',
      payload.content || '',
      setState,
      payload.quote_message_id || null,
    );
    let imageResult = null;
    if (imagePayload) {
      try {
        setState('sending_image_api');
        imageResult = await this.#sendImageNow(
          account,
          textResult.conversation_key,
          payload.customer_name || '',
          imagePayload,
          setState,
          payload.follow_up_quote_message_id || payload.quote_message_id || null,
        );
      } catch (error) {
        const imageFailure = error?.resultJson && typeof error.resultJson === 'object'
          ? error.resultJson
          : {};
        error.resultJson = {
          ...imageFailure,
          text_sent: true,
          image_sent: false,
          image_error: error?.message || String(error),
          image_response_preview: imageFailure.response_preview || null,
          image_diagnostics: imageFailure.diagnostics || {},
        };
        throw error;
      }
    }
    const productResults = [];
    for (const product of followUpProducts) {
      const productId = product?.product_id || product?.platform_product_id;
      if (!productId) {
        productResults.push({
          goods_id: product?.goods_id || null,
          product_id: null,
          status: 'failed',
          error: '商品缺少平台商品 ID',
        });
        continue;
      }
      try {
        setState('sending_product_api');
        const productResult = await this.#sendProductNow(
          account,
          textResult.conversation_key,
          payload.customer_name || '',
          String(productId),
          setState,
        );
        productResults.push({
          goods_id: product?.goods_id || null,
          product_id: String(productId),
          status: productResult?.status === 'sent' ? 'sent' : 'failed',
          error: productResult?.status === 'sent' ? null : (productResult?.error || '商品发送失败'),
        });
      } catch (error) {
        productResults.push({
          goods_id: product?.goods_id || null,
          product_id: String(productId),
          status: 'failed',
          error: error?.message || String(error),
        });
      }
    }
    return {
      method: textResult.method || null,
      text_sent: true,
      platform_message_id: textResult.msg_id || null,
      pre_msg_id: textResult.pre_msg_id || null,
      ts: textResult.ts || null,
      image_sent: imageResult?.status === 'sent',
      image_confirmation_pending: imageResult?.status === 'pending',
      image_method: imageResult?.method || null,
      image_confirmation: imageResult?.confirmation || null,
      image_platform_message_id: imageResult?.msg_id || null,
      image_pre_msg_id: imageResult?.pre_msg_id || null,
      image_ts: imageResult?.ts || null,
      image_url: imageResult?.image_url || null,
      product_results: productResults,
      products_sent: productResults.filter((item) => item.status === 'sent').length,
      products_failed: productResults.filter((item) => item.status !== 'sent').length,
      product_send_failed: productResults.some((item) => item.status !== 'sent'),
    };
  }

  async #executeRpaTask(task, account, setState = () => {}, signal = undefined) {
    if (!task?.id || !this.rpaManager) return;
    const payload = task.payload_json || {};
    try {
      if (['send_message', 'send_image', 'transfer_conversation', 'pdd_transfer_prepare'].includes(task.task_type)) {
        const response = await fetch(`${this.businessApiUrl}/rpa/tasks/${encodeURIComponent(task.id)}/pdd-execution-guard`, {
          method: 'POST', headers: { Authorization: `Bearer ${this.rpaManager.accessToken}` }, signal: AbortSignal.timeout(8000),
        });
        if (!response.ok || (await response.json()).allowed !== true) throw new Error('拼多多任务已失效或转接状态禁止执行');
      }
      if (task.task_type === 'pdd_transfer_prepare') {
        if (!account) throw new Error('未找到拼多多店铺');
        const roster = await this.#listTransferCsNow(account, setState);
        const result = preparePddTransfer(roster);
        this.rpaManager.completeTask(task.id, 'completed', result);
      } else if (task.task_type === 'send_message') {
        const result = await this.#sendReplyBundle(task, payload, account, setState, signal);
        this.rpaManager.completeTask(
          task.id,
          result.image_confirmation_pending ? 'confirmation_pending' : 'completed',
          result,
          result.image_confirmation_pending ? 'image_confirmation_pending' : null,
        );
      } else if (task.task_type === 'send_image') {
        if (!account) throw new Error('鏈壘鍒版秷鎭搴旂殑鎷煎澶氬簵閾猴紝璇风‘璁ゅ簵閾哄凡鐧诲綍');
        const imagePayload = await this.#downloadImage(payload.image_url, signal);
        const result = await this.#sendImageNow(
          account,
          payload.external_conversation_id,
          payload.customer_name || '',
          imagePayload,
          setState,
        );
        this.rpaManager.completeTask(task.id, 'completed', result);
      } else if (task.task_type === 'refresh_customer_orders') {
        if (!account) throw new Error('鏈壘鍒拌鍗曞搴旂殑鎷煎澶氬簵閾猴紝璇风‘璁ゅ簵閾哄凡鐧诲綍');
        const conversationKey = payload.external_conversation_id || 'name:' + (payload.customer_name || '');
        const result = await this.#refreshCustomerOrdersViaApi(
          account,
          conversationKey.slice(0, 128),
          payload.customer_name || '',
        );
        if (result?.status !== 'collected') throw new Error('閲嶆柊璇诲彇瀹㈡埛璁㈠崟澶辫触');
        this.rpaManager.completeTask(task.id, 'completed', result);
      } else if (task.task_type === 'transfer_conversation') {
        if (!account) throw new Error('未找到会话对应的拼多多店铺，请确认店铺已登录');
        const result = await this.#transferConversationNow(
          account,
          payload.external_conversation_id,
          payload.customer_name || '',
          payload.trans_reason || '无原因直接转移',
          setState,
          payload.target_csid || '',
          Boolean(payload.pdd_auto_operation_id),
        );
        this.rpaManager.completeTask(task.id, ['transferred', 'no_online_target'].includes(result?.status) ? 'completed' :
          result?.submitted !== false ? 'confirmation_pending' : 'failed', result, result?.error || null);
      } else {
        this.rpaManager.completeTask(task.id, 'failed', {}, 'Unsupported RPA task: ' + task.task_type);
      }
    } catch (error) {
      this.rpaManager.completeTask(
        task.id,
        'failed',
        error?.resultJson || {},
        error?.message || String(error),
      );
    }
  }

  async setAccountPaused(accountId, paused) {
    this.#requireUser();
    const account = this.registry.get(this.userId, accountId);
    if (!account || account.archivedAt) throw new Error('PDD account not found');
    this.registry.update(this.userId, accountId, { paused });
    this.registry.update(this.userId, accountId, {
      loginStatus: paused ? 'paused' : 'unknown',
    });

    if (paused) {
      this.#dequeueBackgroundAccount(accountId);
      this.#destroyView(accountId);
      if (this.activeAccountId === accountId) this.activeAccountId = null;
      await this.#ensureInitialAccount();
    } else {
      await this.selectAccount(accountId);
    }
    this.#publishState();
    this.syncRpaAccounts();
    return this.getState();
  }

  async removeAccount(accountId, clearStorage) {
    this.#requireUser();
    const account = this.registry.get(this.userId, accountId);
    if (!account || account.archivedAt) throw new Error('PDD account not found');
    this.#dequeueBackgroundAccount(accountId);
    this.#destroyView(accountId);
    if (this.activeAccountId === accountId) this.activeAccountId = null;

    if (clearStorage) {
      this.registry.remove(this.userId, accountId);
      await this.#clearPartition(account.partition);
    } else {
      this.registry.update(this.userId, accountId, { archivedAt: new Date().toISOString(), paused: true });
    }

    await this.#ensureInitialAccount();
    this.syncRpaAccounts();
    this.#publishState();
    return this.getState();
  }

  async restoreAccount(accountId) {
    this.#requireUser();
    const account = this.registry.get(this.userId, accountId);
    if (!account || !account.archivedAt) throw new Error('娌℃湁鍙仮澶嶇殑搴楅摵璧勬枡');
    this.registry.update(this.userId, accountId, { archivedAt: null, paused: false });
    this.registry.update(this.userId, accountId, { loginStatus: 'unknown' });
    this.syncRpaAccounts();
    return this.selectAccount(accountId);
  }

  setOverlayOpen(open) {
    this.overlayOpen = Boolean(open);
    const activeView = this.views.get(this.activeAccountId);
    if (activeView && !activeView.webContents.isDestroyed()) {
      activeView.setVisible(!this.overlayOpen);
    }
    return this.getState();
  }

  goBack() {
    this.#requireIdleActiveStore('鍚庨€€');
    const contents = this.#activeWebContents();
    if (contents?.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    return this.getState();
  }

  goForward() {
    this.#requireIdleActiveStore('鍓嶈繘');
    const contents = this.#activeWebContents();
    if (contents?.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
    return this.getState();
  }

  reload() {
    this.#requireIdleActiveStore('鍒锋柊');
    this.#activeWebContents()?.reload();
    return this.getState();
  }

  async closeForLogout() {
    this.#stopSessionHealthMonitor();
    this.#cancelBackgroundAccountLoads();
    await this.#flushAccountStorage();
    for (const accountId of [...this.views.keys()]) this.#destroyView(accountId);
    this.activeAccountId = null;
    this.runtime.clear();
    this.collectors.clear();
    if (this.window && !this.window.isDestroyed()) {
      this.isQuitting = true;
      this.window.destroy();
      this.isQuitting = false;
    }
    this.window = null;
    this.userId = null;
  }

  async prepareToQuit() {
    this.isQuitting = true;
    this.#stopSessionHealthMonitor();
    this.#cancelBackgroundAccountLoads();
    await this.#flushAccountStorage();
    for (const accountId of [...this.views.keys()]) this.#destroyView(accountId);
  }

  async #flushAccountStorage() {
    if (!this.userId) return;
    const accounts = [
      ...this.registry.list(this.userId),
      ...this.registry.list(this.userId, { archived: true }),
    ];
    await Promise.allSettled(accounts.map(async (account) => {
      try {
        await session.fromPartition(account.partition).flushStorageData();
      } catch (error) {
        this.#writeDiagnostic(account.id, 'partition_flush_failed', {
          error: error?.message || String(error),
        }, 'warn');
      }
    }));
  }

  #scheduleBackgroundAccountLoads() {
    if (!this.userId) return;
    for (const account of this.registry.list(this.userId)) {
      if (
        account.paused
        || account.archivedAt
        || this.views.has(account.id)
        || this.queuedBackgroundAccounts.has(account.id)
      ) continue;
      this.backgroundLoadQueue.push(account.id);
      this.queuedBackgroundAccounts.add(account.id);
      this.#patchRuntime(account.id, { status: 'queued' });
      this.#writeDiagnostic(account.id, 'background_load_queued');
    }
    this.#publishState();
    this.#startBackgroundAccountLoads();
  }

  #startBackgroundAccountLoads() {
    if (this.backgroundLoadRunning || !this.backgroundLoadQueue.length) return;
    const generation = this.backgroundLoadGeneration;
    this.backgroundLoadRunning = true;
    void this.#drainBackgroundAccountLoads(generation).finally(() => {
      if (generation !== this.backgroundLoadGeneration) return;
      this.backgroundLoadRunning = false;
      if (this.backgroundLoadQueue.length) this.#startBackgroundAccountLoads();
    });
  }

  async #drainBackgroundAccountLoads(generation) {
    while (generation === this.backgroundLoadGeneration && this.backgroundLoadQueue.length) {
      await this.#waitForInitialViewLoads(generation);
      if (generation !== this.backgroundLoadGeneration) return;

      const accountId = this.backgroundLoadQueue.shift();
      this.queuedBackgroundAccounts.delete(accountId);
      const account = this.userId ? this.registry.get(this.userId, accountId) : null;
      if (!account || account.paused || account.archivedAt || this.views.has(accountId)) {
        if (this.runtime.get(accountId)?.status === 'queued') this.runtime.delete(accountId);
        continue;
      }

      this.#writeDiagnostic(accountId, 'background_load_started');
      this.#ensureView(account);
      this.#publishState();
    }
  }

  async #waitForInitialViewLoads(generation) {
    const loads = [...this.initialViewLoads.entries()];
    if (!loads.length) return;
    await Promise.all(loads.map(([accountId, loadPromise]) => new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.initialViewLoads.get(accountId) === loadPromise) {
          this.initialViewLoads.delete(accountId);
          if (this.runtime.get(accountId)?.status === 'loading') {
            this.#patchRuntime(accountId, { status: 'error', detail: '鍚庡彴椤甸潰鍔犺浇瓒呮椂' });
          }
          this.#writeDiagnostic(accountId, 'background_load_timeout', {}, 'warn');
          this.#publishState();
        }
        resolve();
      }, BACKGROUND_ACCOUNT_LOAD_TIMEOUT_MS);
      loadPromise.finally(() => {
        clearTimeout(timer);
        resolve();
      });
    })));
    if (generation !== this.backgroundLoadGeneration) return;
  }

  #dequeueBackgroundAccount(accountId) {
    if (!this.queuedBackgroundAccounts.delete(accountId)) return;
    this.backgroundLoadQueue = this.backgroundLoadQueue.filter((id) => id !== accountId);
    if (this.runtime.get(accountId)?.status === 'queued') this.runtime.delete(accountId);
  }

  #cancelBackgroundAccountLoads() {
    this.backgroundLoadGeneration += 1;
    this.backgroundLoadRunning = false;
    this.backgroundLoadQueue = [];
    for (const accountId of this.queuedBackgroundAccounts) {
      if (this.runtime.get(accountId)?.status === 'queued') this.runtime.delete(accountId);
    }
    this.queuedBackgroundAccounts.clear();
    this.initialViewLoads.clear();
  }

  #startSessionHealthMonitor() {
    if (this.sessionHealthTimer || !this.userId || this.sessionHealthCheckIntervalMs <= 0) return;
    this.sessionHealthTimer = setInterval(() => {
      void this.#runSessionHealthChecks();
    }, this.sessionHealthCheckIntervalMs);
    this.sessionHealthTimer.unref?.();
    this.#writeDiagnostic('system', 'session_health_monitor_started', {
      check_interval_ms: this.sessionHealthCheckIntervalMs,
      idle_refresh_interval_ms: this.sessionIdleRefreshIntervalMs,
    });
  }

  #stopSessionHealthMonitor() {
    if (this.sessionHealthTimer) clearInterval(this.sessionHealthTimer);
    this.sessionHealthTimer = null;
    this.sessionHealthCheckRunning = false;
    this.sessionHealthGeneration += 1;
    this.sessionHealthByAccount.clear();
  }

  #markSessionActivity(accountId, observedAt = this.now()) {
    const health = this.sessionHealthByAccount.get(accountId) || {
      lastCheckedAt: null,
      lastRefreshAt: null,
      refreshing: false,
    };
    health.lastActivityAt = Math.max(health.lastActivityAt || 0, observedAt);
    this.sessionHealthByAccount.set(accountId, health);
  }

  async #runSessionHealthChecks() {
    if (this.sessionHealthCheckRunning || !this.userId) return;
    const generation = this.sessionHealthGeneration;
    this.sessionHealthCheckRunning = true;
    try {
      for (const account of this.registry.list(this.userId)) {
        if (generation !== this.sessionHealthGeneration || !this.userId) return;
        await this.#checkAccountSession(account, generation);
      }
    } finally {
      if (generation === this.sessionHealthGeneration) this.sessionHealthCheckRunning = false;
    }
  }

  async #checkAccountSession(account, generation) {
    if (generation !== this.sessionHealthGeneration) return;
    const checkedAt = this.now();
    const previous = this.sessionHealthByAccount.get(account.id) || {};
    const health = {
      lastActivityAt: previous.lastActivityAt || checkedAt,
      lastCheckedAt: checkedAt,
      lastRefreshAt: previous.lastRefreshAt || null,
      refreshing: Boolean(previous.refreshing),
    };
    this.sessionHealthByAccount.set(account.id, health);

    const view = this.views.get(account.id);
    if (account.paused || account.archivedAt || !view || view.webContents.isDestroyed()) {
      this.#writeDiagnostic(account.id, 'session_health_check_skipped', {
        reason: account.paused ? 'paused' : account.archivedAt ? 'archived' : 'view_unavailable',
      }, 'debug');
      return;
    }

    const contents = view.webContents;
    const pageStatus = this.pageClassifier(contents.getURL());
    this.#writeDiagnostic(account.id, 'session_health_checked', {
      page_status: pageStatus,
      login_status: account.loginStatus || 'unknown',
      page_path: diagnosticPagePath(contents.getURL()),
      loading: contents.isLoading(),
      actor_state: this.storeActors.get(account.id)?.state || 'idle',
      idle_for_ms: Math.max(0, checkedAt - health.lastActivityAt),
    }, 'debug');

    if (UNAVAILABLE_LOGIN_STATUSES.has(pageStatus)) {
      this.#setAccountLoginStatus(account.id, pageStatus);
      this.#writeDiagnostic(account.id, 'session_login_unavailable', {
        page_status: pageStatus,
        page_path: diagnosticPagePath(contents.getURL()),
      }, 'warn');
      return;
    }
    if (pageStatus !== 'online' || account.loginStatus !== 'online') {
      this.#writeDiagnostic(account.id, 'session_idle_refresh_skipped', {
        reason: pageStatus !== 'online' ? 'page_not_online' : 'login_not_online',
      }, 'debug');
      return;
    }
    if (health.refreshing || contents.isLoading()) {
      this.#writeDiagnostic(account.id, 'session_idle_refresh_skipped', {
        reason: health.refreshing ? 'refresh_in_progress' : 'page_loading',
      }, 'debug');
      return;
    }

    const actor = this.storeActors.get(account.id);
    if (actor && actor.state !== 'idle' && actor.state !== 'cancelled') {
      this.#writeDiagnostic(account.id, 'session_idle_refresh_skipped', {
        reason: 'store_actor_busy',
        actor_state: actor.state,
      }, 'debug');
      return;
    }
    if (checkedAt - health.lastActivityAt < this.sessionIdleRefreshIntervalMs) return;
    if (health.lastRefreshAt && checkedAt - health.lastRefreshAt < this.sessionIdleRefreshIntervalMs) return;
    if (generation !== this.sessionHealthGeneration) return;

    await this.#getStoreActor(account)
      .enqueue(
        'session_refresh',
        () => this.#refreshIdleAccountPage(account, view),
        { coalesceKey: 'session_refresh', rescanAfter: false },
      )
      .catch((error) => {
        this.#writeDiagnostic(account.id, 'session_idle_refresh_failed', {
          error: error?.message || String(error),
        }, 'warn');
      });
  }

  async #refreshIdleAccountPage(account, view) {
    const health = this.sessionHealthByAccount.get(account.id);
    if (!health || health.refreshing) return;
    if (this.views.get(account.id) !== view || view.webContents.isDestroyed()) return;

    const contents = view.webContents;
    if (contents.isLoading() || this.pageClassifier(contents.getURL()) !== 'online') return;
    health.refreshing = true;
    this.#writeDiagnostic(account.id, 'session_idle_refresh_started', {
      page_path: diagnosticPagePath(contents.getURL()),
      idle_for_ms: Math.max(0, this.now() - health.lastActivityAt),
    });
    try {
      const loadCompleted = this.#waitForSessionRefresh(contents);
      contents.reload();
      await loadCompleted;
      const completedAt = this.now();
      health.lastRefreshAt = completedAt;
      health.lastActivityAt = completedAt;
      this.#writeDiagnostic(account.id, 'session_idle_refresh_completed', {
        page_path: diagnosticPagePath(contents.getURL()),
      });
    } finally {
      health.refreshing = false;
    }
  }

  #waitForSessionRefresh(contents) {
    return new Promise((resolve, reject) => {
      let mainFrameFailed = null;
      const cleanup = () => {
        clearTimeout(timer);
        contents.removeListener('did-fail-load', onFailed);
        contents.removeListener('did-stop-loading', onStopped);
        contents.removeListener('render-process-gone', onGone);
      };
      const onFailed = (_event, errorCode, errorDescription, _url, isMainFrame) => {
        if (isMainFrame && errorCode !== -3) mainFrameFailed = new Error(errorDescription);
      };
      const onStopped = () => {
        cleanup();
        if (mainFrameFailed) reject(mainFrameFailed);
        else resolve();
      };
      const onGone = (_event, details) => {
        cleanup();
        reject(new Error('PDD page renderer process gone: ' + details.reason));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('搴楅摵椤甸潰淇濇椿鍒锋柊瓒呮椂'));
      }, this.sessionRefreshTimeoutMs);
      contents.on('did-fail-load', onFailed);
      contents.once('did-stop-loading', onStopped);
      contents.once('render-process-gone', onGone);
    });
  }

  #ensureView(account) {
    const existing = this.views.get(account.id);
    if (existing && !existing.webContents.isDestroyed()) return existing;

    const view = new WebContentsView({
      webPreferences: {
        partition: account.partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        ...(this.pddPreloadPath ? { preload: this.pddPreloadPath } : {}),
        additionalArguments: [serializedSelectorArgument(this.collectorRules)],
      },
    });
    view.setBackgroundColor('#ffffff');
    view.setVisible(false);
    view.webContents.setBackgroundThrottling(false);
    this.views.set(account.id, view);
    this.#markSessionActivity(account.id);
    this.#createCollector(account.id);
    this.window.contentView.addChildView(view);
    this.#configureSession(view.webContents.session, account.id);
    this.#bindViewEvents(account.id, view);
    this.#layoutViews();

    this.#patchRuntime(account.id, { status: 'loading' });
    this.#writeDiagnostic(account.id, 'view_created', {
      page_path: this.homeUrl,
      partition: account.partition,
    });
    const initialLoad = view.webContents.loadURL(this.homeUrl).catch((error) => {
      if (this.views.get(account.id) !== view) return;
      this.#patchRuntime(account.id, { status: 'error', detail: error.message });
      this.#writeDiagnostic(account.id, 'view_load_rejected', {
        error: error.message,
      }, 'error');
      this.#publishState();
    }).finally(() => {
      if (this.initialViewLoads.get(account.id) === initialLoad) {
        this.initialViewLoads.delete(account.id);
      }
    });
    this.initialViewLoads.set(account.id, initialLoad);
    return view;
  }

  #configureSession(accountSession, accountId = null) {
    if (accountId) this.webRequestAccountsByPartition.set(accountSession.partition, accountId);
    if (this.configuredPartitions.has(accountSession.partition)) return;
    this.configuredPartitions.add(accountSession.partition);
    accountSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    accountSession.setPermissionCheckHandler(() => false);
    accountSession.on('will-download', (event) => event.preventDefault());
    this.#configureImageUploadWebRequestDiagnostics(accountSession);
  }

  #configureImageUploadWebRequestDiagnostics(accountSession) {
    const requestFilter = { urls: ['http://*/*', 'https://*/*'] };
    const accountIdForSession = () => this.webRequestAccountsByPartition.get(accountSession.partition) || 'unknown';

    accountSession.webRequest.onBeforeRequest(requestFilter, (details, callback) => {
      if (!isPddImageUploadWebRequest(details)) {
        callback({ cancel: false });
        return;
      }
      const accountId = accountIdForSession();
      this.pendingImageUploadWebRequests.set(details.id, {
        accountId,
        observedAt: this.now(),
        method: details.method,
        urlSummary: diagnosticUrlSummary(details.url),
      });
      this.#pruneImageUploadWebRequestDiagnostics();
      this.#writeDiagnostic(accountId, 'web_request_image_upload_request', {
        request_id: details.id,
        partition: accountSession.partition,
        method: details.method,
        resource_type: details.resourceType || null,
        url: diagnosticUrlSummary(details.url),
        upload_data: summarizeUploadData(details.uploadData),
      }, 'debug');
      callback({ cancel: false });
    });

    accountSession.webRequest.onBeforeSendHeaders(requestFilter, (details, callback) => {
      const tracked = this.pendingImageUploadWebRequests.get(details.id);
      if (!tracked && !isPddImageUploadWebRequest(details)) {
        callback({ requestHeaders: details.requestHeaders });
        return;
      }
      const accountId = tracked?.accountId || accountIdForSession();
      if (!tracked) {
        this.pendingImageUploadWebRequests.set(details.id, {
          accountId,
          observedAt: this.now(),
          method: details.method,
          urlSummary: diagnosticUrlSummary(details.url),
        });
        this.#pruneImageUploadWebRequestDiagnostics();
      }
      this.#writeDiagnostic(accountId, 'web_request_image_upload_headers', {
        request_id: details.id,
        partition: accountSession.partition,
        method: details.method,
        resource_type: details.resourceType || null,
        url: diagnosticUrlSummary(details.url),
        request_headers: summarizeWebRequestHeaders(details.requestHeaders),
      }, 'debug');
      callback({ requestHeaders: details.requestHeaders });
    });

    accountSession.webRequest.onCompleted(requestFilter, (details) => {
      const tracked = this.pendingImageUploadWebRequests.get(details.id);
      if (!tracked && !isPddImageUploadWebRequest(details)) return;
      const accountId = tracked?.accountId || accountIdForSession();
      this.#writeDiagnostic(accountId, 'web_request_image_upload_completed', {
        request_id: details.id,
        partition: accountSession.partition,
        method: details.method,
        resource_type: details.resourceType || null,
        url: diagnosticUrlSummary(details.url),
        status_code: details.statusCode,
        from_cache: Boolean(details.fromCache),
        response_headers: summarizeWebRequestHeaders(details.responseHeaders),
      }, 'debug');
      this.pendingImageUploadWebRequests.delete(details.id);
    });

    accountSession.webRequest.onErrorOccurred(requestFilter, (details) => {
      const tracked = this.pendingImageUploadWebRequests.get(details.id);
      if (!tracked && !isPddImageUploadWebRequest(details)) return;
      const accountId = tracked?.accountId || accountIdForSession();
      this.#writeDiagnostic(accountId, 'web_request_image_upload_failed', {
        request_id: details.id,
        partition: accountSession.partition,
        method: details.method,
        resource_type: details.resourceType || null,
        url: diagnosticUrlSummary(details.url),
        error: details.error || null,
      }, 'warn');
      this.pendingImageUploadWebRequests.delete(details.id);
    });
  }

  #pruneImageUploadWebRequestDiagnostics() {
    const cutoff = this.now() - WEB_REQUEST_UPLOAD_DIAGNOSTIC_TTL_MS;
    for (const [requestId, request] of this.pendingImageUploadWebRequests.entries()) {
      if ((request?.observedAt || 0) < cutoff) {
        this.pendingImageUploadWebRequests.delete(requestId);
      }
    }
  }

  #configureImageUploadDevtoolsDiagnostics(accountId, contents) {
    if (!contents || contents.isDestroyed() || this.imageUploadDevtoolsContents.has(contents.id)) return;
    const contentsId = contents.id;
    this.imageUploadDevtoolsContents.add(contentsId);
    try {
      if (!contents.debugger.isAttached()) {
        contents.debugger.attach('1.3');
      }
      contents.debugger.sendCommand('Network.enable', {
        maxPostDataSize: 1024 * 1024,
      }).catch((error) => {
        this.#writeDiagnostic(accountId, 'devtools_image_upload_network_enable_failed', {
          error: error?.message || String(error),
        }, 'warn');
      });
      this.#writeDiagnostic(accountId, 'devtools_image_upload_diagnostics_started', {
        web_contents_id: contentsId,
      }, 'debug');
    } catch (error) {
      this.imageUploadDevtoolsContents.delete(contentsId);
      this.#writeDiagnostic(accountId, 'devtools_image_upload_diagnostics_start_failed', {
        web_contents_id: contentsId,
        error: error?.message || String(error),
      }, 'warn');
      return;
    }

    const requestKey = (requestId) => String(contentsId) + ':' + requestId;
    const cleanupContentRequests = () => {
      for (const key of this.pendingImageUploadDevtoolsRequests.keys()) {
        if (key.startsWith(String(contentsId) + ':')) this.pendingImageUploadDevtoolsRequests.delete(key);
      }
      this.imageUploadDevtoolsContents.delete(contentsId);
    };

    const summarizePostData = (postData) => {
      const json = parseJsonObject(postData);
      if (!json) {
        return {
          body_kind: typeof postData === 'string' ? 'text' : 'unknown',
          text_length: typeof postData === 'string' ? postData.length : 0,
          json_shape: null,
        };
      }
      return {
        body_kind: 'json',
        text_length: typeof postData === 'string' ? postData.length : null,
        json_shape: summarizeJsonShape(json, { includeStringPreview: false, maxNodes: 100 }),
      };
    };

    const captureRequestPostData = async (requestId, request) => {
      if (request?.postData) return summarizePostData(request.postData);
      try {
        const payload = await contents.debugger.sendCommand('Network.getRequestPostData', { requestId });
        return summarizePostData(payload?.postData || '');
      } catch (error) {
        return {
          body_kind: request?.hasPostData ? 'unavailable' : 'empty',
          json_shape: null,
          error: request?.hasPostData ? (error?.message || String(error)).slice(0, 256) : null,
        };
      }
    };

    const onMessage = (_event, method, params = {}) => {
      if (contents.isDestroyed()) return;
      if (method === 'Network.requestWillBeSent') {
        const request = params.request || {};
        if (!isPddStoreImageUrl(request.url)) return;
        const key = requestKey(params.requestId);
        this.pendingImageUploadDevtoolsRequests.set(key, {
          accountId,
          requestId: params.requestId,
          url: request.url,
          method: request.method,
          observedAt: this.now(),
        });
        this.#pruneImageUploadDevtoolsRequests();
        captureRequestPostData(params.requestId, request).then((postDataSummary) => {
          this.#writeDiagnostic(accountId, 'devtools_image_store_request_template', {
            request_id: params.requestId,
            web_contents_id: contentsId,
            url: diagnosticUrlSummary(request.url),
            method: request.method || null,
            resource_type: params.type || null,
            has_post_data: Boolean(request.hasPostData || request.postData),
            request_headers: summarizeWebRequestHeaders(request.headers),
            post_data: postDataSummary,
          }, 'debug');
        }).catch((error) => {
          this.#writeDiagnostic(accountId, 'devtools_image_store_request_template_failed', {
            request_id: params.requestId,
            error: error?.message || String(error),
          }, 'warn');
        });
        return;
      }
      if (method === 'Network.responseReceived') {
        const key = requestKey(params.requestId);
        const tracked = this.pendingImageUploadDevtoolsRequests.get(key);
        if (!tracked) return;
        const response = params.response || {};
        this.pendingImageUploadDevtoolsRequests.set(key, {
          ...tracked,
          status: response.status,
          mimeType: response.mimeType || null,
          responseHeaders: response.headers || {},
        });
        return;
      }
      if (method === 'Network.loadingFinished') {
        const key = requestKey(params.requestId);
        const tracked = this.pendingImageUploadDevtoolsRequests.get(key);
        if (!tracked) return;
        contents.debugger.sendCommand('Network.getResponseBody', {
          requestId: params.requestId,
        }).then((payload) => {
          const rawBody = payload?.base64Encoded
            ? Buffer.from(String(payload.body || ''), 'base64').toString('utf8')
            : String(payload?.body || '');
          const bodyPreview = rawBody.slice(0, IMAGE_STORE_DEVTOOLS_RESPONSE_BODY_LIMIT);
          this.#writeDiagnostic(tracked.accountId || accountId, 'devtools_image_store_response_template', {
            request_id: params.requestId,
            web_contents_id: contentsId,
            url: diagnosticUrlSummary(tracked.url),
            status_code: Number(tracked.status) || null,
            mime_type: tracked.mimeType || null,
            response_headers: summarizeWebRequestHeaders(tracked.responseHeaders),
            encoded_data_length: Number(params.encodedDataLength) || null,
            body_length: rawBody.length,
            body_truncated: rawBody.length > IMAGE_STORE_DEVTOOLS_RESPONSE_BODY_LIMIT,
            response: summarizeStoreImageResponseJson(bodyPreview),
          }, 'debug');
        }).catch((error) => {
          this.#writeDiagnostic(tracked.accountId || accountId, 'devtools_image_store_response_template_failed', {
            request_id: params.requestId,
            url: diagnosticUrlSummary(tracked.url),
            error: error?.message || String(error),
          }, 'warn');
        }).finally(() => {
          this.pendingImageUploadDevtoolsRequests.delete(key);
        });
        return;
      }
      if (method === 'Network.loadingFailed') {
        const key = requestKey(params.requestId);
        const tracked = this.pendingImageUploadDevtoolsRequests.get(key);
        if (!tracked) return;
        this.#writeDiagnostic(tracked.accountId || accountId, 'devtools_image_store_failed', {
          request_id: params.requestId,
          url: diagnosticUrlSummary(tracked.url),
          error: params.errorText || null,
          canceled: Boolean(params.canceled),
        }, 'warn');
        this.pendingImageUploadDevtoolsRequests.delete(key);
      }
    };

    const onDetach = (_event, reason) => {
      cleanupContentRequests();
      this.#writeDiagnostic(accountId, 'devtools_image_upload_diagnostics_detached', {
        web_contents_id: contentsId,
        reason: reason || null,
      }, 'debug');
    };

    contents.debugger.on('message', onMessage);
    contents.debugger.on('detach', onDetach);
    const cleanupDebugger = ({ skipDebugger = false } = {}) => {
      const storedCleanup = this.imageUploadDevtoolsCleanups.get(contentsId);
      if (storedCleanup !== cleanupDebugger) return;
      this.imageUploadDevtoolsCleanups.delete(contentsId);
      if (!skipDebugger && !contents.isDestroyed()) {
        try {
          contents.debugger.off('message', onMessage);
          contents.debugger.off('detach', onDetach);
        } catch {
          // The WebContents may already be tearing down.
        }
      }
      cleanupContentRequests();
    };
    this.imageUploadDevtoolsCleanups.set(contentsId, cleanupDebugger);
    contents.once('destroyed', () => cleanupDebugger({ skipDebugger: true }));
  }

  #pruneImageUploadDevtoolsRequests() {
    const cutoff = this.now() - WEB_REQUEST_UPLOAD_DIAGNOSTIC_TTL_MS;
    for (const [key, request] of this.pendingImageUploadDevtoolsRequests.entries()) {
      if ((request?.observedAt || 0) < cutoff) {
        this.pendingImageUploadDevtoolsRequests.delete(key);
      }
    }
  }

  #bindViewEvents(accountId, view) {
    const contents = view.webContents;
    this.#configureImageUploadDevtoolsDiagnostics(accountId, contents);
    const viewEventHandlers = [];
    const on = (eventName, handler) => {
      contents.on(eventName, handler);
      viewEventHandlers.push([eventName, handler]);
    };
    const isCurrentView = () => this.views.get(accountId) === view && !contents.isDestroyed();
    const cleanupEvents = ({ skipContents = false } = {}) => {
      if (this.viewEventCleanups.get(accountId) !== cleanupEvents) return;
      this.viewEventCleanups.delete(accountId);
      if (skipContents || contents.isDestroyed()) return;
      for (const [eventName, handler] of viewEventHandlers) {
        contents.removeListener(eventName, handler);
      }
      contents.removeListener('destroyed', onDestroyed);
      contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    };
    const onDestroyed = () => cleanupEvents({ skipContents: true });
    this.viewEventCleanups.set(accountId, cleanupEvents);
    contents.once('destroyed', onDestroyed);
    let mainFrameLoadFailed = false;
    const setStatus = (status, detail) => {
      if (!isCurrentView()) return;
      this.#patchRuntime(accountId, { status, detail });
      this.#publishState();
    };

    on('did-start-loading', () => {
      if (!isCurrentView()) return;
      this.#markSessionActivity(accountId);
      mainFrameLoadFailed = false;
      setStatus('loading');
      this.#writeDiagnostic(accountId, 'view_load_started', {
        page_path: diagnosticPagePath(contents.getURL()),
      });
    });
    on('did-stop-loading', () => {
      if (!isCurrentView()) return;
      if (!mainFrameLoadFailed) {
        setStatus('ready');
        this.#updateLoginStatus(accountId, contents.getURL());
        contents.send('pdd-adapter:command', { type: 'scan' });
        this.#writeDiagnostic(accountId, 'view_load_stopped', {
          page_path: diagnosticPagePath(contents.getURL()),
        });
      }
    });
    on('did-fail-load', (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
      if (!isCurrentView()) return;
      if (isMainFrame && errorCode !== -3) {
        mainFrameLoadFailed = true;
        setStatus('error', errorDescription);
        this.#setAccountLoginStatus(accountId, 'error');
        this.#writeDiagnostic(accountId, 'view_load_failed', {
          error_code: errorCode,
          error: errorDescription,
        }, 'error');
      }
    });
    on('render-process-gone', (_event, details) => {
      if (this.views.get(accountId) !== view) return;
      setStatus('error', details.reason);
      this.#writeDiagnostic(accountId, 'view_render_process_gone', {
        reason: details.reason,
        exit_code: details.exitCode,
      }, 'error');
    });
    on('did-navigate', (_event, url) => {
      if (!isCurrentView()) return;
      this.#markSessionActivity(accountId);
      this.#updateLoginStatus(accountId, url);
      this.#writeDiagnostic(accountId, 'view_navigated', {
        page_path: diagnosticPagePath(url),
      });
      this.#publishState();
    });
    on('did-navigate-in-page', (_event, url) => {
      if (!isCurrentView()) return;
      this.#markSessionActivity(accountId);
      this.#updateLoginStatus(accountId, url);
      this.#writeDiagnostic(accountId, 'view_navigated_in_page', {
        page_path: diagnosticPagePath(url),
      });
      this.#publishState();
    });
    on('ipc-message', (_event, channel, payload) => {
      if (!isCurrentView()) return;
      if (channel !== 'pdd-adapter:event') return;
      if (payload?.type === 'diagnostic') {
        this.diagnosticLogger?.write(accountId, payload);
        return;
      }
      if (payload?.type === 'page_activity') {
        const observedAt = Date.parse(payload.observed_at || '');
        this.#markSessionActivity(accountId, Number.isFinite(observedAt) ? observedAt : this.now());
        return;
      }
      if (payload?.type === 'account_name_detection') {
        const pending = this.pendingNameDetections.get(payload.request_id);
        if (!pending || pending.accountId !== accountId) return;
        clearTimeout(pending.timer);
        this.pendingNameDetections.delete(payload.request_id);
        const accountName = detectedAlias(payload.account_name);
        const source = [
          'dom',
          'document_title',
          'pdd_api_latest_conversations',
          'pdd_api_custom_service_info',
          'pdd_api_userinfo_realtime',
          'pdd_api_shop_info',
        ].includes(payload.source) ? payload.source : null;
        const diagnostics = payload.diagnostics && typeof payload.diagnostics === 'object'
          ? payload.diagnostics
          : {};
        this.#writeDiagnostic(accountId, 'account_name_detection_received', {
          detected: Boolean(accountName && source),
          source,
          detected_name_length: accountName?.length || 0,
          error: payload.error || null,
          diagnostics,
        });
        pending.resolve({
          accountName: accountName || null,
          source,
          error: payload.error || null,
          diagnostics,
        });
        return;
      }
      if (payload?.type === 'api_latest_conversations_result') {
        const pending = this.pendingConversationLists.get(payload.request_id);
        if (!pending || pending.accountId !== accountId) {
          if (payload.purpose !== 'latest-unread-poll') return;
          if (payload.status !== 'collected' || !payload.response) {
            this.#writeDiagnostic(accountId, 'api_latest_unread_poll_failed', {
              request_id: payload.request_id || null,
              error: payload.error || null,
              diagnostics: payload.diagnostics || {},
            }, 'warn');
            return;
          }
          try {
            const snapshot = mapLatestConversationsResponse(payload.response, payload.observed_at);
            const candidates = this.#latestSnapshotToCandidates(snapshot);
            const unreadCount = candidates.filter((candidate) => Number(candidate.unread_count || 0) > 0).length;
            const potentialBackfillCount = candidates.filter((candidate) => (
              this.#hasPotentialLatestMessageBackfill(accountId, candidate)
            )).length;
            this.#writeDiagnostic(accountId, 'api_latest_unread_poll_received', {
              request_id: payload.request_id || null,
              candidate_count: candidates.length,
              unread_count: unreadCount,
              potential_backfill_count: potentialBackfillCount,
              unread_customer_uids: candidates
                .filter((candidate) => Number(candidate.unread_count || 0) > 0)
                .map((candidate) => candidate.conversation_key)
                .filter(Boolean)
                .slice(0, 20),
              diagnostics: payload.diagnostics || {},
            }, potentialBackfillCount > 0 ? 'info' : 'debug');
            if (potentialBackfillCount > 0) {
              this.#enqueueLatestConversationUnreadBackfill(
                accountId,
                'latest_conversations_poll',
                payload.diagnostics || {},
                candidates,
                { forceBackfill: true },
              );
            }
          } catch (error) {
            this.#writeDiagnostic(accountId, 'api_latest_unread_poll_mapping_failed', {
              request_id: payload.request_id || null,
              error: error?.message || String(error),
            }, 'error');
          }
          return;
        }
        clearTimeout(pending.timer);
        this.pendingConversationLists.delete(payload.request_id);
        if (payload.status !== 'collected' || !payload.response) {
          this.#writeDiagnostic(accountId, 'api_latest_conversations_candidates_failed', {
            request_id: payload.request_id || null,
            purpose: payload.purpose || null,
            error: payload.error || null,
            diagnostics: payload.diagnostics || {},
          }, 'warn');
          pending.resolve([]);
          return;
        }
        try {
          const snapshot = mapLatestConversationsResponse(payload.response, payload.observed_at);
          const candidates = this.#latestSnapshotToCandidates(snapshot);
          this.#writeDiagnostic(accountId, 'api_latest_conversations_candidates_succeeded', {
            request_id: payload.request_id || null,
            conversation_count: candidates.length,
            summary: summarizeMappedSnapshot(snapshot),
          });
          pending.resolve(candidates);
        } catch (error) {
          this.#writeDiagnostic(accountId, 'api_latest_conversations_candidates_mapping_failed', {
            request_id: payload.request_id || null,
            error: error?.message || String(error),
          }, 'error');
          pending.resolve([]);
        }
        return;
      }
      if (payload?.type === 'conversation_candidates') {
        const pending = this.pendingConversationLists.get(payload.request_id);
        if (!pending || pending.accountId !== accountId) return;
        clearTimeout(pending.timer);
        this.pendingConversationLists.delete(payload.request_id);
        pending.resolve(Array.isArray(payload.conversations) ? payload.conversations : []);
        return;
      }
      if (payload?.type === 'conversation_collection_result') {
        const pending = this.pendingConversationCollections.get(payload.request_id);
        if (!pending || pending.accountId !== accountId) return;
        clearTimeout(pending.timer);
        this.pendingConversationCollections.delete(payload.request_id);
        pending.resolve(payload);
        return;
      }
      if (payload?.type === 'conversation_switch_result') {
        const pending = this.pendingConversationCollections.get(payload.request_id);
        if (!pending || pending.accountId !== accountId) return;
        clearTimeout(pending.timer);
        this.pendingConversationCollections.delete(payload.request_id);
        pending.resolve(payload);
        return;
      }
      if (payload?.type === 'api_customer_orders_result') {
        const pending = this.pendingCustomerOrderCollections.get(payload.request_id);
        if (!pending || pending.accountId !== accountId) return;
        clearTimeout(pending.timer);
        this.pendingCustomerOrderCollections.delete(payload.request_id);
        void (async () => {
          if (payload.status !== 'collected' || !payload.response) {
            this.#writeDiagnostic(accountId, 'api_customer_orders_import_failed', {
              request_id: payload.request_id || null,
              conversation_key: payload.conversation_key || null,
              customer_uid: payload.customer_uid || null,
              error: payload.error || null,
              diagnostics: payload.diagnostics || {},
            }, 'warn');
            pending.resolve({
              status: payload.status || 'failed',
              conversation_key: payload.conversation_key || null,
              customer_name: payload.customer_name || null,
              error: payload.error || null,
            });
            return;
          }
          try {
            const snapshot = mapPddUserAllOrderResponse(payload.response, {
              customerUid: payload.customer_uid || payload.conversation_key || null,
              customerName: payload.customer_name || null,
            }, payload.observed_at);
            const conversation = snapshot.conversations[0] || null;
            const orderPayload = conversation?.customer_orders || {};
            const orderCount = Array.isArray(orderPayload.orders) ? orderPayload.orders.length : 0;
            const { ingested, events } = this.#ingestRuntimeSnapshot(accountId, snapshot);
            const directResult = await this.#ingestEventsDirect(accountId, events, { required: true });
            const ok = ingested && directResult.ok;
            this.#writeDiagnostic(accountId, 'api_customer_orders_import_succeeded', {
              request_id: payload.request_id || null,
              conversation_key: payload.conversation_key || null,
              customer_uid: payload.customer_uid || null,
              collection_status: orderPayload.collection_status || null,
              order_count: orderCount,
              total_count: Number(orderPayload.page_summary?.total_count) || orderCount,
              runtime_ingested: Boolean(ingested),
              emitted_event_count: events.length,
              direct_ingest_ok: Boolean(directResult.ok),
            }, ok ? 'info' : 'warn');
            pending.resolve({
              status: ok ? 'collected' : 'failed',
              method: 'api_user_all_order',
              conversation_key: payload.conversation_key || payload.customer_uid || null,
              customer_name: payload.customer_name || null,
              collection_status: orderPayload.collection_status || null,
              order_count: orderCount,
              direct_ingested: Boolean(directResult.ok),
              error: ok ? null : directResult.error || 'runtime_ingest_failed',
            });
          } catch (error) {
            this.#writeDiagnostic(accountId, 'api_customer_orders_mapping_failed', {
              request_id: payload.request_id || null,
              conversation_key: payload.conversation_key || null,
              customer_uid: payload.customer_uid || null,
              error: error?.message || String(error),
            }, 'error');
            pending.resolve({
              status: 'failed',
              conversation_key: payload.conversation_key || null,
              customer_name: payload.customer_name || null,
              error: error?.message || String(error),
            });
          }
        })();
        return;
      }
      if (payload?.type === 'api_customer_products_result') {
        const pending = this.pendingCustomerProductCollections.get(payload.request_id);
        if (!pending || pending.accountId !== accountId) return;
        clearTimeout(pending.timer);
        this.pendingCustomerProductCollections.delete(payload.request_id);
        void (async () => {
          if (payload.status !== 'collected' || !payload.response) {
            this.#writeDiagnostic(accountId, 'api_customer_products_import_failed', {
              request_id: payload.request_id || null,
              conversation_key: payload.conversation_key || null,
              customer_uid: payload.customer_uid || null,
              error: payload.error || null,
              diagnostics: payload.diagnostics || {},
            }, 'warn');
            pending.resolve({
              status: payload.status || 'failed',
              conversation_key: payload.conversation_key || null,
              customer_name: payload.customer_name || null,
              error: payload.error || null,
              products: [],
            });
            return;
          }
          try {
            const hasCustomerUid = Boolean(payload.customer_uid || payload.conversation_key);
            if (!hasCustomerUid || payload.conversation_key === 'shop') {
              const account = this.registry.get(this.userId, accountId);
              if (!account || !account.platformAccountId) {
                const error = 'PDD account unavailable';
                this.#writeDiagnostic(accountId, 'api_customer_products_import_failed', {
                  request_id: payload.request_id || null,
                  conversation_key: payload.conversation_key || 'shop',
                  customer_uid: payload.customer_uid || null,
                  error,
                  reason: 'account_registry_lookup_failed',
                }, 'error');
                pending.resolve({
                  status: 'failed',
                  conversation_key: payload.conversation_key || 'shop',
                  customer_name: payload.customer_name || null,
                  error,
                  products: [],
                });
                return;
              }
              const mapped = mapPddRecommendGoodsResponse(payload.response, payload.observed_at);
              const storeProductsPayload = {
                collection_status: mapped.collection_status || 'unavailable',
                observed_at: mapped.observed_at || new Date().toISOString(),
                products: mapped.products,
                page_summary: {
                  total_count: Number(mapped.total_count) || mapped.products.length,
                  has_more: mapped.has_more === true,
                },
                ...(mapped.error ? { error: mapped.error } : {}),
              };
              const storeProductsDedup = [
                account.platformAccountId,
                storeProductsPayload.collection_status,
                storeProductsPayload.page_summary.total_count,
                storeProductsPayload.products,
              ];
              const storeProductsEventKey = `pinduoduo:${account.platformAccountId}:store-products:${digestPayload(storeProductsDedup)}`;
              const storeProductsEvent = {
                event_id: `pdd_${digestPayload(storeProductsEventKey)}`,
                dedup_key: storeProductsEventKey,
                event_type: 'store_products_snapshot',
                platform_code: 'pinduoduo',
                platform_account_id: account.platformAccountId,
                received_at: storeProductsPayload.observed_at,
                payload_json: {
                  source: 'pdd_api_recommend_goods',
                  ...storeProductsPayload,
                },
              };
              const directResult = await this.#ingestEventsDirect(
                accountId,
                [storeProductsEvent],
                { required: true },
              );
              const directOk = directResult.ok;
              this.#writeDiagnostic(accountId, 'api_customer_products_import_succeeded', {
                request_id: payload.request_id || null,
                conversation_key: payload.conversation_key || null,
                customer_uid: payload.customer_uid || null,
                collection_status: mapped.collection_status || null,
                product_count: mapped.products.length,
                total_count: Number(mapped.total_count) || mapped.products.length,
                shop_level: true,
                emitted_event_count: 1,
                direct_ingest_attempted: Boolean(directResult.attempted),
                direct_ingest_ok: directOk,
              }, directOk && (mapped.collection_status === 'success' || mapped.collection_status === 'empty') ? 'info' : 'warn');
              pending.resolve({
                status: directOk && mapped.collection_status !== 'unavailable' ? 'collected' : 'failed',
                method: 'api_recommend_goods',
                conversation_key: payload.conversation_key || 'shop',
                customer_name: payload.customer_name || null,
                collection_status: mapped.collection_status || null,
                observed_at: mapped.observed_at || null,
                total_count: Number(mapped.total_count) || mapped.products.length,
                has_more: mapped.has_more === true,
                products: mapped.products,
                direct_ingested: directOk,
                error: directOk ? mapped.error || null : directResult.error || mapped.error || 'runtime_ingest_failed',
              });
              return;
            }
            const snapshot = mapPddRecommendGoodsSnapshot(payload.response, {
              customerUid: payload.customer_uid || payload.conversation_key || null,
              customerName: payload.customer_name || null,
            }, payload.observed_at);
            const conversation = snapshot.conversations[0] || null;
            const productPayload = conversation?.customer_products || {};
            const products = Array.isArray(productPayload.products) ? productPayload.products : [];
            const { ingested, events } = this.#ingestRuntimeSnapshot(accountId, snapshot);
            const directResult = await this.#ingestEventsDirect(accountId, events, { required: true });
            const ok = ingested && directResult.ok;
            this.#writeDiagnostic(accountId, 'api_customer_products_import_succeeded', {
              request_id: payload.request_id || null,
              conversation_key: payload.conversation_key || null,
              customer_uid: payload.customer_uid || null,
              collection_status: productPayload.collection_status || null,
              product_count: products.length,
              total_count: Number(productPayload.page_summary?.total_count) || products.length,
              runtime_ingested: Boolean(ingested),
              emitted_event_count: events.length,
              direct_ingest_ok: Boolean(directResult.ok),
            }, ok ? 'info' : 'warn');
            pending.resolve({
              status: ok ? 'collected' : 'failed',
              method: 'api_recommend_goods',
              conversation_key: payload.conversation_key || payload.customer_uid || null,
              customer_name: payload.customer_name || null,
              collection_status: productPayload.collection_status || null,
              observed_at: productPayload.observed_at || null,
              total_count: Number(productPayload.page_summary?.total_count) || products.length,
              has_more: productPayload.page_summary?.has_more === true,
              products,
              direct_ingested: Boolean(directResult.ok),
              error: ok ? null : directResult.error || productPayload.error || 'runtime_ingest_failed',
            });
          } catch (error) {
            this.#writeDiagnostic(accountId, 'api_customer_products_mapping_failed', {
              request_id: payload.request_id || null,
              conversation_key: payload.conversation_key || null,
              customer_uid: payload.customer_uid || null,
              error: error?.message || String(error),
            }, 'error');
            pending.resolve({
              status: 'failed',
              conversation_key: payload.conversation_key || null,
              customer_name: payload.customer_name || null,
              error: error?.message || String(error),
              products: [],
            });
          }
        })();
        return;
      }
      if (payload?.type === 'api_platform_phrases_result') {
        const pending = this.pendingPlatformPhraseCollections.get(payload.request_id);
        if (!pending || pending.accountId !== accountId) return;
        clearTimeout(pending.timer);
        this.pendingPlatformPhraseCollections.delete(payload.request_id);
        if (payload.status !== 'collected') {
          this.#writeDiagnostic(accountId, 'api_platform_phrases_import_failed', {
            request_id: payload.request_id || null,
            source: payload.source || null,
            error: payload.error || null,
            diagnostics: payload.diagnostics || {},
          }, 'warn');
          pending.resolve({
            status: payload.status || 'failed',
            account_id: accountId,
            source: payload.source || null,
            records: [],
            raw_count: 0,
            error: payload.error || null,
          });
          return;
        }
        const records = Array.isArray(payload.records) ? payload.records : [];
        this.#writeDiagnostic(accountId, 'api_platform_phrases_import_succeeded', {
          request_id: payload.request_id || null,
          source: payload.source || null,
          record_count: records.length,
        });
        pending.resolve({
          status: 'collected',
          account_id: accountId,
          source: payload.source || null,
          records,
          raw_count: Number(payload.raw_count) || records.length,
        });
        return;
      }
      if (payload?.type === 'api_chat_list_result') {
        const pending = this.pendingConversationCollections.get(payload.request_id);
        if (!pending || pending.accountId !== accountId) return;
        clearTimeout(pending.timer);
        this.pendingConversationCollections.delete(payload.request_id);
        void (async () => {
          if (payload.status !== 'collected' || !payload.response) {
            this.#writeDiagnostic(accountId, 'api_chat_list_import_failed', {
              request_id: payload.request_id || null,
              conversation_key: payload.conversation_key || null,
              customer_uid: payload.customer_uid || null,
              error: payload.error || null,
              diagnostics: payload.diagnostics || {},
            }, 'warn');
            pending.resolve({
              status: payload.status || 'failed',
              conversation_key: payload.conversation_key || null,
              customer_name: payload.customer_name || null,
              error: payload.error || null,
            });
            return;
          }
          try {
            const snapshot = mapChatListResponse(payload.response, {
              customerUid: payload.customer_uid || payload.conversation_key || null,
              customerName: payload.customer_name || null,
              avatarUrl: payload.avatar_url || null,
            }, payload.observed_at);
            const messageCount = snapshot.conversations.reduce(
              (total, conversation) => total + (conversation.snapshot_messages?.length || 0),
              0,
            );
            const { ingested, events } = this.#ingestRuntimeSnapshot(accountId, snapshot);
            const directResult = pending.directIngest
              ? await this.#ingestEventsDirect(accountId, events, { required: Boolean(pending.requireDirectIngest) })
              : { attempted: false, ok: true, count: 0, error: null };
            this.#writeDiagnostic(accountId, 'api_chat_list_import_succeeded', {
              request_id: payload.request_id || null,
              conversation_key: payload.conversation_key || null,
              customer_uid: payload.customer_uid || null,
              message_count: messageCount,
              has_more: Boolean(snapshot.has_more),
              summary: summarizeMappedSnapshot(snapshot),
              runtime_ingested: Boolean(ingested),
              emitted_event_count: events.length,
              direct_ingest_attempted: Boolean(directResult.attempted),
              direct_ingest_ok: Boolean(directResult.ok),
            });
            const ok = ingested && (directResult.ok || !pending.requireDirectIngest);
            pending.resolve({
              status: ok ? 'collected' : 'failed',
              method: 'api_chat_list',
              conversation_key: payload.conversation_key || payload.customer_uid || null,
              customer_name: payload.customer_name || null,
              message_count: messageCount,
              has_more: Boolean(snapshot.has_more),
              direct_ingested: Boolean(directResult.ok),
              error: ok ? null : directResult.error || 'runtime_ingest_failed',
            });
          } catch (error) {
            this.#writeDiagnostic(accountId, 'api_chat_list_mapping_failed', {
              request_id: payload.request_id || null,
              conversation_key: payload.conversation_key || null,
              customer_uid: payload.customer_uid || null,
              error: error?.message || String(error),
            }, 'error');
            pending.resolve({
              status: 'failed',
              conversation_key: payload.conversation_key || null,
              customer_name: payload.customer_name || null,
              error: error?.message || String(error),
            });
          }
        })();
        return;
      }
      if (payload?.type === 'api_product_send_result') {
        const pending = this.pendingProductSendPreparations.get(payload.request_id);
        if (!pending || pending.accountId !== accountId) return;
        clearTimeout(pending.timer);
        this.pendingProductSendPreparations.delete(payload.request_id);
        if (payload.status !== 'sent') {
          this.#writeDiagnostic(accountId, 'api_product_send_failed', {
            request_id: payload.request_id || null,
            conversation_key: payload.conversation_key || null,
            customer_uid: payload.customer_uid || null,
            product_id: payload.product_id || null,
            error: payload.error || null,
            diagnostics: payload.diagnostics || {},
          }, 'warn');
          pending.resolve({
            status: payload.status || 'failed',
            conversation_key: payload.conversation_key || null,
            customer_name: payload.customer_name || null,
            product_id: payload.product_id || null,
            error: payload.error || null,
          });
          return;
        }
        this.#markSessionActivity(accountId);
        this.#writeDiagnostic(accountId, 'api_product_send_succeeded', {
          request_id: payload.request_id || null,
          conversation_key: payload.conversation_key || null,
          customer_uid: payload.customer_uid || null,
          product_id: payload.product_id || null,
        });
        pending.resolve({
          status: 'sent',
          method: 'api_send_product',
          conversation_key: payload.conversation_key || payload.customer_uid || null,
          customer_name: payload.customer_name || null,
          product_id: payload.product_id || null,
          error: null,
        });
        return;
      }
      if (payload?.type === 'api_sync_message_result') {
        if (payload.status !== 'synced' || !payload.response) {
          this.#writeDiagnostic(accountId, 'api_sync_message_failed', {
            source: payload.source || null,
            error: payload.error || null,
            diagnostics: payload.diagnostics || {},
          }, 'warn');
          return;
        }
        try {
          const snapshot = mapSyncMessageResponse(payload.response, payload.observed_at);
          const summary = summarizeMappedSnapshot(snapshot);
          const hasSyncGap = summary.sync_gap_count > 0;
          const syncAdvanced = Boolean(payload.diagnostics?.sync_advanced);
          const shouldRefreshUnread = hasSyncGap || syncAdvanced || summary.message_count > 0;
          const ingested = summary.message_count > 0
            ? this.collectors.get(accountId)?.runtime.ingest(snapshot)
            : false;
          this.#markSessionActivity(accountId);
          this.#writeDiagnostic(accountId, 'api_sync_message_ingested', {
            source: payload.source || null,
            message_count: summary.message_count,
            conversation_count: summary.conversation_count,
            customer_uids: summary.customer_uids,
            sync_keys: summary.sync_keys,
            sync_gap_count: summary.sync_gap_count,
            sync_gap_customer_uids: summary.sync_gap_customer_uids,
            sync_advanced: syncAdvanced,
            runtime_ingested: Boolean(ingested),
          });
          this.#enqueueSyncGapBackfills(accountId, snapshot, payload.source || null);
          if (shouldRefreshUnread) {
            this.#enqueueLatestConversationUnreadBackfill(
              accountId,
              payload.source || 'sync_message',
              payload.diagnostics || {},
            );
          }
        } catch (error) {
          this.#writeDiagnostic(accountId, 'api_sync_message_mapping_failed', {
            source: payload.source || null,
            error: error?.message || String(error),
          }, 'error');
        }
        return;
      }
      if (payload?.type === 'api_message_send_result') {
        const pending = this.pendingMessagePreparations.get(payload.request_id);
        if (!pending || pending.accountId !== accountId) return;
        clearTimeout(pending.timer);
        this.pendingMessagePreparations.delete(payload.request_id);
        if (payload.status !== 'sent') {
          this.#writeDiagnostic(accountId, 'api_message_send_failed', {
            request_id: payload.request_id || null,
            conversation_key: payload.conversation_key || null,
            customer_uid: payload.customer_uid || null,
            error: payload.error || null,
            diagnostics: payload.diagnostics || {},
          }, 'warn');
          pending.resolve({
            status: payload.status || 'failed',
            conversation_key: payload.conversation_key || null,
            customer_name: payload.customer_name || null,
            error: payload.error || null,
          });
          return;
        }
        const confirmation = mapSendMessageResponse({
          success: true,
          result: {
            response: 'send_message',
            result: 'ok',
            ...(payload.result || {}),
          },
        });
        this.#markSessionActivity(accountId);
        this.#writeDiagnostic(accountId, 'api_message_send_succeeded', {
          request_id: payload.request_id || null,
          conversation_key: payload.conversation_key || null,
          customer_uid: payload.customer_uid || null,
          has_msg_id: Boolean(confirmation.msg_id),
          has_pre_msg_id: Boolean(confirmation.pre_msg_id),
          has_ts: Boolean(confirmation.ts),
        });
        pending.resolve({
          status: confirmation.success ? 'sent' : 'failed',
          method: 'api_send_message',
          conversation_key: payload.conversation_key || payload.customer_uid || null,
          customer_name: payload.customer_name || null,
          msg_id: confirmation.msg_id,
          pre_msg_id: confirmation.pre_msg_id,
          ts: confirmation.ts,
          error: confirmation.success ? null : 'send_confirmation_invalid',
        });
        return;
      }
      if (payload?.type === 'api_conversation_transfer_result') {
        const pending = this.pendingConversationTransfers.get(payload.request_id);
        if (!pending || pending.accountId !== accountId) return;
        clearTimeout(pending.timer);
        this.pendingConversationTransfers.delete(payload.request_id);
        if (payload.status !== 'transferred') {
          this.#writeDiagnostic(accountId, 'api_conversation_transfer_failed', {
            request_id: payload.request_id || null,
            conversation_key: payload.conversation_key || null,
            customer_uid: payload.customer_uid || null,
            error: payload.error || null,
            response_preview: payload.response_preview || null,
            diagnostics: payload.diagnostics || {},
          }, 'warn');
          pending.resolve({
            status: payload.status || 'failed',
            submitted: payload.submitted,
            conversation_key: payload.conversation_key || null,
            customer_name: payload.customer_name || null,
            error: payload.error || null,
            response_preview: payload.response_preview || null,
            diagnostics: payload.diagnostics || {},
          });
          return;
        }
        this.#markSessionActivity(accountId);
        this.#writeDiagnostic(accountId, 'api_conversation_transfer_succeeded', {
          request_id: payload.request_id || null,
          conversation_key: payload.conversation_key || null,
          customer_uid: payload.customer_uid || null,
          target_cs_id: payload.target_cs_id || null,
          target_cs_username: payload.target_cs_username || null,
        });
        pending.resolve({
          status: 'transferred',
          submitted: payload.submitted,
          result: payload.result,
          method: 'api_move_conversation',
          conversation_key: payload.conversation_key || payload.customer_uid || null,
          customer_name: payload.customer_name || null,
          target_cs_id: payload.target_cs_id || null,
          target_cs_username: payload.target_cs_username || null,
          target_cs_nickname: payload.target_cs_nickname || null,
          trans_reason: payload.trans_reason || null,
          error: null,
        });
        return;
      }
      if (payload?.type === 'api_transfer_cs_list_result') {
        const pending = this.pendingTransferCsLists.get(payload.request_id);
        if (!pending || pending.accountId !== accountId) return;
        clearTimeout(pending.timer);
        this.pendingTransferCsLists.delete(payload.request_id);
        if (payload.status !== 'collected') {
          this.#writeDiagnostic(accountId, 'api_transfer_cs_list_failed', {
            request_id: payload.request_id || null,
            error: payload.error || null,
            diagnostics: payload.diagnostics || {},
          }, 'warn');
          pending.resolve({
            status: payload.status || 'failed',
            cs_list: [],
            trans_reason: [],
            error: payload.error || null,
          });
          return;
        }
        this.#markSessionActivity(accountId);
        this.#writeDiagnostic(accountId, 'api_transfer_cs_list_succeeded', {
          request_id: payload.request_id || null,
          cs_count: Array.isArray(payload.cs_list) ? payload.cs_list.length : 0,
          reason_count: Array.isArray(payload.trans_reason) ? payload.trans_reason.length : 0,
        });
        pending.resolve({
          status: 'collected',
          identity_verified: payload.identity_verified === true,
          method: 'api_get_assign_cs_list',
          cs_list: Array.isArray(payload.cs_list) ? payload.cs_list : [],
          trans_reason: Array.isArray(payload.trans_reason) ? payload.trans_reason : [],
          error: null,
        });
        return;
      }
      if (payload?.type === 'api_image_send_result') {
        const pending = this.pendingImagePreparations.get(payload.request_id);
        if (!pending || pending.accountId !== accountId) return;
        clearTimeout(pending.timer);
        this.pendingImagePreparations.delete(payload.request_id);
        if (payload.status !== 'sent') {
          this.#writeDiagnostic(accountId, 'api_image_send_failed', {
            request_id: payload.request_id || null,
            conversation_key: payload.conversation_key || null,
            customer_uid: payload.customer_uid || null,
            error: payload.error || null,
            response_preview: payload.response_preview || null,
            diagnostics: payload.diagnostics || {},
          }, 'warn');
          pending.resolve({
            status: payload.status || 'failed',
            conversation_key: payload.conversation_key || null,
            customer_name: payload.customer_name || null,
            error: payload.error || null,
            response_preview: payload.response_preview || null,
            diagnostics: payload.diagnostics || {},
          });
          return;
        }
        const confirmation = mapSendMessageResponse({
          success: true,
          result: {
            response: 'send_message',
            result: 'ok',
            ...(payload.result || {}),
          },
        });
        this.#markSessionActivity(accountId);
        this.#writeDiagnostic(accountId, 'api_image_upload_succeeded', {
          request_id: payload.request_id || null,
          conversation_key: payload.conversation_key || null,
          image_url: payload.upload?.image_url || null,
          width: Number(payload.upload?.width) || null,
          height: Number(payload.upload?.height) || null,
          image_size: Number(payload.upload?.image_size) || null,
          has_hash: Boolean(payload.upload?.hash),
        });
        this.#writeDiagnostic(accountId, 'api_image_send_succeeded', {
          request_id: payload.request_id || null,
          conversation_key: payload.conversation_key || null,
          customer_uid: payload.customer_uid || null,
          has_msg_id: Boolean(confirmation.msg_id),
          has_pre_msg_id: Boolean(confirmation.pre_msg_id),
          has_ts: Boolean(confirmation.ts),
          image_url: payload.upload?.image_url || null,
        });
        pending.resolve({
          status: confirmation.success ? 'sent' : 'failed',
          method: 'api_send_image',
          conversation_key: payload.conversation_key || payload.customer_uid || null,
          customer_name: payload.customer_name || null,
          msg_id: confirmation.msg_id,
          pre_msg_id: confirmation.pre_msg_id,
          ts: confirmation.ts,
          image_url: payload.upload?.image_url || null,
          error: confirmation.success ? null : 'send_confirmation_invalid',
        });
        return;
      }
      if (payload?.type === 'collect_unread_request') {
        const account = this.registry.get(this.userId, accountId);
        if (
          !account
          || account.paused
          || account.archivedAt
          || UNAVAILABLE_LOGIN_STATUSES.has(account.loginStatus)
        ) return;
        void this.#getStoreActor(account)
          .enqueue(
            'collect_unread',
            () => this.#collectUnreadViaApiBackfill(account, payload),
            { coalesceKey: 'collect_unread' },
          )
          .catch((error) => {
            this.#writeDiagnostic(accountId, 'collect_unread_actor_failed', {
              error: error?.message || String(error),
            }, 'warn');
          });
        return;
      }
      if (payload?.type === 'rescan_requested') {
        this.storeActors.get(accountId)?.requestRescan(payload.reason || 'preload_requested');
        return;
      }
      if (payload?.type === 'scan_result') {
        const pending = this.pendingStoreScans.get(payload.request_id);
        if (!pending || pending.accountId !== accountId) return;
        clearTimeout(pending.timer);
        this.pendingStoreScans.delete(payload.request_id);
        if (payload.status === 'completed') pending.resolve(payload);
        else pending.reject(new Error('搴楅摵椤甸潰閲嶆柊鎵弿澶辫触'));
        return;
      }
      if (payload?.type === 'unread_collection_result') {
        const pending = this.pendingUnreadCollections.get(payload.request_id);
        if (!pending || pending.accountId !== accountId) return;
        clearTimeout(pending.timer);
        this.pendingUnreadCollections.delete(payload.request_id);
        if (payload.status === 'failed') pending.reject(new Error(payload.error || '璇诲彇鏈浼氳瘽澶辫触'));
        else pending.resolve(payload);
        return;
      }
      if (payload?.type === 'message_send_result') {
        const pending = this.pendingMessagePreparations.get(payload.request_id);
        if (!pending || pending.accountId !== accountId) return;
        clearTimeout(pending.timer);
        this.pendingMessagePreparations.delete(payload.request_id);
        pending.resolve(payload);
        return;
      }
      if (
        payload?.type === 'image_preparation_result'
        || payload?.type === 'image_paste_result'
        || payload?.type === 'image_send_result'
      ) {
        const pending = this.pendingImagePreparations.get(payload.request_id);
        if (!pending || pending.accountId !== accountId) return;
        clearTimeout(pending.timer);
        this.pendingImagePreparations.delete(payload.request_id);
        pending.resolve(payload);
        return;
      }
      const ingested = this.collectors.get(accountId)?.runtime.ingest(payload);
      if (!ingested) {
        this.#writeDiagnostic(accountId, 'adapter_payload_rejected', {
          payload_type: payload?.type,
          payload_version: payload?.version,
        }, 'warn');
      }
    });
    on('will-navigate', (event, navigationUrl) => {
      if (!isCurrentView()) return;
      if (!isAllowedPddUrl(navigationUrl)) event.preventDefault();
    });
    contents.setWindowOpenHandler(({ url }) => {
      if (!isCurrentView()) return { action: 'deny' };
      if (isAllowedPddUrl(url)) {
        void contents.loadURL(url);
      } else if (isSafeExternalUrl(url)) {
        void shell.openExternal(url);
      }
      return { action: 'deny' };
    });
  }

  #layoutViews() {
    if (!this.window || this.window.isDestroyed()) return;
    const [width, height] = this.window.getContentSize();
    const bounds = {
      x: 0,
      y: WORKSPACE_TOOLBAR_HEIGHT,
      width: Math.max(width, 1),
      height: Math.max(height - WORKSPACE_TOOLBAR_HEIGHT, 1),
    };
    for (const view of this.views.values()) view.setBounds(bounds);
  }

  #destroyView(accountId) {
    this.#cancelStoreActor(accountId, 'PDD page closed; task cancelled');
    this.sessionHealthByAccount.delete(accountId);
    this.verifiedAccountIdentities.delete(accountId);
    this.initialViewLoads.delete(accountId);
    const view = this.views.get(accountId);
    if (!view) return;
    const contents = view.webContents;
    this.viewEventCleanups.get(accountId)?.();
    if (!contents.isDestroyed()) this.imageUploadDevtoolsCleanups.get(contents.id)?.();
    try {
      this.window?.contentView.removeChildView(view);
    } catch {
      // The window may already be tearing down.
    }
    if (!contents.isDestroyed()) contents.close();
    this.views.delete(accountId);
    this.runtime.delete(accountId);
    this.collectors.delete(accountId);
    for (const [requestId, pending] of this.pendingNameDetections) {
      if (pending.accountId !== accountId) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error('店铺页面已关闭，无法继续识别名称'));
      this.pendingNameDetections.delete(requestId);
    }
    for (const [requestId, pending] of this.pendingConversationLists) {
      if (pending.accountId !== accountId) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error('搴楅摵椤甸潰宸插叧闂紝鏃犳硶鎵弿浼氳瘽'));
      this.pendingConversationLists.delete(requestId);
    }
    for (const [requestId, pending] of this.pendingConversationCollections) {
      if (pending.accountId !== accountId) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error('搴楅摵椤甸潰宸插叧闂紝鏃犳硶璇诲彇浼氳瘽'));
      this.pendingConversationCollections.delete(requestId);
    }
    for (const [requestId, pending] of this.pendingCustomerOrderCollections) {
      if (pending.accountId !== accountId) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error('PDD page closed; cannot read customer orders'));
      this.pendingCustomerOrderCollections.delete(requestId);
    }
    for (const [requestId, pending] of this.pendingCustomerProductCollections) {
      if (pending.accountId !== accountId) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error('PDD page closed; cannot read customer products'));
      this.pendingCustomerProductCollections.delete(requestId);
    }
    for (const [requestId, pending] of this.pendingPlatformPhraseCollections) {
      if (pending.accountId !== accountId) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error('PDD page closed; cannot read platform phrases'));
      this.pendingPlatformPhraseCollections.delete(requestId);
    }
    for (const [requestId, pending] of this.pendingMessagePreparations) {
      if (pending.accountId !== accountId) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error('PDD page closed; cannot send message'));
      this.pendingMessagePreparations.delete(requestId);
    }
    for (const [requestId, pending] of this.pendingProductSendPreparations) {
      if (pending.accountId !== accountId) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error('PDD page closed; cannot send product'));
      this.pendingProductSendPreparations.delete(requestId);
    }
    for (const [requestId, pending] of this.pendingImagePreparations) {
      if (pending.accountId !== accountId) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error('PDD page closed; cannot continue image send'));
      this.pendingImagePreparations.delete(requestId);
    }
    for (const [requestId, pending] of this.pendingTransferCsLists) {
      if (pending.accountId !== accountId) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error('PDD page closed; cannot list transfer customer service accounts'));
      this.pendingTransferCsLists.delete(requestId);
    }
    for (const [requestId, pending] of this.pendingConversationTransfers) {
      if (pending.accountId !== accountId) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error('PDD page closed; cannot transfer conversation'));
      this.pendingConversationTransfers.delete(requestId);
    }
    for (const [requestId, pending] of this.pendingStoreScans) {
      if (pending.accountId !== accountId) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error('搴楅摵椤甸潰宸插叧闂紝鏃犳硶閲嶆柊鎵弿'));
      this.pendingStoreScans.delete(requestId);
    }
    for (const [requestId, pending] of this.pendingUnreadCollections) {
      if (pending.accountId !== accountId) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error('搴楅摵椤甸潰宸插叧闂紝鏃犳硶璇诲彇鏈浼氳瘽'));
      this.pendingUnreadCollections.delete(requestId);
    }
  }

  #cancelStoreActor(accountId, reason) {
    const actor = this.storeActors.get(accountId);
    if (actor) {
      actor.cancel(reason);
      this.storeActors.delete(accountId);
    }
    this.#rejectAccountRequests(accountId, reason);
  }

  #rejectAccountRequests(accountId, reason) {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    const pendingMaps = [
      this.pendingNameDetections,
      this.pendingConversationLists,
      this.pendingConversationCollections,
      this.pendingCustomerOrderCollections,
      this.pendingCustomerProductCollections,
      this.pendingPlatformPhraseCollections,
      this.pendingMessagePreparations,
      this.pendingProductSendPreparations,
      this.pendingImagePreparations,
      this.pendingTransferCsLists,
      this.pendingConversationTransfers,
      this.pendingStoreScans,
      this.pendingUnreadCollections,
    ];
    for (const pendingMap of pendingMaps) {
      for (const [requestId, pending] of pendingMap) {
        if (pending.accountId !== accountId) continue;
        clearTimeout(pending.timer);
        pending.reject(error);
        pendingMap.delete(requestId);
      }
    }
  }

  async #waitForViewReady(contents) {
    if (!contents.isLoading()) return;
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        contents.removeListener('did-stop-loading', onLoaded);
        contents.removeListener('render-process-gone', onGone);
      };
      const onLoaded = () => {
        cleanup();
        resolve();
      };
      const onGone = () => {
        cleanup();
        reject(new Error('店铺页面加载失败'));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('店铺页面加载超时，请稍后重试'));
      }, ACCOUNT_NAME_PAGE_LOAD_TIMEOUT_MS);
      contents.once('did-stop-loading', onLoaded);
      contents.once('render-process-gone', onGone);
    });
  }

  async #clearPartition(partition) {
    const accountSession = session.fromPartition(partition);
    await accountSession.clearStorageData({
      storages: [
        'cookies',
        'filesystem',
        'indexdb',
        'localstorage',
        'serviceworkers',
        'cachestorage',
      ],
    });
    await accountSession.clearCache();
  }

  #activeWebContents() {
    const view = this.views.get(this.activeAccountId);
    return view && !view.webContents.isDestroyed() ? view.webContents : null;
  }

  #requireIdleActiveStore(action) {
    const actor = this.storeActors.get(this.activeAccountId);
    if (!actor || actor.state === 'idle' || actor.state === 'cancelled') return;
    this.#writeDiagnostic(this.activeAccountId, 'manual_navigation_blocked', {
      action,
      actor_state: actor.state,
    }, 'warn');
    throw new Error('PDD store is busy: ' + action);
  }

  #publishState() {
    if (!this.window || this.window.isDestroyed() || this.window.webContents.isDestroyed()) return;
    this.window.webContents.send('pdd-workspace:state-changed', this.getState());
  }

  #patchRuntime(accountId, updates) {
    this.runtime.set(accountId, { ...this.runtime.get(accountId), ...updates });
  }

  async sendImageData({ platformAccountId, localAccountId = null, externalConversationId, customerName, imageDataUrl, quoteMessageId = null }) {
    this.#requireUser();
    const match = String(imageDataUrl || '').trim().match(/^data:image\/(png|jpeg|jpg|webp);base64,([a-z0-9+/=\s]+)$/i);
    if (!match) {
      throw new Error('图片内容无效');
    }
    const imageFormat = match[1].toLowerCase() === 'jpg' ? 'jpeg' : match[1].toLowerCase();
    const base64Payload = match[2].replace(/\s+/g, '');
    const byteSize = Buffer.byteLength(base64Payload, 'base64');
    if (byteSize <= 0) {
      throw new Error('图片内容无效');
    }
    if (byteSize > 10 * 1024 * 1024) {
      throw new Error('图片不能超过 10 MB');
    }
    const normalizedImageDataUrl = `data:image/${imageFormat};base64,${base64Payload}`;
    const account = this.#resolveAccountForSend({
      platformAccountId,
      localAccountId,
      operation: 'send_image_data',
    });
    if (!account) throw new Error('未找到可发送图片的拼多多店铺，请确认店铺已登录且账号身份已识别');
    const image = nativeImage.createFromDataURL(normalizedImageDataUrl);
    const size = image.isEmpty() ? { width: null, height: null } : image.getSize();
    if (image.isEmpty()) {
      this.#writeDiagnostic(account.id, 'api_image_native_decode_unavailable', {
        mime_type: `image/${imageFormat}`,
        byte_size: byteSize,
        reason: 'native_image_empty',
      }, 'debug');
    }
    const imagePayload = {
      image,
      imageDataUrl: normalizedImageDataUrl,
      mimeType: `image/${imageFormat}`,
      byteSize,
      width: Number(size.width) || null,
      height: Number(size.height) || null,
    };
    return this.#getStoreActor(account).enqueue('send_image', ({ setState }) => (
      this.#sendImageNow(account, externalConversationId, customerName, imagePayload, setState, quoteMessageId)
    ));
  }

  async refreshCustomerOrders({ platformAccountId, externalConversationId, customerName }) {
    this.#requireUser();
    const account = this.registry.list(this.userId).find(
      (candidate) => candidate.platformAccountId === platformAccountId,
    );
    if (!account) throw new Error('鏈壘鍒拌鍗曞搴旂殑鎷煎澶氬簵閾猴紝璇风‘璁ゅ簵閾哄凡鐧诲綍');
    if (!externalConversationId) {
      throw new Error('PDD customer uid missing; import the conversation through latest_conversations/chat/list first.');
    }
    return this.#getStoreActor(account).enqueue('refresh_customer_orders', () => (
      this.#refreshCustomerOrdersViaApi(account, externalConversationId.slice(0, 128), customerName)
    ));
  }

  async #refreshCustomerOrdersViaApi(account, conversationKey, customerName = '') {
    if (!conversationKey || conversationKey.startsWith('name:')) {
      throw new Error('PDD customer uid missing; cannot read customer orders through userAllOrder API.');
    }
    if (!this.window || this.window.isDestroyed()) await this.#createWindow();
    const view = this.#ensureView(account);
    await this.#waitForViewReady(view.webContents);
    const requestId = randomUUID();
    this.#writeDiagnostic(account.id, 'api_customer_orders_import_requested', {
      request_id: requestId,
      conversation_key: conversationKey,
      customer_name: customerName || null,
    });
    try {
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingCustomerOrderCollections.delete(requestId);
          reject(new Error('PDD userAllOrder API timeout'));
        }, CUSTOMER_ORDER_COLLECTION_TIMEOUT_MS);
        this.pendingCustomerOrderCollections.set(requestId, {
          accountId: account.id,
          resolve,
          reject,
          timer,
        });
        view.webContents.send('pdd-adapter:command', {
          type: 'collect-customer-orders-api',
          requestId,
          conversationKey,
          customerName: customerName || '',
        });
      });
      if (result?.status === 'collected') return result;
      throw new Error(result?.error || 'PDD userAllOrder API import failed');
    } catch (error) {
      this.#writeDiagnostic(account.id, 'api_customer_orders_import_failed', {
        request_id: requestId,
        conversation_key: conversationKey,
        error: error?.message || String(error),
      }, 'warn');
      throw error;
    }
  }

  async prepareConversationTestReset({
    platformAccountId,
    externalConversationId,
  }) {
    this.#requireUser();
    const account = this.registry.list(this.userId).find(
      (candidate) => candidate.platformAccountId === platformAccountId,
    );
    if (!account) throw new Error('PDD account not found for conversation');
    if (!externalConversationId) throw new Error('Conversation external id missing');
    const collector = this.#createCollector(account.id);
    collector.runtime.suppressConversation(platformAccountId, externalConversationId);
    let deletedEventCount;
    try {
      deletedEventCount = await this.rpaManager.clearConversationEvents(
        platformAccountId,
        externalConversationId,
      );
    } catch (error) {
      collector.runtime.releaseConversation(platformAccountId, externalConversationId);
      throw error;
    }
    return {
      status: 'prepared',
      account_id: account.id,
      deleted_event_count: deletedEventCount,
    };
  }

  async resumeConversationAfterTestReset({
    platformAccountId,
    externalConversationId,
  }) {
    this.#requireUser();
    const account = this.registry.list(this.userId).find(
      (candidate) => candidate.platformAccountId === platformAccountId
        && !candidate.paused
        && !candidate.archivedAt
        && !UNAVAILABLE_LOGIN_STATUSES.has(candidate.loginStatus)
        && this.#isAccountIdentityVerified(candidate),
    );
    if (!account) throw new Error('PDD account not found for conversation');
    const collector = this.#createCollector(account.id);
    collector.runtime.releaseConversation(platformAccountId, externalConversationId);
    return {
      status: 'resumed',
      account_id: account.id,
    };
  }

  #isAccountIdentityVerified(account) {
    if (!account.externalAccountId) return Boolean(account.platformAccountId);
    return this.verifiedAccountIdentities.has(account.id);
  }

  #enqueueSyncGapBackfills(accountId, snapshot, source) {
    const gaps = Array.isArray(snapshot?.sync_gaps) ? snapshot.sync_gaps : [];
    const customerUids = [...new Set(gaps
      .filter((gap) => gap?.has_gap || gap?.reset_seq_id)
      .flatMap((gap) => Array.isArray(gap.customer_uids) ? gap.customer_uids : [])
      .filter(Boolean))];
    if (!customerUids.length) {
      if (gaps.length) {
        this.#writeDiagnostic(accountId, 'api_sync_gap_backfill_skipped', {
          source,
          reason: 'customer_uid_missing',
          gap_count: gaps.length,
        }, 'warn');
      }
      return;
    }
    const account = this.registry.get(this.userId, accountId);
    if (
      !account
      || account.archivedAt
      || account.paused
      || UNAVAILABLE_LOGIN_STATUSES.has(account.loginStatus)
      || !this.#isAccountIdentityVerified(account)
    ) {
      this.#writeDiagnostic(accountId, 'api_sync_gap_backfill_skipped', {
        source,
        reason: 'account_unavailable',
        customer_uids: customerUids.slice(0, 20),
      }, 'warn');
      return;
    }
    const now = this.now();
    for (const customerUid of customerUids) {
      const key = accountId + ':' + customerUid;
      const lastStartedAt = this.syncGapBackfills.get(key) || 0;
      if (now - lastStartedAt < SYNC_GAP_BACKFILL_COOLDOWN_MS) {
        this.#writeDiagnostic(accountId, 'api_sync_gap_backfill_skipped', {
          source,
          reason: 'cooldown',
          customer_uid: customerUid,
        }, 'debug');
        continue;
      }
      this.syncGapBackfills.set(key, now);
      this.#writeDiagnostic(accountId, 'api_sync_gap_backfill_queued', {
        source,
        customer_uid: customerUid,
      });
      this.#getStoreActor(account).enqueue(
        'sync_gap_backfill',
        async () => {
          const view = this.#ensureView(account);
          await this.#waitForViewReady(view.webContents);
          const result = await this.#importConversationViaApi(
            account,
            view,
            customerUid,
            { clearBeforeImport: false },
          );
          this.#writeDiagnostic(accountId, 'api_sync_gap_backfill_completed', {
            source,
            customer_uid: customerUid,
            status: result?.status || 'failed',
            method: result?.method || null,
            message_count: result?.message_count || 0,
            error: result?.error || null,
          }, result?.status === 'collected' ? 'info' : 'warn');
          return result;
        },
        { coalesceKey: 'sync_gap_backfill:' + customerUid, rescanAfter: false },
      ).catch((error) => {
        this.#writeDiagnostic(accountId, 'api_sync_gap_backfill_failed', {
          source,
          customer_uid: customerUid,
          error: error?.message || String(error),
        }, 'warn');
      });
    }
  }

  #apiUnreadBackfillVersion(candidate) {
    return JSON.stringify([
      candidate?.conversation_key || '',
      candidate?.latest_msg_id || '',
      candidate?.preview_text || '',
      Number(candidate?.unread_count || 0),
      candidate?.status || '',
    ]);
  }

  #shouldSkipApiUnreadBackfill(accountId, candidate) {
    const conversationKey = String(candidate?.conversation_key || '').trim();
    if (!conversationKey) return { skip: true, reason: 'conversation_key_missing' };
    const ledgerKey = accountId + ':' + conversationKey;
    const version = this.#apiUnreadBackfillVersion(candidate);
    const previous = this.apiUnreadBackfillVersions.get(ledgerKey);
    const now = this.now();
    if (
      previous?.version === version
      && now - previous.at < API_UNREAD_BACKFILL_VERSION_RETRY_MS
    ) {
      return { skip: true, reason: 'already_backfilled_latest_unread', version };
    }
    this.apiUnreadBackfillVersions.set(ledgerKey, { version, at: now });
    if (this.apiUnreadBackfillVersions.size > 5000) {
      const cutoff = now - API_UNREAD_BACKFILL_VERSION_RETRY_MS * 2;
      for (const [key, value] of this.apiUnreadBackfillVersions) {
        if (!value || value.at < cutoff) this.apiUnreadBackfillVersions.delete(key);
      }
    }
    return { skip: false, reason: null, version };
  }

  #latestSnapshotToCandidates(snapshot) {
    return (Array.isArray(snapshot?.conversations) ? snapshot.conversations : []).map((conversation) => ({
      conversation_key: conversation.external_conversation_id,
      external_conversation_id: conversation.external_conversation_id,
      customer_name: conversation.customer_name,
      preview_text: conversation.latest_message_text,
      unread_count: conversation.unread_count,
      active: Boolean(conversation.active),
      avatar_url: conversation.avatar_url || null,
      status: conversation.structured_payload?.status || null,
      latest_msg_id: conversation.structured_payload?.latest_msg_id || null,
      shop_name: conversation.platform_account_name
        || snapshot.platform_identity?.account_name
        || null,
    }));
  }

  #ingestRuntimeSnapshot(accountId, snapshot) {
    const collector = this.collectors.get(accountId);
    if (!collector) return { ingested: false, events: [] };
    const previousCapture = collector.captureEvents;
    collector.captureEvents = [];
    try {
      const ingested = collector.runtime.ingest(snapshot);
      return {
        ingested: Boolean(ingested),
        events: Array.isArray(collector.captureEvents) ? [...collector.captureEvents] : [],
      };
    } finally {
      collector.captureEvents = previousCapture;
    }
  }

  async #ingestEventsDirect(accountId, events, { required = false } = {}) {
    const accessToken = this.rpaManager?.accessToken;
    if (!Array.isArray(events) || !events.length) {
      return { attempted: false, ok: true, count: 0, error: null };
    }
    if (!accessToken) {
      const result = { attempted: false, ok: !required, count: events.length, error: 'access_token_missing' };
      this.#writeDiagnostic(accountId, 'desktop_direct_event_ingest_skipped', {
        event_count: events.length,
        reason: result.error,
        required,
      }, required ? 'warn' : 'debug');
      return result;
    }
    try {
      const response = await fetch(this.businessApiUrl + '/rpa/events/desktop-batch', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + accessToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ events }),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error('HTTP ' + response.status + ': ' + (await response.text()).slice(0, 500));
      const payload = await response.json();
      this.#writeDiagnostic(accountId, 'desktop_direct_event_ingest_succeeded', {
        event_count: events.length,
        stored_count: Array.isArray(payload) ? payload.length : null,
      });
      return { attempted: true, ok: true, count: events.length, error: null };
    } catch (error) {
      this.#writeDiagnostic(accountId, 'desktop_direct_event_ingest_failed', {
        event_count: events.length,
        required,
        error: error?.message || String(error),
      }, required ? 'error' : 'warn');
      return { attempted: true, ok: false, count: events.length, error: error?.message || String(error) };
    }
  }

  #latestMessagePresenceKey(accountId, candidate) {
    const conversationKey = String(candidate?.conversation_key || '').trim();
    const latestMsgId = String(candidate?.latest_msg_id || '').trim();
    if (!conversationKey || !latestMsgId) return null;
    return accountId + ':' + conversationKey + ':' + latestMsgId;
  }

  #hasPotentialLatestMessageBackfill(accountId, candidate) {
    const conversationKey = String(candidate?.conversation_key || '').trim();
    if (!conversationKey) return false;
    const latestMsgId = String(candidate?.latest_msg_id || '').trim();
    if (!latestMsgId) return Number(candidate?.unread_count || 0) > 0;
    const cacheKey = this.#latestMessagePresenceKey(accountId, candidate);
    const cached = cacheKey ? this.apiLatestMessagePresence.get(cacheKey) : null;
    return !cached || this.now() - cached.at > API_LATEST_MESSAGE_PRESENCE_CACHE_MS;
  }

  async #checkLatestPlatformMessageExists(account, candidate) {
    const platformAccountId = String(account?.platformAccountId || '').trim();
    const conversationKey = String(candidate?.conversation_key || '').trim();
    const latestMsgId = String(candidate?.latest_msg_id || '').trim();
    const cacheKey = this.#latestMessagePresenceKey(account.id, candidate);
    if (!conversationKey || !latestMsgId) return null;
    const cached = cacheKey ? this.apiLatestMessagePresence.get(cacheKey) : null;
    if (cached && this.now() - cached.at <= API_LATEST_MESSAGE_PRESENCE_CACHE_MS) return true;
    const accessToken = this.rpaManager?.accessToken;
    if (!platformAccountId || !accessToken) {
      this.#writeDiagnostic(account.id, 'api_latest_message_exists_check_skipped', {
        conversation_key: conversationKey,
        latest_msg_id: latestMsgId,
        reason: !platformAccountId ? 'platform_account_id_missing' : 'access_token_missing',
      }, 'warn');
      return null;
    }
    const params = new URLSearchParams({
      platform_account_id: platformAccountId,
      conversation_external_id: conversationKey,
      platform_message_id: latestMsgId,
    });
    try {
      const response = await fetch(this.businessApiUrl + '/messages/platform-exists?' + params.toString(), {
        headers: { Authorization: 'Bearer ' + accessToken },
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const payload = await response.json();
      const exists = payload?.exists === true;
      if (exists && cacheKey) this.apiLatestMessagePresence.set(cacheKey, { at: this.now() });
      if (this.apiLatestMessagePresence.size > 10000) {
        const oldest = this.apiLatestMessagePresence.keys().next().value;
        this.apiLatestMessagePresence.delete(oldest);
      }
      return exists;
    } catch (error) {
      this.#writeDiagnostic(account.id, 'api_latest_message_exists_check_failed', {
        conversation_key: conversationKey,
        latest_msg_id: latestMsgId,
        error: error?.message || String(error),
      }, 'warn');
      return null;
    }
  }

  async #resolveLatestConversationBackfillCandidates(account, accountId, source, candidates) {
    const selected = [];
    const skipped = [];
    for (const candidate of candidates) {
      const conversationKey = String(candidate?.conversation_key || '').trim();
      if (!conversationKey) {
        skipped.push({ reason: 'conversation_key_missing' });
        continue;
      }
      const latestMsgId = String(candidate?.latest_msg_id || '').trim();
      const unread = Number(candidate?.unread_count || 0) > 0;
      if (!latestMsgId) {
        if (unread) selected.push({ ...candidate, backfill_reason: 'unread_without_latest_msg_id' });
        else skipped.push({ conversation_key: conversationKey, reason: 'latest_msg_id_missing' });
        continue;
      }
      const exists = await this.#checkLatestPlatformMessageExists(account, candidate);
      if (exists === true) {
        skipped.push({
          conversation_key: conversationKey,
          latest_msg_id: latestMsgId,
          reason: 'latest_msg_id_exists',
        });
        continue;
      }
      selected.push({
        ...candidate,
        backfill_reason: exists === false ? 'latest_msg_id_missing_in_db' : 'latest_msg_id_exists_unknown',
      });
    }
    this.#writeDiagnostic(accountId, 'api_latest_backfill_candidates_filtered', {
      source,
      candidate_count: candidates.length,
      selected_count: selected.length,
      skipped_count: skipped.length,
      selected: selected.slice(0, 20).map((candidate) => ({
        conversation_key: candidate.conversation_key || null,
        latest_msg_id: candidate.latest_msg_id || null,
        unread_count: Number(candidate.unread_count || 0),
        reason: candidate.backfill_reason || null,
      })),
      skipped: skipped.slice(0, 20),
    }, selected.length ? 'info' : 'debug');
    return selected;
  }

  async #processLatestConversationUnreadBackfill(
    account,
    view,
    accountId,
    source,
    candidates,
    { forceBackfill = false } = {},
  ) {
    const resolvedCandidates = Array.isArray(candidates)
      ? candidates
      : await this.#listApiConversationCandidates(account, view, 'sync-unread-refresh');
    const backfillCandidates = await this.#resolveLatestConversationBackfillCandidates(
      account,
      accountId,
      source,
      resolvedCandidates,
    );
    this.#writeDiagnostic(accountId, 'api_latest_unread_candidates_resolved', {
      source,
      candidate_count: resolvedCandidates.length,
      unread_count: backfillCandidates.filter((candidate) => Number(candidate?.unread_count || 0) > 0).length,
      backfill_count: backfillCandidates.length,
      unread_customer_uids: backfillCandidates
        .map((candidate) => candidate.conversation_key)
        .filter(Boolean)
        .slice(0, 20),
    });
    const results = [];
    for (const candidate of backfillCandidates) {
      const skip = forceBackfill
        ? { skip: false, reason: null, version: null }
        : this.#shouldSkipApiUnreadBackfill(accountId, candidate);
      if (skip.skip) {
        this.#writeDiagnostic(accountId, 'api_latest_unread_backfill_skipped', {
          source,
          conversation_key: candidate.conversation_key || null,
          customer_name: candidate.customer_name || null,
          reason: skip.reason,
        }, skip.reason === 'already_backfilled_latest_unread' ? 'debug' : 'warn');
        continue;
      }
      const result = await this.#importConversationViaApi(
        account,
        view,
        candidate.conversation_key,
        { clearBeforeImport: false },
      );
      results.push({
        conversation_key: candidate.conversation_key,
        status: result?.status || 'failed',
        message_count: result?.message_count || 0,
        error: result?.error || null,
      });
      this.#writeDiagnostic(accountId, 'api_latest_unread_backfill_completed', {
        source,
        conversation_key: candidate.conversation_key || null,
        customer_name: candidate.customer_name || null,
        latest_msg_id: candidate.latest_msg_id || null,
        backfill_reason: candidate.backfill_reason || null,
        status: result?.status || 'failed',
        method: result?.method || null,
        message_count: result?.message_count || 0,
        error: result?.error || null,
      }, result?.status === 'collected' ? 'info' : 'warn');
      if (result?.status === 'collected') {
        const presenceKey = this.#latestMessagePresenceKey(accountId, candidate);
        if (presenceKey) this.apiLatestMessagePresence.set(presenceKey, { at: this.now() });
      }
    }
    return { status: 'completed', unread_count: backfillCandidates.length, results };
  }

  #enqueueLatestConversationUnreadBackfill(
    accountId,
    source,
    diagnostics = {},
    candidates = null,
    { forceBackfill = false } = {},
  ) {
    const account = this.registry.get(this.userId, accountId);
    if (
      !account
      || account.archivedAt
      || account.paused
      || UNAVAILABLE_LOGIN_STATUSES.has(account.loginStatus)
      || !this.#isAccountIdentityVerified(account)
    ) {
      this.#writeDiagnostic(accountId, 'api_latest_unread_backfill_skipped', {
        source,
        reason: 'account_unavailable',
      }, 'warn');
      return;
    }
    const now = this.now();
    const lastStartedAt = this.syncLatestUnreadBackfills.get(accountId) || 0;
    if (now - lastStartedAt < SYNC_LATEST_UNREAD_BACKFILL_COOLDOWN_MS) {
      this.#writeDiagnostic(accountId, 'api_latest_unread_backfill_skipped', {
        source,
        reason: 'cooldown',
        elapsed_ms: now - lastStartedAt,
      }, 'debug');
      return;
    }
    this.syncLatestUnreadBackfills.set(accountId, now);
    this.#writeDiagnostic(accountId, 'api_latest_unread_backfill_queued', {
      source,
      sync_advanced: Boolean(diagnostics.sync_advanced),
      sync_message_count: Number(diagnostics.message_count) || 0,
      sync_data_count: Number(diagnostics.sync_data_count) || 0,
      force_backfill: Boolean(forceBackfill),
    });
    this.#getStoreActor(account).enqueue(
      'sync_latest_unread_backfill',
      async () => {
        const view = this.#ensureView(account);
        await this.#waitForViewReady(view.webContents);
        return this.#processLatestConversationUnreadBackfill(
          account,
          view,
          accountId,
          source,
          candidates,
          { forceBackfill },
        );
      },
      { coalesceKey: 'sync_latest_unread_backfill', rescanAfter: false },
    ).catch((error) => {
      this.#writeDiagnostic(accountId, 'api_latest_unread_backfill_failed', {
        source,
        error: error?.message || String(error),
      }, 'warn');
    });
  }

  #updateLoginStatus(accountId, value) {
    try {
      const status = this.pageClassifier(value);
      if (['login_required', 'online', 'risk_control'].includes(status)) {
        this.#setAccountLoginStatus(accountId, status);
      }
    } catch {
      // Ignore incomplete navigation URLs.
    }
  }

  #setAccountLoginStatus(accountId, loginStatus) {
    if (!this.userId) return;
    const account = this.registry.get(this.userId, accountId);
    if (!account) return;
    if (account.loginStatus !== loginStatus) this.registry.update(this.userId, accountId, { loginStatus });
    if (loginStatus === 'login_required' || loginStatus === 'risk_control') {
      this.#cancelStoreActor(accountId, '店铺登录状态不可用，任务已取消');
    }
    this.syncRpaAccounts();
  }

  syncRpaAccounts() {
    if (!this.userId || !this.rpaManager) return;
    this.rpaManager.setPlatformAccounts('pinduoduo', [
      ...this.registry.list(this.userId),
      ...this.registry.list(this.userId, { archived: true }),
    ]);
  }

  #createCollector(accountId) {
    if (this.collectors.has(accountId)) return this.collectors.get(accountId);
    const collector = {
      status: 'idle',
      lastCollectedAt: null,
      runtime: new PddCollectionRuntime({
        localAccountId: accountId,
        getPlatformAccountId: () => {
          const account = this.registry.get(this.userId, accountId);
          return account && this.#isAccountIdentityVerified(account) ? account.platformAccountId || null : null;
        },
        enqueueEvent: (event) => {
          if (Array.isArray(collector.captureEvents)) collector.captureEvents.push(event);
          const account = this.registry.get(this.userId, accountId);
          const identityVerified = account ? this.#isAccountIdentityVerified(account) : false;
          if (!account || !identityVerified) {
            this.#writeDiagnostic(accountId, 'runtime_event_dropped_before_rpa_enqueue', {
              reason: !account ? 'account_missing' : 'identity_not_verified',
              event_id: event?.event_id || null,
              event_type: event?.event_type || null,
              platform_message_id: event?.platform_message_id || null,
              conversation_external_id: event?.conversation_external_id || null,
              sender_role: event?.payload_json?.sender_role || null,
              content_preview: String(event?.payload_json?.content || '').slice(0, 128),
              has_platform_account_id: Boolean(account?.platformAccountId),
              has_external_account_id: Boolean(account?.externalAccountId),
              login_status: account?.loginStatus || null,
            }, 'warn');
            return;
          }
          collector.status = 'collecting';
          collector.lastCollectedAt = new Date().toISOString();
          this.#writeDiagnostic(accountId, 'runtime_event_forwarding_to_rpa', {
            event_id: event?.event_id || null,
            event_type: event?.event_type || null,
            platform_account_id: event?.platform_account_id || null,
            platform_message_id: event?.platform_message_id || null,
            conversation_external_id: event?.conversation_external_id || null,
            sender_role: event?.payload_json?.sender_role || null,
            content_preview: String(event?.payload_json?.content || '').slice(0, 128),
            rpa_state: this.rpaManager?.getState?.().status || null,
            ...(event?.event_type === 'customer_orders_snapshot' ? {
              order_collection_status: event?.payload_json?.collection_status || null,
              order_collection_error: event?.payload_json?.error || null,
              order_count: Array.isArray(event?.payload_json?.orders) ? event.payload_json.orders.length : 0,
            } : {}),
            ...(event?.event_type === 'customer_products_snapshot' ? {
              product_collection_status: event?.payload_json?.collection_status || null,
              product_collection_error: event?.payload_json?.error || null,
              product_count: Array.isArray(event?.payload_json?.products) ? event.payload_json.products.length : 0,
            } : {}),
          });
          this.rpaManager?.enqueueEvent(event);
          this.#publishState();
        },
        onDiagnostic: (stage, details = {}, level = 'debug') => {
          this.#writeDiagnostic(accountId, stage, details, level);
        },
        onStatus: (status) => {
          collector.status = status === 'online' ? 'watching' : status;
          if (['login_required', 'online', 'risk_control', 'error'].includes(status)) {
            this.#setAccountLoginStatus(accountId, status);
          }
          this.#publishState();
        },
        onIdentity: ({
          external_account_id: externalAccountId,
          account_name: platformAccountName,
          logo_url: platformAccountLogoUrl = null,
          service_username: platformAccountServiceUsername = null,
          cs_id: platformAccountCsId = null,
          cs_uid: platformAccountCsUid = null,
          is_mall_owner: platformAccountIsMallOwner = false,
          account_name_source: accountNameSource,
        }) => {
          const current = this.registry.get(this.userId, accountId);
          if (!current) return;
          if (
            current.externalAccountId
            && externalAccountId
            && current.externalAccountId !== externalAccountId
          ) {
            this.registry.update(this.userId, accountId, { loginStatus: 'account_mismatch' });
            collector.status = 'error';
            this.#cancelStoreActor(accountId, 'PDD login account mismatch; task cancelled');
            this.#writeDiagnostic(accountId, 'account_identity_mismatch', {
              expected_present: true,
              actual_present: true,
            }, 'error');
            this.syncRpaAccounts();
            this.#publishState();
            return;
          }
          const canVerifyIdentity = externalAccountId
            ? (!current.externalAccountId || current.externalAccountId === externalAccountId)
            : (!current.externalAccountId && Boolean(current.platformAccountId));
          if (canVerifyIdentity) {
            const wasVerified = this.verifiedAccountIdentities.has(accountId);
            this.verifiedAccountIdentities.add(accountId);
            if (!wasVerified) {
              this.#writeDiagnostic(accountId, 'account_identity_verified', {
                method: externalAccountId ? 'external_account_id' : 'bound_platform_account',
                has_platform_account_id: Boolean(current.platformAccountId),
                has_external_account_id: Boolean(externalAccountId),
              });
            }
            collector.runtime.accountBindingChanged();
          }
          const identifiedAlias = detectedAlias(platformAccountName);
          const shouldIdentifyAlias = isAutoReplaceableAlias(current.alias) && identifiedAlias;
          if (
            current.externalAccountId === externalAccountId
            && current.platformAccountName === platformAccountName
            && current.platformAccountLogoUrl === platformAccountLogoUrl
            && current.platformAccountServiceUsername === platformAccountServiceUsername
            && current.platformAccountCsId === platformAccountCsId
            && current.platformAccountCsUid === platformAccountCsUid
            && current.platformAccountIsMallOwner === (platformAccountIsMallOwner === true)
            && !shouldIdentifyAlias
          ) return;
          this.registry.update(this.userId, accountId, {
            externalAccountId,
            platformAccountName,
            platformAccountLogoUrl,
            platformAccountServiceUsername,
            platformAccountCsId,
            platformAccountCsUid,
            platformAccountIsMallOwner,
            ...(shouldIdentifyAlias ? { alias: identifiedAlias } : {}),
          });
          if (shouldIdentifyAlias) {
            this.#writeDiagnostic(accountId, 'account_name_identified', {
              detected_name_length: identifiedAlias.length,
              source: accountNameSource || null,
            });
          }
          this.syncRpaAccounts();
          this.#publishState();
        },
      }),
    };
    this.collectors.set(accountId, collector);
    return collector;
  }

  #writeDiagnostic(accountId, stage, details = {}, level = 'info') {
    this.diagnosticLogger?.write(accountId, {
      type: 'diagnostic',
      level,
      stage,
      details,
      observed_at: new Date().toISOString(),
    });
  }

  #requireUser() {
    if (!this.userId) throw new Error('拼多多工作区尚未绑定当前用户');
  }
}
