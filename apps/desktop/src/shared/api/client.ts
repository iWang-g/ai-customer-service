import type { MessageNoticeSnapshot } from '../../message-notice/types';
const API_BASE_URL = (
  window.desktopConfig?.businessApiUrl ||
  import.meta.env.VITE_API_BASE_URL ||
  (import.meta.env.DEV ? '/api/v1' : 'http://127.0.0.1:8001/api/v1')
).replace(/\/$/, '');
const SESSION_STORAGE_KEY = 'ai-customer-service.auth';
const SESSION_CHANGE_EVENT = 'ai-customer-service.session-change';
const KNOWLEDGE_BASE_URL = (
  window.desktopConfig?.knowledgeBaseUrl ||
  import.meta.env.VITE_KB_BASE_URL ||
  (import.meta.env.DEV ? '/kb-api/api/v1' : 'http://127.0.0.1:8010/api/v1')
).replace(/\/$/, '');

export interface ApiUser {
  id: string;
  username: string;
  display_name: string;
  role: string;
  is_active: boolean;
  last_login_at: string | null;
}

export interface AuthSession {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  refresh_expires_in: number;
  user: ApiUser;
}

export interface ApiConversation {
  id: string;
  user_id: string;
  platform_account_id: string | null;
  platform_code: string;
  platform_name: string | null;
  shop_name: string | null;
  shop_logo_url: string | null;
  shop_service_username: string | null;
  shop_is_mall_owner: boolean;
  latest_customer_message_at: string | null;
  external_conversation_id: string | null;
  customer_name: string | null;
  avatar_url: string | null;
  title: string | null;
  latest_message_text: string | null;
  latest_message_at: string | null;
  unread_count: number;
  status: string;
  awaiting_reply: boolean;
  human_required: boolean;
  human_required_reason: string | null;
  human_required_word: string | null;
  human_required_at: string | null;
  messages_cleared_sequence: number;
  deleted_at: string | null;
  metadata_json: Record<string, unknown>;
  message_sync_issue?: MessageSyncIssue | null;
}

export interface MessageSyncIssue {
  observation_id: string;
  first_detected_at: string;
  latest_detected_at: string;
  unread: boolean;
  message_count: number;
  consecutive_failure_count: number;
  requires_attention: boolean;
  dismissed_at: string | null;
}

export interface MessageSyncIssueSnapshotMessage {
  dom_sequence: number;
  sender_role: string;
  message_type: string;
  content: string;
  display_mode: string;
  automation_mode: string;
  time_label: string | null;
  structured_payload: Record<string, unknown> | null;
}

export interface MessageSyncIssueDetail {
  conversation_id: string;
  issue: MessageSyncIssue;
  messages: MessageSyncIssueSnapshotMessage[];
}

export interface ApiMessage {
  id: string;
  conversation_id: string;
  user_id: string;
  platform_code: string;
  platform_message_id: string | null;
  sender_role: string;
  sender_name: string | null;
  content: string;
  message_status: string;
  source: string;
  raw_payload: Record<string, unknown>;
  conversation_sequence: number;
  collected_at: string;
  first_observation_id: string | null;
  first_dom_sequence: number | null;
  collection_kind: string;
  automation_eligible: boolean;
  platform_sent_at: string | null;
  observed_at: string | null;
  snapshot_id: string | null;
  snapshot_sequence: number | null;
  time_group_index: number | null;
  has_explicit_time: boolean | null;
  time_label: string | null;
  sent_at: string;
}

export interface CustomerOrderProduct {
  goods_id?: string;
  title?: string;
  quantity?: number | null;
  image_url?: string;
  sku?: string;
  price?: number | null;
  sub_order_id?: string;
}

export interface CustomerOrder {
  id: string;
  platform_order_id: string;
  goods_id: string;
  status: string;
  raw_status: string;
  products_json: CustomerOrderProduct[];
  order_amount: number | null;
  discount_amount: number | null;
  paid_amount: number | null;
  ordered_at: string | null;
  paid_at: string | null;
  signed_at: string | null;
  after_sale_json: Record<string, unknown>;
  last_observed_at: string;
}

export interface CustomerOrdersResponse {
  conversation_id: string;
  collection_status: 'not_collected' | 'success' | 'empty' | 'unavailable';
  collection_error: string | null;
  observed_at: string | null;
  customer_key: string;
  total_count: number;
  has_more: boolean;
  query_coverage?: string | null;
  last_attempt_task_id?: string | null;
  last_attempt_at?: string | null;
  orders: CustomerOrder[];
  outreach: Array<{
    strategy_type: string;
    goods_id: string;
    status: string;
    due_at: string;
    cancel_reason: string | null;
    completed_at: string | null;
  }>;
}

export interface CustomerProduct {
  id: string;
  goods_id: string;
  product_id: string | null;
  platform_product_id?: string;
  title: string | null;
  image_url: string | null;
  link_url: string | null;
  price: number | null;
  price_label: string | null;
  quantity: number | null;
  sold_quantity: number | null;
  sold_quantity_30d: number | null;
  source: string | null;
  raw_payload: Record<string, unknown>;
  last_observed_at: string;
}

