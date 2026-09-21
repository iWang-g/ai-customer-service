'use strict';
const { parse } = require('./protocol.cjs');
const API = 'mtop.taobao.qianniu.cs.item.detail.query';
const PRODUCT_IDS = ['730328029364', '835010203895', '730114688994'];
function string(value) { return typeof value === 'string' ? value : null; }
function id(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('Unsafe ID');
  const result = String(value ?? '');
  if (!/^\d{1,30}$/.test(result)) throw new Error('Invalid ID');
  return result;
}
function price(value) { return typeof value === 'string' && /^\d{1,12}(?:\.\d{1,4})?$/.test(value) ? value : null; }
function quantity(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }
function attributes(value) {
  if (typeof value !== 'string' || !value) return [];
  return value.split(';').filter(Boolean).map(raw => {
    const parts = raw.split(':');
    // Qianniu also returns negative property/value codes for custom SKU options.
    if (parts.length !== 4 || !/^-?\d+$/.test(parts[0]) || !/^-?\d+$/.test(parts[1])) return { raw, parsed: false };
    return { propertyId: parts[0], valueId: parts[1], name: parts[2], value: parts[3], raw, parsed: true };
  });
}
function summarizeDetail(raw, productId) {
  let value = parse(raw);
  for (let depth = 0; !value?.api && depth < 4; depth++) {
    value = value?.result ?? value?.data;
    if (typeof value === 'string') value = parse(value);
  }
  if (value?.api?.toLowerCase() !== API || value.v !== '1.0' || !Array.isArray(value.ret) ||
      !value.ret.some(r => typeof r === 'string' && r.startsWith('SUCCESS::'))) throw new Error('Detail API did not return success');
  const data = value.data, item = data?.item;
  if (!item || id(item.itemId) !== productId || typeof item.title !== 'string' || !item.title.trim()) throw new Error('Detail item mismatch');
  const source = data.skuList ?? item.skus;
  if (!Array.isArray(source) || source.length > 2000) throw new Error('Invalid SKU list');
  const skus = source.map(sku => ({ skuId: id(sku.skuId), price: price(sku.price), quantity: quantity(sku.quantity),
    propertiesRaw: string(sku.props), propertiesNameRaw: string(sku.propsName), attributes: attributes(sku.propsName) }));
  if (new Set(skus.map(s => s.skuId)).size !== skus.length) throw new Error('Duplicate SKU');
  if (Array.isArray(item.skus) && (item.skus.length !== skus.length ||
      item.skus.some(s => !skus.some(t => t.skuId === id(s.skuId))))) throw new Error('SKU lists disagree');
  if (data.itemServiceList != null && !Array.isArray(data.itemServiceList)) throw new Error('Invalid service list');
  const services = (data.itemServiceList || []).map(s => ({ name: string(s.serviceName), description: string(s.description) }));
  return { productId, title: item.title, categoryId: item.categoryId == null ? null : id(item.categoryId),
    price: price(item.price), quantity: quantity(item.quantity), approveStatus: string(item.approveStatus),
    propertiesRaw: string(item.props), propertiesNameRaw: string(item.propsName),
    propertiesAliasRaw: string(item.propsAlias), attributes: attributes(item.propsName),
    topLevelPropertiesNameRaw: string(data.propsName), topLevelAttributes: attributes(data.propsName),
    skus, services, hasBuyerDependentDelivery: !!data.deliveryTimeData,
    servicesPresent: Array.isArray(data.itemServiceList),
    limitations: ['Historical or live source and time must be retained.',
      'Delivery, promotions and final paid prices are not universal product facts.',
      'Unknown attribute syntax is preserved without guessing.'] };
}
module.exports = { API, PRODUCT_IDS, attributes, summarizeDetail };
