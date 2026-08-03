/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { AnimatePresence, motion } from 'framer-motion';
import { X, MessageSquare, Zap, Terminal, Search, Filter } from 'lucide-react';
import { LogEntry, MOCK_LOGS } from '../types';
import { useState } from 'react';

interface LogModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function LogModal({ isOpen, onClose }: LogModalProps) {
  const [filter, setFilter] = useState<'all' | 'reply' | 'token' | 'system'>('all');
  const [searchTerm, setSearchTerm] = useState('');

  const filteredLogs = MOCK_LOGS.filter(log => {
    const matchesFilter = filter === 'all' || log.type === filter;
    const matchesSearch = log.message.toLowerCase().includes(searchTerm.toLowerCase()) || 
                         (log.details?.toLowerCase().includes(searchTerm.toLowerCase()) ?? false);
    return matchesFilter && matchesSearch;
  });

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
          />
          
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            className="relative w-full max-w-2xl h-[600px] bg-white rounded-3xl shadow-2xl overflow-hidden flex flex-col"
          >
            {/* Header */}
            <div className="p-6 border-b border-slate-100 flex items-center justify-between bg-white">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-slate-900 rounded-xl text-white">
                  <Terminal size={20} />
                </div>
                <div>
                  <h2 className="text-lg font-bold text-slate-800">系统运行日志</h2>
                  <p className="text-xs text-slate-400 font-medium uppercase tracking-widest">Real-time behavior tracking</p>
                </div>
              </div>
              <button 
                onClick={onClose}
                className="p-2 hover:bg-slate-100 rounded-xl transition-colors text-slate-400"
              >
                <X size={20} />
              </button>
            </div>

            {/* Filters */}
            <div className="p-4 bg-slate-50 flex flex-wrap gap-3 items-center border-b border-slate-100">
              <div className="flex bg-white p-1 rounded-xl border border-slate-200 shadow-sm">
                {[
                  { id: 'all', label: '全部', icon: Filter },
                  { id: 'reply', label: '回复日志', icon: MessageSquare },
                  { id: 'token', label: 'Token 调用', icon: Zap },
                ].map((item) => (
                  <button
                    key={item.id}
                    onClick={() => setFilter(item.id as any)}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                      filter === item.id 
                        ? 'bg-slate-900 text-white shadow-md' 
                        : 'text-slate-500 hover:text-slate-700'
                    }`}
                  >
                    <item.icon size={14} />
                    {item.label}
                  </button>
                ))}
              </div>

              <div className="flex-1 relative min-w-[200px]">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input 
                  type="text" 
                  placeholder="搜索日志内容..." 
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full pl-9 pr-4 py-2 bg-white border border-slate-200 rounded-xl text-xs focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all outline-none"
                />
              </div>
            </div>

            {/* Log Content */}
            <div className="flex-1 overflow-y-auto p-4 space-y-2 bg-slate-900 font-mono text-xs">
              {filteredLogs.length > 0 ? (
                filteredLogs.map((log) => (
                  <div key={log.id} className="p-3 rounded-lg bg-slate-800/50 border border-slate-700/50 hover:bg-slate-800 transition-colors group">
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-2">
                        <span className="text-slate-500 text-[10px]">{log.timestamp}</span>
                        <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${
                          log.type === 'reply' ? 'bg-blue-500/20 text-blue-400' :
                          log.type === 'token' ? 'bg-amber-500/20 text-amber-400' :
                          'bg-slate-500/20 text-slate-400'
                        }`}>
                          {log.type}
                        </span>
                      </div>
                      {log.tokens && (
                        <span className="text-amber-400 font-bold">{log.tokens} tokens</span>
                      )}
                    </div>
                    <div className="text-slate-200 leading-relaxed">{log.message}</div>
                    {log.details && (
                      <div className="mt-1.5 pt-1.5 border-t border-slate-700/30 text-slate-500 italic">
                        {log.details}
                      </div>
                    )}
                  </div>
                ))
              ) : (
                <div className="h-full flex flex-col items-center justify-center space-y-2 py-20">
                  <Terminal size={32} className="text-slate-700" />
                  <p className="text-slate-500">未找到匹配的日志</p>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="p-4 border-t border-slate-100 bg-slate-50 flex items-center justify-between text-[10px] font-bold text-slate-400 uppercase tracking-widest">
              <span>Streaming active logs</span>
              <div className="flex items-center gap-1.5">
                <div className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse" />
                Live
              </div>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
