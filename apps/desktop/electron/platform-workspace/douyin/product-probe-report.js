import { createHmac, randomBytes } from 'node:crypto';

export class JsonNumber {
  constructor(source) { this.source = source; }
}

// JSON source is required only for numbers that cannot be represented safely.
// Fail closed on older runtimes; String(roundedNumber) cannot restore an ID.
export function parseProductProbeJson(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 512 * 1024) throw new Error('response_too_large');
  return JSON.parse(text, (_key, value, context) => {
    if (typeof value === 'number' && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) {
      if (!context?.source) throw new Error('number_precision_unavailable');
      return new JsonNumber(context.source);
    }
    return value;
  });
}

const scalar = (value) => value instanceof JsonNumber ? value.source : String(value);
export const idText = (value) => {
  const text = scalar(value);
  return (typeof value === 'string' || typeof value === 'number' || value instanceof JsonNumber)
    && /^\d{1,40}$/.test(text) ? text : null;
};
const safeCount = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
const codeValue = (value) => Number.isSafeInteger(value) && Math.abs(value) < 1e9 ? value
  : typeof value === 'string' && /^-?\d{1,9}$/.test(value) ? value : null;
const safeTitle = (value) => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').slice(0, 120) : '标题字段暂缺';

export const PRODUCT_PROBE_ERRORS = {
  invalid_origin: '当前页面不是飞鸽客服页面', invalid_command: '探测参数无效', busy: '已有商品探测正在运行',
  im_not_ready: '请先进入飞鸽客服接待页面', identity_mismatch: '店铺身份已变化，结果已丢弃',
  identity_unavailable: '无法核验店铺身份', cancelled_or_timeout: '探测已取消或超时',
  network_or_parse_error: '网络、跨域或店铺身份响应异常', empty_body: '平台响应为空',
  response_too_large: '响应超过诊断大小限制', number_precision_unavailable: '当前运行环境无法保留长数字精度',
  invalid_json: '平台未返回有效 JSON', http_error: '商品查询被平台拒绝或 HTTP 请求失败',
  business_error: '平台返回业务错误或尚未识别的成功码', invalid_shape: '商品列表结构不符合候选协议',
  invalid_products: '部分商品 ID 缺失或格式无法识别', invalid_total: '平台总数缺失或与本页条数矛盾',
  execution_error: '页面执行失败，请刷新客服页后重试',
  ownership_unverified: '本次店铺首页商品列表未能确认该商品归属，请刷新列表后重试；不代表商品不存在',
};

