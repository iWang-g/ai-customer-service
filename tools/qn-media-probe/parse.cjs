'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateResult } = require('./server.cjs');
const CACHE_ROOT = 'D:\\AliWorkbenchData\\NewAppData\\msgImage';

function httpUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value.startsWith('//') ? 'https:' + value : value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
function productId(value) {
  const normalized = httpUrl(value);
  if (!normalized) return null;
  const url = new URL(normalized);
  const routes = { 'h5.m.taobao.com': '/awp/core/detail.htm', 'item.taobao.com': '/item.htm' };
  if (routes[url.hostname] !== url.pathname || url.port || url.searchParams.getAll('id').length !== 1) return null;
  const id = url.searchParams.get('id');
  return /^\d+$/.test(id) ? id : null;
}
function belowRoot(candidate) {
  const relative = path.win32.relative(CACHE_ROOT, candidate);
  return !!relative && relative !== '..' && !relative.startsWith('..\\') && !path.win32.isAbsolute(relative);
}
function cachePath(pic) {
  if (typeof pic !== 'string' || !/^pic:impicture\|[^?]+\?/.test(pic)) return null;
  const query = new URLSearchParams(pic.slice(pic.indexOf('?') + 1));
  if (query.getAll('filepath').length !== 1) return null;
  const value = query.get('filepath');
  if (!value || !/^[a-z]:[\\/]/i.test(value) || /[\x00-\x1f]/.test(value) || value.slice(2).includes(':')) return null;
  const resolved = path.win32.resolve(value);
  return belowRoot(resolved) ? resolved : null;
}
function positiveInt(value) { return Number.isSafeInteger(value) && value > 0 ? value : null; }
function money(value) { return typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? value : null; }

function parseSample(sample) {
  const original = sample.originalData && typeof sample.originalData === 'object' ? sample.originalData : {};
  const nodes = Array.isArray(original.jsview) ? original.jsview : [];
  const parts = nodes.map((node, index) => {
    const type = node?.type, value = node?.value || {};
    const base = { index, nativeNodeType: type ?? null };
    if (type === 0 && typeof value.text === 'string') return { ...base, kind: 'text', text: value.text };
    if (type === 1 || type === 5) {
      const id = productId(value.url);
      if (id) {
        let info = null;
        try { info = typeof value.urlinfo === 'string' ? JSON.parse(value.urlinfo) : null; } catch { /* Preserve the link when metadata is invalid. */ }
        const hasMetadata = !!info && typeof info === 'object' && !Array.isArray(info);
        return { ...base, kind: 'product', representation: hasMetadata ? 'resolved-link' : 'product-link', productId: id,
          url: 'https://item.taobao.com/item.htm?id=' + id,
          title: typeof info?.title === 'string' ? info.title : null,
          imageUrl: httpUrl(info?.imageUrl), displayPrice: money(info?.price),
          originalDisplayPrice: money(info?.originalPrice), metadataState: hasMetadata ? 'present' : 'missing-or-invalid' };
      }
      return { ...base, kind: 'unsupported', reason: 'unrecognized-link', url: httpUrl(value.url) };
    }
    if (type === 7) {
      // Top-level dimensions describe this sample only when it contains one image node.
      const single = nodes.length === 1;
      return { ...base, kind: 'image', url: httpUrl(value.url) || (single ? httpUrl(original.url) : null),
        localPath: cachePath(value.pic), mediaReference: typeof value.pic === 'string' ? value.pic : null,
        width: single ? positiveInt(original.width) : null, height: single ? positiveInt(original.height) : null,
        declaredSize: single ? positiveInt(original.size) : null,
        isOriginal: single && (original.isOriginal === 1 || original.isOriginal === 0) ? original.isOriginal === 1 : null,
        fileId: single && typeof original.fileId === 'string' ? original.fileId : null };
    }
    return { ...base, kind: 'unsupported', reason: 'unknown-node-type' };
  });
  if (!parts.length) {
    if (typeof original.text === 'string' && original.text) parts.push({ index: null, kind: 'text', text: original.text });
    else parts.push({ index: null, kind: 'unsupported', reason: 'no-readable-original-data' });
  }
  const messageKind = sample.nativeFields?.templateId === 129 ? 'system' : 'customer';
  return { ...sample.message, messageKind, parts };
}

function verifyCache(part) {
  if (part.kind !== 'image' || !part.localPath || !belowRoot(path.win32.resolve(part.localPath)))
    return { readable: false, reason: 'no-allowed-cache-path' };
  try {
    const real = fs.realpathSync.native(part.localPath);
    if (!belowRoot(real)) return { readable: false, reason: 'cache-path-escapes-root' };
    const stat = fs.statSync(real);
    if (!stat.isFile() || stat.size > 20 * 1024 * 1024) return { readable: false, reason: 'invalid-cache-file' };
    const bytes = fs.readFileSync(real);
    const jpeg = bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    return { readable: true, size: bytes.length, signature: jpeg ? 'jpeg' : 'other',
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      matchesDeclaredSize: part.declaredSize == null ? null : part.declaredSize === bytes.length };
  } catch (error) { return { readable: false, reason: error.code || 'cache-read-failed' }; }
}

function parseRecord(record) {
  if (!record.ok) throw new Error('probe did not complete successfully');
  validateResult(record.value);
  return { version: 1, target: record.value.target, before: record.value.before, after: record.value.after,
    messages: record.value.samples.map(parseSample), missingSampleIds: record.value.missingSampleIds };
}

if (require.main === module) {
  try {
    const [input, output] = process.argv.slice(2);
    if (!input || process.argv.length > 4) throw new Error('Usage: node tools/qn-media-probe/parse.cjs <sample.json> [parsed.json]');
    const parsed = parseRecord(JSON.parse(fs.readFileSync(path.resolve(input), 'utf8')));
    for (const message of parsed.messages) for (const part of message.parts) {
      if (part.kind === 'image') part.cache = verifyCache(part);
    }
    if (output) fs.writeFileSync(path.resolve(output), JSON.stringify(parsed, null, 2), { flag: 'wx' });
    console.log(JSON.stringify({ contextUnchanged: JSON.stringify(parsed.before) === JSON.stringify(parsed.after),
      targetSelected: parsed.before.cid === parsed.target.cid, missingSampleIds: parsed.missingSampleIds,
      messages: parsed.messages.map(message => ({ messageId: message.messageId, parts: message.parts.map(part => ({
        kind: part.kind, index: part.index, nativeNodeType: part.nativeNodeType, reason: part.reason,
        productId: part.productId, title: part.title, displayPrice: part.displayPrice,
        width: part.width, height: part.height, declaredSize: part.declaredSize, cache: part.cache })) })) }, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { parseSample, parseRecord, productId, cachePath, verifyCache };
