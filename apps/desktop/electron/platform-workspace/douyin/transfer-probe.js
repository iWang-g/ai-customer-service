// T1 reads staff candidates and capability only. Never calls the transfer method.
export async function probeDouyinTransfer(command) {
  const key = '__acsDouyinTransferProbeV1';
  if (!['im.jinritemai.com', 'pigeon.jinritemai.com'].includes(location.hostname)) return { error: 'invalid_origin' };
  if (command.action === 'cancel') {
    if (window[key]?.token === command.token) window[key].controller.abort();
    return null;
  }
  if (command.action !== 'read' || typeof command.token !== 'string' || !command.token
    || typeof command.shopId !== 'string' || !/^\d{1,40}$/.test(command.shopId)) return { error: 'invalid_command' };
  if (window[key]) return { error: 'busy' };
  const im = window.__PLATFORM_VARIABLES_IN_BENCH__?.extra?.im;
  if (!im) return { error: 'im_not_ready' };
  const capability = { pigeonIM: Boolean(im.pigeonIM), transferConversation: typeof im.pigeonIM?.transferConversation === 'function' };
  const controller = new AbortController();
  const state = { token: command.token, controller };
  window[key] = state;
  const started = Date.now();
  const timer = setTimeout(() => controller.abort(), 15000);
  let httpStatus = null;
  const readBody = async (response, limit) => {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('empty_body');
    const decoder = new TextDecoder();
    let bytes = 0, text = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > limit) throw new Error('response_too_large');
        text += decoder.decode(value, { stream: true });
      }
      return text + decoder.decode();
    } finally { await reader.cancel().catch(() => {}); }
  };
  const init = { method: 'GET', credentials: 'include', redirect: 'error', cache: 'no-store', signal: controller.signal };
  const readIdentity = async () => {
    const response = await fetch(`https://pigeon.jinritemai.com/backstage/currentuser?_ts=${Date.now()}&biz_type=4&_pms=1`, init);
    if (!response.ok) throw new Error('identity_unavailable');
    const data = JSON.parse(await readBody(response, 128 * 1024));
    const asId = (value) => typeof value === 'string' && value.length <= 128 && value.trim() ? value
      : Number.isSafeInteger(value) && value >= 0 ? String(value) : '';
    const shopId = asId(data?.data?.ShopId), staffId = asId(data?.data?.CustomerServiceInfo?.id);
    if (data?.code !== 0 || !shopId || !staffId) throw new Error('identity_unavailable');
    if (shopId !== command.shopId) throw new Error('identity_mismatch');
    return { shopId, staffId, staffName: typeof data.data.CustomerServiceInfo.screen_name === 'string'
      ? data.data.CustomerServiceInfo.screen_name.slice(0, 128) : '' };
  };
  try {
    const before = await readIdentity();
    const response = await fetch('https://pigeon.jinritemai.com/backstage/getCanAssignStaffList', init);
    httpStatus = response.status;
    const body = await readBody(response, 512 * 1024);
    const after = await readIdentity();
    if (before.staffId !== after.staffId || window.__PLATFORM_VARIABLES_IN_BENCH__?.extra?.im !== im)
      throw new Error('identity_mismatch');
    if (controller.signal.aborted) throw new Error('cancelled_or_timeout');
    return { body, httpStatus, capability, currentStaff: after, elapsedMs: Date.now() - started,
      requestBinding: { token: command.token, shopId: command.shopId, staffId: after.staffId } };
  } catch (error) {
    return { httpStatus, capability, elapsedMs: Date.now() - started, error: controller.signal.aborted ? 'cancelled_or_timeout'
      : ['empty_body', 'response_too_large', 'identity_unavailable', 'identity_mismatch', 'cancelled_or_timeout'].includes(error?.message)
        ? error.message : 'network_or_parse_error' };
  } finally {
    clearTimeout(timer);
    if (window[key] === state) delete window[key];
  }
}

export const transferProbeScript = (command) => `(${probeDouyinTransfer.toString()})(${JSON.stringify(command)})`;
