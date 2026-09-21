// recvUser is treated conservatively as acceptance eligibility, not an online-state enum.
export function preparePddTransfer(roster, random = Math.random) {
  if (roster?.status !== 'collected' || !Array.isArray(roster.cs_list) || roster.identity_verified !== true) {
    throw new Error('客服列表或当前客服身份未确认');
  }
  const candidates = roster.cs_list.filter((entry) => entry && typeof entry.csid === 'string'
    && entry.csid && entry.isCurrent === false && entry.recvUser === 1);
  if (!candidates.length) return { status: 'no_online_target', submitted: false };
  const target = candidates[Math.min(candidates.length - 1, Math.floor(random() * candidates.length))];
  return { status: 'prepared', submitted: false, target_cs_id: target.csid,
    target_cs_username: target.nickname || target.username || target.csid };
}
