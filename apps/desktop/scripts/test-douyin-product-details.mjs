import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { productProbeScript } from '../electron/platform-workspace/douyin/product-probe.js';
import { buildProductDetailProbeReport } from '../electron/platform-workspace/douyin/product-detail-probe-report.js';
import { productDetailLinkReport } from '../electron/platform-workspace/douyin/product-detail-link-report.js';
import { mapDouyinProductDetail } from '../electron/platform-workspace/douyin/product-details.js';

const pid = '3830227192483283126';
const list = `{"code":0,"total":1,"data":[{"product_item":{"product_id":${pid},"shop_id":"123","product_base_info":{"title":"private-title"}}}]}`;
const specifications = `{"code":0,"data":{"product_info":{"product_id":${pid},"spec_detail_info":[{"name":"尺寸","spec_details":[{"name":"40×120"},{"name":"50×150"}]}]}}}`;
const attributes = `{"status_code":0,"detail_info":{"product_id":${pid},"token":"private-token","product_format":[{"format":[{"name":"材质","message":[{"desc":"棉"},{"desc":"混纺"}]}]},{"format":[{"name":"包装","message":[{"desc":"独立包装"}]}]}],"detail_imgs_new":[{"url":"https://private.test/?signature=secret"}]}}`;
const response = (body) => ({ body, httpStatus: 200, elapsedMs: 12, requestBinding: {
  token: 'one', productId: pid, shopId: '123', source: body.includes('spec_detail_info') ? 'specifications' : 'attributes',
} });
const result = (overrides = {}) => ({ ...response(list), specifications: response(specifications), attributes: response(attributes), ...overrides });
const report = (input = result()) => buildProductDetailProbeReport(input,
  { productId: pid, shopId: '123', frameOrigin: 'https://pigeon.jinritemai.com', requestToken: 'one' });

function formalInput() {
  const data = JSON.parse(specifications);
  data.data.product_info.product_id = pid;
  data.data.product_info.spec_detail_info[0].spec_details.forEach((entry, i) => { entry.id = String(i + 1); });
  data.data.items = [{ sku_id: '11', product_id: pid, spec_detail_id1: '2',
    spec_name1: '尺寸', spec_detail_name1: '50×150', price: 999, stock_num: 77 }];
  const attr = JSON.parse(attributes); delete attr.detail_info.product_id;
  return result({ specifications: response(JSON.stringify(data)), attributes: response(JSON.stringify(attr)) });
}
const formal = (input = formalInput()) => mapDouyinProductDetail(input,
  { productId: pid, shopId: '123', requestToken: 'one' });

test('formal detail preserves actual SKU combinations and admits request-associated attributes without ID echo', () => {
  const detail = formal();
  assert.equal(detail.product_id, pid);
  assert.equal(detail.specifications.skus.length, 1, 'never synthesize the other dimension option');
  assert.deepEqual(detail.specifications.skus[0].attributes, [{ name: '尺寸', value: '50×150' }]);
  assert.equal(detail.attributes.response_identity, 'not_returned');
  assert.equal(detail.attributes.entries.length, 2);
  for (const secret of ['price', 'stock_num', 'private-token', 'detail_imgs', 'requestBinding', 'jump_url'])
    assert.ok(!JSON.stringify(detail).includes(secret), secret);
});

test('formal attributes fail independently; specification identity and real SKU associations are required', () => {
  const input = formalInput();
  input.attributes = { error: 'cancelled_or_timeout' };
  assert.equal(formal(input).attributes, null);
  assert.equal(formal(input).specifications.skus.length, 1);
  for (const mutate of [
    (data) => { data.data.items[0].product_id = '999'; },
    (data) => { data.data.items[0].spec_detail_id1 = '999'; },
    (data) => { data.data.items[0].spec_detail_name1 = 'wrong'; },
    (data) => { data.data.items.push(data.data.items[0]); },
    (data) => { delete data.data.product_info.product_id; },
  ]) {
    const bad = formalInput(); const data = JSON.parse(bad.specifications.body); mutate(data);
    bad.specifications = response(JSON.stringify(data));
    assert.throws(() => formal(bad));
  }
  const conflict = formalInput(); conflict.attributes.body = conflict.attributes.body.replace('"detail_info":{', '"detail_info":{"product_id":"999",');
  assert.equal(formal(conflict).attributes, null);
  const unbound = formalInput(); unbound.specifications.requestBinding.token = 'other';
  assert.throws(() => formal(unbound));
});

