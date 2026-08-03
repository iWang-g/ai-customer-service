import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import AppShell from './app/AppShell';
import PinduoduoWorkspaceApp from './platform-workspace/App';
import './index.css';

const appView = new URLSearchParams(window.location.search).get('view');
document.body.dataset.appView = appView || 'message-center';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {appView === 'pinduoduo-workspace' ? <PinduoduoWorkspaceApp /> : <AppShell />}
  </StrictMode>,
);
