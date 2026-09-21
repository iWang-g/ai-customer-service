import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { productProbeScript } from '../electron/platform-workspace/douyin/product-probe.js';
import { buildProductProbeReport } from '../electron/platform-workspace/douyin/product-probe-report.js';
import { mapDouyinProducts } from '../electron/platform-workspace/douyin/products.js';

const body = '{"code":0,"total":21,"data":[{"product_item":{"product_id":3830227192483283126,"product_base_info":{"title":"private-title","main_img":"https://cdn.example.test/img?signature=private-token","price":15500}},"token":"private-credential"}]}';
const reportFor = (text = body, httpStatus = 200) => buildProductProbeReport({ body: text, httpStatus }, { frameOrigin: 'https://pigeon.jinritemai.com' });
function harness(fetcher, extra = {}) {
  const calls = [];
  const window = { __PLATFORM_VARIABLES_IN_BENCH__: { extra: { im: { sendText() { throw new Error('must not send'); } } } } };
  const context = vm.createContext({ window, location: { hostname: 'pigeon.jinritemai.com' },
    AbortController, TextDecoder, setTimeout, clearTimeout,
    fetch: async (url, options) => { calls.push({ url, options }); return fetcher(url, options, calls.length); }, ...extra });
  const run = (command = {}) => vm.runInContext(productProbeScript({ action: 'read', token: 'one', shopId: '123', ...command }), context);
  return { run, calls, window };
}
const identity = () => Response.json({ code: 0, data: { ShopId: '123' } });

test('list mapping selects nested fields, preserves IDs and excludes unverified prices and payloads', () => {
  const source = body.replace('"total":21', '"total":1');
  const result = mapDouyinProducts({ body: source, httpStatus: 200 });
  assert.equal(result.products[0].product_id, '3830227192483283126');
  assert.equal(result.products[0].title, 'private-title');
  assert.equal(result.products[0].price, undefined);
  assert.deepEqual(result.products[0].raw_payload, {});
  assert.equal(result.page_summary.has_more, false);
  assert.throws(() => mapDouyinProducts({ body, httpStatus: 200 }), /条数/);
  assert.equal(mapDouyinProducts({ body: '{"code":0,"total":0,"data":[]}', httpStatus: 200 }).collection_status, 'empty');
  const unsafe = source.replace('https://cdn.example.test/img?signature=private-token', 'javascript:alert(1)');
  assert.equal(mapDouyinProducts({ body: unsafe, httpStatus: 200 }).products[0].image_url, null);
  const mismatch = source.replace('"title":"private-title"', '"product_id":"99","title":"private-title"');
  assert.throws(() => mapDouyinProducts({ body: mismatch, httpStatus: 200 }), /身份/);
});

test('display price preserves platform text without converting amounts or using marketing labels', () => {
  const mapPrice = (display) => {
    const source = JSON.parse(body.replace('"total":21', '"total":1'));
    source.data[0].product_item.product_id = '3830227192483283126';
    source.data[0].product_item.marketing_info = { price: { effective_min_price: 1, origin_price: 999999 },
      marketing_price_prefix: 'unverified', show_product_marketing_info: { show_sku_info: {
        show_price: { show_price: display },
      } } };
    return mapDouyinProducts({ body: JSON.stringify(source), httpStatus: 200 }).products[0];
  };
  for (const [display, expected] of [
    [{ price_prefix: '¥', show_amount: '155.00', price_suffix: '', amount: 1, price_label: { text: 'unverified' } }, '¥155.00'],
    [{ price_prefix: '¥', show_amount: '99.00–155.00', price_suffix: '起' }, '¥99.00–155.00起'],
    [{ show_amount: '0.00' }, '0.00'],
    [{ show_amount: '1'.repeat(64) }, '1'.repeat(64)],
    [{ show_amount: '1'.repeat(65) }, null],
    [{ show_amount: '' }, null], [{ show_amount: '  ' }, null], [{ amount: 15500 }, null],
    [{ show_amount: 155 }, null], [{ show_amount: '155', price_prefix: {} }, null],
    [{ show_amount: '155', price_suffix: [] }, null], [{ show_amount: '155\n00' }, null],
    [{ show_amount: '\u202e155' }, null],
  ]) {
    const product = mapPrice(display);
    assert.equal(product.price_label, expected);
    assert.equal(product.price, undefined);
    assert.equal(product.product_id, '3830227192483283126');
    assert.deepEqual(product.raw_payload, {});
  }
});