function harness(fetcher) {
  const calls = [];
  const window = { __PLATFORM_VARIABLES_IN_BENCH__: { extra: { im: {} } } };
  const context = vm.createContext({ window, location: { hostname: 'pigeon.jinritemai.com' },
    AbortController, TextDecoder, setTimeout, clearTimeout,
    fetch: async (url, options) => { calls.push({ url, options }); return fetcher(url, options, calls.length); } });
  return { calls, window, run: (command = {}) => vm.runInContext(productProbeScript({
    action: 'read', token: 'one', shopId: '123', productId: pid, ...command }), context) };
}
function fetchSuccess(url) {
  return url.includes('currentuser') ? Response.json({ code: 0, data: { ShopId: '123' } })
    : new Response(url.includes('get_product_list') ? list : url.includes('get_skuinfo_list') ? specifications : attributes);
}

test('detail preview preserves IDs and every attribute group; retained diagnostics omit values', () => {
  const output = report();
  assert.equal(output.report.ownership.outcome, 'verified_in_current_first_page');
  assert.match(output.preview.join('\n'), new RegExp(pid));
  assert.match(output.preview.join('\n'), /尺寸：40×120 \/ 50×150/);
  assert.match(output.preview.join('\n'), /材质：棉 \/ 混纺/);
  assert.match(output.preview.join('\n'), /包装：独立包装/);
  assert.equal(output.report.sources.attributes.entryCount, 2);
  assert.equal(output.report.sources.specifications.outcome, 'candidate_success');
  const exported = JSON.stringify(output.report);
  for (const secret of [pid, 'private-title', 'private-token', 'https://private', '40×120', '独立包装', '混纺'])
    assert.ok(!exported.includes(secret), secret);
  assert.ok(!output.preview.join('\n').includes('signature='));
});

test('conflicting response IDs never enter preview, while the other source survives', () => {
  for (const [body, error] of [
    [attributes.replace(pid, '999'), 'product_identity_mismatch'],
    [attributes.replace('"product_format"', '"product_info":{"product_id":"999"},"product_format"'), 'product_identity_mismatch'],
  ]) {
    const output = report(result({ attributes: response(body) }));
    assert.equal(output.report.sources.attributes.error, error);
    assert.equal(output.report.sources.specifications.outcome, 'candidate_success');
    assert.ok(!output.preview.join('\n').includes('独立包装'));
    assert.ok(output.report.sources.attributes.responseShape);
  }
});

test('no echoed ID permits request-bound candidate preview of all nine attributes without asserting identity', () => {
  const data = JSON.parse(attributes);
  delete data.detail_info.product_id;
  data.detail_info.product_format = [{ format: Array.from({ length: 9 }, (_, i) => ({
    name: `属性${i + 1}`, message: [{ desc: `内容${i + 1}` }],
  })) }];
  const output = report(result({ attributes: response(JSON.stringify(data)) }));
  const item = output.report.sources.attributes;
  assert.equal(output.report.version, 2);
  assert.equal(item.outcome, 'candidate_pending_review');
  assert.equal(item.requestAssociation, 'matched');
  assert.equal(item.responseIdentity, 'not_returned');
  assert.equal(item.reviewStatus, 'unreviewed');
  assert.equal(item.entryCount, 9);
  assert.equal(item.previewTruncated, false);
  assert.match(output.preview.join('\n'), /属性9：内容9/);
  assert.match(output.preview.join('\n'), /待原平台核对/);
  for (const secret of [pid, '内容9', '属性9', '"one"', 'requestBinding']) assert.ok(!JSON.stringify(output.report).includes(secret), secret);
  for (const binding of [undefined, { token: 'old' }, { ...response('').requestBinding, productId: '999' },
    { ...response('').requestBinding, shopId: 'other' }, { ...response('').requestBinding, source: 'specifications' }]) {
    const rejected = report(result({ attributes: { ...response(JSON.stringify(data)), requestBinding: binding } }));
    assert.equal(rejected.report.sources.attributes.error, 'request_binding_mismatch');
    assert.ok(!rejected.preview.join('\n').includes('内容9'));
  }
});

