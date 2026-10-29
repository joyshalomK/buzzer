import type { SyncPhase } from '../lib/syncView';

interface Props {
  phase: SyncPhase;
  enabled: boolean;
  countdown: number | null;
  onPress: () => void;
}

/** Huge circular SYNC button. Fires on pointerdown (not click) to shave latency. */
export function SyncButton({ phase, enabled, countdown, onPress }: Props) {
  const style =
    phase === 'GO'
      ? 'buzzer-armed bg-gradient-to-b from-cyan-300 to-sky-600 shadow-[0_14px_0_#075985,0_0_70px_rgba(34,211,238,0.6)] text-white'
      : phase === 'PRESSED'
        ? 'bg-gradient-to-b from-sky-500 to-sky-700 shadow-[0_4px_0_#0c4a6e] translate-y-2 text-white/90'
        : phase === 'COUNTDOWN'
          ? 'bg-gradient-to-b from-slate-500 to-slate-600 shadow-[0_12px_0_#334155] text-amber-200 ring-4 ring-amber-300/70'
          : phase === 'READY'
            ? 'bg-gradient-to-b from-slate-500 to-slate-600 shadow-[0_12px_0_#334155] text-white/70 ring-4 ring-cyan-300/60'
            : 'bg-gradient-to-b from-slate-500 to-slate-700 shadow-[0_12px_0_#1e293b] text-white/45';

  const label = phase === 'COUNTDOWN' && countdown ? String(countdown) : phase === 'PRESSED' ? '✓' : 'SYNC!';

  return (
    <button
      type="button"
      disabled={!enabled}
      aria-label="싱크 버튼"
      aria-disabled={!enabled}
      onPointerDown={(e) => {
        e.preventDefault();
        if (enabled) onPress();
      }}
      onKeyDown={(e) => {
        if (enabled && (e.key === ' ' || e.key === 'Enter')) {
          e.preventDefault();
          onPress();
        }
      }}
      onContextMenu={(e) => e.preventDefault()}
      className={`relative aspect-square w-[70vw] max-w-[22rem] select-none rounded-full font-display text-[clamp(2.75rem,14vw,5rem)]
        tracking-wide transition-[transform,box-shadow,background] duration-100 touch-none
        active:enabled:translate-y-2 disabled:cursor-not-allowed ${style}`}
    >
      <span className="pointer-events-none absolute inset-[7%] rounded-full border-4 border-white/20" />
      {phase === 'GO' && <span className="sync-ring pointer-events-none absolute inset-0 rounded-full" />}
      <span key={label} className={`relative drop-shadow-[0_3px_0_rgba(0,0,0,0.25)] ${phase === 'COUNTDOWN' ? 'winner-pop text-[1.4em]' : ''}`}>
        {label}
      </span>
    </button>
  );
}
