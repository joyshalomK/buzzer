import { useSyncExternalStore } from 'react';
import { audioReady, isMuted, subscribeSound } from '../lib/sound';

export function useSoundState() {
  const muted = useSyncExternalStore(subscribeSound, isMuted);
  const ready = useSyncExternalStore(subscribeSound, audioReady);
  return { muted, ready };
}
