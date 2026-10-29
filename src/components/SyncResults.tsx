import { STATUS_LABEL_KO, formatMs, formatSeconds } from '../lib/syncView';
import type { SyncTeamResult } from '../lib/types';

const MEDAL: Record<number, string> = { 1: '🥇', 2: '🥈', 3: '🥉' };

/** Ranking list used on phones and the admin screen. */
export function SyncResultList({ results, highlightTeamId, showIncomplete = true }: {
  results: SyncTeamResult[];
  highlightTeamId?: string;
  showIncomplete?: boolean;
}) {
  const rows = showIncomplete ? results : results.filter((t) => t.status === 'COMPLETE');
  if (rows.length === 0) return null;
  return (
    <ol className="w-full space-y-2">
      {rows.map((t) => (
        <li
          key={t.team_id}
          className={`rank-in flex items-center gap-3 rounded-2xl px-4 py-3 text-left ring-1
            ${t.team_id === highlightTeamId ? 'bg-cyan-400/20 ring-cyan-300/70' : t.rank === 1 ? 'bg-amber-400/15 ring-amber-300/50' : 'bg-white/5 ring-white/10'}`}
        >
          <span className="w-12 shrink-0 text-center font-display text-2xl text-amber-300">
            {t.rank != null ? MEDAL[t.rank] ?? `${t.rank}위` : '–'}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-lg font-black text-white">{t.team_name}</span>
            <span className="block truncate text-sm text-white/60">
              {t.members.map((m) => `${m.label} ${formatSeconds(m.elapsed_ms)}`).join(' · ')}
            </span>
          </span>
          <span className="shrink-0 text-right">
            {t.status === 'COMPLETE' ? (
              <span className="font-display text-2xl text-cyan-200">{formatMs(t.gap_ms)}</span>
            ) : (
              <span className="text-sm font-bold text-white/50">{STATUS_LABEL_KO[t.status]}</span>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}
