import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { orderProbeScript } from '../electron/platform-workspace/douyin/order-probe.js';
import { buildOrderProbeReport } from '../electron/platform-workspace/douyin/order-probe-report.js';
import { mapDouyinOrders } from '../electron/platform-workspace/douyin/orders.js';

const orderId = '9007199254740993123';
const options = { shopId: '123', buyerId: 'private-buyer', conversationId: 'private-buyer:123::2:1:pigeon',
  requestToken: 'token', frameOrigin: 'https://im.jinritemai.com', buyerEvidence: 'security_src_user_id_matches' };
const body = `{"code":0,"total":2,"data":[{"order_id":${orderId},"shop_id":"123","security_user_id":"private-buyer",
  "order_status_desc":"待发货","aftersale_sum_status_desc":"无售后","actual_pay_amount":99,"pay_time_sec":0,
  "post_receiver":"private-recipient","mobile":"private-mobile","post_address":{"name":"private-address"},"token":"private-token",
  "sku_order_list":[{"product_id":"1","product_name":"private-product-A","sku_space_text":"尺寸甲"},
    {"product_id":"2","product_name":"private-product-B","sku_space_text":"尺寸乙"}]},
  {"order_id":"22","order_status_desc":"已发货","actual_pay_amount":100.5,"sku_order_list":[]}]}`;
const envelope = (text = body) => ({ body: text, httpStatus: 200, elapsedMs: 12, requestBinding: {
  token: 'token', shopId: options.shopId, buyerId: options.buyerId, conversationId: options.conversationId,
} });
const report = (input = envelope()) => buildOrderProbeReport(input, options);

const formalBody = () => ({ code: 0, page: 0, size: 5, data: [{ order_id: orderId,
  shop_id: options.shopId, security_user_id: options.buyerId, order_status_desc: '待支付',
  order_time_sec: 1789787342, pay_time_sec: 0, actual_pay_amount: 16500,
  mobile: 'private-mobile', sku_order_list: [
    { product_id: '11', sku_id: '21', sku_order_id: '31', product_name: '甲', sku_space_text: '规格甲', buy_num: 2, img: 'https://cdn.example.test/a.png' },
    { product_id: '12', sku_id: '22', sku_order_id: '32', product_name: '乙', sku_space_text: '规格乙', buy_num: 1 },
  ] }] });
const formal = (data = formalBody()) => mapDouyinOrders(envelope(JSON.stringify(data)), options);

test('formal orders preserve exact identities and multiple SKUs, omit amounts and personal details', () => {
  const value = formal();
  assert.equal(value.orders[0].platform_order_id, orderId);
  assert.equal(value.orders[0].products.length, 2);
  assert.equal(value.orders[0].products[0].quantity, 2);
  assert.equal(value.orders[0].raw_status, '待支付');
  assert.equal(value.orders[0].ordered_at, '2026-09-19T03:09:02.000Z');
  assert.ok(!JSON.stringify(value).includes('16500'));
  assert.ok(!JSON.stringify(value).includes('private-mobile'));
  assert.equal(value.query_coverage, 'first_page_only_unknown_total_and_sort');
  assert.deepEqual(formal({ code: 0, data: [] }).orders, []);
  // Response size semantics are still unknown; a bounded actual list is authoritative.
  const sizeVariant = formalBody(); sizeVariant.size = 1;
  assert.equal(formal(sizeVariant).orders.length, 1);
});

test('formal orders reject missing/mismatched identity, pagination, duplicate or excessive SKUs', () => {
  for (const change of [x => delete x.data[0].security_user_id, x => x.data[0].shop_id = 'wrong',
    x => x.data[0].security_user_id = 'another', x => x.page = 1, x => x.data[0].shop_id = undefined,
    x => x.data[0].sku_order_list = null, x => x.data[0].sku_order_list[0].sku_order_id = '32',
    x => x.data[0].sku_order_list[0].product_id = 'invalid',
    x => x.data[0].sku_order_list = Array.from({ length: 21 }, () => ({}))]) {
    const data = formalBody(); change(data); assert.throws(() => formal(data));
  }
  const data = formalBody(); data.data[0].sku_order_list[0].buy_num = true;
  data.data[0].sku_order_list[0].img = 'javascript:alert(1)';
  assert.equal(formal(data).orders[0].products[0].quantity, null);
  assert.equal(formal(data).orders[0].products[0].image_url, '');
});

