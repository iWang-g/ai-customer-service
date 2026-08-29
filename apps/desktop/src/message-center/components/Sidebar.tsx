/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from 'react';
import { motion } from 'framer-motion';
import { 
  Search,
  Plus,
  ChevronDown,
  X,
  Trash2,
  Settings,
} from 'lucide-react';
import type { Conversation, Shop } from '../types';
import CustomerAvatar from './CustomerAvatar';
import ConversationResetModal from './ConversationResetModal';

function normalizeHexColor(value?: string): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  const shortMatch = trimmed.match(/^#([0-9a-f]{3})$/i);
  if (shortMatch) {
    return `#${shortMatch[1].split('').map((char) => `${char}${char}`).join('')}`;
  }
  return /^#[0-9a-f]{6}$/i.test(trimmed) ? trimmed : null;
}

function hexToRgba(hex: string, alpha: number): string {
  const normalized = normalizeHexColor(hex);
  if (!normalized) return `rgba(71, 85, 105, ${alpha})`;
  const value = normalized.slice(1);
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

interface SidebarProps {
  conversations: Conversation[];
  isLoading: boolean;
  error: string;
  selectedId: string;
  onSelect: (id: string) => void;
  selectedCategory: 'all' | 'pending';
  onCategorySelect: (cat: 'all' | 'pending') => void;
  selectedShop: string;
  shops: Shop[];
  onShopSelect: (id: string) => void;
  searchTerm: string;
  onSearchTermChange: (value: string) => void;
  onOpenImportModal: () => void;
  onClearHumanRequired: (conversationId: string) => Promise<void>;
  onClearConversationHistory: (conversationId: string) => Promise<void>;
  onDeleteConversation: (conversationId: string) => Promise<void>;
  shopNameColors: Record<string, string>;
  onShopNameColorsChange: (colors: Record<string, string>) => void;
  lang: 'zh' | 'en';
}

export default function Sidebar({ 
  conversations, 
  isLoading,
  error,
  selectedId, 
  onSelect,
  selectedCategory,
  onCategorySelect,
  selectedShop,
  shops,
  onShopSelect,
  searchTerm,
  onSearchTermChange,
  onOpenImportModal,
  onClearHumanRequired,
  onClearConversationHistory,
  onDeleteConversation,
  shopNameColors,
  onShopNameColorsChange,
  lang
}: SidebarProps) {
  const [isShopDropdownOpen, setIsShopDropdownOpen] = useState(false);
  const [isShopSettingsOpen, setIsShopSettingsOpen] = useState(false);
  const [shopFilterText, setShopFilterText] = useState('');
  const [contextMenu, setContextMenu] = useState<{ conversationId: string; x: number; y: number } | null>(null);
  const [resetConversation, setResetConversation] = useState<Conversation | null>(null);
  const [conversationAction, setConversationAction] = useState<'clear' | 'delete'>('clear');

  const filteredShops = shops.filter(s =>
    s.name.toLowerCase().includes(shopFilterText.toLowerCase())
      || s.platformName?.toLowerCase().includes(shopFilterText.toLowerCase())
  );

  const currentShop = shops.find(s => s.id === selectedShop);
  const shopLabel = (shop: Shop) => (
    shop.platformName ? `${shop.platformName} | ${shop.name}` : shop.name
  );
  const currentShopName = currentShop ? shopLabel(currentShop) : '全部门店';

  const colorOptions = ['#475569', '#2563eb', '#0891b2', '#059669', '#7c3aed', '#c2410c', '#be123c'];

  const t = {
    zh: {
      title: '消息中心',
      emptyTitle: '请导入最近会话消息',
      emptySub: '点击下方或右上角加号，从已登录的拼多多店铺读取最近会话消息',
      searchPlaceholder: '搜索回复、用户...',
      allMsg: '全部消息',
      pendingMsg: '待回复',
      searchEmptyTitle: '未找到匹配的会话',
      searchEmptySub: '请尝试搜索其他客户、消息、门店或平台',
    },
    en: {
      title: 'Messages',
      emptyTitle: 'Import Recent Messages',
      emptySub: 'Click below or the top-right plus icon to read recent messages from a logged-in Pinduoduo shop',
      searchPlaceholder: 'Search replies, users...',
      allMsg: 'All Messages',
      pendingMsg: 'Awaiting Reply',
      searchEmptyTitle: 'No matching conversations',
      searchEmptySub: 'Try another customer, message, shop, or platform',
    }
  }[lang];

  return (
    <div className="flex-1 h-full flex flex-col bg-white overflow-hidden" id="sidebar-main">
      {/* Header */}
      <div className="p-4 flex items-center justify-between pb-0">
        <h1 className="text-xl font-bold tracking-tight text-slate-800">{t.title}</h1>
        <button 
          onClick={onOpenImportModal}
          className="p-2 hover:bg-slate-100 rounded-lg transition-colors overflow-hidden border border-slate-100 hover:border-slate-200" 
          id="new-chat-btn"
        >
          <Plus size={20} className="text-slate-600" />
        </button>
      </div>

      {/* Category Tabs */}
      <div className="px-4 flex border-b border-slate-100" id="category-tabs">
        <button 
          onClick={() => onCategorySelect('all')}
          className={`flex-1 py-3 text-[10px] font-bold uppercase tracking-widest transition-all relative ${
            selectedCategory === 'all' ? 'text-brand-active' : 'text-slate-400 hover:text-slate-600'
          }`}
        >
          {t.allMsg}
          {selectedCategory === 'all' && (
            <motion.div layoutId="tab-underline" className="absolute bottom-0 left-0 right-0 h-0.5 bg-brand-active" />
          )}
        </button>
        <button 
          onClick={() => onCategorySelect('pending')}
          className={`flex-1 py-3 text-[10px] font-bold uppercase tracking-widest transition-all relative ${
            selectedCategory === 'pending' ? 'text-brand-active' : 'text-slate-400 hover:text-slate-600'
          }`}
        >
          {t.pendingMsg}
          {selectedCategory === 'pending' && (
            <motion.div layoutId="tab-underline" className="absolute bottom-0 left-0 right-0 h-0.5 bg-brand-active" />
          )}
        </button>
      </div>

      {/* Filters Area */}
      <div className="p-4 space-y-3 bg-slate-50/50">
        {/* Shop Selector */}
        <div className="relative">
          <div className="flex gap-2">
            <button
              onClick={() => setIsShopDropdownOpen(!isShopDropdownOpen)}
              className="min-w-0 flex-1 flex items-center justify-between px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs font-bold text-slate-700 hover:border-brand-active transition-all"
              id="shop-selector-btn"
            >
              <span className="min-w-0 truncate" title={currentShopName}>{currentShopName}</span>
              <ChevronDown size={14} className={`shrink-0 transition-transform ${isShopDropdownOpen ? 'rotate-180' : ''}`} />
            </button>
            <button
              type="button"
              onClick={() => setIsShopSettingsOpen(true)}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-500 transition-colors hover:border-brand-active hover:text-brand-active"
              title="店铺会话背景颜色"
              aria-label="店铺会话背景颜色设置"
            >
              <Settings size={15} />
            </button>
          </div>
          
          {isShopDropdownOpen && (
            <>
              <div className="fixed inset-0 z-20" onClick={() => setIsShopDropdownOpen(false)}></div>
              <div className="absolute top-full left-0 right-0 mt-2 bg-white border border-slate-200 rounded-xl shadow-xl z-30 overflow-hidden min-w-[200px]">
                <div className="p-2 border-b border-slate-100">
                  <input 
                    type="text" 
                    placeholder="搜索门店..."
                    autoFocus
                    value={shopFilterText}
                    onChange={(e) => setShopFilterText(e.target.value)}
                    className="w-full px-3 py-1.5 bg-slate-50 border-none text-xs focus:ring-1 focus:ring-brand-active/20 rounded-lg"
                  />
                </div>
                <div className="max-h-48 overflow-y-auto">
                  {filteredShops.map(shop => (
                    <button
                      key={shop.id}
                      onClick={() => {
                        onShopSelect(shop.id);
                        setIsShopDropdownOpen(false);
                      }}
                      className={`w-full text-left px-4 py-2.5 text-xs font-medium hover:bg-slate-50 transition-colors ${
                        selectedShop === shop.id ? 'text-brand-active bg-sky-50/50' : 'text-slate-600'
                      }`}
                    >
                      <span className="block truncate" title={shopLabel(shop)}>{shopLabel(shop)}</span>
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>

        {/* Search */}
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input 
            type="text" 
            value={searchTerm}
            onChange={(event) => onSearchTermChange(event.target.value)}
            placeholder={t.searchPlaceholder}
            aria-label={t.searchPlaceholder}
            className="w-full pl-9 pr-9 py-2 bg-white border border-slate-200 rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-brand-active/20 focus:border-brand-active transition-all"
          />
          {searchTerm && (
            <button
              type="button"
              onClick={() => onSearchTermChange('')}
              aria-label={lang === 'zh' ? '清除会话搜索' : 'Clear conversation search'}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            >
              <X size={13} />
            </button>
          )}
        </div>
      </div>

      {/* Conversation List */}
      <div className="flex-1 overflow-y-auto px-2 space-y-1 pt-2" id="conversation-list">
        {isLoading && conversations.length === 0 ? (
          <div className="py-16 text-center text-xs font-semibold text-slate-400">正在从服务端加载会话...</div>
        ) : error && conversations.length === 0 ? (
          <div className="m-3 p-4 rounded-xl bg-rose-50 border border-rose-100 text-xs font-semibold text-rose-600 leading-relaxed">{error}</div>
        ) : conversations.length > 0 ? conversations.map((conv) => {
          const isSelected = selectedId === conv.id;
          const shopConversationColor = normalizeHexColor(shopNameColors[conv.shopId]);
          const conversationTintStyle = shopConversationColor && !isSelected
            ? {
                backgroundImage: `radial-gradient(circle at center, ${hexToRgba(shopConversationColor, 0.08)} 0%, ${hexToRgba(shopConversationColor, 0.04)} 48%, rgba(255, 255, 255, 0) 82%)`,
                borderColor: 'transparent',
              }
            : undefined;
          return (
            <motion.button
              key={conv.id}
              onClick={() => onSelect(conv.id)}
              onContextMenu={(event) => {
                if (!conv.humanRequired && conv.platform !== 'pinduoduo') return;
                event.preventDefault();
                setContextMenu({ conversationId: conv.id, x: event.clientX, y: event.clientY });
              }}
              className={`relative w-full overflow-hidden flex items-start gap-3 p-4 rounded-2xl border transition-all text-left ${
                isSelected
                  ? 'bg-sky-50 shadow-sm border-sky-100'
                  : 'border-transparent hover:bg-slate-50'
              }`}
              style={conversationTintStyle}
            >
              <CustomerAvatar name={conv.userName} src={conv.avatarUrl} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2 truncate">
                    <span className="font-bold text-slate-800 truncate text-[15px]">{conv.userName}</span>
                    <span
                      className="min-w-0 max-w-[142px] truncate px-1.5 py-0.5 bg-white/65 rounded text-[10px] font-bold text-slate-500"
                      title={`${conv.platformName} | ${conv.shopName}`}
                    >
                      <span>{conv.platformName} | </span>
                      <span>{conv.shopName}</span>
                    </span>
                  </div>
                  <span className="text-[11px] text-slate-400 font-medium whitespace-nowrap ml-1">{conv.time}</span>
                </div>
                <p className="text-sm text-slate-500 truncate leading-relaxed">
                  {conv.lastMessage}
                </p>
                {conv.humanRequired && (
                  <span
                    className="mt-2 inline-flex items-center rounded-md bg-sky-50 px-2 py-0.5 text-[10px] font-bold text-green-600 ring-1 ring-inset ring-sky-200"
                    title={conv.humanRequiredWord ? `命中敏感词：${conv.humanRequiredWord}` : '该会话等待人工处理'}
                  >
                    待人工处理
                  </span>
                )}
              </div>
              {conv.awaitingReply && (
                <div
                  className="w-2 h-2 rounded-full bg-brand-active mt-3 flex-shrink-0 shadow-[0_0_8px_rgba(14,165,233,0.5)]"
                  title={lang === 'zh' ? '客户消息待回复' : 'Customer message awaiting reply'}
                  aria-label={lang === 'zh' ? '客户消息待回复' : 'Customer message awaiting reply'}
                />
              )}
            </motion.button>
          );
        }) : searchTerm.trim() ? (
          <div className="flex-1 px-6 py-16 text-center" id="sidebar-search-empty-state">
            <Search size={28} className="mx-auto text-slate-300" />
            <h3 className="mt-4 text-[15px] font-bold text-slate-700">{t.searchEmptyTitle}</h3>
            <p className="mt-2 text-[11px] font-medium leading-relaxed text-slate-400">
              {t.searchEmptySub}
            </p>
          </div>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center py-16 px-6 text-center" id="sidebar-empty-state">
            <motion.button
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={onOpenImportModal}
              className="w-16 h-16 bg-sky-500 hover:bg-sky-600 text-white rounded-2xl flex items-center justify-center shadow-lg shadow-sky-500/25 transition-colors mb-4 relative group"
              id="empty-import-plus-btn"
            >
              <Plus size={28} strokeWidth={2.5} />
              <div className="absolute inset-0 rounded-2xl bg-sky-500 animate-ping opacity-20 pointer-events-none group-hover:hidden" />
            </motion.button>
            <h3 className="text-[15px] font-bold text-slate-700">{t.emptyTitle}</h3>
            <p className="text-[11px] text-slate-400 mt-2 leading-relaxed font-medium">
              {t.emptySub}
            </p>
          </div>
        )}
      </div>
      {contextMenu && (
        <>
          <button type="button" aria-label="关闭会话菜单" className="fixed inset-0 z-40 cursor-default" onClick={() => setContextMenu(null)} />
          <div
            className="fixed z-50 min-w-44 rounded-xl border border-slate-200 bg-white p-1.5 shadow-xl"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            {conversations.find((item) => item.id === contextMenu.conversationId)?.humanRequired && (
              <button
                type="button"
                onClick={() => {
                  const conversationId = contextMenu.conversationId;
                  setContextMenu(null);
                  void onClearHumanRequired(conversationId);
                }}
                className="w-full rounded-lg px-3 py-2 text-left text-xs font-bold text-slate-700 hover:bg-slate-50"
              >
                清除“待人工处理”标记
              </button>
            )}
            {conversations.find((item) => item.id === contextMenu.conversationId)?.platform === 'pinduoduo' && (
              <button
                type="button"
                onClick={() => {
                  const conversation = conversations.find(
                    (item) => item.id === contextMenu.conversationId,
                  ) || null;
                  setContextMenu(null);
                  setConversationAction('clear');
                  setResetConversation(conversation);
                }}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-bold text-rose-600 hover:bg-rose-50"
              >
                <Trash2 size={14} />
                清空聊天记录…
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                const conversation = conversations.find(
                  (item) => item.id === contextMenu.conversationId,
                ) || null;
                setContextMenu(null);
                setConversationAction('delete');
                setResetConversation(conversation);
              }}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-bold text-rose-700 hover:bg-rose-50"
            >
              <Trash2 size={14} />
              删除会话…
            </button>
          </div>
        </>
      )}
      <ConversationResetModal
        conversation={resetConversation}
        mode={conversationAction}
        onClose={() => setResetConversation(null)}
        onConfirm={conversationAction === 'delete' ? onDeleteConversation : onClearConversationHistory}
      />
      {isShopSettingsOpen && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-900/30 p-4">
          <div className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
              <div>
                <h2 className="text-sm font-bold text-slate-800">店铺会话背景颜色</h2>
                <p className="mt-1 text-[11px] text-slate-400">用于区分不同店铺的会话项背景，设置会保存在本机。</p>
              </div>
              <button
                type="button"
                onClick={() => setIsShopSettingsOpen(false)}
                className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                aria-label="关闭店铺会话背景颜色设置"
              >
                <X size={16} />
              </button>
            </div>
            <div className="max-h-[60vh] overflow-y-auto p-4">
              {shops.filter((shop) => shop.id !== 'all').map((shop) => {
                const configuredColor = normalizeHexColor(shopNameColors[shop.id]);
                const currentColor = configuredColor || '#475569';
                return (
                  <div key={shop.id} className="flex items-center gap-3 border-b border-slate-100 py-3 last:border-b-0">
                    {shop.logoUrl ? (
                      <img src={shop.logoUrl} alt="" className="h-8 w-8 shrink-0 rounded-full object-cover" referrerPolicy="no-referrer" />
                    ) : (
                      <div className="h-8 w-8 shrink-0 rounded-full bg-slate-100" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-bold text-slate-700">{shopLabel(shop)}</p>
                      <div
                        className="mt-1 h-5 rounded-md border px-2 text-[10px] font-medium leading-5 text-slate-500"
                        style={configuredColor
                          ? {
                              backgroundImage: `radial-gradient(circle at center, ${hexToRgba(configuredColor, 0.08)} 0%, ${hexToRgba(configuredColor, 0.04)} 48%, rgba(255, 255, 255, 0) 82%)`,
                              borderColor: 'transparent',
                            }
                          : undefined}
                      >
                        {configuredColor ? '会话背景预览' : '默认样式'}
                      </div>
                      <div className="mt-2 flex items-center gap-1.5">
                        {colorOptions.map((color) => (
                          <button
                            key={color}
                            type="button"
                            onClick={() => onShopNameColorsChange({ ...shopNameColors, [shop.id]: color })}
                            className={`h-5 w-5 rounded-full border ${configuredColor === color ? 'border-slate-900 ring-2 ring-slate-200' : 'border-white'}`}
                            style={{ backgroundColor: color }}
                            aria-label={`选择颜色 ${color}`}
                            title={color}
                          />
                        ))}
                      </div>
                    </div>
                    <input
                      type="color"
                      value={currentColor}
                      onChange={(event) => onShopNameColorsChange({ ...shopNameColors, [shop.id]: event.target.value })}
                      className="h-8 w-8 shrink-0 rounded border border-slate-200 bg-white p-1"
                      aria-label={`${shop.name} 自定义颜色`}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const next = { ...shopNameColors };
                        delete next[shop.id];
                        onShopNameColorsChange(next);
                      }}
                      className="shrink-0 rounded-lg px-2 py-1 text-[11px] font-semibold text-slate-400 hover:bg-slate-50 hover:text-slate-600"
                    >
                      默认
                    </button>
                  </div>
                );
              })}
              {shops.filter((shop) => shop.id !== 'all').length === 0 && (
                <div className="py-10 text-center text-xs font-semibold text-slate-400">暂无可设置的店铺</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
