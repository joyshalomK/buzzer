import type { RealtimeStatus } from '../hooks/useLiveSync';

export function ConnectionBadge({ connected, realtime, compact = false }: {
  connected: boolean;
  realtime: RealtimeStatus;
  compact?: boolean;
}) {
  const [label, dot] = !connected
    ? ['연결 끊김', 'bg-rose-500 animate-pulse']
    : realtime === 'live'
      ? ['실시간', 'bg-emerald-400']
      : ['연결됨 (폴링)', 'bg-amber-400'];
  return (
    <span
      role="status"
      className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1 text-xs font-bold text-white/90"
      title={realtime === 'live' ? 'Realtime 연결됨' : 'Realtime 재연결 중 — 주기적 조회로 동기화'}
    >
      <span className={`h-2.5 w-2.5 rounded-full ${dot}`} />
      {!compact && label}
    </span>
  );
}
