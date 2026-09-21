import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
const { createTransferProtocol } = createRequire(import.meta.url)('./transfer-protocol.cjs');
const p = createTransferProtocol();

export function parseTransferReceipt(lines, context, targetUid) {
  const forwards = lines.filter(l => l.includes(' ForwardContact]') && l.includes(`3#${context.shopUid} `));
  if (forwards.length > 1) return { status: 'confirmation_pending', reason: '同一账号存在并发转接，无法唯一确认' };
  const forward = forwards[0];
  if (!forward || !forward.includes(`fromNumberId=${context.buyerUid},cid=${context.cid},toNumberId=${targetUid} `)) return null;
  const pid = /^\[\S+ \S+ \d+ (\d+) /.exec(forward)?.[1];
  if (!pid) return null;
  const receipts = [];
  for (const line of lines) {
    if (!line.includes('HandleMtopResponse]') || !line.includes(`#3#${context.shopUid} `) ||
        /^\[\S+ \S+ \d+ (\d+) /.exec(line)?.[1] !== pid) continue;
    const m = / data=(\{.*\}),nTaskID=(\d+),action=mtop\.taobao\.qianniu\.cloudkefu\.forward,resultCode\.ToString\(\)=([^,]+),requestParam=(\{.*\}) \]\[MTopChannel/.exec(line);
    if (!m) continue;
    try {
      const request = JSON.parse(m[4]), options = typeof request.options === 'string' ? JSON.parse(request.options) : request.options;
      if (String(request.buyerId) !== context.buyerUid || String(request.toId) !== targetUid || options?.appCid !== context.cid ||
          options.buyerDomain !== 'cntaobao' || options.loginDomain !== 'cntaobao') continue;
      const body = JSON.parse(m[1]);
      if (body.api !== p.FORWARD || body.v !== '3.0' || !Array.isArray(body.ret) || !body.ret.length) continue;
      let success = false;
      try { success = p.business(p.unwrap(body, p.FORWARD, '3.0')) && body.data.module === true && m[3] === 'ResultCode=[0:0__]'; } catch { /* Explicit business failure below. */ }
      const rejected = body.ret.some(x => typeof x === 'string' && !x.startsWith('SUCCESS::')) ||
        Number.isInteger(body.data?.errorCode) && body.data.errorCode !== 0;
      if (!success && !rejected) continue;
      receipts.push({ status: success ? 'transferred' : 'failed', evidence: { pid, requestId: m[2],
        shopUid: context.shopUid, buyerUid: context.buyerUid, cid: context.cid, targetUid,
        errorCode: body.data?.errorCode, errorMap: body.data?.errorMap, module: body.data?.module,
        ret: body.ret, api: body.api, version: body.v },
        reason: success ? null : '千牛转接业务失败：' + JSON.stringify(body.data?.errorMap || body.ret || {}).slice(0, 300) });
    } catch { /* Incomplete or rotated logs never establish success. */ }
  }
  return receipts.length === 1 ? receipts[0] : receipts.length ? { status: 'confirmation_pending', reason: '发现多条转接回执' } : null;
}

export async function openTransferLog(file) {
  const handle = await fs.open(file, 'r'), stat = await handle.stat();
  let offset = stat.size, remainder = '', lines = [];
  return { close: () => handle.close(), async confirm(context, targetUid, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    do {
      const current = await fs.stat(file);
      if (current.ino !== stat.ino || current.size < offset || current.size - offset > 16 * 1024 * 1024)
        return { status: 'confirmation_pending', reason: '转接期间日志变化，结果待确认' };
      if (current.size > offset) {
        const buffer = Buffer.alloc(current.size - offset);
        const read = await handle.read(buffer, 0, buffer.length, offset); offset += read.bytesRead;
        const full = Buffer.concat([Buffer.from(remainder, 'base64'), buffer.subarray(0, read.bytesRead)]);
        const end = full.lastIndexOf(10);
        if (end >= 0) lines.push(...full.subarray(0, end + 1).toString('utf8').split(/\r?\n/).filter(l => l.includes('ForwardContact]') || l.includes('HandleMtopResponse]')));
        remainder = full.subarray(end + 1).toString('base64');
        const result = parseTransferReceipt(lines, context, targetUid);
        if (result) return result;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    return { status: 'confirmation_pending', reason: '未找到唯一有效的千牛转接业务回执，请在千牛核对，勿重复转接' };
  } };
}
