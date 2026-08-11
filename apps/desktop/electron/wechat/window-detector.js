import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function asList(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

export function classifyWechatWindow(title) {
  const normalized = String(title || '').trim().toLowerCase();
  if (!normalized || /login|sign in|\u767b\u5f55|\u626b\u7801|\u98ce\u63a7/.test(normalized)) {
    return 'login_required';
  }
  return 'online';
}

export function buildWechatWindowDetectionScript(processNames = ['Weixin', 'WeChat']) {
  const names = processNames.map((name) => name.replace(/\.exe$/i, '')).filter(Boolean);
  const powershellNames = names.map((name) => `'${name.replaceAll("'", "''")}'`).join(', ');
  return [
    '$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new()',
    `$names = @(${powershellNames})`,
    '$items = @()',
    'Get-Process | Where-Object { $names -contains $_.ProcessName } | ForEach-Object {',
    '  $items += [pscustomobject]@{',
    '    pid = $_.Id;',
    '    hwnd = [int64]$_.MainWindowHandle;',
    '    title = [string]$_.MainWindowTitle;',
    '    process_name = [string]$_.ProcessName;',
    '    executable_path = $null',
    '  }',
    '}',
    '$items | ConvertTo-Json -Compress',
  ].join('\n');
}

export async function listWechatWindows(processNames = ['Weixin', 'WeChat']) {
  if (process.platform !== 'win32') return [];
  const script = buildWechatWindowDetectionScript(processNames);
  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
    ], { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 });
    const parsed = JSON.parse(String(stdout || '').trim() || '[]');
    return asList(parsed).map((item) => ({
      pid: Number(item.pid),
      hwnd: Number(item.hwnd),
      title: String(item.title || ''),
      processName: String(item.process_name || ''),
      executablePath: item.executable_path ? String(item.executable_path) : null,
      loginStatus: Number(item.hwnd) > 0 ? classifyWechatWindow(item.title) : 'login_required',
    })).filter((item) => Number.isInteger(item.pid) && item.pid > 0);
  } catch (error) {
    throw new Error(`微信窗口检测失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}
