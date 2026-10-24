// All sound effects are synthesised with the Web Audio API (no audio files).
// iOS Safari only allows audio after a user gesture, so the AudioContext is
// created/resumed on the first touch, and every play() reports whether it
// could actually make a sound so the UI can fall back to visual effects.
import { KEYS, load, save } from './storage';

type Listener = () => void;

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let muted = load<boolean>(KEYS.muted, false);
const listeners = new Set<Listener>();

function emit() {
  listeners.forEach((l) => l());
}

export function subscribeSound(l: Listener) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function isMuted() {
  return muted;
}

export function setMuted(v: boolean) {
  muted = v;
  save(KEYS.muted, v);
  if (!v) unlockAudio();
  emit();
}

/** True when sound can actually be heard right now. */
export function audioReady() {
  return !muted && ctx?.state === 'running';
}

export function unlockAudio() {
  try {
    if (!ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      ctx = new AC({ latencyHint: 'interactive' });
      master = ctx.createGain();
      master.gain.value = 0.6;
      master.connect(ctx.destination);
      ctx.onstatechange = emit;
    }
    if (ctx.state !== 'running') void ctx.resume().then(emit, () => {});
    // iOS: playing a silent buffer inside the gesture fully unlocks output
    const buf = ctx.createBuffer(1, 1, 22050);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(0);
  } catch {
    /* audio unsupported: visual effects only */
  }
  emit();
}

/** Install one-shot listeners so the first touch anywhere unlocks audio. */
export function installAudioUnlock() {
  const handler = () => unlockAudio();
  const opts = { capture: true, passive: true } as const;
  ['pointerdown', 'touchend', 'keydown'].forEach((ev) => window.addEventListener(ev, handler, opts));
  // returning to the tab can leave iOS contexts "interrupted"
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && ctx && ctx.state !== 'running') void ctx.resume().catch(() => {});
  });
}

interface ToneOpts {
  type?: OscillatorType;
  freq: number;
  freqEnd?: number;
  start?: number;
  dur: number;
  gain?: number;
}

function tone({ type = 'sine', freq, freqEnd, start = 0, dur, gain = 0.5 }: ToneOpts) {
  if (!ctx || !master) return;
  const t0 = ctx.currentTime + start;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (freqEnd) osc.frequency.exponentialRampToValueAtTime(freqEnd, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
  g.gain.setValueAtTime(gain, t0 + Math.max(0.01, dur - 0.06));
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

function play(fn: () => void): boolean {
  if (!audioReady()) return false;
  try {
    fn();
    return true;
  } catch {
    return false;
  }
}

export const sfx = {
  /** Short, harsh electronic buzzer. */
  buzz: () =>
    play(() => {
      tone({ type: 'square', freq: 140, dur: 0.38, gain: 0.35 });
      tone({ type: 'sawtooth', freq: 147, dur: 0.38, gain: 0.25 });
      tone({ type: 'square', freq: 290, freqEnd: 260, dur: 0.38, gain: 0.12 });
    }),
  /** Bright fanfare for the winner. */
  win: () =>
    play(() => {
      const notes = [523.25, 659.25, 783.99, 1046.5];
      notes.forEach((f, i) => tone({ type: 'triangle', freq: f, start: i * 0.11, dur: 0.22, gain: 0.45 }));
      tone({ type: 'triangle', freq: 1046.5, start: 0.44, dur: 0.6, gain: 0.4 });
      tone({ type: 'sine', freq: 1318.5, start: 0.44, dur: 0.6, gain: 0.25 });
      [0.5, 0.62, 0.74, 0.86].forEach((s, i) =>
        tone({ type: 'sine', freq: 2093 + i * 220, start: s, dur: 0.12, gain: 0.12 }),
      );
    }),
  /** Softer chime for everyone else when a winner is decided. */
  chime: () =>
    play(() => {
      tone({ type: 'triangle', freq: 880, dur: 0.18, gain: 0.3 });
      tone({ type: 'triangle', freq: 1174.7, start: 0.14, dur: 0.3, gain: 0.3 });
    }),
  /** Quick "go!" for the start of buzzing. */
  start: () =>
    play(() => {
      tone({ type: 'square', freq: 660, dur: 0.09, gain: 0.25 });
      tone({ type: 'square', freq: 990, start: 0.12, dur: 0.16, gain: 0.25 });
    }),
};

export function vibrate(pattern: number | number[]) {
  try {
    if (!muted) navigator.vibrate?.(pattern);
  } catch {
    /* unsupported */
  }
}
