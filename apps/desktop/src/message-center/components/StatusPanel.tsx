import {
  Activity,
  AlertCircle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Cpu,
  Edit3,
  Image as ImageIcon,
  MessageSquareText,
  PackageSearch,
  RefreshCw,
  Save,
  ShieldCheck,
  Sparkles,
  Store,
  Terminal,
  Zap,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { parseApiDateTime } from '../../shared/dateTime';
import type { BotStatus, Conversation, StatusEvent } from '../types';
import type {
  CustomerProduct,
  CustomerProductsResponse,
  CustomerOrdersResponse,
  PlatformQuickReply,
  ShopProductSummary,
} from '../../shared/api/client';

interface StatusPanelProps {
  bot: BotStatus;
  events: StatusEvent[];
  isLoading: boolean;
  onModelChange: (model: string) => void;
  onViewLogs: () => void;
  connectionStatus: 'connecting' | 'connected' | 'disconnected';
  isLoadingConversations: boolean;
  customerOrders: CustomerOrdersResponse | null;
  isLoadingCustomerOrders: boolean;
  onRefreshCustomerOrders: () => Promise<void>;
  customerProducts: CustomerProductsResponse | null;
  isLoadingCustomerProducts: boolean;
  onRefreshCustomerProducts: () => Promise<CustomerProductsResponse | null>;
  onSendCustomerProduct: (product: CustomerProduct) => Promise<void>;
  shopSummary: ShopProductSummary;
  isLoadingShopSummary: boolean;
  isGeneratingShopSummary: boolean;
  isSavingShopSummary: boolean;
  onGenerateShopSummary: () => Promise<ShopProductSummary>;
  onSaveShopSummary: (summary: { shop_intro: string; on_sale_products: string }) => Promise<ShopProductSummary>;
  quickReplies: {
    personal: PlatformQuickReply[];
    team: PlatformQuickReply[];
  };
  quickReplyStatus: {
    personal: { isLoading: boolean; error: string; unavailable: boolean };
    team: { isLoading: boolean; error: string; unavailable: boolean };
  };
  onRefreshQuickReplies: (source: 'personal' | 'team') => Promise<void>;
  onSelectQuickReply: (item: PlatformQuickReply) => void;
  conversation?: Conversation;
}

function formatDuration(value: number | null): string {
  if (value === null) return '--';
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${value}ms`;
}

function formatEventTime(value: string): string {
  const date = parseApiDateTime(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

const outreachLabels: Record<string, string> = {
  order_follow_up: '未下单追单',
  post_receipt_care: '签收后关怀',
};

const outreachStatusLabels: Record<string, string> = {
  candidate: '待调度',
  scheduled: '等待中',
  rechecking: '正在复查订单',
  queued: '等待发送',
  completed: '已发送',
  cancelled: '已取消',
  failed: '发送失败',
};

const orderStatusLabels: Record<string, string> = {
  pending_payment: '待支付',
  paid_pending_shipment: '待发货',
  shipped_pending_receipt: '待签收',
  signed: '已签收',
  completed: '已完成',
  refunding: '退款中',
  refunded: '已退款',
  cancelled: '已取消',
  unknown: '状态未知',
};

function formatOrderTime(value: string | null): string {
  if (!value) return '--';
  const matched = value.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  return matched ? `${matched[1]}/${matched[2]}/${matched[3]} ${matched[4]}:${matched[5]}` : value;
}

function formatMoney(value: number | null): string {
  return value === null ? '--' : `¥${value.toFixed(2)}`;
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) throw new Error('Failed to copy order ID');
}

function groupQuickReplies(items: PlatformQuickReply[]): Array<{ name: string; items: PlatformQuickReply[] }> {
  const groups = new Map<string, PlatformQuickReply[]>();
  for (const item of items) {
    const name = item.category.trim() || '未分类';
    const group = groups.get(name) || [];
    group.push(item);
    groups.set(name, group);
  }
  return [...groups.entries()].map(([name, groupItems]) => ({ name, items: groupItems }));
}

function QuickReplySection({
  title,
  items,
  status,
  isOpen,
  onToggle,
  onRefresh,
  onSelect,
}: {
  title: string;
  items: PlatformQuickReply[];
  status: { isLoading: boolean; error: string; unavailable: boolean };
  isOpen: boolean;
  onToggle: () => void;
  onRefresh: () => Promise<void>;
  onSelect: (item: PlatformQuickReply) => void;
}) {
  const groups = groupQuickReplies(items);
  return (
    <section className="border-b border-slate-200 last:border-b-0">
      <div className="flex items-center gap-2 bg-white px-1 py-2">
        <button
          type="button"
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left"
          aria-expanded={isOpen}
        >
          <MessageSquareText size={14} className="shrink-0 text-sky-500" />
          <span className="truncate text-xs font-bold text-slate-700">{title}</span>
          <span className="shrink-0 text-[10px] font-medium text-slate-400">{items.length}</span>
          <ChevronDown size={14} className={`ml-auto shrink-0 text-slate-300 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
        </button>
        <button
          type="button"
          onClick={() => void onRefresh()}
          disabled={status.isLoading}
          className="shrink-0 rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-indigo-600 disabled:cursor-not-allowed disabled:opacity-50"
          title={`刷新${title}`}
          aria-label={`刷新${title}`}
        >
          <RefreshCw size={13} className={status.isLoading ? 'animate-spin' : ''} />
        </button>
      </div>
      {isOpen ? (
        <div className="space-y-3 pb-4">
          {status.unavailable ? (
            <p className="rounded-lg bg-slate-50 px-3 py-2 text-[10px] leading-4 text-slate-500">
              当前店铺未启用{title}
            </p>
          ) : null}
          {status.error ? (
            <p className="rounded-lg border border-rose-100 bg-rose-50 px-3 py-2 text-[10px] leading-4 text-rose-600">
              {status.error}
            </p>
          ) : null}
          {status.isLoading && items.length === 0 ? (
            <p className="px-1 py-5 text-center text-xs text-slate-400">正在读取{title}...</p>
          ) : null}
          {groups.map((group) => (
            <div key={group.name} className="space-y-1.5">
              <div className="px-1 text-[10px] font-bold text-slate-400">{group.name}</div>
              {group.items.map((item) => (
                <button
                  type="button"
                  key={item.source_id}
                  onClick={() => onSelect(item)}
                  className="group w-full rounded-lg border border-slate-100 bg-white px-3 py-2 text-left transition-colors hover:border-sky-200 hover:bg-sky-50"
                  title="填入输入框"
                >
                  <span className="block line-clamp-3 whitespace-pre-wrap break-words text-xs leading-5 text-slate-600 group-hover:text-slate-700">
                    {item.content}
                  </span>
                  <span className="mt-1 flex items-center gap-2 text-[10px] text-slate-400">
                    {item.quick_key ? <span className="truncate">{item.quick_key}</span> : null}
                    {item.images.length > 0 ? (
                      <span className="inline-flex shrink-0 items-center gap-0.5">
                        <ImageIcon size={11} />
                        {item.images.length}
                      </span>
                    ) : null}
                  </span>
                </button>
              ))}
            </div>
          ))}
          {!status.isLoading && !status.unavailable && !status.error && items.length === 0 ? (
            <p className="px-1 py-5 text-center text-xs text-slate-400">暂无话术</p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export default function StatusPanel({
  bot,
  events,
  isLoading,
  onModelChange,
  onViewLogs,
  connectionStatus,
  isLoadingConversations,
  customerOrders,
  isLoadingCustomerOrders,
  onRefreshCustomerOrders,
  customerProducts,
  isLoadingCustomerProducts,
  onRefreshCustomerProducts,
  onSendCustomerProduct,
  shopSummary,
  isLoadingShopSummary,
  isGeneratingShopSummary,
  isSavingShopSummary,
  onGenerateShopSummary,
  onSaveShopSummary,
  quickReplies,
  quickReplyStatus,
  onRefreshQuickReplies,
  onSelectQuickReply,
  conversation,
}: StatusPanelProps) {
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [activeView, setActiveView] = useState<'products' | 'orders' | 'quickReplies' | 'status'>('products');
  const [isPersonalRepliesOpen, setIsPersonalRepliesOpen] = useState(true);
  const [isTeamRepliesOpen, setIsTeamRepliesOpen] = useState(true);
  const [isSummaryOpen, setIsSummaryOpen] = useState(false);
  const [summaryDraft, setSummaryDraft] = useState({ shop_intro: '', on_sale_products: '' });
  const [summaryNotice, setSummaryNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [refreshError, setRefreshError] = useState('');
  const [productRefreshError, setProductRefreshError] = useState('');
  const [sendingProductId, setSendingProductId] = useState('');
  const [productPage, setProductPage] = useState(1);
  const [copiedOrderId, setCopiedOrderId] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isModelMenuOpen) return;
    const closeMenu = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setIsModelMenuOpen(false);
    };
    document.addEventListener('mousedown', closeMenu);
    return () => document.removeEventListener('mousedown', closeMenu);
  }, [isModelMenuOpen]);

  const productPageSize = 10;
  const productItems = customerProducts?.products || [];
  const productPageCount = Math.max(1, Math.ceil(productItems.length / productPageSize));
  const normalizedProductPage = Math.min(productPage, productPageCount);
  const visibleProducts = productItems.slice(
    (normalizedProductPage - 1) * productPageSize,
    normalizedProductPage * productPageSize,
  );
  const isPinduoduoConversation = conversation?.platform === 'pinduoduo';

  useEffect(() => {
    setProductPage(1);
  }, [customerProducts?.conversation_id, customerProducts?.observed_at]);

  useEffect(() => {
    setProductPage((current) => Math.min(current, productPageCount));
  }, [productPageCount]);

  useEffect(() => {
    const nextDraft = {
      shop_intro: shopSummary.shop_intro || '',
      on_sale_products: shopSummary.on_sale_products || '',
    };
    setSummaryDraft(nextDraft);
    setSummaryNotice(null);
    setIsSummaryOpen(!nextDraft.shop_intro && !nextDraft.on_sale_products);
  }, [conversation?.shopId, shopSummary.shop_intro, shopSummary.on_sale_products]);

  const connectionLabel = {
    connecting: '连接中',
    connected: '服务已连接',
    disconnected: '服务已断开',
  }[connectionStatus];
  const eventColor = {
    info: 'text-blue-500',
    success: 'text-emerald-500',
    warning: 'text-amber-500',
    error: 'text-rose-500',
  };

  const handleCopyOrderId = async (orderId: string) => {
    try {
      await copyText(orderId);
      setCopiedOrderId(orderId);
      window.setTimeout(() => {
        setCopiedOrderId((current) => current === orderId ? '' : current);
      }, 1500);
    } catch {
      setCopiedOrderId('');
    }
  };

  const handleGenerateSummary = async () => {
    setSummaryNotice(null);
    setIsSummaryOpen(true);
    try {
      const nextSummary = await onGenerateShopSummary();
      setSummaryDraft({
        shop_intro: nextSummary.shop_intro || '',
        on_sale_products: nextSummary.on_sale_products || '',
      });
      setSummaryNotice({ type: 'success', text: '已生成，可继续编辑后保存' });
    } catch (error) {
      setSummaryNotice({ type: 'error', text: error instanceof Error ? error.message : '生成失败' });
    }
  };

  const handleSaveSummary = async () => {
    setSummaryNotice(null);
    try {
      const nextSummary = await onSaveShopSummary(summaryDraft);
      setSummaryDraft({
        shop_intro: nextSummary.shop_intro || '',
        on_sale_products: nextSummary.on_sale_products || '',
      });
      setSummaryNotice({ type: 'success', text: '已保存到店铺资料' });
    } catch (error) {
      setSummaryNotice({ type: 'error', text: error instanceof Error ? error.message : '保存失败' });
    }
  };

  const hasShopSummary = Boolean(shopSummary.shop_intro || shopSummary.on_sale_products);
  const summaryTimestamp = shopSummary.edited_at || shopSummary.generated_at || '';

  return (
    <div className="h-full w-full flex flex-col border-l border-brand-border bg-slate-50/50" id="status-panel">
      <div className="border-b border-brand-border bg-white p-4">
        <div className="flex items-center gap-3">
          <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-slate-100 bg-slate-50 text-slate-300">
            {conversation?.shopLogoUrl ? (
              <img
                src={conversation.shopLogoUrl}
                alt=""
                className="h-full w-full object-cover"
                referrerPolicy="no-referrer"
              />
            ) : (
              <Store size={26} />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <h2 className="min-w-0 truncate text-sm font-bold text-slate-800">
                {conversation?.shopName || '未选择店铺'}
              </h2>
              {conversation?.shopIsMallOwner ? (
                <span className="shrink-0 rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-bold text-emerald-600">
                  主账号
                </span>
              ) : null}
            </div>
            <p className="mt-1 truncate text-[11px] font-medium text-slate-500">
              客服账号：{conversation?.shopServiceUsername || '未识别'}
            </p>
          </div>
        </div>
      </div>
      <div className="border-b border-brand-border bg-white px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => setIsSummaryOpen((value) => !value)}
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
          >
            <Sparkles size={14} className="shrink-0 text-sky-500" />
            <span className="min-w-0 truncate text-xs font-bold text-slate-700">店铺在售商品信息摘要</span>
            <ChevronDown
              size={14}
              className={`shrink-0 text-slate-300 transition-transform ${isSummaryOpen ? 'rotate-180' : ''}`}
            />
          </button>
          <button
            type="button"
            disabled={!conversation || isLoadingShopSummary || isGeneratingShopSummary}
            onClick={() => void handleGenerateSummary()}
            className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-sky-100 bg-sky-50 px-1.5 text-[9px] font-medium leading-none text-sky-600 hover:bg-sky-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Sparkles size={11} />
            {isGeneratingShopSummary ? '生成中' : hasShopSummary ? '重新生成' : '生成'}
          </button>
        </div>
        {!isSummaryOpen && hasShopSummary ? (
          <p className="mt-2 line-clamp-2 text-[10px] leading-4 text-slate-500">
            {shopSummary.shop_intro || shopSummary.on_sale_products}
          </p>
        ) : null}
        {isSummaryOpen ? (
          <div className="mt-3 space-y-3">
            <label className="block">
              <span className="flex items-center gap-1 text-[10px] font-bold text-slate-500">
                <Edit3 size={11} />
                店铺简介
              </span>
              <textarea
                value={summaryDraft.shop_intro}
                onChange={(event) => setSummaryDraft((current) => ({ ...current, shop_intro: event.target.value }))}
                placeholder="例如：主营二次元抱枕、枕套和周边定制。"
                className="mt-1 h-16 w-full resize-none rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 text-[10px] leading-[15px] text-slate-700 outline-none focus:border-sky-300 focus:bg-white"
              />
            </label>
            <label className="block">
              <span className="flex items-center gap-1 text-[10px] font-bold text-slate-500">
                <PackageSearch size={11} />
                当前在售商品
              </span>
              <textarea
                value={summaryDraft.on_sale_products}
                onChange={(event) => setSummaryDraft((current) => ({ ...current, on_sale_products: event.target.value }))}
                placeholder="当前店铺在售商品：商品标题一；商品标题二；..."
                className="mt-1 h-28 w-full resize-none rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 text-[10px] leading-[15px] text-slate-700 outline-none focus:border-sky-300 focus:bg-white"
              />
            </label>
            <div className="flex items-center justify-between gap-2">
              <p className="min-w-0 truncate text-[9px] text-slate-400">
                {summaryTimestamp ? `最近更新：${new Date(summaryTimestamp).toLocaleString('zh-CN')}` : '保存后会参与自动回复判断'}
              </p>
              <button
                type="button"
                disabled={!conversation || isSavingShopSummary}
                onClick={() => void handleSaveSummary()}
                className="inline-flex shrink-0 items-center gap-1 rounded-md bg-sky-500 px-2.5 py-1 text-[10px] font-semibold text-white hover:bg-sky-600 disabled:cursor-not-allowed disabled:bg-slate-300"
              >
                <Save size={12} />
                {isSavingShopSummary ? '保存中' : '保存'}
              </button>
            </div>
            {summaryNotice ? (
              <p className={`text-[10px] ${summaryNotice.type === 'success' ? 'text-emerald-600' : 'text-rose-600'}`}>
                {summaryNotice.text}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="p-4 border-b border-brand-border bg-white">
        <div className="grid grid-cols-4 gap-1 rounded-xl bg-slate-100 p-1">
          <button onClick={() => setActiveView('products')} className={`rounded-lg px-1.5 py-1.5 text-[11px] font-semibold leading-4 transition-colors ${activeView === 'products' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500'}`}>商品列表</button>
          <button onClick={() => setActiveView('orders')} className={`rounded-lg px-1.5 py-1.5 text-[11px] font-semibold leading-4 transition-colors ${activeView === 'orders' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500'}`}>客户订单</button>
          <button onClick={() => setActiveView('quickReplies')} className={`rounded-lg px-1.5 py-1.5 text-[11px] font-semibold leading-4 transition-colors ${activeView === 'quickReplies' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500'}`}>快捷回复</button>
          <button onClick={() => setActiveView('status')} className={`rounded-lg px-1.5 py-1.5 text-[11px] font-semibold leading-4 transition-colors ${activeView === 'status' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500'}`}>运行状态</button>
        </div>
      </div>

      {activeView === 'products' ? <div className="flex-1 overflow-y-auto p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-bold text-slate-800">商品列表</h2>
            <p className="mt-1 text-[10px] text-slate-400">来自拼多多 recommendGoods</p>
          </div>
          <button
            onClick={() => {
              setProductRefreshError('');
              void onRefreshCustomerProducts().catch((error) => setProductRefreshError(error instanceof Error ? error.message : '商品刷新失败'));
            }}
            disabled={isLoadingCustomerProducts}
            className="rounded-lg border border-slate-200 bg-white p-2 text-slate-500 hover:text-indigo-600 disabled:opacity-50"
            title="刷新商品列表"
          >
            <RefreshCw size={15} className={isLoadingCustomerProducts ? 'animate-spin' : ''} />
          </button>
        </div>

        {productRefreshError && <div className="rounded-xl border border-rose-100 bg-rose-50 p-3 text-xs text-rose-600">{productRefreshError}</div>}
        {isLoadingCustomerProducts && !customerProducts && <div className="py-16 text-center text-xs text-slate-400">正在读取商品列表...</div>}
        {!isLoadingCustomerProducts && (!customerProducts || customerProducts.collection_status === 'not_collected' || customerProducts.collection_status === 'unavailable') && (
          <div className="rounded-2xl border border-dashed border-slate-200 bg-white py-12 text-center">
            <PackageSearch size={28} className="mx-auto text-slate-300" />
            <p className="mt-3 text-xs font-semibold text-slate-500">尚未采集商品列表</p>
            <p className="mt-1 text-[10px] text-slate-400">可点击右上角刷新</p>
          </div>
        )}
        {customerProducts?.collection_status === 'empty' && (
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5 text-center text-xs font-semibold text-slate-600">未读取到商品信息</div>
        )}
        {visibleProducts.map((product, index) => {
          const productKey = product.product_id || product.link_url || `${product.title || 'product'}:${index}`;
          const isSending = sendingProductId === productKey;
          return (
            <article key={productKey} className="border border-slate-200 bg-white p-2.5 shadow-sm">
              <div className="flex gap-3">
                {product.image_url ? (
                  <img src={product.image_url} alt="商品" className="h-20 w-20 shrink-0 border border-slate-100 object-cover" referrerPolicy="no-referrer" />
                ) : (
                  <div className="flex h-20 w-20 shrink-0 items-center justify-center border border-dashed border-slate-200 bg-slate-50 text-slate-300">
                    <PackageSearch size={22} />
                  </div>
                )}
                <div className="flex min-w-0 flex-1 flex-col items-start">
                  <p className="line-clamp-2 text-[11px] font-semibold leading-5 text-slate-700">{product.title || '商品信息暂缺'}</p>
                  {product.price_label && <p className="mt-1 text-xs font-bold text-rose-500">{product.price_label}</p>}
                  <button
                    type="button"
                    disabled={isSending || !product.product_id}
                    onClick={() => {
                      setProductRefreshError('');
                      setSendingProductId(productKey);
                      void onSendCustomerProduct(product)
                        .catch((error) => setProductRefreshError(error instanceof Error ? error.message : '商品发送失败'))
                        .finally(() => setSendingProductId((current) => current === productKey ? '' : current));
                    }}
                    className="mt-auto rounded bg-sky-500 px-1.5 py-0 leading-none text-white transition-colors hover:bg-sky-600 disabled:bg-slate-300"
                  >
                    <span className="block origin-center scale-75 text-[15px] font-medium">
                      {isSending ? '发送中' : '发送商品'}
                    </span>
                  </button>
                </div>
              </div>
            </article>
          );
        })}
        {customerProducts?.collection_status === 'success' && productItems.length > productPageSize && (
          <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-500">
            <button
              type="button"
              disabled={normalizedProductPage <= 1}
              onClick={() => setProductPage((current) => Math.max(1, current - 1))}
              className="flex items-center gap-1 rounded-md px-2 py-1 font-semibold text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-300"
            >
              <ChevronLeft size={14} />
              上一页
            </button>
            <span className="font-semibold text-slate-500">
              {normalizedProductPage} / {productPageCount}
              <span className="ml-1 font-normal text-slate-400">共 {productItems.length} 件</span>
            </span>
            <button
              type="button"
              disabled={normalizedProductPage >= productPageCount}
              onClick={() => setProductPage((current) => Math.min(productPageCount, current + 1))}
              className="flex items-center gap-1 rounded-md px-2 py-1 font-semibold text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-300"
            >
              下一页
              <ChevronRight size={14} />
            </button>
          </div>
        )}
        {customerProducts?.observed_at && <p className="text-center text-[9px] text-slate-400">最近采集：{new Date(customerProducts.observed_at).toLocaleString('zh-CN')}</p>}
      </div> : activeView === 'quickReplies' ? (
        <div className="flex-1 overflow-y-auto p-5">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-sm font-bold text-slate-800">快捷回复</h2>
              <p className="mt-1 truncate text-[10px] text-slate-400">来自当前拼多多店铺的平台话术</p>
            </div>
          </div>

          {!isPinduoduoConversation ? (
            <div className="rounded-xl border border-dashed border-slate-200 bg-white px-4 py-12 text-center">
              <MessageSquareText size={28} className="mx-auto text-slate-300" />
              <p className="mt-3 text-xs font-semibold text-slate-500">当前平台暂不支持快捷回复</p>
            </div>
          ) : (
            <>
              <div className="divide-y divide-slate-200">
                <QuickReplySection
                  title="个人话术"
                  items={quickReplies.personal}
                  status={quickReplyStatus.personal}
                  isOpen={isPersonalRepliesOpen}
                  onToggle={() => setIsPersonalRepliesOpen((value) => !value)}
                  onRefresh={() => onRefreshQuickReplies('personal')}
                  onSelect={onSelectQuickReply}
                />
                <QuickReplySection
                  title="团队话术"
                  items={quickReplies.team}
                  status={quickReplyStatus.team}
                  isOpen={isTeamRepliesOpen}
                  onToggle={() => setIsTeamRepliesOpen((value) => !value)}
                  onRefresh={() => onRefreshQuickReplies('team')}
                  onSelect={onSelectQuickReply}
                />
              </div>
            </>
          )}
        </div>
      ) : activeView === 'status' ? <>
      <div className="p-6 text-center border-b border-brand-border bg-white">
        <div className="w-20 h-20 bg-slate-50 rounded-3xl shadow-sm border border-slate-100 flex items-center justify-center mx-auto mb-4 relative">
          <div className="absolute -top-1 -right-1 w-6 h-6 bg-green-500 border-4 border-white rounded-full" />
          <Cpu size={40} className="text-brand-active" />
        </div>
        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">当前展示模型</p>
        <h2 className="mt-1 text-lg font-bold text-slate-800 break-all">{bot.model}</h2>
        <p className="mt-1 text-[10px] font-medium text-slate-400">仅切换统计视图，不修改实际配置</p>
      </div>

      <div className="p-6 space-y-6 overflow-y-auto flex-1" id="bot-metrics">
        <section>
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-2">
              <Activity size={12} />性能指标
            </h3>
            <span className="text-[10px] font-bold text-indigo-500 bg-indigo-50 px-1.5 py-0.5 rounded">今日</span>
          </div>
          <div className={`grid grid-cols-2 gap-3 ${isLoading ? 'opacity-60' : ''}`}>
            {[
              { label: '运行时间', value: bot.uptime || '--', icon: Clock, color: 'text-blue-500', hint: bot.uptime ? '' : '暂未统计' },
              { label: '请求处理', value: bot.requestsProcessed.toLocaleString(), icon: Zap, color: 'text-amber-500', hint: '模型调用次数' },
              { label: '系统健康', value: `${bot.health.toFixed(1)}%`, icon: ShieldCheck, color: 'text-emerald-500', hint: '模型调用成功率' },
              { label: '响应速度', value: formatDuration(bot.avgResponseTimeMs), icon: Zap, color: 'text-rose-500', hint: '平均回复生成耗时' },
            ].map((stat) => (
              <div key={stat.label} className="p-3 bg-white border border-slate-100 rounded-2xl shadow-sm">
                <div className={`p-1.5 rounded-lg bg-slate-50 inline-block mb-2 ${stat.color}`}><stat.icon size={14} /></div>
                <div className="text-xs font-bold text-slate-800">{stat.value}</div>
                <div className="text-[10px] text-slate-400 font-medium">{stat.label}</div>
                <div className="mt-1 text-[9px] text-slate-300">{stat.hint}</div>
              </div>
            ))}
          </div>
        </section>

        <section>
          <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-4 flex items-center gap-2"><Zap size={12} />快速操作</h3>
          <div className="space-y-2">
            <div className="relative" ref={menuRef}>
              <button onClick={() => setIsModelMenuOpen((value) => !value)} className="w-full flex items-center justify-between p-3 bg-white border border-slate-100 rounded-xl hover:shadow-md transition-all group">
                <div className="flex items-center gap-3"><div className="p-2 bg-indigo-50 rounded-lg text-indigo-500"><Cpu size={16} /></div><span className="text-sm font-semibold text-slate-700">查看模型数据</span></div>
                <ChevronDown size={16} className={`text-slate-300 transition-transform ${isModelMenuOpen ? 'rotate-180' : ''}`} />
              </button>
              {isModelMenuOpen && (
                <div className="absolute z-20 left-0 right-0 mt-2 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl">
                  {bot.availableModels.map((model) => (
                    <button key={model} onClick={() => { setIsModelMenuOpen(false); onModelChange(model); }} className={`w-full px-4 py-3 text-left text-xs font-semibold hover:bg-slate-50 ${model === bot.model ? 'text-indigo-600 bg-indigo-50' : 'text-slate-600'}`}>{model}</button>
                  ))}
                  {bot.availableModels.length === 0 && <div className="px-4 py-3 text-xs text-slate-400">暂无可用模型</div>}
                </div>
              )}
            </div>
            <button onClick={onViewLogs} className="w-full flex items-center justify-between p-3 bg-white border border-slate-100 rounded-xl hover:shadow-md transition-all group">
              <div className="flex items-center gap-3"><div className="p-2 bg-slate-100 rounded-lg text-slate-500"><Terminal size={16} /></div><span className="text-sm font-semibold text-slate-700">查看日志</span></div>
              <span className="text-xs text-slate-300">›</span>
            </button>
          </div>
        </section>

        <section>
          <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-4 flex items-center gap-2"><AlertCircle size={12} />最新事件</h3>
          <div className="max-h-64 overflow-y-auto space-y-3 bg-white/70 border border-slate-100 rounded-2xl p-4 text-[10px]">
            {events.length ? events.map((event) => (
              <div key={event.id} className="flex gap-2 leading-4">
                <span className="shrink-0 text-slate-400 font-mono">{formatEventTime(event.timestamp)}</span>
                <span className={eventColor[event.level]}>{event.message}</span>
              </div>
            )) : <p className="py-6 text-center text-slate-400">暂无运行事件</p>}
          </div>
        </section>
      </div>
      </> : <div className="flex-1 overflow-y-auto p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-bold text-slate-800">客户订单信息</h2>
            <p className="mt-1 text-[10px] text-slate-400">来自拼多多“最新订单 / 个人订单”</p>
          </div>
          <button
            onClick={() => {
              setRefreshError('');
              void onRefreshCustomerOrders().catch((error) => setRefreshError(error instanceof Error ? error.message : '订单刷新失败'));
            }}
            disabled={isLoadingCustomerOrders}
            className="rounded-lg border border-slate-200 bg-white p-2 text-slate-500 hover:text-indigo-600 disabled:opacity-50"
            title="刷新客户订单"
          >
            <RefreshCw size={15} className={isLoadingCustomerOrders ? 'animate-spin' : ''} />
          </button>
        </div>

        {refreshError && <div className="rounded-xl border border-rose-100 bg-rose-50 p-3 text-xs text-rose-600">{refreshError}</div>}
        {isLoadingCustomerOrders && !customerOrders && <div className="py-16 text-center text-xs text-slate-400">正在读取客户订单...</div>}
        {!isLoadingCustomerOrders && (!customerOrders || customerOrders.collection_status === 'not_collected') && (
          <div className="rounded-2xl border border-dashed border-slate-200 bg-white py-12 text-center">
            <PackageSearch size={28} className="mx-auto text-slate-300" />
            <p className="mt-3 text-xs font-semibold text-slate-500">尚未采集客户订单</p>
            <p className="mt-1 text-[10px] text-slate-400">可点击右上角刷新</p>
          </div>
        )}
        {(customerOrders?.collection_status === 'empty' || customerOrders?.collection_status === 'unavailable') && (
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5 text-center text-xs font-semibold text-slate-600">未读取到订单信息</div>
        )}
        {customerOrders?.orders.map((order) => {
          const product = order.products_json[0] as { title?: string; quantity?: number; image_url?: string } | undefined;
          const statusLabel = order.raw_status || orderStatusLabels[order.status] || order.status;
          return (
            <article key={order.id} className="border border-slate-200 bg-white shadow-sm">
              <div className="space-y-1.5 border-b border-slate-100 p-3 text-xs">
                <span className="block text-sm font-bold text-rose-500">{statusLabel}</span>
                <div className="flex items-center justify-between gap-2">
                  <p className="min-w-0 flex-1 truncate text-left text-slate-600">
                    <span>订单编号：</span><span className="font-medium text-slate-700">{order.platform_order_id}</span>
                  </p>
                  <button
                    type="button"
                    onClick={() => void handleCopyOrderId(order.platform_order_id)}
                    className="shrink-0 font-medium text-indigo-600 transition-colors hover:text-indigo-700"
                    title="复制订单编号"
                  >
                    {copiedOrderId === order.platform_order_id ? '已复制' : '复制'}
                  </button>
                </div>
                <p className="text-slate-600">下单时间：{formatOrderTime(order.ordered_at)}</p>
              </div>
              {String(order.after_sale_json?.text || '').trim() && (
                <div className="mx-3 mt-2 inline-block border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[9px] text-amber-700">
                  {String(order.after_sale_json.text)}
                </div>
              )}
              <div className="flex gap-3 border-b border-slate-100 p-3">
                {product?.image_url ? (
                  <img src={product.image_url} alt="商品" className="h-16 w-16 shrink-0 border border-slate-100 object-cover" referrerPolicy="no-referrer" />
                ) : (
                  <div className="flex h-16 w-16 shrink-0 items-center justify-center border border-dashed border-slate-200 bg-slate-50 text-slate-300">
                    <PackageSearch size={20} />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-[11px] font-medium leading-5 text-slate-700">{product?.title || '商品信息暂缺'}</p>
                  <div className="mt-2 flex items-center justify-between text-[10px]">
                    <span className="text-slate-500">x{product?.quantity || 1}</span>
                    <span className="font-medium text-slate-700">{formatMoney(order.order_amount ?? order.paid_amount)}</span>
                  </div>
                </div>
              </div>
              <div className="space-y-1 p-3 text-[11px]">
                <div className="flex justify-between text-slate-500"><span>店铺优惠抵扣</span><span>{formatMoney(order.discount_amount)}</span></div>
                <div className="flex justify-between font-medium text-slate-700"><span>实付</span><span className="text-rose-500">{formatMoney(order.paid_amount)}</span></div>
              </div>
            </article>
          );
        })}
        {customerOrders && customerOrders.outreach.length > 0 && (
          <section className="space-y-2">
            <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-400">主动话术状态</h3>
            {customerOrders.outreach.map((item) => (
              <div key={`${item.strategy_type}:${item.due_at}`} className="rounded-xl border border-slate-100 bg-white p-3 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-slate-700">{outreachLabels[item.strategy_type] || item.strategy_type}</span>
                  <span className="rounded-md bg-slate-50 px-2 py-1 text-[10px] font-bold text-slate-500">
                    {outreachStatusLabels[item.status] || item.status}
                  </span>
                </div>
                {item.status === 'scheduled' && (
                  <p className="mt-2 text-[10px] text-slate-400">计划时间：{parseApiDateTime(item.due_at).toLocaleString('zh-CN')}</p>
                )}
                {item.cancel_reason && <p className="mt-2 text-[10px] text-amber-600">原因：{item.cancel_reason}</p>}
              </div>
            ))}
          </section>
        )}
        {customerOrders?.observed_at && <p className="text-center text-[9px] text-slate-400">最近采集：{new Date(customerOrders.observed_at).toLocaleString('zh-CN')}</p>}
      </div>}

      <div className="p-4 bg-white border-t border-brand-border">
        <div className="flex items-center justify-end gap-3 px-2">
          <div className="flex items-center gap-1">
            <div className={`w-1.5 h-1.5 rounded-full ${connectionStatus === 'connected' ? 'bg-green-500 animate-pulse' : connectionStatus === 'connecting' ? 'bg-amber-500 animate-pulse' : 'bg-rose-500'}`} />
            <span className={`text-[10px] font-bold ${connectionStatus === 'connected' ? 'text-green-500' : connectionStatus === 'connecting' ? 'text-amber-500' : 'text-rose-500'}`}>{connectionLabel}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