export function buildProductProbeReport(result, { frameOrigin, observedAt = new Date().toISOString() } = {}) {
  const salt = randomBytes(32);
  const digest = (value) => createHmac('sha256', salt).update(String(value)).digest('hex').slice(0, 20);
  // Essential scalar samples never consume the recursive response budget. Rich
  // SKU trees must not hide later products or the deeply nested display price.
  const scalarShape = (value) => {
    if (value === undefined) return { type: 'missing' };
    if (value === null) return { type: 'null' };
    if (value instanceof JsonNumber) return { type: 'number', length: value.source.length,
      precision: 'source-preserved', fingerprint: digest(value.source) };
    if (typeof value === 'object') return { type: Array.isArray(value) ? 'array' : 'object' };
    return { type: typeof value, length: scalar(value).length, fingerprint: digest(scalar(value)),
      ...(typeof value === 'string' && /^https?:\/\//i.test(value) ? { format: 'http-url' } : {}) };
  };
  let remaining = 2500;
  let truncated = false;
  const shape = (value, depth = 0) => {
    if (--remaining < 0 || depth > 8) { truncated = true; return { type: 'limit' }; }
    if (value === null) return { type: 'null' };
    if (value instanceof JsonNumber) return scalarShape(value);
    if (Array.isArray(value)) {
      if (value.length > 20) truncated = true;
      return { type: 'array', length: value.length, items: value.slice(0, 20).map((v) => shape(v, depth + 1)) };
    }
    if (typeof value === 'object') {
      const entries = Object.entries(value);
      if (entries.length > 60) truncated = true;
      return { type: 'object', fields: Object.fromEntries(entries.slice(0, 60).map(([key, v]) => [
        /^[A-Za-z_$][A-Za-z0-9_$:]{0,63}$/.test(key) ? key : `key_${digest(key)}`,
        /token|cookie|authorization|password|secret|ticket|headers|stack/i.test(key)
          ? { type: 'redacted' } : shape(v, depth + 1),
      ])) };
    }
    return scalarShape(value);
  };
  const report = { version: 2, kind: 'douyin_product_list_probe', observedAt,
    frameOrigin: ['https://im.jinritemai.com', 'https://pigeon.jinritemai.com'].includes(frameOrigin) ? frameOrigin : null,
    request: { endpoint: '/backstage/workstation/get_product_list', page_no: 0, page_size: 20, presale_biz_scene: 'b_product_list' },
    httpStatus: Number.isInteger(result?.httpStatus) ? result.httpStatus : null,
    outcome: 'unavailable', error: null, code: null, total: null, receivedCount: null,
    validIdCount: 0, duplicateIdCount: 0, idSamples: [], productSamples: [], responseShape: null, truncated: false };
  let preview = [];
  if (result?.error) report.error = Object.hasOwn(PRODUCT_PROBE_ERRORS, result.error) ? result.error : 'execution_error';
  else {
    let data;
    try { data = parseProductProbeJson(result?.body); }
    catch (error) { report.error = Object.hasOwn(PRODUCT_PROBE_ERRORS, error.message) ? error.message : 'invalid_json'; }
    if (data !== undefined) {
      report.responseShape = shape(data);
      report.code = codeValue(data?.code);
      report.total = safeCount(data?.total);
      report.receivedCount = Array.isArray(data?.data) ? data.data.length : null;
      const rows = Array.isArray(data?.data) ? data.data.slice(0, 20) : [];
      const ids = rows.map((row) => idText(row?.product_item?.product_id));
      report.validIdCount = ids.filter(Boolean).length;
      report.duplicateIdCount = report.validIdCount - new Set(ids.filter(Boolean)).size;
      report.idSamples = rows.map((row, index) => ({ index, valid: Boolean(ids[index]),
        value: scalarShape(row?.product_item?.product_id) }));
      const displayPricePath = 'product_item.marketing_info.show_product_marketing_info.show_sku_info.show_price.show_price';
      const essentialPaths = [
        'product_id', 'product_name', 'img', 'sku_min_price_str', 'sku_max_price_str',
        'product_item.product_id', 'product_item.product_base_info.product_id',
        'product_item.product_base_info.title', 'product_item.product_base_info.main_img',
        'product_item.product_base_info.product_center_url',
        'product_item.product_base_info.status', 'product_item.product_base_info.check_status',
        'product_item.marketing_info.price.effective_min_price',
        'product_item.marketing_info.price.regular_price', 'product_item.marketing_info.price.origin_price',
        'product_item.marketing_info.marketing_price_prefix',
        ...['amount', 'show_amount', 'price_prefix', 'price_suffix', 'price_type', 'price_label']
          .map((key) => `${displayPricePath}.${key}`),
      ];
      report.productSamples = rows.map((row, index) => ({ index, fields: Object.fromEntries(
        essentialPaths.map((path) => [path, scalarShape(path.split('.').reduce((value, key) =>
          value && typeof value === 'object' && Object.hasOwn(value, key) ? value[key] : undefined, row))]),
      ) }));
      if (!(report.httpStatus >= 200 && report.httpStatus < 300)) report.error = 'http_error';
      else if (data?.code !== 0) report.error = 'business_error';
      else if (!Array.isArray(data?.data) || rows.length !== data.data.length) report.error = 'invalid_shape';
      else if (report.total === null || report.total < rows.length || (!rows.length && report.total > 0)) report.error = 'invalid_total';
      else if (report.validIdCount !== rows.length || report.duplicateIdCount) report.error = 'invalid_products';
      else {
        report.outcome = rows.length ? 'candidate_success' : 'candidate_empty';
        preview = rows.slice(0, 5).map((row, index) => `${index + 1}. ${safeTitle(row.product_item?.product_base_info?.title)}\n商品 ID：${ids[index]}`);
      }
    }
    if (!(report.httpStatus >= 200 && report.httpStatus < 300)) report.error = 'http_error';
  }
  report.truncated = truncated;
  // Only this pseudonymized report is kept for export. Preview is transient UI.
  return { report, preview, summary: report.error ? PRODUCT_PROBE_ERRORS[report.error]
    : `读取到 ${report.receivedCount} 条商品，平台返回总数 ${report.total}。${report.total > report.receivedCount ? '本次仅探测第一页。' : ''}` };
}
