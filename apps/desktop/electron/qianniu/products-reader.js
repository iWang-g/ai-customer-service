import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { parseShopProfile } from './shop-profile.js';
const require = createRequire(import.meta.url);
const { installProductsPage } = require('./products-page.cjs');
const { summarize } = require('./products-protocol.cjs');
const { summarizeDetail } = require('./product-detail-protocol.cjs');
const { verifyOwnership } = require('./product-ownership-protocol.cjs');
const { createOrderIdentityProtocol } = require('./order-identity-protocol.cjs');
const liveIdentity = createOrderIdentityProtocol();
const execFileAsync = promisify(execFile);
const directory = path.dirname(fileURLToPath(import.meta.url));

export async function collectProducts(query, { onProgress = () => {}, maxDurationMs = 30 * 60 * 1000 } = {}) {
  const products = [], ids = new Set();
  const deadline = Date.now() + maxDurationMs;
  let total;
  // Keep the verified five-item page size; bound total work independently.
  for (let pageNo = 1; pageNo <= 1000; pageNo++) {
    if (Date.now() >= deadline) throw new Error('商品同步超时，原有列表未更新，请稍后重试');
    const page = summarize(await query(pageNo), pageNo, 5);
    if (Date.now() >= deadline) throw new Error('商品同步超时，原有列表未更新，请稍后重试');
    if (page.total > 5000) throw new Error('本次商品同步最多支持 5000 件，原有列表未更新');
    if (total !== undefined && total !== page.total) throw new Error('千牛商品总数发生变化，请重试');
    total = page.total;
    for (const product of page.products) {
      if (ids.has(product.productId)) throw new Error('千牛商品分页发生重叠，请重试');
      ids.add(product.productId);
      products.push({ product_id: product.productId, goods_id: product.productId, title: product.title,
        image_url: product.imageUrl, link_url: product.url, price: product.price,
        price_label: product.price == null ? null : '¥' + product.price, quantity: product.quantity,
        sold_quantity: product.soldQuantity, source: 'qianniu_products_v1',
        raw_payload: { category_id: product.categoryId } });
    }
    if (products.length > total || (products.length < total && page.products.length !== 5))
      throw new Error('千牛商品分页不完整，已保留原有列表');
    onProgress({ collected: products.length, total, page: pageNo });
    if (products.length === total) return products;
  }
  throw new Error('千牛商品采集超过页数上限');
}

