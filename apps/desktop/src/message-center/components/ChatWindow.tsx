/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useRef, useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { 
  Send, 
  Bot, 
  X,
  ImageOff,
  Package,
  ShoppingBag,
  Info,
  Paperclip,
  AlertTriangle,
  Eye,
  LoaderCircle,
  RefreshCw,
} from 'lucide-react';
import type { Conversation, Message } from '../types';
import CustomerAvatar from './CustomerAvatar';
import { loadQaImageUrl, type MessageSyncIssueDetail } from '../../shared/api/client';

interface ChatWindowProps {
  conversation?: Conversation;
  isLoading: boolean;
  error: string;
  onSendMessage: (content: string) => Promise<{ draftOnly: boolean; sendMethod?: 'click' | 'enter' | null }>;
  onSendImage: (imageDataUrl: string) => Promise<void>;
  automaticSendNotice?: {
    kind: 'sending' | 'success' | 'error';
    text: string;
    version: number;
  } | null;
  onLoadMessageSyncIssue: (conversationId: string) => Promise<MessageSyncIssueDetail>;
  onDismissMessageSyncIssue: (conversationId: string) => Promise<void>;
  onRebuildMessageQueue: (conversationId: string) => Promise<void>;
}

function ChatImage({ src, onOpen }: { src: string; onOpen: (url: string) => void }) {
  const [url, setUrl] = useState('');
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    let objectUrl = '';
    setUrl('');
    setFailed(false);
    void loadQaImageUrl(src).then((nextUrl) => {
      if (!active) {
        if (nextUrl.startsWith('blob:')) URL.revokeObjectURL(nextUrl);
        return;
      }
      objectUrl = nextUrl.startsWith('blob:') ? nextUrl : '';
      setUrl(nextUrl);
    }).catch(() => {
      if (active) setFailed(true);
    });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src]);

  if (failed) {
    return (
      <div className="flex h-36 w-48 items-center justify-center gap-2 rounded-md border border-slate-200 bg-white text-xs font-medium text-slate-400 shadow-sm">
        <ImageOff size={18} />
        图片加载失败
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => url && onOpen(url)}
      disabled={!url}
      className="block h-36 w-48 overflow-hidden rounded-md border border-slate-200 bg-white shadow-sm transition-colors hover:border-sky-300 focus:outline-none focus:ring-2 focus:ring-sky-400 disabled:cursor-wait"
      aria-label="查看图片"
      title="查看图片"
    >
      {url && (
        <img
          src={url}
          alt="聊天图片"
          className="h-full w-full object-contain"
          loading="lazy"
          onError={() => setFailed(true)}
        />
      )}
    </button>
  );
}

