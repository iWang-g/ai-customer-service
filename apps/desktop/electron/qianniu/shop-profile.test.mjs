import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { parseShopProfile, SHOP_PROFILE_API } from './shop-profile.js';
import { qianniuAccountFromBridgeClient } from './message-mapper.js';
import { QianniuWorkerManager } from './worker-manager.js';
const require = createRequire(import.meta.url);
const { installProductsPage } = require('./products-page.cjs');
const identity = { shopUid: '123', mainUid: '789', nick: 'Seller:Operator' };
// Synthetic contract fixture; live response field validation is still required.
const raw = (result = {}) => JSON.stringify({ api: SHOP_PROFILE_API, v: '1.0', ret: ['SUCCESS::ok'],
  data: { result: { shopId: 456, nick: identity.nick, shopTitle: 'Storefront', ...result } } });
const client = { clientId: 'page', state: { loginID: { targetId: '123', havMainId: '789', nick: identity.nick } } };

test('storefront, main account and operator remain separate, without changing routing IDs', () => {
  const profile = parseShopProfile(raw(), identity);
  const account = qianniuAccountFromBridgeClient(client, profile);
  assert.equal(account.alias, 'Storefront'); assert.equal(account.account_name, identity.nick);
  assert.equal(account.id, 'qianniu-123'); assert.equal(account.external_account_id, 'qianniu:123');
  assert.equal(account.metadata_json.shop_uid, '123'); assert.equal(account.metadata_json.shop_id, '456');
  assert.equal(account.metadata_json.main_account_uid, '789');
  assert.equal(qianniuAccountFromBridgeClient(client).alias, '待识别店铺');
  for (const change of [{ main_account_uid: '999' }, { service_account_uid: '999' }, { service_account_name: 'other' }])
    assert.equal(qianniuAccountFromBridgeClient(client, { ...profile, ...change }).alias, '待识别店铺');
});

test('rejects failed responses, mismatched identities, conflicting titles and nick-only results', () => {
  for (const result of [{ shopTitle: null }, { nick: 'Other:Operator' }, { shopId: 'bad' },
    { shopId: 9007199254740992 }, { title: 'Another shop' }]) assert.throws(() => parseShopProfile(raw(result), identity));
  assert.throws(() => parseShopProfile('{}', identity));
  assert.throws(() => parseShopProfile(raw().replace('SUCCESS::ok', 'FAIL::no'), identity));
});

async function pageRun(overrides = {}, changeContext = false) {
  let finish, calls = 0, forwarded = 0;
  const done = new Promise(resolve => { finish = resolve; });
  const env = { _vs: { loginID: { targetId: '123', havMainId: '789', nick: identity.nick }, conversationID: { ccode: '' } },
    onInvokeNotify: () => { forwarded++; }, workbench: { createSequenceId: () => 'sid', application: {
      invoke(sid, command, payload) {
        calls++; const request = JSON.parse(payload);
        assert.equal(command, 'invokeMTopChannelService'); assert.equal(request.method, SHOP_PROFILE_API);
        assert.equal(request.httpMethod, 'post'); assert.deepEqual(JSON.parse(request.param), {});
        queueMicrotask(() => {
          if (changeContext) env._vs.loginID.havMainId = '999';
          env.onInvokeNotify('unrelated', 0, '{}'); env.onInvokeNotify(sid, 0, raw());
        });
      } } }, fetch: async (url, options) => {
        if (url.endsWith('/poll')) {
          assert.equal(JSON.parse(options.body).shopProfileVersion, 1);
          return { ok: true, json: async () => ({ job: { id: 'job', kind: 'profile', ...identity, ...overrides } }) };
        }
        env.__qianniuProductsV3.stop();
        finish({ calls, forwarded, result: JSON.parse(options.body).result });
        return { ok: true, json: async () => ({}) };
      } };
  installProductsPage(env, { base: 'http://test', token: 'test' }); return done;
}

test('profile reads require no conversation and only issue the fixed read-only API', async () => {
  const value = await pageRun(); assert.equal(value.result.ok, true); assert.equal(value.forwarded, 1);
  assert.deepEqual(value.result.before, value.result.after);
  for (const bad of [{ method: 'write.api' }, { shopUid: '999' }, { mainUid: '999' }, { nick: 'other' }, { cid: 'unexpected' }]) {
    const value = await pageRun(bad); assert.equal(value.calls, 0); assert.equal(value.result.ok, false);
  }
  assert.equal((await pageRun({}, true)).result.ok, false);
});

test('worker profile enrichment is asynchronous and retains last successful name on query failure', async () => {
  const previousFetch = globalThis.fetch;
  const worker = new QianniuWorkerManager({ enabled: true });
  const profile = parseShopProfile(raw(), identity);
  let reads = 0;
  worker.productsReader = { server: {}, readShopProfile: async () => { reads++; return profile; } };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ clients: [client, client] }) });
  try {
    await worker.refreshClients(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(worker.knownAccounts().length, 1); assert.equal(worker.knownAccounts()[0].alias, 'Storefront');
    await worker.refreshClients(); assert.equal(reads, 1);
    worker.shopProfiles.set('123', { ...profile, shop_profile_observed_at: '2020-01-01T00:00:00Z' });
    worker.shopProfileAttempts.clear(); worker.productsReader.readShopProfile = async () => { throw Error('offline'); };
    await worker.refreshClients(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(worker.knownAccounts()[0].alias, 'Storefront');
  } finally { globalThis.fetch = previousFetch; }
});
