/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertCircle, LoaderCircle, MonitorUp, RefreshCw, Search, ShoppingBag, X } from 'lucide-react';

interface ImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  candidates: PddImportCandidate[];
  isLoading: boolean;
  error: string;
  onRefresh: () => void;
  onImport: (candidate: PddImportCandidate) => Promise<void>;
  lang: 'zh' | 'en';
}

export default function ImportModal({
  isOpen,
  onClose,
  candidates,
  isLoading,
  error,
  onRefresh,
  onImport,
  lang,
}: ImportModalProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [importingId, setImportingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');

  const t = {
    zh: {
      title: '导入最近会话消息',
      subtitle: '从已登录的拼多多店铺读取最近会话消息',
      searchPlaceholder: '搜索客户名、店铺或消息预览...',
      importBtn: '导入消息',
      importingTitle: '正在读取聊天记录',
      importingSubtitle: '正在切换到目标店铺和客户会话，请稍候...',
      emptyTitle: '未检测到可导入会话',
      emptySubtitle: '请确认拼多多店铺已完成登录，并已进入客服接待页面。',
      loading: '正在扫描已添加店铺...',
      refresh: '重新扫描',
      retry: '扫描失败，请重试',
      imported: '已读取',
    },
    en: {
      title: 'Import Recent Messages',
      subtitle: 'Read recent conversation messages from logged-in Pinduoduo shops',
      searchPlaceholder: 'Search customer, shop, or preview...',
      importBtn: 'Import Messages',
      importingTitle: 'Reading conversation history',
      importingSubtitle: 'Switching to the target shop and customer session...',
      emptyTitle: 'No importable conversations found',
      emptySubtitle: 'Make sure a Pinduoduo shop is logged in and on the service page.',
      loading: 'Scanning added shops...',
      refresh: 'Scan again',
      retry: 'Scan failed. Try again.',
      imported: 'Read',
    },
  }[lang];

  const filteredCandidates = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    if (!term) return candidates;
    return candidates.filter((candidate) => [
      candidate.customerName,
      candidate.externalConversationId || '',
      candidate.conversationKey,
      candidate.shopName,
      candidate.platformName,
      candidate.previewText || '',
    ].some((value) => value.toLowerCase().includes(term)));
  }, [candidates, searchTerm]);

  const handleImport = async (candidate: PddImportCandidate) => {
    if (importingId) return;
    setImportingId(candidate.id);
    setActionError('');
    try {
      await onImport(candidate);
      onClose();
    } catch (importError) {
      setActionError(importError instanceof Error ? importError.message : t.retry);
    } finally {
      setImportingId(null);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6" id="import-modal-overlay">
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
            className="relative w-full max-w-lg bg-white rounded-3xl shadow-2xl overflow-hidden flex flex-col"
            id="import-modal-content"
          >
            <button
              type="button"
              onClick={onClose}
              className="absolute right-4 top-4 z-10 p-2 hover:bg-slate-100 rounded-xl transition-colors text-slate-400"
              id="close-import-modal-btn"
              aria-label="Close"
            >
              <X size={20} />
            </button>
            {importingId ? (
              <div className="p-10 flex flex-col items-center justify-center text-center min-h-[320px]">
                <LoaderCircle size={56} className="text-sky-500 animate-spin mb-6" />
                <h3 className="text-xl font-bold text-slate-800 tracking-tight">{t.importingTitle}</h3>
                <p className="text-xs text-slate-400 mt-2 font-medium max-w-xs">{t.importingSubtitle}</p>
              </div>
            ) : (
              <>
                <div className="p-6 border-b border-slate-100 flex items-center justify-between bg-white">
                  <div className="flex items-center gap-3">
                    <div className="p-2.5 bg-sky-50 text-sky-600 rounded-2xl"><MonitorUp size={22} /></div>
                    <div>
                      <h2 className="text-lg font-bold text-slate-800">{t.title}</h2>
                      <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">{t.subtitle}</p>
                    </div>
                  </div>
                  <div className="w-9 shrink-0" aria-hidden="true" />
                </div>
                <div className="p-4 bg-slate-50 border-b border-slate-100 flex gap-2">
                  <div className="relative flex-1">
                    <Search size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
                    <input
                      type="text"
                      placeholder={t.searchPlaceholder}
                      value={searchTerm}
                      onChange={(event) => setSearchTerm(event.target.value)}
                      className="w-full pl-10 pr-4 py-2.5 bg-white border border-slate-200 rounded-xl text-xs focus:ring-2 focus:ring-sky-500/20 focus:border-sky-500 transition-all outline-none"
                    />
                  </div>
                  <button onClick={onRefresh} disabled={isLoading} className="px-3 rounded-xl border border-slate-200 bg-white text-slate-500 hover:text-sky-600 disabled:opacity-50" title={t.refresh} aria-label={t.refresh}>
                    <RefreshCw size={16} className={isLoading ? 'animate-spin' : ''} />
                  </button>
                </div>
                {(error || actionError) && (
                  <div className="mx-4 mt-4 px-3 py-2 rounded-xl bg-red-50 text-red-600 text-xs flex items-center gap-2">
                    <AlertCircle size={14} />
                    <span>{error || actionError}</span>
                  </div>
                )}
                <div className="flex-1 max-h-[360px] overflow-y-auto p-4 space-y-2 bg-slate-50/50">
                  {isLoading && !candidates.length ? (
                    <div className="py-12 flex flex-col items-center justify-center text-center text-xs text-slate-400">
                      <LoaderCircle size={28} className="animate-spin text-sky-500 mb-3" />{t.loading}
                    </div>
                  ) : filteredCandidates.length ? (
                    filteredCandidates.map((candidate) => (
                      <div key={candidate.id} className="p-3 bg-white border border-slate-200/80 rounded-2xl transition-all flex items-center justify-between hover:border-sky-500 hover:shadow-md">
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="p-2.5 rounded-xl bg-sky-50 text-sky-500"><ShoppingBag size={18} /></div>
                          <div className="min-w-0">
                            <div className="text-xs font-bold text-slate-700 truncate">{candidate.platformName} - {candidate.shopName}</div>
                            <div className="text-[11px] text-slate-500 font-semibold mt-0.5 truncate">{candidate.customerName}</div>
                            <div className="text-[10px] text-slate-400 mt-0.5 truncate">UID {candidate.externalConversationId || candidate.conversationKey}</div>
                            {candidate.previewText && <div className="text-[10px] text-slate-400 mt-0.5 truncate">{candidate.previewText}</div>}
                          </div>
                        </div>
                        <button onClick={() => void handleImport(candidate)} disabled={Boolean(importingId)} className="shrink-0 ml-3 text-[10px] bg-sky-500 hover:bg-sky-600 text-white px-3 py-1.5 rounded-xl font-bold shadow-sm disabled:opacity-50">
                          {t.importBtn}
                        </button>
                      </div>
                    ))
                  ) : (
                    <div className="py-12 flex flex-col items-center justify-center text-center space-y-2">
                      <ShoppingBag size={32} className="text-slate-300" />
                      <p className="text-xs font-bold text-slate-500">{t.emptyTitle}</p>
                      <p className="text-[10px] text-slate-400 max-w-xs">{t.emptySubtitle}</p>
                    </div>
                  )}
                </div>
                <div className="p-4 bg-slate-50 border-t border-slate-100 flex items-center justify-between text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                  <span>{candidates.length} {lang === 'zh' ? '个可导入会话' : 'sessions available'}</span>
                  <span className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse" />Online</span>
                </div>
              </>
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
