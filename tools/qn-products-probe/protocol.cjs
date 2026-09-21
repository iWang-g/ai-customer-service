'use strict';
const API = 'mtop.taobao.qianniu.cs.item.onsale.query';
function parse(raw) {
  if (typeof raw !== 'string' || raw.length > 2 * 1024 * 1024) throw new Error('Invalid response size');
  const text = raw.trim();
  const jsonp = /^mtopjsonp\d+\(([\s\S]*)\);?$/.exec(text);
  return JSON.parse(jsonp ? jsonp[1] : text, (_key, value, context) => {
    if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) {
      if (!context?.source || !/^\d+$/.test(context.source)) throw new Error('Unsafe integer');
      return context.source;
    }
    return value;
  });
}
function id(value) {
  const result = String(value ?? '');
  if (!/^\d{1,30}$/.test(result)) throw new Error('Invalid product ID');
  return result;
}
function url(value) {
  if (typeof value !== 'string' || value.length > 8192) return null;
  try {
    const parsed = new URL(value.startsWith('//') ? 'https:' + value : value);
    return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.href : null;
  } catch { return null; }
}
function summarize(raw, pageNo, pageSize = 5) {
  let value = parse(raw);
  for (let depth = 0; !value?.api && depth < 4; depth++) {
    value = value?.result ?? value?.data;
    if (typeof value === 'string') value = parse(value);
  }
  if (value?.api?.toLowerCase() !== API || value.v !== '1.0' ||
      !Array.isArray(value.ret) || !value.ret.some(ret => typeof ret === 'string' && ret.startsWith('SUCCESS::'))) {
    throw new Error('Product API did not return success');
  }
  const data = value.data;
  if (!Array.isArray(data?.itemList) || data.itemList.length > pageSize ||
      !/^\d+$/.test(String(data.total)) || !Number.isSafeInteger(Number(data.total))) throw new Error('Unexpected product page');
  const products = data.itemList.map(item => {
    const productId = id(item.itemId), itemUrl = url(item.itemUrl);
    if (!itemUrl) throw new Error('Missing product URL');
    const target = new URL(itemUrl);
    if (target.hostname !== 'item.taobao.com' || target.pathname !== '/item.htm' || target.port ||
        target.searchParams.getAll('id').length !== 1 || target.searchParams.get('id') !== productId) throw new Error('Product identity mismatch');
    if (typeof item.title !== 'string' || !item.title.trim() || item.title.length > 1024) throw new Error('Missing product title');
    return { productId, title: item.title, imageUrl: url(item.pic),
      url: 'https://item.taobao.com/item.htm?id=' + productId,
      price: typeof item.price === 'string' && /^\d{1,12}(?:\.\d{1,4})?$/.test(item.price) ? item.price : null,
      quantity: Number.isSafeInteger(item.quantity) && item.quantity >= 0 ? item.quantity : null,
      soldQuantity: Number.isSafeInteger(item.soldQuantity) && item.soldQuantity >= 0 ? item.soldQuantity : null,
      categoryId: item.categoryId == null ? null : id(item.categoryId) };
  });
  if (new Set(products.map(p => p.productId)).size !== products.length) throw new Error('Duplicate product in page');
  return { pageNo, pageSize, total: Number(data.total), products };
}
module.exports = { API, parse, summarize };
