// Runs only in the already authenticated shop frame; no message SDK methods.
export async function probeDouyinOrders(command) {
  const key = '__acsDouyinOrderProbeV1';
  if (!['im.jinritemai.com', 'pigeon.jinritemai.com'].includes(location.hostname)) return { error: 'invalid_origin' };
  if (command.action === 'cancel') {
    if (window[key]?.token === command.token) window[key].controller.abort();
    return null;
  }
  if (command.action !== 'read' || typeof command.token !== 'string' || !command.token
    || typeof command.shopId !== 'string' || !/^\d{1,40}$/.test(command.shopId)
    || typeof command.buyerId !== 'string' || !/^[^\s:\u0000-\u001f\u007f]{1,256}$/.test(command.buyerId)
    || command.conversationId !== `${command.buyerId}:${command.shopId}::2:1:pigeon`) return { error: 'invalid_command' };
  if (window[key]) return { error: 'busy' };
  if (!window.__PLATFORM_VARIABLES_IN_BENCH__?.extra?.im) return { error: 'im_not_ready' };
  const controller = new AbortController();
  const state = { token: command.token, controller };
  window[key] = state;
  const timer = setTimeout(() => controller.abort(), 15000);
  const started = Date.now();
  let httpStatus = null;
  const readBody = async (response, limit) => {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('empty_body');
    const decoder = new TextDecoder();
    let size = 0, text = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw new Error('response_too_large');
        text += decoder.decode(value, { stream: true });
      }
      return text + decoder.decode();
    } finally { await reader.cancel().catch(() => {}); }
  };
  const identityMatches = async () => {
    const response = await fetch(`https://pigeon.jinritemai.com/backstage/currentuser?_ts=${Date.now()}&biz_type=4&_pms=1`, {
      credentials: 'include', redirect: 'error', cache: 'no-store', signal: controller.signal,
    });
    if (!response.ok) throw new Error('identity_unavailable');
    const data = JSON.parse(await readBody(response, 128 * 1024));
    const id = data?.data?.ShopId;
    return data?.code === 0 && (typeof id === 'string' || Number.isSafeInteger(id)) && String(id) === command.shopId;
  };
  try {
    if (!await identityMatches()) return { error: 'identity_mismatch' };
    const response = await fetch(`https://pigeon.jinritemai.com/backstage/cmpoent/order/query?biz_type=4&PIGEON_BIZ_TYPE=2&_pms=1&FUSION=true&_ts=${Date.now()}`, {
      method: 'POST', credentials: 'include', redirect: 'error', cache: 'no-store', signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ security_user_id: command.buyerId, page_no: 0, page_size: 5,
        tab_type: 0, search_words: '', is_init_tab: 0, biz_type: 2, version: '1.0',
        workstation_opt_version: 'v2', service_entity_id: '', workstation_opt_gray: true }),
    });
    httpStatus = response.status;
    const body = await readBody(response, 512 * 1024);
    if (!await identityMatches()) return { error: 'identity_mismatch' };
    if (controller.signal.aborted) return { error: 'cancelled_or_timeout' };
    return { body, httpStatus, elapsedMs: Date.now() - started,
      requestBinding: { token: command.token, shopId: command.shopId, buyerId: command.buyerId,
        conversationId: command.conversationId } };
  } catch (error) {
    return { httpStatus, elapsedMs: Date.now() - started, error: controller.signal.aborted ? 'cancelled_or_timeout'
      : ['empty_body', 'response_too_large', 'identity_unavailable'].includes(error?.message) ? error.message : 'network_or_parse_error' };
  } finally {
    clearTimeout(timer);
    if (window[key] === state) delete window[key];
  }
}

export const orderProbeScript = (command) => `(${probeDouyinOrders.toString()})(${JSON.stringify(command)})`;
