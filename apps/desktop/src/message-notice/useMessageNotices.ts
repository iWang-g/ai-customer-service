import { useCallback, useEffect, useRef } from 'react';
import { listMessageNotices } from '../shared/api/client';

/** Shares the existing message-center socket. Serial requests coalesce event bursts. */
export function useMessageNotices(userId: string | null, ready: boolean, connection: string) {
  const requestRef = useRef<() => void>(() => {});
  const connectionRef = useRef(connection);
  connectionRef.current = connection;
  const sessionRef = useRef('');

  useEffect(() => {
    const bridge = window.desktopBridge;
    // Vite can hot-reload this renderer before the Electron preload is restarted.
    if (!bridge?.setMessageNoticeOwner || !bridge.publishMessageNotices || !ready) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    let dirty = false;
    let failures = 0;
    let sessionId = '';
    let since = '';
    const run = async () => {
      timer = undefined;
      if (cancelled || !sessionId || !userId) return;
      if (running) { dirty = true; return; }
      running = true;
      dirty = false;
      try {
        const snapshot = await listMessageNotices(since);
        if (cancelled) return;
        failures = 0;
        await bridge.publishMessageNotices({ sessionId, items: snapshot.items,
          clockOffset: Date.parse(snapshot.server_time) - Date.now(),
          status: connectionRef.current === 'connected' ? 'connected' : 'disconnected' });
      } catch (error) {
        if (!cancelled) {
          console.error('消息通知同步失败:', error);
          failures += 1;
          await bridge.publishMessageNotices({ sessionId, status: 'error' }).catch(() => {});
        }
      } finally {
        running = false;
        if (!cancelled && (dirty || failures)) {
          timer = setTimeout(() => void run(), dirty ? 250 : Math.min(30000, 2000 * 2 ** Math.min(failures, 4)));
        }
      }
    };
    const schedule = () => {
      if (cancelled) return;
      if (running) { dirty = true; return; }
      if (!timer) timer = setTimeout(() => void run(), 250);
    };
    requestRef.current = schedule;
    void bridge.setMessageNoticeOwner(userId).then((state) => {
      if (cancelled) return;
      sessionId = state.sessionId;
      sessionRef.current = sessionId;
      since = state.since;
      if (userId) schedule();
    }).catch((error) => console.error('消息通知初始化失败:', error));
    return () => {
      cancelled = true;
      clearTimeout(timer);
      requestRef.current = () => {};
      sessionRef.current = '';
    };
  }, [userId, ready]);

  useEffect(() => {
    if (!userId || !ready) return;
    if (connection === 'connected') requestRef.current();
    else if (sessionRef.current) void window.desktopBridge?.publishMessageNotices({
      sessionId: sessionRef.current, status: connection === 'connecting' ? 'connecting' : 'disconnected',
    }).catch(() => {});
  }, [connection, userId, ready]);

  return useCallback(() => requestRef.current(), []);
}
