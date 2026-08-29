import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRuntimeConfig } from '../electron/runtime-config.js';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopDirectory = path.resolve(scriptDirectory, '..');
const configPath = path.resolve(
  desktopDirectory,
  process.env.RUNTIME_CONFIG_FILE || process.argv[2] || path.join('config', 'release.json'),
);

let config;
try {
  config = validateRuntimeConfig(
    JSON.parse(fs.readFileSync(configPath, 'utf8')),
    { rejectLoopback: true },
  );
} catch (error) {
  console.error(`发布配置校验失败: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

console.log(`发布配置有效: ${configPath}`);
console.log(`Business API: ${config.businessApiUrl}`);
console.log(`Knowledge Base: ${config.knowledgeBaseUrl}`);
console.log(`WebSocket: ${config.websocketUrl}`);
