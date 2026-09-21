import { createHmac, randomBytes } from 'node:crypto';
import { parseProductProbeJson, JsonNumber, idText } from './product-probe-report.js';

const errors = {
  invalid_origin: '当前页面不是飞鸽客服页面', invalid_command: '订单探测参数无效', busy: '已有订单探测正在运行',
  im_not_ready: '请先进入飞鸽客服接待页面', identity_mismatch: '店铺身份已变化，订单结果已丢弃',
  identity_unavailable: '无法核验店铺身份', cancelled_or_timeout: '订单探测已取消或超时',
  network_or_parse_error: '网络、跨域或店铺身份响应异常', empty_body: '平台响应为空',
  response_too_large: '订单响应超过诊断大小限制', number_precision_unavailable: '当前环境无法保留长数字精度',
  invalid_json: '平台未返回有效 JSON', http_error: '订单查询 HTTP 请求失败',
  business_error: '平台返回业务错误或尚未识别的成功码', invalid_shape: '订单列表结构尚未识别',
  request_binding_mismatch: '结果与本次客户请求关联不一致', execution_error: '页面执行失败，请刷新客服页后重试',
};
const scalar = (v) => v instanceof JsonNumber ? v.source : typeof v === 'string' || typeof v === 'number' ? String(v) : null;
const at = (object, path) => path.split('.').reduce((v, key) => v?.[key], object);

