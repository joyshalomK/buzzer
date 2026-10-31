import { describe, expect, it } from 'vitest';
import {
  BODY_RATIO, CHAMPION_STEPS, REVEAL_STEPS, SlotBook, VOID_STEPS, gridFor, lookOf, slotPoint, stageTargets, stepAt,
  type StageEntry, type Zone,
} from '../../src/lib/oxStage';

const e = (name: string, o: Partial<StageEntry> = {}): StageEntry => ({ key: `k-${name}`, name, alive: true, pick: null, correct: null, ...o });
const place = (ts: ReturnType<typeof stageTargets>) => Object.fromEntries(ts.map((t) => [t.name, `${t.place}/${t.mood}`]));

describe('characters', () => {
  it('look is decided by the key only (same after a reload)', () => {
    expect(lookOf('a1b2c3d4e5f6')).toEqual(lookOf('a1b2c3d4e5f6'));
    const looks = new Set(Array.from({ length: 30 }, (_, i) => lookOf(`key${i}`).body));
    expect(looks.size).toBeGreaterThan(20);
  });
});

describe('layout', () => {
  it('a zone holds every character of the round without overlap, at 1920x1080, 1366x768 and 4K', () => {
    for (const [w, h] of [[1840, 820], [1300, 560], [3700, 1700]]) {
      for (const n of [1, 3, 5, 9, 12, 17, 25, 40, 80]) {
        const g = gridFor(n, w, h);
        expect(g.cols * g.rows).toBeGreaterThanOrEqual(n);
        for (const zone of ['O', 'C', 'X'] as Zone[]) {
          const pts = Array.from({ length: n }, (_, i) => slotPoint(zone, i, g, w, h, `key${i}`));
          for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
              const dx = Math.abs(pts[i].x - pts[j].x);
              const dy = Math.abs(pts[i].y - pts[j].y);
              // bodies (and the names under them) never sit on top of each other
              if (n <= 40) expect(dx >= g.size * 0.95 || dy >= g.size * BODY_RATIO).toBe(true);
            }
          }
          // inside the stage
          expect(pts.every((p) => p.x > 0 && p.x < w && p.y <= h)).toBe(true);
        }
      }
    }
  });

  it('slots are stable: only the character that changes side moves', () => {
    const b = new SlotBook();
    expect([b.place('a', 'C'), b.place('b', 'C'), b.place('c', 'C')]).toEqual([0, 1, 2]);
    expect(b.place('b', 'O')).toBe(0);
    expect(b.place('a', 'C')).toBe(0); // unchanged
    expect(b.place('c', 'C')).toBe(2);
    expect(b.place('d', 'C')).toBe(1); // reuses the freed spot
    expect(b.place('b', 'X')).toBe(0);
    expect(b.place('a', 'O')).toBe(0); // O slot 0 was freed when b left
    b.keepOnly(new Set(['a']));
    expect(b.place('e', 'C')).toBe(0);
  });
});

describe('stage targets (from server state only)', () => {
  const entries = [e('A', { pick: 'O' }), e('B', { pick: 'X' }), e('C')];

  it('waiting and answering', () => {
    expect(place(stageTargets('ROUND_READY', null, [e('A'), e('B')], 0))).toEqual({ A: 'C/idle', B: 'C/idle' });
    expect(place(stageTargets('ANSWERING', null, entries, 0))).toEqual({ A: 'O/idle', B: 'X/idle', C: 'C/idle' });
    expect(place(stageTargets('ANSWER_CLOSED', null, entries, 0))).toEqual({ A: 'O/idle', B: 'X/idle', C: 'C/idle' });
  });

  it('reveal: tension, cheering, sad faces, walking off, then gone — as the server decided', () => {
    const revealed = [e('A', { pick: 'O', correct: true }), e('B', { pick: 'X', alive: false, correct: false }), e('C', { alive: false, correct: false })];
    const at = (step: number) => place(stageTargets('RESULT_REVEALED', null, revealed, step));
    expect(at(0)).toEqual({ A: 'O/idle', B: 'X/idle', C: 'C/idle' });
    expect(at(1)).toEqual({ A: 'O/cheer', B: 'X/idle', C: 'C/idle' });
    expect(at(2)).toEqual({ A: 'O/cheer', B: 'X/sad', C: 'C/sad' });
    expect(at(3)).toEqual({ A: 'O/idle', B: 'EXIT/sad', C: 'EXIT/sad' });
    expect(at(4)).toEqual({ A: 'O/wave' });
    expect(stepAt(0, REVEAL_STEPS)).toBe(0);
    expect(stepAt(1500, REVEAL_STEPS)).toBe(1);
    expect(stepAt(60_000, REVEAL_STEPS)).toBe(4);
  });

  it('void round: nobody leaves, everybody comes back to the middle', () => {
    const v = [e('A', { pick: 'X', correct: false }), e('B', { correct: false })];
    expect(place(stageTargets('ROUND_VOID', null, v, 1))).toEqual({ A: 'X/sad', B: 'C/sad' });
    expect(place(stageTargets('ROUND_VOID', null, v, stepAt(5000, VOID_STEPS)))).toEqual({ A: 'C/cheer', B: 'C/cheer' });
  });

  it('champion and joint winners', () => {
    const w = [e('A')];
    expect(place(stageTargets('FINISHED', 'CHAMPION', w, 0))).toEqual({ A: 'C/idle' });
    expect(place(stageTargets('FINISHED', 'CHAMPION', w, 3))).toEqual({ A: 'CHAMPION/champion' });
    expect(place(stageTargets('FINISHED', 'CHAMPION', w, stepAt(20_000, CHAMPION_STEPS)))).toEqual({ A: 'CHAMPION/wave' });
    expect(Object.keys(place(stageTargets('FINISHED', 'CO_WINNERS', [e('A'), e('B')], 3)))).toEqual(['A', 'B']);
    expect(place(stageTargets('FINISHED', 'ENDED', [e('A'), e('Z', { alive: false })], 0))).toEqual({ A: 'C/wave' });
  });
});
