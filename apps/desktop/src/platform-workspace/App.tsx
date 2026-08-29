import {
  ArrowLeft,
  ArrowRight,
  MoreVertical,
  Plus,
  Radio,
  RefreshCw,
  RotateCcw,
  Store,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

type RuntimeStatus = 'idle' | 'queued' | 'loading' | 'ready' | 'error' | 'paused';
type CollectionStatus = 'idle' | 'watching' | 'collecting' | 'login_required' | 'risk_control' | 'error' | 'paused';

interface WorkspaceAccount {
  id: string;
  alias: string;
  paused: boolean;
  createdAt: string;
  lastOpenedAt: string | null;
  platformAccountId: string | null;
  platformAccountLogoUrl: string | null;
  platformAccountServiceUsername?: string | null;
  platformAccountCsId?: string | null;
  platformAccountCsUid?: string | null;
  platformAccountIsMallOwner?: boolean;
  loginStatus: 'unknown' | 'login_required' | 'online' | 'offline' | 'risk_control' | 'account_mismatch' | 'error' | 'paused';
  runtimeStatus: RuntimeStatus;
  collectionStatus: CollectionStatus;
  lastCollectedAt: string | null;
}

function StoreLogoBadge({ logoUrl, runtimeStatus }: { logoUrl: string | null; runtimeStatus: RuntimeStatus }) {
  const [failed, setFailed] = useState(false);
  const showImage = Boolean(logoUrl && !failed);
  return (
    <span className="relative flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-sm border border-slate-100 bg-orange-50 text-orange-500">
      {showImage ? (
        <img
          src={logoUrl || ''}
          alt=""
          className="h-full w-full rounded-sm object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <Store size={15} strokeWidth={2.1} />
      )}
      <span className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border border-white ${statusColors[runtimeStatus]}`} />
    </span>
  );
}

interface WorkspaceState {
  accounts: WorkspaceAccount[];
  archivedAccounts: WorkspaceAccount[];
  activeAccountId: string | null;
  navigation: {
    canGoBack?: boolean;
    canGoForward?: boolean;
    isLoading?: boolean;
  };
  rpa: {
    status: 'stopped' | 'starting' | 'online' | 'offline' | 'error';
    nodeId?: string | null;
    detail?: string | null;
    lastHeartbeatAt?: string | null;
  };
}

type ModalState =
  | { type: 'restore' }
  | { type: 'rename'; account: WorkspaceAccount }
  | {
    type: 'confirm-detected-name';
    account: WorkspaceAccount;
    detectedName: string;
    source: 'dom' | 'document_title' | 'pdd_api_latest_conversations' | 'pdd_api_custom_service_info' | 'pdd_api_userinfo_realtime' | 'pdd_api_shop_info';
  }
  | { type: 'remove'; account: WorkspaceAccount }
  | null;

const EMPTY_STATE: WorkspaceState = {
  accounts: [],
  archivedAccounts: [],
  activeAccountId: null,
  navigation: {},
  rpa: { status: 'stopped' },
};

const rpaLabels: Record<WorkspaceState['rpa']['status'], string> = {
  stopped: 'RPA 未启动',
  starting: 'RPA 启动中',
  online: 'RPA 在线',
  offline: 'RPA 离线',
  error: 'RPA 异常',
};

const statusLabels: Record<RuntimeStatus, string> = {
  idle: '待打开',
  queued: '排队加载中',
  loading: '加载中',
  ready: '页面已加载',
  error: '页面异常',
  paused: '已暂停',
};

const statusColors: Record<RuntimeStatus, string> = {
  idle: 'bg-slate-300',
  queued: 'bg-sky-400',
  loading: 'bg-amber-400',
  ready: 'bg-emerald-500',
  error: 'bg-rose-500',
  paused: 'bg-slate-400',
};

const collectionLabels: Record<CollectionStatus, string> = {
  idle: '采集待启动',
  watching: '正在监听',
  collecting: '采集正常',
  login_required: '等待登录',
  risk_control: '需要人工验证',
  error: '采集异常',
  paused: '采集已暂停',
};


function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': /, '') : '操作失败';
}

export default function PinduoduoWorkspaceApp() {
  const [state, setState] = useState<WorkspaceState>(EMPTY_STATE);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [modal, setModal] = useState<ModalState>(null);

  const activeAccount = useMemo(
    () => state.accounts.find((account) => account.id === state.activeAccountId),
    [state.accounts, state.activeAccountId],
  );

  useEffect(() => {
    const bridge = window.pddWorkspace;
    if (!bridge) {
      setError('此页面需要在 AI 智能客服桌面应用中打开');
      setReady(true);
      return;
    }
    const unsubscribe = bridge.onStateChanged((nextState) => {
      setState(nextState);
      setReady(true);
    });
    void bridge
      .getState()
      .then((nextState) => {
        setState(nextState);
        setReady(true);
      })
      .catch((reason) => {
        setError(errorMessage(reason));
        setReady(true);
      });
    return unsubscribe;
  }, []);

  const overlayOpen = modal !== null;
  useEffect(() => {
    void window.pddWorkspace?.setOverlayOpen(overlayOpen);
  }, [overlayOpen]);

  const perform = async (operation: () => Promise<WorkspaceState>) => {
    setBusy(true);
    setError('');
    setStatusMessage('');
    try {
      const nextState = await operation();
      setState(nextState);
      return nextState;
    } catch (reason) {
      setError(errorMessage(reason));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const addAccount = () => {
    setModal(null);
    void perform(() => window.pddWorkspace.addAccount());
  };

  const openAccountMenu = async (account: WorkspaceAccount) => {
    setError('');
    setStatusMessage('');
    try {
      const action = await window.pddWorkspace.showAccountMenu(account.id);
      if (action === 'rename') {
        setModal({ type: 'rename', account });
      } else if (action === 'reidentify') {
        setBusy(true);
        setStatusMessage('正在通过店铺信息接口识别店铺名称...');
        try {
          const detection = await window.pddWorkspace.detectAccountName(account.id);
          const detectedName = typeof detection?.accountName === 'string' ? detection.accountName.trim() : '';
          const source = detection?.source;
          setStatusMessage('');
          if (!detectedName || !source) {
            setError('店铺名称识别未返回有效名称，请刷新拼多多客服页面后重试。');
            return;
          }
          setModal({
            type: 'confirm-detected-name',
            account,
            detectedName,
            source,
          });
        } finally {
          setBusy(false);
        }
      } else if (action === 'toggle_paused') {
        void perform(() => window.pddWorkspace.setAccountPaused(account.id, !account.paused));
      } else if (action === 'remove') {
        setModal({ type: 'remove', account });
      }
    } catch (reason) {
      setStatusMessage('');
      setError(errorMessage(reason));
    }
  };

  if (!ready) {
    return <div className="flex h-screen items-center justify-center bg-slate-50 text-sm font-medium text-slate-500">正在打开工作区...</div>;
  }

  return (
    <div className="h-screen w-full overflow-hidden bg-slate-50 text-slate-900">
      <header className="relative z-20 flex h-[72px] items-center border-b border-slate-200 bg-white px-4 shadow-sm">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className="flex shrink-0 items-center gap-2 border-r border-slate-200 pr-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-md bg-rose-600 text-white">
              <Store size={19} />
            </div>
            <div className="hidden xl:block">
              <div className="text-sm font-bold">拼多多工作区</div>
              <div className="text-[11px] text-slate-500">
                {activeAccount
                  ? activeAccount.loginStatus === 'account_mismatch'
                    ? '登录店铺不匹配 · 已停止自动化'
                    : `${statusLabels[activeAccount.runtimeStatus]} · ${collectionLabels[activeAccount.collectionStatus]}`
                  : '未选择店铺'}
              </div>
            </div>
          </div>

          <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-2" aria-label="拼多多店铺">
            {state.accounts.map((account) => {
              const active = account.id === state.activeAccountId;
              return (
                <div key={account.id} className="relative flex shrink-0 items-center">
                  <button
                    type="button"
                    onClick={() => {
                      if (!account.paused) void perform(() => window.pddWorkspace.selectAccount(account.id));
                    }}
                    className={`flex h-10 max-w-52 items-center gap-2 rounded-l-md border px-3 text-left text-sm transition-colors ${
                      active
                        ? 'border-rose-200 bg-rose-50 font-semibold text-rose-700'
                        : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                    }`}
                    title={account.alias}
                  >
                    <StoreLogoBadge logoUrl={account.platformAccountLogoUrl} runtimeStatus={account.runtimeStatus} />
                    <span className="truncate">{account.alias}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void openAccountMenu(account)}
                    disabled={busy}
                    className={`flex h-10 w-8 items-center justify-center rounded-r-md border border-l-0 transition-colors ${
                      active
                        ? 'border-rose-200 bg-rose-50 text-rose-600 hover:bg-rose-100'
                        : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50'
                    }`}
                    aria-label={`${account.alias}菜单`}
                    title="店铺菜单"
                  >
                    <MoreVertical size={16} />
                  </button>
                </div>
              );
            })}

            <button
              type="button"
              onClick={addAccount}
              disabled={busy}
              className="ml-1 flex h-10 shrink-0 items-center gap-2 rounded-md border border-dashed border-slate-300 px-3 text-sm font-semibold text-slate-600 hover:border-rose-300 hover:bg-rose-50 hover:text-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Plus size={16} />
              添加店铺
            </button>
            {state.archivedAccounts.length > 0 && (
              <button
                type="button"
                onClick={() => setModal({ type: 'restore' })}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 hover:bg-slate-50 hover:text-slate-800"
                aria-label="恢复已移除店铺"
                title="恢复已移除店铺"
              >
                <RotateCcw size={16} />
              </button>
            )}
          </nav>

          <div
            className={`hidden shrink-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-xs font-semibold lg:flex ${
              state.rpa.status === 'online'
                ? 'bg-emerald-50 text-emerald-700'
                : state.rpa.status === 'starting'
                  ? 'bg-amber-50 text-amber-700'
                  : 'bg-slate-100 text-slate-600'
            }`}
            title={state.rpa.detail || (state.rpa.nodeId ? `节点 ${state.rpa.nodeId}` : rpaLabels[state.rpa.status])}
          >
            <Radio size={14} />
            {rpaLabels[state.rpa.status]}
          </div>

          <div className="flex shrink-0 items-center gap-1 border-l border-slate-200 pl-3">
            <ToolbarButton
              label="后退"
              disabled={!state.navigation.canGoBack || !activeAccount}
              onClick={() => void perform(() => window.pddWorkspace.goBack())}
            >
              <ArrowLeft size={17} />
            </ToolbarButton>
            <ToolbarButton
              label="前进"
              disabled={!state.navigation.canGoForward || !activeAccount}
              onClick={() => void perform(() => window.pddWorkspace.goForward())}
            >
              <ArrowRight size={17} />
            </ToolbarButton>
            <ToolbarButton
              label="刷新"
              disabled={!activeAccount}
              onClick={() => void perform(() => window.pddWorkspace.reload())}
            >
              <RefreshCw size={17} className={state.navigation.isLoading ? 'animate-spin' : ''} />
            </ToolbarButton>
          </div>
        </div>

        {(statusMessage || error) && (
          <div
            className={`fixed right-4 top-20 z-[80] flex max-w-[min(520px,calc(100vw-2rem))] items-start gap-2 rounded-md border bg-white px-3 py-2 text-xs font-medium leading-5 shadow-lg ${
              error
                ? 'border-rose-200 text-rose-700'
                : 'border-sky-200 text-sky-700'
            }`}
          >
            {statusMessage && !error && <RefreshCw size={14} className="mt-0.5 shrink-0 animate-spin" />}
            <span className="min-w-0 whitespace-normal break-words">{error || statusMessage}</span>
            <button
              type="button"
              onClick={() => {
                setError('');
                setStatusMessage('');
              }}
              className="mt-0.5 shrink-0"
              aria-label="关闭提示"
              title="关闭"
            >
              <X size={14} />
            </button>
          </div>
        )}
      </header>

      {!activeAccount && (
        <main className="flex h-[calc(100vh-72px)] items-center justify-center bg-slate-50">
          <div className="flex flex-col items-center gap-4 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-400 shadow-sm">
              <Store size={27} />
            </div>
            <div>
              <h1 className="text-base font-bold text-slate-800">暂无运行中的店铺</h1>
              <p className="mt-1 text-sm text-slate-500">添加或恢复一个拼多多店铺</p>
            </div>
            <button
              type="button"
              onClick={addAccount}
              disabled={busy}
              className="flex items-center gap-2 rounded-md bg-rose-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Plus size={17} />
              添加店铺
            </button>
            {state.archivedAccounts.length > 0 && (
              <button
                type="button"
                onClick={() => setModal({ type: 'restore' })}
                className="flex h-10 w-10 items-center justify-center rounded-md border border-slate-300 bg-white text-slate-500 hover:bg-slate-50 hover:text-slate-800"
                aria-label="恢复已移除店铺"
                title="恢复已移除店铺"
              >
                <RotateCcw size={17} />
              </button>
            )}
          </div>
        </main>
      )}

      {modal?.type === 'restore' && (
        <RestoreAccountsModal
          busy={busy}
          archivedAccounts={state.archivedAccounts}
          onClose={() => setModal(null)}
          onRestore={async (accountId) => {
            const succeeded = await perform(() => window.pddWorkspace.restoreAccount(accountId));
            if (succeeded) setModal(null);
          }}
        />
      )}

      {modal?.type === 'rename' && (
        <RenameAccountModal
          account={modal.account}
          busy={busy}
          onClose={() => setModal(null)}
          onRename={async (alias) => {
            const succeeded = await perform(() => window.pddWorkspace.renameAccount(modal.account.id, alias));
            if (succeeded) setModal(null);
          }}
        />
      )}

      {modal?.type === 'remove' && (
        <RemoveAccountModal
          account={modal.account}
          busy={busy}
          onClose={() => setModal(null)}
          onRemove={async (clearStorage) => {
            const succeeded = await perform(() => window.pddWorkspace.removeAccount(modal.account.id, clearStorage));
            if (succeeded) setModal(null);
          }}
        />
      )}

      {modal?.type === 'confirm-detected-name' && (
        <ConfirmDetectedNameModal
          account={modal.account}
          detectedName={modal.detectedName}
          source={modal.source}
          busy={busy}
          onClose={() => setModal(null)}
          onConfirm={async () => {
            const succeeded = await perform(() => (
              window.pddWorkspace.renameAccount(modal.account.id, modal.detectedName)
            ));
            if (succeeded) setModal(null);
          }}
        />
      )}
    </div>
  );
}

function ToolbarButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex h-9 w-9 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-35"
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}

function ModalFrame({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/30 p-6">
      <section className="w-full max-w-md rounded-md border border-slate-200 bg-white shadow-2xl" role="dialog" aria-modal="true" aria-label={title}>
        <header className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <h2 className="text-base font-bold text-slate-900">{title}</h2>
          <button type="button" onClick={onClose} className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="关闭" title="关闭">
            <X size={18} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

function RestoreAccountsModal({
  archivedAccounts,
  busy,
  onClose,
  onRestore,
}: {
  archivedAccounts: WorkspaceAccount[];
  busy: boolean;
  onClose: () => void;
  onRestore: (accountId: string) => Promise<void>;
}) {
  return (
    <ModalFrame title="恢复已移除店铺" onClose={onClose}>
      <div className="p-5">
        <div className="max-h-64 space-y-1 overflow-y-auto">
          {archivedAccounts.map((account) => (
            <button
              key={account.id}
              type="button"
              disabled={busy}
              onClick={() => void onRestore(account.id)}
              className="flex w-full items-center justify-between rounded-md px-3 py-2.5 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              <span className="truncate">{account.alias}</span>
              <span className="flex items-center gap-1 text-xs font-semibold text-rose-600"><RotateCcw size={13} />恢复</span>
            </button>
          ))}
        </div>
      </div>
    </ModalFrame>
  );
}

function RenameAccountModal({ account, busy, onClose, onRename }: { account: WorkspaceAccount; busy: boolean; onClose: () => void; onRename: (alias: string) => Promise<void> }) {
  const [alias, setAlias] = useState(account.alias);
  return (
    <ModalFrame title="重命名店铺" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void onRename(alias);
        }}
        className="p-5"
      >
        <label className="block text-sm font-semibold text-slate-700" htmlFor="pdd-rename-alias">店铺名称</label>
        <input
          id="pdd-rename-alias"
          value={alias}
          onChange={(event) => setAlias(event.target.value)}
          maxLength={64}
          autoFocus
          className="mt-2 w-full rounded-md border border-slate-300 px-3 py-2.5 text-sm outline-none focus:border-rose-500 focus:ring-2 focus:ring-rose-100"
        />
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50">取消</button>
          <button type="submit" disabled={busy || !alias.trim()} className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50">保存</button>
        </div>
      </form>
    </ModalFrame>
  );
}

function ConfirmDetectedNameModal({
  account,
  detectedName,
  source,
  busy,
  onClose,
  onConfirm,
}: {
  account: WorkspaceAccount;
  detectedName: string;
  source: 'dom' | 'document_title' | 'pdd_api_latest_conversations' | 'pdd_api_custom_service_info' | 'pdd_api_userinfo_realtime' | 'pdd_api_shop_info';
  busy: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const sourceLabel = source === 'pdd_api_custom_service_info'
    ? '店铺信息接口'
    : source === 'pdd_api_userinfo_realtime'
      ? '客服实时信息接口'
      : source === 'pdd_api_shop_info'
        ? '店铺信息接口'
        : source === 'pdd_api_latest_conversations'
          ? 'latest_conversations 接口'
          : source === 'document_title' ? '客服接待页面标题' : '客服接待页面内容';
  return (
    <ModalFrame title="确认店铺名称" onClose={onClose}>
      <div className="p-5">
        <dl className="space-y-4 text-sm">
          <div>
            <dt className="font-semibold text-slate-500">当前名称</dt>
            <dd className="mt-1 break-words text-slate-800">{account.alias}</dd>
          </div>
          <div className="border-t border-slate-200 pt-4">
            <dt className="font-semibold text-slate-500">识别到的名称</dt>
            <dd className="mt-1 break-words text-base font-semibold text-slate-900">{detectedName}</dd>
            <dd className="mt-1 text-xs text-slate-400">
              来源：{sourceLabel}
            </dd>
          </div>
        </dl>
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="rounded-md border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50">取消</button>
          <button type="button" onClick={() => void onConfirm()} disabled={busy} className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50">确认替换</button>
        </div>
      </div>
    </ModalFrame>
  );
}

function RemoveAccountModal({ account, busy, onClose, onRemove }: { account: WorkspaceAccount; busy: boolean; onClose: () => void; onRemove: (clearStorage: boolean) => Promise<void> }) {
  const [clearStorage, setClearStorage] = useState(false);
  return (
    <ModalFrame title="移除店铺" onClose={onClose}>
      <div className="p-5">
        <p className="text-sm leading-6 text-slate-600">将从工作区移除“{account.alias}”。保留浏览器资料时，可以稍后从添加店铺窗口恢复。</p>
        <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-md border border-rose-200 bg-rose-50 p-3">
          <input type="checkbox" checked={clearStorage} onChange={(event) => setClearStorage(event.target.checked)} className="mt-0.5 h-4 w-4 accent-rose-600" />
          <span>
            <span className="block text-sm font-semibold text-rose-800">同时清除本机浏览器资料</span>
            <span className="mt-0.5 block text-xs leading-5 text-rose-600">Cookie、缓存和登录态将无法恢复。</span>
          </span>
        </label>
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50">取消</button>
          <button type="button" disabled={busy} onClick={() => void onRemove(clearStorage)} className="rounded-md bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-700 disabled:opacity-50">确认移除</button>
        </div>
      </div>
    </ModalFrame>
  );
}
