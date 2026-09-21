import type { Message } from '../../shared/types';

type DeliveryMessage = {
  platform_code: string;
  message_status: string;
  raw_payload: Record<string, unknown>;
};

export function deliveryStatus(message: DeliveryMessage): Message['deliveryStatus'] {
  if (message.message_status === 'queued') return 'sending';
  if (message.message_status === 'confirmation_pending') return 'confirmation_pending';
  if (message.message_status !== 'failed') return 'sent';
  const result = message.raw_payload.send_result;
  return message.platform_code === 'douyin' && result && typeof result === 'object'
    && 'auto_send_suppressed' in result && result.auto_send_suppressed === true
    ? 'cancelled' : 'failed';
}

export function clearAwaitingAfterGeneratedReply(message: Pick<DeliveryMessage, 'platform_code' | 'message_status'>): boolean {
  return message.platform_code !== 'douyin' || message.message_status === 'sent';
}