test('jump URL summaries match only explicit product IDs on allowed HTTPS hosts, never leak URL values', () => {
  for (const url of [
    `https://haohuo.jinritemai.com/detail?product_id=${pid}&token=private-token`,
    `sslocal://webview?url=${encodeURIComponent(`https://haohuo.jinritemai.com/detail?product_id=${pid}`)}`,
  ]) {
    const summary = productDetailLinkReport(url, pid);
    assert.equal(summary.status, 'product_id_matches');
    const exported = JSON.stringify(summary);
    assert.ok(!exported.includes(pid));
    assert.ok(!exported.includes('private-token'));
  }
  for (const url of [
    `https://haohuo.jinritemai.com/detail?id=${pid}`,
    `https://haohuo.jinritemai.com/detail?promotion_id=${pid}`,
    `https://haohuo.jinritemai.com.evil.test/?product_id=${pid}`,
    `http://haohuo.jinritemai.com/?product_id=${pid}`,
    `https://user:secret@haohuo.jinritemai.com/?product_id=${pid}`,
    `sslocal://detail?product_id=${pid}`,
  ]) assert.equal(productDetailLinkReport(url, pid).status, 'no_verified_product_id');
  assert.equal(productDetailLinkReport(`https://haohuo.jinritemai.com/?product_id=${pid}&product_id=999`, pid).status, 'product_id_conflict');
  assert.equal(productDetailLinkReport(`https://haohuo.jinritemai.com/?product_id=3.830227192483283126e18`, pid).status, 'product_id_conflict');
  const limited = productDetailLinkReport('x'.repeat(5000), pid);
  assert.equal(limited.truncated, true);
  assert.equal(limited.status, 'invalid_or_oversized');
  assert.equal(productDetailLinkReport('not a URL', pid).status, 'invalid_or_oversized');
  assert.equal(productDetailLinkReport(null, pid).status, 'missing');
});

test('link identity conflict overrides matching JSON identity; promotion ID never grants verification', () => {
  const withLink = (url, echoed = false) => {
    const data = JSON.parse(attributes);
    if (echoed) data.detail_info.product_id = pid;
    else delete data.detail_info.product_id;
    data.detail_info.jump_url = url;
    return report(result({ attributes: response(JSON.stringify(data)) }));
  };
  const matched = withLink(`https://haohuo.jinritemai.com/?product_id=${pid}`);
  assert.equal(matched.report.sources.attributes.responseIdentity, 'jump_url_id_matches');
  const conflict = withLink('https://haohuo.jinritemai.com/?product_id=999', true);
  assert.equal(conflict.report.sources.attributes.error, 'product_identity_mismatch');
  assert.ok(!conflict.preview.join('\n').includes('独立包装'));
  const promotion = withLink(`https://haohuo.jinritemai.com/?promotion_id=${pid}`);
  assert.equal(promotion.report.sources.attributes.outcome, 'candidate_pending_review');
  assert.equal(promotion.report.sources.attributes.jumpUrl.promotionIds[0].interpretation, 'unverified');
});

test('errors and successful empty sets remain distinct; invalid lists cannot establish ownership', () => {
  for (const input of [result({ body: list.replace(pid, '999') }), result({ body: list.replace('"123"', '"124"') }),
    result({ error: 'identity_mismatch' }), result({ body: list.replace('"total":1', '"total":21') })]) {
    const output = report(input);
    assert.equal(output.preview.length, 0);
    assert.deepEqual(output.report.sources, {});
  }
  const empty = report(result({ specifications: response(specifications.replace(/\[\{"name":"尺寸".*\]\}/, '[]}')) }));
  assert.equal(empty.report.sources.specifications.outcome, 'candidate_empty');
  for (const [input, error] of [
    [{ error: 'cancelled_or_timeout' }, 'cancelled_or_timeout'],
    [response('not json'), 'invalid_json'],
    [{ ...response(attributes), httpStatus: 403 }, 'http_error'],
    [response(attributes.replace('"status_code":0', '"status_code":10005')), 'business_error'],
  ]) assert.equal(report(result({ attributes: input })).report.sources.attributes.error, error);
});

