const RISK_PATH_MARKERS = ['/risk', '/verify', '/captcha'];

export function classifyPddPage(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !(
      url.hostname === 'pinduoduo.com' || url.hostname.endsWith('.pinduoduo.com')
    )) return 'unsupported';
    const path = url.pathname.toLowerCase();
    if (path.startsWith('/login')) return 'login_required';
    if (RISK_PATH_MARKERS.some((marker) => path.includes(marker))) return 'risk_control';
    if (path.startsWith('/chat-windows') || path.startsWith('/chat-merchant')) return 'online';
    return 'unknown';
  } catch {
    return 'unsupported';
  }
}
