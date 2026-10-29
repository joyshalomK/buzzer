import { useEffect, useRef, useState } from 'react';
import { serverClock } from '../lib/serverClock';

/** Server-clock "now", re-rendering every `intervalMs` while `active`. */
export function useServerNow(active: boolean, intervalMs = 100) {
  const [now, setNow] = useState(() => serverClock.now());
  useEffect(() => {
    setNow(serverClock.now());
    if (!active) return;
    const id = window.setInterval(() => setNow(serverClock.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [active, intervalMs]);
  return now;
}

/** Calls `fn` once when the server clock reaches `serverMs` (+ `delayMs`). */
export function useAtServerTime(serverMs: number | null | undefined, fn: () => void, delayMs = 0) {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    if (serverMs == null) return;
    const wait = serverMs + delayMs - serverClock.now();
    if (wait < -5000) return; // long past: nothing to wake up for
    const id = window.setTimeout(() => fnRef.current(), Math.max(0, wait));
    return () => window.clearTimeout(id);
  }, [serverMs, delayMs]);
}
