import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const probeScriptPath = path.join(currentDirectory, 'identity-probe.ps1');

function normalizeIdentityPart(value) {
  return String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ');
}

export function createWechatExternalAccountId(wechatName, wechatId) {
  const normalizedName = normalizeIdentityPart(wechatName);
  const normalizedWechatId = normalizeIdentityPart(wechatId);
  if (!normalizedName || !normalizedWechatId) return null;
  const digest = createHash('sha256')
    .update(`wechat-identity-v1\0${normalizedName}\0${normalizedWechatId}`)
    .digest('hex');
  return `wechat:${digest}`;
}

export function normalizeWechatIdentity(payload) {
  const wechatName = normalizeIdentityPart(payload?.wechat_name ?? payload?.wechatName);
  const wechatId = normalizeIdentityPart(payload?.wechat_id ?? payload?.wechatId);
  const externalAccountId = createWechatExternalAccountId(wechatName, wechatId);
  if (!externalAccountId) return null;
  return {
    wechatName,
    wechatId,
    externalAccountId,
    source: String(payload?.source || 'wechat_profile_uia'),
  };
}

export async function detectWechatIdentity({ pid, hwnd }) {
  const processId = Number(pid);
  const windowHandle = Number(hwnd);
  if (!Number.isInteger(processId) || processId <= 0 || !Number.isInteger(windowHandle) || windowHandle <= 0) {
    return { status: 'invalid_target', identity: null };
  }
  if (process.platform !== 'win32') return { status: 'unsupported_platform', identity: null };

  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      probeScriptPath,
      '-ProcessId',
      String(processId),
      '-WindowHandle',
      String(windowHandle),
    ], { windowsHide: true, timeout: 8000, maxBuffer: 1024 * 1024 });
    const parsed = JSON.parse(String(stdout || '').trim() || '{}');
    return {
      status: String(parsed.status || 'probe_failed'),
      identity: normalizeWechatIdentity(parsed),
      detail: parsed.detail ? String(parsed.detail) : null,
    };
  } catch (error) {
    return {
      status: 'probe_failed',
      identity: null,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
