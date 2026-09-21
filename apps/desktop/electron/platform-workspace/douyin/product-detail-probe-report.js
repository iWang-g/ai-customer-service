import { buildProductProbeReport, parseProductProbeJson, idText, PRODUCT_PROBE_ERRORS } from './product-probe-report.js';
import { mapDouyinProducts } from './products.js';
import { productDetailLinkReport } from './product-detail-link-report.js';

const pathValue = (value, path) => path.split('.').reduce((item, key) => item?.[key], value);
const text = (value) => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').trim().slice(0, 180) : '';
const errors = { ...PRODUCT_PROBE_ERRORS, product_identity_missing: '返回商品身份尚未确认，仅保留脱敏结构',
  request_binding_mismatch: '详情与本次商品请求关联不一致，未展示详情',
  product_identity_mismatch: '返回商品身份不一致，未展示详情', invalid_detail_shape: '详情字段结构尚未识别' };

// Only named textual fields enter the transient preview. Full responses and
// preview values never enter the retained/exported diagnostic report.
export function buildProductDetailProbeReport(result, { productId, shopId, frameOrigin, requestToken,
  observedAt = new Date().toISOString() } = {}) {
  const list = buildProductProbeReport(result, { frameOrigin, observedAt });
  const report = { version: 2, kind: 'douyin_product_detail_probe', observedAt, frameOrigin: list.report.frameOrigin,
    ownership: { outcome: 'unverified', error: null, httpStatus: list.report.httpStatus,
      code: list.report.code, total: list.report.total, receivedCount: list.report.receivedCount }, sources: {} };
  const preview = [];
  let owned;
  try {
    if (typeof productId !== 'string' || !/^\d{1,40}$/.test(productId)) throw new Error();
    owned = mapDouyinProducts(result).products.find((row) => row.product_id === productId);
    const raw = parseProductProbeJson(result.body).data.find((row) => idText(row?.product_item?.product_id) === productId)?.product_item;
    if (!owned || (raw.shop_id != null && idText(raw.shop_id) !== shopId)) throw new Error();
  } catch {
    report.ownership.error = result?.error && Object.hasOwn(errors, result.error) ? result.error : 'ownership_unverified';
    return { report, preview, summary: errors[report.ownership.error] };
  }
  report.ownership.outcome = 'verified_in_current_first_page';
  preview.push(`商品：${text(owned.title)}\n商品 ID：${productId}`);
  const definitions = [
    { key: 'specifications', label: '规格', endpoint: '/backstage/workstation/get_skuinfo_list', code: 'code',
      ids: ['data.product_info.product_id'], field: 'data.product_info.spec_detail_info' },
    { key: 'attributes', label: '属性', endpoint: '/aweme/v2/shop/promotion/pack/detail/', code: 'status_code',
      ids: ['detail_info.product_id', 'detail_info.product_info.product_id'], field: 'detail_info.product_format' },
  ];
  for (const definition of definitions) {
    const source = result[definition.key];
    // Reuse the bounded structural redactor; ignore list-specific validation.
    const structural = buildProductProbeReport(source, { frameOrigin, observedAt }).report;
    const item = { endpoint: definition.endpoint, httpStatus: structural.httpStatus,
      elapsedMs: Number.isSafeInteger(source?.elapsedMs) ? source.elapsedMs : null,
      code: null, outcome: 'unavailable', error: null, identity: [],
      requestAssociation: 'unverified', responseIdentity: 'not_checked', reviewStatus: 'unreviewed',
      groupCount: null, entryCount: null, previewTruncated: false,
      responseShape: structural.responseShape, truncated: structural.truncated };
    report.sources[definition.key] = item;
    let data;
    if (source?.error) item.error = Object.hasOwn(errors, source.error) ? source.error : 'execution_error';
    else {
      try { data = parseProductProbeJson(source?.body); }
      catch (error) { item.error = Object.hasOwn(errors, error.message) ? error.message : 'invalid_json'; }
      if (!(item.httpStatus >= 200 && item.httpStatus < 300)) item.error = 'http_error';
    }
    if (!item.error) {
      const binding = source?.requestBinding;
      if (typeof requestToken === 'string' && requestToken.length > 0 && binding?.token === requestToken
        && binding.productId === productId && binding.shopId === shopId && binding.source === definition.key)
        item.requestAssociation = 'matched';
      else item.error = 'request_binding_mismatch';
      const code = data?.[definition.code];
      item.code = Number.isSafeInteger(code) && Math.abs(code) < 1e9 ? code : null;
      if (!item.error && code !== 0) item.error = 'business_error';
      item.identity = definition.ids.map((path) => {
        const value = pathValue(data, path);
        return { path, present: value !== undefined && value !== null,
          matches: idText(value) === productId };
      });
      const present = item.identity.filter((entry) => entry.present);
      if (definition.key === 'attributes') item.jumpUrl = productDetailLinkReport(data?.detail_info?.jump_url, productId);
      const conflict = present.some((entry) => !entry.matches) || item.jumpUrl?.status === 'product_id_conflict';
      item.responseIdentity = conflict ? 'conflict' : present.length ? 'explicit_id_matches'
        : item.jumpUrl?.status === 'product_id_matches' && !item.jumpUrl.truncated ? 'jump_url_id_matches' : 'not_returned';
      if (!item.error && conflict) item.error = 'product_identity_mismatch';
      if (!item.error && !present.length && definition.key === 'specifications') item.error = 'product_identity_missing';
    }
    if (!item.error) {
      const groups = pathValue(data, definition.field);
      if (!Array.isArray(groups)) item.error = 'invalid_detail_shape';
      else {
        item.groupCount = groups.length;
        const lines = [];
        let count = 0;
        let malformed = false;
        const previewText = (value) => {
          if (typeof value === 'string' && value.length > 180) item.previewTruncated = true;
          return text(value);
        };
        for (const group of groups) {
          if (definition.key === 'specifications') {
            if (!text(group?.name) || !Array.isArray(group?.spec_details)) { malformed = true; continue; }
            const values = group.spec_details.map((entry) => previewText(entry?.name)).filter(Boolean);
            count += values.length;
            if (lines.length < 8 && values.length) lines.push(`${previewText(group.name)}：${values.slice(0, 12).join(' / ')}${values.length > 12 ? ' …（部分选项）' : ''}`);
            else if (values.length) item.previewTruncated = true;
            if (values.length > 12 || values.length !== group.spec_details.length) item.previewTruncated = true;
          } else {
            if (!Array.isArray(group?.format)) { malformed = true; continue; }
            for (const attribute of group.format) {
              if (!text(attribute?.name) || !Array.isArray(attribute?.message)) { malformed = true; continue; }
              const values = attribute.message.map((entry) => previewText(entry?.desc)).filter(Boolean);
              if (values.length) {
                count++;
                if (lines.length < 20) lines.push(`${previewText(attribute.name)}：${values.slice(0, 6).join(' / ')}`);
                else item.previewTruncated = true;
              }
              if (values.length > 6 || values.length !== attribute.message.length) item.previewTruncated = true;
            }
          }
        }
        item.entryCount = count;
        item.previewTruncated ||= malformed;
        const pendingIdentity = definition.key === 'attributes' && item.responseIdentity === 'not_returned';
        item.outcome = count ? pendingIdentity ? 'candidate_pending_review' : 'candidate_success'
          : malformed ? 'unavailable' : 'candidate_empty';
        if (malformed && !count) item.error = 'invalid_detail_shape';
        const joined = lines.join('\n');
        item.previewTruncated ||= joined.length > 1200;
        const heading = pendingIdentity ? '属性（本次商品请求返回，待原平台核对；响应未回显商品 ID）' : definition.label;
        if (!item.error) preview.push(`${heading}：${lines.length ? '\n' + joined.slice(0, 1200) : '未解析到可用条目'}${item.previewTruncated ? '\n（预览有省略或未识别字段，请以原平台为准）' : ''}`);
      }
    }
    if (item.error) preview.push(`${definition.label}：${errors[item.error]}`);
  }
  const usable = Object.values(report.sources).filter((source) => ['candidate_success', 'candidate_pending_review'].includes(source.outcome)).length;
  const pendingReview = report.sources.attributes?.outcome === 'candidate_pending_review';
  return { report, preview, summary: pendingReview ? '属性已返回，请与原平台核对候选内容'
    : usable === 2 ? '已取得规格和属性候选资料，请核对原平台'
    : usable ? '取得部分详情，另一路暂无可用资料' : '暂未取得可核对的详情，请导出脱敏样本分析' };
}
