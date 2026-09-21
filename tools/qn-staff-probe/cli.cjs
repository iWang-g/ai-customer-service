'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { randomBytes, randomUUID } = require('node:crypto');
const { TARGET, buildReadRequest, sameContext, summarize, mergeStaff, diagnostic } = require('./protocol.cjs');
const { installStaffProbe } = require('./page.cjs');
const DIRECTORY = path.resolve(__dirname, '../../.tmp/qn-staff-probe');
const PORT = 18091;
function prepare() {
  fs.mkdirSync(DIRECTORY, { recursive: true });
  const file = path.join(DIRECTORY, 'config.json');
  const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8'))
    : { ...TARGET, base: 'http://127.0.0.1:' + PORT, token: randomBytes(32).toString('hex') };
  if (Object.entries(TARGET).some(([k, v]) => config[k] !== v) || config.base !== 'http://127.0.0.1:' + PORT ||
      !/^[a-f0-9]{64}$/.test(config.token)) throw new Error('Invalid probe config');
  fs.writeFileSync(file, JSON.stringify(config));
  fs.writeFileSync(path.join(DIRECTORY, 'page.js'), '(' + installStaffProbe.toString() + ')(window,' +
    JSON.stringify(config) + ',' + buildReadRequest.toString() + ');');
  console.log('Prepared staff read-only probe; queries are not enabled');
}
function createProbe(config, directory = DIRECTORY) {
  const pages = new Map(), accepted = new Set(), results = [], queue = [];
  let active = null, runPage = null, baseline = null, phase = 'idle';
  const resultFile = path.join(directory, 'run-' + new Date().toISOString().replace(/[:.]/g, '-') + '.ndjson');
  const snapshotFile = resultFile.replace(/\.ndjson$/, '.json');
  let summary = null;
  function recordTimeout() {
    if (active && Date.now() - active.started > 20000) {
      const record = { at: new Date().toISOString(), id: active.id, kind: active.kind, error: 'Query/result delivery timed out; no retry' };
      fs.appendFileSync(resultFile, JSON.stringify(record) + '\n'); results.push(record);
      active = null; queue.length = 0; phase = 'finished';
    }
  }
  const server = http.createServer(async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    const origin = req.headers.origin;
    if (req.headers.host !== '127.0.0.1:' + server.address().port || origin && origin !== 'https://alires-webui') return send(403, {});
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Methods', 'POST'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type'); return send(204, null); }
    if (req.method !== 'POST') return send(405, {});
    try {
      const chunks = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) return send(413, {}); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (body.token !== config.token) return send(403, {});
      recordTimeout();
      if (req.url === '/status' && !origin) return send(200, { phase, active: active?.kind, pages: [...pages.values()], results, summary, resultFile, snapshotFile });
      if (req.url === '/run' && !origin) {
        const live = [...pages.values()].filter(p => Date.now() - p.at < 5000);
        if (phase !== 'idle' || live.length !== 1) return send(409, { error: 'Need one fresh target page and unused run' });
        runPage = live[0].pageId; baseline = live[0].state; phase = 'running';
        queue.push({ id: randomUUID(), kind: 'list', pageNo: 1, shopUid: TARGET.shopUid, mainUid: TARGET.mainUid });
        return send(202, { queued: 1, plan: 'pages-until-short-page-then-status', maxPages: 20 });
      }
      if (req.url === '/stop' && !origin) { if (active) return send(409, { error: 'Query is still in flight' }); queue.length = 0; phase = 'finished'; return send(200, {}); }
      if (req.url === '/poll') {
        if (body.protocolVersion !== 2 || typeof body.pageId !== 'string' || !/^staff-[a-zA-Z0-9-]{1,90}$/.test(body.pageId)) return send(400, {});
        buildReadRequest({ id: 'validate', kind: 'list', shopUid: TARGET.shopUid, mainUid: TARGET.mainUid }, body.state || {});
        for (const [id, p] of pages) if (Date.now() - p.at > 30000) pages.delete(id);
        if (pages.size >= 10 && !pages.has(body.pageId)) return send(409, {});
        pages.set(body.pageId, { pageId: body.pageId, state: body.state, at: Date.now() });
        if (phase === 'finished') return send(200, { stop: true });
        if (body.pageId !== runPage || active || !queue.length) return send(200, {});
        if (!sameContext(body.state, baseline)) { phase = 'finished'; queue.length = 0; return send(200, { stop: true }); }
        const job = queue.shift(); active = { ...job, started: Date.now() }; return send(200, { job });
      }
      if (req.url === '/result') {
        if (body.pageId !== runPage) return send(409, {});
        if (accepted.has(body.id)) return send(200, { duplicate: true });
        if (!active || body.id !== active.id) return send(409, {});
        const { started: _started, ...job } = active;
        const record = { at: new Date().toISOString(), source: 'live-bridge', ...job };
        try {
          const r = body.result;
          if (!r?.ok || !sameContext(r.before, baseline) || !sameContext(r.before, r.after))
            throw new Error(r?.error || 'Context mismatch');
          Object.assign(record, summarize(r.raw, job, baseline), { contextUnchanged: true });
          if (job.kind === 'list') {
            const previousIds = new Set(results.filter(r => r.kind === 'list').flatMap(r => r.data?.result || []).map(a => String(a.subUserId)));
            if (record.data.result.some(a => previousIds.has(String(a.subUserId)))) throw new Error('Staff ID repeated across pages');
            if (job.pageNo >= 20 && record.accountCount === 5) throw new Error('Staff page limit reached; incomplete roster');
          }
        } catch (error) {
          record.error = String(error.message).slice(0, 240);
          const r = body.result;
          if (r?.ok && sameContext(r.before, baseline) && sameContext(r.before, r.after)) {
            try { record.diagnostic = diagnostic(r.raw, job, baseline); } catch { /* Unparseable replies remain failures. */ }
          }
        }
        fs.appendFileSync(resultFile, JSON.stringify(record) + '\n');
        accepted.add(body.id); results.push(record); active = null;
        if (!record.error && job.kind === 'list') {
          const next = record.accountCount === 5 ? { kind: 'list', pageNo: job.pageNo + 1 } : { kind: 'status' };
          queue.push({ id: randomUUID(), ...next, shopUid: TARGET.shopUid, mainUid: TARGET.mainUid });
        }
        if (!queue.length) {
          phase = 'finished';
          if (!record.error) {
            try { summary = mergeStaff(results); }
            catch (error) { summary = { error: error.message, paginationComplete: false }; }
            fs.writeFileSync(snapshotFile, JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
          }
        }
        console.log(JSON.stringify({ kind: job.kind, apiSuccess: record.apiSuccess, error: record.error, phase }));
        return send(200, {});
      }
      return send(404, {});
    } catch { return send(400, { error: 'Invalid probe request' }); }
  });
  server.requestTimeout = 10000;
  return server;
}
async function main() {
  const cmd = process.argv[2];
  if (cmd === 'prepare') return prepare();
  if (!['serve', 'status', 'run', 'stop'].includes(cmd)) throw new Error('Usage: cli.cjs prepare|serve|status|run|stop');
  const config = JSON.parse(fs.readFileSync(path.join(DIRECTORY, 'config.json'), 'utf8'));
  if (cmd === 'serve') {
    const server = createProbe(config);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(PORT, '127.0.0.1', resolve); });
    console.log('Staff probe listening on 18091; queries disabled until run'); return;
  }
  const response = await fetch(config.base + '/' + cmd, { method: 'POST', signal: AbortSignal.timeout(5000),
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: config.token }) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Probe command failed');
  console.log(JSON.stringify(result, null, 2));
}
module.exports = { createProbe };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
