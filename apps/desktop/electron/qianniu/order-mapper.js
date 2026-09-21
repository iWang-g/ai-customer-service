const TRADE_API = 'mtop.taobao.qianniu.cs.trade.query';
const SUMMARY_API = 'mtop.taobao.qianniu.airisland.reception.detail.get';

function asString(value, limit = 256) {
  if (value === null || value === undefined || typeof value === 'object') return '';
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || !Number.isInteger(value))) return '';
  const text = String(value).trim();
  return text.slice(0, limit);
}

function amount(value) {
  const text = typeof value === 'string' ? value : '';
  if (!/^\d{1,12}(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents / 100 : null;
}

function normalizeTime(value) {
  const text = asString(value, 64);
  if (!text) return null;
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/.test(text)) return null;
  const date = new Date(text.replace(' ', 'T') + (/(Z|[+-]\d{2}:\d{2})$/.test(text) ? '' : '+08:00'));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function product(item = {}) {
  return {
    goods_id: asString(item.auctionId, 128),
    title: asString(item.auctionTitle || item.itemTitle, 512),
    sku: asString(item.sku || item.skuInfo, 1024),
    quantity: Number.isSafeInteger(item.buyAmount) ? item.buyAmount : null,
    price: amount(item.price ?? item.auctionPrice),
    image_url: /^https?:\/\//.test(item.picUrl || '') ? asString(item.picUrl, 4096) :
      (String(item.picUrl || '').startsWith('//') ? 'https:' + asString(item.picUrl, 4096) : ''),
    sub_order_id: asString(item.subOrderId, 128),
  };
}

function mapTradeResponse(response, { shopUid, cid, buyerUid } = {}) {
  if (!response || response.api?.toLowerCase() !== TRADE_API ||
      !Array.isArray(response.ret) || !response.ret.some((item) => /^SUCCESS::/.test(item))) {
    throw new Error('千牛订单接口返回失败');
  }
  const data = response.data?.data || response.data;
  const orders = Array.isArray(data?.orders) ? data.orders : null;
  if (!orders) throw new Error('千牛订单回包缺少 orders');
  const mapped = orders.map((item) => {
    const rawOrderId = item.bizOrderId ?? item.orderId;
    const orderId = typeof rawOrderId === 'string' ? asString(rawOrderId, 128) : '';
    if (!/^\d+$/.test(orderId)) throw new Error('千牛订单号无效');
    const products = Array.isArray(item.itemList) ? item.itemList.map(product) : [];
    return {
      platform_order_id: orderId,
      goods_id: products.find((entry) => entry.goods_id)?.goods_id || '',
      status: 'unknown',
      raw_status: typeof item.cardTypeText === 'string' ? asString(item.cardTypeText, 128) : '',
      products,
      order_amount: amount(item.orderPrice),
      discount_amount: null,
      paid_amount: null,
      ordered_at: normalizeTime(item.createTime || item.orderTime),
      paid_at: normalizeTime(item.payTime),
      signed_at: null,
      after_sale: {},
      source: 'qianniu_cs_trade_query',
    };
  });
  return {
    platform: 'qianniu',
    shop_uid: asString(shopUid, 128),
    cid: asString(cid, 256),
    buyer_uid: asString(buyerUid, 128),
    collection_status: 'success',
    orders: mapped,
    page_summary: { total_count: mapped.length, has_more: false },
    read_only: true,
  };
}

function mapEmptyTradeResponse(response, context) {
  const result = mapTradeResponse(response, context);
  return result.orders.length === 0 ? { ...result, collection_status: 'empty' } : result;
}

export { TRADE_API, SUMMARY_API, mapTradeResponse, mapEmptyTradeResponse };
