import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, LayoutGrid, MoreVertical, Pause, Play, Plus, RefreshCw, Search, Store } from 'lucide-react';

type PlatformCode = 'pinduoduo' | 'douyin';
type Filter = 'all' | PlatformCode;
export interface Account {
  id: string;
  accountId: string;
  platformCode: PlatformCode;
  platformName: string;
  alias: string;
  paused: boolean;
  loginStatus: string;
  runtimeStatus: string;
  collectionStatus: string;
  statusDetail?: string | null;
  platformAccountId?: string | null;
  lastOpenedAt?: string | null;
}
export interface WorkspaceState {
  activePlatform: PlatformCode | null;
  activeAccountKey: string | null;
  platformFilter: Filter;
  accounts: Account[];
  archivedAccounts: Account[];
  navigation: { canGoBack?: boolean; canGoForward?: boolean; isLoading?: boolean };
  rpa: { status: string; detail?: string | null };
  platformHealth: Record<PlatformCode, { accountCount: number; onlineCount: number; errorCount: number }>;
}

const emptyState: WorkspaceState = {
  activePlatform: null, activeAccountKey: null, platformFilter: 'all', accounts: [], archivedAccounts: [],
  navigation: {}, rpa: { status: 'stopped' },
  platformHealth: { pinduoduo: { accountCount: 0, onlineCount: 0, errorCount: 0 }, douyin: { accountCount: 0, onlineCount: 0, errorCount: 0 } },
};

const statusText = (account: Account) => {
  if (account.paused) return '已暂停';
  if (account.loginStatus === 'login_required') return '等待登录';
  if (account.runtimeStatus === 'error' || account.loginStatus === 'error') return '页面异常';
  if (account.loginStatus === 'online' || account.runtimeStatus === 'ready') return '已连接';
  return account.statusDetail || '准备中';
};

