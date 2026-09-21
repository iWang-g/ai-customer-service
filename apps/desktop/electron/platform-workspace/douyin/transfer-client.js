import { probeDouyinTransfer } from './transfer-probe.js';

// Executed only for an explicit manual request. Polling never resubmits.
export async function runDouyinTransfer(command, probe) {
  if (!['im.jinritemai.com', 'pigeon.jinritemai.com'].includes(location.hostname)) throw new Error('不是飞鸽页面');
  const key = '__acsDouyinTransfersV1';
  const im = window.__PLATFORM_VARIABLES_IN_BENCH__?.extra?.im;
  const sdk = im?.pigeonIM;
  const get = (o, k) => o && typeof o === 'object' ? Object.getOwnPropertyDescriptor(o, k)?.value : undefined;
  const id = (v) => {
    if (typeof v === 'string' && v.length <= 350 && v && v !== '0') return v;
    if (Number.isSafeInteger(v) && v > 0) return String(v);
    if (typeof v === 'bigint' && v > 0n) return String(v);
    const low = get(v, 'low'), high = get(v, 'high');
    if (Number.isInteger(low) && Number.isInteger(high)) {
      const bits = (BigInt(high >>> 0) << 32n) | BigInt(low >>> 0);
      return bits > 0n ? String(get(v, 'unsigned') ? bits : BigInt.asIntN(64, bits)) : null;
    }
    return null;
  };
  const targets = async () => {
    const result = await probe({ action: 'read', token: command.token, shopId: command.shopId });
    if (result.error || result.httpStatus !== 200 || result.currentStaff?.staffId !== command.staffId
      || !result.capability?.transferConversation) throw new Error('客服列表或当前登录身份无法核验，请刷新后重试');
    const data = JSON.parse(result.body, (_k, v, context) => Number.isInteger(v) && !Number.isSafeInteger(v)
      ? context?.source || null : v);
    if (data.code !== 0 || !Array.isArray(data.data)) throw new Error('客服列表返回异常');
    const conflict = (row) => ['shop_id', 'shopId'].some((k) => row?.[k] != null && id(row[k]) !== command.shopId);
    if (conflict(data)) throw new Error('客服列表店铺身份不匹配');
    const counts = new Map();
    for (const row of data.data) { const staffId = id(row?.staffId); counts.set(staffId, (counts.get(staffId) || 0) + 1); }
    return data.data.filter((row) => row && row.status === 1 && !conflict(row)
      && /^\d{1,40}$/.test(id(row.staffId) || '') && id(row.staffId) !== command.staffId && counts.get(id(row.staffId)) === 1)
      .slice(0, 100).map((row) => ({ id: id(row.staffId),
        name: (typeof row.staffName === 'string' && row.staffName.trim() ? row.staffName
          : typeof row.staff_username === 'string' && row.staff_username.trim() ? row.staff_username : String(row.staffId))
          .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, 128) }));
  };
  if (command.action === 'list') return { targets: await targets() };
  let state = window[key];
  if (!state || state.im !== im) {
    state = { im, entries: new Map(), receiveMessage(args) {
      const visit = (message, depth = 0) => {
        if (Array.isArray(message) && depth < 2) {
          for (let i = 0; i < Math.min(message.length, 20); i++) visit(get(message, String(i)), depth + 1);
          return;
        }
        if (!message || typeof message !== 'object') return;
        const ext = get(message, 'ext'), cid = get(message, 'securityConversationId') || get(message, 'conversationId');
        for (const entry of state.entries.values()) {
          if (!entry.submittedAt || entry.evidence || Date.now() - entry.submittedAt > 20000 || state.im !== im
            || window.__PLATFORM_VARIABLES_IN_BENCH__?.extra?.im !== im || cid !== entry.cid
            || get(ext, 'security_biz_conversation_id') !== entry.cid || get(ext, 'shop_id') !== entry.shopId
            || id(get(ext, 'to_trans_uid')) !== entry.targetId || id(get(ext, 'src_user_id')) !== entry.staffId
            || id(get(message, 'originSender')) !== entry.staffId
            || get(message, 'serverStatus') !== 0 || get(message, 'isOffline') !== false || get(message, 'pullSource') !== 1) continue;
          const serverId = id(get(message, 'serverId'));
          const rawTime = get(message, 'createdAt');
          const sentAt = rawTime instanceof Date ? Date.prototype.getTime.call(rawTime)
            : typeof rawTime === 'string' ? Date.parse(rawTime) : NaN;
          const now = Date.now();
          if (!serverId || serverId.length > 128 || !Number.isFinite(sentAt) || sentAt < entry.submittedAt - 5000
            || sentAt > now + 5000) continue;
          entry.evidence = { method: 'douyin_transfer_event_v1', conversation_id: entry.cid, shop_id: entry.shopId,
            source_staff_id: entry.staffId, target_staff_id: entry.targetId, server_id: serverId,
            server_status: 0, is_offline: false, pull_source: 1, submitted_at: new Date(entry.submittedAt).toISOString(),
            platform_sent_at: new Date(sentAt).toISOString(), observed_at: new Date(now).toISOString() };
        }
      };
      visit(args);
    } };
    window[key] = state;
  }
  if (!['submit', 'poll'].includes(command.action)) throw new Error('转接操作无效');
  let entry = state.entries.get(command.operationId);
  if (command.action === 'submit' && !entry) {
    const suffix = `:${command.shopId}::2:1:pigeon`;
    if (!/^[a-f0-9]{32}$/.test(command.operationId || '') || !command.cid?.endsWith(suffix)
      || !command.cid.slice(0, -suffix.length) || command.cid.slice(0, -suffix.length).includes(':')) throw new Error('会话参数无效');
    if (state.entries.size >= 100) throw new Error('请刷新飞鸽页面后再转接');
    entry = { cid: command.cid, shopId: command.shopId, staffId: command.staffId, targetId: command.targetId };
    state.entries.set(command.operationId, entry); // Duplicate submissions share this entry even during verification.
    try {
      const list = await targets();
      if (!list.some((t) => t.id === command.targetId)) throw new Error('目标客服已离线、离开列表或不是唯一目标，请重新选择');
      if (window[key] !== state || window.__PLATFORM_VARIABLES_IN_BENCH__?.extra?.im !== im
        || im.pigeonIM !== sdk || !window.__acsDouyinObservationV1?.messageHook || window.__acsDouyinObservationV1.im !== im)
        throw new Error('消息接收入口尚未就绪，未提交转接');
      entry.submittedAt = Date.now();
      try {
        Promise.resolve(im.pigeonIM.transferConversation('2', entry.cid, entry.targetId)).then(
          () => { entry.resolved = true; }, () => { entry.error = '平台调用异常，转接结果待核对'; });
      } catch { entry.error = '平台调用异常，转接结果待核对'; }
    } catch (error) { entry.failed = true; entry.error = error.message; }
  }
  if (!entry || entry.cid !== command.cid || entry.targetId !== command.targetId || entry.staffId !== command.staffId)
    return { status: 'confirmation_pending', error: '页面或转接状态变化，请在飞鸽核对' };
  if (entry.failed && !entry.submittedAt) return { status: 'failed', error: entry.error, evidence: { submitted: false } };
  if (entry.resolved && entry.evidence) return { status: 'transferred', evidence: { ...entry.evidence, sdk_resolved: true } };
  return { status: 'confirmation_pending', error: entry.error || '尚未收到匹配的转出事件，请在飞鸽核对' };
}

export const transferClientScript = (command) => `(${runDouyinTransfer.toString()})(${JSON.stringify(command)}, ${probeDouyinTransfer.toString()})`;