test('large or unexpected collections stay bounded and disclose incomplete preview', () => {
  const large = JSON.parse(attributes);
  large.detail_info.product_id = pid;
  large.detail_info.product_format = [{ format: Array.from({ length: 100 }, () =>
    ({ name: '属性', message: [{ desc: '长'.repeat(400) }] })) }];
  const output = report(result({ attributes: response(JSON.stringify(large)) }));
  assert.equal(output.report.sources.attributes.previewTruncated, true);
  assert.ok(output.preview.join('\n').length < 6500);
  assert.ok(JSON.stringify(output.report).length < 600000);
});

test('page queries only verified shop product with fixed read endpoints and no buyer context', async () => {
  const h = harness(fetchSuccess);
  const output = await h.run();
  assert.equal(output.specifications.body, specifications);
  assert.equal(output.attributes.body, attributes);
  assert.equal(h.calls.length, 6);
  const sku = h.calls.find((call) => call.url.includes('get_skuinfo_list'));
  assert.ok(sku.url.includes(`product_id=${pid}&security_user_id=&_pms=1`));
  const detail = h.calls.find((call) => call.url.includes('/pack/detail/'));
  assert.equal(detail.options.body, `promotion_id=${pid}&enter_from=&meta_param=&is_h5=1`);
  assert.equal(detail.options.credentials, 'include');
  assert.equal(detail.options.redirect, 'error');
  assert.equal(h.window.__acsDouyinProductProbeV1, undefined);
});

test('unowned, mismatched shop and invalid product inputs prevent detail HTTP requests', async () => {
  for (const body of [list.replace(pid, '999'), list.replace('"123"', '"124"'), list.replace('"code":0', '"code":10005')]) {
    const h = harness((url) => url.includes('get_product_list') ? new Response(body) : fetchSuccess(url));
    assert.equal((await h.run()).error, 'ownership_unverified');
    assert.equal(h.calls.length, 2);
  }
  const h = harness(fetchSuccess);
  assert.equal((await h.run({ productId: '1&evil=2' })).error, 'invalid_command');
  assert.equal(h.calls.length, 0);
});

test('attribute network failure preserves specifications; final identity change discards both', async () => {
  const h = harness((url) => {
    if (url.includes('/pack/detail/')) throw new Error('private-cookie');
    return fetchSuccess(url);
  });
  const output = await h.run();
  assert.equal(output.specifications.body, specifications);
  assert.equal(output.attributes.error, 'network_or_parse_error');
  assert.ok(!JSON.stringify(output).includes('private-cookie'));
  let identities = 0;
  const changed = harness((url) => url.includes('currentuser') && ++identities === 3
    ? Response.json({ code: 0, data: { ShopId: 'other' } }) : fetchSuccess(url));
  assert.equal((await changed.run()).error, 'identity_mismatch');
});

test('detail cancellation aborts both queries and clears in-flight state', async () => {
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  let count = 0;
  const h = harness((url, options) => {
    if (url.includes('get_skuinfo_list') || url.includes('/pack/detail/')) {
      if (++count === 2) started();
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('cancel'))));
    }
    if (options.signal.aborted) throw new Error('cancel');
    return fetchSuccess(url);
  });
  const pending = h.run();
  await ready;
  assert.equal((await h.run()).error, 'busy');
  await h.run({ action: 'cancel' });
  const output = await pending;
  assert.equal(output.error, 'cancelled_or_timeout');
  assert.equal(output.specifications, undefined);
  assert.equal(h.window.__acsDouyinProductProbeV1, undefined);
});
