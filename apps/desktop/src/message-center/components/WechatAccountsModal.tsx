import { AnimatePresence, motion } from 'framer-motion';
import { CheckCircle2, LoaderCircle, RefreshCw, Search, XCircle } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

interface WechatAccountsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

function statusLabel(account: WechatAccount) {
  if (account.healthStatus !== 'online') return '离线';
  if (account.identityStatus === 'identified') return '已识别';
  if (account.identityStatus === 'conflict') return '身份冲突';
  return '待识别';
}

export default function WechatAccountsModal({ isOpen, onClose }: WechatAccountsModalProps) {
  const [accounts, setAccounts] = useState<WechatAccount[]>([]);
  const [loading, setLoading] = useState(false);
  const [identifying, setIdentifying] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [showHistory, setShowHistory] = useState(false);

  const refresh = async () => {
    setLoading(true);
    setError('');
    try {
      setAccounts(await window.desktopBridge?.getWechatAccounts() || []);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) void refresh();
  }, [isOpen]);

  const visibleAccounts = useMemo(() => accounts.filter((account) => {
    if (account.healthStatus === 'online') return true;
    return showHistory
      && account.identityStatus === 'identified'
      && Boolean(account.externalAccountId)
      && Boolean(account.wechatName)
      && Boolean(account.wechatId);
  }).sort((left, right) => {
    if (left.healthStatus === right.healthStatus) return (left.wechatName || left.alias).localeCompare(right.wechatName || right.alias, 'zh-CN');
    return left.healthStatus === 'online' ? -1 : 1;
  }), [accounts, showHistory]);
  const historyCount = accounts.filter(
    (account) => account.healthStatus !== 'online'
      && account.identityStatus === 'identified'
      && Boolean(account.externalAccountId)
      && Boolean(account.wechatName)
      && Boolean(account.wechatId),
  ).length;
  const pendingOnlineCount = accounts.filter(
    (account) => account.healthStatus === 'online' && (!account.externalAccountId || account.identityStatus !== 'identified'),
  ).length;

  const identify = async (payload: { localAccountId?: string; force?: boolean }, busyKey: string) => {
    setIdentifying(busyKey);
    setError('');
    try {
      const result = await window.desktopBridge?.identifyWechatAccounts(payload);
      if (result) setAccounts(result.accounts);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setIdentifying(null);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center p-4 sm:p-6">
          <motion.button
            type="button"
            aria-label="关闭微信账号窗口"
            className="absolute inset-0 bg-slate-950/40 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.section
            role="dialog"
            aria-modal="true"
            aria-label="已登录微信账号"
            initial={{ opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 12 }}
            className="relative w-full max-w-3xl overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-2xl"
          >
            <header className="flex items-start justify-between border-b border-slate-100 px-6 py-5">
              <div>
                <h2 className="text-lg font-bold text-slate-900">已登录微信账号</h2>
                <p className="mt-1 text-xs text-slate-500">查看不会操作微信；只有点击身份识别按钮才会依次打开个人资料。</p>
              </div>
              <button type="button" className="rounded-xl p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700" onClick={onClose}>
                <XCircle size={20} />
              </button>
            </header>

            <div className="max-h-[58vh] overflow-y-auto p-6">
              {error && <div className="mb-4 rounded-xl bg-rose-50 px-4 py-3 text-xs font-semibold text-rose-700">{error}</div>}
              {loading && accounts.length === 0 ? (
                <div className="flex h-40 items-center justify-center gap-2 text-sm text-slate-500"><LoaderCircle className="animate-spin" size={18} />正在刷新窗口状态</div>
              ) : visibleAccounts.length === 0 ? (
                <div className="flex h-40 items-center justify-center text-sm text-slate-500">暂未检测到微信账号记录</div>
              ) : (
                <div className="space-y-3">
                  {visibleAccounts.map((account) => {
                    const online = account.healthStatus === 'online';
                    const identified = account.identityStatus === 'identified' && Boolean(account.externalAccountId);
                    const rowBusy = identifying === account.localAccountId;
                    return (
                      <div key={account.localAccountId} className="grid grid-cols-[1fr_1fr_auto] items-center gap-4 rounded-2xl border border-slate-200 px-4 py-4">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-bold text-slate-900">{account.wechatName || (online ? '未识别窗口' : account.alias)}</div>
                          <div className="mt-1 text-xs text-slate-500">微信号：{account.wechatId || '—'}</div>
                        </div>
                        <div className="flex items-center gap-2 text-xs font-semibold">
                          {identified ? <CheckCircle2 size={16} className="text-emerald-500" /> : <Search size={16} className="text-amber-500" />}
                          <span className={online ? 'text-slate-700' : 'text-slate-400'}>{statusLabel(account)}</span>
                          {online && <span className="rounded-full bg-emerald-50 px-2 py-1 text-[10px] text-emerald-700">窗口在线</span>}
                        </div>
                        <button
                          type="button"
                          disabled={!online || Boolean(identifying)}
                          onClick={() => void identify({ localAccountId: account.localAccountId, force: true }, account.localAccountId)}
                          className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {rowBusy ? '识别中…' : identified ? '重新识别' : '识别'}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 bg-slate-50 px-6 py-4">
              <div className="flex flex-wrap items-center gap-4">
                <span className="text-xs text-slate-500">{pendingOnlineCount ? `${pendingOnlineCount} 个在线窗口待识别` : '当前在线窗口均已确认身份'}</span>
                <label className="flex cursor-pointer items-center gap-2 text-xs font-semibold text-slate-600">
                  <input
                    type="checkbox"
                    checked={showHistory}
                    onChange={(event) => setShowHistory(event.target.checked)}
                    className="h-4 w-4 rounded border-slate-300 accent-emerald-600"
                  />
                  显示历史账号{historyCount ? ` (${historyCount})` : ''}
                </label>
              </div>
              <div className="flex gap-2">
                <button type="button" disabled={loading || Boolean(identifying)} onClick={() => void refresh()} className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-bold text-slate-700 hover:bg-slate-100 disabled:opacity-50">
                  <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />刷新窗口状态
                </button>
                <button type="button" disabled={!pendingOnlineCount || Boolean(identifying)} onClick={() => void identify({ force: false }, 'all')} className="flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-xs font-bold text-white shadow-lg shadow-emerald-100 hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40">
                  {identifying === 'all' ? <LoaderCircle size={14} className="animate-spin" /> : <Search size={14} />}
                  {identifying === 'all' ? '正在依次识别…' : '识别未确认窗口'}
                </button>
              </div>
            </footer>
          </motion.section>
        </div>
      )}
    </AnimatePresence>
  );
}
