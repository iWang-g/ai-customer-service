export const SHOP_PROFILE_API = 'mtop.taobao.jdy.resource.shop.info.get';

// Login nick identifies the operator, never the storefront title.
export function parseShopProfile(raw, { shopUid, mainUid, nick }) {
  const response = JSON.parse(raw);
  if (response.api !== SHOP_PROFILE_API || response.v !== '1.0' ||
      !Array.isArray(response.ret) || !response.ret.length ||
      !response.ret.every(value => typeof value === 'string' && value.startsWith('SUCCESS::')))
    throw new Error('千牛店铺资料业务查询失败');
  const data = response.data?.result;
  const id = data?.shopId;
  if ((typeof id !== 'string' && !Number.isSafeInteger(id)) || !/^\d{1,30}$/.test(String(id)) ||
      !nick || data.nick !== nick || !/^\d+$/.test(shopUid) || !/^\d+$/.test(mainUid))
    throw new Error('千牛店铺资料身份不一致');
  const titles = [data.shopName, data.shopTitle, data.title].filter(value => typeof value === 'string' && value.trim());
  const names = new Set(titles.map(value => value.trim()));
  if (names.size !== 1) {
    const fields = Object.keys(data).filter(key => /^[a-zA-Z0-9_]{1,50}$/.test(key)).slice(0, 80);
    throw new Error('千牛店铺资料缺少唯一店名；返回字段：' + fields.join(','));
  }
  const name = [...names][0];
  if (name.length > 128 || /[\x00-\x1f]/.test(name)) throw new Error('千牛店名格式无效');
  return { shop_id: String(id), shop_name: name, main_account_uid: mainUid,
    shop_profile_main_uid: mainUid, shop_profile_account_uid: shopUid,
    service_account_uid: shopUid, service_account_name: nick,
    shop_name_source: 'qianniu_shop_info', shop_profile_observed_at: new Date().toISOString() };
}
