'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSample, productId, cachePath } = require('./parse.cjs');
const { mergeMediaUpdate, mergeMessages } = require('./merge.cjs');
const sample = originalData => ({ message: { shopUid: '1', cid: 'sample', messageId: '123.PNM', text: '' }, originalData });

test('preserves text, image, product, and unknown nodes in order without repeating original.text', () => {
  const input = sample({ text: 'hello', jsview: [{ type: 0, value: { text: 'hello' } },
    { type: 7, value: { url: 'https://img.alicdn.com/test.jpg' } },
    { type: 5, value: { url: 'https://h5.m.taobao.com/awp/core/detail.htm?id=1234567890123456789&tracking=private',
      urlinfo: JSON.stringify({ title: 'Fixture product', imageUrl: '//img.alicdn.com/test.png', price: '30.0' }) } },
    { type: 999, value: { text: 'not a proven text node' } }] });
  const copy = structuredClone(input), parsed = parseSample(input);
  assert.deepEqual(parsed.parts.map(p => p.kind), ['text', 'image', 'product', 'unsupported']);
  assert.deepEqual(parsed.parts.map(p => p.index), [0, 1, 2, 3]);
  assert.equal(parsed.parts[2].productId, '1234567890123456789');
  assert.equal(parsed.parts[2].url, 'https://item.taobao.com/item.htm?id=1234567890123456789');
  assert.equal(parsed.parts[2].imageUrl, 'https://img.alicdn.com/test.png');
  assert.equal(parsed.parts[2].displayPrice, '30.0');
  assert.equal(parsed.parts[2].representation, 'resolved-link');
  assert.deepEqual(input, copy); assert.deepEqual(parseSample(input), parsed);
});

test('empty original data is an unsupported message, never dropped or merged with a neighboring product', () => {
  const parsed = parseSample(sample({}));
  assert.equal(parsed.messageId, '123.PNM');
  assert.deepEqual(parsed.parts, [{ index: null, kind: 'unsupported', reason: 'no-readable-original-data' }]);
  assert.equal(parseSample(sample({ text: 'fallback text' })).parts[0].text, 'fallback text');
  assert.equal(parsed.messageKind, 'customer');
});

test('classifies the observed template-129 companion as a system message', () => {
  const value = parseSample({ message: { messageId: 'system.PNM' }, nativeFields: { templateId: 129 }, originalData: {} });
  assert.equal(value.messageKind, 'system');
  assert.equal(value.parts[0].kind, 'unsupported');
});

test('media enrichment updates one message part idempotently and never creates a duplicate message', () => {
  const message = parseSample({ message: { shopUid: 's', cid: 'c', messageId: 'm' }, nativeFields: { templateId: 102 },
    originalData: { jsview: [{ type: 7, value: { url: 'https://img.alicdn.com/a.jpg' } }] } });
  const update = { mcode: { messageId: 'm' }, index: 0, update: { type: 7, value: { pic: 'pic:impicture|a?filepath=D%3A%5CAliWorkbenchData%5CNewAppData%5CmsgImage%5Caa%5Ca.jpg' } } };
  assert.equal(mergeMediaUpdate([message], update).reason, 'updated');
  assert.equal(message.parts.length, 1); assert.equal(message.parts[0].localPath.endsWith('a.jpg'), true);
  assert.equal(mergeMediaUpdate([message], update).reason, 'updated');
  assert.equal(mergeMediaUpdate([message], { ...update, mcode: { messageId: 'other' } }).applied, false);
  assert.equal(mergeMessages([message], [structuredClone(message)]).length, 1);
});

test('new product link type 1 transitions to resolved type 5 within the same message', () => {
  const input = sample({ jsview: [{ type: 1, value: { url: 'https://h5.m.taobao.com/awp/core/detail.htm?id=123' } }] });
  const first = parseSample(input);
  assert.equal(first.parts[0].productId, '123'); assert.equal(first.parts[0].representation, 'product-link');
  input.originalData.jsview[0].type = 5;
  input.originalData.jsview[0].value.urlinfo = '{"title":"Resolved fixture","price":"20.5"}';
  const enriched = parseSample(input);
  assert.equal(enriched.messageId, first.messageId); assert.equal(enriched.parts.length, 1);
  assert.equal(enriched.parts[0].representation, 'resolved-link');
  assert.equal(enriched.parts[0].title, 'Resolved fixture');
});

test('product classification requires a known item URL and tolerates invalid/missing metadata', () => {
  for (const url of ['https://example.com/?id=123', 'https://item.taobao.com.evil.test/item.htm?id=123',
    'https://item.taobao.com/other?id=123', 'https://item.taobao.com/item.htm?id=1&id=2',
    'https://item.taobao.com/item.htm?id=not-an-id', 'javascript:alert(1)']) assert.equal(productId(url), null);
  const parsed = parseSample(sample({ jsview: [{ type: 5, value: {
    url: 'https://item.taobao.com/item.htm?id=123', urlinfo: '{broken' } }] }));
  assert.equal(parsed.parts[0].kind, 'product'); assert.equal(parsed.parts[0].title, null);
  assert.equal(parsed.parts[0].metadataState, 'missing-or-invalid');
  assert.equal(parsed.parts[0].representation, 'product-link');
  const text = parseSample(sample({ text: 'https://item.taobao.com/item.htm?id=123' }));
  assert.equal(text.parts[0].kind, 'text');
});

test('resolves only allowed image cache paths, rejecting traversal, ADS and duplicate parameters', () => {
  const prefix = 'pic:impicture|fixture?filepath=';
  const allowed = 'D:\\AliWorkbenchData\\NewAppData\\msgImage\\aa\\sample.jpg';
  assert.equal(cachePath(prefix + encodeURIComponent(allowed)), allowed);
  for (const candidate of ['D:\\private.txt', 'D:\\AliWorkbenchData\\NewAppData\\msgImage\\..\\private.txt',
    'D:\\AliWorkbenchData\\NewAppData\\msgImage-other\\sample.jpg', allowed + ':stream', '\\\\server\\share\\sample.jpg'])
    assert.equal(cachePath(prefix + encodeURIComponent(candidate)), null);
  assert.equal(cachePath(prefix + encodeURIComponent(allowed) + '&filepath=' + encodeURIComponent(allowed)), null);
});

test('retains observed image metadata without claiming declared bytes equal cached bytes', () => {
  const input = sample({ width: 720, height: 1280, size: 247486, isOriginal: 1, fileId: 'fixture.jpg',
    jsview: [{ type: 7, value: { url: 'https://img.alicdn.com/fixture.jpg' } }] });
  const image = parseSample(input).parts[0];
  assert.equal(image.width, 720); assert.equal(image.height, 1280); assert.equal(image.declaredSize, 247486);
  assert.equal(image.isOriginal, true); assert.equal(image.localPath, null);
  input.originalData.jsview.push({ type: 7, value: {} });
  assert.equal(parseSample(input).parts[0].width, null);
});