test('diagnostics redact identifiers embedded in dynamic object keys and exclude component tree', () => {
  const data = formalBody();
  data.componentized_data = { [`shop_order_${orderId}`]: { nested: options.buyerId } };
  data.data[0][`sku_order_${orderId}`] = 'private-dynamic-value';
  const value = report(envelope(JSON.stringify(data))).report;
  assert.equal(value.version, 2);
  assert.deepEqual(value.responseShape.fields.componentized_data, { type: 'redacted' });
  assert.equal(value.pagination.page.type, 'number');
  assert.equal(value.orders[0].statusFields.order_status_desc.type, 'string');
  assert.equal(value.orders[0].timeFields.order_time_sec.type, 'number');
  for (const secret of [orderId, options.buyerId, 'private-dynamic-value']) assert.ok(!JSON.stringify(value).includes(secret));
});

test('order preview preserves long IDs, all SKU items and unconverted amounts; retained report omits private values', () => {
  const { report: value, preview } = report();
  assert.equal(value.requestAssociation, 'matched');
  assert.equal(value.orders[0].responseIdentity, 'explicit_buyer_matches');
  assert.equal(value.orders[1].responseIdentity, 'not_returned');
  assert.equal(value.orders[0].skuCount, 2);
  assert.equal(value.previewCount, 2);
  assert.match(preview[0], new RegExp(orderId));
  assert.match(preview[0], /尺寸甲/); assert.match(preview[0], /尺寸乙/);
  assert.match(preview[0], /actual_pay_amount：99（原始值，单位待核验）/);
  assert.match(preview[1], /actual_pay_amount：100.5/);
  assert.ok(!preview.join('').includes('1970'));
  for (const secret of [orderId, 'private-buyer', 'private-product-A', '尺寸甲', 'private-recipient', 'private-mobile', 'private-address', 'private-token'])
    assert.ok(!JSON.stringify(value).includes(secret), secret);
  for (const secret of ['private-recipient', 'private-mobile', 'private-address', 'private-token'])
    assert.ok(!preview.join('').includes(secret), secret);
  assert.equal(value.request.buyer.fingerprint, value.orders[0].identity.find((x) => x.path === 'security_user_id').value.fingerprint);
  assert.equal(value.orders[0].orderId.precision, 'source-preserved');
});

test('wrong shop, conflicting buyer and duplicate order IDs never enter preview', () => {
  for (const text of [body.replace('"shop_id":"123"', '"shop_id":"456"'),
    body.replace('"security_user_id":"private-buyer"', '"security_user_id":"other"'),
    body.replace('"order_id":"22"', `"order_id":${orderId}`)]) {
    const value = report(envelope(text));
    assert.ok(!value.preview.join('').includes('private-product-A'));
  }
  const root = report(envelope(body.replace('"code":0,', '"code":0,"security_user_id":"other",')));
  assert.equal(root.report.outcome, 'identity_conflict');
  assert.deepEqual(root.preview, []);
});

test('business failure, missing list, identity binding and explicit empty are different', () => {
  assert.equal(report(envelope('{"code":0,"data":[]}')).report.outcome, 'candidate_empty');
  for (const text of ['{"code":10005,"data":[]}', '{"code":0}', '{"code":0,"data":null}', 'not-json']) {
    const output = report(envelope(text));
    assert.equal(output.report.outcome, 'unavailable');
    assert.deepEqual(output.preview, []);
  }
  for (const change of [{ requestBinding: undefined }, { requestBinding: { ...envelope().requestBinding, token: 'old' } },
    { requestBinding: { ...envelope().requestBinding, buyerId: 'other' } }, { httpStatus: 403 }])
    assert.deepEqual(report({ ...envelope(), ...change }).preview, []);
  assert.equal(report({ error: 'identity_mismatch', body }).report.error, 'identity_mismatch');
});

