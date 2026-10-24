import type { ViewKind } from '../lib/participantView';

interface Props {
  kind: ViewKind;
  enabled: boolean;
  onPress: () => void;
}

/** Huge circular buzzer. Fires on pointerdown (not click) to shave latency. */
export function Buzzer({ kind, enabled, onPress }: Props) {
  const style =
    kind === 'ARMED'
      ? 'buzzer-armed bg-gradient-to-b from-rose-400 to-rose-600 shadow-[0_14px_0_#9f1239,0_0_60px_rgba(251,58,93,0.55)] text-white'
      : kind === 'PRESSED'
        ? 'bg-gradient-to-b from-rose-500 to-rose-700 shadow-[0_4px_0_#881337] translate-y-2 text-white/90'
        : kind === 'WINNER_ME'
          ? 'bg-gradient-to-b from-amber-200 to-amber-500 shadow-[0_12px_0_#b45309,0_0_80px_rgba(251,191,36,0.7)] text-amber-950'
          : kind === 'READY'
            ? 'bg-gradient-to-b from-slate-500 to-slate-600 shadow-[0_12px_0_#334155] text-white/70 ring-4 ring-emerald-400/70'
            : 'bg-gradient-to-b from-slate-500 to-slate-700 shadow-[0_12px_0_#1e293b] text-white/45';

  return (
    <button
      type="button"
      disabled={!enabled}
      aria-label="부저"
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
      <span className="relative drop-shadow-[0_3px_0_rgba(0,0,0,0.25)]">
        {kind === 'WINNER_ME' ? '1등!' : 'BUZZ!'}
      </span>
    </button>
  );
}
