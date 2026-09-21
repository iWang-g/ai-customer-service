import { useEffect, useMemo, useState } from 'react';
import { Bell, ChevronDown, ChevronRight, ChevronUp, Inbox } from 'lucide-react';
import PlatformLogo, { platformName } from './PlatformLogo';
import { elapsedSeconds, filterNotices, noticeStatus, type MessageNoticeState, type NoticeFilter } from './types';
import './style.css';

const initial: MessageNoticeState = { revision: -1, sessionId: '', since: '', items: [], collapsed: false, hasUnseenCustomerMessage: false, status: 'signed_out', clockOffset: 0 };
const tabs: [NoticeFilter, string][] = [['all', '全部消息'], ['pending', '未超时'], ['timeout', '已超时'], ['ai', 'AI已回复']];

export default function MessageNoticeApp() {
  const [state, setState] = useState(initial);
  const [filter, setFilter] = useState<NoticeFilter>('all');
  const [platform, setPlatform] = useState('all');
  const [now, setNow] = useState(Date.now());
  const [actionError, setActionError] = useState('');
  useEffect(() => {
    const bridge = window.messageNoticeBridge;
    if (!bridge) return;
    let cancelled = false;
    const accept = (next: MessageNoticeState) => {
      if (!cancelled) setState((current) => next.revision >= current.revision ? next : current);
    };
    const dispose = bridge.onState(accept);
    void bridge.getState().then(accept).catch(() => setActionError('通知窗初始化失败'));
    return () => { cancelled = true; dispose(); };
  }, []);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => { setFilter('all'); setPlatform('all'); }, [state.sessionId]);
  const clock = now + state.clockOffset;
  const platforms = useMemo(() => ['all', ...new Set(state.items.map((item) => item.platform_code))], [state.items]);
  const activePlatform = platforms.includes(platform) ? platform : 'all';
  const items = filterNotices(state.items, filter, activePlatform, clock);
  const pendingCount = state.items.filter((item) => !item.reply_kind).length;
  const perform = (action: Promise<unknown> | undefined) => {
    setActionError('');
    void action?.then((ok) => { if (ok === false) setActionError('会话已更新，请稍后重试'); }).catch(() => setActionError('操作失败，请稍后重试'));
  };
  const statusText = { signed_out: '登录后接收新消息', connecting: '正在连接消息服务…', connected: '实时同步', disconnected: '连接断开 · 正在重连', error: '消息同步失败 · 正在重试' }[state.status];
  return <main className={`notice-window ${state.collapsed ? 'is-collapsed' : ''}`}>
    <header className="notice-titlebar">
      <Bell size={15} /><strong className="notice-title-text">消息通知
        {state.collapsed && state.hasUnseenCustomerMessage && <span className="notice-new-message-dot" role="status" aria-label="有新客户消息尚未查看" title="有新客户消息尚未查看" />}
      </strong>
      {state.collapsed && pendingCount > 0 && <span className="notice-compact-count">{pendingCount} 待回复</span>}
      <button type="button" title={state.collapsed ? '展开通知窗' : '收起通知窗'} aria-label={state.collapsed ? '展开通知窗' : '收起通知窗'} onClick={() => perform(window.messageNoticeBridge?.setCollapsed(!state.collapsed))}>
        {state.collapsed ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
      </button>
    </header>
    {!state.collapsed && <>
      <nav className="notice-tabs" aria-label="消息状态">
        {tabs.map(([id, name]) => {
          const count = filterNotices(state.items, id, activePlatform, clock).length;
          return <button key={id} className={filter === id ? 'active' : ''} aria-pressed={filter === id} onClick={() => setFilter(id)}>{name}{count > 0 && <sup className={id === 'timeout' ? 'danger' : ''}>{count > 99 ? '99+' : count}</sup>}</button>;
        })}
      </nav>
      <nav className="notice-platforms" aria-label="消息平台">
        {platforms.map((id) => {
          const count = filterNotices(state.items, filter, id, clock).length;
          return <button key={id} className={activePlatform === id ? 'active' : ''} aria-pressed={activePlatform === id} onClick={() => setPlatform(id)}>{id === 'all' ? '全部' : platformName(id)}{count > 0 && <span>{count}</span>}</button>;
        })}
      </nav>
      <section className="notice-list" aria-label="客户消息">
        {items.map((item) => {
          const status = noticeStatus(item, clock);
          const label = status === 'pending' ? `${elapsedSeconds(item, clock)}s` : status === 'timeout' ? '已超时' : status === 'ai' ? 'AI已回复' : '人工已回复';
          return <button className={`notice-card ${status}`} key={item.conversation_id} onClick={() => perform(window.messageNoticeBridge?.openConversation(item.conversation_id))}>
            <PlatformLogo code={item.platform_code} />
            <div className="notice-card-content">
              <div className="notice-card-heading"><strong title={item.customer_name}>{item.customer_name}</strong><span className="notice-shop" title={item.shop_name}>{item.shop_name}</span><span className={`notice-status ${status}`}>{label}</span></div>
              <p title={item.message_text}>{item.message_text}</p>
            </div>
            <ChevronRight className="notice-card-arrow" size={14} />
          </button>;
        })}
        {items.length === 0 && <div className="notice-empty"><Inbox size={34} strokeWidth={1.3} /><strong>{state.status === 'signed_out' ? '等待登录' : '暂无消息'}</strong><p>{state.status === 'signed_out' ? '登录主程序后，客户新消息会显示在这里' : state.items.length ? '当前筛选下没有客户消息' : '客户新消息会在这里持续提醒'}</p></div>}
      </section>
      <footer className={`notice-footer ${state.status}`}><i /><span role="status">{actionError || statusText}</span><span>{state.items.length} 个会话</span></footer>
    </>}
  </main>;
}
