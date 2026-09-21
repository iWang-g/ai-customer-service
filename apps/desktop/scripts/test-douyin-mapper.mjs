import assert from 'node:assert/strict';
import { mapDouyinMessage, isDouyinLiveReply } from '../electron/platform-workspace/douyin/mapper.js';

const raw = { securityConversationId: 'buyer-1:shop-1::2:1:pigeon', serverId: '9007199254740993',
  subConversationShortId: 'short-1', type: 1000, content: '你好', createdAt: '2026-09-11T07:30:28.839Z',
  ext: { type: 'text', 's:sender_biz_role': 'Buyer', nickname: '买家',
    's:client_message_id': 'client-1', message_logid: 'log-1', shop_id: 'shop-1' },
};
const customer = mapDouyinMessage(raw, 'shop-1');
assert.equal(customer.senderRole, 'customer');
assert.equal(customer.platformMessageId, '9007199254740993');
assert.equal(customer.platformSentAt, '2026-09-11T07:30:28.839Z');
assert.equal(customer.structuredPayload.client_message_id, 'client-1');
const compensation = mapDouyinMessage({ ...raw, serverId: undefined, serverMessageId: raw.serverId,
  type: undefined, msgType: 1000, createdAt: undefined, createTime: '1789111828839' }, 'shop-1', 'compensation');
assert.equal(compensation.platformMessageId, customer.platformMessageId);
assert.equal(compensation.platformSentAt, customer.platformSentAt);
assert.equal(compensation.messageType, 'text');
const agent = mapDouyinMessage({ ...raw, ext: { ...raw.ext, 's:sender_biz_role': 'CurrentServer', nickname: undefined } }, 'shop-1');
assert.equal(agent.senderRole, 'agent');
assert.equal(agent.customerName, null, 'agent echo must not replace buyer nickname');
assert.equal(mapDouyinMessage(raw, 'other-shop'), null);
assert.equal(mapDouyinMessage({ ...raw, ext: { ...raw.ext, shop_id: 'other-shop' } }, 'shop-1'), null);
assert.equal(mapDouyinMessage({ ...raw, serverId: undefined }, 'shop-1'), null, 'client ID cannot replace a server ID');
assert.equal(mapDouyinMessage({ ...raw, serverId: 9007199254740993 }, 'shop-1'), null, 'reject lost integer precision');
assert.equal(mapDouyinMessage({ ...raw, createdAt: {}, createTime: 0 }, 'shop-1').platformSentAt, null);
assert.equal(mapDouyinMessage({ ...raw, serverId: 'second-message' }, 'shop-1').content, customer.content);
assert.notEqual(mapDouyinMessage({ ...raw, serverId: 'second-message' }, 'shop-1').platformMessageId, customer.platformMessageId);
assert.equal(mapDouyinMessage({ ...raw, ext: { ...raw.ext, 's:sender_biz_role': 'Robot' } }, 'shop-1').senderRole, 'platform');
assert.match(mapDouyinMessage({ ...raw, type: 2000, content: '', ext: { ...raw.ext, type: 'image' } }, 'shop-1').content, /非文本/);
const observedAt = '2026-09-11T10:42:57.802Z';
const startedAt = '2026-09-11T10:40:58.156Z';
assert.equal(isDouyinLiveReply({ ...customer, platformSentAt: '2026-09-11T10:42:57.942Z' }, startedAt, observedAt), true,
  'actual buyer hello with platform clock ahead 140ms remains eligible');
for (const [offset, expected] of [[5000, true], [5001, false], [-300000, true], [-300001, false]]) {
  const candidate = { ...customer, platformSentAt: new Date(Date.parse(observedAt) + offset).toISOString() };
  assert.equal(isDouyinLiveReply(candidate, '2026-09-11T10:00:00Z', observedAt), expected);
}
for (const [offset, expected] of [[-5000, true], [-5001, false]]) {
  assert.equal(isDouyinLiveReply({ ...customer, platformSentAt: new Date(Date.parse(observedAt) + offset).toISOString() },
    observedAt, observedAt), expected, 'startup boundary tolerates platform clock skew');
}
assert.equal(isDouyinLiveReply({ ...compensation, platformSentAt: observedAt }, startedAt, observedAt), false);
assert.equal(isDouyinLiveReply({ ...agent, platformSentAt: observedAt }, startedAt, observedAt), false);
assert.equal(isDouyinLiveReply({ ...customer, platformSentAt: null }, startedAt, observedAt), false);

// Structure matches the two real observation-v2 cards; values are synthetic.
const product = { product_id: '9007199254740993001', product_name: '', product_name_two_lines: '测试商品',
  img: 'https://cdn.example.com/product.jpg?signature=test', price: '155.00',
  current_price: { price: '155.00', prefix: '¥', suffix: '', currency: '1' },
  buttons: [{ label: '不可执行', onClick: 'private-action' }] };
