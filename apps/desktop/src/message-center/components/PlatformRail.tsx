/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { AnimatePresence, motion } from 'framer-motion';
import { 
  MessagesSquare, 
  Store,
  Video,
  Play,
  ShoppingBag,
  Heart,
  MessageCircle,
  LayoutDashboard,
  Settings,
  LogOut
} from 'lucide-react';
import { useState } from 'react';
import customerServiceAvatar from '../../shared/assets/customer-service-avatar.svg';
import DevelopmentNotice from './DevelopmentNotice';

interface PlatformRailProps {
  selectedPlatform: string;
  onPlatformSelect: (id: string) => void;
  onOpenAdmin: () => void;
  onLogout: () => void;
  userName: string;
  userId: string;
  userRole: string;
  lang: 'zh' | 'en';
}

const platformIcons: Record<string, any> = {
  all: MessagesSquare,
  qianniu: Store,
  pinduoduo: ShoppingBag,
  personal_wechat: MessageCircle,
  qq: MessagesSquare,
  douyin: Video,
  kuaishou: Play,
  xiaohongshu: Heart,
};

const platformThemes: Record<string, { bg: string, text: string, shadow: string, glow: string }> = {
  all: { bg: 'bg-indigo-600', text: 'text-white', shadow: 'shadow-indigo-500/40', glow: 'bg-indigo-500' },
  qianniu: { bg: 'bg-blue-500', text: 'text-white', shadow: 'shadow-blue-500/40', glow: 'bg-blue-400' },
  pinduoduo: { bg: 'bg-rose-600', text: 'text-white', shadow: 'shadow-rose-600/40', glow: 'bg-rose-500' },
  personal_wechat: { bg: 'bg-emerald-500', text: 'text-white', shadow: 'shadow-emerald-500/40', glow: 'bg-emerald-400' },
  qq: { bg: 'bg-sky-500', text: 'text-white', shadow: 'shadow-sky-500/40', glow: 'bg-sky-400' },
  douyin: { bg: 'bg-slate-900', text: 'text-white', shadow: 'shadow-slate-400/30', glow: 'bg-slate-400' },
  kuaishou: { bg: 'bg-orange-500', text: 'text-white', shadow: 'shadow-orange-500/40', glow: 'bg-orange-400' },
  xiaohongshu: { bg: 'bg-red-500', text: 'text-white', shadow: 'shadow-red-500/40', glow: 'bg-red-400' },
};

const railPlatforms = [
  { id: 'all', name: '全部' },
  { id: 'qianniu', name: '千牛' },
  { id: 'pinduoduo', name: '拼多多' },
  { id: 'personal_wechat', name: '个人微信' },
  { id: 'qq', name: 'QQ' },
  { id: 'douyin', name: '抖音' },
  { id: 'kuaishou', name: '快手' },
  { id: 'xiaohongshu', name: '小红书' },
];

