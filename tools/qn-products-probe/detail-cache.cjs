'use strict';
// Offline evidence only: never replay cached URLs, credentials, or signatures.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { parse } = require('./protocol.cjs');
const { API, PRODUCT_IDS, summarizeDetail } = require('./detail-protocol.cjs');
const root = path.join(process.env.LOCALAPPDATA, 'QianniuTemp/32222303856223/Cache/Cache_Data');
const files = new Map();
function file(name) {
  if (!files.has(name)) {
    const target = path.join(root, name);
    if (fs.statSync(target).size > 64 * 1024 * 1024) throw new Error('Cache too large');
    files.set(name, fs.readFileSync(target));
  }
  return files.get(name);
}
function stream(address, size) {
  if (!(address >>> 31) || size < 1 || size > 2 * 1024 * 1024) throw new Error('Invalid stream');
  const type = (address >>> 28) & 7, block = { 2: 256, 3: 1024, 4: 4096 }[type];
  if (type !== 0 && !block) throw new Error('Unsupported stream');
  const name = type === 0 ? 'f_' + (address & 0xfffffff).toString(16).padStart(6, '0') : 'data_' + ((address >>> 16) & 255);
  const buffer = file(name), start = type === 0 ? 0 : 8192 + (address & 65535) * block;
  if (start + size > buffer.length) throw new Error('Truncated stream');
  return buffer.subarray(start, start + size);
}
function shape(value, depth = 0) {
  if (depth > 6) return Array.isArray(value) ? 'array' : typeof value;
  if (Array.isArray(value)) return { length: value.length, sample: value.length ? shape(value[0], depth + 1) : null };
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 100).map(([k,v]) => [k, shape(v, depth + 1)]));
  return value === null ? 'null' : typeof value;
}
function scanDetails() {
const buffer = file('data_1'), records = [];
for (let offset = 8192; offset + 256 <= buffer.length; offset += 256) {
  try {
    const length = buffer.readInt32LE(offset + 32);
    if (length < 1 || length > 12000) continue;
    const longKey = buffer.readUInt32LE(offset + 36);
    if (!longKey && offset + 96 + length > buffer.length) continue;
    const bytes = longKey ? stream(longKey, length) : buffer.subarray(offset + 96, offset + 96 + length);
    const match = bytes.toString('utf8').match(/https:\/\/[^\x00\s]+/);
    if (!match) continue;
    const url = new URL(match[0]);
    if (!['h5api.m.taobao.com', 'acs.m.taobao.com'].includes(url.hostname) ||
        url.pathname !== '/h5/' + API + '/1.0/') continue;
    const params = JSON.parse(url.searchParams.get('data'));
    let raw = stream(buffer.readUInt32LE(offset + 60), buffer.readInt32LE(offset + 44));
    if (raw[0] === 31 && raw[1] === 139) raw = zlib.gunzipSync(raw, { maxOutputLength: 2 * 1024 * 1024 });
    const response = parse(raw.toString('utf8'));
    const at = Number(url.searchParams.get('t'));
    records.push({ source: 'historical-cache', api: url.pathname.split('/')[2], version: url.pathname.split('/')[3],
      requestedAt: Number.isSafeInteger(at) && at > 0 ? new Date(at).toISOString() : null,
      parameterKeys: Object.keys(params), productId: String(params.itemId || params.id || ''),
      success: Array.isArray(response.ret) && response.ret.some(s => typeof s === 'string' && s.startsWith('SUCCESS::')),
      structure: shape(response.data), cacheEntryOffset: offset,
      details: PRODUCT_IDS.includes(String(params.itemId)) && response.data?.item ? summarizeDetail(raw.toString('utf8'), String(params.itemId)) : null });
  } catch { /* Skip incomplete live-cache entries; no response or request secrets are logged. */ }
}
records.sort((a,b) => (b.requestedAt || '').localeCompare(a.requestedAt || ''));
return records;
}
function resolveDetailIdentity() {
  const cid = '2214525969878.1-2216058631944.1#11001@cntaobao';
  const keys = file('data_1').toString('latin1'), identities = new Set();
  for (const match of keys.matchAll(/https:\/\/[^\x00\s]+/g)) {
    try {
      const url = new URL(match[0]);
      if (!['h5api.m.taobao.com', 'acs.m.taobao.com'].includes(url.hostname) || url.pathname !== '/h5/' + API + '/1.0/') continue;
      const p = JSON.parse(url.searchParams.get('data'));
      if (p._message_cid === cid && p.isNewCustomer === true && PRODUCT_IDS.includes(String(p.itemId)) &&
          typeof p.encryptId === 'string' && /^[a-zA-Z0-9_-]{8,256}$/.test(p.encryptId)) identities.add(p.encryptId);
    } catch { /* Only use exact, unambiguous account/CID/API matches. */ }
  }
  if (identities.size !== 1) throw new Error('No unique cached detail buyer identity');
  return { encryptId: [...identities][0], isNewCustomer: true, cid };
}
module.exports = { scanDetails, resolveDetailIdentity };
if (require.main === module) {
  const records = scanDetails();
  if (process.argv[2]) fs.writeFileSync(path.resolve(process.argv[2]), JSON.stringify(records, null, 2), { flag: 'wx' });
  console.log(JSON.stringify(records.map(r => ({ api: r.api, productId: r.productId, requestedAt: r.requestedAt,
    success: r.success, skus: r.details?.skus.length, services: r.details?.services.length })), null, 2));
}
