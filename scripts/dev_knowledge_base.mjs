import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const candidates = [
  process.env.KB_PYTHON,
  resolve(root, '.venv-kb-embedding', 'Scripts', 'python.exe'),
  resolve(root, '.venv-kb-embedding', 'bin', 'python'),
  'python',
].filter(Boolean);

const python = candidates.find((candidate) => {
  if (candidate === 'python') {
    return true;
  }
  return existsSync(candidate);
});

const env = {
  ...process.env,
  KB_DATABASE_PATH: process.env.KB_DATABASE_PATH || './data/knowledge-base.db',
  KB_EMBEDDING_CACHE_PATH: process.env.KB_EMBEDDING_CACHE_PATH || './data/models',
  KB_EMBEDDING_ENABLED: process.env.KB_EMBEDDING_ENABLED || 'true',
  KB_VECTOR_SEARCH_ENABLED: process.env.KB_VECTOR_SEARCH_ENABLED || 'true',
};

console.log(`[dev:kb] python=${python}`);
console.log(`[dev:kb] KB_DATABASE_PATH=${env.KB_DATABASE_PATH}`);
console.log(`[dev:kb] KB_EMBEDDING_CACHE_PATH=${env.KB_EMBEDDING_CACHE_PATH}`);

const child = spawn(
  python,
  [
    '-m',
    'uvicorn',
    'app.main:app',
    '--app-dir',
    'services/knowledge-base',
    '--host',
    '127.0.0.1',
    '--port',
    '8010',
  ],
  {
    cwd: root,
    env,
    stdio: 'inherit',
    shell: false,
  },
);

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
