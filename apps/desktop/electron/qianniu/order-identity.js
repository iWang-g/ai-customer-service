import fs from 'node:fs/promises';
import path from 'node:path';

export async function resolveOrderBuyer(shopUid, cid, mainUid, cacheRoot = path.join(process.env.LOCALAPPDATA || '', 'QianniuTemp')) {
  if (!/^\d+$/.test(shopUid) || !/^\d+$/.test(mainUid)) throw new Error('千牛订单账号无效');
  const match = /^(\d+)\.1-(\d+)\.1#11001@cntaobao$/.exec(cid);
  if (!match || ![match[1], match[2]].includes(mainUid)) throw new Error('订单会话不属于当前店铺');
  const buyerUid = match[1] === mainUid ? match[2] : match[1];
  const directory = path.join(cacheRoot, '3' + shopUid, 'Cache', 'Cache_Data');
  const identities = new Set();
  // Chromium's cache index contains complete request URLs. Use only this account,
  // fixed API/version and an exact CID match; never infer an encrypted ID from a UID.
  for (const name of ['data_0', 'data_1', 'data_2', 'data_3']) {
    let buffer;
    try {
      const file = path.join(directory, name);
      if ((await fs.stat(file)).size > 64 * 1024 * 1024) continue;
      buffer = await fs.readFile(file);
    } catch (error) { if (['ENOENT', 'EBUSY', 'EPERM'].includes(error.code)) continue; throw error; }
    for (const hit of buffer.toString('latin1').matchAll(/https:\/\/[^\s\x00-\x20"<>]{1,16000}/g)) {
      try {
        const url = new URL(hit[0]);
        if (!['h5api.m.taobao.com', 'acs.m.taobao.com'].includes(url.hostname) ||
            url.pathname.toLowerCase() !== '/h5/mtop.taobao.qianniu.cs.trade.query/1.0/' ||
            url.searchParams.getAll('data').length !== 1) continue;
        const data = JSON.parse(url.searchParams.get('data'));
        if (data._message_cid === cid && typeof data.securityBuyerUid === 'string' &&
            /^[a-zA-Z0-9_-]{8,256}$/.test(data.securityBuyerUid)) identities.add(data.securityBuyerUid);
      } catch { /* Ignore incomplete cache records. */ }
    }
  }
  if (identities.size !== 1) throw new Error(identities.size ? '买家身份缓存有冲突，暂无法查询订单' : '该买家尚无可验证的订单身份缓存');
  return { buyerUid, securityBuyerUid: [...identities][0] };
}
