import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createTransferProtocol } = require('./transfer-protocol.cjs');
const { installTransferPage } = require('./transfer-page.cjs');
const directory = path.dirname(fileURLToPath(import.meta.url));
const protocol = createTransferProtocol();
export const TRANSFER_PORT = 18093;

export class QianniuTransferChannel {
  constructor({ dataPath, install = true, port = TRANSFER_PORT }) {
    Object.assign(this, { dataPath, install, port });
    this.pages = new Map(); this.jobs = new Map(); this.server = null; this.starting = null;
  }
  async start() {
    if (this.starting) return this.starting;
    if (this.server) return;
    this.starting = this.startServer().finally(() => { this.starting = null; });
    return this.starting;
  }
  async startServer() {
    await fs.mkdir(this.dataPath, { recursive: true });
    const file = path.join(this.dataPath, 'config.json');
    let config;
    try { config = JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; config = { token: randomBytes(32).toString('hex') }; }
    if (!/^[a-f0-9]{64}$/.test(config.token)) throw new Error('千牛转接通道配置无效');
    this.token = config.token;
    await fs.writeFile(file, JSON.stringify(config));
    const server = http.createServer((req, res) => void this.request(req, res));
    server.requestTimeout = 10000;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(this.port, '127.0.0.1', resolve); });
    this.server = server;
    this.port = server.address().port;
    try {
      const bundle = path.join(this.dataPath, 'page.js');
      await fs.writeFile(bundle, '(' + installTransferPage.toString() + ')(window,' +
        JSON.stringify({ base: `http://127.0.0.1:${this.port}`, token: this.token }) + ',' + createTransferProtocol.toString() + ');');
      if (this.install) await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', path.join(directory, 'install-orders.ps1'), '-ModuleName', 'transfer', '-BundlePath', bundle,
        '-BackupDirectory', path.join(this.dataPath, 'backups')], { windowsHide: true, timeout: 20000 });
    } catch (error) { await this.stop(); throw error; }
  }
  async stop() {
    for (const t of this.jobs.values()) { clearTimeout(t.timer); t.reject(new Error('千牛转接通道已停止；已提交操作需核对')); }
    this.jobs.clear(); this.pages.clear();
    const server = this.server; this.server = null;
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }
  async request(req, res) {
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    const origin = req.headers.origin;
    if (req.headers.host !== `127.0.0.1:${this.port}` || origin && origin !== 'https://alires-webui') return send(403, {});
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Methods', 'POST'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type'); return send(204, null); }
    if (req.method !== 'POST') return send(405, {});
    try {
      let size = 0; const chunks = [];
      for await (const c of req) { size += c.length; if (size > 512000) return send(413, {}); chunks.push(c); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (body.token !== this.token || body.version !== 1 || typeof body.pageId !== 'string' || body.pageId.length > 100) return send(403, {});
      if (req.url === '/poll') {
        const s = body.state;
        if (!protocol.id(s?.shopUid) || !protocol.id(s.mainUid) || !protocol.nick(s.nick)) return send(400, {});
        for (const [id, page] of this.pages) if (Date.now() - page.at > 10000) this.pages.delete(id);
        this.pages.set(body.pageId, { ...s, pageId: body.pageId, at: Date.now() });
        const task = [...this.jobs.values()].find(t => !t.sent && t.pageId === body.pageId);
        if (task) task.sent = true;
        return send(200, { job: task?.job || null });
      }
      if (req.url === '/result') {
        const task = this.jobs.get(body.id);
        if (!task || !task.sent || task.pageId !== body.pageId) return send(409, {});
        clearTimeout(task.timer); this.jobs.delete(body.id);
        const r = body.result;
        if (r?.before?.shopUid !== task.page.shopUid || r.before.mainUid !== task.page.mainUid || r.before.nick !== task.page.nick ||
            JSON.stringify(r.before) !== JSON.stringify(r.after) || typeof r.invoked !== 'boolean')
          task.reject(new Error('千牛转接回执身份不匹配，结果待确认'));
        else task.resolve(r);
        if (this.pages.has(body.pageId)) this.pages.get(body.pageId).at = Date.now();
        return send(200, {});
      }
      send(404, {});
    } catch { send(400, {}); }
  }
  page(shopUid) {
    const pages = [...this.pages.values()].filter(p => p.shopUid === shopUid && Date.now() - p.at < 10000);
    if (pages.length !== 1) throw new Error('千牛转接页面未就绪或存在多个页面，请重启千牛后重试');
    return pages[0];
  }
  async run(context, kind, target = {}) {
    let ticket;
    try {
      await this.start();
      const page = this.page(context.shopUid);
      if (protocol.identity(page, context.cid) !== context.buyerUid) throw new Error('千牛买家与会话不一致');
      if ([...this.jobs.values()].some(t => t.pageId === page.pageId)) throw new Error('千牛客服通道正在处理其他请求');
      return await new Promise((resolve, reject) => {
        const id = randomUUID();
        const job = { id, kind, shopUid: context.shopUid, cid: context.cid, buyerUid: context.buyerUid,
          buyerNick: context.buyerNick, ...target, expiresAt: Date.now() + 300000 };
        const timer = setTimeout(() => { this.jobs.delete(id); reject(new Error('千牛转接通道超时，已提交操作需核对')); }, 315000);
        ticket = { page, pageId: page.pageId, job, sent: false, resolve, reject, timer };
        this.jobs.set(id, ticket);
      });
    } catch (error) {
      error.invoked = ticket?.sent === true;
      throw error;
    }
  }
}
