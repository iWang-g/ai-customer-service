import { buildOrderProbeReport } from './order-probe-report.js';
import { parseProductProbeJson, idText } from './product-probe-report.js';

const clean = (value, max = 512) => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').trim().slice(0, max) : '';
const identifier = (value) => {
  const id = idText(value);
  if (!/^\d{1,40}$/.test(id || '')) throw new Error('订单商品标识无效');
  return id;
};
const timestamp = (value) => {
  const n = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  return Number.isSafeInteger(n) && n >= 946684800 && n <= 4102444800 ? new Date(n * 1000).toISOString() : null;
};
const image = (value) => {
  if (typeof value !== 'string' || value.length > 2048) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
};

// Formal projection is separate from diagnostics. Dynamic amounts are deliberately
// absent until units and payment semantics have been verified against the platform.
export function mapDouyinOrders(result, options) {
  const { report } = buildOrderProbeReport(result, options);
  if (report.error || !['candidate_pending_review', 'candidate_empty'].includes(report.outcome))
    throw new Error('订单查询失败或订单身份未通过核验');
  const root = parseProductProbeJson(result.body);
  if (root.page != null && root.page !== 0)
    throw new Error('订单查询分页不符合预期');
  const orders = root.data.map((order) => {
    if (String(order.shop_id) !== options.shopId || order.security_user_id !== options.buyerId)
      throw new Error('订单未回显匹配的店铺和客户身份');
    if (!Array.isArray(order.sku_order_list) || order.sku_order_list.length > 20)
      throw new Error('订单商品结构未知或超过读取上限');
    const products = order.sku_order_list.map((sku) => ({
      product_id: identifier(sku.product_id),
      sku_order_id: identifier(sku.sku_order_id),
      sku_id: sku.sku_id == null || sku.sku_id === '' ? '' : identifier(sku.sku_id),
      title: clean(sku.product_name, 1000), sku: clean(sku.sku_space_text, 1000),
      quantity: Number.isSafeInteger(sku.buy_num) && sku.buy_num > 0 && sku.buy_num <= 1000000 ? sku.buy_num : null,
      image_url: image(sku.img),
    }));
    if (new Set(products.map((p) => p.sku_order_id)).size !== products.length)
      throw new Error('订单商品编号重复');
    return { platform_order_id: identifier(order.order_id), shop_id: options.shopId, buyer_id: options.buyerId,
      raw_status: clean(order.order_status_desc, 128), ordered_at: timestamp(order.order_time_sec),
      after_sale_description: clean(order.aftersale_sum_status_desc), products };
  });
  return { source: 'douyin_orders_v1', shop_id: options.shopId, buyer_id: options.buyerId,
    conversation_id: options.conversationId, request_association: 'matched',
    observed_at: options.observedAt || new Date().toISOString(),
    query_coverage: 'first_page_only_unknown_total_and_sort', orders };
}
