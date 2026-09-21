'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { TARGET, SAMPLE_IDS, assertTarget, validateMessageIds } = require('./inspect.js');
const directory = path.resolve(__dirname, '../../.tmp/qn-media-probe');

function buildPage(config) {
  const read = name => fs.readFileSync(path.resolve(__dirname, name), 'utf8');
  const script = '(function(){var module={exports:{}};\n' + read('../qn-read-messages-page.js') +
    '\nvar readerFactory=module.exports.createReader;\n' + read('inspect.js') +
    '\nvar inspector=module.exports;\n' + read('page.js') +
    '\nmodule.exports.start(window,inspector.createInspector(readerFactory,window),inspector.snapshot,' +
    JSON.stringify(config) + ');})();';
  new vm.Script(script);
  return script;
}

function initialize() {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'config.json');
  const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) :
    { base: 'http://127.0.0.1:18085', token: crypto.randomBytes(32).toString('hex') };
  if (config.base !== 'http://127.0.0.1:18085' || !/^[a-f0-9]{64}$/.test(config.token)) throw new Error('invalid probe config');
  fs.writeFileSync(file, JSON.stringify(config));
  fs.writeFileSync(path.join(directory, 'bundle.js'), buildPage(config));
  return config;
}

function validateResult(value) {
  if (!value || ![1, 2].includes(value.version) || value.target?.shopUid !== TARGET.shopUid || value.target?.cid !== TARGET.cid ||
      value.target?.mainUid !== TARGET.mainUid || value.method !== 'im.singlemsg.GetLocalHisMsg') throw new Error('invalid result identity');
  assertTarget(value.before); assertTarget(value.after);
  if (value.before.cid !== value.after.cid) throw new Error('context changed');
  const requested = value.version === 2 ? validateMessageIds(value.requestedMessageIds) : null;
  if (requested && (value.requireUnselected !== true || value.before.cid === TARGET.cid)) throw new Error('target conversation is selected');
  if (!Array.isArray(value.samples) || value.samples.length > (requested ? requested.length : 4)) throw new Error('invalid sample count');
  const ids = new Set(); let controls = 0;
  for (const sample of value.samples) {
    const message = sample.message;
    if (message?.shopUid !== TARGET.shopUid || message.cid !== TARGET.cid || !message.messageId || ids.has(message.messageId))
      throw new Error('invalid sample identity');
    ids.add(message.messageId);
    if (requested) {
      if (!requested.includes(message.messageId) || sample.role !== 'requested') throw new Error('sample outside requested IDs');
      continue;
    }
    if (!SAMPLE_IDS.includes(message.messageId) &&
        !(sample.role === 'text-control' && message.direction === 'incoming' && message.text && ++controls === 1))
      throw new Error('sample outside scope');
  }
  const missing = (requested || SAMPLE_IDS).filter(id => !ids.has(id));
  if (JSON.stringify(value.missingSampleIds) !== JSON.stringify(missing)) throw new Error('invalid missing sample IDs');
}

function createServer(config) {
  const pages = new Map(); let job = null;
  return http.createServer(async (req, res) => {
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    const origin = req.headers.origin;
    if (origin && origin !== 'https://alires-webui') return send(403, { error: 'origin rejected' });
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'POST'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      return send(204, null);
    }
    if (req.method !== 'POST') return send(405, { error: 'POST required' });
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length; if (size > 1024 * 1024) return send(413, { error: 'body too large' });
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (body.token !== config.token) return send(403, { error: 'unauthorized' });
      if (req.url === '/status') return send(200, { pages: [...pages.values()], job });
      if (req.url === '/poll') {
        assertTarget(body.state);
        if (typeof body.pageId !== 'string' || body.pageId.length > 100) throw new Error('invalid page id');
        pages.set(body.pageId, { pageId: body.pageId, state: body.state, probeVersion: body.probeVersion === 2 ? 2 : 1,
          ready: body.ready === true, lastSeen: Date.now() });
        if (job?.state === 'queued' && job.pageId === body.pageId && body.ready === true) {
          job.state = 'running'; job.startedAt = new Date().toISOString();
          return send(200, { job: { id: job.id, messageIds: job.messageIds } });
        }
        return send(200, { job: null });
      }
      if (req.url === '/arm') {
        if (job && ['queued', 'running'].includes(job.state)) throw new Error('probe already armed/running');
        const live = [...pages.values()].filter(p => p.ready && Date.now() - p.lastSeen < 10000);
        if (live.length !== 1) throw new Error('expected exactly one ready target page');
        job = { id: crypto.randomUUID(), state: 'queued', pageId: live[0].pageId };
        if (body.messageIds != null) {
          // Reject before publishing a job if the loaded page cannot retain new IDs.
          job = null;
          const messageIds = validateMessageIds(body.messageIds);
          if (live[0].probeVersion !== 2) throw new Error('media page reload required for new message IDs');
          if (live[0].state.cid === TARGET.cid) throw new Error('target conversation is selected');
          job = { id: crypto.randomUUID(), state: 'queued', pageId: live[0].pageId, messageIds };
        }
        return send(200, { job });
      }
      if (req.url === '/result') {
        if (!job || body.id !== job.id || body.pageId !== job.pageId || !['running', 'done'].includes(job.state))
          throw new Error('unexpected result');
        if (job.state === 'done') return send(200, { accepted: true });
        if (typeof body.result?.ok !== 'boolean') throw new Error('invalid result');
        if (body.result.ok) {
          validateResult(body.result.value);
          if (job.messageIds && (body.result.value.version !== 2 ||
              JSON.stringify(body.result.value.requestedMessageIds) !== JSON.stringify(job.messageIds)))
            throw new Error('result does not match dispatched message IDs');
        }
        const record = { at: new Date().toISOString(), id: job.id, ...body.result };
        fs.writeFileSync(path.join(directory, job.id + '.json'), JSON.stringify(record, null, 2), { flag: 'wx' });
        job.state = 'done'; job.ok = record.ok; job.output = path.join(directory, job.id + '.json');
        console.log(JSON.stringify({ id: job.id, ok: record.ok, samples: record.value?.samples?.length,
          missingSampleIds: record.value?.missingSampleIds, error: record.error }));
        return send(200, { accepted: true });
      }
      return send(404, { error: 'unknown route' });
    } catch (error) { send(400, { error: error.message }); }
  });
}

if (require.main === module) {
  const config = initialize();
  if (process.argv.includes('--prepare')) console.log('Media probe bundle prepared; no query armed.');
  else {
    const server = createServer(config);
    server.requestTimeout = 10000;
    server.listen(18085, '127.0.0.1', () => console.log('Media probe listening on 127.0.0.1:18085; disarmed.'));
  }
}
module.exports = { buildPage, validateResult, createServer };
