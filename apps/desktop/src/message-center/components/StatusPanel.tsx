import {
  Activity,
  AlertCircle,
  ChevronDown,
  Clock,
  Cpu,
  PackageSearch,
  RefreshCw,
  ShieldCheck,
  Terminal,
  Zap,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { parseApiDateTime } from '../../shared/dateTime';
import type { BotStatus, StatusEvent } from '../types';
import type { CustomerOrdersResponse } from '../../shared/api/client';

interface StatusPanelProps {
  bot: BotStatus;
  events: StatusEvent[];
  isLoading: boolean;
  onModelChange: (model: string) => void;
  onViewLogs: () => void;
  connectionStatus: 'connecting' | 'connected' | 'disconnected';
  customerOrders: CustomerOrdersResponse | null;
  isLoadingCustomerOrders: boolean;
  onRefreshCustomerOrders: () => Promise<void>;
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

export default function StatusPanel({
  bot,
  events,
  isLoading,
  onModelChange,
  onViewLogs,
  connectionStatus,
  customerOrders,
  isLoadingCustomerOrders,
  onRefreshCustomerOrders,
}: StatusPanelProps) {
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [activeView, setActiveView] = useState<'orders' | 'status'>('status');
  const [refreshError, setRefreshError] = useState('');
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

  return (
    <div className="w-80 h-full flex flex-col border-l border-brand-border bg-slate-50/50" id="status-panel">
      <div className="p-4 border-b border-brand-border bg-white">
        <div className="grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1">
          <button onClick={() => setActiveView('orders')} className={`rounded-lg px-3 py-2 text-xs font-bold transition-colors ${activeView === 'orders' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500'}`}>客户订单</button>
          <button onClick={() => setActiveView('status')} className={`rounded-lg px-3 py-2 text-xs font-bold transition-colors ${activeView === 'status' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500'}`}>运行状态</button>
        </div>
      </div>

      {activeView === 'status' ? <>
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
                <div className="flex items-center gap-3"><div className="p-2 bg-indigo-50 rounded-lg text-indigo-500"><Cpu size={16} /></div><span className="text-sm font-semibold text-slate-700">切换模型</span></div>
                <ChevronDown size={16} className={`text-slate-300 transition-transform ${isModelMenuOpen ? 'rotate-180' : ''}`} />
              </button>
              {isModelMenuOpen && (
                <div className="absolute z-20 left-0 right-0 mt-2 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl">
                  {bot.availableModels.map((model) => (
                    <button key={model} onClick={() => { setIsModelMenuOpen(false); onModelChange(model); }} className={`w-full px-4 py-3 text-left text-xs font-semibold hover:bg-slate-50 ${model === bot.model ? 'text-indigo-600 bg-indigo-50' : 'text-slate-600'}`}>{model}</button>
                  ))}
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
        {customerOrders?.collection_status === 'empty' && (
          <div className="rounded-2xl border border-emerald-100 bg-emerald-50 p-5 text-center text-xs font-semibold text-emerald-700">当前客户暂无个人订单</div>
        )}
        {customerOrders?.collection_status === 'unavailable' && (
          <div className="rounded-2xl border border-amber-100 bg-amber-50 p-4 text-xs text-amber-700">
            <p>订单读取失败，不能据此判断客户未下单。</p>
            {customerOrders.collection_error && (
              <p className="mt-2 break-all font-mono text-[10px] text-amber-600">{customerOrders.collection_error}</p>
            )}
          </div>
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
        <div className="flex items-center justify-end px-2">
          <div className="flex items-center gap-1">
            <div className={`w-1.5 h-1.5 rounded-full ${connectionStatus === 'connected' ? 'bg-green-500 animate-pulse' : connectionStatus === 'connecting' ? 'bg-amber-500 animate-pulse' : 'bg-rose-500'}`} />
            <span className={`text-[10px] font-bold ${connectionStatus === 'connected' ? 'text-green-500' : connectionStatus === 'connecting' ? 'text-amber-500' : 'text-rose-500'}`}>{connectionLabel}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
