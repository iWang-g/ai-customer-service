import fs from 'node:fs/promises';
import path from 'node:path';

export async function resolveProductBuyer(shopUid, cid, mainUid, cacheRoot = path.join(process.env.LOCALAPPDATA || '', 'QianniuTemp')) {
  const match = /^(\d+)\.1-(\d+)\.1#11001@cntaobao$/.exec(cid || '');
  if (!/^\d+$/.test(shopUid) || !/^\d+$/.test(mainUid) || !match || ![match[1], match[2]].includes(mainUid))
    throw new Error('商品详情会话不属于当前店铺');
  const identities = new Map();
  for (const name of ['data_0', 'data_1', 'data_2', 'data_3']) {
    let buffer;
    try {
      const file = path.join(cacheRoot, '3' + shopUid, 'Cache', 'Cache_Data', name);
      if ((await fs.stat(file)).size > 64 * 1024 * 1024) continue;
      buffer = await fs.readFile(file);
    } catch (error) { if (['ENOENT', 'EBUSY', 'EPERM'].includes(error.code)) continue; throw error; }
    for (const hit of buffer.toString('latin1').matchAll(/https:\/\/[^\s\x00-\x20"<>]{1,16000}/g)) {
      try {
        const url = new URL(hit[0]);
        if (!['h5api.m.taobao.com', 'acs.m.taobao.com'].includes(url.hostname) ||
            url.pathname !== '/h5/mtop.taobao.qianniu.cs.item.detail.query/1.0/' || url.searchParams.getAll('data').length !== 1) continue;
        const data = JSON.parse(url.searchParams.get('data'));
        if (data._message_cid === cid && typeof data.encryptId === 'string' && /^[a-zA-Z0-9_-]{8,256}$/.test(data.encryptId) &&
            typeof data.isNewCustomer === 'boolean') identities.set(JSON.stringify([data.encryptId, data.isNewCustomer]),
          { encryptId: data.encryptId, isNewCustomer: data.isNewCustomer });
      } catch { /* Never log URLs or guess buyer identities from another conversation. */ }
    }
  }
  if (identities.size !== 1) throw new Error('该会话尚无唯一可验证的商品详情身份缓存');
  return [...identities.values()][0];
}
