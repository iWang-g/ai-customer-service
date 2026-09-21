import assert from 'node:assert/strict';
import test from 'node:test';
import { mapEmptyTradeResponse, mapTradeResponse, TRADE_API } from './order-mapper.js';

const context = { shopUid: '2222303856223', cid: '2214525969878.1-2216058631944.1#11001@cntaobao', buyerUid: '2214525969878' };
function response(orders) { return { api: TRADE_API, ret: ['SUCCESS::调用成功'], v: '1.0', data: { data: { orders } } }; }

test('maps a multi-item order while preserving long IDs as strings', () => {
  const result = mapTradeResponse(response([{ bizOrderId: '2145790274051222188', orderPrice: '19.00', payTime: '2026-09-09T01:02:03Z', itemList: [
    { auctionId: '730328029364', auctionTitle: '抱枕配件', sku: '颜色:红', buyAmount: 1, price: '19.00', picUrl: 'https://img.example/a.png', subOrderId: '900000000000000001' },
    { auctionId: '730328029365', auctionTitle: '配件二', buyAmount: 2, auctionPrice: '3.5' },
  ] }]), context);
  assert.equal(result.orders[0].platform_order_id, '2145790274051222188');
  assert.equal(result.orders[0].products.length, 2);
  assert.equal(result.orders[0].products[1].quantity, 2);
  assert.equal(result.orders[0].paid_amount, null);
  assert.equal(result.read_only, true);
});

test('distinguishes a confirmed empty response from a malformed response', () => {
  assert.equal(mapEmptyTradeResponse(response([]), context).collection_status, 'empty');
  assert.throws(() => mapEmptyTradeResponse({ api: TRADE_API, ret: ['FAIL_SYS'] }, context), /返回失败/);
  assert.throws(() => mapTradeResponse(response([{ bizOrderId: 2145790274051222188, itemList: [] }]), context), /订单号无效/);
});

test('does not invent paid, discount, status, or time values', () => {
  const order = mapTradeResponse(response([{ bizOrderId: '123', payStatus: 2, logisticsStatus: 2, itemList: [] }]), context).orders[0];
  assert.equal(order.status, 'unknown'); assert.equal(order.order_amount, null);
  assert.equal(order.paid_amount, null); assert.equal(order.discount_amount, null);
  assert.equal(order.ordered_at, null); assert.equal(order.signed_at, null);
});
