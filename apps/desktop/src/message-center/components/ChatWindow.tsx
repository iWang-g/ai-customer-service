/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useRef, useEffect, useMemo } from 'react';
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
  Quote,
  ArrowRightLeft,
  Search,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import type { Conversation, Message, SendMessageResult } from '../types';
import CustomerAvatar from './CustomerAvatar';
import { loadQaImageUrl, type PlatformQuickReply } from '../../shared/api/client';

interface ChatWindowProps {
  conversation?: Conversation;
  isLoading: boolean;
  error: string;
  onSendMessage: (content: string, options?: { quote?: Message | null }) => Promise<SendMessageResult>;
  onSendImage: (imageDataUrl: string, options?: { quote?: Message | null }) => Promise<void>;
  onSyncRecentMessages?: (conversation: Conversation) => Promise<void>;
  onListTransferCs?: (conversation: Conversation) => Promise<{
    status: 'collected';
    cs_list: PddTransferCs[];
    trans_reason: PddTransferReason[];
  }>;
  onTransferConversation?: (
    conversation: Conversation,
    targetCsid: string,
    transReason: string,
  ) => Promise<{
    status: 'transferred';
    target_cs_id: string | null;
    target_cs_username: string | null;
    target_cs_nickname: string | null;
  }>;
  quickReplies: {
    personal: PlatformQuickReply[];
    team: PlatformQuickReply[];
  };
  quickReplyInsert?: {
    conversationId: string;
    sourceId: string;
    content: string;
  } | null;
  onQuickReplyInserted?: () => void;
  automaticSendNotice?: {
    kind: 'sending' | 'success' | 'error';
    text: string;
    version: number;
  } | null;
}

function transferErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error
    ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') || fallback
    : fallback;
}

function TextBubble({ text, customer, status }: { text: string; customer: boolean; status?: Message['deliveryStatus'] }) {
  return <div className={`w-fit max-w-full px-4 py-3 rounded-2xl text-sm leading-relaxed shadow-sm break-words whitespace-pre-wrap ${customer
    ? 'bg-white text-slate-700 rounded-tl-md border border-slate-100'
    : `bg-sky-500 text-white rounded-tr-md ${status === 'sending' || status === 'failed' || status === 'cancelled' ? 'opacity-70' : ''}`}`}>{text}</div>;
}

function ChatImage({ src, onOpen, directUrl = false }: { src: string; onOpen: (url: string) => void; directUrl?: boolean }) {
  const [url, setUrl] = useState('');
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    let objectUrl = '';
    setUrl('');
    setFailed(false);
    // Platform URLs must never enter the knowledge-base authenticated fetch path.
    void (directUrl ? Promise.resolve(src) : loadQaImageUrl(src)).then((nextUrl) => {
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
  }, [src, directUrl]);

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
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      )}
    </button>
  );
}

