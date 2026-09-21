'use strict';
// Serialized into the page bundle so both sides enforce the same application scope.
function createOrderIdentityProtocol() {
  const api = 'mtop.taobao.yungw.security.userinfo.transfrom', appkey = '23436601';
  const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{8,256}$/.test(value);
  function validateBase(base) {
    const match = /^(\d+)\.1-(\d+)\.1#11001@cntaobao$/.exec(base.cid || '');
    if (typeof base.shopUid !== 'string' || !/^\d+$/.test(base.shopUid) ||
        typeof base.mainUid !== 'string' || !/^\d+$/.test(base.mainUid) ||
        !match || ![match[1], match[2]].includes(base.mainUid) || match[1] === match[2] ||
        (match[1] === base.mainUid ? match[2] : match[1]) !== base.buyerUid)
      throw Error('订单买家身份不匹配');
  }
  function params(base, key, securityBuyerUid) {
    validateBase(base);
    if (typeof key !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(key)) throw Error('订单身份请求标识无效');
    const reverse = securityBuyerUid !== undefined;
    if (reverse && !validId(securityBuyerUid)) throw Error('订单安全标识无效');
    const plain = { appkey: '', bizDomain: 'taobao', decryptId: '', encryptId: '', ext: {}, nick: '', type: 'decryptUserId' };
    const secure = { ...plain, appkey, type: 'internal' };
    return { userSecurityQueryListStr: JSON.stringify([{ ext: {},
      from: reverse ? { ...secure, encryptId: securityBuyerUid } : { ...plain, decryptId: base.buyerUid },
      identifyKey: key, to: reverse ? plain : secure }]) };
  }
  function equal(a, b) {
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(k => Object.hasOwn(b, k) && equal(a[k], b[k]));
  }
  function validateParams(base, value) {
    if (!value || Object.keys(value).join(',') !== 'userSecurityQueryListStr' ||
        typeof value.userSecurityQueryListStr !== 'string' || value.userSecurityQueryListStr.length > 4000)
      throw Error('订单身份转换参数无效');
    let list;
    try { list = JSON.parse(value.userSecurityQueryListStr); } catch { throw Error('订单身份转换参数无效'); }
    if (!Array.isArray(list) || list.length !== 1 || !list[0]?.from) throw Error('订单身份转换参数无效');
    const item = list[0];
    const reverse = item.from.type === 'internal';
    const expected = JSON.parse(params(base, item.identifyKey, reverse ? item.from.encryptId : undefined).userSecurityQueryListStr);
    if (!equal(list, expected)) throw Error('订单身份转换范围不匹配');
  }
  function identity(response, base, key, reverse = false) {
    validateBase(base);
    if (response?.api !== api || response.v !== '1.0' || !Array.isArray(response.ret) ||
        !response.ret.some(r => typeof r === 'string' && r.startsWith('SUCCESS::')) || response.data?.code !== '0')
      throw Error('千牛买家身份转换失败，请确认账号权限后重试');
    const entries = response.data.data;
    if (!entries || Array.isArray(entries) || Object.keys(entries).length !== 1 || !Object.hasOwn(entries, key))
      throw Error('订单身份回包不匹配');
    const value = entries[key];
    if (value?.bizDomain !== 'taobao' || value.userDomain !== 'cntaobao' ||
        value.type !== (reverse ? 'decryptUserId' : 'internal') || value.appkey !== (reverse ? '' : appkey))
      throw Error('订单安全标识应用范围不匹配');
    if (reverse) {
      if (value.decryptId !== base.buyerUid) throw Error('订单身份反向校验买家不匹配');
      return base.buyerUid;
    }
    if (!validId(value.encryptId)) throw Error('订单安全标识无效');
    return value.encryptId;
  }
  return { api, appkey, validId, validateBase, params, validateParams, identity };
}
module.exports = { createOrderIdentityProtocol };
