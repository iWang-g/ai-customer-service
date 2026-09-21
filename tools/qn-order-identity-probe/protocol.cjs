'use strict';
// This factory is shared with the injected page; keep it self-contained.
function createProtocol() {
  const shopUid = '2223058140526', mainUid = '2219010055052', buyerUid = '2211907653301';
  const cid = buyerUid + '.1-' + mainUid + '.1#11001@cntaobao';
  const api = 'mtop.taobao.yungw.security.userinfo.transfrom';
  const summaryApi = 'mtop.taobao.qianniu.airisland.reception.detail.get';
  const tradeApi = 'mtop.taobao.qianniu.cs.trade.query';
  const appkey = '23436601';
  function validIdentity(value) {
    return typeof value === 'string' && /^[a-zA-Z0-9_-]{8,256}$/.test(value);
  }
  function key(reverse) {
    return 'qn-order-identity-' + buyerUid + (reverse ? '-reverse' : '-forward');
  }
  function request(job) {
    if (!job || typeof job.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(job.id)) throw Error('Invalid job ID');
    const needsId = ['reverse', 'trade'].includes(job.stage);
    if (Object.keys(job).sort().join(',') !== (needsId ? 'id,securityBuyerUid,stage' : 'id,stage') ||
        needsId && !validIdentity(job.securityBuyerUid)) throw Error('Invalid fixed probe parameters');
    if (job.stage === 'summary') return { method: summaryApi, version: '2.0', httpMethod: 'get', param: JSON.stringify({
      buyerInfo: JSON.stringify([{ decryptId: buyerUid, bizDomain: 'taobao' }]), sellerNick: 'cntaobao欧金金赛高' }) };
    if (job.stage === 'trade') return { method: tradeApi, version: '1.0', httpMethod: 'get',
      param: JSON.stringify({ securityBuyerUid: job.securityBuyerUid, _message_cid: cid }) };
    if (!['forward', 'reverse'].includes(job.stage)) throw Error('Unsupported probe stage');
    const reverse = job.stage === 'reverse';
    const plain = { appkey: '', bizDomain: 'taobao', decryptId: '', encryptId: '', ext: {}, nick: '', type: 'decryptUserId' };
    const secure = { ...plain, appkey, type: 'internal' };
    const from = reverse ? { ...secure, encryptId: job.securityBuyerUid } : { ...plain, decryptId: buyerUid };
    return { method: api, version: '1.0', httpMethod: 'post', param: JSON.stringify({ userSecurityQueryListStr:
      JSON.stringify([{ ext: {}, from, identifyKey: key(reverse), to: reverse ? plain : secure }]) }) };
  }
  function identity(response, reverse = false) {
    if (response?.api !== api || response.v !== '1.0' || !Array.isArray(response.ret) ||
        !response.ret.some(r => typeof r === 'string' && r.startsWith('SUCCESS::')) || response.data?.code !== '0')
      throw Error('Identity conversion did not succeed');
    const entries = response.data.data;
    if (!entries || Object.keys(entries).length !== 1 || !Object.hasOwn(entries, key(reverse)))
      throw Error('Identity correlation mismatch');
    const value = entries[key(reverse)];
    if (value?.bizDomain !== 'taobao' || value.userDomain !== 'cntaobao' ||
        value.type !== (reverse ? 'decryptUserId' : 'internal') || value.appkey !== (reverse ? '' : appkey))
      throw Error('Identity application scope mismatch');
    if (reverse) {
      if (value.decryptId !== buyerUid) throw Error('Converted buyer UID mismatch');
      return buyerUid;
    }
    if (!validIdentity(value.encryptId)) throw Error('Invalid converted identity');
    return value.encryptId;
  }
  function assertContext(value) {
    if (value?.shopUid !== shopUid || value.mainUid !== mainUid || typeof value.cid !== 'string')
      throw Error('Probe account mismatch');
  }
  return { shopUid, mainUid, buyerUid, cid, api, summaryApi, tradeApi, appkey, key, request, identity, assertContext };
}
module.exports = { createProtocol };
