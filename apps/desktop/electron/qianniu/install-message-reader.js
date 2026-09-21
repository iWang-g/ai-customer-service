import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export async function installMessageReader({ toolsRoot, dataPath }) {
  await fs.mkdir(dataPath, { recursive: true });
  const bundle = path.join(dataPath, 'page.js');
  await fs.copyFile(path.join(toolsRoot, 'qn-read-messages-page.js'), bundle);
  await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(path.dirname(fileURLToPath(import.meta.url)), 'install-orders.ps1'),
    '-BundlePath', bundle, '-BackupDirectory', path.join(dataPath, 'backups'), '-ModuleName', 'messages'],
  { windowsHide: true, timeout: 20000 });
}
