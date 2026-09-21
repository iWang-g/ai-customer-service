export interface Platform {
  id: string;
  name: string;
  icon: string;
}

export interface Message {
  id: string;
  platformMessageId?: string | null;
  sender: 'user' | 'bot' | 'agent' | 'platform';
  content: string;
  timestamp: string;
  deliveryStatus?: 'sending' | 'sent' | 'failed' | 'confirmation_pending' | 'cancelled';
  quote?: {
    platformMessageId?: string | null;
    sender: 'user' | 'bot' | 'agent' | 'platform';
    content: string;
    media?: {
      type: 'image';
      url: string;
    };
  } | null;
  media?: {
    type: 'image';
    url: string;
  };
  timeline?: {
    type: 'text' | 'image' | 'product' | 'order' | 'system' | 'context' | 'time' | 'unknown';
    displayMode: 'bubble' | 'card' | 'separator' | 'notice' | 'hidden';
    data?: {
      parts?: Array<{
        index: number;
        kind: 'text' | 'image' | 'product' | 'unsupported';
        text?: string;
        url?: string | null;
        title?: string | null;
        product_id?: string | null;
        image_url?: string | null;
        price_label?: string | null;
      }>;
      title?: string;
      product_id?: string | null;
      price?: number | null;
      price_label?: string | null;
      image_url?: string | null;
      source_label?: string | null;
      sales_tip?: string | null;
      link_url?: string | null;
      button_text?: string | null;
      customer_number?: number | null;
      order_sequence_no?: string | null;
      order_id?: string | null;
      group_order_id?: string | null;
      order_status_label?: string | null;
      after_sales_label?: string | null;
      quantity?: number | null;
      spec?: string | null;
      amount?: number | null;
      amount_label?: string | null;
    };
  };
}

export interface Conversation {
  pddTransfer?: { status: string; targetNick: string } | null;
  qianniuTransfer?: { status: string; targetNick: string } | null;
  douyinTransfer?: { status: string; targetNick: string } | null;
  id: string;
  userName: string;
  avatarUrl?: string | null;
  shopLogoUrl?: string | null;
  shopId: string;
  localShopId?: string | null;
  shopName: string;
  shopServiceUsername?: string | null;
  shopIsMallOwner?: boolean;
  externalConversationId?: string | null;
  lastMessage: string;
  platform: string;
  platformName: string;
  status: 'active' | 'pending' | 'resolved';
  awaitingReply: boolean;
  humanRequired?: boolean;
  humanRequiredReason?: string | null;
  humanRequiredWord?: string | null;
  latestCustomerMessageAt?: string | null;
  syncIssue?: {
    observationId: string;
    firstDetectedAt: string;
    latestDetectedAt: string;
    unread: boolean;
    messageCount: number;
    consecutiveFailureCount: number;
    requiresAttention: boolean;
    dismissedAt: string | null;
  } | null;
  time: string;
  messages: Message[];
}

export interface Shop {
  id: string;
  name: string;
  platform?: string;
  platformName?: string;
  logoUrl?: string | null;
}

export interface BotStatus {
  model: string;
  availableModels: string[];
  uptime: string | null;
  requestsProcessed: number;
  avgResponseTimeMs: number | null;
  health: number;
}

export interface DesktopWindow {
  id: string;
  title: string;
  platform: string;
  shopName: string;
  associatedConversationId: string;
}

export interface LogEntry {
  id: string;
  timestamp: string;
  type: 'reply' | 'token';
  status: string;
  message: string;
  details?: string;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number | null;
}

export interface StatusEvent {
  id: string;
  timestamp: string;
  message: string;
  level: 'info' | 'success' | 'warning' | 'error';
}
