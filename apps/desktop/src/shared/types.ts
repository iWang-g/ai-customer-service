export interface Platform {
  id: string;
  name: string;
  icon: string;
}

export interface Message {
  id: string;
  sender: 'user' | 'bot' | 'agent';
  content: string;
  timestamp: string;
  media?: {
    type: 'image';
    url: string;
  };
}

export interface Conversation {
  id: string;
  userName: string;
  shopId: string;
  shopName: string;
  externalConversationId?: string | null;
  lastMessage: string;
  platform: string;
  platformName: string;
  status: 'active' | 'pending' | 'resolved';
  time: string;
  messages: Message[];
}

export interface Shop {
  id: string;
  name: string;
  platform?: string;
  platformName?: string;
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
