import { buildProductDetailProbeReport } from './product-detail-probe-report.js';
import { parseProductProbeJson, idText } from './product-probe-report.js';
import { mapDouyinProducts } from './products.js';

const value = (text, max = 512) => {
  if (typeof text !== 'string' || !text.trim() || text.length > max) throw new Error('商品详情字段不完整或过长');
  return text.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').trim();
};
const list = (items, max) => {
  if (!Array.isArray(items) || items.length > max) throw new Error('商品详情条目结构无效');
  return items;
};

// Formal projection is separate from diagnostic previews: no raw response,
// credentials, marketing, SKU price/stock, or inferred Cartesian combinations.
export function mapDouyinProductDetail(result, options) {
  const { report } = buildProductDetailProbeReport(result, options);
  const spec = report.sources.specifications;
  if (report.ownership.outcome !== 'verified_in_current_first_page' || spec?.error
    || spec?.requestAssociation !== 'matched' || spec?.responseIdentity !== 'explicit_id_matches')
    throw new Error('商品归属或规格身份未通过核验');
  const product = mapDouyinProducts(result).products.find((p) => p.product_id === options.productId);
  const data = parseProductProbeJson(result.specifications.body).data;
  const dimensions = list(data.product_info.spec_detail_info, 3).map((group) => ({
    name: value(group.name), options: list(group.spec_details, 300).map((item) => ({
      id: value(idText(item.id), 40), name: value(item.name),
    })),
  }));
  const ids = new Set();
  const skus = list(data.items, 2000).map((item) => {
    const skuId = idText(item.sku_id);
    if (!/^\d{1,40}$/.test(skuId || '') || ids.has(skuId) || idText(item.product_id) !== options.productId)
      throw new Error('SKU 商品身份不一致');
    ids.add(skuId);
    const attributes = dimensions.map((dimension, i) => {
      const id = idText(item[`spec_detail_id${i + 1}`]);
      const option = dimension.options.find((entry) => entry.id === id);
      if (!option || item[`spec_name${i + 1}`] !== dimension.name || item[`spec_detail_name${i + 1}`] !== option.name)
        throw new Error('SKU 规格关联不一致');
      return { name: dimension.name, value: option.name };
    });
    return { sku_id: skuId, attributes };
  });
  const observedAt = options.observedAt || new Date().toISOString();
  const projection = { source: 'douyin_product_detail_v1', shop_id: options.shopId,
    product_id: options.productId, observed_at: observedAt, title: value(product.title, 1000),
    ownership: 'verified_in_current_first_page',
    specifications: { source: 'get_skuinfo_list', observed_at: observedAt,
      response_identity: 'explicit_id_matches', dimensions, skus }, attributes: null };
  const attr = report.sources.attributes;
  if (!attr?.error && attr?.requestAssociation === 'matched'
    && ['explicit_id_matches', 'jump_url_id_matches', 'not_returned'].includes(attr.responseIdentity)) {
    try {
      const details = parseProductProbeJson(result.attributes.body).detail_info;
      const entries = list(details.product_format, 30).flatMap((group) => list(group.format, 100).map((entry) => ({
        name: value(entry.name), values: list(entry.message, 20).map((item) => value(item.desc, 2048)),
      })));
      if (entries.length > 200) throw new Error('属性过多');
      projection.attributes = { source: 'promotion_pack_detail', observed_at: observedAt,
        response_identity: attr.responseIdentity, request_association: 'matched', entries };
    } catch { /* Partial failure must not erase independently verified specifications. */ }
  }
  if (JSON.stringify(projection).length > 180000) throw new Error('商品详情过大');
  return projection;
}
