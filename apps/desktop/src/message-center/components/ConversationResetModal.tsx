import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertCircle, AlertTriangle, LoaderCircle, Trash2, X } from 'lucide-react';
import type { Conversation } from '../types';

interface ConversationResetModalProps {
  conversation: Conversation | null;
  onClose: () => void;
  onConfirm: (conversationId: string) => Promise<void>;
}

export default function ConversationResetModal({
  conversation,
  onClose,
  onConfirm,
}: ConversationResetModalProps) {
  const [isResetting, setIsResetting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!conversation) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isResetting) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [conversation, isResetting, onClose]);

  const handleConfirm = async () => {
    if (!conversation || isResetting) return;
    setIsResetting(true);
    setError('');
    try {
      await onConfirm(conversation.id);
      onClose();
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : '清空聊天记录失败，请稍后重试');
    } finally {
      setIsResetting(false);
    }
  };

  return (
    <AnimatePresence>
      {conversation && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 sm:p-6">
          <motion.button
            type="button"
            aria-label="关闭清空聊天记录确认框"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => { if (!isResetting) onClose(); }}
            className="absolute inset-0 cursor-default bg-slate-900/60 backdrop-blur-sm"
          />
          <motion.section
            initial={{ opacity: 0, scale: 0.96, y: 16 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 16 }}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="reset-conversation-title"
            aria-describedby="reset-conversation-description"
            className="relative w-full max-w-md overflow-hidden rounded-3xl border border-white/70 bg-white shadow-2xl"
          >
            <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-6 py-5">
              <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-rose-50 text-rose-600">
                  <AlertTriangle size={22} />
                </div>
                <div>
                  <h2 id="reset-conversation-title" className="text-lg font-bold text-slate-800">
                    清空聊天记录
                  </h2>
                  <p className="mt-0.5 text-xs font-medium text-slate-400">仅用于重新测试消息采集</p>
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                disabled={isResetting}
                className="rounded-xl p-2 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 disabled:cursor-not-allowed disabled:opacity-40"
                aria-label="关闭"
              >
                <X size={20} />
              </button>
            </div>

            <div className="space-y-4 px-6 py-5">
              <p id="reset-conversation-description" className="text-sm leading-6 text-slate-600">
                确定清空客户 <span className="font-bold text-slate-800">“{conversation.userName}”</span> 在消息中心的聊天测试数据吗？
              </p>
              <div className="rounded-2xl border border-rose-100 bg-rose-50/70 p-4 text-xs leading-5 text-rose-700">
                <p className="font-bold">将删除</p>
                <p className="mt-1">消息、发送任务、自动回复记录和采集诊断。</p>
              </div>
              <div className="rounded-2xl border border-emerald-100 bg-emerald-50/70 p-4 text-xs leading-5 text-emerald-700">
                <p className="font-bold">不会删除拼多多平台聊天记录</p>
                <p className="mt-1">清空后聊天区保持为空，平台再次出现未读会话时才会重新采集。</p>
              </div>
              {error && (
                <div className="flex items-start gap-2 rounded-2xl bg-amber-50 px-4 py-3 text-xs font-semibold leading-5 text-amber-700">
                  <AlertCircle size={16} className="mt-0.5 shrink-0" />
                  <span>{error}</span>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-3 border-t border-slate-100 bg-slate-50/80 px-6 py-4">
              <button
                type="button"
                onClick={onClose}
                disabled={isResetting}
                className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-bold text-slate-600 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void handleConfirm()}
                disabled={isResetting}
                className="inline-flex min-w-32 items-center justify-center gap-2 rounded-xl bg-rose-600 px-4 py-2.5 text-sm font-bold text-white shadow-lg shadow-rose-200 transition-colors hover:bg-rose-700 disabled:cursor-wait disabled:opacity-70"
              >
                {isResetting ? <LoaderCircle size={17} className="animate-spin" /> : <Trash2 size={17} />}
                {isResetting ? '正在清空…' : '确认清空'}
              </button>
            </div>
          </motion.section>
        </div>
      )}
    </AnimatePresence>
  );
}