export default function AggregatedPlatformWorkspaceApp() {
  const [state, setState] = useState(emptyState);
  const [search, setSearch] = useState('');
  const hostRef = useRef<HTMLDivElement>(null);
  const refreshBounds = useCallback(() => {
    const rect = hostRef.current?.getBoundingClientRect();
    if (!rect || !window.platformWorkspace) return;
    void window.platformWorkspace.setPageBounds({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }).catch(() => undefined);
  }, []);

  useEffect(() => {
    let alive = true;
    void window.platformWorkspace?.getState().then((next) => { if (alive && next) setState(next); }).catch(() => undefined);
    const off = window.platformWorkspace?.onStateChanged((next) => alive && setState(next));
    const observer = new ResizeObserver(refreshBounds);
    if (hostRef.current) observer.observe(hostRef.current);
    window.addEventListener('resize', refreshBounds);
    return () => { alive = false; off?.(); observer.disconnect(); window.removeEventListener('resize', refreshBounds); };
  }, [refreshBounds]);

  const visibleAccounts = useMemo(() => state.accounts.filter((account) => {
    if (state.platformFilter !== 'all' && account.platformCode !== state.platformFilter) return false;
    const needle = search.trim().toLowerCase();
    return !needle || `${account.alias} ${account.platformName} ${account.platformAccountId || ''}`.toLowerCase().includes(needle);
  }), [search, state.accounts, state.platformFilter]);
  const active = state.accounts.find((account) => account.id === state.activeAccountKey) || null;
  const run = (task: Promise<unknown>) => void task.catch((error) => console.error(error));
  const select = (account: Account) => run(window.platformWorkspace!.selectAccount(account.platformCode, account.accountId));

  useEffect(() => { refreshBounds(); }, [refreshBounds, state.activeAccountKey]);

  return <div className="flex h-screen w-full flex-col overflow-hidden bg-slate-100 text-slate-900">
    <header className="flex h-[72px] shrink-0 items-center justify-between border-b border-slate-200 bg-white px-5 shadow-sm">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-sky-600 text-white"><LayoutGrid size={21} /></div>
        <div><div className="text-sm font-bold">多平台工作台</div><div className="text-xs text-slate-500">{active ? `${active.platformName} · ${active.alias}` : '请选择一个店铺'}</div></div>
      </div>
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <span className="rounded-full bg-slate-100 px-3 py-1">RPA {state.rpa.status}</span>
        <button type="button" title="后退" disabled={!state.navigation.canGoBack} onClick={() => run(window.platformWorkspace!.goBack())} className="rounded-md p-2 hover:bg-slate-100 disabled:opacity-30"><ChevronLeft size={17} /></button>
        <button type="button" title="前进" disabled={!state.navigation.canGoForward} onClick={() => run(window.platformWorkspace!.goForward())} className="rounded-md p-2 hover:bg-slate-100 disabled:opacity-30"><ChevronRight size={17} /></button>
        <button type="button" title="刷新" onClick={() => run(window.platformWorkspace!.reload())} className="rounded-md p-2 hover:bg-slate-100"><RefreshCw size={16} /></button>
      </div>
    </header>
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-[320px] shrink-0 flex-col border-r border-slate-200 bg-white">
        <div className="border-b border-slate-100 p-4">
          <div className="relative"><Search size={15} className="absolute left-3 top-2.5 text-slate-400" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索店铺" className="w-full rounded-md border border-slate-200 py-2 pl-9 pr-3 text-sm outline-none focus:border-sky-400" /></div>
          <div className="mt-3 flex gap-1 rounded-md bg-slate-100 p-1">
            {(['all', 'pinduoduo', 'douyin'] as Filter[]).map((filter) => <button key={filter} type="button" onClick={() => run(window.platformWorkspace!.setPlatformFilter(filter))} className={`flex-1 rounded px-2 py-1.5 text-xs ${state.platformFilter === filter ? 'bg-white font-semibold text-sky-700 shadow-sm' : 'text-slate-500'}`}>{filter === 'all' ? '全部' : filter === 'pinduoduo' ? '拼多多' : '抖店'}</button>)}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          {visibleAccounts.map((account) => <div key={account.id} className={`mb-2 flex items-center gap-2 rounded-lg border p-3 ${account.id === state.activeAccountKey ? 'border-sky-300 bg-sky-50' : 'border-slate-200 bg-white'}`}>
            <button type="button" onClick={() => !account.paused && select(account)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
              <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md ${account.platformCode === 'douyin' ? 'bg-slate-900 text-white' : 'bg-rose-100 text-rose-600'}`}><Store size={17} /></div>
              <div className="min-w-0"><div className="truncate text-sm font-semibold">{account.alias}</div><div className="mt-0.5 truncate text-[11px] text-slate-500">{account.platformName} · {statusText(account)}</div></div>
            </button>
            <button type="button" title={account.paused ? '恢复运行' : '暂停运行'} onClick={() => run(window.platformWorkspace!.callAccount({ platformCode: account.platformCode, accountId: account.accountId, method: 'setAccountPaused', args: [!account.paused] }))} className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700">{account.paused ? <Play size={15} /> : <Pause size={15} />}</button>
            <button type="button" title="重命名" onClick={() => { const alias = window.prompt('店铺别名', account.alias); if (alias?.trim()) run(window.platformWorkspace!.callAccount({ platformCode: account.platformCode, accountId: account.accountId, method: 'renameAccount', args: [alias.trim()] })); }} className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"><MoreVertical size={15} /></button>
          </div>)}
          {!visibleAccounts.length && <div className="py-10 text-center text-sm text-slate-400">暂无匹配店铺</div>}
        </div>
        <div className="grid grid-cols-2 gap-2 border-t border-slate-100 p-3">
          <button type="button" onClick={() => run(window.platformWorkspace!.addAccount('pinduoduo'))} className="flex items-center justify-center gap-1 rounded-md border border-rose-200 px-2 py-2 text-xs text-rose-600 hover:bg-rose-50"><Plus size={14} />拼多多</button>
          <button type="button" onClick={() => run(window.platformWorkspace!.addAccount('douyin'))} className="flex items-center justify-center gap-1 rounded-md border border-slate-300 px-2 py-2 text-xs text-slate-700 hover:bg-slate-50"><Plus size={14} />抖店</button>
        </div>
      </aside>
      <main className="relative min-w-0 flex-1 bg-slate-50">
        <div className="absolute inset-x-0 top-0 z-10 flex h-10 items-center justify-between border-b border-slate-200 bg-white/95 px-4 text-xs text-slate-500 backdrop-blur">
          <span>{active ? `${active.platformName} / ${active.alias}` : '未选择店铺'}</span><span>{active ? statusText(active) : '添加店铺后开始使用'}</span>
        </div>
        <div ref={hostRef} id="platform-page-host" className="absolute inset-x-0 bottom-0 top-10 overflow-hidden" />
        {!active && <div className="absolute inset-0 flex items-center justify-center pt-10 text-sm text-slate-400"><div className="text-center"><Store className="mx-auto mb-3 text-slate-300" size={34} /><div>选择店铺以打开平台页面</div></div></div>}
      </main>
    </div>
  </div>;
}