function ProductThumbnail({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return failed ? (
    <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded bg-slate-100 text-slate-400" title="商品图片加载失败">
      <ImageOff size={20} />
    </div>
  ) : <img src={src} alt="商品" className="h-16 w-16 shrink-0 rounded object-cover" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
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
  const linkUrl = data?.link_url || '';
  const title = data?.title || message.content;
  if (isOrder) {
    return (
      <div className="w-[360px] max-w-full overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-2 text-xs font-semibold text-slate-500">
          <Icon size={14} />
          {heading}
        </div>
        <div className="space-y-3 p-3">
          {data?.order_sequence_no ? (
            <div className="flex min-w-0 items-center gap-2 text-xs text-slate-500">
              <span className="shrink-0 font-medium text-slate-600">订单编号：</span>
              <span className="min-w-0 flex-1 truncate">{data.order_sequence_no}</span>
            </div>
          ) : null}
          {(data?.order_status_label || data?.after_sales_label) ? (
            <div className="flex flex-wrap gap-2 text-xs">
              {data?.order_status_label ? (
                <span className="font-semibold text-rose-500">{data.order_status_label}</span>
              ) : null}
              {data?.after_sales_label ? (
                <span className="text-slate-500">{data.after_sales_label}</span>
              ) : null}
            </div>
          ) : null}
          <div className="flex gap-3">
            {imageUrl ? <img src={imageUrl} alt="商品" className="h-16 w-16 shrink-0 rounded object-cover" referrerPolicy="no-referrer" /> : null}
            <div className="min-w-0 flex-1">
              {linkUrl ? (
                <a
                  href={linkUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="block whitespace-pre-wrap break-words text-sm leading-5 text-sky-600 hover:text-sky-700 hover:underline"
                >
                  {title}
                </a>
              ) : (
                <p className="whitespace-pre-wrap break-words text-sm leading-5 text-slate-700">{title}</p>
              )}
              {data?.spec ? <p className="mt-1 truncate text-xs text-slate-400">{data.spec}</p> : null}
              <div className="mt-2 flex items-center justify-between gap-2 text-xs">
                {data?.quantity ? <span className="text-slate-500">x{data.quantity}</span> : <span />}
                {data?.amount_label ? (
                  <span className="shrink-0 font-semibold text-rose-500">实收 {data.amount_label}</span>
                ) : typeof data?.amount === 'number' ? (
                  <span className="shrink-0 font-semibold text-rose-500">实收 ¥{data.amount.toFixed(2)}</span>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="w-[360px] max-w-full overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-2 text-xs font-semibold text-slate-500">
        <Icon size={14} />
        {heading}
      </div>
      <div className="flex gap-3 p-3">
        {imageUrl ? <ProductThumbnail src={imageUrl} /> : null}
        <div className="min-w-0 flex-1">
          {linkUrl ? (
            <a
              href={linkUrl}
              target="_blank"
              rel="noreferrer"
              className="block whitespace-pre-wrap break-words text-sm leading-5 text-sky-600 hover:text-sky-700 hover:underline"
            >
              {title}
            </a>
          ) : (
            <p className="whitespace-pre-wrap break-words text-sm leading-5 text-slate-700">{title}</p>
          )}
          <div className="mt-2 flex items-center justify-between gap-2 text-xs">
            {data?.product_id ? <span className="truncate text-slate-400">商品ID：{data.product_id}</span> : <span />}
            {data?.price_label ? (
              <span className="shrink-0 font-semibold text-rose-500">{data.price_label}</span>
            ) : typeof data?.price === 'number' ? (
              <span className="shrink-0 font-semibold text-rose-500">¥{data.price.toFixed(2)}</span>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function QuotePreview({
  quote,
  compact = false,
}: {
  quote: NonNullable<Message['quote']>;
  compact?: boolean;
}) {
  const isCustomer = quote.sender === 'user';
  return (
    <div className={`flex max-w-full items-center gap-2 rounded-md border-l-2 border-slate-300 bg-slate-100/80 px-2 py-1.5 text-xs text-slate-500 ${compact ? 'w-full' : 'mb-2'}`}>
      {quote.media?.type === 'image' ? (
        <img src={quote.media.url} alt="quoted" className="h-8 w-8 shrink-0 rounded object-cover" />
      ) : null}
      <div className="min-w-0 flex-1">
        <div className="mb-0.5 font-semibold text-slate-400">{isCustomer ? '客户消息' : '客服消息'}</div>
        <div className="truncate">{quote.content}</div>
      </div>
    </div>
  );
}

function quoteFromMessage(message: Message): NonNullable<Message['quote']> {
  return {
    platformMessageId: message.platformMessageId || null,
    sender: message.sender,
    content: message.content || (message.media?.type === 'image' ? '[图片]' : '[引用消息]'),
    ...(message.media ? { media: message.media } : {}),
  };
}

function canQuoteMessage(message: Message): boolean {
  if (!message.platformMessageId || message.sender === 'platform') return false;
  if (message.media?.type === 'image') return true;
  if (message.timeline?.type === 'image' || message.timeline?.type === 'text') return true;
  return !message.timeline;
}

function isActiveConversation(conversation: Conversation): boolean {
  if (!conversation.latestCustomerMessageAt) return false;
  const date = new Date(conversation.latestCustomerMessageAt);
  if (Number.isNaN(date.getTime())) return false;
  return Date.now() - date.getTime() <= 3 * 24 * 60 * 60 * 1000;
}

export default function ChatWindow({
  conversation,
  isLoading,
  error,
  onSendMessage,
  onSendImage,
  onSyncRecentMessages,
  onListTransferCs,
  onTransferConversation,
  quickReplies,
  quickReplyInsert,
  onQuickReplyInserted,
  automaticSendNotice,
}: ChatWindowProps) {
  const [inputValue, setInputValue] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState('');
  const [sendNotice, setSendNotice] = useState('');
  const [historySync, setHistorySync] = useState({ id: '', busy: false, error: '' });
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [pendingImage, setPendingImage] = useState<{ url: string; name: string } | null>(null);
  const [quotedMessage, setQuotedMessage] = useState<Message | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; message: Message } | null>(null);
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(0);
  const [isSuggestionDismissed, setIsSuggestionDismissed] = useState(false);
  const [isComposing, setIsComposing] = useState(false);
  const [isTransferModalOpen, setIsTransferModalOpen] = useState(false);
  const [isLoadingTransferCs, setIsLoadingTransferCs] = useState(false);
  const [transferCsList, setTransferCsList] = useState<PddTransferCs[]>([]);
  const [transferReasons, setTransferReasons] = useState<PddTransferReason[]>([]);
  const [transferSearch, setTransferSearch] = useState('');
  const [transferError, setTransferError] = useState('');
  const [transferSuccess, setTransferSuccess] = useState('');
  const [selectedTransferReason, setSelectedTransferReason] = useState('无原因直接转移');
  const [transferringCsid, setTransferringCsid] = useState<string | null>(null);
  const [confirmTransfer, setConfirmTransfer] = useState<PddTransferCs | null>(null);
  const transferEpoch = useRef(0);
  const transferBusy = useRef(false);
  const transferConversationId = useRef(conversation?.id);
  transferConversationId.current = conversation?.id;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const previousConversationIdRef = useRef<string | undefined>(undefined);
  const sendNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeMessages = conversation?.messages ?? [];
  const hasSendingMessages = activeMessages.some((message) => message.deliveryStatus === 'sending');
  const activeConversation = conversation ? isActiveConversation(conversation) : false;
  const isPddConversation = conversation?.platform === 'pinduoduo';
  const isDouyinConversation = conversation?.platform === 'douyin';
  const supportsTransfer = isPddConversation || isDouyinConversation || conversation?.platform === 'qianniu';
  const hasPendingConfirmation = activeMessages.some((message) => message.deliveryStatus === 'confirmation_pending');
  const platformTransfer = isDouyinConversation ? conversation?.douyinTransfer : conversation?.platform === 'qianniu' ? conversation.qianniuTransfer : isPddConversation ? conversation?.pddTransfer : null;
  const transferBlocked = ['preparing', 'ack_queued', 'ready', 'transferring', 'transferred', 'confirmation_pending'].includes(platformTransfer?.status || '');
  const transferNotice = platformTransfer?.status === 'unavailable'
    ? isPddConversation ? '暂无其他可接待客服，本次未转接；新消息仍会自动处理' : '暂无其他在线客服，本次未转接；新消息仍会自动处理'
    : !transferBlocked ? '' : platformTransfer?.status === 'transferred'
    ? `已转移给 ${platformTransfer.targetNick}` : platformTransfer?.status !== 'confirmation_pending'
      ? '转接处理中，已暂停发送' : `转接结果待确认，请在${isDouyinConversation ? '飞鸽' : isPddConversation ? '拼多多原平台' : '千牛'}核对，勿重复转接`;
  const canTransferConversation = Boolean(
    supportsTransfer
    && conversation?.shopId
    && conversation?.externalConversationId
    && onListTransferCs
    && onTransferConversation,
  );
  const quickReplySuggestions = useMemo(() => {
    const query = inputValue.trim().toLocaleLowerCase();
    if (!conversation || pendingImage || !query) return [];
    return [...quickReplies.personal, ...quickReplies.team]
      .filter((item) => item.content.toLocaleLowerCase().includes(query))
      .filter((item, index, items) => (
        items.findIndex((candidate) => candidate.content === item.content) === index
      ))
      .slice(0, 5);
  }, [conversation, inputValue, pendingImage, quickReplies.personal, quickReplies.team]);
  const visibleTransferCsList = useMemo(() => {
    const query = transferSearch.trim().toLocaleLowerCase();
    if (!query) return transferCsList;
    return transferCsList.filter((item) => [
      item.accountName,
      item.username,
      item.nickname,
      item.remark,
      item.csid,
    ].some((value) => String(value || '').toLocaleLowerCase().includes(query)));
  }, [transferCsList, transferSearch]);

  useEffect(() => {
    const conversationChanged = previousConversationIdRef.current !== conversation?.id;
    previousConversationIdRef.current = conversation?.id;
    if (scrollRef.current && (conversationChanged || stickToBottomRef.current)) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      stickToBottomRef.current = true;
    }
  }, [activeMessages.length, conversation?.id]);

  useEffect(() => {
    transferEpoch.current++;
    setPreviewImage(null);
    setPendingImage(null);
    setQuotedMessage(null);
    setContextMenu(null);
    setSendNotice('');
    setIsTransferModalOpen(false);
    setIsLoadingTransferCs(false);
    setTransferCsList([]);
    setTransferSearch('');
    setTransferError('');
    setTransferSuccess('');
    setTransferringCsid(null);
    setConfirmTransfer(null);
    if (sendNoticeTimerRef.current) {
      clearTimeout(sendNoticeTimerRef.current);
      sendNoticeTimerRef.current = null;
    }
  }, [conversation?.id]);

  useEffect(() => {
    setActiveSuggestionIndex(0);
  }, [inputValue, quickReplySuggestions.length]);

  useEffect(() => {
    if (!quickReplyInsert || quickReplyInsert.conversationId !== conversation?.id) return;
    setInputValue(quickReplyInsert.content);
    setSendError('');
    setActiveSuggestionIndex(0);
    setIsSuggestionDismissed(true);
    onQuickReplyInserted?.();
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }, [conversation?.id, onQuickReplyInserted, quickReplyInsert]);

  useEffect(() => () => {
    if (sendNoticeTimerRef.current) clearTimeout(sendNoticeTimerRef.current);
  }, []);

  useEffect(() => {
    if (!contextMenu) return undefined;
    const close = () => setContextMenu(null);
    document.addEventListener('click', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', close);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!previewImage) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPreviewImage(null);
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [previewImage]);

  const handleSend = async () => {
    if (!conversation || transferBlocked || isDouyinConversation && (hasSendingMessages || hasPendingConfirmation)) return;

    const content = inputValue.trim();
    if (!content && !pendingImage) return;

    setIsSending(true);
    setSendError('');
    setSendNotice('发送中');
    if (sendNoticeTimerRef.current) {
      clearTimeout(sendNoticeTimerRef.current);
      sendNoticeTimerRef.current = null;
    }
    if (!pendingImage) {
      setInputValue('');
      setQuotedMessage(null);
    }
    try {
      if (pendingImage) await onSendImage(pendingImage.url, { quote: quotedMessage });
      else {
        const result = await onSendMessage(content, { quote: quotedMessage });
        if (result.sendMethod === 'qianniu_direct_send' || result.sendMethod === 'douyin_task') {
          setPendingImage(null);
          setSendNotice('已提交');
          sendNoticeTimerRef.current = setTimeout(() => {
            setSendNotice('');
            sendNoticeTimerRef.current = null;
          }, 1200);
          return;
        }
      }
      setPendingImage(null);
      setQuotedMessage(null);
      setSendNotice('发送成功');
      sendNoticeTimerRef.current = setTimeout(() => {
        setSendNotice('');
        sendNoticeTimerRef.current = null;
      }, 1800);
    } catch (submitError) {
      if (!pendingImage) {
        setInputValue(content);
        setQuotedMessage(quotedMessage);
      }
      setSendError(submitError instanceof Error ? submitError.message : '消息发送失败');
    } finally {
      setIsSending(false);
    }
  };

  const openTransferModal = async () => {
    if (!conversation || !onListTransferCs || transferBusy.current) return;
    const epoch = ++transferEpoch.current, id = conversation.id;
    setIsTransferModalOpen(true);
    setIsLoadingTransferCs(true);
    setTransferCsList([]);
    setTransferReasons([]);
    setTransferSearch('');
    setTransferError('');
    setTransferSuccess('');
    setConfirmTransfer(null);
    setSelectedTransferReason('无原因直接转移');
    try {
      const result = await onListTransferCs(conversation);
      if (epoch !== transferEpoch.current || transferConversationId.current !== id) return;
      const reasons = result.trans_reason?.length
        ? result.trans_reason
        : [{ code: null, desc: '无原因直接转移' }];
      setTransferCsList(result.cs_list || []);
      setTransferReasons(reasons);
      setSelectedTransferReason(
        reasons.find((reason) => reason.desc === '无原因直接转移')?.desc
        || reasons[0]?.desc
        || '无原因直接转移',
      );
    } catch (transferListError) {
      if (epoch !== transferEpoch.current || transferConversationId.current !== id) return;
      setTransferError(transferErrorMessage(transferListError, '客服列表加载失败'));
    } finally {
      if (epoch === transferEpoch.current && transferConversationId.current === id) setIsLoadingTransferCs(false);
    }
  };

  const submitTransfer = async (target: PddTransferCs) => {
    if (!conversation || !onTransferConversation || transferBusy.current) return;
    const epoch = transferEpoch.current, id = conversation.id;
    transferBusy.current = true;
    setTransferringCsid(target.csid);
    setTransferError('');
    setTransferSuccess('');
    try {
      await onTransferConversation(conversation, target.csid, selectedTransferReason || '无原因直接转移');
      if (epoch !== transferEpoch.current || transferConversationId.current !== id) return;
      setTransferSuccess(`已转移给 ${target.nickname || target.accountName || target.csid}`);
      setConfirmTransfer(null);
      if (conversation.platform === 'qianniu' || isDouyinConversation) setTransferCsList([]);
      else window.setTimeout(() => {
        if (epoch === transferEpoch.current && transferConversationId.current === id) setIsTransferModalOpen(false);
      }, 800);
    } catch (transferErrorResult) {
      if (epoch !== transferEpoch.current || transferConversationId.current !== id) return;
      setConfirmTransfer(null);
      if (conversation.platform === 'qianniu' || isDouyinConversation) setTransferCsList([]);
      setTransferError(transferErrorMessage(transferErrorResult, '会话转移失败'));
    } finally {
      transferBusy.current = false;
      if (epoch === transferEpoch.current && transferConversationId.current === id) setTransferringCsid(null);
    }
  };

  const selectQuickReply = (item: PlatformQuickReply) => {
    setInputValue(item.content);
    setSendError('');
    setActiveSuggestionIndex(0);
    setIsSuggestionDismissed(true);
    window.requestAnimationFrame(() => inputRef.current?.focus());
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
      <div className="min-w-0 flex-1 h-full flex flex-col items-center justify-center bg-brand-bg relative overflow-hidden" id="empty-chat">
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
    <div className="min-w-0 flex-1 h-full flex flex-col bg-white" id="chat-window">
      {/* Header */}
      <div className="h-16 shrink-0 border-bottom border-brand-border px-6 flex items-center justify-between bg-white z-10 sticky top-0" id="chat-header">
        <div className="flex min-w-0 items-center gap-3">
          <CustomerAvatar name={conversation.userName} size="header" src={conversation.avatarUrl} />
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 truncate font-bold text-slate-800">{conversation.userName}</span>
              <span className="px-1.5 py-0.5 bg-slate-100 text-slate-500 rounded text-[10px] font-bold">
                {conversation.platformName}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className={`w-1.5 h-1.5 rounded-full ${activeConversation ? 'bg-green-500' : 'bg-slate-300'}`}></span>
              <span className="text-[10px] text-slate-400 font-medium tracking-tight">
                {activeConversation ? '活跃会话' : '非活跃会话'}
              </span>
            </div>
          </div>
        </div>
        {conversation.platform === 'qianniu' && onSyncRecentMessages && (
          <button type="button" title="同步最近消息" aria-label="同步最近消息"
            disabled={historySync.id === conversation.id && historySync.busy}
            className="ml-4 flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-slate-500 hover:bg-sky-50 hover:text-sky-600 disabled:opacity-50"
            onClick={() => {
              const target = conversation;
              setHistorySync({ id: target.id, busy: true, error: '' });
              void onSyncRecentMessages(target).then(() => {
                setHistorySync(current => current.id === target.id ? { id: target.id, busy: false, error: '' } : current);
              }).catch(error => {
                setHistorySync(current => current.id === target.id ? { id: target.id, busy: false, error: error instanceof Error ? error.message : '消息同步失败' } : current);
              });
            }}>
            <RefreshCw size={17} className={historySync.id === conversation.id && historySync.busy ? 'animate-spin' : ''} />
          </button>
        )}
        {supportsTransfer && (
          <button
            type="button"
            onClick={openTransferModal}
            disabled={!canTransferConversation || transferBlocked || isLoadingTransferCs || Boolean(transferringCsid)}
            className="ml-4 inline-flex h-9 shrink-0 items-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-600 shadow-sm transition-colors hover:border-sky-200 hover:bg-sky-50 hover:text-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="转移会话"
            title={canTransferConversation ? '转移会话' : '当前会话缺少可转移参数'}
          >
            <ArrowRightLeft size={15} />
            转移会话
          </button>
        )}
      </div>

      {/* Message List */}
      <div 
        ref={scrollRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          stickToBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
        }}
        className="min-w-0 flex-1 overflow-y-auto px-6 py-8 space-y-6 bg-brand-bg relative"
        id="message-list"
      >
        <div className="absolute inset-0 opacity-[0.02] pointer-events-none" style={{ backgroundImage: 'radial-gradient(#0ea5e9 1px, transparent 1px)', backgroundSize: '32px 32px' }}></div>
        
        {isLoading && activeMessages.length === 0 && <div className="relative z-10 text-center text-xs font-semibold text-slate-400">正在加载消息...</div>}
        {historySync.id === conversation.id && historySync.error && <div className="relative z-10 rounded-md border border-rose-100 bg-rose-50 p-3 text-xs text-rose-600">{historySync.error}</div>}
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
                onContextMenu={(event) => {
                  if (!canQuoteMessage(msg)) return;
                  event.preventDefault();
                  setContextMenu({ x: event.clientX, y: event.clientY, message: msg });
                }}
              >
                {isPlatform ? null : isFirst ? (
                  <CustomerAvatar
                    name={isCustomer ? conversation.userName : '客服'}
                    size="message"
                    type={isCustomer ? 'customer' : 'service'}
                    src={isCustomer ? conversation.avatarUrl : conversation.shopLogoUrl}
                  />
                ) : (
                  <div className="w-10 flex-shrink-0" />
                )}
                
                <div className={`min-w-0 group relative z-10 flex flex-col ${isPlatform ? 'max-w-[80%] items-center' : isCustomer ? 'max-w-[70%] items-start' : 'max-w-[70%] items-end'}`}>
                  {msg.quote ? <QuotePreview quote={msg.quote} /> : null}
                  {conversation.platform === 'qianniu' && msg.timeline?.data?.parts?.length ? (
                    <div className="flex max-w-full flex-col gap-2">
                      {msg.timeline.data.parts.map(part => part.kind === 'image' ? (
                        part.url ? <ChatImage key={part.index} src={part.url} onOpen={setPreviewImage} /> :
                          <div key={part.index} className="flex h-36 w-48 items-center justify-center rounded-md border border-slate-200 bg-white text-xs text-slate-400"><ImageOff size={18} className="mr-2" />图片暂不可用</div>
                      ) : part.kind === 'product' ? (
                        <TimelineCard key={part.index} message={{ ...msg, content: part.title || '商品分享', timeline: {
                          type: 'product', displayMode: 'card', data: { title: part.title || '商品分享', product_id: part.product_id,
                            image_url: part.image_url, link_url: part.url, price_label: part.price_label },
                        } }} />
                      ) : (
                        <TextBubble key={part.index} text={part.text || '[暂不支持的消息]'} customer={isCustomer} status={msg.deliveryStatus} />
                      ))}
                    </div>
                  ) : displayMode === 'card' ? (
                    <TimelineCard message={msg} />
                  ) : msg.media?.type === 'image' ? (
                    <ChatImage src={msg.media.url} onOpen={setPreviewImage} directUrl={conversation.platform === 'douyin'} />
                  ) : (
                    <TextBubble text={msg.content} customer={isCustomer} status={msg.deliveryStatus} />
                  )}
                  {msg.timestamp && (
                    <div className={`mt-1 text-[10px] text-slate-400 font-medium tracking-tight ${isPlatform ? 'text-center' : isCustomer ? 'text-left' : 'text-right'}`}>
                      {msg.timestamp}
                    </div>
                  )}
                  {!isCustomer && msg.deliveryStatus === 'sending' && (
                    <div className="mt-1 text-[10px] font-medium text-slate-400">发送中...</div>
                  )}
                  {!isCustomer && msg.deliveryStatus === 'failed' && (
                    <div className="mt-1 text-[10px] font-medium text-rose-500">发送失败</div>
                  )}
                  {!isCustomer && msg.deliveryStatus === 'cancelled' && (
                    <div className="mt-1 text-[10px] font-medium text-slate-500">已取消发送</div>
                  )}
                  {!isCustomer && msg.deliveryStatus === 'confirmation_pending' && (
                    <div className="mt-1 text-[10px] font-medium text-amber-600">发送结果待确认，请在原平台核对，勿重复发送</div>
                  )}
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
        {contextMenu && !isDouyinConversation && (
          <div
            className="fixed z-[80] min-w-32 rounded-md border border-slate-200 bg-white p-1 shadow-lg"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs font-semibold text-slate-600 hover:bg-slate-50"
              onClick={() => {
                setQuotedMessage(contextMenu.message);
                setContextMenu(null);
              }}
            >
              <Quote size={14} />
              引用回复
            </button>
          </div>
        )}
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
              referrerPolicy="no-referrer"
              className="max-h-full max-w-full object-contain"
              onClick={(event) => event.stopPropagation()}
            />
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isTransferModalOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[75] flex items-center justify-center bg-slate-950/35 p-6"
            role="dialog"
            aria-modal="true"
            aria-label="转移会话"
            onClick={() => { if (!transferBusy.current) { transferEpoch.current++; setIsLoadingTransferCs(false); setIsTransferModalOpen(false); } }}
          >
            <motion.div
              initial={{ opacity: 0, y: 12, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.98 }}
              className="flex max-h-[82vh] w-[760px] max-w-full flex-col overflow-hidden rounded-lg bg-white shadow-2xl"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex h-12 shrink-0 items-center justify-between border-b border-slate-200 px-5">
                <h2 className="text-sm font-semibold text-slate-800">转移会话</h2>
                <button
                  type="button"
                  onClick={() => { transferEpoch.current++; setIsLoadingTransferCs(false); setIsTransferModalOpen(false); }}
                  disabled={Boolean(transferringCsid)}
                  className="flex h-8 w-8 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-600 disabled:cursor-not-allowed disabled:opacity-50"
                  aria-label="关闭转移会话弹窗"
                  title="关闭"
                >
                  <X size={17} />
                </button>
              </div>

              <div className="flex min-h-0 flex-1 flex-col gap-3 p-5">
                {conversation.platform === 'qianniu' && <p className="break-words text-xs text-slate-600">{conversation.shopName} / {conversation.userName}</p>}
                <div className="flex flex-wrap items-center gap-3">
                  {conversation.platform === 'qianniu' && <button type="button" title="刷新在线客服" aria-label="刷新在线客服"
                    disabled={transferBlocked || isLoadingTransferCs || Boolean(transferringCsid)} onClick={openTransferModal}
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded border border-slate-200 disabled:opacity-50"><RefreshCw size={16} /></button>}
                  <label className="relative min-w-0 flex-1">
                    <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                    <input
                      type="search"
                      value={transferSearch}
                      onChange={(event) => setTransferSearch(event.target.value)}
                      placeholder="请输入内容"
                      className="h-9 w-full rounded-md border border-slate-200 bg-white pl-9 pr-3 text-sm text-slate-700 outline-none transition-colors placeholder:text-slate-400 focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
                    />
                  </label>
                  <select
                    value={selectedTransferReason}
                    onChange={(event) => setSelectedTransferReason(event.target.value)}
                    className="h-9 w-44 rounded-md border border-slate-200 bg-white px-3 text-xs font-medium text-slate-600 outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
                    aria-label="转移原因"
                  >
                    {(transferReasons.length ? transferReasons : [{ code: null, desc: '无原因直接转移' }]).map((reason) => (
                      <option key={`${reason.code ?? 'default'}:${reason.desc}`} value={reason.desc}>
                        {reason.desc}
                      </option>
                    ))}
                  </select>
                </div>

                {transferError && (
                  <div className="rounded-md border border-rose-100 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-600">
                    {transferError}
                  </div>
                )}
                {transferSuccess && (
                  <div className="rounded-md border border-emerald-100 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-600">
                    {transferSuccess}
                  </div>
                )}

                {confirmTransfer && <div className="border-y border-slate-200 py-3 text-sm text-slate-700">
                  <p className="break-words">将 {conversation.shopName} 的 {conversation.userName} 转移给 {confirmTransfer.nickname}？</p>
                  <div className="mt-3 flex gap-2">
                    <button type="button" disabled={Boolean(transferringCsid)} onClick={() => submitTransfer(confirmTransfer)}
                      className="rounded bg-sky-600 px-3 py-2 text-xs text-white disabled:opacity-50">{transferringCsid ? '转移中…' : '确认转移'}</button>
                    <button type="button" disabled={Boolean(transferringCsid)} onClick={() => setConfirmTransfer(null)}
                      className="rounded border border-slate-200 px-3 py-2 text-xs disabled:opacity-50">取消</button>
                  </div>
                </div>}

                <div className={`${transferSuccess && !isPddConversation ? 'hidden' : ''} min-h-[260px] overflow-hidden rounded-md border border-slate-200`}>
                  <div className={`grid h-10 ${isPddConversation ? 'grid-cols-[1.2fr_1fr_1fr_96px_176px]' : 'grid-cols-[minmax(0,1fr)_minmax(0,1fr)_80px]'} items-center border-b border-slate-200 bg-slate-50 px-3 text-xs font-semibold text-slate-500`}>
                    <div className="min-w-0">账号名</div>
                    {isPddConversation && <div className="min-w-0">昵称</div>}
                    <div className="min-w-0">{!isPddConversation ? '在线状态' : '备注'}</div>
                    {isPddConversation && <div className="text-right">当前未回复</div>}
                    <div className="text-right">操作</div>
                  </div>
                  <div className="max-h-[360px] overflow-y-auto">
                    {isLoadingTransferCs ? (
                      <div className="flex h-48 items-center justify-center gap-2 text-xs font-semibold text-slate-400">
                        <Loader2 size={16} className="animate-spin" />
                        正在加载客服账号...
                      </div>
                    ) : visibleTransferCsList.length ? (
                      visibleTransferCsList.map((item) => {
                        const isCurrentTransferring = transferringCsid === item.csid;
                        return (
                          <div
                            key={item.csid}
                            className={`grid min-h-12 ${isPddConversation ? 'grid-cols-[1.2fr_1fr_1fr_96px_176px]' : 'grid-cols-[minmax(0,1fr)_minmax(0,1fr)_80px]'} items-center border-b border-slate-100 px-3 text-xs text-slate-600 last:border-b-0 hover:bg-slate-50`}
                          >
                            <div className="min-w-0 truncate font-medium text-slate-700" title={item.accountName || item.username || item.csid}>
                              {item.accountName || item.username || item.csid}
                            </div>
                            {isPddConversation && <div className="min-w-0 truncate" title={item.nickname || '-'}>
                              {item.nickname || '-'}
                            </div>}
                            <div className="min-w-0 truncate text-slate-400" title={item.onlineLabel || item.remark || '-'}>
                              {!isPddConversation ? item.onlineLabel : item.remark || '-'}
                            </div>
                            {isPddConversation && <div className="text-right font-semibold text-slate-700">{item.unreplyNum || 0}</div>}
                            <div className="flex justify-end gap-2">
                              <button
                                type="button"
                                onClick={() => !isPddConversation ? setConfirmTransfer(item) : submitTransfer(item)}
                                disabled={Boolean(transferringCsid)}
                                className="inline-flex h-8 items-center justify-center rounded-md bg-sky-500 px-3 text-xs font-semibold text-white transition-colors hover:bg-sky-600 disabled:cursor-not-allowed disabled:bg-slate-300"
                              >
                                {isCurrentTransferring ? (
                                  <>
                                    <Loader2 size={14} className="mr-1.5 animate-spin" />
                                    转移中
                                  </>
                                ) : '转移'}
                              </button>
                              {isPddConversation && <button
                                type="button"
                                disabled
                                className="inline-flex h-8 items-center justify-center rounded-md border border-slate-200 bg-slate-50 px-3 text-xs font-semibold text-slate-300"
                                title="暂不支持微信通知"
                              >
                                转移并微信通知
                              </button>}
                            </div>
                          </div>
                        );
                      })
                    ) : (
                      <div className="flex h-48 items-center justify-center text-xs font-semibold text-slate-400">
                        {transferError ? '客服列表不可用' : transferSearch ? '没有匹配的客服账号' : '暂无可转移客服账号'}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Input Area */}
      <div className="relative shrink-0 p-6 border-top border-brand-border bg-white" id="input-area">
        {transferNotice && <p className="mx-auto mb-2 max-w-4xl break-words text-xs text-amber-700">{transferNotice}</p>}
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
        {quotedMessage && (
          <div className="mx-auto mb-2 flex max-w-4xl items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 p-2">
            <QuotePreview quote={quoteFromMessage(quotedMessage)} compact />
            <button
              type="button"
              onClick={() => setQuotedMessage(null)}
              className="shrink-0 rounded-lg p-2 text-slate-400 hover:bg-white hover:text-rose-500"
              aria-label="取消引用"
              title="取消引用"
            >
              <X size={17} />
            </button>
          </div>
        )}
        {quickReplySuggestions.length > 0 && !isComposing && !isSuggestionDismissed && (
          <div
            className="absolute bottom-[calc(100%-1.25rem)] left-6 right-6 z-30 mx-auto max-w-4xl overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl"
            role="listbox"
            aria-label="内容联想"
          >
            {quickReplySuggestions.map((item, index) => (
              <button
                key={`${item.source_id}:${item.content}`}
                type="button"
                role="option"
                aria-selected={index === activeSuggestionIndex}
                onMouseDown={(event) => {
                  event.preventDefault();
                  selectQuickReply(item);
                }}
                className={`flex w-full items-start gap-2 border-b border-slate-100 px-3 py-2 text-left last:border-b-0 ${
                  index === activeSuggestionIndex ? 'bg-sky-50' : 'bg-white hover:bg-slate-50'
                }`}
              >
                <span className="mt-0.5 shrink-0 text-[10px] font-semibold text-slate-400">
                  {item.source === 'personal' ? '个人' : '团队'}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs leading-5 text-slate-700">{item.content}</span>
                  <span className="block truncate text-[10px] leading-4 text-slate-400">
                    {item.category || '未分类'}
                    {item.quick_key ? ` · ${item.quick_key}` : ''}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
        <div className="mx-auto flex max-w-4xl min-w-0 items-end gap-3 bg-slate-50 border border-slate-100 rounded-2xl p-2 focus-within:ring-2 focus-within:ring-brand-active/10 focus-within:border-brand-active transition-all">
          <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(event) => { selectImage(event.target.files?.[0] || null); event.currentTarget.value = ''; }} />
          <button type="button" onClick={() => fileInputRef.current?.click()} disabled={!isPddConversation || isSending || Boolean(pendingImage)} className="rounded-xl p-2.5 text-slate-400 transition-colors hover:bg-white hover:text-brand-active disabled:opacity-40" title="发送图片" aria-label="发送图片"><Paperclip size={18} /></button>
          <textarea
            disabled={transferBlocked}
            ref={inputRef}
            rows={1}
            value={inputValue}
            onChange={(e) => {
              setInputValue(e.target.value);
              setIsSuggestionDismissed(false);
            }}
            placeholder={isDouyinConversation ? '输入文本消息...' : '输入消息...'}
            className="min-w-0 flex-1 bg-transparent border-none outline-none focus:outline-none focus-visible:outline-none focus:ring-0 focus-visible:ring-0 text-sm py-2.5 resize-none max-h-32 text-slate-700 appearance-none"
            onKeyDown={(e) => {
              if (!isComposing && !isSuggestionDismissed && quickReplySuggestions.length > 0) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setActiveSuggestionIndex((current) => (current + 1) % quickReplySuggestions.length);
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setActiveSuggestionIndex((current) => (
                    (current - 1 + quickReplySuggestions.length) % quickReplySuggestions.length
                  ));
                  return;
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setIsSuggestionDismissed(true);
                  return;
                }
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  selectQuickReply(quickReplySuggestions[activeSuggestionIndex] || quickReplySuggestions[0]);
                  return;
                }
              }
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
            onCompositionStart={() => setIsComposing(true)}
            onCompositionEnd={() => setIsComposing(false)}
            id="chat-input"
          />
          <button 
            onClick={handleSend}
            disabled={transferBlocked || isDouyinConversation && (hasSendingMessages || hasPendingConfirmation) || (!inputValue.trim() && !pendingImage) || isSending}
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
