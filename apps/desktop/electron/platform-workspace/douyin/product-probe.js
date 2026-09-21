// Serialized into an existing shop frame. Only fixed read endpoints are allowed.
export async function probeDouyinProducts(command) {
  const key = '__acsDouyinProductProbeV1';
  if (!['im.jinritemai.com', 'pigeon.jinritemai.com'].includes(location.hostname)) return { error: 'invalid_origin' };
  if (command.action === 'cancel') {
    if (window[key]?.token === command.token) window[key].controller.abort();
    return null;
  }
  if (command.action !== 'read' || typeof command.shopId !== 'string' || !command.shopId
    || typeof command.token !== 'string' || (command.productId !== undefined
      && (typeof command.productId !== 'string' || !/^\d{1,40}$/.test(command.productId)))) return { error: 'invalid_command' };
  if (window[key]) return { error: 'busy' };
  if (!window.__PLATFORM_VARIABLES_IN_BENCH__?.extra?.im) return { error: 'im_not_ready' };
  const controller = new AbortController();
  const state = { token: command.token, controller };
  window[key] = state;
  const timer = setTimeout(() => controller.abort(), command.productId ? 20000 : 12000);
  let httpStatus = null;
  const readBody = async (response, limit) => {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('empty_body');
    const decoder = new TextDecoder();
    let size = 0;
    let text = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
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
      credentials: 'include', signal: controller.signal, redirect: 'error', cache: 'no-store',
    });
    if (!response.ok) throw new Error('identity_unavailable');
    const identity = JSON.parse(await readBody(response, 128 * 1024));
    const id = identity?.data?.ShopId;
    return identity?.code === 0 && (typeof id === 'string' || Number.isSafeInteger(id)) && String(id) === command.shopId;
  };
  try {
    if (!await identityMatches()) return { error: 'identity_mismatch' };
    const response = await fetch(`https://pigeon.jinritemai.com/backstage/workstation/get_product_list?busy=1&_ts=${Date.now()}&biz_type=4&_pms=1`, {
      method: 'POST', credentials: 'include', redirect: 'error', cache: 'no-store', signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ search_words: '', biz_type: 4, business_type: 4, check_status: 3,
        hot_style: 0, is_channel: 0, page_no: 0, page_size: 20,
        presale_biz_scene: 'b_product_list', status: 0, user_id: '' }),
    });
    httpStatus = response.status;
    // Return bounded JSON text to the main process, so long numeric IDs can be
    // read from JSON.parse's source context without rounding them in the frame.
    const body = await readBody(response, 512 * 1024);
    if (command.productId) {
      // A fresh shop-list membership check precedes every diagnostic detail read.
      // The renderer's product ID alone is not proof of ownership.
      const list = JSON.parse(body, (_key, value, context) => {
        if (typeof value === 'number' && !Number.isSafeInteger(value)) {
          if (!context?.source) throw new Error('number_precision_unavailable');
          return context.source;
        }
        return value;
      });
      const matches = Array.isArray(list?.data) ? list.data.filter((row) =>
        String(row?.product_item?.product_id) === command.productId) : [];
      const item = matches[0]?.product_item;
      if (!response.ok || list?.code !== 0 || matches.length !== 1
        || (item?.product_base_info?.product_id != null && String(item.product_base_info.product_id) !== command.productId)
        || (item?.shop_id != null && String(item.shop_id) !== command.shopId)) return { error: 'ownership_unverified' };
      if (!await identityMatches()) return { error: 'identity_mismatch' };
      const readSource = async (source, url, options = {}) => {
        const started = Date.now();
        const requestBinding = { token: command.token, productId: command.productId, shopId: command.shopId, source };
        let status = null;
        // Each source has its own deadline, so one timeout leaves time for the
        // final shop identity check and does not discard the other source.
        const sourceController = new AbortController();
        const abort = () => sourceController.abort();
        controller.signal.addEventListener('abort', abort, { once: true });
        if (controller.signal.aborted) abort();
        const sourceTimer = setTimeout(abort, 7000);
        try {
          const res = await fetch(url, { ...options, credentials: 'include', redirect: 'error',
            cache: 'no-store', signal: sourceController.signal });
          status = res.status;
          return { requestBinding, httpStatus: status, body: await readBody(res, 512 * 1024), elapsedMs: Date.now() - started };
        } catch (error) {
          return { requestBinding, httpStatus: status, elapsedMs: Date.now() - started, error: sourceController.signal.aborted
            ? 'cancelled_or_timeout' : error?.message === 'response_too_large' ? 'response_too_large' : 'network_or_parse_error' };
        } finally { clearTimeout(sourceTimer); controller.signal.removeEventListener('abort', abort); }
      };
      const [specifications, attributes] = await Promise.all([
        readSource('specifications', `https://pigeon.jinritemai.com/backstage/workstation/get_skuinfo_list?PIGEON_BIZ_TYPE=2&product_id=${command.productId}&security_user_id=&_pms=1`),
        readSource('attributes', `https://haohuo.jinritemai.com/aweme/v2/shop/promotion/pack/detail/?is_h5=1&origin_type=1337&_ts=${Date.now()}`, {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `promotion_id=${command.productId}&enter_from=&meta_param=&is_h5=1`,
        }),
      ]);
      if (!await identityMatches()) return { error: 'identity_mismatch' };
      return { httpStatus, body, specifications, attributes };
    }
    if (!await identityMatches()) return { error: 'identity_mismatch' };
    return { httpStatus, body };
  } catch (error) {
    const known = ['empty_body', 'response_too_large', 'identity_unavailable', 'number_precision_unavailable'];
    return { httpStatus, error: controller.signal.aborted ? 'cancelled_or_timeout'
      : known.includes(error?.message) ? error.message : 'network_or_parse_error' };
  } finally {
    clearTimeout(timer);
    if (window[key] === state) delete window[key];
  }
}

export const productProbeScript = (command) => `(${probeDouyinProducts.toString()})(${JSON.stringify(command)})`;
