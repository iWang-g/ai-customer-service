'use strict';
const { parse } = require('./products-protocol.cjs');
const API = 'mtop.taobao.airisland.material.item.query';

function id(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('Unsafe item identity');
  const result = String(value ?? '');
  if (!/^\d{1,30}$/.test(result)) throw new Error('Invalid item identity');
  return result;
}

function text(value, maxLength) {
  return typeof value === 'string' && value.trim() && value.length <= maxLength ? value.trim() : null;
}

function price(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const result = String(value);
  return /^\d{1,12}(?:\.\d{1,4})?$/.test(result) ? result : null;
}

function imageUrl(value) {
  const result = text(value, 8192);
  return result?.startsWith('//') ? `https:${result}` : result;
}

function verifyOwnership(raw, productId, mainUid) {
  let value = parse(raw);
  for (let depth = 0; !value?.api && depth < 4; depth++) {
    value = value?.result ?? value?.data;
    if (typeof value === 'string') value = parse(value);
  }
  if (value?.api?.toLowerCase() !== API || value.v !== '1.0' || !Array.isArray(value.ret)
      || !value.ret.some(item => typeof item === 'string' && item.startsWith('SUCCESS::')))
    throw new Error('Item ownership API did not return success');
  if (value.data?.code !== '0' || !Array.isArray(value.data?.data) || value.data.data.length !== 1)
    throw new Error('Item ownership result is incomplete');
  const item = value.data.data[0];
  const actualProductId = id(item?.itemId);
  const sellerUid = id(item?.sellerId);
  if (actualProductId !== productId || sellerUid !== mainUid) throw new Error('商品不属于当前店铺');
  const title = text(item.itemName, 1000);
  if (!title) throw new Error('Item ownership title is missing');
  const quantity = Number.isSafeInteger(item.quantity) && item.quantity >= 0 ? item.quantity : null;
  return {
    source: 'qianniu_material_item_v1', product_id: actualProductId, seller_uid: sellerUid,
    title, image_url: imageUrl(item.itemPicUrl), link_url: text(item.itemUrl, 8192),
    price: price(item.actualPriceYuan), quantity, has_sku: item.hasSku === true,
  };
}

module.exports = { API, verifyOwnership };