export function buildOrderProbeReport(result, { shopId, buyerId, conversationId, requestToken,
  buyerEvidence = 'collected_conversation', frameOrigin, observedAt = new Date().toISOString() } = {}) {
  const salt = randomBytes(32);
  const digest = (v) => createHmac('sha256', salt).update(String(v)).digest('hex').slice(0, 20);
  const field = (v) => v === undefined ? { type: 'missing' } : v === null ? { type: 'null' }
    : typeof v === 'object' && !(v instanceof JsonNumber) ? { type: Array.isArray(v) ? 'array' : 'object' }
    : { type: v instanceof JsonNumber ? 'number' : typeof v, length: String(scalar(v) ?? v).length,
      fingerprint: digest(scalar(v) ?? v), ...(v instanceof JsonNumber ? { precision: 'source-preserved' } : {}),
      ...(/^-?\d+(?:\.\d+)?$/.test(scalar(v) || '') ? { format: 'decimal', fractional: String(scalar(v)).includes('.') } : {}) };
  let budget = 2500, truncated = false, previewTruncated = false;
  const shape = (v, depth = 0) => {
    if (--budget < 0 || depth > 8) { truncated = true; return { type: 'limit' }; }
    if (v === null || typeof v !== 'object' || v instanceof JsonNumber) return field(v);
    if (Array.isArray(v)) {
      truncated ||= v.length > 20;
      return { type: 'array', length: v.length, items: v.slice(0, 20).map((x) => shape(x, depth + 1)) };
    }
    const entries = Object.entries(v); truncated ||= entries.length > 60;
    return { type: 'object', fields: Object.fromEntries(entries.slice(0, 60).map(([key, value]) => [
      /^[A-Za-z_$][A-Za-z0-9_$:]{0,63}$/.test(key) && !/\d{6,}/.test(key) ? key : `key_${digest(key)}`,
      /token|cookie|authorization|password|secret|ticket|headers|stack|receiver|mobile|phone|address|^componentized_data$/i.test(key)
        ? { type: 'redacted' } : shape(value, depth + 1),
    ])) };
  };
  const text = (v) => {
    if (typeof v !== 'string') return '';
    previewTruncated ||= v.length > 180;
    return v.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').trim().slice(0, 180);
  };
  const identity = (order) => [
    ['shop_id', shopId], ['security_user_id', buyerId], ['buyer_info.security_user_id', buyerId],
  ].map(([path, expected]) => ({ path, value: field(at(order, path)),
    present: at(order, path) != null, matches: at(order, path) != null && scalar(at(order, path)) === expected }));
    const report = { version: 2, kind: 'douyin_orders_probe', observedAt,
    frameOrigin: ['https://im.jinritemai.com', 'https://pigeon.jinritemai.com'].includes(frameOrigin) ? frameOrigin : null,
    request: { endpoint: '/backstage/cmpoent/order/query', page_no: 0, page_size: 5,
      shop: field(shopId), buyer: field(buyerId), conversation: field(conversationId) },
    buyerEvidence: ['collected_conversation', 'security_src_user_id_matches'].includes(buyerEvidence) ? buyerEvidence : 'unverified',
    requestAssociation: 'unverified', httpStatus: Number.isSafeInteger(result?.httpStatus) ? result.httpStatus : null,
    elapsedMs: Number.isSafeInteger(result?.elapsedMs) ? result.elapsedMs : null,
    code: null, outcome: 'unavailable', error: null, receivedCount: null, previewCount: 0,
    queryCoverage: 'first_page_only_unknown_total_and_sort', pagination: {}, orders: [],
    responseShape: null, truncated: false, previewTruncated: false };
  const preview = [];
  let data;
  if (result?.error) report.error = Object.hasOwn(errors, result.error) ? result.error : 'execution_error';
  else {
    try { data = parseProductProbeJson(result?.body); }
    catch (error) { report.error = Object.hasOwn(errors, error.message) ? error.message : 'invalid_json'; }
    if (data !== undefined) report.responseShape = shape(data);
    if (!report.error && !(report.httpStatus >= 200 && report.httpStatus < 300)) report.error = 'http_error';
    const code = data?.code;
    report.code = Number.isSafeInteger(code) && Math.abs(code) < 1e9 ? code : null;
    if (!report.error && code !== 0) report.error = 'business_error';
    const binding = result?.requestBinding;
    if (typeof requestToken === 'string' && requestToken && binding?.token === requestToken
      && binding.shopId === shopId && binding.buyerId === buyerId && binding.conversationId === conversationId)
      report.requestAssociation = 'matched';
    if (!report.error && report.requestAssociation !== 'matched') report.error = 'request_binding_mismatch';
    if (!report.error && (!Array.isArray(data?.data) || data.data.length > 5)) report.error = 'invalid_shape';
  }
  if (!report.error) {
    report.receivedCount = data.data.length;
    report.pagination = Object.fromEntries(['total', 'total_count', 'has_more', 'page_no', 'page_size', 'page', 'size', 'current_tab', 'cursor']
      .map((key) => [key, field(data[key])]));
    const rootIdentity = identity(data);
    report.responseIdentity = rootIdentity;
    const rootConflict = rootIdentity.some((entry) => entry.present && !entry.matches);
    const ids = data.data.map((order) => idText(order?.order_id));
    for (const [index, order] of data.data.entries()) {
      const checks = identity(order);
      const conflict = rootConflict || checks.some((entry) => entry.present && !entry.matches);
      const id = ids[index];
      const valid = id && ids.filter((value) => value === id).length === 1;
      const buyerReturned = checks.some((entry) => entry.path.includes('security_user_id') && entry.present)
        || rootIdentity.some((entry) => entry.path.includes('security_user_id') && entry.present);
      const skus = Array.isArray(order?.sku_order_list) ? order.sku_order_list : [];
      const item = { index, orderId: field(order?.order_id), identity: checks,
        responseIdentity: conflict ? 'conflict' : buyerReturned ? 'explicit_buyer_matches' : 'not_returned',
        outcome: conflict ? 'identity_conflict' : !valid ? 'invalid_or_duplicate_order_id' : 'candidate_pending_review',
        skuCount: Array.isArray(order?.sku_order_list) ? skus.length : null, skusTruncated: skus.length > 20,
        statusFields: Object.fromEntries(['order_status', 'order_status_desc', 'aftersale_sum_status', 'aftersale_sum_status_desc']
          .map((key) => [key, field(order?.[key])])),
        timeFields: Object.fromEntries(['order_time_sec', 'pay_time_sec', 'logistics_time_sec']
          .map((key) => [key, field(order?.[key])])),
        amounts: Object.fromEntries(['actual_pay_amount', 'order_amount', 'discount_amount', 'post_amount',
          'total_pay_amount', 'total_post_amount', 'total_modify_amount', 'promotion_pay_amount',
          'total_promotion_amount', 'actual_pay_amount_str', 'total_pay_amount_str']
          .map((key) => [key, field(order?.[key])])),
        skuSamples: skus.slice(0, 20).map((sku) => ({ fields: Object.fromEntries(
          ['order_id', 'sku_order_id', 'product_id', 'product_name', 'sku_space_text', 'buy_num', 'quantity', 'price']
            .map((key) => [key, field(sku?.[key])])) })), reviewStatus: 'unreviewed' };
      report.orders.push(item);
      if (conflict || !valid) continue;
      const lines = [`${index + 1}. 订单编号：${id}`, `状态：${text(order.order_status_desc) || '暂缺'}`,
        `售后：${text(order.aftersale_sum_status_desc) || '暂缺'}`];
      for (const key of ['actual_pay_amount', 'order_amount', 'discount_amount', 'post_amount']) {
        const amount = scalar(order[key]);
        if (amount !== null && /^-?\d{1,20}(?:\.\d{1,8})?$/.test(amount)) lines.push(`${key}：${amount}（原始值，单位待核验）`);
      }
      const paid = Number(order.pay_time_sec);
      if ((typeof order.pay_time_sec === 'number' || typeof order.pay_time_sec === 'string')
        && paid >= 946684800 && paid <= 4102444800) lines.push(`付款时间（候选秒值）：${new Date(paid * 1000).toISOString()}`);
      for (const [i, sku] of skus.slice(0, 20).entries()) lines.push(`商品 ${i + 1}：${text(sku?.product_name) || '名称暂缺'}\n规格：${text(sku?.sku_space_text) || '暂缺'}`);
      if (!Array.isArray(order.sku_order_list)) lines.push('商品条目结构尚未识别');
      if (skus.length > 20) { lines.push('商品条目超过 20 项，预览有省略'); previewTruncated = true; }
      const joined = lines.join('\n');
      previewTruncated ||= joined.length > 2400;
      preview.push(joined.slice(0, 2400));
    }
    report.previewCount = preview.length;
    report.outcome = rootConflict ? 'identity_conflict' : data.data.length === 0 ? 'candidate_empty'
      : preview.length === data.data.length ? 'candidate_pending_review' : preview.length ? 'candidate_partial' : 'unavailable';
  }
  report.truncated = truncated;
  report.previewTruncated = previewTruncated;
  return { report, preview, summary: report.error ? errors[report.error]
    : report.outcome === 'candidate_empty' ? '本次查询范围内未返回订单，查询覆盖范围尚未确认'
    : report.outcome === 'identity_conflict' || !preview.length ? '订单身份冲突或字段尚未识别，请导出脱敏样本'
    : `本次客户请求返回 ${report.receivedCount} 单，可预览 ${preview.length} 单；请与原平台核对` };
}