export default function PlatformRail({ selectedPlatform, onPlatformSelect, onOpenAdmin, onLogout, userName, userId, userRole, lang }: PlatformRailProps) {
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [developmentNoticeTrigger, setDevelopmentNoticeTrigger] = useState(0);

  const t = {
    zh: {
      settings: '设置助手',
      admin: '管理后台',
      profile: '管理员账号',
      logout: '退出登录',
    },
    en: {
      settings: 'Settings Help',
      admin: 'Admin Console',
      profile: 'Administrator',
      logout: 'Log Out',
    }
  }[lang];

  return (
    <div className="w-18 h-full flex flex-col items-center py-6 bg-white border-r border-slate-200 gap-6" id="platform-rail">
      {/* Top Icons */}
      <div className="flex-1 flex flex-col items-center gap-4 w-full">
        {railPlatforms.map((p) => {
          const Icon = platformIcons[p.id] || MessagesSquare;
          const isActive = selectedPlatform === p.id;
          const theme = platformThemes[p.id] || platformThemes.all;
          
          return (
            <button
              key={p.id}
              onClick={() => onPlatformSelect(p.id)}
              onContextMenu={(event) => {
                if (p.id !== 'pinduoduo') return;
                event.preventDefault();
                void window.desktopBridge
                  ?.showPlatformContextMenu({ platformCode: 'pinduoduo', userId })
                  .catch((error) => console.error('打开拼多多工作区菜单失败:', error));
              }}
              className={`group relative flex flex-col items-center gap-1.5 transition-all focus:outline-none w-full`}
              id={`rail-platform-${p.id}`}
            >
              <div className={`w-12 h-12 rounded-2xl flex items-center justify-center transition-all duration-300 relative overflow-visible ${
                isActive 
                  ? `${theme.bg} ${theme.text} scale-110 ${theme.shadow} shadow-2xl` 
                  : 'bg-transparent text-slate-400 hover:text-slate-600 hover:bg-slate-50'
              }`}>
                <Icon 
                  size={isActive ? (p.id === 'all' ? 26 : 24) : (p.id === 'all' ? 24 : 22)} 
                  strokeWidth={isActive ? 2.5 : 2} 
                />
                
                {isActive && (
                  <motion.div 
                    layoutId="rail-glow"
                    className={`absolute inset-0 rounded-2xl -z-10 blur-xl opacity-40 ${theme.glow}`}
                  />
                )}
              </div>
              
              <span className={`text-[10px] font-bold uppercase tracking-widest transition-colors ${
                isActive ? 'text-slate-800' : 'text-slate-400 group-hover:text-slate-600'
              }`}>
                {p.name}
              </span>

              {/* Active Side Indicator */}
              {isActive && (
                <motion.div 
                  layoutId="rail-active-indicator" 
                  className={`absolute left-0 w-1.5 h-10 ${theme.bg} rounded-r-full shadow-[2px_0_10px_rgba(0,0,0,0.1)]`}
                />
              )}
              
              {/* Tooltip */}
              <div className="absolute left-full ml-4 px-2.5 py-1.5 bg-slate-900 text-white text-[10px] rounded-lg opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-50 transition-all font-bold uppercase tracking-wider shadow-2xl translate-x-[-4px] group-hover:translate-x-0">
                 {p.name}
              </div>
            </button>
          );
        })}
      </div>

      {/* Bottom User Profile */}
      <div className="flex flex-col items-center gap-4 pb-2 w-full relative" id="rail-bottom-actions">
        <button
          type="button"
          onClick={onOpenAdmin}
          className="p-2.5 text-indigo-500 hover:text-indigo-700 hover:bg-indigo-50 rounded-xl transition-all group relative"
          id="open-admin-btn"
          aria-label={t.admin}
        >
          <LayoutDashboard size={20} />
          <div className="absolute left-full ml-4 px-2.5 py-1.5 bg-slate-900 text-white text-[10px] rounded-lg opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-50 transition-all font-bold uppercase tracking-wider shadow-2xl translate-x-[-4px] group-hover:translate-x-0">
            {t.admin}
          </div>
        </button>

        <button
          type="button"
          onClick={() => setDevelopmentNoticeTrigger((current) => current + 1)}
          className="p-2.5 text-slate-400 hover:text-slate-600 hover:bg-slate-50 rounded-xl transition-all group relative"
          id="assistant-settings-btn"
          aria-label={t.settings}
        >
          <Settings size={20} />
          <div className="absolute left-full ml-4 px-2.5 py-1.5 bg-slate-900 text-white text-[10px] rounded-lg opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-50 transition-all font-bold uppercase tracking-wider shadow-2xl translate-x-[-4px] group-hover:translate-x-0">
            {t.settings}
          </div>
        </button>

        <div className="h-px w-8 bg-slate-100" />
        
        <div className="relative">
          <button 
            onClick={() => setIsProfileOpen(!isProfileOpen)}
            className="group relative focus:outline-none flex items-center justify-center"
          >
            <div className="w-10 h-10 rounded-2xl bg-slate-50 border border-slate-200 flex items-center justify-center text-slate-500 hover:border-brand-active hover:text-brand-active transition-all overflow-hidden relative shadow-sm">
              <img 
                src={customerServiceAvatar}
                alt="Admin" 
                className="w-full h-full object-cover"
              />
              {/* Status Indicator */}
              <div className="absolute bottom-0 right-0 w-3 h-3 bg-green-500 border-2 border-white rounded-full" />
            </div>
          </button>

          {/* Profile Dropdown */}
          <AnimatePresence>
            {isProfileOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setIsProfileOpen(false)} />
                <motion.div
                  initial={{ opacity: 0, scale: 0.95, x: -10 }}
                  animate={{ opacity: 1, scale: 1, x: 0 }}
                  exit={{ opacity: 0, scale: 0.95, x: -10 }}
                  className="absolute bottom-0 left-14 bg-white border border-slate-200 rounded-2xl shadow-2xl z-50 p-4 min-w-[200px]"
                  id="profile-dropdown-menu"
                >
                  <div className="text-xs font-bold text-slate-800">{userName}</div>
                  <div className="text-[10px] text-slate-400 font-semibold truncate mb-3">{userRole === 'admin' ? t.profile : '客服账号'}</div>
                  
                  <div className="h-px bg-slate-100 my-2" />
                  
                  <button
                    onClick={() => {
                      setIsProfileOpen(false);
                      onLogout();
                    }}
                    className="w-full flex items-center gap-2.5 px-3 py-2 bg-rose-50 hover:bg-rose-100 text-rose-600 rounded-xl text-xs font-bold transition-all text-left"
                    id="rail-logout-btn"
                  >
                    <LogOut size={14} />
                    <span>{t.logout}</span>
                  </button>
                </motion.div>
              </>
            )}
          </AnimatePresence>
        </div>
      </div>
      <DevelopmentNotice
        trigger={developmentNoticeTrigger}
        message={lang === 'zh' ? '设置助手功能开发中' : 'Assistant settings are under development'}
      />
    </div>
  );
}
