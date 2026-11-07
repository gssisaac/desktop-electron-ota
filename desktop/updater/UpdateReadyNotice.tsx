'use client';

import { useEffect, useState } from 'react';

/** Exposed by `desktop/src/preload/bridge.js`. Absent in a browser and in `next dev`. */
type DesktopOta = {
  pendingUpdate: () => Promise<string | null>;
  onUpdateReady: (listener: (payload: { version: string }) => void) => () => void;
  applyPendingUpdate: () => Promise<void>;
};

function desktopOta(): DesktopOta | null {
  if (typeof window === 'undefined') return null;
  return (window as Window & { desktopOta?: DesktopOta }).desktopOta ?? null;
}

/**
 * Bottom-left notice once a newer bundle has downloaded. Copy this into the Next.js app shell
 * and mount it once. The running bundle stays put until Refresh.
 *
 * No dependency on the desktop shell: it reads `window.desktopOta`, which only the launcher's
 * preload defines, so the same component is a no-op on the web.
 */
export function UpdateReadyNotice() {
  const [version, setVersion] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const desktop = desktopOta();
    if (!desktop) return;
    let alive = true;

    const unsubscribe = desktop.onUpdateReady((payload) => {
      if (!alive || !payload?.version) return;
      setVersion(payload.version);
      setError(null);
    });

    void desktop
      .pendingUpdate()
      .then((pending) => {
        if (alive && pending) setVersion(pending);
      })
      .catch(() => {
        // The shell has not finished booting yet; the event covers it.
      });

    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  if (!version) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        bottom: 12,
        left: 12,
        zIndex: 20,
        width: 300,
        padding: 12,
        border: '1px solid rgba(127,127,127,0.35)',
        background: 'Canvas',
        color: 'CanvasText',
        boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
      }}
    >
      <p style={{ margin: 0, fontSize: 12, fontWeight: 600 }}>Update downloaded</p>
      <p style={{ margin: '4px 0 0', fontSize: 11, opacity: 0.75 }}>
        __APP_NAME__ {version} is ready. Refresh to start using it.
      </p>
      {error ? <p style={{ margin: '8px 0 0', fontSize: 11, color: '#b91c1c' }}>{error}</p> : null}
      <div style={{ marginTop: 10, display: 'flex', justifyContent: 'flex-end' }}>
        <button
          type="button"
          disabled={refreshing}
          onClick={() => {
            const desktop = desktopOta();
            if (!desktop) return;
            setRefreshing(true);
            setError(null);
            void desktop.applyPendingUpdate().catch((err: unknown) => {
              setRefreshing(false);
              setError(err instanceof Error ? err.message : 'Could not refresh. Try again.');
            });
          }}
        >
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
    </div>
  );
}
