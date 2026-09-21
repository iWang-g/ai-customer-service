import fs from 'node:fs';
import path from 'node:path';

const LOCAL_RUNTIME_CONFIG = Object.freeze({
  businessApiUrl: 'http://127.0.0.1:8001/api/v1',
  knowledgeBaseUrl: 'http://127.0.0.1:8010/api/v1',
  websocketUrl: 'ws://127.0.0.1:8001',
});

function normalizeQianniuConfig(value = {}, environment = process.env) {
  const rawEnabled = value.enabled ?? environment.QIANNIU_ENABLED;
  const enabled = rawEnabled === true || rawEnabled === 'true' || rawEnabled === '1';
  return Object.freeze({
    enabled,
    appLogPath: typeof value.appLogPath === 'string' && value.appLogPath.trim()
      ? value.appLogPath.trim()
      : (environment.QIANNIU_APP_LOG || 'D:\\AliWorkbenchData\\System\\log\\app.log'),
    bridgeBase: typeof value.bridgeBase === 'string' && value.bridgeBase.trim()
      ? value.bridgeBase.replace(/\/$/, '')
      : (environment.QIANNIU_BRIDGE_BASE || 'http://127.0.0.1:18082/qn-bridge').replace(/\/$/, ''),
  });
}

function normalizeUrl(value, name, protocols) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} 未配置`);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} 不是有效 URL`);
  }
  if (!protocols.includes(parsed.protocol)) {
    throw new Error(`${name} 必须使用 ${protocols.join(' 或 ')}`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${name} 不能包含账号、查询参数或锚点`);
  }
  return value.replace(/\/$/, '');
}

export function validateRuntimeConfig(value, { rejectLoopback = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('客户端运行配置格式无效');
  }
  const config = {
    businessApiUrl: normalizeUrl(value.businessApiUrl, 'Business API 地址', ['http:', 'https:']),
    knowledgeBaseUrl: normalizeUrl(value.knowledgeBaseUrl, 'Knowledge Base 地址', ['http:', 'https:']),
    websocketUrl: normalizeUrl(value.websocketUrl, 'WebSocket 地址', ['ws:', 'wss:']),
    qianniu: normalizeQianniuConfig(value.qianniu || {}),
  };
  if (!config.businessApiUrl.endsWith('/api/v1')) {
    throw new Error('Business API 地址必须以 /api/v1 结尾');
  }
  if (!config.knowledgeBaseUrl.endsWith('/api/v1')) {
    throw new Error('Knowledge Base 地址必须以 /api/v1 结尾');
  }
  const allowLoopback = value.allowLoopback === true;
  if (rejectLoopback && !allowLoopback) {
    for (const configuredUrl of [config.businessApiUrl, config.knowledgeBaseUrl, config.websocketUrl]) {
      const hostname = new URL(configuredUrl).hostname.toLowerCase();
      if (['127.0.0.1', 'localhost', '::1'].includes(hostname)) {
        throw new Error('发布配置不能指向用户电脑的本机地址，除非显式设置 allowLoopback=true');
      }
    }
  }
  return Object.freeze(config);
}

export function loadRuntimeConfig({ isPackaged, resourcesPath, environment = process.env }) {
  if (isPackaged) {
    const configPath = path.join(resourcesPath, 'runtime-config.json');
    if (!fs.existsSync(configPath)) throw new Error(`缺少客户端运行配置: ${configPath}`);
    let value;
    try {
      value = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (error) {
      throw new Error(`无法读取客户端运行配置: ${error instanceof Error ? error.message : error}`);
    }
    return validateRuntimeConfig(value, { rejectLoopback: true });
  }
  return validateRuntimeConfig({
    businessApiUrl: environment.BUSINESS_API_URL || LOCAL_RUNTIME_CONFIG.businessApiUrl,
    knowledgeBaseUrl: environment.KNOWLEDGE_BASE_URL || LOCAL_RUNTIME_CONFIG.knowledgeBaseUrl,
    websocketUrl: environment.BUSINESS_WS_URL || LOCAL_RUNTIME_CONFIG.websocketUrl,
    qianniu: {
      enabled: environment.QIANNIU_ENABLED,
      appLogPath: environment.QIANNIU_APP_LOG,
      bridgeBase: environment.QIANNIU_BRIDGE_BASE,
    },
  });
}

export function rendererRuntimeArguments(config) {
  return [
    `--acs-business-api-url=${encodeURIComponent(config.businessApiUrl)}`,
    `--acs-knowledge-base-url=${encodeURIComponent(config.knowledgeBaseUrl)}`,
    `--acs-websocket-url=${encodeURIComponent(config.websocketUrl)}`,
  ];
}

export function serviceProxyBypassRules(config) {
  return [...new Set([
    config.businessApiUrl,
    config.knowledgeBaseUrl,
    config.websocketUrl,
  ].filter((value) => typeof value === 'string').map((value) => new URL(value).hostname))].join(',');
}
