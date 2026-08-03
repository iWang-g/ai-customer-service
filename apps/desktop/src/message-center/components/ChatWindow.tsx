/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useRef, useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { 
  Send, 
  Paperclip, 
  Smile, 
  MoreHorizontal, 
  Bot, 
  ShieldCheck,
  X,
  ImageOff,
} from 'lucide-react';
import { Conversation } from '../types';
import CustomerAvatar from './CustomerAvatar';

interface ChatWindowProps {
  conversation?: Conversation;
  isLoading: boolean;
  error: string;
  onSendMessage: (content: string) => Promise<{ draftOnly: boolean; sendMethod?: 'click' | 'enter' | null }>;
}

export default function ChatWindow({ conversation, isLoading, error, onSendMessage }: ChatWindowProps) {
  const [inputValue, setInputValue] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState('');
  const [sendNotice, setSendNotice] = useState('');
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [failedImages, setFailedImages] = useState<Set<string>>(() => new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeMessages = conversation?.messages ?? [];

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [activeMessages.length, conversation?.id]);

  useEffect(() => {
    setPreviewImage(null);
    setFailedImages(new Set());
  }, [conversation?.id]);

  useEffect(() => {
    if (!previewImage) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPreviewImage(null);
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [previewImage]);

  const handleSend = async () => {
    if (!conversation) return;

    const content = inputValue.trim();
    if (!content) return;

    setIsSending(true);
    setSendError('');
    setSendNotice('');
    try {
      const result = await onSendMessage(content);
      setInputValue('');
      setSendNotice(
        result.sendMethod
          ? `拼多多消息已发送（${result.sendMethod === 'click' ? '点击发送按钮' : 'Enter 兜底'}）`
          : '消息已提交',
      );
    } catch (submitError) {
      setSendError(submitError instanceof Error ? submitError.message : '消息发送失败');
    } finally {
      setIsSending(false);
    }
  };

  if (!conversation) {
    return (
      <div className="flex-1 h-full flex flex-col items-center justify-center bg-brand-bg relative overflow-hidden" id="empty-chat">
         <div className="absolute inset-0 opacity-[0.03] pointer-events-none" style={{ backgroundImage: 'radial-gradient(#0ea5e9 1px, transparent 1px)', backgroundSize: '24px 24px' }}></div>
         <div className="text-center space-y-4 z-10">
           <div className="w-20 h-20 bg-white rounded-3xl shadow-xl flex items-center justify-center mx-auto mb-6">
             <Bot size={40} className="text-brand-active" />
           </div>
           <h2 className="text-2xl font-bold text-slate-800">选择一个对话开始</h2>
           <p className="text-slate-500 max-w-xs mx-auto">
             从左侧列表选择一个正在进行或已挂起的客服请求。
           </p>
         </div>
      </div>
    );
  }

  return (
    <div className="flex-1 h-full flex flex-col bg-white" id="chat-window">
      {/* Header */}
      <div className="h-16 border-bottom border-brand-border px-6 flex items-center justify-between bg-white z-10 sticky top-0" id="chat-header">
        <div className="flex items-center gap-3">
          <CustomerAvatar name={conversation.userName} size="header" />
          <div>
            <div className="flex items-center gap-2">
              <span className="font-bold text-slate-800">{conversation.userName}</span>
              <span className="px-1.5 py-0.5 bg-slate-100 text-slate-500 rounded text-[10px] font-bold uppercase tracking-wider">
                {conversation.platform}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500"></span>
              <span className="text-[10px] text-slate-400 font-medium uppercase tracking-tight">Active Conversation</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button className="flex items-center gap-2 px-3 py-1.5 bg-emerald-50 text-emerald-600 rounded-lg text-xs font-semibold hover:bg-emerald-100 transition-colors border border-emerald-100/50" id="resolved-btn">
            <ShieldCheck size={14} />
            标记已解决
          </button>
          <button className="p-2 hover:bg-slate-100 rounded-lg transition-colors text-slate-400" id="options-btn">
            <MoreHorizontal size={20} />
          </button>
        </div>
      </div>

      {/* Message List */}
      <div 
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-6 py-8 space-y-6 bg-brand-bg relative" 
        id="message-list"
      >
        <div className="absolute inset-0 opacity-[0.02] pointer-events-none" style={{ backgroundImage: 'radial-gradient(#0ea5e9 1px, transparent 1px)', backgroundSize: '32px 32px' }}></div>
        
        {isLoading && <div className="relative z-10 text-center text-xs font-semibold text-slate-400">正在加载消息...</div>}
        {!isLoading && error && activeMessages.length === 0 && <div className="relative z-10 mx-auto max-w-md p-3 bg-rose-50 border border-rose-100 rounded-xl text-xs font-semibold text-rose-600">{error}</div>}
        <AnimatePresence initial={false}>
          {activeMessages.map((msg, index) => {
            const isCustomer = msg.sender === 'user';
            const isFirst = index === 0 || activeMessages[index - 1].sender !== msg.sender;
            
            return (
              <motion.div
                key={msg.id}
                initial={{ opacity: 0, y: 10, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                className={`flex items-start gap-3 ${isCustomer ? 'justify-start' : 'justify-start flex-row-reverse'}`}
                id={`msg-${msg.id}`}
              >
                {isFirst ? (
                  <CustomerAvatar
                    name={isCustomer ? conversation.userName : '客服'}
                    size="message"
                    type={isCustomer ? 'customer' : 'service'}
                  />
                ) : (
                  <div className="w-8 flex-shrink-0" />
                )}
                
                <div className={`max-w-[70%] min-w-0 group relative z-10 flex flex-col ${isCustomer ? 'items-start' : 'items-end'}`}>
                  {msg.media?.type === 'image' ? (
                    failedImages.has(msg.id) ? (
                      <div className="flex h-36 w-48 items-center justify-center gap-2 rounded-md border border-slate-200 bg-white text-xs font-medium text-slate-400 shadow-sm">
                        <ImageOff size={18} />
                        图片加载失败
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setPreviewImage(msg.media?.url || null)}
                        className="block h-36 w-48 overflow-hidden rounded-md border border-slate-200 bg-white shadow-sm transition-colors hover:border-sky-300 focus:outline-none focus:ring-2 focus:ring-sky-400"
                        aria-label="查看图片"
                        title="查看图片"
                      >
                        <img
                          src={msg.media.url}
                          alt="聊天图片"
                          className="h-full w-full object-contain"
                          loading="lazy"
                          onError={() => setFailedImages((current) => new Set(current).add(msg.id))}
                        />
                      </button>
                    )
                  ) : (
                    <div className={`w-fit max-w-full px-4 py-3 rounded-2xl text-sm leading-relaxed shadow-sm break-words ${
                      isCustomer 
                        ? 'bg-white text-slate-700 rounded-tl-md border border-slate-100' 
                        : 'bg-sky-500 text-white rounded-tr-md'
                    }`}>
                      {msg.content}
                    </div>
                  )}
                  {msg.timestamp && (
                    <div className={`mt-1 text-[10px] text-slate-400 font-medium tracking-tight ${isCustomer ? 'text-left' : 'text-right'}`}>
                      {msg.timestamp}
                    </div>
                  )}
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>

      <AnimatePresence>
        {previewImage && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/75 p-6"
            role="dialog"
            aria-modal="true"
            aria-label="图片预览"
            onClick={() => setPreviewImage(null)}
          >
            <button
              type="button"
              onClick={() => setPreviewImage(null)}
              className="absolute right-5 top-5 flex h-10 w-10 items-center justify-center rounded-md bg-white/10 text-white hover:bg-white/20"
              aria-label="关闭图片预览"
              title="关闭"
            >
              <X size={22} />
            </button>
            <motion.img
              initial={{ opacity: 0, scale: 0.97 }}
              animate={{ opacity: 1, scale: 1 }}
              src={previewImage}
              alt="聊天图片预览"
              className="max-h-full max-w-full object-contain"
              onClick={(event) => event.stopPropagation()}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Input Area */}
      <div className="p-6 border-top border-brand-border bg-white" id="input-area">
        {sendError && <p className="max-w-4xl mx-auto mb-2 text-xs font-semibold text-rose-600">{sendError}</p>}
        {sendNotice && <p className="max-w-4xl mx-auto mb-2 text-xs font-semibold text-emerald-600">{sendNotice}</p>}
        <div className="flex items-end gap-3 max-w-4xl mx-auto bg-slate-50 border border-slate-100 rounded-2xl p-2 focus-within:ring-2 focus-within:ring-brand-active/10 focus-within:border-brand-active transition-all">
          <button className="p-2.5 hover:bg-slate-200 rounded-xl transition-colors text-slate-400" id="attach-btn">
            <Paperclip size={18} />
          </button>
          <textarea
            rows={1}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder="输入消息..."
            className="flex-1 bg-transparent border-none outline-none focus:outline-none focus-visible:outline-none focus:ring-0 focus-visible:ring-0 text-sm py-2.5 resize-none max-h-32 text-slate-700 appearance-none"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            id="chat-input"
          />
          <button className="p-2.5 hover:bg-slate-200 rounded-xl transition-colors text-slate-400" id="emoji-btn">
            <Smile size={18} />
          </button>
          <button 
            onClick={handleSend}
            disabled={!inputValue.trim() || isSending}
            className={`p-2.5 rounded-xl transition-all shadow-md ${
              inputValue.trim() && !isSending
                ? 'bg-brand-active text-white scale-100 rotate-0' 
                : 'bg-slate-300 text-slate-50 opacity-50 cursor-not-allowed scale-90 -rotate-12'
            }`}
            id="send-btn"
          >
            <Send size={18} />
          </button>
        </div>
        <p className="text-center mt-3 text-[10px] text-slate-400 font-medium uppercase tracking-widest">
           由 AI 智能分流系统处理中
        </p>
      </div>
    </div>
  );
}