export interface CustomerProductsResponse {
  conversation_id: string;
  status: 'collected' | 'failed';
  method?: 'api_recommend_goods' | 'qianniu_onsale' | 'douyin_product_list' | null;
  conversation_key: string | null;
  customer_name: string | null;
  collection_status: 'not_collected' | 'success' | 'empty' | 'unavailable';
  collection_error: string | null;
  observed_at: string | null;
  customer_key: string;
  total_count: number;
  has_more: boolean;
  products: CustomerProduct[];
  error?: string | null;
}

export interface AiModel {
  provider: string;
  model_id: string;
  display_name: string;
  available: boolean;
  fetched_at: string;
}

export interface AiModelList { items: AiModel[]; }

export interface EmailConfig {
  enabled: boolean;
  provider: 'qq' | 'gmail' | 'custom';
  sender_email: string;
  sender_email_masked: string;
  smtp_host: string;
  smtp_port: number;
  security: 'ssl' | 'starttls' | 'none';
  auth_code_saved: boolean;
  trigger_scenarios: string;
  ask_email_text: string;
  success_text: string;
  missing_template_text: string;
  updated_at: string | null;
}

export interface EmailConfigInput {
  enabled: boolean;
  provider: 'qq' | 'gmail' | 'custom';
  sender_email: string;
  smtp_host: string;
  smtp_port: number;
  security: 'ssl' | 'starttls' | 'none';
  auth_code: string;
  trigger_scenarios: string;
  ask_email_text: string;
  success_text: string;
  missing_template_text: string;
}

