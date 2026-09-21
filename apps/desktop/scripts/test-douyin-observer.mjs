import assert from 'node:assert/strict';
import vm from 'node:vm';
import { observerScript } from '../electron/platform-workspace/douyin/observer.js';
import { DouyinObservationBuffer } from '../electron/platform-workspace/douyin/observation-buffer.js';

const context = vm.createContext({ window: {}, location: { hostname: 'im.jinritemai.com' },
  AbortController, AbortSignal, setTimeout, clearTimeout,
  fetch: async () => ({ ok: true, status: 200, json: async () => ({ code: 0, data: [] }) }),
});
const run = (script) => vm.runInContext(script, context);
run(`
  window.calls = 0;
  window.originalNext = function (...args) { window.nextThis = this; window.args = args; return 42; };
  window.originalSend = function () { window.calls++; return window.result; };
  window.im = { _message$: { next: window.originalNext }, sendText: window.originalSend };
  window.__PLATFORM_VARIABLES_IN_BENCH__ = { extra: { im: window.im } };
`);
const poll = () => run(observerScript({ action: 'poll', token: 'test' }));
await poll();
assert.equal(run('window.calls'), 0, 'installing observer must never send');
run('window.firstHook = window.im._message$.next');
await poll();
assert.equal(run('window.firstHook === window.im._message$.next'), true, 'no double wrapping');
await run(observerScript({ action: 'stop', token: 'obsolete-token' }));
assert.equal(run('window.firstHook === window.im._message$.next'), true, 'old lifecycle cannot stop new hooks');
assert.equal(run(`window.im._message$.next({content:'private-body', conversationId:'buyer:shop::2:1:pigeon',
  senderRole:'1', clientId:'client-1', messageId:{low:1,high:2097152,unsigned:true}, createTime: 1800000000000})`), 42);
assert.equal(run('window.nextThis === window.im._message$'), true);
let batch = await poll();
let message = batch.records.find((r) => r.kind === 'message');
assert.equal(message.value[0].messageId, '9007199254740993');
run(`window.result = Promise.resolve({messageId:'server-1', code:0});
  window.returned = window.im.sendText('buyer:shop::2:1:pigeon', 'private-body');`);
assert.equal(run('window.returned === window.result'), true, 'return original promise');
await run('window.result');
batch = await poll();
assert.ok(batch.records.some((r) => r.kind === 'send_resolved'));
assert.equal(run('window.calls'), 1);
run(`window.result = Promise.reject(new Error('private-error')); window.im.sendText('c', 'private-body');`);
await run('window.result.catch(() => {})');
batch = await poll();
assert.ok(batch.records.some((r) => r.kind === 'send_rejected'));
await run(observerScript({ action: 'stop' }));
assert.equal(run('window.im.sendText === window.originalSend'), true);
assert.equal(run('window.im._message$.next === window.originalNext'), true);
run(`window.failure = new Error('platform-error'); window.im._message$.next = function () {throw window.failure;};`);
await poll();
assert.equal(run(`(() => {try {window.im._message$.next('a')} catch(e) {return e === window.failure}})()`), true);
run(`window.oldIm = window.im;
  window.im = {_message$: {next() {return 7}}, sendText() {window.calls++}};
  window.__PLATFORM_VARIABLES_IN_BENCH__.extra.im = window.im;`);
await poll();
assert.equal(run(`(() => {try {window.oldIm._message$.next()} catch(e) {return e === window.failure}})()`), true);
run(`for (let i=0; i<125; i++) window.im._message$.next({messageId:String(i)});`);
batch = await poll();
assert.equal(batch.records.length, 20);
assert.ok(batch.dropped >= 25);
await run(observerScript({ action: 'stop' }));

const buffer = new DouyinObservationBuffer();
buffer.ingest({ records: [message, { kind: 'message', value: {
  content: 'private-body', nickname: 'private-name', cookie: 'private-cookie', token: 'private-token',
  sender: 'buyer', ShopId: 'shop', conversationId: 'buyer:shop::2:1:pigeon',
  messageId: '9007199254740993', senderRole: '1', ext: { 's:sender_biz_role': 'Buyer' },
  createTime: 1800000000000, unknown: 'private-extra', avatarUrl: 'https://private-host/path?token=secret',
} }] }, 'https://im.jinritemai.com/path?ticket=private-ticket');
const report = buffer.export();
const encoded = JSON.stringify(report);
for (const sensitive of ['private-', '9007199254740993', 'buyer:', 'shop:', 'private-host']) assert.ok(!encoded.includes(sensitive), sensitive);
const values = report.records[1].value;
assert.equal(values.senderRole, '1');
assert.equal(values.ext['s:sender_biz_role'], 'Buyer');
assert.equal(values.createTime, 1800000000000);
assert.equal(values.conversationId.split(':')[0], values.sender);
assert.equal(values.conversationId.split(':')[1], values.ShopId);
assert.equal(report.records[0].value[0].messageId, values.messageId, 'same IDs link across sources');
assert.notEqual(new DouyinObservationBuffer().redact('buyer', 'sender'), values.sender, 'per-session salt');

