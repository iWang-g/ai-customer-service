export const DOUYIN_LOGIN_URL = 'https://fxg.jinritemai.com/login/common';

export function isDouyinUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && (url.hostname === 'jinritemai.com' || url.hostname.endsWith('.jinritemai.com'));
  } catch {
    return false;
  }
}

// Executed in the platform frame's main world. M0 only reads identity/readiness;
// it never installs a message hook, submits a reply or changes staff status.
export async function probeDouyinPage() {
  const im = window.__PLATFORM_VARIABLES_IN_BENCH__?.extra?.im;
  const imReady = Boolean(im && typeof im.sendText === 'function');
  if (location.hostname === 'fxg.jinritemai.com' && location.pathname.startsWith('/login')) {
    return { state: 'login_required', imReady: false };
  }
  if (location.hostname === 'fxg.jinritemai.com') {
    return { state: 'backend', imReady: false };
  }
  if (!['pigeon.jinritemai.com', 'im.jinritemai.com'].includes(location.hostname)) return { state: 'waiting', imReady };
  try {
    const response = await fetch(`https://pigeon.jinritemai.com/backstage/currentuser?_ts=${Date.now()}&biz_type=4&_pms=1`, {
      credentials: 'include', signal: AbortSignal.timeout(8000),
    });
    if (response.status === 401) return { state: 'login_required', imReady: false };
    if (response.status === 403) return { state: 'error', detail: '店铺信息查询被平台拒绝 (403)', imReady: false };
    if (!response.ok) return { state: 'error', detail: `店铺信息查询失败 (${response.status})`, imReady: false };
    const result = await response.json();
    if (Number(result.code) === 10005 || Number(result.code) === 10008) {
      return { state: 'login_required', imReady: false };
    }
    if (result.code !== 0 || !result.data) return { state: 'error', detail: '暂未取得店铺信息，请检查平台登录状态', imReady: false };
    const data = result.data;
    const asId = (value) => typeof value === 'string' ? value.slice(0, 128)
      : Number.isSafeInteger(value) ? String(value) : '';
    const shopId = asId(data.ShopId);
    if (!shopId) return { state: 'error', detail: '平台未返回有效店铺 ID', imReady: false };
    return {
      state: 'identified', imReady, shopId,
      shopName: typeof data.ShopName === 'string' ? data.ShopName.slice(0, 64) : '',
      logoUrl: typeof data.ShopLogo === 'string' ? data.ShopLogo.slice(0, 2048) : '',
      staffId: asId(data.CustomerServiceInfo?.id),
      staffName: typeof data.CustomerServiceInfo?.screen_name === 'string'
        ? data.CustomerServiceInfo.screen_name.slice(0, 128) : '',
    };
  } catch {
    return { state: 'error', detail: '店铺信息暂时无法读取，请刷新客服页面重试', imReady: false };
  }
}

export const DOUYIN_PROBE_SCRIPT = `(${probeDouyinPage.toString()})()`;