test('unknown buyer UID namespace is diagnostic only; malformed SKU lists and large arrays remain bounded', () => {
  const data = { code: 0, data: [{ order_id: '1', uid: 'not-security-uid', sku_order_list:
    Array.from({ length: 100 }, () => ({ product_name: '长'.repeat(300), sku_space_text: '选项' })) }] };
  const output = report(envelope(JSON.stringify(data)));
  assert.equal(output.report.orders[0].responseIdentity, 'not_returned');
  assert.equal(output.report.orders[0].skusTruncated, true);
  assert.equal(output.report.previewTruncated, true);
  assert.ok(output.preview.join('').length <= 2400);
  data.data[0].sku_order_list = null;
  assert.match(report(envelope(JSON.stringify(data))).preview[0], /结构尚未识别/);
  data.data = Array.from({ length: 6 }, (_, i) => ({ order_id: String(i) }));
  assert.equal(report(envelope(JSON.stringify(data))).report.error, 'invalid_shape');
});

function harness(fetcher) {
  const window = { __PLATFORM_VARIABLES_IN_BENCH__: { extra: { im: {} } } };
  const calls = [];
  const context = vm.createContext({ window, location: { hostname: 'im.jinritemai.com' },
    AbortController, TextDecoder, setTimeout, clearTimeout,
    fetch: async (url, init) => { calls.push({ url, init }); return fetcher(url, init, calls.length); } });
  return { window, calls, run: (change = {}) => vm.runInContext(orderProbeScript({ action: 'read',
    token: 'token', shopId: options.shopId, buyerId: options.buyerId, conversationId: options.conversationId, ...change }), context) };
}
const ok = (url) => url.includes('currentuser') ? Response.json({ code: 0, data: { ShopId: '123' } }) : new Response(body);

test('one exact buyer order request between shop checks, no order operations or SDK calls', async () => {
  const h = harness(ok); const output = await h.run();
  assert.equal(output.body, body);
  assert.equal(h.calls.length, 3);
  const request = h.calls[1];
  assert.match(request.url, /\/backstage\/cmpoent\/order\/query\?biz_type=4/);
  assert.equal(request.init.redirect, 'error'); assert.equal(request.init.credentials, 'include');
  assert.deepEqual(JSON.parse(request.init.body), { security_user_id: 'private-buyer', page_no: 0, page_size: 5,
    tab_type: 0, search_words: '', is_init_tab: 0, biz_type: 2, version: '1.0', workstation_opt_version: 'v2',
    service_entity_id: '', workstation_opt_gray: true });
  assert.equal(h.window.__acsDouyinOrderProbeV1, undefined);
});

test('invalid conversation and missing SDK do not fetch; shop change discards raw orders', async () => {
  const h = harness(ok);
  assert.equal((await h.run({ conversationId: 'another:123::2:1:pigeon' })).error, 'invalid_command');
  delete h.window.__PLATFORM_VARIABLES_IN_BENCH__;
  assert.equal((await h.run()).error, 'im_not_ready');
  assert.equal(h.calls.length, 0);
  for (const after of [1, 3]) {
    const changed = harness((url, init, count) => count === after ? Response.json({ code: 0, data: { ShopId: '456' } }) : ok(url));
    const output = await changed.run();
    assert.equal(output.error, 'identity_mismatch'); assert.equal(output.body, undefined);
    assert.equal(changed.calls.length, after);
  }
});

test('cancel aborts query, busy is bounded, oversize response cannot be retained', async () => {
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const h = harness((url, init) => {
    if (url.includes('currentuser')) return ok(url);
    started();
    return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('private-error'))));
  });
  const pending = h.run(); await ready;
  assert.equal((await h.run()).error, 'busy');
  await h.run({ action: 'cancel' });
  const result = await pending;
  assert.equal(result.error, 'cancelled_or_timeout'); assert.ok(!JSON.stringify(result).includes('private-error'));
  const large = harness((url) => url.includes('currentuser') ? ok(url) : new Response('x'.repeat(512 * 1024 + 1)));
  assert.equal((await large.run()).error, 'response_too_large');
});
