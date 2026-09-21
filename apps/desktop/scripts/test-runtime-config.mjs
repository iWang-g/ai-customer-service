import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadRuntimeConfig,
  rendererRuntimeArguments,
  serviceProxyBypassRules,
  validateRuntimeConfig,
} from '../electron/runtime-config.js';

const remoteConfig = {
  businessApiUrl: 'http://43.139.142.142/api/v1',
  knowledgeBaseUrl: 'http://43.139.142.142/kb-api/api/v1',
  websocketUrl: 'ws://43.139.142.142',
};
const localPackagedConfig = {
  businessApiUrl: 'http://127.0.0.1:8001/api/v1',
  knowledgeBaseUrl: 'http://127.0.0.1:8010/api/v1',
  websocketUrl: 'ws://127.0.0.1:8001',
  allowLoopback: true,
};
const defaultQianniuConfig = {
  enabled: false,
  appLogPath: 'D:\\AliWorkbenchData\\System\\log\\app.log',
  bridgeBase: 'http://127.0.0.1:18082/qn-bridge',
};

assert.deepEqual(
  { ...validateRuntimeConfig(remoteConfig, { rejectLoopback: true }) },
  { ...remoteConfig, qianniu: defaultQianniuConfig },
);
assert.deepEqual(
  { ...validateRuntimeConfig(localPackagedConfig, { rejectLoopback: true }) },
  {
    businessApiUrl: localPackagedConfig.businessApiUrl,
    knowledgeBaseUrl: localPackagedConfig.knowledgeBaseUrl,
    websocketUrl: localPackagedConfig.websocketUrl,
    qianniu: defaultQianniuConfig,
  },
);
assert.equal(serviceProxyBypassRules(remoteConfig), '43.139.142.142');
assert.equal(serviceProxyBypassRules({
  businessApiUrl: 'https://api.example.com/api/v1',
  knowledgeBaseUrl: 'https://kb.example.com/api/v1',
  websocketUrl: 'wss://api.example.com',
}), 'api.example.com,kb.example.com');
assert.throws(
  () => validateRuntimeConfig({ ...remoteConfig, businessApiUrl: 'http://127.0.0.1:8001/api/v1' }, { rejectLoopback: true }),
  /本机地址/,
);
assert.throws(
  () => validateRuntimeConfig({ ...remoteConfig, knowledgeBaseUrl: 'http://example.com:8010' }),
  /\/api\/v1/,
);

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-runtime-config-'));
try {
  fs.writeFileSync(
    path.join(temporaryDirectory, 'runtime-config.json'),
    JSON.stringify(remoteConfig),
    'utf8',
  );
  const loaded = loadRuntimeConfig({
    isPackaged: true,
    resourcesPath: temporaryDirectory,
    environment: {},
  });
  assert.deepEqual({ ...loaded }, { ...remoteConfig, qianniu: defaultQianniuConfig });
  assert.deepEqual(rendererRuntimeArguments(loaded), [
    `--acs-business-api-url=${encodeURIComponent(remoteConfig.businessApiUrl)}`,
    `--acs-knowledge-base-url=${encodeURIComponent(remoteConfig.knowledgeBaseUrl)}`,
    `--acs-websocket-url=${encodeURIComponent(remoteConfig.websocketUrl)}`,
  ]);
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}

console.log('客户端运行配置测试通过');
