'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { API, summarize } = require('./protocol.cjs');
const root = path.join(process.env.LOCALAPPDATA, 'QianniuTemp/32222303856223/Cache/Cache_Data');
const files = new Map();
function file(name) {
  if (!files.has(name)) {
    const target = path.join(root, name);
    if (fs.statSync(target).size > 64 * 1024 * 1024) throw new Error('Cache file too large');
    files.set(name, fs.readFileSync(target));
  }
  return files.get(name);
}
function stream(address, size) {
  if (!(address >>> 31) || size < 1 || size > 2 * 1024 * 1024) throw new Error('Invalid cache stream');
  const type = (address >>> 28) & 7;
  const block = { 2: 256, 3: 1024, 4: 4096 }[type];
  if (type !== 0 && !block) throw new Error('Unsupported cache block');
  const name = type === 0 ? 'f_' + (address & 0xfffffff).toString(16).padStart(6, '0') : 'data_' + ((address >>> 16) & 255);
  const buffer = file(name), start = type === 0 ? 0 : 8192 + (address & 65535) * block;
  if (start + size > buffer.length) throw new Error('Truncated cache stream');
  return buffer.subarray(start, start + size);
}
const buffer = file('data_1'), pages = new Map();
for (let offset = 8192; offset + 256 <= buffer.length; offset += 256) {
  try {
    const length = buffer.readInt32LE(offset + 32);
    if (length < 1 || length > 12000) continue;
    const longKey = buffer.readUInt32LE(offset + 36);
    const bytes = longKey ? stream(longKey, length) : buffer.subarray(offset + 96, offset + 96 + length);
    const match = bytes.toString('utf8').match(/https:\/\/[^\x00\s]+/);
    if (!match) continue;
    const url = new URL(match[0]);
    if (!['h5api.m.taobao.com', 'acs.m.taobao.com'].includes(url.hostname) || url.pathname !== '/h5/' + API + '/1.0/') continue;
    const params = JSON.parse(url.searchParams.get('data'));
    if (![1, 2].includes(params.pageNo) || params.pageSize !== 5) continue;
    let raw = stream(buffer.readUInt32LE(offset + 60), buffer.readInt32LE(offset + 44));
    if (raw[0] === 31 && raw[1] === 139) raw = zlib.gunzipSync(raw, { maxOutputLength: 2 * 1024 * 1024 });
    const page = summarize(raw.toString('utf8'), params.pageNo, params.pageSize);
    const requestTime = Number(url.searchParams.get('t'));
    if (!Number.isSafeInteger(requestTime) || requestTime < 1) continue;
    const old = pages.get(page.pageNo);
    if (!old || old.requestTime < requestTime) pages.set(page.pageNo, { source: 'historical-cache', requestTime, ...page });
  } catch { /* Cache entries may be evicted or incomplete while the client is running. */ }
}
const result = [...pages.values()].sort((a, b) => a.pageNo - b.pageNo);
if (!result.length) throw new Error('No verified cached product pages');
if (process.argv[2]) fs.writeFileSync(path.resolve(process.argv[2]), JSON.stringify(result, null, 2), { flag: 'wx' });
console.log(JSON.stringify(result.map(p => ({ pageNo: p.pageNo, count: p.products.length, total: p.total,
  requestTime: new Date(p.requestTime).toISOString(), productIds: p.products.map(item => item.productId) }))));
