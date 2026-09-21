import { createHmac, randomBytes } from 'node:crypto';

// Inspect locally only. Never follow a server-supplied URL or export its values.
export function productDetailLinkReport(value, productId) {
  const report = { present: value != null, status: 'missing', links: [], productIds: [],
    promotionIds: [], truncated: false };
  if (value == null) return report;
  const salt = randomBytes(32);
  const safeName = (name) => /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(name) ? name
    : `key_${createHmac('sha256', salt).update(name).digest('hex').slice(0, 16)}`;
  const hosts = new Set(['haohuo.jinritemai.com', 'fxg.jinritemai.com', 'im.jinritemai.com', 'pigeon.jinritemai.com']);
  const inspect = (raw, depth, parent) => {
    if (typeof raw !== 'string' || raw.length > 4096 || depth > 2 || report.links.length >= 8) {
      report.truncated = true;
      return;
    }
    let url;
    try { url = new URL(raw); } catch { return; }
    const knownProtocol = ['https:', 'http:', 'sslocal:', 'snssdk1128:'].includes(url.protocol);
    const trusted = url.protocol === 'https:' && hosts.has(url.hostname) && !url.username && !url.password && !url.port;
    const index = report.links.length;
    const params = [...url.searchParams.entries()];
    const link = { parent, protocol: knownProtocol ? url.protocol : 'other',
      host: hosts.has(url.hostname) ? url.hostname : null, trustedPlatformUrl: trusted,
      parameterNames: params.slice(0, 40).map(([key]) => safeName(key)) };
    report.links.push(link);
    if (params.length > 40) report.truncated = true;
    // Check all explicit product IDs, including duplicate/conflicting parameters,
    // even if the exported parameter-name list is truncated.
    for (const [key, candidate] of params) {
      if (trusted && key === 'product_id') {
        const valid = /^\d{1,40}$/.test(candidate);
        report.productIds.push({ link: index, parameter: key, valid, matches: valid && candidate === productId });
      }
      if (key === 'promotion_id') report.promotionIds.push({ link: index, parameter: key,
        valid: /^\d{1,40}$/.test(candidate), matchesRequestedProduct: candidate === productId,
        interpretation: 'unverified' });
      if ((trusted || ['sslocal:', 'snssdk1128:'].includes(url.protocol))
        && ['url', 'target_url', 'web_url', 'schema'].includes(key)) inspect(candidate, depth + 1, index);
    }
  };
  inspect(value, 0, null);
  report.status = !report.links.length ? 'invalid_or_oversized'
    : report.productIds.some((entry) => !entry.matches) ? 'product_id_conflict'
      : report.productIds.length ? 'product_id_matches' : 'no_verified_product_id';
  // The input size bounds work; export only bounded diagnostics.
  for (const key of ['productIds', 'promotionIds']) {
    if (report[key].length > 40) { report[key] = report[key].slice(0, 40); report.truncated = true; }
  }
  return report;
}
