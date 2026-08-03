/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { motion } from 'framer-motion';
import { 
  Zap, 
  Activity, 
  Clock, 
  Cpu, 
  ShieldCheck, 
  AlertCircle,
  Terminal,
  ChevronRight
} from 'lucide-react';
import { BotStatus } from '../types';

interface StatusPanelProps {
  bot: BotStatus;
  onViewLogs: () => void;
  connectionStatus: 'connecting' | 'connected' | 'disconnected';
}

export default function StatusPanel({ bot, onViewLogs, connectionStatus }: StatusPanelProps) {
  const connectionLabel = {
    connecting: '连接中',
    connected: '服务已连接',
    disconnected: '服务已断开',
  }[connectionStatus];
  return (
    <div className="w-80 h-full flex flex-col border-l border-brand-border bg-slate-50/50" id="status-panel">
      {/* Bot Identity */}
      <div className="p-6 text-center border-bottom border-brand-border bg-white" id="bot-profile">
        <div className="w-20 h-20 bg-slate-50 rounded-3xl shadow-sm border border-slate-100 flex items-center justify-center mx-auto mb-4 relative">
          <div className="absolute -top-1 -right-1 w-6 h-6 bg-green-500 border-4 border-white rounded-full"></div>
          <Zap size={40} className="text-brand-active" fill="currentColor" />
        </div>
        <h2 className="text-lg font-bold text-slate-800">{bot.name}</h2>
        <div className="flex items-center justify-center gap-1.5 mt-1">
          <Cpu size={12} className="text-slate-400" />
          <span className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">{bot.model}</span>
        </div>
      </div>

      {/* Metrics Grid */}
      <div className="p-6 space-y-6 overflow-y-auto" id="bot-metrics">
        <section>
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-2">
              <Activity size={12} />
              性能指标
            </h3>
            <span className="text-[10px] font-bold text-green-500 uppercase tracking-widest bg-green-50 px-1.5 py-0.5 rounded">Healthy</span>
          </div>
          
          <div className="grid grid-cols-2 gap-3">
            {[
              { label: '运行时间', value: bot.uptime, icon: Clock, color: 'text-blue-500' },
              { label: '请求处理', value: bot.requestsProcessed.toLocaleString(), icon: Zap, color: 'text-amber-500' },
              { label: '系统健康', value: `${bot.health}%`, icon: ShieldCheck, color: 'text-emerald-500' },
              { label: '响应速度', value: bot.avgResponseTime, icon: Zap, color: 'text-rose-500' },
            ].map((stat, i) => (
              <div key={i} className="p-3 bg-white border border-slate-100 rounded-2xl shadow-sm">
                <div className={`p-1.5 rounded-lg bg-slate-50 inline-block mb-2 ${stat.color}`}>
                  <stat.icon size={14} />
                </div>
                <div className="text-xs font-bold text-slate-800">{stat.value}</div>
                <div className="text-[10px] text-slate-400 font-medium">{stat.label}</div>
              </div>
            ))}
          </div>
        </section>

        {/* Quick Settings */}
        <section>
           <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-4 flex items-center gap-2">
            <Zap size={12} />
            快速操作
          </h3>
          <div className="space-y-2">
            <button className="w-full flex items-center justify-between p-3 bg-white border border-slate-100 rounded-xl hover:shadow-md transition-all group" id="switch-model-btn">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-indigo-50 rounded-lg text-indigo-500">
                  <Cpu size={16} />
                </div>
                <span className="text-sm font-semibold text-slate-700">切换模型</span>
              </div>
              <ChevronRight size={16} className="text-slate-300 group-hover:text-slate-500 transition-colors" />
            </button>
            <button 
              onClick={onViewLogs}
              className="w-full flex items-center justify-between p-3 bg-white border border-slate-100 rounded-xl hover:shadow-md transition-all group" 
              id="logs-btn"
            >
              <div className="flex items-center gap-3">
                <div className="p-2 bg-slate-100 rounded-lg text-slate-500">
                  <Terminal size={16} />
                </div>
                <span className="text-sm font-semibold text-slate-700">查看日志</span>
              </div>
              <ChevronRight size={16} className="text-slate-300 group-hover:text-slate-500 transition-colors" />
            </button>

            {/* Shutdown Button */}
            <button className="w-full flex items-center gap-3 p-3 bg-rose-50 border border-rose-100 rounded-xl hover:bg-rose-100 transition-all group mt-2" id="shutdown-bot-btn">
              <div className="p-2 bg-rose-500 rounded-lg text-white shadow-lg shadow-rose-200">
                <ShieldCheck size={16} />
              </div>
              <div className="text-left">
                <span className="block text-sm font-bold text-rose-700">关闭机器人</span>
                <span className="block text-[10px] text-rose-400 font-bold uppercase tracking-tight">Switch to Manual</span>
              </div>
            </button>
          </div>
        </section>

        {/* System Logs (Mini) */}
        <section className="flex-1">
          <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-4 flex items-center gap-2">
            <AlertCircle size={12} />
            最新事件
          </h3>
          <div className="space-y-4 bg-white/50 border border-slate-100/50 rounded-2xl p-4 font-mono text-[10px]">
             {[
               { time: '14:22:10', msg: 'Prompt optimizing...', type: 'info' },
               { time: '14:20:05', msg: 'Context window refreshed', type: 'success' },
               { time: '14:15:30', msg: 'Handled WeChat User #122', type: 'info' },
               { time: '14:10:12', msg: 'Model latency 1.4s detected', type: 'warning' },
             ].map((log, i) => (
               <div key={i} className="flex gap-2">
                 <span className="text-slate-400">{log.time}</span>
                 <span className={`${
                   log.type === 'info' ? 'text-blue-500' : 
                   log.type === 'success' ? 'text-green-500' : 
                   'text-amber-500'
                 }`}>{log.msg}</span>
               </div>
             ))}
          </div>
        </section>
      </div>
      
      {/* Footer Footer */}
      <div className="p-4 bg-white border-top border-brand-border">
         <div className="flex items-center justify-between px-2">
           <span className="text-[10px] text-slate-300 font-bold uppercase tracking-tighter">System Engine v4.0.2</span>
           <div className="flex items-center gap-1">
             <div className={`w-1.5 h-1.5 rounded-full ${connectionStatus === 'connected' ? 'bg-green-500 animate-pulse' : connectionStatus === 'connecting' ? 'bg-amber-500 animate-pulse' : 'bg-rose-500'}`}></div>
             <span className={`text-[10px] font-bold uppercase ${connectionStatus === 'connected' ? 'text-green-500' : connectionStatus === 'connecting' ? 'text-amber-500' : 'text-rose-500'}`}>{connectionLabel}</span>
           </div>
         </div>
      </div>
    </div>
  );
}