test('long numeric IDs remain exact in preview; report exports shapes without scalar data', () => {
  const { report, preview } = reportFor();
  assert.equal(report.outcome, 'candidate_success');
  assert.equal(report.total, 21);
  assert.match(preview[0], /3830227192483283126/);
  assert.equal(report.idSamples[0].value.type, 'number');
  assert.equal(report.idSamples[0].value.precision, 'source-preserved');
  const exported = JSON.stringify(report);
  for (const secret of ['private-title', 'private-token', 'private-credential', '3830227192483283126', '15500', 'https://cdn']) {
    assert.ok(!exported.includes(secret), secret);
  }
  assert.equal(report.responseShape.fields.data.items[0].fields.token.type, 'redacted');
  assert.notEqual(reportFor().report.idSamples[0].value.fingerprint, report.idSamples[0].value.fingerprint);
});

test('malformed/denied/ambiguous responses cannot be reported as empty shops', () => {
  assert.equal(reportFor('<html>private login</html>').report.error, 'invalid_json');
  assert.equal(reportFor('<html>private login</html>', 403).report.error, 'http_error');
  assert.equal(reportFor('{"code":10005,"data":[]}').report.error, 'business_error');
  assert.equal(reportFor('{"code":"0","total":0,"data":[]}').report.error, 'business_error');
  assert.equal(reportFor('{"code":0,"total":0,"data":{}}').report.error, 'invalid_shape');
  assert.equal(reportFor('{"code":0,"data":[]}').report.error, 'invalid_total');
  assert.equal(reportFor('{"code":0,"total":20,"data":[]}').report.error, 'invalid_total');
  assert.equal(reportFor('{"code":0,"total":0,"data":[]}').report.outcome, 'candidate_empty');
});

test('string and numeric ID types, duplicates, unsupported numeric formats and sample limits', () => {
  const stringId = reportFor(body.replace('3830227192483283126', '"3830227192483283126"'));
  assert.equal(stringId.report.idSamples[0].value.type, 'string');
  assert.equal(reportFor(body.replace('3830227192483283126', '3.830227192483283126e18')).report.error, 'invalid_products');
  const row = { product_item: { product_id: '123' } };
  assert.equal(reportFor(JSON.stringify({ code: 0, total: 2, data: [row, row] })).report.error, 'invalid_products');
  assert.equal(reportFor(JSON.stringify({ code: 0, total: 21, data: Array(21).fill(row) })).report.error, 'invalid_shape');
  const long = { ...row, extra: Array(40).fill({ nested: Array(40).fill('private') }) };
  const report = reportFor(JSON.stringify({ code: 0, total: 1, data: [long] })).report;
  assert.equal(report.truncated, true);
  assert.ok(JSON.stringify(report).length < 200000);
  assert.equal(reportFor(' '.repeat(512 * 1024 + 1)).report.error, 'response_too_large');
});

test('SKU-heavy pages preserve essential fields for every product despite recursive truncation', () => {
  const data = Array.from({ length: 16 }, (_, index) => ({ product_id: '', product_name: '', img: '', product_item: {
    product_id: `38302271924832831${String(index).padStart(2, '0')}`,
    product_base_info: { title: `private-title-${index}`, main_img: 'https://cdn.example.test/private-url',
      skus: Array.from({ length: 20 }, () => ({ properties: Array(20).fill({ name: 'private-property' }) })) },
    marketing_info: { show_product_marketing_info: { show_sku_info: { show_price: {
      show_price: { amount: 15500, show_amount: '155.00', price_prefix: '¥', price_suffix: '',
        price_type: 'private-enum', price_label: 'private-label' },
    } } } },
  } }));
  const { report } = reportFor(JSON.stringify({ code: 0, total: 16, data }));
  assert.equal(report.version, 2);
  assert.equal(report.outcome, 'candidate_success');
  assert.equal(report.truncated, true);
  assert.equal(report.idSamples.length, 16);
  assert.equal(report.productSamples.length, 16);
  for (let i = 0; i < 16; i++) {
    assert.equal(report.idSamples[i].value.type, 'string');
    assert.equal(report.idSamples[i].value.length, 19);
    const fields = report.productSamples[i].fields;
    assert.equal(fields['product_item.product_base_info.title'].length, `private-title-${i}`.length);
    assert.equal(fields['product_item.product_base_info.main_img'].format, 'http-url');
    assert.equal(fields['product_item.product_base_info.product_id'].type, 'missing');
    assert.equal(fields['product_item.marketing_info.show_product_marketing_info.show_sku_info.show_price.show_price.show_amount'].type, 'string');
  }
  const exported = JSON.stringify(report);
  assert.ok(!exported.includes('private-'));
  assert.ok(!exported.includes('38302271924832831'));
  assert.ok(!exported.includes('155.00'));
  assert.ok(!exported.includes('15500'));
  assert.ok(exported.length < 600000);
});

