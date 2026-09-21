'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { API, summarize } = require('./protocol.cjs');
const { installProductsProbe } = require('./page.cjs');
const item = { itemId: '123', title: 'Test product', itemUrl: 'https://item.taobao.com/item.htm?id=123&sid=omit',
  pic: '//img.alicdn.com/test.png', price: '65.50', quantity: 12, soldQuantity: 3 };
const response = items => JSON.stringify({ api: API, v: '1.0', ret: ['SUCCESS::ok'], data: { itemList: items, total: 2 } });
test('projects products and pagination, preserves price precision, removes URL session data', () => {
  const value = summarize(response([item]), 1);
  assert.equal(value.total, 2);
  assert.equal(value.products[0].price, '65.50');
  assert.equal(value.products[0].imageUrl, 'https://img.alicdn.com/test.png');
  assert.equal(value.products[0].url, 'https://item.taobao.com/item.htm?id=123');
  assert.equal(summarize('mtopjsonp2(' + response([]) + ')', 2).products.length, 0);
});
test('rejects errors, mismatched identities, duplicate products and unexpected API', () => {
  for (const raw of [response([item, item]), response([{ ...item, itemId: '999' }]),
    response([item]).replace('SUCCESS::ok', 'FAIL::no'), response([item]).replace(API, 'other.api'),
    response([item]).replace('"total":2', '"total":null')]) assert.throws(() => summarize(raw, 1));
});
test('large numeric IDs are kept as exact strings', () => {
  const raw = response([{ ...item, itemId: '1234567890123456789', itemUrl: 'https://item.taobao.com/item.htm?id=1234567890123456789' }])
    .replace('"itemId":"1234567890123456789"', '"itemId":1234567890123456789');
  assert.equal(summarize(raw, 1).products[0].productId, '1234567890123456789');
});
async function runPage(job, mutate = false, detail = false) {
  let done;
  const finished = new Promise(resolve => { done = resolve; });
  const calls = [];
  const config = { base: 'http://127.0.0.1:18088', token: 'test', shopUid: '123', mainUid: '789', cid: '456.1-789.1#11001@cntaobao' };
  if (detail) config.kind = 'detail';
  const env = { _vs: { loginID: { targetId: '123', havMainId: '789' }, conversationID: { ccode: 'other' } },
    onInvokeNotify: () => calls.push('unrelated'),
    workbench: { createSequenceId: () => 'owned', application: { invoke(sid, command, data) {
      calls.push({ command, data: JSON.parse(data) });
      env.onInvokeNotify('someone-else', 0, '{}');
      if (mutate) env._vs.conversationID.ccode = 'changed';
      queueMicrotask(() => env.onInvokeNotify(sid, 0, response([item])));
    } } },
    fetch: async (url, options) => {
      if (url.endsWith('/poll')) return { ok: true, json: async () => ({ job: { id: 'one', shopUid: '123', mainUid: '789', cid: config.cid,
        ...(detail ? { productId: '835010203895', encryptId: 'synthetic-test-id', isNewCustomer: true } : { pageNo: 1, pageSize: 5 }), ...job } }) };
      const body = JSON.parse(options.body);
      env[detail ? '__qnProductDetailsProbeV1' : '__qnProductsProbeV1'].stop(); done({ calls, result: body.result });
      return { ok: true, json: async () => ({}) };
    } };
  installProductsProbe(env, config);
  return finished;
}
test('page performs fixed read-only MTOP call and preserves other callbacks', async () => {
  const { calls, result } = await runPage({});
  assert.equal(result.ok, true);
  assert.deepEqual(result.before, result.after);
  assert.equal(result.before.cid, 'other');
  assert.equal(calls[0].command, 'invokeMTopChannelService');
  assert.equal(calls[0].data.method, API);
  assert.deepEqual(JSON.parse(calls[0].data.param), { pageNo: 1, pageSize: 5, _message_cid: '456.1-789.1#11001@cntaobao' });
  assert.equal(calls[1], 'unrelated');
});
test('page refuses other shops, arbitrary APIs, pages and changed contexts', async () => {
  for (const job of [{ shopUid: '999' }, { pageNo: 3 }, { pageSize: 30 }, { method: 'write.api' }, { cid: 'other' }]) {
    const value = await runPage(job);
    assert.equal(value.result.ok, false);
    assert.equal(value.calls.length, 0);
  }
  assert.equal((await runPage({}, true)).result.ok, false);
});

test('detail page limits API, product IDs and scope while leaving unselected context unchanged', async () => {
  const { calls, result } = await runPage({}, false, true);
  assert.equal(result.ok, true);
  assert.equal(result.before.cid, 'other');
  assert.deepEqual(result.before, result.after);
  assert.equal(calls[0].data.method, 'mtop.taobao.qianniu.cs.item.detail.query');
  assert.equal(calls[0].data.httpMethod, 'get');
  assert.equal(calls[1], 'unrelated');
  assert.deepEqual(JSON.parse(calls[0].data.param), { itemId: '835010203895', encryptId: 'synthetic-test-id',
    isNewCustomer: true, _message_cid: '456.1-789.1#11001@cntaobao' });
  for (const job of [{ productId: '1' }, { method: 'write.api' }, { shopUid: '999' }, { cid: 'other' },
    { encryptId: '' }, { isNewCustomer: false }, { pageNo: 1 }]) {
    const rejected = await runPage(job, false, true);
    assert.equal(rejected.result.ok, false);
    assert.equal(rejected.calls.length, 0);
  }
  assert.equal((await runPage({}, true, true)).result.ok, false);
});

test('detail parser preserves exact SKU data, unknown syntax, and conditional services without buyer context', () => {
  const { API: detailApi, summarizeDetail, attributes } = require('./detail-protocol.cjs');
  const data = { item: { itemId: '123', title: 'Pillow', propsName: '1:2:Material:Cotton',
    price: '25.00', quantity: 3 }, skuList: [{ skuId: '1234567890123456789', price: '25.00',
      propsName: '1:2:Style:Cover only;3:4:Size:50x150', quantity: 3 }],
    itemServiceList: [{ serviceName: 'Return', description: 'Only if unused', detailUrl: 'secret' }],
    deliveryTimeData: { ipInfo: { areaId: 'private' } } };
  const raw = d => JSON.stringify({ api: detailApi, v: '1.0', ret: ['SUCCESS::ok'], data: d });
  const result = summarizeDetail(raw(data).replace('"skuId":"1234567890123456789"', '"skuId":1234567890123456789'), '123');
  assert.equal(result.skus[0].skuId, '1234567890123456789');
  assert.equal(result.skus[0].attributes[0].value, 'Cover only');
  assert.equal(result.price, '25.00');
  assert.deepEqual(result.services, [{ name: 'Return', description: 'Only if unused' }]);
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.deepEqual(attributes('1:2:Ambiguous:Value:Extra'), [{ raw: '1:2:Ambiguous:Value:Extra', parsed: false }]);
  assert.deepEqual(attributes('-1:-2:Custom:Cover'), [{ propertyId: '-1', valueId: '-2', name: 'Custom', value: 'Cover', raw: '-1:-2:Custom:Cover', parsed: true }]);
  assert.throws(() => summarizeDetail(raw(data), '999'));
  assert.throws(() => summarizeDetail(raw({ ...data, skuList: data.skuList.concat(data.skuList) }), '123'));
  assert.throws(() => summarizeDetail(raw(data).replace('SUCCESS::ok', 'FAIL::denied'), '123'));
  assert.equal(summarizeDetail(raw({ ...data, item: { ...data.item, price: null } }), '123').price, null);
});