function TimelineCard({ message }: { message: Message }) {
  const timeline = message.timeline;
  const data = timeline?.data;
  const imageUrl = data?.image_url || '';
  const isOrder = timeline?.type === 'order';
  const isContext = timeline?.type === 'context';
  const Icon = isOrder ? ShoppingBag : isContext ? Info : Package;
  const heading = isOrder ? '订单信息' : isContext
    ? data?.source_label || '商品来源'
    : timeline?.type === 'unknown' ? '平台内容' : '商品信息';
  return (
    <div className="w-[360px] max-w-full overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-2 text-xs font-semibold text-slate-500">
        <Icon size={14} />
        {heading}
      </div>
      <div className="flex gap-3 p-3">
        {imageUrl ? <img src={imageUrl} alt="商品" className="h-16 w-16 shrink-0 rounded object-cover" referrerPolicy="no-referrer" /> : null}
        <div className="min-w-0 flex-1">
          <p className="whitespace-pre-wrap break-words text-sm leading-5 text-slate-700">{data?.title || message.content}</p>
          <div className="mt-2 flex items-center justify-between gap-2 text-xs">
            {data?.product_id ? <span className="truncate text-slate-400">商品ID：{data.product_id}</span> : <span />}
            {data?.price_label ? (
              <span className="shrink-0 font-semibold text-rose-500">{data.price_label}</span>
            ) : typeof data?.price === 'number' ? (
              <span className="shrink-0 font-semibold text-rose-500">¥{data.price.toFixed(2)}</span>
            ) : null}
          </div>
          {timeline?.type === 'product' ? (
            <span className="mt-2 inline-flex rounded border border-sky-200 px-2 py-1 text-xs font-medium text-sky-600">查看商品规格</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default function ChatWindow({
  conversation,
  isLoading,
  error,
  onSendMessage,
  onSendImage,
  automaticSendNotice,
  onLoadMessageSyncIssue,
  onDismissMessageSyncIssue,
  onRebuildMessageQueue,
}: ChatWindowProps) {
  const [inputValue, setInputValue] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState('');
  const [sendNotice, setSendNotice] = useState('');
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [pendingImage, setPendingImage] = useState<{ url: string; name: string } | null>(null);
  const [syncIssueDetail, setSyncIssueDetail] = useState<MessageSyncIssueDetail | null>(null);
  const [isLoadingSyncIssue, setIsLoadingSyncIssue] = useState(false);
  const [isRebuildingQueue, setIsRebuildingQueue] = useState(false);
  const [syncIssueError, setSyncIssueError] = useState('');
  const [confirmRebuild, setConfirmRebuild] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const previousConversationIdRef = useRef<string | undefined>(undefined);
  const sendNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeMessages = conversation?.messages ?? [];
  const hasSendingMessages = activeMessages.some((message) => message.deliveryStatus === 'sending');

  useEffect(() => {
    const conversationChanged = previousConversationIdRef.current !== conversation?.id;
    previousConversationIdRef.current = conversation?.id;
    if (scrollRef.current && (conversationChanged || stickToBottomRef.current)) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      stickToBottomRef.current = true;
    }
  }, [activeMessages.length, conversation?.id]);

  useEffect(() => {
    setPreviewImage(null);
    setPendingImage(null);
    setSendNotice('');
    setSyncIssueDetail(null);
    setSyncIssueError('');
    setConfirmRebuild(false);
    if (sendNoticeTimerRef.current) {
      clearTimeout(sendNoticeTimerRef.current);
      sendNoticeTimerRef.current = null;
    }
  }, [conversation?.id]);

  useEffect(() => {
    if (!conversation?.syncIssue?.requiresAttention) {
      setSyncIssueDetail(null);
      setSyncIssueError('');
      setConfirmRebuild(false);
    }
  }, [conversation?.syncIssue?.observationId, conversation?.syncIssue?.requiresAttention]);

  useEffect(() => () => {
    if (sendNoticeTimerRef.current) clearTimeout(sendNoticeTimerRef.current);
  }, []);

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
    if (!content && !pendingImage) return;

    setIsSending(true);
    setSendError('');
    setSendNotice('发送中');
    if (sendNoticeTimerRef.current) {
      clearTimeout(sendNoticeTimerRef.current);
      sendNoticeTimerRef.current = null;
    }
    try {
      if (pendingImage) await onSendImage(pendingImage.url);
      else {
        await onSendMessage(content);
        setInputValue('');
      }
      setPendingImage(null);
      setSendNotice('发送成功');
      sendNoticeTimerRef.current = setTimeout(() => {
        setSendNotice('');
        sendNoticeTimerRef.current = null;
      }, 1800);
    } catch (submitError) {
      setSendError(submitError instanceof Error ? submitError.message : '消息发送失败');
    } finally {
      setIsSending(false);
    }
  };

  const handleLoadSyncIssue = async () => {
    if (!conversation || isLoadingSyncIssue) return;
    if (syncIssueDetail?.issue.observation_id === conversation.syncIssue?.observationId) {
      setSyncIssueDetail(null);
      return;
    }
    setIsLoadingSyncIssue(true);
    setSyncIssueError('');
    try {
      setSyncIssueDetail(await onLoadMessageSyncIssue(conversation.id));
    } catch (issueError) {
      setSyncIssueError(issueError instanceof Error ? issueError.message : '读取采集快照失败');
    } finally {
      setIsLoadingSyncIssue(false);
    }
  };

  const handleDismissSyncIssue = async () => {
    if (!conversation) return;
    setSyncIssueError('');
    try {
      await onDismissMessageSyncIssue(conversation.id);
    } catch (issueError) {
      setSyncIssueError(issueError instanceof Error ? issueError.message : '暂时隐藏提示失败');
    }
  };

  const handleRebuildQueue = async () => {
    if (!conversation || isRebuildingQueue) return;
    setIsRebuildingQueue(true);
    setSyncIssueError('');
    try {
      await onRebuildMessageQueue(conversation.id);
      setSyncIssueDetail(null);
      setConfirmRebuild(false);
    } catch (issueError) {
      setSyncIssueError(issueError instanceof Error ? issueError.message : '重建会话消息队列失败');
    } finally {
      setIsRebuildingQueue(false);
    }
  };

  const selectImage = (file: File | null) => {
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setSendError('仅支持 PNG、JPG、JPEG 和 WebP 图片');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setSendError('图片不能超过 10 MB');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setPendingImage({ url: reader.result, name: file.name || '粘贴的图片' });
        setSendError('');
      }
    };
    reader.onerror = () => setSendError('图片读取失败');
    reader.readAsDataURL(file);
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

      </div>

      {conversation.syncIssue?.requiresAttention && (
        <div className="border-y border-amber-200 bg-amber-50 px-6 py-3 text-amber-950">
          <div className="flex items-start gap-3">
            <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-600" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold">该会话的消息序列无法安全衔接</p>
              <p className="mt-1 text-xs leading-5 text-amber-800">
                检测到未读消息，但最新采集内容暂未写入聊天区。其他会话的采集和自动回复不受影响。
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleLoadSyncIssue()}
                  disabled={isLoadingSyncIssue || isRebuildingQueue}
                  className="inline-flex items-center gap-1.5 rounded-md border border-amber-300 bg-white px-2.5 py-1.5 text-xs font-bold text-amber-800 hover:bg-amber-100 disabled:opacity-50"
                >
                  {isLoadingSyncIssue ? <LoaderCircle size={14} className="animate-spin" /> : <Eye size={14} />}
                  {syncIssueDetail ? '收起采集内容' : '查看采集内容'}
                </button>
                {!confirmRebuild ? (
                  <button
                    type="button"
                    onClick={() => setConfirmRebuild(true)}
                    disabled={isRebuildingQueue}
                    className="inline-flex items-center gap-1.5 rounded-md bg-amber-600 px-2.5 py-1.5 text-xs font-bold text-white hover:bg-amber-700 disabled:opacity-50"
                  >
                    <RefreshCw size={14} />
                    重建消息队列
                  </button>
                ) : (
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-semibold text-amber-800">将用最新完整快照替换当前消息队列，且不会触发自动回复。</span>
                    <button
                      type="button"
                      onClick={() => void handleRebuildQueue()}
                      disabled={isRebuildingQueue}
                      className="inline-flex items-center gap-1.5 rounded-md bg-rose-600 px-2.5 py-1.5 font-bold text-white hover:bg-rose-700 disabled:opacity-60"
                    >
                      {isRebuildingQueue ? <LoaderCircle size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                      确认重建
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmRebuild(false)}
                      disabled={isRebuildingQueue}
                      className="rounded-md px-2 py-1.5 font-bold text-amber-800 hover:bg-amber-100 disabled:opacity-50"
                    >
                      取消
                    </button>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => void handleDismissSyncIssue()}
                  disabled={isRebuildingQueue}
                  className="rounded-md px-2 py-1.5 text-xs font-bold text-amber-700 hover:bg-amber-100 disabled:opacity-50"
                >
                  暂不处理
                </button>
              </div>
              {syncIssueError && <p className="mt-2 text-xs font-semibold text-rose-600">{syncIssueError}</p>}
              {syncIssueDetail && (
                <div className="mt-3 max-h-48 overflow-y-auto border-t border-amber-200 pt-2">
                  <div className="mb-2 flex items-center justify-between gap-3 text-[11px] text-amber-700">
                    <span>最近快照共 {syncIssueDetail.messages.length} 条内容</span>
                    <span>{new Date(syncIssueDetail.issue.latest_detected_at).toLocaleString('zh-CN')}</span>
                  </div>
                  <div className="space-y-1.5">
                    {syncIssueDetail.messages.map((message) => (
                      <div
                        key={`${message.dom_sequence}:${message.sender_role}:${message.content}`}
                        className="flex gap-2 text-xs leading-5"
                      >
                        <span className="w-12 shrink-0 font-bold text-amber-700">
                          {message.sender_role === 'customer' ? '客户' : message.sender_role === 'agent' ? '客服' : '平台'}
                        </span>
                        <span className="min-w-0 flex-1 break-words text-amber-950">
                          {message.content || `[${message.message_type}]`}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Message List */}
      <div 
        ref={scrollRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          stickToBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
        }}
        className="flex-1 overflow-y-auto px-6 py-8 space-y-6 bg-brand-bg relative" 
        id="message-list"
      >
        <div className="absolute inset-0 opacity-[0.02] pointer-events-none" style={{ backgroundImage: 'radial-gradient(#0ea5e9 1px, transparent 1px)', backgroundSize: '32px 32px' }}></div>
        
        {isLoading && activeMessages.length === 0 && <div className="relative z-10 text-center text-xs font-semibold text-slate-400">正在加载消息...</div>}
        {!isLoading && error && activeMessages.length === 0 && <div className="relative z-10 mx-auto max-w-md p-3 bg-rose-50 border border-rose-100 rounded-xl text-xs font-semibold text-rose-600">{error}</div>}
        <AnimatePresence initial={false}>
          {activeMessages.map((msg, index) => {
            const isCustomer = msg.sender === 'user';
            const isPlatform = msg.sender === 'platform';
            const displayMode = msg.timeline?.displayMode || 'bubble';
            const isFirst = index === 0 || activeMessages[index - 1].sender !== msg.sender;

            if (displayMode === 'hidden') return null;
            if (displayMode === 'separator') {
              return (
                <motion.div key={msg.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="relative z-10 flex items-center justify-center">
                  <span className="rounded-full bg-slate-100 px-3 py-1 text-[10px] font-medium text-slate-400">{msg.content}</span>
                </motion.div>
              );
            }
            if (displayMode === 'notice') {
              return (
                <motion.div key={msg.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="relative z-10 mx-auto max-w-[80%] text-center text-xs leading-5 text-slate-400">
                  {msg.content}
                </motion.div>
              );
            }
            
            return (
              <motion.div
                key={msg.id}
                initial={{ opacity: 0, y: 10, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                className={`flex items-start gap-3 ${isPlatform ? 'justify-center' : isCustomer ? 'justify-start' : 'justify-start flex-row-reverse'}`}
                id={`msg-${msg.id}`}
              >
                {isPlatform ? null : isFirst ? (
                  <CustomerAvatar
                    name={isCustomer ? conversation.userName : '客服'}
                    size="message"
                    type={isCustomer ? 'customer' : 'service'}
                  />
                ) : (
                  <div className="w-8 flex-shrink-0" />
                )}
                
                <div className={`min-w-0 group relative z-10 flex flex-col ${isPlatform ? 'max-w-[80%] items-center' : isCustomer ? 'max-w-[70%] items-start' : 'max-w-[70%] items-end'}`}>
                  {displayMode === 'card' ? (
                    <TimelineCard message={msg} />
                  ) : msg.media?.type === 'image' ? (
                    <ChatImage src={msg.media.url} onOpen={setPreviewImage} />
                  ) : (
                    <div className={`w-fit max-w-full px-4 py-3 rounded-2xl text-sm leading-relaxed shadow-sm break-words whitespace-pre-wrap ${
                      isCustomer 
                        ? 'bg-white text-slate-700 rounded-tl-md border border-slate-100' 
                        : `bg-sky-500 text-white rounded-tr-md ${msg.deliveryStatus === 'sending' ? 'opacity-70' : ''}`
                    }`}>
                      {msg.content}
                    </div>
                  )}
                  {msg.timestamp && (
                    <div className={`mt-1 text-[10px] text-slate-400 font-medium tracking-tight ${isPlatform ? 'text-center' : isCustomer ? 'text-left' : 'text-right'}`}>
                      {msg.timestamp}
                    </div>
                  )}
                  {!isCustomer && msg.deliveryStatus === 'sending' && (
                    <div className="mt-1 text-[10px] font-medium text-slate-400">发送中...</div>
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
        {!sendError && (sendNotice || automaticSendNotice || hasSendingMessages) && (
          <p className={`max-w-4xl mx-auto mb-2 text-xs font-semibold ${
            automaticSendNotice?.kind === 'error' && !sendNotice
              ? 'text-rose-600'
              : automaticSendNotice?.kind === 'sending' || sendNotice === '发送中'
                ? 'text-sky-600'
                : hasSendingMessages
                  ? 'text-sky-600'
                  : 'text-emerald-600'
          }`}>
            {sendNotice || automaticSendNotice?.text || '发送中'}
          </p>
        )}
        {pendingImage && (
          <div className="mx-auto mb-2 flex max-w-4xl items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 p-2">
            <img src={pendingImage.url} alt="待发送图片" className="h-16 w-16 rounded-lg object-cover" />
            <span className="min-w-0 flex-1 truncate text-xs font-semibold text-slate-600">{pendingImage.name}</span>
            <button type="button" onClick={() => setPendingImage(null)} className="rounded-lg p-2 text-slate-400 hover:bg-white hover:text-rose-500" aria-label="移除待发送图片"><X size={17} /></button>
          </div>
        )}
        <div className="flex items-end gap-3 max-w-4xl mx-auto bg-slate-50 border border-slate-100 rounded-2xl p-2 focus-within:ring-2 focus-within:ring-brand-active/10 focus-within:border-brand-active transition-all">
          <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(event) => { selectImage(event.target.files?.[0] || null); event.currentTarget.value = ''; }} />
          <button type="button" onClick={() => fileInputRef.current?.click()} disabled={isSending || Boolean(pendingImage)} className="rounded-xl p-2.5 text-slate-400 transition-colors hover:bg-white hover:text-brand-active disabled:opacity-40" title="发送图片" aria-label="发送图片"><Paperclip size={18} /></button>
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
            onPaste={(event) => {
              const image = Array.from(event.clipboardData.items).find((item) => item.type.startsWith('image/'))?.getAsFile() || null;
              if (image) {
                event.preventDefault();
                selectImage(image);
              }
            }}
            id="chat-input"
          />
          <button 
            onClick={handleSend}
            disabled={(!inputValue.trim() && !pendingImage) || isSending}
            className={`p-2.5 rounded-xl transition-all shadow-md ${
              (inputValue.trim() || pendingImage) && !isSending
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
