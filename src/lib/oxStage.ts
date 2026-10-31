// Pure logic of the OX SURVIVAL big-screen stage: where every character
// stands and how it behaves, derived only from server state (the picks the
// server stored and the verdicts it froze) plus time since the server event.
import type { OxAnswer, OxGameStatus, OxResult } from './types';

export interface StageEntry {
  /** stable per participant (hash), used as the React key */
  key: string;
  name: string;
  /** server survival status */
  alive: boolean;
  pick: OxAnswer | null;
  /** server verdict, only after the reveal */
  correct: boolean | null;
}

export type Zone = 'O' | 'C' | 'X';
export type Mood = 'idle' | 'cheer' | 'wave' | 'sad' | 'champion';

export interface Target {
  key: string;
  name: string;
  /** where the character stands; EXIT = walking off the stage */
  place: Zone | 'EXIT' | 'CHAMPION';
  mood: Mood;
}

// ---------------------------------------------------------------------------
// Look of a character: decided by its key only, so it never changes

export interface Look {
  body: string;
  bodyDark: string;
  skin: string;
  hair: string;
  hairStyle: 0 | 1 | 2 | 3;
  accessory: 'none' | 'santa' | 'party' | 'bow' | 'glasses';
  /** desynchronises idle animations */
  delay: number;
}

const SKINS = ['#ffd9b8', '#f6c89f', '#e9b48a', '#d49a6a', '#ffe4cc'];
const HAIRS = ['#3b2a20', '#1f1b18', '#7a4a2a', '#c58b3c', '#5b3a6e'];
const ACCESSORIES: Look['accessory'][] = ['none', 'santa', 'party', 'bow', 'glasses', 'santa', 'none'];

export function hashOf(key: string) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function lookOf(key: string): Look {
  const h = hashOf(key);
  const hue = h % 360;
  return {
    body: `hsl(${hue} 72% 56%)`,
    bodyDark: `hsl(${hue} 65% 40%)`,
    skin: SKINS[(h >>> 9) % SKINS.length],
    hair: HAIRS[(h >>> 13) % HAIRS.length],
    hairStyle: ((h >>> 17) % 4) as Look['hairStyle'],
    accessory: ACCESSORIES[(h >>> 20) % ACCESSORIES.length],
    delay: ((h >>> 5) % 1000) / 1000,
  };
}

// ---------------------------------------------------------------------------
// Stage geometry, in fractions of the stage box (0..1)

/** area where characters of a zone stand (below the zone's big letter) */
export const ZONES: Record<Zone, { x0: number; x1: number; y0: number; y1: number }> = {
  O: { x0: 0.03, x1: 0.31, y0: 0.36, y1: 0.95 },
  C: { x0: 0.36, x1: 0.64, y0: 0.36, y1: 0.95 },
  X: { x0: 0.69, x1: 0.97, y0: 0.36, y1: 0.95 },
};

export interface Grid {
  cols: number;
  rows: number;
  /** character width in px */
  size: number;
  /** cell size in px */
  cellW: number;
  cellH: number;
}

/** character height / width (svg) and the name label below it */
export const BODY_RATIO = 1.5;
const LABEL_RATIO = 0.42;

/**
 * Grid of one zone big enough for `n` characters — every character could
 * pick the same side — so slots never reflow during a round.
 */
export function gridFor(n: number, w: number, h: number): Grid {
  const z = ZONES.O;
  const zw = (z.x1 - z.x0) * w;
  const zh = (z.y1 - z.y0) * h;
  const count = Math.max(1, n);
  const cellAspect = 1 / (BODY_RATIO + LABEL_RATIO) * 1.25; // a bit wider than the body for the name
  let cols = Math.max(1, Math.round(Math.sqrt((count * zw) / (zh * cellAspect))));
  cols = Math.min(cols, count);
  const rows = Math.ceil(count / cols);
  const cellW = zw / cols;
  const cellH = zh / rows;
  const size = Math.max(18, Math.min(cellW * 0.78, cellH / (BODY_RATIO + LABEL_RATIO), h * 0.2));
  return { cols, rows, size, cellW, cellH };
}

