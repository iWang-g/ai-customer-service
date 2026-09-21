import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { mapEmptyTradeResponse, TRADE_API, SUMMARY_API } from './order-mapper.js';
const require = createRequire(import.meta.url);
const { installOrderPage } = require('./order-page.cjs');
const { createOrderIdentityProtocol } = require('./order-identity-protocol.cjs');
const identityProtocol = createOrderIdentityProtocol();
const execFileAsync = promisify(execFile);
const directory = path.dirname(fileURLToPath(import.meta.url));

export function parseOrderJson(raw) {
  return JSON.parse(raw, (_key, value, context) => {
    if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) {
      if (!context?.source || !/^\d+$/.test(context.source)) throw new Error('运行环境不支持无损订单号解析');
      return context.source;
    }
    return value;
  });
}
export function verifyOrderSummary(summary, buyerUid) {
  if (summary?.api?.toLowerCase() !== SUMMARY_API || !summary.ret?.some(x => /^SUCCESS::/.test(x)) ||
      !Array.isArray(summary.data?.data) || summary.data.data.length !== 1) throw new Error('无法确认订单摘要买家');
  const buyer = summary.data.data[0];
  if (String(buyer.buyerId) !== buyerUid || buyer.bizDomain !== 'taobao') throw new Error('订单摘要买家不匹配');
  if (!Array.isArray(buyer.tradeSimpleList)) throw new Error('订单摘要未明确返回订单列表，暂不更新');
  return new Set(buyer.tradeSimpleList.map(o => {
    if (typeof o.bizOrderId === 'number' && !Number.isSafeInteger(o.bizOrderId)) throw new Error('订单号精度错误');
    const id = String(o.bizOrderId); if (!/^\d+$/.test(id)) throw new Error('订单摘要编号无效'); return id;
  }));
}

export async function resolveLiveOrderBuyer(base, query) {
  identityProtocol.validateBase(base);
  const forwardKey = randomUUID(), reverseKey = randomUUID();
  const convert = async (key, securityBuyerUid) => {
    const raw = await query({ ...base, method: identityProtocol.api, version: '1.0',
      params: identityProtocol.params(base, key, securityBuyerUid) });
    try { return parseOrderJson(raw); }
    catch { throw new Error('订单身份响应格式无效'); }
  };
  const securityBuyerUid = identityProtocol.identity(await convert(forwardKey), base, forwardKey);
  identityProtocol.identity(await convert(reverseKey, securityBuyerUid), base, reverseKey, true);
  return { buyerUid: base.buyerUid, securityBuyerUid, identitySource: 'verified_live_conversion' };
}

export async function readVerifiedOrders(base, sellerNick, query, resolveIdentity) {
  identityProtocol.validateBase(base);
  const summary = parseOrderJson(await query({ ...base, method: SUMMARY_API, version: '2.0', params: {
    buyerInfo: JSON.stringify([{ decryptId: base.buyerUid, bizDomain: 'taobao' }]), sellerNick } }));
  const orderIds = verifyOrderSummary(summary, base.buyerUid);
  if (!orderIds.size) return { platform: 'qianniu', shop_uid: base.shopUid, cid: base.cid, buyer_uid: base.buyerUid,
    collection_status: 'empty', orders: [], page_summary: { total_count: 0, has_more: false }, read_only: true,
    identity_verified: true, identity_source: 'verified_buyer_summary' };
  let identity;
  try { identity = resolveIdentity ? await resolveIdentity(base.shopUid, base.cid, base.mainUid) : await resolveLiveOrderBuyer(base, query); }
  catch (error) {
    if (error?.message === '该买家尚无可验证的订单身份缓存')
      throw new Error(`已查询到 ${orderIds.size} 笔订单，明细暂未获取：缺少该买家的订单查询身份信息，原有数据未更新`);
    throw new Error(`已查询到 ${orderIds.size} 笔订单，明细暂未获取：${error.message}，原有数据未更新`);
  }
  if (identity.buyerUid !== base.buyerUid || !identityProtocol.validId(identity.securityBuyerUid)) throw new Error('订单明细买家身份不匹配');
  const trade = parseOrderJson(await query({ ...base, method: TRADE_API, version: '1.0', params: {
    securityBuyerUid: identity.securityBuyerUid, _message_cid: base.cid } }));
  const snapshot = mapEmptyTradeResponse(trade, base);
  if (snapshot.orders.some(o => !orderIds.has(o.platform_order_id)) || !snapshot.orders.length)
    throw new Error('订单明细与买家摘要不一致，暂不展示');
  return { ...snapshot, identity_source: identity.identitySource || 'verified_external_identity', page_summary: { total_count: Math.max(snapshot.orders.length, orderIds.size),
    has_more: orderIds.size > snapshot.orders.length || snapshot.orders.length > 100 } };
}

