'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { randomBytes, randomUUID } = require('node:crypto');
const { installProductsProbe } = require('./page.cjs');
const { summarize } = require('./protocol.cjs');
const { summarizeDetail, PRODUCT_IDS } = require('./detail-protocol.cjs');
const detail = (process.argv[2] || '').startsWith('detail-');
const directory = path.resolve(__dirname, detail ? '../../.tmp/qn-product-details-probe' : '../../.tmp/qn-products-probe');
const configFile = path.join(directory, 'config.json');
function prepare() {
  fs.mkdirSync(directory, { recursive: true });
  const config = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : {
    base: detail ? 'http://127.0.0.1:18090' : 'http://127.0.0.1:18088', token: randomBytes(32).toString('hex'),
    shopUid: '2222303856223', mainUid: '2216058631944', cid: '2214525969878.1-2216058631944.1#11001@cntaobao',
  };
  if (detail) config.kind = 'detail';
  fs.writeFileSync(configFile, JSON.stringify(config));
  fs.writeFileSync(path.join(directory, 'page.js'), '(' + installProductsProbe.toString() + ')(window,' + JSON.stringify(config) + ');');
  console.log('Prepared standalone products probe in ' + directory);
}
function serve(config) {
  const port = detail ? 18090 : 18088;
  const pages = new Map(), results = [];
  let active = null, runPage = null, finished = false;
  const queue = [];
  const server = http.createServer(async (req, res) => {
    const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    const origin = req.headers.origin;
    if (req.headers.host !== '127.0.0.1:' + port || origin && origin !== 'https://alires-webui') return send(403, {});
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'POST'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type'); return send(204, null);
    }
    if (req.method !== 'POST') return send(405, {});
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 4 * 1024 * 1024) return send(413, {}); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (body.token !== config.token) return send(403, {});
      if (req.url === '/status' && !origin) return send(200, { pages: [...pages.values()], active: active?.id, finished, results });
      if (req.url === '/run' && !origin) {
        const live = [...pages.values()].filter(p => Date.now() - p.at < 5000);
        if (live.length !== 1 || active || queue.length || finished) return send(409, { error: 'Need one fresh target page and an unused probe run' });
        runPage = live[0].pageId;
        if (detail) {
          let identity;
          try { identity = require('./detail-cache.cjs').resolveDetailIdentity(); }
          catch { return send(409, { error: 'No unique detail buyer identity in target account cache' }); }
          for (const productId of PRODUCT_IDS) queue.push({ id: randomUUID(), shopUid: config.shopUid,
            mainUid: config.mainUid, ...identity, productId });
        } else for (const pageNo of [1, 2]) queue.push({ id: randomUUID(), shopUid: config.shopUid, mainUid: config.mainUid, cid: config.cid, pageNo, pageSize: 5 });
        return send(202, { queued: queue.length });
      }
      if (req.url === '/poll') {
        if (typeof body.pageId !== 'string' || body.pageId.length > 100 || body.state?.shopUid !== config.shopUid ||
            body.state?.mainUid !== config.mainUid || typeof body.state.cid !== 'string') return send(400, {});
        pages.set(body.pageId, { pageId: body.pageId, ...body.state, at: Date.now() });
        if (active && Date.now() - active.started > 20000) { queue.length = 0; active = null; finished = true; }
        if (finished) return send(200, { stop: true });
        if (active || body.pageId !== runPage || !queue.length) return send(200, {});
        const job = queue.shift(); active = { ...job, started: Date.now() };
        return send(200, { job });
      }
      if (req.url === '/result') {
        if (!active || body.id !== active.id || body.pageId !== runPage) return send(409, {});
        const result = body.result;
        const record = { at: new Date().toISOString(), source: 'live-bridge', shopUid: config.shopUid,
          mainUid: config.mainUid, ...(detail ? { productId: active.productId } : { pageNo: active.pageNo }) };
        try {
          if (!result?.ok || result.before?.shopUid !== config.shopUid || result.before?.mainUid !== config.mainUid ||
              typeof result.before?.cid !== 'string' || JSON.stringify(result.before) !== JSON.stringify(result.after)) throw new Error(result?.error || 'Context mismatch');
          Object.assign(record, detail ? summarizeDetail(result.raw, active.productId) : summarize(result.raw, active.pageNo), { contextUnchanged: true,
            targetSelected: result.before.cid === config.cid });
          if (!detail && results.length && (results[0].total !== record.total || results[0].products.some(p => record.products.some(q => p.productId === q.productId)))) {
            throw new Error('Page totals changed or products overlapped');
          }
        } catch (error) { record.error = error.message; queue.length = 0; }
        results.push(record); active = null; finished = !queue.length;
        fs.appendFileSync(path.join(directory, 'results.ndjson'), JSON.stringify(record) + '\n');
        console.log(JSON.stringify({ productId: record.productId, skuCount: record.skus?.length, pageNo: record.pageNo, count: record.products?.length, total: record.total, error: record.error, finished }));
        return send(200, {});
      }
      send(404, {});
    } catch { send(400, {}); }
  });
  server.requestTimeout = 10000;
  server.listen(port, '127.0.0.1', () => console.log('Products probe ready on ' + port + '; queries disabled until run command'));
}
async function main() {
  const command = detail ? process.argv[2].slice(7) : process.argv[2];
  if (command === 'prepare') return prepare();
  if (!['serve', 'status', 'run'].includes(command)) throw new Error('Usage: node tools/qn-products-probe/cli.cjs prepare|serve|status|run');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  if (command === 'serve') return serve(config);
  const response = await fetch(config.base + '/' + command, { method: 'POST', signal: AbortSignal.timeout(5000),
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: config.token }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Probe command failed');
  console.log(JSON.stringify(result));
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
