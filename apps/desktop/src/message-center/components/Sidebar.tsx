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
} from 'lucide-react';
import type { Conversation, Shop } from '../types';
import CustomerAvatar from './CustomerAvatar';

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
  lang
}: SidebarProps) {
  const [isShopDropdownOpen, setIsShopDropdownOpen] = useState(false);
  const [shopFilterText, setShopFilterText] = useState('');
  const [contextMenu, setContextMenu] = useState<{ conversationId: string; x: number; y: number } | null>(null);

  const filteredShops = shops.filter(s =>
    s.name.toLowerCase().includes(shopFilterText.toLowerCase())
      || s.platformName?.toLowerCase().includes(shopFilterText.toLowerCase())
  );

  const currentShop = shops.find(s => s.id === selectedShop);
  const shopLabel = (shop: Shop) => (
    shop.platformName ? `${shop.platformName} | ${shop.name}` : shop.name
  );
  const currentShopName = currentShop ? shopLabel(currentShop) : '全部门店';

  const t = {
    zh: {
      title: '消息中心',
      emptyTitle: '请导入对应窗口',
      emptySub: '点击下方或右上角加号，导入并开始接管桌面端客服会话消息',
      searchPlaceholder: '搜索回复、用户...',
      allMsg: '全部消息',
      pendingMsg: '待处理',
      searchEmptyTitle: '未找到匹配的会话',
      searchEmptySub: '请尝试搜索其他客户、消息、门店或平台',
    },
    en: {
      title: 'Messages',
      emptyTitle: 'Please Import Windows',
      emptySub: 'Click below or top-right plus icon to import active desktop customer service sessions',
      searchPlaceholder: 'Search replies, users...',
      allMsg: 'All Messages',
      pendingMsg: 'Pending',
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
          <button 
            onClick={() => setIsShopDropdownOpen(!isShopDropdownOpen)}
            className="w-full flex items-center justify-between px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs font-bold text-slate-700 hover:border-brand-active transition-all"
            id="shop-selector-btn"
          >
            <span className="min-w-0 truncate" title={currentShopName}>{currentShopName}</span>
            <ChevronDown size={14} className={`transition-transform ${isShopDropdownOpen ? 'rotate-180' : ''}`} />
          </button>
          
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
        {isLoading ? (
          <div className="py-16 text-center text-xs font-semibold text-slate-400">正在从服务端加载会话...</div>
        ) : error && conversations.length === 0 ? (
          <div className="m-3 p-4 rounded-xl bg-rose-50 border border-rose-100 text-xs font-semibold text-rose-600 leading-relaxed">{error}</div>
        ) : conversations.length > 0 ? conversations.map((conv) => (
          <motion.button
            key={conv.id}
            onClick={() => onSelect(conv.id)}
            onContextMenu={(event) => {
              if (!conv.humanRequired) return;
              event.preventDefault();
              setContextMenu({ conversationId: conv.id, x: event.clientX, y: event.clientY });
            }}
            className={`w-full flex items-start gap-3 p-4 rounded-2xl transition-all text-left ${
              selectedId === conv.id 
                ? 'bg-sky-50 shadow-sm border border-sky-100' 
                : 'hover:bg-slate-50 border border-transparent'
            }`}
          >
            <CustomerAvatar name={conv.userName} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2 truncate">
                  <span className="font-bold text-slate-800 truncate text-[15px]">{conv.userName}</span>
                  <span
                    className="min-w-0 max-w-[142px] truncate px-1.5 py-0.5 bg-slate-100 text-slate-500 rounded text-[10px] font-bold"
                    title={`${conv.platformName} | ${conv.shopName}`}
                  >
                    {conv.platformName} | {conv.shopName}
                  </span>
                </div>
                <span className="text-[11px] text-slate-400 font-medium whitespace-nowrap ml-1">{conv.time}</span>
              </div>
              <p className="text-sm text-slate-500 truncate leading-relaxed">
                {conv.lastMessage}
              </p>
              {conv.humanRequired && (
                <span
                  className="mt-2 inline-flex items-center rounded-md bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-700 ring-1 ring-inset ring-amber-200"
                  title={conv.humanRequiredWord ? `命中敏感词：${conv.humanRequiredWord}` : '该会话等待人工处理'}
                >
                  待人工处理
                </span>
              )}
            </div>
            {conv.awaitingReply && (
              <div className="w-2 h-2 rounded-full bg-brand-active mt-3 flex-shrink-0 shadow-[0_0_8px_rgba(14,165,233,0.5)]" />
            )}
          </motion.button>
        )) : searchTerm.trim() ? (
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
          </div>
        </>
      )}
    </div>
  );
}