export class QianniuProductsReader {
  constructor({ dataPath }) {
    this.dataPath = dataPath;
    this.pages = new Map(); this.jobs = new Map(); this.pollWaiters = new Map(); this.reads = new Map(); this.server = null; this.starting = null;
    this.generation = 0;
    this.shopQueues = new Map(); this.detailReads = new Map();
  }
  async start() {
    if (this.starting) return this.starting;
    if (this.server) return;
    this.starting = this.#start().finally(() => { this.starting = null; });
    return this.starting;
  }
  async #start() {
    await fs.mkdir(this.dataPath, { recursive: true });
    const configPath = path.join(this.dataPath, 'config.json');
    let config;
    try { config = JSON.parse(await fs.readFile(configPath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; config = { token: randomBytes(32).toString('hex') }; }
    if (!/^[a-f0-9]{64}$/.test(config.token)) throw new Error('商品通道配置无效');
    this.token = config.token;
    await fs.writeFile(configPath, JSON.stringify(config));
    const server = http.createServer((req, res) => void this.#request(req, res));
    server.requestTimeout = 12000;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(18089, '127.0.0.1', resolve); });
    this.server = server;
    try {
      const bundle = path.join(this.dataPath, 'page.js');
      await fs.writeFile(bundle, '(' + installProductsPage.toString() + ')(window,' + JSON.stringify({ base: 'http://127.0.0.1:18089', token: this.token }) + ',' + createOrderIdentityProtocol.toString() + ');');
      await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', path.join(directory, 'install-orders.ps1'), '-ModuleName', 'products', '-BundlePath', bundle,
        '-BackupDirectory', path.join(this.dataPath, 'backups')], { windowsHide: true, timeout: 20000 });
    } catch { await this.stop(); throw new Error('千牛商品模块安装失败'); }
  }
  async stop() {
    this.generation++;
    for (const task of this.jobs.values()) { clearTimeout(task.timer); task.reject(new Error('千牛商品读取已停止')); }
    for (const waiter of this.pollWaiters.values()) waiter.finish(null);
    this.pollWaiters.clear();
    this.jobs.clear(); this.pages.clear();
    const server = this.server; this.server = null;
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }
  async #request(req, res) {
    const send = (code, value) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    const origin = req.headers.origin;
    if (req.headers.host !== '127.0.0.1:18089' || origin && origin !== 'https://alires-webui') return send(403, {});
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
        if (!/^\d+$/.test(body.state?.shopUid || '') || !/^\d+$/.test(body.state?.mainUid || '') || typeof body.state.cid !== 'string') return send(400, {});
        for (const [id, page] of this.pages) if (Date.now() - page.at > 30000) this.pages.delete(id);
        this.pages.set(body.pageId, { ...body.state, shopProfileVersion: body.shopProfileVersion,
          pageId: body.pageId, at: Date.now() });
        const task = body.deliveryVersion === 1
          ? await this.#waitForJob(body.pageId)
          : this.#takeJob(body.pageId);
        return send(200, { job: task?.job || null, deliveryVersion: body.deliveryVersion === 1 ? 1 : 0 });
      }
      if (req.url === '/result') {
        const task = this.jobs.get(body.id);
        if (!task || !task.sent || task.pageId !== body.pageId) return send(409, {});
        clearTimeout(task.timer); this.jobs.delete(body.id);
        const result = body.result;
        if (!result?.ok) task.reject(new Error('千牛商品查询失败，请重试'));
        else if (result.before?.shopUid !== task.job.shopUid || result.before?.mainUid !== task.job.mainUid ||
            typeof result.before?.cid !== 'string' || JSON.stringify(result.before) !== JSON.stringify(result.after) || typeof result.raw !== 'string')
          task.reject(new Error('千牛商品查询上下文变化'));
        else task.resolve(result.raw);
        return send(200, {});
      }
      send(404, {});
    } catch { send(400, {}); }
  }
  #query(page, job) {
    if (!this.server) return Promise.reject(new Error('千牛商品服务已停止'));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => { this.jobs.delete(id); reject(new Error('千牛商品查询超时')); }, 18000);
      this.jobs.set(id, { job: { ...job, id }, pageId: page.pageId, resolve, reject, timer, sent: false });
      this.#wakePage(page.pageId);
    });
  }
  #takeJob(pageId) {
    const task = [...this.jobs.values()].find(job => job.pageId === pageId && !job.sent);
    if (task) task.sent = true;
    return task || null;
  }
  #waitForJob(pageId) {
    const ready = this.#takeJob(pageId);
    if (ready) return Promise.resolve(ready);
    const previous = this.pollWaiters.get(pageId);
    if (previous) previous.finish(null);
    return new Promise(resolve => {
      const waiter = {
        timer: null,
        finish: value => {
          if (this.pollWaiters.get(pageId) !== waiter) return;
          clearTimeout(waiter.timer);
          this.pollWaiters.delete(pageId);
          resolve(value);
        },
      };
      waiter.timer = setTimeout(() => waiter.finish(null), 8000);
      this.pollWaiters.set(pageId, waiter);
    });
  }
  #wakePage(pageId) {
    const waiter = this.pollWaiters.get(pageId);
    if (waiter) waiter.finish(this.#takeJob(pageId));
  }
  read(shopUid, cid, onProgress) {
    if (!this.reads.has(shopUid)) this.reads.set(shopUid, this.#serial(shopUid, () => this.#read(shopUid, cid, onProgress)).finally(() => this.reads.delete(shopUid)));
    return this.reads.get(shopUid);
  }
  readShopProfile(shopUid, mainUid, nick) {
    return this.#serial(shopUid, async () => {
      const generation = this.generation;
      const pages = [...this.pages.values()].filter(p => p.shopUid === shopUid && Date.now() - p.at < 10000);
      if (pages.length !== 1 || pages[0].shopProfileVersion !== 1)
        throw new Error('千牛店铺资料页面未就绪或需重启');
      const page = pages[0];
      if (page.mainUid !== mainUid) throw new Error('千牛店铺主账号不一致');
      const raw = await this.#query(page, { kind: 'profile', shopUid, mainUid, nick });
      if (generation !== this.generation) throw new Error('千牛店铺读取已停止');
      return parseShopProfile(raw, { shopUid, mainUid, nick });
    });
  }
  #serial(shopUid, operation) {
    const generation = this.generation;
    const work = (this.shopQueues.get(shopUid) || Promise.resolve()).catch(() => {}).then(() => {
      if (generation !== this.generation) throw new Error('千牛商品读取已停止');
      return operation();
    });
    this.shopQueues.set(shopUid, work);
    void work.finally(() => { if (this.shopQueues.get(shopUid) === work) this.shopQueues.delete(shopUid); }).catch(() => {});
    return work;
  }
  readDetail(shopUid, cid, productId, { ownershipVerified = false } = {}) {
    if (typeof productId !== 'string' || !/^\d{1,30}$/.test(productId)) return Promise.reject(new Error('商品 ID 无效'));
    const key = shopUid + ':' + cid + ':' + productId;
    if (!this.detailReads.has(key)) this.detailReads.set(key, this.#serial(shopUid, async () => {
      await this.start();
      const generation = this.generation;
      const pages = [...this.pages.values()].filter(p => p.shopUid === shopUid && Date.now() - p.at < 10000);
      if (pages.length !== 1) throw new Error('千牛商品详情页面未就绪，请重启千牛');
      const page = pages[0];
      const match = /^(\d+)\.1-(\d+)\.1#11001@cntaobao$/.exec(cid || '');
      if (!match || ![match[1], match[2]].includes(page.mainUid)) throw new Error('千牛商品详情会话不属于当前店铺');
      const buyerUid = match[1] === page.mainUid ? match[2] : match[1];
      const base = { shopUid, mainUid: page.mainUid, buyerUid, cid };
      let ownership = null;
      if (!ownershipVerified) {
        const ownershipRaw = await this.#query(page, {
          kind: 'ownership', shopUid, mainUid: page.mainUid, cid, productId,
        });
        ownership = verifyOwnership(ownershipRaw, productId, page.mainUid);
      }
      if (generation !== this.generation) throw new Error('千牛商品读取已停止');
      const key = randomUUID();
      const identityRaw = await this.#query(page, { kind: 'identity', ...base, key });
      const identity = { encryptId: liveIdentity.identity(JSON.parse(identityRaw), base, key), isNewCustomer: true };
      if (generation !== this.generation) throw new Error('千牛商品读取已停止');
      const observed_at = new Date().toISOString();
      const raw = await this.#query(page, { kind: 'detail', shopUid, mainUid: page.mainUid, cid, productId, ...identity });
      if (generation !== this.generation) throw new Error('千牛商品读取已停止');
      return { shop_uid: shopUid, seller_uid: page.mainUid, product_id: productId,
        observed_at, source: 'qianniu_product_detail_v1',
        ...(ownership ? { ownership } : {}), detail: summarizeDetail(raw, productId) };
    }).finally(() => this.detailReads.delete(key)));
    return this.detailReads.get(key);
  }
  async #read(shopUid, cid, onProgress) {
    await this.start();
    const generation = this.generation;
    const pages = [...this.pages.values()].filter(page => page.shopUid === shopUid && Date.now() - page.at < 10000);
    if (pages.length !== 1) throw new Error('千牛商品页面未就绪，请重启千牛后重试');
    const page = pages[0], match = /^(\d+)\.1-(\d+)\.1#11001@cntaobao$/.exec(cid || '');
    if (!match || ![match[1], match[2]].includes(page.mainUid)) throw new Error('千牛商品查询会话不属于此店铺');
    const observed_at = new Date().toISOString();
    const products = await collectProducts(async pageNo => {
      if (pageNo > 1) await new Promise(resolve => setTimeout(resolve, 250));
      if (generation !== this.generation) throw new Error('千牛商品读取已停止');
      return this.#query(page, { shopUid, mainUid: page.mainUid, cid, pageNo, pageSize: 5 });
    }, { onProgress });
    if (generation !== this.generation) throw new Error('千牛商品读取已停止');
    return { shop_uid: shopUid, seller_uid: page.mainUid, source: 'qianniu_products_v1', observed_at,
      collection_status: products.length ? 'success' : 'empty', products,
      page_summary: { total_count: products.length, has_more: false } };
  }
}
