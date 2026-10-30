import { formatPercent } from '../lib/matchView';
import type { MatchFinalRow, MatchOption } from '../lib/types';

const MEDAL: Record<number, string> = { 1: '🥇', 2: '🥈', 3: '🥉' };

/** Final ranking list used on phones. */
export function MatchFinalList({ rows, highlightTeamId }: { rows: MatchFinalRow[]; highlightTeamId?: string }) {
  if (rows.length === 0) return null;
  return (
    <ol className="w-full space-y-2">
      {rows.map((t) => (
        <li
          key={t.team_id}
          className={`rank-in flex items-center gap-3 rounded-2xl px-4 py-3 text-left ring-1
            ${t.team_id === highlightTeamId ? 'bg-pink-400/20 ring-pink-300/70' : t.rank === 1 ? 'bg-amber-400/15 ring-amber-300/50' : 'bg-white/5 ring-white/10'}`}
        >
          <span className="w-12 shrink-0 text-center font-display text-2xl text-amber-300">{MEDAL[t.rank] ?? `${t.rank}위`}</span>
          <span className="min-w-0 flex-1 truncate text-lg font-black text-white">{t.team_name}</span>
          <span className="shrink-0 text-right">
            <span className="block font-display text-xl text-pink-200">{t.matched_count} / {t.total_questions}</span>
            <span className="block text-xs font-bold text-white/55">{formatPercent(t.match_percentage)}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

/** "A" / "B" badge in the option colours. */
export function OptionBadge({ option, className = '' }: { option: MatchOption | null; className?: string }) {
  if (!option) return <span className={`inline-flex items-center justify-center rounded-lg bg-white/10 px-2 font-black text-white/45 ${className}`}>–</span>;
  return (
    <span className={`inline-flex items-center justify-center rounded-lg px-2 font-black text-white ${option === 'A' ? 'bg-rose-500' : 'bg-sky-500'} ${className}`}>
      {option}
    </span>
  );
}
