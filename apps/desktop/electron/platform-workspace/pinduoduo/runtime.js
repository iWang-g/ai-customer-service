import { createHash } from 'node:crypto';
import { validateAdapterPayload } from './reader.js';

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function safeIsoDate(value, fallback) {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function compact(value) {
  return JSON.stringify(value);
}

function messageFallbackIdentity(message) {
  return digest(compact({
    sender_role: message.sender_role,
    content: message.content,
    message_type: message.message_type,
    platform_sent_at: message.platform_sent_at,
    time_group_index: message.time_group_index,
    time_label: message.time_label,
  })).slice(0, 40);
}

function normalizedSnapshotMessages(messages) {
  const seen = new Set();
  const normalized = [];
  for (const message of messages) {
    const identity = message.platform_message_id || messageFallbackIdentity(message);
    if (seen.has(identity)) continue;
    seen.add(identity);
    normalized.push(message);
  }
  return normalized;
}

export class PddCollectionRuntime {
  constructor({ localAccountId, getPlatformAccountId, enqueueEvent, onIdentity, onStatus }) {
    this.localAccountId = localAccountId;
    this.getPlatformAccountId = getPlatformAccountId;
    this.enqueueEvent = enqueueEvent;
    this.onIdentity = onIdentity;
    this.onStatus = onStatus;
    this.pendingSnapshot = null;
    this.emitted = new Set();
  }

  ingest(rawPayload) {
    const payload = validateAdapterPayload(rawPayload);
    if (!payload) return false;
    if (payload.type === 'status') {
      this.onStatus?.(payload.status, payload);
      return true;
    }
    if (payload.type === 'identity') {
      this.onIdentity?.(payload);
      return true;
    }
    if (!this.getPlatformAccountId()) {
      this.pendingSnapshot = payload;
      return true;
    }
    this.#emitSnapshot(payload);
    return true;
  }

  accountBindingChanged() {
    if (!this.pendingSnapshot || !this.getPlatformAccountId()) return;
    const snapshot = this.pendingSnapshot;
    this.pendingSnapshot = null;
    this.#emitSnapshot(snapshot);
  }

  #emitSnapshot(snapshot) {
    const platformAccountId = this.getPlatformAccountId();
    if (!platformAccountId) return;
    for (const conversation of snapshot.conversations) {
      const externalConversationId = conversation.external_conversation_id
        || `name:${digest(conversation.customer_name || 'unknown').slice(0, 24)}`;
      const conversationState = {
        customer_name: conversation.customer_name,
        title: conversation.title,
        latest_message_text: conversation.latest_message_text,
        unread_count: conversation.unread_count,
        avatar_url: conversation.avatar_url,
      };
      const snapshotDedup = `pinduoduo:${platformAccountId}:${externalConversationId}:snapshot:${digest(compact(conversationState)).slice(0, 32)}`;
      this.#emitOnce(snapshotDedup, {
        event_id: `pdd_${digest(snapshotDedup)}`,
        dedup_key: snapshotDedup,
        event_type: 'conversation_snapshot',
        platform_code: 'pinduoduo',
        platform_account_id: platformAccountId,
        conversation_external_id: externalConversationId,
        received_at: snapshot.observed_at,
        payload_json: {
          customer_name: conversation.customer_name,
          title: conversation.title,
          content: conversation.latest_message_text,
          unread_count: conversation.unread_count,
          conversation_metadata: {
            avatar_url: conversation.avatar_url,
            local_account_id: this.localAccountId,
          },
        },
      });

      for (const message of normalizedSnapshotMessages(conversation.messages)) {
        const stableMessagePart = message.platform_message_id || messageFallbackIdentity(message);
        const messageDedup = `pinduoduo:${platformAccountId}:${externalConversationId}:message:v3:${stableMessagePart}`;
        this.#emitOnce(messageDedup, {
          event_id: `pdd_${digest(messageDedup)}`,
          dedup_key: messageDedup,
          event_type: message.sender_role === 'agent' ? 'agent_message' : 'message_received',
          platform_code: 'pinduoduo',
          platform_account_id: platformAccountId,
          platform_message_id: message.platform_message_id,
          conversation_external_id: externalConversationId,
          received_at: snapshot.observed_at,
          payload_json: {
            customer_name: conversation.customer_name,
            title: conversation.title,
            content: message.content,
            sender_name: message.sender_name,
            sender_role: message.sender_role,
            message_type: message.message_type,
            ...(message.message_type === 'image' && message.image_url
              ? { media_type: 'image', image_url: message.image_url }
              : {}),
            platform_sent_at: safeIsoDate(message.platform_sent_at, null),
            observed_at: snapshot.observed_at,
            snapshot_id: snapshot.snapshot_id,
            snapshot_sequence: message.snapshot_sequence,
            time_group_index: message.time_group_index,
            time_label: message.time_label,
            has_explicit_time: message.has_explicit_time,
            unread_count: conversation.unread_count,
            conversation_metadata: {
              avatar_url: conversation.avatar_url,
              local_account_id: this.localAccountId,
            },
          },
        });
      }
    }
  }

  #emitOnce(key, event) {
    if (this.emitted.has(key)) return;
    this.emitted.add(key);
    if (this.emitted.size > 10000) {
      const oldest = this.emitted.values().next().value;
      this.emitted.delete(oldest);
    }
    this.enqueueEvent(event);
  }
}
