export interface MessageNoticeItem {
  conversation_id: string;
  platform_code: string;
  customer_name: string;
  shop_name: string;
  message_id: string;
  message_text: string;
  latest_message_sender: 'customer' | 'ai' | 'manual';
  customer_message_at: string;
  reply_kind: 'ai' | 'manual' | null;
  replied_at: string | null;
}

export interface MessageNoticeSnapshot {
  since: string;
  server_time: string;
  items: MessageNoticeItem[];
}

export interface MessageNoticeState {
  revision: number;
  sessionId: string;
  since: string;
  items: MessageNoticeItem[];
  collapsed: boolean;
  hasUnseenCustomerMessage: boolean;
  status: 'signed_out' | 'connecting' | 'connected' | 'disconnected' | 'error';
  clockOffset: number;
}

export type NoticeFilter = 'all' | 'pending' | 'timeout' | 'ai';

export function noticeStatus(item: MessageNoticeItem, now: number): 'pending' | 'timeout' | 'ai' | 'manual' {
  if (item.reply_kind) return item.reply_kind;
  return elapsedSeconds(item, now) > 180 ? 'timeout' : 'pending';
}

export function elapsedSeconds(item: MessageNoticeItem, now: number): number {
  return Math.max(1, Math.floor((now - Date.parse(item.customer_message_at)) / 1000));
}

export function filterNotices(items: MessageNoticeItem[], filter: NoticeFilter, platform: string, now: number) {
  return items.filter((item) => (platform === 'all' || platform === item.platform_code)
    && (filter === 'all' || noticeStatus(item, now) === filter));
}