export interface EmailTemplate {
  id: string;
  template_key: string;
  name: string;
  scene: string;
  aliases: string[];
  subject: string;
  body: string;
  enabled: boolean;
  platform_account_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface EmailTemplateInput {
  template_key?: string | null;
  name: string;
  scene?: string;
  aliases?: string[];
  subject: string;
  body: string;
  enabled: boolean;
  platform_account_id?: string | null;
}

export interface EmailTestResult {
  ok: boolean;
  message: string;
  message_id: string;
  elapsed_ms: number;
}

export interface UserSettings {
  auto_reply_enabled: boolean;
  updated_at: string | null;
}

export interface UserSettingsInput {
  auto_reply_enabled: boolean;
}

export interface DashboardAnalytics {
  start_date: string;
  end_date: string;
  metrics: {
    message_count: number;
    independent_reception_rate: number;
    average_response_seconds: number | null;
    transfer_to_human_rate: number;
  };
  traffic: Array<{ label: string; count: number }>;
  categories: Array<{
    type: 'qa_category' | 'document_retrieval';
    category_id: string | null;
    name: string;
    count: number;
    percentage: number;
  }>;
  updated_at: string;
}

export interface MonitoringOverview {
  current_model: string;
  available_models: string[];
  metrics: {
    model: string;
    period: 'today';
    uptime: string | null;
    request_count: number;
    success_rate: number;
    average_response_ms: number | null;
  };
  updated_at: string;
}

export interface MonitoringLog {
  id: string;
  timestamp: string;
  type: 'reply' | 'token';
  status: string;
  message: string;
  details: string;
  model: string;
  stage: string;
  input_tokens: number;
  output_tokens: number;
  duration_ms: number | null;
}

export interface MonitoringEvent {
  id: string;
  timestamp: string;
  type: string;
  level: 'info' | 'success' | 'warning' | 'error';
  message: string;
}

export interface TestReplyMessage {
  role: 'user' | 'assistant';
  content: string;
  media?: Array<{ type: string; url?: string }>;
}

export interface TestReplyResult {
  decision: string;
  text: string;
  media: Array<{ type: string; url?: string }>;
  intent: Record<string, unknown>;
  action_plan: Record<string, unknown>;
  confidence: number;
  risk_flags: string[];
  qa_match: Record<string, unknown> | null;
  retrieval: Array<Record<string, unknown>>;
  model_calls: Record<string, string>;
  provider: string;
  trace_id: string;
  task_ids: string[];
}

export interface KnowledgeBaseSummary {
  id: string;
  name: string;
  kind: 'qa' | 'product' | 'tone';
  persona: string;
  enabled: boolean;
  is_public: boolean;
  owner_user_id: string;
  owner_username: string;
  owner_display_name: string;
  is_owner: boolean;
  read_only: boolean;
  item_count: number;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeDocument {
  id: string;
  base_id: string;
  title: string;
  original_filename: string;
  file_type: string;
  file_size: number;
  status: string;
  chunk_count: number;
  chunk_strategy_version: string;
  error_message: string;
  created_at: string;
  updated_at: string;
  duplicate?: boolean;
}

export interface KnowledgeDocumentDetail extends KnowledgeDocument {
  content: string;
  chunk_type: string;
  metadata: Record<string, unknown>;
  strategy_version: string;
}

export interface KnowledgeDocumentChunk {
  id: string;
  document_id: string;
  base_id: string;
  chunk_index: number;
  title_path: string;
  content: string;
  enabled: boolean;
  created_at: string;
}

export interface KnowledgeDocumentChunkPage {
  items: KnowledgeDocumentChunk[];
  total: number;
  page: number;
  page_size: number;
  pages: number;
}

export interface ProductDocumentSearchResult {
  source_id: string;
  chunk_id: string;
  context_chunk_ids: string[];
  base_id: string;
  source_title: string;
  title_path: string;
  chunk_type: string;
  snippet: string;
  score: number;
}

export interface ProductDocumentSearchMetadata {
  mode: string;
  candidate_count: number;
  fts_candidate_count?: number;
  vector_candidate_count?: number;
  embedding_enabled?: boolean;
  embedding_model?: string;
  count: number;
  chunk_strategy_version?: string;
}

export interface ProductDocumentSearchResponse {
  results: ProductDocumentSearchResult[];
  metadata: ProductDocumentSearchMetadata;
}

export interface QaEntry {
  id: string;
  base_id: string;
  category_id: string;
  category: string;
  question: string;
  keywords: string[];
  answer: string;
  image_url: string;
  weight: number;
  call_count: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface QaEntryInput {
  category_id: string;
  category: string;
  question: string;
  keywords: string[];
  answer: string;
  image_url: string;
  weight: number;
  enabled: boolean;
}

export interface QaCategory {
  id: string;
  base_id: string;
  name: string;
  is_builtin: boolean;
  sort_order: number;
  item_count: number;
  created_at: string;
  updated_at: string;
}

export interface QaEntryPage {
  items: QaEntry[];
  total: number;
  page: number;
  page_size: number;
  pages: number;
}

export interface PlatformPhraseRecord {
  source_id: string;
  category: string;
  quick_key: string;
  content: string;
  images: Array<{ url: string; width?: number | null; height?: number | null; image_size?: number | null }>;
}

export interface PlatformQuickReply extends PlatformPhraseRecord {
  source: 'personal' | 'team';
}

export interface PlatformPhraseQaDraft {
  source_id: string;
  category: string;
  question: string;
  keywords: string[];
  answer: string;
  image_url: string;
  weight: number;
  enabled: boolean;
}

export interface PlatformPhraseNormalizeResponse {
  items: PlatformPhraseQaDraft[];
  provider: string;
  used_fallback: boolean;
  error: string | null;
  total_records?: number;
  generated_count?: number;
  failed_count?: number;
  batch_count?: number;
  completed_batches?: number;
}

export interface PlatformPhraseSnapshot {
  id: string;
  platform_account_id: string;
  local_account_id: string | null;
  platform: 'pinduoduo';
  source: 'personal' | 'team';
  records: PlatformPhraseRecord[];
  record_count: number;
  raw_count: number;
  content_hash: string;
  status: string;
  error: string | null;
  collected_at: string;
  updated_at: string;
}

export interface PlatformPhraseNormalizeTask extends PlatformPhraseNormalizeResponse {
  task_id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  cancel_requested: boolean;
  current_batch: number;
  message: string;
}

export interface RobotPlatformScope {
  platform_code: string;
  platform_account_id: string | null;
  all_accounts: boolean;
}

export interface ApiRobot {
  id: string;
  user_id: string;
  name: string;
  status: 'online' | 'offline';
  enabled: boolean;
  config_json: Record<string, unknown>;
  qa_knowledge_base_ids: string[];
  product_knowledge_base_ids: string[];
  tone_knowledge_base_id: string | null;
  platform_scopes: RobotPlatformScope[];
  created_at: string;
  updated_at: string;
}

export interface RobotInput {
  name: string;
  enabled?: boolean;
  status?: 'online' | 'offline';
  config_json?: Record<string, unknown>;
  qa_knowledge_base_ids?: string[];
  product_knowledge_base_ids?: string[];
  tone_knowledge_base_id?: string | null;
  platform_scopes?: RobotPlatformScope[];
}

export interface PlatformAccount {
  id: string;
  platform_code: string;
  platform_name: string;
  account_name: string;
  account_alias: string | null;
  local_account_id: string | null;
  login_status: string;
  is_active: boolean;
  metadata_json: Record<string, unknown>;
}

export interface ShopProductSummary {
  shop_intro: string;
  on_sale_products: string;
  generated_at?: string | null;
  edited_at?: string | null;
}

interface PageResponse<T> {
  items: T[];
  meta: { total: number; limit: number; offset: number };
}

export interface RealtimeEvent {
  type: string;
  message?: ApiMessage;
  follow_up_message?: ApiMessage | null;
  follow_up_messages?: ApiMessage[];
  task?: {
    platform_code?: string;
    id: string;
    conversation_id: string | null;
    message_id: string | null;
    task_type: string;
    status: string;
    payload_json: Record<string, unknown>;
    result_json: Record<string, unknown>;
    error_message: string | null;
  };
  [key: string]: unknown;
}

function formatErrorDetail(detail: unknown): string {
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((item) => {
        if (typeof item === 'object' && item && 'msg' in item) return String(item.msg);
        return String(item);
      })
      .join('；');
  }
  return '请求失败，请稍后重试';
}

export class ApiRequestError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

export function isAuthenticationError(error: unknown): boolean {
  return error instanceof ApiRequestError && (error.status === 401 || error.status === 403);
}

async function parseError(response: Response): Promise<Error> {
  try {
    const payload = (await response.json()) as { detail?: unknown };
    return new ApiRequestError(formatErrorDetail(payload.detail), response.status);
  } catch {
    return new ApiRequestError(`请求失败 (${response.status})`, response.status);
  }
}

export function getStoredSession(): AuthSession | null {
  try {
    const value = localStorage.getItem(SESSION_STORAGE_KEY);
    return value ? (JSON.parse(value) as AuthSession) : null;
  } catch {
    localStorage.removeItem(SESSION_STORAGE_KEY);
    return null;
  }
}

export function storeSession(session: AuthSession): void {
  localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  window.dispatchEvent(new CustomEvent<AuthSession | null>(SESSION_CHANGE_EVENT, { detail: session }));
}

export function clearStoredSession(): void {
  localStorage.removeItem(SESSION_STORAGE_KEY);
  window.dispatchEvent(new CustomEvent<AuthSession | null>(SESSION_CHANGE_EVENT, { detail: null }));
}

export function subscribeToSessionChanges(listener: (session: AuthSession | null) => void): () => void {
  const handleChange = (event: Event) => {
    listener((event as CustomEvent<AuthSession | null>).detail);
  };
  window.addEventListener(SESSION_CHANGE_EVENT, handleChange);
  return () => window.removeEventListener(SESSION_CHANGE_EVENT, handleChange);
}

async function refreshSession(): Promise<AuthSession | null> {
  const current = getStoredSession();
  if (!current?.refresh_token) return null;
  try {
    const response = await fetch(`${API_BASE_URL}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: current.refresh_token }),
    });
    if (response.status === 401 || response.status === 403) {
      clearStoredSession();
      return null;
    }
    if (!response.ok) return null;
    const refreshed = (await response.json()) as AuthSession;
    storeSession(refreshed);
    return refreshed;
  } catch {
    return null;
  }
}

async function apiRequest<T>(
  path: string,
  init: RequestInit = {},
  requireAuth = true,
  retryAfterRefresh = true,
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('Content-Type', 'application/json');
  if (requireAuth) {
    const session = getStoredSession();
    if (!session) throw new Error('登录状态已失效，请重新登录');
    headers.set('Authorization', `Bearer ${session.access_token}`);
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, { ...init, headers });
  } catch {
    throw new Error('无法连接业务服务，请确认后端已在 8001 端口启动');
  }

  if ((response.status === 401 || response.status === 403) && requireAuth && retryAfterRefresh) {
    const refreshed = await refreshSession();
    if (refreshed) return apiRequest<T>(path, init, true, false);
    if (getStoredSession()) throw new Error('服务暂时无法刷新登录状态，请稍后重试');
  }
  if (!response.ok) throw await parseError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

async function knowledgeRequest<T>(
  path: string,
  init: RequestInit = {},
  retryAfterRefresh = true,
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  const session = getStoredSession();
  if (!session) throw new Error('登录状态已失效，请重新登录');
  headers.set('Authorization', `Bearer ${session.access_token}`);
  let response: Response;
  try {
    response = await fetch(`${KNOWLEDGE_BASE_URL}${path}`, { ...init, headers });
  } catch {
    throw new Error('无法连接知识库服务，请确认 8010 端口已启动');
  }
  if ((response.status === 401 || response.status === 403) && retryAfterRefresh) {
    const refreshed = await refreshSession();
    if (refreshed) return knowledgeRequest<T>(path, init, false);
  }
  if (!response.ok) throw await parseError(response);
  return (await response.json()) as T;
}

export function login(username: string, password: string): Promise<AuthSession> {
  return apiRequest<AuthSession>(
    '/auth/login',
    { method: 'POST', body: JSON.stringify({ username, password }) },
    false,
  );
}

export function getCurrentUser(): Promise<ApiUser> {
  return apiRequest<ApiUser>('/auth/me');
}

export function logout(): Promise<{ message: string }> {
  return apiRequest<{ message: string }>('/auth/logout', { method: 'POST' });
}

export function listAiModels(): Promise<AiModelList> {
  return apiRequest<AiModelList>('/ai-models');
}

export function syncAiModels(): Promise<AiModelList> {
  return apiRequest<AiModelList>('/ai-models/sync', { method: 'POST' });
}

export function getUserSettings(): Promise<UserSettings> {
  return apiRequest<UserSettings>('/settings');
}

export function saveUserSettings(input: UserSettingsInput): Promise<UserSettings> {
  return apiRequest<UserSettings>('/settings', { method: 'PUT', body: JSON.stringify(input) });
}

export function getDashboardAnalytics(startDate: string, endDate: string): Promise<DashboardAnalytics> {
  const query = new URLSearchParams({
    start_date: startDate,
    end_date: endDate,
    timezone: 'Asia/Shanghai',
  });
  return apiRequest<DashboardAnalytics>(`/analytics/dashboard?${query}`);
}

export function getEmailConfig(): Promise<EmailConfig> {
  return apiRequest<EmailConfig>('/email/config');
}

export function saveEmailConfig(input: EmailConfigInput): Promise<EmailConfig> {
  return apiRequest<EmailConfig>('/email/config', { method: 'PUT', body: JSON.stringify(input) });
}

export function testEmailConfig(toEmail: string, templateId?: string): Promise<EmailTestResult> {
  return apiRequest<EmailTestResult>('/email/test', {
    method: 'POST',
    body: JSON.stringify({ to_email: toEmail, template_id: templateId || null }),
  });
}

export function listEmailTemplates(): Promise<EmailTemplate[]> {
  return apiRequest<EmailTemplate[]>('/email/templates');
}

export function createEmailTemplate(input: EmailTemplateInput): Promise<EmailTemplate> {
  return apiRequest<EmailTemplate>('/email/templates', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateEmailTemplate(id: string, input: Partial<EmailTemplateInput>): Promise<EmailTemplate> {
  return apiRequest<EmailTemplate>(`/email/templates/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function deleteEmailTemplate(id: string): Promise<void> {
  return apiRequest<void>(`/email/templates/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function testRobotReply(input: {
  robot_id: string;
  message: string;
  conversation: TestReplyMessage[];
  platform_code?: string;
  shop_name?: string;
  customer_name?: string;
}): Promise<TestReplyResult> {
  return apiRequest<TestReplyResult>('/automation/test-reply', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function getKnowledgeBase(id: string): Promise<KnowledgeBaseSummary> {
  return knowledgeRequest<KnowledgeBaseSummary>(`/knowledge-bases/${encodeURIComponent(id)}`);
}

export function createKnowledgeBase(
  name: string,
  kind: 'product' | 'qa' | 'tone',
  persona = '',
  isPublic = false,
): Promise<KnowledgeBaseSummary> {
  return knowledgeRequest<KnowledgeBaseSummary>('/knowledge-bases', {
    method: 'POST',
    body: JSON.stringify({ name, kind, persona, is_public: isPublic }),
  });
}

export function updateKnowledgeBase(
  id: string,
  input: { name?: string; persona?: string; enabled?: boolean; is_public?: boolean },
): Promise<KnowledgeBaseSummary> {
  return knowledgeRequest<KnowledgeBaseSummary>(`/knowledge-bases/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function listKnowledgeBases(kind?: 'product' | 'qa' | 'tone'): Promise<KnowledgeBaseSummary[]> {
  const query = kind ? `?kind=${encodeURIComponent(kind)}` : '';
  return knowledgeRequest<KnowledgeBaseSummary[]>(`/knowledge-bases${query}`);
}

export function deleteKnowledgeBase(id: string): Promise<KnowledgeBaseSummary> {
  return knowledgeRequest<KnowledgeBaseSummary>(`/knowledge-bases/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export interface KnowledgeBaseUsage {
  knowledge_base_id: string;
  in_use: boolean;
  robots: Array<{ id: string; name: string }>;
}

export function getKnowledgeBaseUsage(id: string): Promise<KnowledgeBaseUsage> {
  return apiRequest<KnowledgeBaseUsage>(`/robots/knowledge-base-usage/${encodeURIComponent(id)}`);
}

export function deleteUnusedKnowledgeBase(id: string): Promise<KnowledgeBaseSummary> {
  return apiRequest<KnowledgeBaseSummary>(`/robots/knowledge-bases/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function listQaEntries(
  baseId: string,
  options: { categoryId?: string; keyword?: string; page?: number; pageSize?: number } = {},
): Promise<QaEntryPage> {
  const query = new URLSearchParams({
    page: String(options.page ?? 1),
    page_size: String(options.pageSize ?? 20),
  });
  if (options.categoryId && options.categoryId !== 'all') query.set('category_id', options.categoryId);
  if (options.keyword) query.set('keyword', options.keyword);
  return knowledgeRequest<QaEntryPage>(`/knowledge-bases/${encodeURIComponent(baseId)}/qa-entries?${query}`);
}

export function listQaCategories(baseId: string): Promise<QaCategory[]> {
  return knowledgeRequest<QaCategory[]>(`/knowledge-bases/${encodeURIComponent(baseId)}/qa-categories`);
}

export function createQaCategory(baseId: string, name: string): Promise<QaCategory> {
  return knowledgeRequest<QaCategory>(`/knowledge-bases/${encodeURIComponent(baseId)}/qa-categories`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

export function createQaEntry(baseId: string, input: QaEntryInput): Promise<QaEntry> {
  return knowledgeRequest<QaEntry>(`/knowledge-bases/${encodeURIComponent(baseId)}/qa-entries`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function normalizePlatformPhrases(input: {
  platform: 'pinduoduo';
  source: 'personal' | 'team';
  existing_categories: string[];
  records: PlatformPhraseRecord[];
}): Promise<PlatformPhraseNormalizeResponse> {
  return apiRequest<PlatformPhraseNormalizeResponse>('/platform-phrases/normalize', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function getPlatformPhraseCache(input: {
  source: 'personal' | 'team';
  platformAccountId?: string | null;
  localAccountId?: string | null;
}): Promise<{ item: PlatformPhraseSnapshot | null }> {
  const query = new URLSearchParams({ source: input.source });
  if (input.platformAccountId) query.set('platform_account_id', input.platformAccountId);
  if (input.localAccountId) query.set('local_account_id', input.localAccountId);
  return apiRequest<{ item: PlatformPhraseSnapshot | null }>(`/platform-phrases/cache?${query}`);
}

export function savePlatformPhraseCache(input: {
  platform: 'pinduoduo';
  source: 'personal' | 'team';
  platformAccountId?: string | null;
  localAccountId?: string | null;
  records: PlatformPhraseRecord[];
  rawCount?: number;
  status?: 'collected' | 'failed';
  error?: string | null;
}): Promise<PlatformPhraseSnapshot> {
  return apiRequest<PlatformPhraseSnapshot>('/platform-phrases/cache', {
    method: 'PUT',
    body: JSON.stringify({
      platform: input.platform,
      source: input.source,
      platform_account_id: input.platformAccountId || null,
      local_account_id: input.localAccountId || null,
      records: input.records,
      raw_count: input.rawCount ?? input.records.length,
      status: input.status || 'collected',
      error: input.error || null,
    }),
  });
}

export function createPlatformPhraseNormalizeTask(input: {
  platform: 'pinduoduo';
  source: 'personal' | 'team';
  existing_categories: string[];
  records: PlatformPhraseRecord[];
}): Promise<PlatformPhraseNormalizeTask> {
  return apiRequest<PlatformPhraseNormalizeTask>('/platform-phrases/normalize-tasks', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function getPlatformPhraseNormalizeTask(taskId: string): Promise<PlatformPhraseNormalizeTask> {
  return apiRequest<PlatformPhraseNormalizeTask>(`/platform-phrases/normalize-tasks/${encodeURIComponent(taskId)}`);
}

export function cancelPlatformPhraseNormalizeTask(taskId: string): Promise<PlatformPhraseNormalizeTask> {
  return apiRequest<PlatformPhraseNormalizeTask>(
    `/platform-phrases/normalize-tasks/${encodeURIComponent(taskId)}/cancel`,
    { method: 'POST' },
  );
}

export function updateQaEntry(entryId: string, input: QaEntryInput): Promise<QaEntry> {
  return knowledgeRequest<QaEntry>(`/qa-entries/${encodeURIComponent(entryId)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function deleteQaEntry(entryId: string): Promise<QaEntry> {
  return knowledgeRequest<QaEntry>(`/qa-entries/${encodeURIComponent(entryId)}`, { method: 'DELETE' });
}

export async function uploadQaImage(file: File): Promise<{ image_url: string }> {
  const body = new FormData();
  body.append('file', file);
  return knowledgeRequest<{ image_url: string }>('/qa-assets', { method: 'POST', body });
}

export function getQaImageUrl(imageUrl: string): string {
  if (!imageUrl) return imageUrl;
  if (/^(?:https?:)/i.test(imageUrl)) {
    // Normalize URLs returned by older ai-reply processes that omitted the API prefix.
    return imageUrl.replace(/(\/8010)(\/qa-assets\/)/i, '$1/api/v1$2');
  }
  if (/^(?:data:|blob:)/i.test(imageUrl)) return imageUrl;
  return `${KNOWLEDGE_BASE_URL}${imageUrl.startsWith('/') ? '' : '/'}${imageUrl}`;
}

export function getBusinessAssetUrl(assetUrl: string): string {
  if (!assetUrl) return assetUrl;
  if (/^(?:https?:|data:|blob:)/i.test(assetUrl)) return assetUrl;
  const apiRoot = API_BASE_URL.replace(/\/api\/v1$/, '');
  return `${apiRoot}${assetUrl.startsWith('/') ? '' : '/'}${assetUrl}`;
}

export async function loadQaImageUrl(imageUrl: string): Promise<string> {
  const url = getQaImageUrl(imageUrl);
  if (!url.includes('/api/v1/qa-assets/')) return url;
  const session = getStoredSession();
  if (!session) throw new Error('登录状态已失效，请重新登录');
  let response = await fetch(url, { headers: { Authorization: `Bearer ${session.access_token}` } });
  if (response.status === 401) {
    const refreshed = await refreshSession();
    if (refreshed) {
      response = await fetch(url, { headers: { Authorization: `Bearer ${refreshed.access_token}` } });
    }
  }
  if (!response.ok) throw await parseError(response);
  return URL.createObjectURL(await response.blob());
}

export function listProductDocuments(baseId: string): Promise<KnowledgeDocument[]> {
  return knowledgeRequest<KnowledgeDocument[]>(`/knowledge-bases/${encodeURIComponent(baseId)}/documents`);
}

export function getKnowledgeDocument(documentId: string): Promise<KnowledgeDocumentDetail> {
  return knowledgeRequest<KnowledgeDocumentDetail>(`/documents/${encodeURIComponent(documentId)}`);
}

export function listKnowledgeDocumentChunks(
  documentId: string,
  page = 1,
  pageSize = 100,
): Promise<KnowledgeDocumentChunkPage> {
  const query = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
  return knowledgeRequest<KnowledgeDocumentChunkPage>(`/documents/${encodeURIComponent(documentId)}/chunks?${query}`);
}

export function importProductDocument(baseId: string, file: File): Promise<KnowledgeDocument> {
  const body = new FormData();
  body.append('file', file);
  return knowledgeRequest<KnowledgeDocument>(`/documents/import?base_id=${encodeURIComponent(baseId)}`, {
    method: 'POST',
    body,
  });
}

export function deleteKnowledgeDocument(documentId: string): Promise<KnowledgeDocument> {
  return knowledgeRequest<KnowledgeDocument>(`/documents/${encodeURIComponent(documentId)}`, { method: 'DELETE' });
}

export function reprocessKnowledgeDocument(documentId: string): Promise<KnowledgeDocument> {
  return knowledgeRequest<KnowledgeDocument>(`/documents/${encodeURIComponent(documentId)}/reprocess`, {
    method: 'POST',
  });
}

export function searchProductDocuments(input: {
  query: string;
  baseIds: string[];
  topK?: number;
}): Promise<ProductDocumentSearchResponse> {
  return knowledgeRequest<ProductDocumentSearchResponse>('/documents/search', {
    method: 'POST',
    body: JSON.stringify({
      query: input.query,
      base_ids: input.baseIds,
      top_k: input.topK ?? 5,
    }),
  });
}

export function listRobots(): Promise<ApiRobot[]> {
  return apiRequest<ApiRobot[]>('/robots');
}

export function createRobot(input: RobotInput): Promise<ApiRobot> {
  return apiRequest<ApiRobot>('/robots', { method: 'POST', body: JSON.stringify(input) });
}

export function updateRobot(robotId: string, input: Partial<RobotInput>): Promise<ApiRobot> {
  return apiRequest<ApiRobot>(`/robots/${encodeURIComponent(robotId)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function deleteRobot(robotId: string): Promise<void> {
  return apiRequest<void>(`/robots/${encodeURIComponent(robotId)}`, { method: 'DELETE' });
}

export function listPlatformAccounts(): Promise<{ items: PlatformAccount[] }> {
  return apiRequest<{ items: PlatformAccount[] }>('/platform-accounts');
}

export function updatePlatformAccount(
  accountId: string,
  input: { metadata_json?: Record<string, unknown> },
): Promise<PlatformAccount> {
  return apiRequest<PlatformAccount>(`/platform-accounts/${encodeURIComponent(accountId)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function generatePlatformAccountShopSummary(accountId: string): Promise<PlatformAccount> {
  return apiRequest<PlatformAccount>(`/platform-accounts/${encodeURIComponent(accountId)}/shop-summary/generate`, {
    method: 'POST',
  });
}

export function updatePlatformAccountShopSummary(
  accountId: string,
  input: { shop_intro: string; on_sale_products: string },
): Promise<PlatformAccount> {
  return apiRequest<PlatformAccount>(`/platform-accounts/${encodeURIComponent(accountId)}/shop-summary`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function listConversations(): Promise<PageResponse<ApiConversation>> {
  return apiRequest<PageResponse<ApiConversation>>('/conversations?limit=100');
}

export function getCustomerOrders(conversationId: string): Promise<CustomerOrdersResponse> {
  return apiRequest<CustomerOrdersResponse>(
    `/conversations/${encodeURIComponent(conversationId)}/orders`,
  );
}

export function getCustomerProducts(conversationId: string): Promise<CustomerProductsResponse> {
  return apiRequest<CustomerProductsResponse>(
    `/conversations/${encodeURIComponent(conversationId)}/products`,
  );
}

export function clearConversationHumanRequired(conversationId: string): Promise<{ conversation: ApiConversation }> {
  return apiRequest<{ conversation: ApiConversation }>(
    `/conversations/${encodeURIComponent(conversationId)}/clear-human-required`,
    { method: 'POST' },
  );
}

export function clearConversationAwaitingReply(conversationId: string): Promise<{ conversation: ApiConversation }> {
  return apiRequest<{ conversation: ApiConversation }>(
    `/conversations/${encodeURIComponent(conversationId)}/clear-awaiting-reply`,
    { method: 'POST' },
  );
}

export function clearConversationHistory(conversationId: string): Promise<{ conversation: ApiConversation }> {
  return apiRequest(`/conversations/${encodeURIComponent(conversationId)}/clear-history`, {
    method: 'POST',
  });
}

export function deleteConversation(conversationId: string): Promise<{ conversation: ApiConversation }> {
  return apiRequest(`/conversations/${encodeURIComponent(conversationId)}`, {
    method: 'DELETE',
  });
}

export function getConversationMessageSyncIssue(
  conversationId: string,
): Promise<MessageSyncIssueDetail> {
  return apiRequest<MessageSyncIssueDetail>(
    `/conversations/${encodeURIComponent(conversationId)}/message-sync-issue`,
  );
}

export function dismissConversationMessageSyncIssue(
  conversationId: string,
): Promise<{ conversation: ApiConversation }> {
  return apiRequest<{ conversation: ApiConversation }>(
    `/conversations/${encodeURIComponent(conversationId)}/message-sync-issue/dismiss`,
    { method: 'POST' },
  );
}

export function rebuildConversationMessageQueue(conversationId: string): Promise<{
  conversation: ApiConversation;
  messages: ApiMessage[];
  deleted_counts: Record<string, number>;
}> {
  return apiRequest(
    `/conversations/${encodeURIComponent(conversationId)}/message-sync-issue/rebuild`,
    { method: 'POST' },
  );
}

export function resetConversationTestData(conversationId: string): Promise<{
  conversation: ApiConversation;
  deleted_counts: Record<string, number>;
}> {
  return apiRequest(
    `/conversations/${encodeURIComponent(conversationId)}/reset-test-data`,
    { method: 'POST' },
  );
}

export function listMessages(conversationId: string): Promise<PageResponse<ApiMessage>> {
  return apiRequest<PageResponse<ApiMessage>>(
    `/conversations/${encodeURIComponent(conversationId)}/messages?limit=200`,
  );
}

export function sendMessage(conversationId: string, content: string, clientMessageId?: string): Promise<{ message: ApiMessage }> {
  return apiRequest<{ message: ApiMessage }>('/messages/send', {
    method: 'POST',
    body: JSON.stringify({ conversation_id: conversationId, content, client_message_id: clientMessageId }),
  });
}

export function recordSentMessage(
  conversationId: string,
  content: string,
  platformMessageId?: string | null,
  clientMessageId?: string | null,
  mediaType: 'text' | 'image' = 'text',
  options: { platformSentAt?: string | null; rawPayload?: Record<string, unknown> | null } = {},
): Promise<{ message: ApiMessage }> {
  return apiRequest<{ message: ApiMessage }>('/messages/record-sent', {
    method: 'POST',
    body: JSON.stringify({
      conversation_id: conversationId,
      content,
      platform_message_id: platformMessageId || null,
      client_message_id: clientMessageId || null,
      media_type: mediaType,
      platform_sent_at: options.platformSentAt || null,
      raw_payload: options.rawPayload || null,
    }),
  });
}

export function getMonitoringOverview(model?: string): Promise<MonitoringOverview> {
  const query = model ? `?model=${encodeURIComponent(model)}` : '';
  return apiRequest<MonitoringOverview>(`/monitoring/overview${query}`);
}

export function listMonitoringLogs(
  type: 'all' | 'reply' | 'token' = 'all',
): Promise<{ items: MonitoringLog[] }> {
  return apiRequest<{ items: MonitoringLog[] }>(`/monitoring/logs?type=${type}&limit=100`);
}

export function listMonitoringEvents(): Promise<{ items: MonitoringEvent[] }> {
  return apiRequest<{ items: MonitoringEvent[] }>('/monitoring/events?limit=10');
}

export function connectRealtime(
  accessToken: string,
  onEvent: (event: RealtimeEvent) => void,
  onStatus: (status: 'connecting' | 'connected' | 'disconnected') => void,
  onConnected?: () => void,
): () => void {
  const configured = window.desktopConfig?.websocketUrl || import.meta.env.VITE_WS_URL as string | undefined;
  const wsBase = configured
    ? configured.replace(/\/$/, '')
    : import.meta.env.DEV
      ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`
      : API_BASE_URL.replace(/^http/, 'ws').replace(/\/api\/v1$/, '');
  let socket: WebSocket | null = null;
  let heartbeat: number | null = null;
  let reconnectTimer: number | null = null;
  let reconnectAttempt = 0;
  let stopped = false;
  let hasConnected = false;

  const clearHeartbeat = () => {
    if (heartbeat !== null) window.clearInterval(heartbeat);
    heartbeat = null;
  };

  const connect = async (refreshBeforeConnect = false) => {
    if (stopped) return;
    if (!hasConnected && reconnectAttempt === 0) onStatus('connecting');
    const refreshed = refreshBeforeConnect ? await refreshSession() : null;
    if (stopped) return;
    const currentAccessToken = refreshed?.access_token || getStoredSession()?.access_token || accessToken;
    const nextSocket = new WebSocket(`${wsBase}/ws/events?token=${encodeURIComponent(currentAccessToken)}`);
    socket = nextSocket;

    nextSocket.addEventListener('open', () => {
      if (stopped || socket !== nextSocket) return;
      reconnectAttempt = 0;
      hasConnected = true;
      onStatus('connected');
      onConnected?.();
      clearHeartbeat();
      heartbeat = window.setInterval(() => {
        if (nextSocket.readyState === WebSocket.OPEN) nextSocket.send('ping');
      }, 30_000);
    });
    nextSocket.addEventListener('message', (event) => {
      try {
        onEvent(JSON.parse(event.data) as RealtimeEvent);
      } catch {
        // Ignore malformed push messages and keep the connection alive.
      }
    });
    nextSocket.addEventListener('close', () => {
      if (socket !== nextSocket) return;
      clearHeartbeat();
      socket = null;
      if (stopped) return;
      onStatus('disconnected');
      const delay = Math.min(30_000, 1_000 * (2 ** reconnectAttempt));
      reconnectAttempt += 1;
      reconnectTimer = window.setTimeout(() => void connect(true), delay);
    });
    nextSocket.addEventListener('error', () => {
      if (nextSocket.readyState !== WebSocket.CLOSED) nextSocket.close();
    });
  };

  void connect();

  return () => {
    stopped = true;
    clearHeartbeat();
    if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
    socket?.close();
    socket = null;
  };
}

export function listMessageNotices(since: string): Promise<MessageNoticeSnapshot> {
  return apiRequest<MessageNoticeSnapshot>(`/conversations/message-notices?since=${encodeURIComponent(since)}`);
}

export function refreshDouyinCustomerOrders(conversationId: string): Promise<{ task_id: string }> {
  return apiRequest(`/conversations/${encodeURIComponent(conversationId)}/orders/refresh`, { method: 'POST' });
}

export function getConversation(conversationId: string): Promise<{ conversation: ApiConversation }> {
  return apiRequest<{ conversation: ApiConversation }>(`/conversations/${encodeURIComponent(conversationId)}`);
}
