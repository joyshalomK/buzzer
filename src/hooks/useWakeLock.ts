import { useEffect } from 'react';

/** Keeps the phone screen on while the buzzer page is open (where supported). */
export function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let cancelled = false;
    const request = async () => {
      try {
        if (document.visibilityState !== 'visible') return;
        lock = await navigator.wakeLock.request('screen');
        if (cancelled) void lock.release();
      } catch {
        /* denied or unsupported */
      }
    };
    void request();
    const onVis = () => document.visibilityState === 'visible' && void request();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVis);
      void lock?.release().catch(() => {});
    };
  }, [active]);
}
