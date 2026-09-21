import { Component, StrictMode, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import AppShell from './app/AppShell';
import PinduoduoWorkspaceApp from './platform-workspace/App';
import './index.css';
import MessageNoticeApp from './message-notice/App';
import AggregatedPlatformWorkspaceApp from './platform-workspace/AggregatedApp';

const appView = new URLSearchParams(window.location.search).get('view');
document.body.dataset.appView = appView || 'message-center';

class RendererErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Uncaught React renderer error', error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="flex h-full w-full items-center justify-center bg-slate-50 text-slate-900">
        <section className="w-full max-w-md px-6 text-center">
          <h1 className="text-xl font-semibold">页面加载失败</h1>
          <p className="mt-3 text-sm text-slate-600">桌面界面发生异常，后台服务仍会继续运行。</p>
          <button
            type="button"
            className="mt-6 rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-700"
            onClick={() => window.location.reload()}
          >
            重新加载
          </button>
        </section>
      </main>
    );
  }
}

window.addEventListener('error', (event) => {
  console.error('Uncaught renderer error', event.error || event.message);
});
window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled renderer rejection', event.reason);
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RendererErrorBoundary>
      {appView === 'message-notice' ? <MessageNoticeApp /> : appView === 'platform-workspace' ? <AggregatedPlatformWorkspaceApp /> : appView === 'pinduoduo-workspace' ? <PinduoduoWorkspaceApp />
        : appView === 'douyin-workspace' ? <PinduoduoWorkspaceApp platform="douyin" /> : <AppShell />}
    </RendererErrorBoundary>
  </StrictMode>,
);
