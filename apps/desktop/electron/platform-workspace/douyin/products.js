import { buildProductProbeReport, parseProductProbeJson } from './product-probe-report.js';

function displayPrice(product) {
  const price = product.marketing_info?.show_product_marketing_info?.show_sku_info?.show_price?.show_price;
  if (typeof price?.show_amount !== 'string' || !price.show_amount.trim()) return null;
  const parts = [price.price_prefix ?? '', price.show_amount, price.price_suffix ?? ''];
  if (parts.some((part) => typeof part !== 'string')) return null;
  const label = parts.join('');
  // Keep the platform's display text, never infer units from amount or fall back
  // to an original/regular price. Invalid optional prices do not discard goods.
  if (label.length > 64 || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(label)) return null;
  return label.trim();
}

export function mapDouyinProducts(result) {
  const { report, summary } = buildProductProbeReport(result);
  if (report.error) throw new Error(summary);
  if (report.receivedCount !== Math.min(report.total, 20)) throw new Error('商品首页条数与平台总数不符，原列表未更新');
  const data = parseProductProbeJson(result.body);
  const products = data.data.map((row) => {
    const product = row.product_item;
    // Unsafe JSON numbers are represented by a source-preserving wrapper.
    const productId = typeof product.product_id === 'object' ? product.product_id.source : String(product.product_id);
    const base = product.product_base_info;
    if (base?.product_id != null && String(base.product_id?.source ?? base.product_id) !== productId)
      throw new Error('商品身份字段不一致，原列表未更新');
    const title = typeof base?.title === 'string' ? base.title.trim().slice(0, 1000) : null;
    let imageUrl = null;
    if (typeof base?.main_img === 'string' && base.main_img.length <= 4096) {
      try {
        const url = new URL(base.main_img);
        if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) imageUrl = url.href;
      } catch { /* Missing/invalid images use the UI placeholder. */ }
    }
    return { product_id: productId, goods_id: productId, title: title || null, image_url: imageUrl,
      price_label: displayPrice(product), source: 'douyin_product_list', raw_payload: {} };
  });
  return { products, collection_status: products.length ? 'success' : 'empty',
    page_summary: { page_no: 0, page_size: 20, total_count: report.total, has_more: report.total > products.length } };
}
