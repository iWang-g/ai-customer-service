import { createHmac, randomBytes } from 'node:crypto';
import { parseProductProbeJson, JsonNumber } from './product-probe-report.js';

const errors = {
  invalid_origin: '当前页面不是飞鸽接待页', invalid_command: '探测参数无效', busy: '该页面正在探测',
  im_not_ready: '飞鸽页面尚未就绪', identity_unavailable: '无法核验当前店铺或客服身份',
  identity_mismatch: '店铺或登录客服已变化，结果已丢弃', cancelled_or_timeout: '探测已取消或超时',
  network_or_parse_error: '网络或身份响应异常', response_too_large: '响应超过大小限制', empty_body: '平台响应为空',
  execution_error: '页面执行失败', invalid_json: '平台未返回有效 JSON', number_precision_unavailable: '无法保留长数字精度',
  http_error: '客服列表 HTTP 请求失败', business_error: '平台业务失败或成功码尚未识别',
  invalid_shape: '客服列表结构尚未识别', request_binding_mismatch: '探测请求关联不一致',
};
const scalar = (v) => v instanceof JsonNumber ? v.source : typeof v === 'string' || typeof v === 'number' ? String(v) : null;
const id = (v) => { const s = scalar(v); return s && /^[^\s\u0000-\u001f\u007f]{1,128}$/.test(s) ? s : null; };