const cardMessage = (card, overrides = {}) => ({ ...raw, content: '[商品]', ext: { ...raw.ext,
  type: 'template_card', goods_id: product.product_id, static_data: JSON.stringify(card),
  generic_search_keywords: JSON.stringify({ content: '备用标题' }), ...overrides } });
const buyerProduct = mapDouyinMessage(cardMessage({sale_goods:[product]}), 'shop-1');
assert.equal(buyerProduct.messageType, 'product');
assert.equal(buyerProduct.displayMode, 'card');
assert.equal(buyerProduct.structuredPayload.title, '测试商品');
assert.equal(buyerProduct.structuredPayload.product_id, product.product_id);
assert.equal(buyerProduct.structuredPayload.image_url, product.img);
assert.equal(buyerProduct.structuredPayload.price_label, '¥155.00');
assert.ok(!JSON.stringify(buyerProduct).includes('private-action'), 'do not persist card actions/layout');
const sellerProduct = mapDouyinMessage(cardMessage({b_goods:[{...product, product_name:'客服推荐商品', product_name_two_lines:''}]},
  {'s:sender_biz_role':'CurrentServer'}), 'shop-1');
assert.equal(sellerProduct.senderRole, 'agent');
assert.equal(sellerProduct.structuredPayload.title, '客服推荐商品');
assert.equal(sellerProduct.structuredPayload.product_id, product.product_id);
const corruptCard = mapDouyinMessage(cardMessage({}, {static_data:'{bad-json'}), 'shop-1');
assert.equal(corruptCard.messageType, 'product');
assert.equal(corruptCard.structuredPayload.title, '备用标题');
assert.equal(corruptCard.structuredPayload.image_url, undefined);
assert.equal(mapDouyinMessage(cardMessage({}, {static_data:'x'.repeat(65537)}), 'shop-1').messageType, 'product');
const mismatchedCard = mapDouyinMessage(cardMessage({sale_goods:[{...product,product_id:'123'}]}), 'shop-1');
assert.equal(mismatchedCard.structuredPayload.image_url, undefined, 'never mix product IDs and thumbnails');
assert.equal(mismatchedCard.structuredPayload.price_label, undefined);
assert.equal(mapDouyinMessage({...cardMessage({order_id:'123'}),content:'[订单卡片]'}, 'shop-1').messageType, 'unknown');
const imageMessage = { ...raw, content:'[图片]', ext:{...raw.ext, type:'file_image', imageUrl:'https://cdn.example.com/photo.jpg?signature=test'} };
const picture = mapDouyinMessage(imageMessage, 'shop-1');
assert.equal(picture.messageType, 'image');
assert.equal(picture.displayMode, 'bubble');
assert.equal(picture.structuredPayload.image_url, imageMessage.ext.imageUrl);
for (const unsafe of ['javascript:alert(1)', 'file:///private.jpg', 'data:image/svg+xml,test', 'https://user:pass@cdn.example.com/a', 'not-a-url', 'https://cdn.example.com/'+'a'.repeat(4096)]) {
  const invalidImage = mapDouyinMessage({...imageMessage,ext:{...imageMessage.ext,imageUrl:unsafe}}, 'shop-1');
  assert.equal(invalidImage.structuredPayload.image_url, undefined);
  assert.match(invalidImage.content, /图片暂不可用/);
  assert.equal(mapDouyinMessage(cardMessage({sale_goods:[{...product,img:unsafe}]}), 'shop-1').structuredPayload.image_url, undefined);
}
assert.equal(mapDouyinMessage({...raw,ext:{...raw.ext,imageUrl:imageMessage.ext.imageUrl}}, 'shop-1').messageType, 'text',
  'a text message carrying imageUrl remains text');
for (const product of [buyerProduct,corruptCard]) {
  assert.equal(isDouyinLiveReply({...product,platformSentAt:observedAt},startedAt,observedAt),true,'live buyer products can trigger a reply');
  assert.equal(isDouyinLiveReply({...product,platformSentAt:observedAt,structuredPayload:{...product.structuredPayload,collection_source:'compensation'}},startedAt,observedAt),false);
  assert.equal(isDouyinLiveReply({...product,platformSentAt:'2026-09-10T00:00:00Z'},startedAt,observedAt),false);
}
for (const nontext of [sellerProduct]) {
  assert.equal(isDouyinLiveReply({...nontext,platformSentAt:observedAt},startedAt,observedAt),false,'agent cards must never trigger AI');
}
assert.equal(isDouyinLiveReply({...picture,platformSentAt:observedAt},startedAt,observedAt),true,'buyer images trigger text clarification without vision');
assert.equal(mapDouyinMessage({...imageMessage,serverId:undefined,serverMessageId:'image-history',type:undefined,msgType:1000},
  'shop-1','compensation').messageType,'image');
console.log('Douyin mapper: live/compensation mapping, IDs, clock tolerance, roles, placeholders and shop isolation passed');
