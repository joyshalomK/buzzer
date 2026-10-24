import { setMuted, unlockAudio } from '../lib/sound';
import { useSoundState } from '../hooks/useSound';

export function SoundToggle({ className = '' }: { className?: string }) {
  const { muted, ready } = useSoundState();
  const blocked = !muted && !ready;
  return (
    <button
      type="button"
      onClick={() => (blocked ? unlockAudio() : setMuted(!muted))}
      aria-label={muted ? '소리 켜기' : '소리 끄기'}
      className={`inline-flex h-9 min-w-9 items-center justify-center gap-1 rounded-full px-2.5 text-sm font-bold transition
        ${muted ? 'bg-white/10 text-white/60' : blocked ? 'bg-amber-400/20 text-amber-200' : 'bg-white/15 text-white'} ${className}`}
    >
      <span aria-hidden>{muted ? '🔇' : blocked ? '🔈' : '🔊'}</span>
      <span className="text-xs">{muted ? 'OFF' : blocked ? '탭하여 켜기' : 'ON'}</span>
    </button>
  );
}