test('one fixed first-page request between two identity reads; message SDK is untouched', async () => {
  const h = harness(async (url) => url.includes('currentuser') ? identity() : new Response(body));
  const im = h.window.__PLATFORM_VARIABLES_IN_BENCH__.extra.im;
  const result = await h.run();
  assert.equal(result.body, body);
  assert.equal(h.calls.length, 3);
  const request = h.calls[1];
  assert.ok(request.url.startsWith('https://pigeon.jinritemai.com/backstage/workstation/get_product_list?'));
  const params = JSON.parse(request.options.body);
  assert.equal(params.page_no, 0);
  assert.equal(params.page_size, 20);
  assert.equal(params.user_id, '');
  assert.equal(params.presale_biz_scene, 'b_product_list');
  assert.equal(request.options.credentials, 'include');
  assert.equal(request.options.redirect, 'error');
  assert.equal(h.window.__PLATFORM_VARIABLES_IN_BENCH__.extra.im, im);
  assert.equal(h.window.__acsDouyinProductProbeV1, undefined);
});

test('identity mismatch prevents product requests, including unsafe numeric shop IDs', async () => {
  for (const ShopId of ['other', 9007199254740992]) {
    const h = harness(async () => Response.json({ code: 0, data: { ShopId } }));
    assert.equal((await h.run()).error, 'identity_mismatch');
    assert.equal(h.calls.length, 1);
  }
});

test('identity change after request discards all response data', async () => {
  const h = harness(async (_url, _options, n) => n === 1 ? identity() : n === 2
    ? new Response(body) : Response.json({ code: 0, data: { ShopId: 'other' } }));
  const result = await h.run();
  assert.equal(result.error, 'identity_mismatch');
  assert.equal(result.body, undefined);
});

test('single in-flight request; token cancellation aborts fetch without raw error export', async () => {
  let started;
  const waiting = new Promise((resolve) => { started = resolve; });
  const h = harness(async (url, options) => {
    if (url.includes('currentuser')) return identity();
    started();
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('private-cookie'))));
  });
  const pending = h.run();
  await waiting;
  assert.equal((await h.run({ token: 'two' })).error, 'busy');
  await h.run({ action: 'cancel', token: 'wrong' });
  assert.equal(h.window.__acsDouyinProductProbeV1.controller.signal.aborted, false);
  await h.run({ action: 'cancel' });
  const result = await pending;
  assert.equal(result.error, 'cancelled_or_timeout');
  assert.ok(!JSON.stringify(result).includes('private-cookie'));
});

test('response size cap and fetch deadline bound diagnostic requests', async () => {
  const h = harness(async (url) => url.includes('currentuser') ? identity() : new Response('x'.repeat(512 * 1024 + 1)));
  assert.equal((await h.run()).error, 'response_too_large');
  const timed = harness(async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('timeout')));
  }), { setTimeout: (callback) => setTimeout(callback, 5) });
  assert.equal((await timed.run()).error, 'cancelled_or_timeout');
});

test('foreign origin, missing SDK and forged command never fetch', async () => {
  const foreign = harness(async () => identity(), { location: { hostname: 'example.test' } });
  assert.equal((await foreign.run()).error, 'invalid_origin');
  assert.equal(foreign.calls.length, 0);
  const h = harness(async () => identity());
  assert.equal((await h.run({ action: 'unknown' })).error, 'invalid_command');
  delete h.window.__PLATFORM_VARIABLES_IN_BENCH__;
  assert.equal((await h.run()).error, 'im_not_ready');
  assert.equal(h.calls.length, 0);
});
