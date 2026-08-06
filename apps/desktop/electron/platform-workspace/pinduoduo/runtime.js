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
  constructor({
    localAccountId,
    getPlatformAccountId,
    enqueueEvent,
    onIdentity,
    onStatus,
    onDiagnostic,
  }) {
    this.localAccountId = localAccountId;
    this.getPlatformAccountId = getPlatformAccountId;
    this.enqueueEvent = enqueueEvent;
    this.onIdentity = onIdentity;
    this.onStatus = onStatus;
    this.onDiagnostic = onDiagnostic;
    this.pendingSnapshot = null;
    this.emitted = new Set();
  }

  ingest(rawPayload) {
    const payload = validateAdapterPayload(rawPayload);
    if (!payload) {
      this.#diagnostic('runtime_payload_rejected', {
        payload_type: rawPayload?.type || null,
      }, 'warn');
      return false;
    }
    if (payload.type === 'status') {
      this.onStatus?.(payload.status, payload);
      return true;
    }
    if (payload.type === 'identity') {
      this.onIdentity?.(payload);
      return true;
    }
    if (!this.getPlatformAccountId()) {
      this.#diagnostic('runtime_snapshot_pending_no_platform_account', {
        snapshot_id: payload.snapshot_id || null,
        conversation_count: payload.conversations?.length || 0,
      }, 'warn');
      this.pendingSnapshot = payload;
      return true;
    }
    this.#diagnostic('runtime_snapshot_received', {
      snapshot_id: payload.snapshot_id || null,
      conversation_count: payload.conversations?.length || 0,
      total_message_count: (payload.conversations || [])
        .reduce((total, conversation) => total + (conversation.messages?.length || 0), 0),
    });
    this.#emitSnapshot(payload);
    return true;
  }

  accountBindingChanged() {
    if (!this.pendingSnapshot || !this.getPlatformAccountId()) return;
    const snapshot = this.pendingSnapshot;
    this.pendingSnapshot = null;
    this.#diagnostic('runtime_pending_snapshot_released', {
      snapshot_id: snapshot.snapshot_id || null,
      conversation_count: snapshot.conversations?.length || 0,
    });
    this.#emitSnapshot(snapshot);
  }

  #emitSnapshot(snapshot) {
    const platformAccountId = this.getPlatformAccountId();
    if (!platformAccountId) {
      this.#diagnostic('runtime_snapshot_skipped_no_platform_account', {
        snapshot_id: snapshot.snapshot_id || null,
      }, 'warn');
      return;
    }
    let emittedCandidates = 0;
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
      emittedCandidates += 1;
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

      if (conversation.customer_orders) {
        const ordersPayload = conversation.customer_orders;
        const ordersDedup = `pinduoduo:${platformAccountId}:${externalConversationId}:orders:${digest(compact(ordersPayload)).slice(0, 32)}`;
        emittedCandidates += 1;
        this.#emitOnce(ordersDedup, {
          event_id: `pdd_${digest(ordersDedup)}`,
          dedup_key: ordersDedup,
          event_type: 'customer_orders_snapshot',
          platform_code: 'pinduoduo',
          platform_account_id: platformAccountId,
          conversation_external_id: externalConversationId,
          received_at: ordersPayload.observed_at || snapshot.observed_at,
          payload_json: {
            customer_key: `conversation:${externalConversationId}`,
            customer_name: conversation.customer_name,
            ...ordersPayload,
          },
        });
      }

      const messages = normalizedSnapshotMessages(conversation.messages);
      this.#diagnostic('runtime_conversation_snapshot_expanded', {
        snapshot_id: snapshot.snapshot_id || null,
        conversation_external_id: externalConversationId,
        customer_name: conversation.customer_name || null,
        latest_message_text: conversation.latest_message_text || '',
        unread_count: conversation.unread_count,
        raw_message_count: conversation.messages?.length || 0,
        normalized_message_count: messages.length,
      });
      for (const message of messages) {
        const stableMessagePart = message.platform_message_id || messageFallbackIdentity(message);
        const messageDedup = `pinduoduo:${platformAccountId}:${externalConversationId}:message:v3:${stableMessagePart}`;
        emittedCandidates += 1;
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
    this.#diagnostic('runtime_snapshot_expansion_completed', {
      snapshot_id: snapshot.snapshot_id || null,
      event_candidate_count: emittedCandidates,
    });
  }

  #emitOnce(key, event) {
    if (this.emitted.has(key)) {
      this.#diagnostic('runtime_event_skipped_duplicate', {
        event_type: event.event_type,
        dedup_key: event.dedup_key,
        platform_message_id: event.platform_message_id || null,
        conversation_external_id: event.conversation_external_id || null,
        sender_role: event.payload_json?.sender_role || null,
        content_preview: String(event.payload_json?.content || '').slice(0, 128),
      });
      return;
    }
    this.emitted.add(key);
    if (this.emitted.size > 10000) {
      const oldest = this.emitted.values().next().value;
      this.emitted.delete(oldest);
    }
    this.#diagnostic('runtime_event_emitting', {
      event_id: event.event_id,
      event_type: event.event_type,
      dedup_key: event.dedup_key,
      platform_message_id: event.platform_message_id || null,
      conversation_external_id: event.conversation_external_id || null,
      sender_role: event.payload_json?.sender_role || null,
      content_preview: String(event.payload_json?.content || '').slice(0, 128),
      ...(event.event_type === 'customer_orders_snapshot' ? {
        order_collection_status: event.payload_json?.collection_status || null,
        order_collection_error: event.payload_json?.error || null,
        order_count: Array.isArray(event.payload_json?.orders) ? event.payload_json.orders.length : 0,
      } : {}),
    });
    this.enqueueEvent(event);
  }

  #diagnostic(stage, details = {}, level = 'debug') {
    this.onDiagnostic?.(stage, details, level);
  }
}
