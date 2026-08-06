import { AnimatePresence, motion } from 'framer-motion';
import { Filter, MessageSquare, Search, Terminal, X, Zap } from 'lucide-react';
import { useMemo, useState } from 'react';
import { parseApiDateTime } from '../../shared/dateTime';
import type { LogEntry } from '../types';

interface LogModalProps {
  isOpen: boolean;
  onClose: () => void;
  logs: LogEntry[];
  isLoading: boolean;
}

function formatTimestamp(value: string): string {
  const date = parseApiDateTime(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { hour12: false });
}

export default function LogModal({ isOpen, onClose, logs, isLoading }: LogModalProps) {
  const [filter, setFilter] = useState<'all' | 'reply' | 'token'>('all');
  const [searchTerm, setSearchTerm] = useState('');
  const filteredLogs = useMemo(() => logs.filter((log) => {
    const matchesFilter = filter === 'all' || log.type === filter;
    const keyword = searchTerm.trim().toLowerCase();
    const matchesSearch = !keyword || log.message.toLowerCase().includes(keyword) || (log.details?.toLowerCase().includes(keyword) ?? false);
    return matchesFilter && matchesSearch;
  }), [filter, logs, searchTerm]);

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" />
          <motion.div initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 20 }} className="relative w-full max-w-3xl h-[650px] bg-white rounded-3xl shadow-2xl overflow-hidden flex flex-col">
            <div className="p-6 border-b border-slate-100 flex items-center justify-between bg-white">
              <div className="flex items-center gap-3"><div className="p-2 bg-slate-900 rounded-xl text-white"><Terminal size={20} /></div><div><h2 className="text-lg font-bold text-slate-800">系统运行日志</h2><p className="text-xs text-slate-400 font-medium">回复处理与模型 Token 调用记录</p></div></div>
              <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-xl text-slate-400"><X size={20} /></button>
            </div>
            <div className="p-4 bg-slate-50 flex flex-wrap gap-3 items-center border-b border-slate-100">
              <div className="flex bg-white p-1 rounded-xl border border-slate-200 shadow-sm">
                {[
                  { id: 'all', label: '全部', icon: Filter },
                  { id: 'reply', label: '回复日志', icon: MessageSquare },
                  { id: 'token', label: 'Token 调用', icon: Zap },
                ].map((item) => <button key={item.id} onClick={() => setFilter(item.id as typeof filter)} className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-bold ${filter === item.id ? 'bg-slate-900 text-white shadow-md' : 'text-slate-500'}`}><item.icon size={14} />{item.label}</button>)}
              </div>
              <div className="flex-1 relative min-w-[200px]"><Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" /><input value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} placeholder="搜索日志内容..." className="w-full pl-9 pr-4 py-2 bg-white border border-slate-200 rounded-xl text-xs outline-none focus:border-indigo-500" /></div>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-2 bg-slate-900 font-mono text-xs">
              {isLoading ? <div className="h-full flex items-center justify-center text-slate-500">正在加载日志...</div> : filteredLogs.length ? filteredLogs.map((log) => {
                const totalTokens = (log.inputTokens || 0) + (log.outputTokens || 0);
                return <div key={log.id} className="p-3 rounded-lg bg-slate-800/50 border border-slate-700/50 hover:bg-slate-800">
                  <div className="flex items-center justify-between mb-1"><div className="flex items-center gap-2"><span className="text-slate-500 text-[10px]">{formatTimestamp(log.timestamp)}</span><span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${log.type === 'reply' ? 'bg-blue-500/20 text-blue-400' : 'bg-amber-500/20 text-amber-400'}`}>{log.type === 'reply' ? '回复' : 'TOKEN'}</span><span className={log.status === 'failed' ? 'text-rose-400' : 'text-emerald-400'}>{log.status}</span></div>{log.type === 'token' && <span className="text-amber-400 font-bold">{totalTokens} tokens</span>}</div>
                  <div className="text-slate-200 leading-relaxed">{log.message}</div>
                  {log.details && <div className="mt-1.5 pt-1.5 border-t border-slate-700/30 text-slate-500">{log.details}{log.durationMs !== null && log.durationMs !== undefined ? ` · ${log.durationMs}ms` : ''}</div>}
                </div>;
              }) : <div className="h-full flex flex-col items-center justify-center gap-2 text-slate-500"><Terminal size={32} className="text-slate-700" /><p>暂无匹配日志</p></div>}
            </div>
            <div className="p-4 border-t border-slate-100 bg-slate-50 flex items-center justify-between text-[10px] font-bold text-slate-400"><span>最近 100 条记录</span><span>{filteredLogs.length} 条</span></div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
