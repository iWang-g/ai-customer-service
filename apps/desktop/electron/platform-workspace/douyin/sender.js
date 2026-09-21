// Serialized into the verified IM frame. Polling never invokes sendText again.
export async function sendDouyinText(command) {
  if (!['im.jinritemai.com', 'pigeon.jinritemai.com'].includes(location.hostname)) throw new Error('Invalid IM origin');
  const im = window.__PLATFORM_VARIABLES_IN_BENCH__?.extra?.im;
  const key = '__acsDouyinSendsV1';
  const state = window[key] ||= new Map();
  let entry = state.get(command.taskId);
  if (command.action === 'send' && !entry) {
    if (!im || typeof im.sendText !== 'function') throw new Error('IM not ready');
    const suffix = `:${command.shopId}::2:1:pigeon`;
    const buyer = command.conversationId?.slice(0, -suffix.length);
    if (!command.conversationId?.endsWith(suffix) || !buyer || buyer.includes(':')
      || typeof command.content !== 'string' || !command.content.trim() || command.content.length > 4000) {
      throw new Error('Invalid send target or text');
    }
    // Identity is checked immediately before submission, including same-frame account changes.
    const response = await fetch(`https://pigeon.jinritemai.com/backstage/currentuser?_ts=${Date.now()}&biz_type=4&_pms=1`, {
      credentials: 'include', signal: AbortSignal.timeout(8000),
    });
    const identity = response.ok ? await response.json() : null;
    if (identity?.code !== 0 || String(identity.data?.ShopId) !== command.shopId
      || window.__PLATFORM_VARIABLES_IN_BENCH__?.extra?.im !== im) throw new Error('Shop identity changed or login expired');
    // A concurrent duplicate may have completed the same asynchronous identity check.
    entry = state.get(command.taskId);
    if (!entry) {
      entry = { conversationId: command.conversationId, content: command.content, result: null };
      state.set(command.taskId, entry);
      try {
        Promise.resolve(im.sendText(command.conversationId, command.content)).then(
          (result) => { entry.result = result; },
          () => { entry.error = 'SDK 调用异常，发送结果待确认'; },
        );
      } catch { entry.error = 'SDK 调用异常，发送结果待确认'; }
    }
  }
  if (!entry) return { status: 'confirmation_pending', error: '页面已变化，发送结果待确认' };
  const value = entry.result;
  const ext = value?.ext || {};
  const id = (v) => {
    if (typeof v === 'string') return v.length <= 128 && v !== '0' ? v : null;
    if (typeof v === 'bigint') return v > 0n ? String(v) : null;
    if (Number.isSafeInteger(v) && v > 0) return String(v);
    if (v && Number.isInteger(v.low) && Number.isInteger(v.high)) {
      const bits = (BigInt(v.high >>> 0) << 32n) | BigInt(v.low >>> 0);
      return bits > 0n ? String(v.unsigned ? bits : BigInt.asIntN(64, bits)) : null;
    }
    return null;
  };
  const platformId = id(value?.serverId || value?.serverMessageId);
  const matches = value && (value.securityConversationId || value.conversationId) === entry.conversationId
    && value.content === entry.content && ext['s:sender_biz_role'] === 'CurrentServer';
  const status = ext['s:send_response_status'];
  const check = ext['s:send_response_check_code'];
  const serverStatus = value?.serverStatus;
  const knownCode = (v) => typeof v === 'number' || typeof v === 'string' && /^\d+$/.test(v);
  if (matches && knownCode(status) && knownCode(check)) {
    if (Number(status) !== 0 || Number(check) !== 0) return {
      status: 'failed', error: '平台拒绝发送', response_status: String(status), check_code: String(check),
    };
    if (platformId && (serverStatus === 0 || serverStatus === '0')) {
      const time = value.createdAt instanceof Date ? value.createdAt.toISOString() : value.createTime;
      const millis = typeof time === 'number' ? time : /^\d+$/.test(time || '') ? Number(time) : Date.parse(time);
      return { status: 'completed', platform_message_id: platformId, text_sent: true,
        platform_sent_at: millis >= 946684800000 && millis <= 4102444800000 ? new Date(millis).toISOString() : null,
        response_status: String(status), check_code: String(check), method: 'douyin_im_send_text' };
    }
  }
  // Keep the SDK message identity even when receipt fields are missing. The server
  // can then confirm against an independently collected platform echo by ID.
  const sameConversation = value && (value.securityConversationId || value.conversationId) === entry.conversationId;
  return { status: 'confirmation_pending', error: entry.error || '等待平台发送确认', method: 'douyin_im_send_text',
    ...(sameConversation && value.content === entry.content ? {
      sdk_platform_message_id: platformId,
      sdk_client_message_id: id(ext['s:client_message_id']),
    } : {}),
    diagnostics: { resolved: value != null, conversation_matches: Boolean(sameConversation),
      content_matches: value?.content === entry.content, role: typeof ext['s:sender_biz_role'] === 'string' ? ext['s:sender_biz_role'].slice(0, 32) : null,
      response_status: knownCode(status) ? String(status) : null, check_code: knownCode(check) ? String(check) : null,
      server_status: knownCode(serverStatus) ? String(serverStatus) : null } };
}

export function senderScript(command) {
  return `(${sendDouyinText.toString()})(${JSON.stringify(command)})`;
}