export class QianniuOrderReader {
  constructor({ dataPath, bridgeBase = 'http://127.0.0.1:18082/qn-bridge', versionDirectory = '' }) {
    this.dataPath = dataPath; this.bridgeBase = bridgeBase; this.versionDirectory = versionDirectory;
    this.pages = new Map(); this.jobs = new Map(); this.inflight = new Map(); this.server = null; this.starting = null;
  }
  async start() {
    if (this.starting) return this.starting;
    if (this.server) return;
    if (!this.starting) this.starting = this.#start().finally(() => { this.starting = null; });
    return this.starting;
  }
  async #start() {
    await fs.mkdir(this.dataPath, { recursive: true });
    const configFile = path.join(this.dataPath, 'config.json');
    let config;
    try { config = JSON.parse(await fs.readFile(configFile, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; config = { token: randomBytes(32).toString('hex') }; }
    if (!/^[a-f0-9]{64}$/.test(config.token)) throw new Error('订单通道配置无效');
    this.token = config.token;
    await fs.writeFile(configFile, JSON.stringify(config));
    const server = http.createServer((req, res) => void this.#request(req, res));
    server.requestTimeout = 10000;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(18086, '127.0.0.1', resolve); });
    this.server = server;
    try {
      const bundle = path.join(this.dataPath, 'page.js');
      await fs.writeFile(bundle, '(' + installOrderPage.toString() + ')(window,' + JSON.stringify({
        base: 'http://127.0.0.1:18086', token: this.token }) + ',' + createOrderIdentityProtocol.toString() + ');');
      await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', path.join(directory, 'install-orders.ps1'), '-BundlePath', bundle,
        '-BackupDirectory', path.join(this.dataPath, 'backups'),
        ...(this.versionDirectory ? ['-VersionDirectory', this.versionDirectory] : [])], { windowsHide: true, timeout: 20000 });
    } catch { await this.stop(); throw new Error('千牛订单模块资源加载失败'); }
  }
  async stop() {
    for (const task of this.jobs.values()) { clearTimeout(task.timer); task.reject(new Error('千牛订单服务已停止')); }
    this.jobs.clear(); this.pages.clear();
    const server = this.server; this.server = null;
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }
  async #request(req, res) {
    const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    const origin = req.headers.origin;
    if (origin && origin !== 'https://alires-webui') return send(403, {});
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'POST'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type'); return send(204, null);
    }
    if (req.method !== 'POST') return send(405, {});
    try {
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > 4 * 1024 * 1024) return send(413, {}); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (body.token !== this.token || typeof body.pageId !== 'string' || body.pageId.length > 100) return send(403, {});
      if (req.url === '/poll') {
        if (!/^\d+$/.test(body.state?.shopUid || '') || !/^\d+$/.test(body.state?.mainUid || '')) return send(400, {});
        this.pages.set(body.pageId, { ...body.state, identityVersion: body.identityVersion, pageId: body.pageId, at: Date.now() });
        const pending = [...this.jobs.values()].find(j => j.pageId === body.pageId && !j.sent);
        if (pending) pending.sent = true;
        return send(200, { job: pending?.job || null });
      }
      if (req.url === '/result') {
        const task = this.jobs.get(body.id);
        if (!task || task.pageId !== body.pageId || !task.sent) return send(409, {});
        this.jobs.delete(body.id); clearTimeout(task.timer);
        const result = body.result;
        if (!result?.ok) task.reject(new Error('千牛订单查询失败，请重试'));
        else if (result.before?.shopUid !== task.job.shopUid || result.before?.mainUid !== task.job.mainUid ||
            result.before?.cid !== task.job.contextCid || JSON.stringify(result.before) !== JSON.stringify(result.after) || typeof result.raw !== 'string')
          task.reject(new Error('千牛订单查询上下文不匹配'));
        else task.resolve(result.raw);
        return send(200, {});
      }
      send(404, {});
    } catch { send(400, {}); }
  }
  #query(page, job) {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => { this.jobs.delete(id); reject(new Error('千牛订单读取超时')); }, 18000);
      this.jobs.set(id, { pageId: page.pageId, job: { ...job, id, contextCid: page.cid }, resolve, reject, timer, sent: false });
    });
  }
  read(shopUid, cid) {
    const key = shopUid + '|' + cid;
    if (!this.inflight.has(key)) this.inflight.set(key, this.#read(shopUid, cid).finally(() => this.inflight.delete(key)));
    return this.inflight.get(key);
  }
  async #read(shopUid, cid) {
    await this.start();
    const pages = [...this.pages.values()].filter(p => p.shopUid === shopUid && Date.now() - p.at < 10000);
    if (pages.length !== 1) throw new Error('千牛订单页面未就绪，请重启千牛后重试');
    const page = pages[0];
    if (page.identityVersion !== 1) throw new Error('千牛订单模块已更新，请重启千牛后重试');
    const match = /^(\d+)\.1-(\d+)\.1#11001@cntaobao$/.exec(cid || '');
    if (!match || ![match[1], match[2]].includes(page.mainUid)) throw new Error('订单会话不属于当前店铺');
    const buyerUid = match[1] === page.mainUid ? match[2] : match[1];
    const json = async (route, body) => {
      const response = await fetch(this.bridgeBase + route, { signal: AbortSignal.timeout(4000), ...(body ? {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
      if (!response.ok) throw new Error('千牛账号查询失败'); return response.json();
    };
    const { clients } = await json('/clients');
    const matches = clients.filter(c => c.state?.loginID?.targetId === shopUid && (c.waiting || Date.now() - Date.parse(c.lastSeen) < 10000));
    if (matches.length !== 1) throw new Error('千牛账号页面不唯一');
    const { command } = await json('/command', { clientId: matches[0].clientId, cmd: 'getLoginuser', param: {} });
    let login;
    const until = Date.now() + 15000;
    while (Date.now() < until) {
      const { result } = await json('/results?commandId=' + encodeURIComponent(command.id));
      if (result) { if (!result.ok || result.clientId !== matches[0].clientId) throw new Error('千牛账号查询失败'); login = result.value; break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (typeof login === 'string') login = JSON.parse(login);
    if (String(login?.sub_user_id || login?.user_id) !== shopUid || String(login?.user_id) !== page.mainUid || !login?.user_nick)
      throw new Error('千牛主子账号绑定校验失败');
    const base = { shopUid, mainUid: page.mainUid, cid, buyerUid };
    const snapshot = await readVerifiedOrders(base, 'cntaobao' + login.user_nick.replace(/^cntaobao/, ''), job => this.#query(page, job));
    return { ...snapshot, observed_at: new Date().toISOString(), customer_key: 'qianniu:' + shopUid + ':' + buyerUid,
      identity_verified: true, source: 'qianniu_orders_v1' };
  }
}