export function buildTransferProbeReport(result, { shopId, requestToken, frameOrigin, observedAt = new Date().toISOString() }) {
  const salt = randomBytes(32);
  const digest = (v) => createHmac('sha256', salt).update(String(v)).digest('hex').slice(0, 20);
  const field = (v) => v === undefined ? { type: 'missing' } : v === null ? { type: 'null' }
    : typeof v === 'object' && !(v instanceof JsonNumber) ? { type: Array.isArray(v) ? 'array' : 'object' }
      : { type: v instanceof JsonNumber ? 'number' : typeof v, length: String(scalar(v) ?? v).length,
        fingerprint: digest(scalar(v) ?? v) };
  let budget = 2500, truncated = false, previewTruncated = false;
  const shape = (v, depth = 0) => {
    if (--budget < 0 || depth > 6) { truncated = true; return { type: 'limit' }; }
    if (!v || typeof v !== 'object' || v instanceof JsonNumber) return field(v);
    if (Array.isArray(v)) {
      truncated ||= v.length > 20;
      return { type: 'array', length: v.length, items: v.slice(0, 20).map((x) => shape(x, depth + 1)) };
    }
    const entries = Object.entries(v); truncated ||= entries.length > 50;
    return { type: 'object', fields: Object.fromEntries(entries.slice(0, 50).map(([key, value]) => [
      /^[A-Za-z_$][A-Za-z_$]{0,63}$/.test(key) ? key : `key_${digest(key)}`,
      /token|cookie|authorization|password|secret|ticket|headers|mobile|phone|address|email/i.test(key)
        ? { type: 'redacted' } : shape(value, depth + 1),
    ])) };
  };
  const text = (value, max = 100) => {
    const s = scalar(value) || '';
    previewTruncated ||= s.length > max;
    return s.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').slice(0, max);
  };
  const report = { version: 1, kind: 'douyin_transfer_probe', observedAt,
    frameOrigin: ['https://im.jinritemai.com', 'https://pigeon.jinritemai.com'].includes(frameOrigin) ? frameOrigin : null,
    request: { endpoint: '/backstage/getCanAssignStaffList', shop: field(shopId) },
    httpStatus: Number.isSafeInteger(result?.httpStatus) ? result.httpStatus : null,
    elapsedMs: Number.isSafeInteger(result?.elapsedMs) ? result.elapsedMs : null, code: null,
    capability: { pigeonIM: result?.capability?.pigeonIM === true, transferConversation: result?.capability?.transferConversation === true },
    requestAssociation: 'unverified', currentStaff: null, receivedCount: null, previewCount: 0,
    outcome: 'unavailable', error: null, staff: [], responseShape: null, truncated: false, previewTruncated: false };
  let data; const preview = [];
  if (result?.error) report.error = Object.hasOwn(errors, result.error) ? result.error : 'execution_error';
  else {
    try { data = parseProductProbeJson(result?.body); }
    catch (error) { report.error = Object.hasOwn(errors, error.message) ? error.message : 'invalid_json'; }
    if (data !== undefined) report.responseShape = shape(data);
    report.code = Number.isSafeInteger(data?.code) && Math.abs(data.code) < 1e9 ? data.code : null;
    if (!report.error && !(report.httpStatus >= 200 && report.httpStatus < 300)) report.error = 'http_error';
    if (!report.error && data?.code !== 0) report.error = 'business_error';
    const binding = result?.requestBinding, current = result?.currentStaff;
    if (requestToken && binding?.token === requestToken && binding.shopId === shopId
      && current?.shopId === shopId && id(current.staffId) && binding.staffId === current.staffId) report.requestAssociation = 'matched';
    if (!report.error && report.requestAssociation !== 'matched') report.error = 'request_binding_mismatch';
    if (!report.error && !Array.isArray(data?.data)) report.error = 'invalid_shape';
  }
  if (!report.error) {
    const current = result.currentStaff;
    report.currentStaff = { id: field(current.staffId), name: field(current.staffName) };
    preview.push(`当前登录客服：${text(current.staffName) || '名称暂缺'}；ID：${text(current.staffId, 128)}`);
    report.receivedCount = data.data.length;
    const items = data.data.slice(0, 100);
    previewTruncated ||= items.length < data.data.length;
    const ids = data.data.map((x) => id(x?.staffId));
    const names = data.data.map((x) => typeof x?.staffName === 'string' ? x.staffName.trim() : '');
    for (const [index, row] of items.entries()) {
      const staffId = id(row?.staffId);
      const duplicateId = Boolean(staffId && ids.filter((v) => v === staffId).length > 1);
      const duplicateName = Boolean(names[index] && names.filter((v) => v === names[index]).length > 1);
      const shopPresent = row?.shop_id != null || row?.shopId != null;
      const conflict = ['shop_id', 'shopId'].some((key) => row?.[key] != null && scalar(row[key]) !== shopId)
        || ['shop_id', 'shopId'].some((key) => data[key] != null && scalar(data[key]) !== shopId);
      const statusKeys = ['status', 'online_status', 'onlineStatus', 'staffStatus', 'statusDesc'];
      report.staff.push({ index, staffId: field(row?.staffId), staffName: field(row?.staffName),
        staffUsername: field(row?.staff_username), shopIdentity: conflict ? 'conflict' : shopPresent ? 'explicit_matches' : 'not_returned',
        validId: Boolean(staffId), duplicateId, duplicateName,
        sameIdAsCurrent: Boolean(staffId && staffId === current.staffId),
        statusFields: Object.fromEntries(statusKeys.map((k) => [k, field(row?.[k])])) });
      if (conflict || !staffId) continue;
      report.previewCount++;
      const status = statusKeys.filter((k) => scalar(row[k]) !== null).map((k) => `${k}=${text(row[k], 40)}`).join('；');
      preview.push(`${index + 1}. ${text(row.staffName) || '昵称暂缺'}；账号：${text(row.staff_username) || '暂缺'}\nID：${text(staffId, 128)}\n状态原值（含义待核验）：${status || '未知'}${duplicateId ? '\n客服 ID 重复' : ''}${duplicateName ? '\n存在同名客服，请核对账号' : ''}${staffId === current.staffId ? '\n与当前登录客服 ID 同值（标识体系待核验）' : ''}`);
    }
    const rootConflict = ['shop_id', 'shopId'].some((key) => data[key] != null && scalar(data[key]) !== shopId);
    report.outcome = rootConflict ? 'identity_conflict' : !items.length ? 'candidate_empty'
      : report.previewCount === items.length ? 'candidate_pending_review' : 'candidate_partial';
  }
  report.truncated = truncated; report.previewTruncated = previewTruncated;
  return { report, preview, summary: report.error ? errors[report.error]
    : report.outcome === 'identity_conflict' ? '列表返回的店铺身份冲突，候选已隐藏'
      : report.outcome === 'candidate_empty' ? '本次未返回可分配客服，不能据此断言店铺没有客服'
        : `返回 ${report.receivedCount} 个候选，预览 ${report.previewCount} 个；请与飞鸽核对` };
}
