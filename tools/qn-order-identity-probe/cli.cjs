'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { randomBytes, randomUUID, createHash } = require('node:crypto');
const { createProtocol } = require('./protocol.cjs');
const { installIdentityProbe } = require('./page.cjs');
const protocol = createProtocol();
const directory = path.resolve(__dirname, '../../.tmp/qn-order-identity-probe');
const configFile = path.join(directory, 'config.json');

function prepare() {
  fs.mkdirSync(directory, { recursive: true });
  const config = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) :
    { base: 'http://127.0.0.1:18094', token: randomBytes(32).toString('hex') };
  if (config.base !== 'http://127.0.0.1:18094' || !/^[a-f0-9]{64}$/.test(config.token)) throw Error('Invalid probe configuration');
  fs.writeFileSync(configFile, JSON.stringify(config));
  fs.writeFileSync(path.join(directory, 'page.js'), '(' + installIdentityProbe.toString() + ')(window,' +
    JSON.stringify(config) + ',' + createProtocol.toString() + ');');
  console.log('Prepared fixed read-only identity probe: ' + directory);
}

async function verifyLogin() {
  const base = 'http://127.0.0.1:18082/qn-bridge';
  const json = async (route, body) => {
    const response = await fetch(base + route, { signal: AbortSignal.timeout(5000), ...(body ? {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw Error('Login bridge unavailable');
    return response.json();
  };
  const { clients } = await json('/clients');
  const pages = clients.filter(c => c.state?.loginID?.targetId === protocol.shopUid &&
    (c.waiting || Date.now() - Date.parse(c.lastSeen) < 10000));
  if (pages.length !== 1 || pages[0].state.loginID.havMainId !== protocol.mainUid) throw Error('Login page is not unique');
  const { command } = await json('/command', { clientId: pages[0].clientId, cmd: 'getLoginuser', param: {} });
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    const { result } = await json('/results?commandId=' + encodeURIComponent(command.id));
    if (result) {
      if (!result.ok || result.clientId !== pages[0].clientId) throw Error('Login lookup failed');
      const login = typeof result.value === 'string' ? JSON.parse(result.value) : result.value;
      if (String(login?.sub_user_id || login?.user_id) !== protocol.shopUid || String(login?.user_id) !== protocol.mainUid ||
          login.user_nick?.replace(/^cntaobao/, '') !== '欧金金赛高') throw Error('Login binding mismatch');
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error('Login lookup timeout');
}

async function serve(config) {
  const { parseOrderJson, readVerifiedOrders } = await import('../../apps/desktop/electron/qianniu/order-reader.js');
  const pages = new Map();
  let active = null, running = false, finished = false, runPage = null, baseline = null, report = null;
  function query(stage, securityBuyerUid) {
    const job = { id: randomUUID(), stage, ...(securityBuyerUid ? { securityBuyerUid } : {}) };
    protocol.request(job);
    if (active) return Promise.reject(Error('Concurrent identity query refused'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { active = null; reject(Error('Identity page query timeout')); }, 18000);
      active = { job, resolve, reject, timer, sent: false };
    });
  }
  async function run() {
    report = { startedAt: new Date().toISOString(), shopUid: protocol.shopUid, mainUid: protocol.mainUid,
      buyerUid: protocol.buyerUid, buyerNick: 'tb3611370423', cid: protocol.cid,
      readOnly: true, source: 'independent-identity-probe', stages: [] };
    try {
      await verifyLogin();
      const base = { shopUid: protocol.shopUid, mainUid: protocol.mainUid, buyerUid: protocol.buyerUid, cid: protocol.cid };
      const snapshot = await readVerifiedOrders(base, 'cntaobao欧金金赛高', job => {
        if (job.method === protocol.summaryApi) return query('summary');
        if (job.method === protocol.tradeApi) return query('trade', job.params.securityBuyerUid);
        throw Error('Unexpected order query');
      }, async () => {
        const identity = protocol.identity(parseOrderJson(await query('forward')));
        protocol.identity(parseOrderJson(await query('reverse', identity)), true);
        report.identityRoundTripVerified = true;
        report.identityAppkey = protocol.appkey;
        report.identityFingerprint = createHash('sha256').update(identity).digest('hex');
        return { buyerUid: protocol.buyerUid, securityBuyerUid: identity };
      });
      report.snapshot = snapshot;
      report.contextUnchanged = true;
      report.targetSelected = baseline?.cid === protocol.cid;
      report.success = true;
    } catch (error) { report.success = false; report.error = error.message; }
    finally {
      running = false; finished = true; report.finishedAt = new Date().toISOString();
      const output = path.resolve(__dirname, '../../qianniu-test/order-identity-live-' + Date.now() + '.json');
      fs.writeFileSync(output, JSON.stringify(report, null, 2), { flag: 'wx' });
      console.log(JSON.stringify({ output, success: report.success, error: report.error,
        identityRoundTripVerified: report.identityRoundTripVerified, orderCount: report.snapshot?.orders.length }));
    }
  }
  const server = http.createServer(async (req, res) => {
    const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    const origin = req.headers.origin;
    if (req.headers.host !== '127.0.0.1:18094' || origin && origin !== 'https://alires-webui') return send(403, {});
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'POST'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      return send(204, null);
    }
    if (req.method !== 'POST') return send(405, {});
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 4 * 1024 * 1024) return send(413, {}); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (body.token !== config.token) return send(403, {});
      if (!origin && req.url === '/status') return send(200, { pages: [...pages.values()], running, finished, report });
      if (!origin && req.url === '/run') {
        const live = [...pages.values()].filter(p => Date.now() - p.at < 5000);
        if (running || finished || live.length !== 1) return send(409, { error: 'Need one fresh page and an unused run' });
        running = true; runPage = live[0].pageId; baseline = live[0].state;
        void run().catch(() => { finished = true; running = false; console.error('Probe report write failed'); });
        return send(202, { started: true });
      }
      if (typeof body.pageId !== 'string' || body.pageId.length > 100) return send(400, {});
      if (req.url === '/poll') {
        protocol.assertContext(body.state);
        pages.set(body.pageId, { pageId: body.pageId, state: body.state, at: Date.now() });
        if (finished) return send(200, { stop: true });
        if (!active || active.sent || body.pageId !== runPage) return send(200, {});
        if (JSON.stringify(body.state) !== JSON.stringify(baseline)) {
          const task = active; active = null; clearTimeout(task.timer); task.reject(Error('Context changed between stages'));
          return send(200, {});
        }
        active.sent = true;
        return send(200, { job: active.job });
      }
      if (req.url === '/result') {
        if (!active?.sent || body.pageId !== runPage || body.id !== active.job.id) return send(409, {});
        const task = active; active = null; clearTimeout(task.timer);
        const result = body.result;
        const record = { stage: task.job.stage, at: new Date().toISOString(), ok: Boolean(result?.ok) };
        report.stages.push(record);
        if (!result?.ok) task.reject(Error('Identity page stage failed: ' + task.job.stage));
        else if (JSON.stringify(result.before) !== JSON.stringify(baseline) ||
            JSON.stringify(result.after) !== JSON.stringify(baseline) || typeof result.raw !== 'string')
          task.reject(Error('Identity result context mismatch'));
        else {
          try {
            const raw = parseOrderJson(result.raw);
            // Persist only response shape/status. Never log the security ID or raw MTOP response.
            record.api = raw.api; record.returnCodes = Array.isArray(raw.ret) ? raw.ret.map(r => String(r).split('::')[0].replace(/[^A-Z_0-9]/g, '').slice(0,80)) : [];
            record.dataKeys = Object.keys(raw.data || {});
            record.businessCode = ['0', '1', '-1'].includes(raw.data?.code) ? raw.data.code : undefined;
            task.resolve(result.raw);
          } catch { task.reject(Error('Invalid identity JSON response')); }
        }
        return send(200, {});
      }
      send(404, {});
    } catch { send(400, {}); }
  });
  server.requestTimeout = 10000;
  server.listen(18094, '127.0.0.1', () => console.log('Read-only identity probe ready on 18094; awaiting explicit run'));
}
async function main() {
  const command = process.argv[2];
  if (command === 'prepare') return prepare();
  if (!['serve', 'status', 'run'].includes(command)) throw Error('Usage: cli.cjs prepare|serve|status|run');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  if (command === 'serve') return serve(config);
  const response = await fetch(config.base + '/' + command, { method: 'POST', signal: AbortSignal.timeout(5000),
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: config.token }) });
  const value = await response.json();
  if (!response.ok) throw Error(value.error || 'Probe command failed');
  console.log(JSON.stringify(value));
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
