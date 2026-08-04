import {
  Activity,
  AlertCircle,
  ChevronDown,
  Clock,
  Cpu,
  ShieldCheck,
  Terminal,
  Zap,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { BotStatus, StatusEvent } from '../types';

interface StatusPanelProps {
  bot: BotStatus;
  events: StatusEvent[];
  isLoading: boolean;
  onModelChange: (model: string) => void;
  onViewLogs: () => void;
  connectionStatus: 'connecting' | 'connected' | 'disconnected';
}

function formatDuration(value: number | null): string {
  if (value === null) return '--';
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${value}ms`;
}

function formatEventTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

export default function StatusPanel({
  bot,
  events,
  isLoading,
  onModelChange,
  onViewLogs,
  connectionStatus,
}: StatusPanelProps) {
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
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

  return (
    <div className="w-80 h-full flex flex-col border-l border-brand-border bg-slate-50/50" id="status-panel">
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