// Synthetic non-text payloads: these enum names are fixtures, not platform evidence.
await poll();
run(`window.im._message$.next({ content: '[商品]', type: 1000, ext: {
  type: 'fixture_product', displayType: '0', goods_id: 'private-product-id',
  generic_search_keywords: JSON.stringify({content:'private-product-title'}),
  msg_render_model: JSON.stringify({render_body: {title:'private-title',
    image: 'https://private-host/image?signature=private-signature',
    product_id:'private-product-id', price:15500, type:'private_nested_type',
    token:'private-token', items: [{label:'private-label'}], padding:'x'.repeat(5000)}}),
  imageUrl:'https://private-host/photo?token=private-token',
  get static_data() { throw new Error('must not execute SDK getters'); }
}});`);
batch = await poll();
const productRecord = batch.records.find((r) => r.kind === 'message');
assert.equal(productRecord.value[0].diagnosticPayloads['ext.msg_render_model'].parsing, 'json', 'parse JSON before string clipping');
assert.equal(productRecord.value[0].diagnosticPayloads['ext.static_data'], undefined, 'never invoke getters');
const nontext = new DouyinObservationBuffer();
nontext.ingest({records:[productRecord]}, 'https://im.jinritemai.com');
const product = nontext.export().records[0].value[0];
assert.equal(nontext.export().version, 2);
assert.equal(product.ext.type, 'fixture_product');
assert.equal(product.ext.displayType, '0');
assert.equal(product.content.marker, '[商品]');
const body = product.diagnosticPayloads['ext.msg_render_model'].shape.fields.render_body.fields;
assert.equal(body.title.type, 'string');
assert.equal(body.image.format, 'http-url');
assert.equal(body.price.type, 'number');
assert.equal(body.token.type, 'redacted');
assert.equal(body.items.type, 'array');
assert.equal(body.product_id.fingerprint, product.ext.goods_id.slice(3), 'structured IDs retain cross-field fingerprints');
for (const privateValue of ['private-', 'private_nested_type', '15500', 'https://']) {
  assert.ok(!JSON.stringify(product).includes(privateValue), `redact ${privateValue}`);
}
run(`window.im._message$.next({content:'[图片]', ext:{type:'fixture_image',
  imageUrl:'https://private-host/image', msg_render_model:'{bad-json', static_data:'x'.repeat(65537)}});`);
batch = await poll();
nontext.ingest(batch, 'https://im.jinritemai.com');
const picture = nontext.export().records.at(-1).value[0];
assert.equal(picture.content.marker, '[图片]');
assert.equal(picture.diagnosticPayloads['ext.imageUrl'].shape.format, 'http-url');
assert.equal(picture.diagnosticPayloads['ext.msg_render_model'].parsing, 'invalid-json');
assert.equal(picture.diagnosticPayloads['ext.static_data'].parsing, 'size-limit');
assert.equal(picture.diagnosticPayloads['ext.static_data'].shape, undefined);
assert.equal(nontext.redact('用户超时未回复，系统关闭会话', 'content').marker, '用户超时未回复，系统关闭会话');
assert.equal(nontext.redact('private-system-text', 'content').marker, undefined);
run(`window.im._message$.next({wrapperOnly: 'private-wrapper'});`);
batch = await poll();
assert.equal(batch.records.find((r) => r.kind === 'message').value[0].wrapperOnly, 'private-wrapper', 'unknown wrapper fallback stays intact');
await run(observerScript({action:'stop'}));
await run(observerScript({action:'poll', token:'collector-test', mode:'collector'}));
run(`window.im._message$.next({content:'[商品]',ext:{type:'fixture_product',
  msg_render_model:JSON.stringify({title:'private-title'})}});`);
batch = await run(observerScript({action:'poll', token:'collector-test', mode:'collector'}));
const collected = batch.records.find((r) => r.kind === 'message').value[0];
assert.equal(collected.diagnosticPayloads, undefined, 'business collection does not acquire diagnostic payloads');
assert.equal(collected.ext.msg_render_model, undefined);
assert.ok(JSON.stringify(collected.message_core).includes('private-title'), 'bounded visible rendering text is available to mapper');
run(`window.im._message$.next({content:'[订单卡片]',ext:{type:'template_card',static_data:JSON.stringify({
  title:'核心标题', token:'secret-token', buttons:[{text:'申请退款'}], list:Array.from({length:80},()=>({content:'x'.repeat(800)}))})}});`);
batch = await run(observerScript({action:'poll', token:'collector-test', mode:'collector'}));
const largeCore = batch.records.find((r) => r.kind === 'message').value[0].message_core;
assert.equal(largeCore.truncated, true, 'collector truncation evidence survives into mapper');
assert.ok(JSON.stringify(largeCore).length <= 4096);
assert.ok(!JSON.stringify(largeCore).includes('secret-token'));
const coreReport = new DouyinObservationBuffer();
coreReport.ingest(batch, 'https://im.jinritemai.com');
assert.ok(!JSON.stringify(coreReport.export()).includes('核心标题'), 'diagnostic export remains redacted');
await run(observerScript({action:'stop'}));

for (let i = 0; i < 400; i++) buffer.ingest({ records: [{ kind: 'message', value: {} }] }, 'https://im.jinritemai.com');
assert.equal(buffer.records.length, 300);
assert.ok(buffer.dropped > 0);
console.log('Douyin observer: passive hooks, Promise/exception identity, replacement, bounds and redaction passed');
