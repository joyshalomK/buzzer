import { describe, expect, it } from 'vitest';
import { syncResultsToCsv } from '../../src/lib/csv';
import { ServerClock } from '../../src/lib/serverClock';
import { deriveSyncView, fullyRevealed, tieGroups, type SyncViewInput } from '../../src/lib/syncView';
import type { Room, SyncRound, SyncTeamResult } from '../../src/lib/types';

const room: Room = {
  id: 'room', room_code: 'ABCD', status: 'OPEN', announcement: null, announcement_at: null,
  test_mode: false, rev: 0, created_at: '', mode: 'SYNC', sync_show_progress: false,
};
const START = 1_000_000;
const round = (o: Partial<SyncRound> = {}): SyncRound => ({
  id: 'r1', room_id: 'room', round_number: 1, status: 'WAITING', started_at: null, ended_at: null,
  started_ms: null, deadline_ms: null, duration_ms: 10_000, lead_ms: 3000, team_ids: null,
  revealed_rank: null, created_at: '', ...o,
});
const running = round({ status: 'RUNNING', started_ms: START, deadline_ms: START + 10_000 });
const base: SyncViewInput = {
  connected: true, room, round: round(), teamSize: 2, pressed: false, localPressed: false, eligible: true, now: START - 5000,
};
const view = (o: Partial<SyncViewInput>) => deriveSyncView({ ...base, ...o });

describe('deriveSyncView', () => {
  it('waiting room: partner missing vs. both connected', () => {
    expect(view({ teamSize: 1 }).phase).toBe('WAITING_PARTNER');
    expect(view({ teamSize: 1 }).title).toBe('파트너를 기다리는 중');
    expect(view({}).phase).toBe('TEAM_READY');
    expect(view({}).title).toBe('2명 모두 접속 완료');
    expect(view({ round: round({ status: 'READY' }) }).phase).toBe('READY');
  });

  it('counts down to the server GO instant, then enables the button for the window only', () => {
    const at = (now: number) => view({ round: running, now });
    expect(at(START - 2500)).toMatchObject({ phase: 'COUNTDOWN', countdown: 3, canPress: false });
    expect(at(START - 1999)).toMatchObject({ phase: 'COUNTDOWN', countdown: 2 });
    expect(at(START - 1)).toMatchObject({ phase: 'COUNTDOWN', countdown: 1 });
    expect(at(START)).toMatchObject({ phase: 'GO', canPress: true, countdown: null });
    expect(at(START + 10_000)).toMatchObject({ phase: 'GO', canPress: true });
    expect(at(START + 10_001)).toMatchObject({ phase: 'TIME_UP', canPress: false });
  });

  it('shows no remaining-time number while the game runs', () => {
    const v = view({ round: running, now: START + 4000 });
    expect(v.countdown).toBeNull();
    expect(`${v.title} ${v.message}`).not.toMatch(/\d/);
  });

  it('locks after my press (local or server-confirmed)', () => {
    expect(view({ round: running, now: START + 1000, localPressed: true })).toMatchObject({ phase: 'PRESSED', canPress: false, title: '입력 완료!' });
    expect(view({ round: running, now: START + 1000, pressed: true }).phase).toBe('PRESSED');
  });

  it('a press is still possible while the badge says disconnected (the request may get through)', () => {
    expect(view({ round: running, now: START + 1000, connected: false }).canPress).toBe(true);
    expect(view({ connected: false }).phase).toBe('DISCONNECTED');
  });

  it('rematch: teams not in the list only watch', () => {
    expect(view({ round: running, now: START + 1000, eligible: false })).toMatchObject({ phase: 'NOT_ELIGIBLE', canPress: false });
  });

  it('after the window: tallying, then results', () => {
    expect(view({ round: round({ status: 'FINISHED' }), pressed: true }).phase).toBe('TALLYING');
    expect(view({ round: round({ status: 'RESULTS', revealed_rank: 3 }) }).phase).toBe('RESULTS');
    expect(fullyRevealed(round({ status: 'RESULTS', revealed_rank: 3 }))).toBe(false);
    expect(fullyRevealed(round({ status: 'RESULTS', revealed_rank: 1 }))).toBe(true);
    expect(view({ room: { ...room, status: 'ENDED' } }).phase).toBe('ENDED');
  });
});

const team = (name: string, rank: number | null, gap: number | null, status: SyncTeamResult['status'] = 'COMPLETE'): SyncTeamResult => ({
  team_id: name, team_name: name, status, gap_ms: gap, rank,
  members: [{ participant_id: `${name}a`, label: '아빠', elapsed_ms: 1000 }, { participant_id: `${name}b`, label: '딸', elapsed_ms: gap == null ? null : 1000 + gap }],
});

describe('tieGroups', () => {
  it('finds teams sharing a rank, ignoring unranked teams', () => {
    const g = tieGroups([team('A', 1, 5), team('B', 1, 5), team('C', 3, 9), team('D', 4, 12), team('E', 4, 12), team('F', null, null, 'PARTIAL'), team('G', null, null, 'NONE')]);
    expect(g.map((x) => [x.rank, x.teams.map((t) => t.team_name)])).toEqual([[1, ['A', 'B']], [4, ['D', 'E']]]);
    expect(tieGroups([team('A', 1, 5), team('B', 2, 6)])).toEqual([]);
  });
});

describe('ServerClock', () => {
  it('uses the midpoint of the fastest round trip', () => {
    const c = new ServerClock();
    expect(c.offset).toBe(0);
    c.sample(1000, 1400, 6200); // rtt 400 -> offset 5000
    c.sample(2000, 2040, 7120); // rtt 40 -> offset 5100 (more precise)
    c.sample(3000, 3300, 8000); // rtt 300 -> offset 4850
    expect(c.offset).toBe(5100);
    expect(c.accuracy).toBe(20);
    expect(c.now(10_000)).toBe(15_100);
  });

  it('ignores invalid samples', () => {
    const c = new ServerClock();
    c.sample(10, 5, 100);
    c.sample(10, 20, Number.NaN);
    expect(c.offset).toBe(0);
  });
});

describe('syncResultsToCsv', () => {
  it('writes one row per team with both records and the gap', () => {
    const csv = syncResultsToCsv(2, [team('=튼튼', 1, 12), team('반쪽', null, null, 'PARTIAL')]);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0]).toContain('시간 차이(ms)');
    expect(lines[1]).toBe(`"2","1","'=튼튼","아빠","1000","딸","1012","12","완료"`);
    expect(lines[2]).toBe(`"2","","반쪽","아빠","1000","딸","","","미완료"`);
  });
});