/** Foot position (px) of slot `i` in a zone. A small per-character jitter looks less robotic. */
export function slotPoint(zone: Zone, i: number, g: Grid, w: number, h: number, key: string) {
  const z = ZONES[zone];
  const col = i % g.cols;
  const row = Math.floor(i / g.cols);
  const hh = hashOf(key);
  // jitter only inside the room the cell has to spare, so neighbours never overlap
  const spareX = Math.max(0, g.cellW - g.size * 1.1);
  const spareY = Math.max(0, g.cellH - g.size * (BODY_RATIO + LABEL_RATIO));
  const jx = (((hh >>> 3) % 100) / 100 - 0.5) * spareX * 0.7;
  const jy = (((hh >>> 11) % 100) / 100 - 0.5) * spareY * 0.7;
  return {
    x: z.x0 * w + (col + 0.5) * g.cellW + jx,
    y: z.y0 * h + row * g.cellH + spareY / 2 + g.size * BODY_RATIO + jy,
  };
}

/** Where a character leaves the stage: through the exit at the bottom middle. */
export function exitPoint(key: string, w: number, h: number) {
  const hh = hashOf(key);
  return { x: w * (0.44 + ((hh >>> 7) % 100) / 100 * 0.12), y: h * 1.18 };
}

/**
 * Remembers each character's slot so that only characters that change
 * side get a new spot; everyone else stays where they are.
 */
export class SlotBook {
  private slots = new Map<string, { zone: Zone; i: number }>();
  private used: Record<Zone, Set<number>> = { O: new Set(), C: new Set(), X: new Set() };

  place(key: string, zone: Zone): number {
    const cur = this.slots.get(key);
    if (cur?.zone === zone) return cur.i;
    if (cur) this.used[cur.zone].delete(cur.i);
    let i = 0;
    while (this.used[zone].has(i)) i++;
    this.used[zone].add(i);
    this.slots.set(key, { zone, i });
    return i;
  }

  /** forget characters that left the stage */
  keepOnly(keys: Set<string>) {
    for (const [k, s] of this.slots) {
      if (!keys.has(k)) {
        this.used[s.zone].delete(s.i);
        this.slots.delete(k);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Timeline after a server event (ms since the event)

/** reveal: tension → answer + cheering → the wrong side hangs heads → walks off → result */
export const REVEAL_STEPS = [0, 1000, 2400, 3300, 5200];
/** void round: tension → "everybody wrong" → back to the middle, "try again" */
export const VOID_STEPS = [0, 1000, 2800];
/** champion: walk to the middle → grow → crown → celebrate → calm */
export const CHAMPION_STEPS = [0, 1400, 2300, 3200, 8000];

export function stepAt(elapsedMs: number, steps: number[]) {
  let s = 0;
  for (let i = 0; i < steps.length; i++) if (elapsedMs >= steps[i]) s = i;
  return s;
}

/** Where everybody is and what they do, for a game state and a timeline step. */
export function stageTargets(
  status: OxGameStatus | 'LOADING',
  result: OxResult | null,
  entries: StageEntry[],
  step: number,
): Target[] {
  const t = (e: StageEntry, place: Target['place'], mood: Mood): Target => ({ key: e.key, name: e.name, place, mood });
  const side = (e: StageEntry): Zone => e.pick ?? 'C';

  switch (status) {
    case 'ANSWERING':
    case 'ANSWER_CLOSED':
      return entries.map((e) => t(e, side(e), 'idle'));
    case 'RESULT_REVEALED':
      return entries.flatMap((e) => {
        if (step === 0) return [t(e, side(e), 'idle')];
        if (e.alive) return [t(e, side(e), step === 1 || step === 2 ? 'cheer' : step === 4 ? 'wave' : 'idle')];
        // eliminated by the server in this round (wrong pick or no answer)
        if (step <= 1) return [t(e, side(e), 'idle')];
        if (step === 2) return [t(e, side(e), 'sad')];
        if (step === 3) return [t(e, 'EXIT', 'sad')];
        return [];
      });
    case 'ROUND_VOID':
      return entries.map((e) => (step === 0 ? t(e, side(e), 'idle') : step === 1 ? t(e, side(e), 'sad') : t(e, 'C', 'cheer')));
    case 'FINISHED': {
      const winners = entries.filter((e) => e.alive);
      if (result === 'ENDED') return winners.map((e) => t(e, 'C', 'wave'));
      return winners.map((e) => t(e, step === 0 ? 'C' : 'CHAMPION', step >= 3 && step < 4 ? 'champion' : step >= 4 ? 'wave' : 'idle'));
    }
    default:
      // lobby / round ready: survivors gather in the middle
      return entries.filter((e) => e.alive).map((e) => t(e, 'C', 'idle'));
  }
}
