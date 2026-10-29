// FAMILY SYNC MODE — integration tests against a real PostgreSQL server
// running the production migrations. Numbers refer to the README test plan.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { anonPool, createRoom, phones, rpc, rpcError, setupAdmin, superPool } from './helpers';

let su: pg.Pool;
let anon: pg.Pool;
let admin: string;

beforeAll(async () => {
  su = superPool();
  anon = anonPool(60);
  admin = await setupAdmin(su, anon);
});

afterAll(async () => {
  await anon.end();
  await su.end();
});

type Member = { participant_id: string; token: string; team_id: string; team_name: string; label: string };

async function syncRoom() {
  const room = await createRoom(anon, admin);
  await rpc(anon, 'admin_set_mode', { p_admin_token: admin, p_room_id: room.id, p_mode: 'SYNC' });
  return room;
}

const join = (code: string, team: string, label: string, db: pg.Pool | pg.Client = anon) =>
  rpc<Member>(db, 'sync_join', { p_room_code: code, p_team_name: team, p_label: label });

async function adminState(code: string) {
  return rpc(anon, 'admin_sync_state', { p_admin_token: admin, p_room_code: code });
}

async function act(roomId: string, roundId: string | null, action: string) {
  return rpc(anon, 'admin_sync_action', { p_admin_token: admin, p_room_id: roomId, p_round_id: roundId, p_action: action });
}

/** Starts the current round and moves its GO instant `agoMs` into the past (no 3 s wait in tests). */
async function startNow(roomId: string, code: string, agoMs = 50) {
  const s = await adminState(code);
  const r = await act(roomId, s.round.id, 'START');
  await su.query(
    `update public.sync_rounds set started_at = clock_timestamp() - $2 * interval '1 millisecond' where id = $1`,
    [r.id, agoMs],
  );
  return r as { id: string };
}

const press = (m: Member, roundId: string, db: pg.Pool | pg.Client = anon) =>
  rpc(db, 'sync_buzz', { p_token: m.token, p_round_id: roundId });

async function setElapsed(roundId: string, m: Member, ms: number) {
  await su.query('update public.sync_buzzes set elapsed_ms = $3 where sync_round_id = $1 and participant_id = $2', [
    roundId, m.participant_id, ms,
  ]);
}

describe('S1. 10 teams / 20 phones', () => {
  it('20 concurrent joins form 10 full teams, 20 concurrent presses are all recorded and ranked', async () => {
    const room = await syncRoom();
    const { clients, close } = await phones(20);
    const members = await Promise.all(
      clients.map((c, i) => join(room.room_code, `가족${Math.floor(i / 2) + 1}`, i % 2 ? '엄마' : '아빠', c)),
    );
    const teams = new Map<string, Member[]>();
    members.forEach((m) => teams.set(m.team_id, [...(teams.get(m.team_id) ?? []), m]));
    expect(teams.size).toBe(10);
    [...teams.values()].forEach((t) => expect(t).toHaveLength(2));

    const round = await startNow(room.id, room.room_code, 200);
    const results = await Promise.all(clients.map((c, i) => press(members[i], round.id, c)));
    await close();
    results.forEach((r) => expect(r.result).toBe('ACCEPTED'));

    const s = await adminState(room.room_code);
    // everybody pressed => closed early, no need to wait 10 s
    expect(s.round.status).toBe('FINISHED');
    expect(s.progress).toEqual({ pressed: 20, expected: 20 });
    expect(s.results).toHaveLength(10);
    let prevGap = -1;
    for (const t of s.results) {
      expect(t.status).toBe('COMPLETE');
      const [a, b] = t.members.map((m: { elapsed_ms: number }) => m.elapsed_ms);
      expect(t.gap_ms).toBe(Math.abs(a - b));
      expect(t.gap_ms).toBeGreaterThanOrEqual(prevGap);
      prevGap = t.gap_ms;
    }
    expect(s.results[0].rank).toBe(1);

    const stored = await su.query('select count(*)::int n from public.sync_buzzes where sync_round_id = $1', [round.id]);
    expect(stored.rows[0].n).toBe(20);
  });
});

describe('S2. Team size limit', () => {
  it('a third member is rejected', async () => {
    const room = await syncRoom();
    await join(room.room_code, '튼튼가족', '아빠');
    await join(room.room_code, ' 튼튼가족 ', '딸'); // same family after trimming
    expect(await rpcError(anon, 'sync_join', { p_room_code: room.room_code, p_team_name: '튼튼가족', p_label: '엄마' }))
      .toBe('TEAM_FULL');
  });

  it('6 simultaneous joins to one family => exactly 2 succeed', async () => {
    const room = await syncRoom();
    const { clients, close } = await phones(6);
    const results = await Promise.allSettled(clients.map((c, i) => join(room.room_code, 'Kim', `p${i}`, c)));
    await close();
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .forEach((r) => expect(r.reason.message).toBe('TEAM_FULL'));
    const n = await su.query(
      `select count(*)::int n from public.team_members m join public.teams t on t.id = m.team_id
       where t.room_id = $1`, [room.id]);
    expect(n.rows[0].n).toBe(2);
  });

  it('family names are case-insensitive; duplicate label in a team is rejected; input is validated', async () => {
    const room = await syncRoom();
    const a = await join(room.room_code, 'Park', '아빠');
    const b = await join(room.room_code, 'PARK', '아들');
    expect(b.team_id).toBe(a.team_id);
    expect(b.team_name).toBe('Park');

    const room2 = await syncRoom();
    await join(room2.room_code, 'Lee', '엄마');
    expect(await rpcError(anon, 'sync_join', { p_room_code: room2.room_code, p_team_name: 'lee', p_label: '엄마' }))
      .toBe('LABEL_TAKEN');
    expect(await rpcError(anon, 'sync_join', { p_room_code: room2.room_code, p_team_name: '  ', p_label: 'x' }))
      .toBe('TEAM_NAME_REQUIRED');
    expect(await rpcError(anon, 'sync_join', { p_room_code: room2.room_code, p_team_name: '12345678901', p_label: 'x' }))
      .toBe('TEAM_NAME_TOO_LONG');
    expect(await rpcError(anon, 'sync_join', { p_room_code: room2.room_code, p_team_name: 'A', p_label: '123456789' }))
      .toBe('MEMBER_LABEL_TOO_LONG');
  });

  it('kicking a member frees the slot; leaving is blocked while a round runs', async () => {
    const room = await syncRoom();
    const a = await join(room.room_code, 'Choi', '아빠');
    const b = await join(room.room_code, 'Choi', '딸');
    await rpc(anon, 'admin_kick', { p_admin_token: admin, p_participant_id: b.participant_id });
    expect((await rpc(anon, 'sync_state', { p_token: b.token })).error).toBe('KICKED');
    const c = await join(room.room_code, 'Choi', '아들');
    expect(c.team_id).toBe(a.team_id);

    await startNow(room.id, room.room_code);
    expect(await rpcError(anon, 'sync_leave', { p_token: a.token })).toBe('SYNC_RUNNING');
  });
});

describe('S3. Duplicate presses', () => {
  it('the same participant pressing 5 times at once is recorded once', async () => {
    const room = await syncRoom();
    const a = await join(room.room_code, 'Dup', 'A');
    await join(room.room_code, 'Dup', 'B');
    const round = await startNow(room.id, room.room_code);
    const { clients, close } = await phones(5);
    const results = await Promise.all(clients.map((c) => press(a, round.id, c)));
    await close();
    expect(results.filter((r) => r.result === 'ACCEPTED')).toHaveLength(1);
    expect(results.filter((r) => r.result === 'DUPLICATE')).toHaveLength(4);
    const n = await su.query('select count(*)::int n from public.sync_buzzes where participant_id = $1', [a.participant_id]);
    expect(n.rows[0].n).toBe(1);
  });
});

describe('S4/S5. 10-second window enforced by the server', () => {
  it('a press just before the deadline counts', async () => {
    const room = await syncRoom();
    const a = await join(room.room_code, 'Edge', 'A');
    await join(room.room_code, 'Edge', 'B');
    const round = await startNow(room.id, room.room_code, 9_700);
    expect((await press(a, round.id)).result).toBe('ACCEPTED');
    const s = await adminState(room.room_code);
    const e = s.results[0].members.find((m: { participant_id: string }) => m.participant_id === a.participant_id).elapsed_ms;
    expect(e).toBeGreaterThanOrEqual(9_700);
    expect(e).toBeLessThanOrEqual(10_000);
  });

  it('a press after the deadline is rejected and not stored; the round auto-finishes', async () => {
    const room = await syncRoom();
    const a = await join(room.room_code, 'Late', 'A');
    await join(room.room_code, 'Late', 'B');
    const round = await startNow(room.id, room.room_code, 10_050);
    expect((await press(a, round.id)).result).toBe('TOO_LATE');
    const n = await su.query('select count(*)::int n from public.sync_buzzes where sync_round_id = $1', [round.id]);
    expect(n.rows[0].n).toBe(0);
    // any read settles the expired round
    const st = await rpc(anon, 'sync_state', { p_token: a.token });
    expect(st.round.status).toBe('FINISHED');
    // ended_at = deadline (Date.parse truncates µs, deadline_ms rounds: allow 1 ms)
    expect(Math.abs(Date.parse(st.round.ended_at) - st.round.deadline_ms)).toBeLessThanOrEqual(1);
    expect((await press(a, round.id)).result).toBe('CLOSED');
  });

  it('a press before the scheduled GO is rejected (not stored) and may be retried', async () => {
    const room = await syncRoom();
    const a = await join(room.room_code, 'Early', 'A');
    await join(room.room_code, 'Early', 'B');
    const s = await adminState(room.room_code);
    const round = await act(room.id, s.round.id, 'START');
    expect(round.started_ms - round.lead_ms).toBeLessThanOrEqual(Date.now() + 1000);
    const early = await press(a, round.id);
    expect(early.result).toBe('TOO_EARLY');
    expect(early.wait_ms).toBeGreaterThan(0);
    await su.query(`update public.sync_rounds set started_at = clock_timestamp() - interval '1 second' where id = $1`, [round.id]);
    expect((await press(a, round.id)).result).toBe('ACCEPTED');
  });

  it('presses are refused before START and after the host stops the round', async () => {
    const room = await syncRoom();
    const a = await join(room.room_code, 'Stop', 'A');
    const b = await join(room.room_code, 'Stop', 'B');
    const s = await adminState(room.room_code);
    expect((await press(a, s.round.id)).result).toBe('NOT_STARTED');
    const round = await startNow(room.id, room.room_code);
    await act(room.id, round.id, 'FINISH');
    expect((await press(b, round.id)).result).toBe('CLOSED');
  });
});

describe('S6. Incomplete teams', () => {
  it('one press => PARTIAL (unranked), no press => NONE', async () => {
    const room = await syncRoom();
    const a1 = await join(room.room_code, 'Full', 'A');
    const a2 = await join(room.room_code, 'Full', 'B');
    const b1 = await join(room.room_code, 'Half', 'A');
    await join(room.room_code, 'Half', 'B');
    await join(room.room_code, 'Zero', 'A');
    await join(room.room_code, 'Solo', 'A'); // partner never joined
    const round = await startNow(room.id, room.room_code);
    await press(a1, round.id);
    await press(a2, round.id);
    await press(b1, round.id);
    const done = await act(room.id, round.id, 'FINISH');
    expect(done.status).toBe('FINISHED');
    const s = await adminState(room.room_code);
    const by = Object.fromEntries(s.results.map((t: { team_name: string }) => [t.team_name, t]));
    expect(by.Full).toMatchObject({ status: 'COMPLETE', rank: 1 });
    expect(by.Half).toMatchObject({ status: 'PARTIAL', rank: null, gap_ms: null });
    expect(by.Zero).toMatchObject({ status: 'NONE', rank: null });
    expect(by.Solo).toMatchObject({ status: 'NONE', rank: null });
    expect(s.results[0].team_name).toBe('Full');
    expect(s.progress).toEqual({ pressed: 3, expected: 6 });
  });
});

describe('S7. Network loss / reload', () => {
  it('a retry after a lost response is DUPLICATE; state restores from the token', async () => {
    const room = await syncRoom();
    const a = await join(room.room_code, 'Net', 'A');
    await join(room.room_code, 'Net', 'B');
    const round = await startNow(room.id, room.room_code);
    expect((await press(a, round.id)).result).toBe('ACCEPTED');
    expect((await press(a, round.id)).result).toBe('DUPLICATE'); // response was "lost", phone retries

    const st = await rpc(anon, 'sync_state', { p_token: a.token });
    expect(st.ok).toBe(true);
    expect(st.team.name).toBe('Net');
    expect(st.team.members.map((m: { label: string }) => m.label)).toEqual(['A', 'B']);
    expect(st.me.pressed).toBe(true);
    expect(st.round.status).toBe('RUNNING');
    expect(typeof st.server_now_ms).toBe('number');
  });

  it('a delayed request for a previous round is STALE_ROUND and never lands in the new one', async () => {
    const room = await syncRoom();
    const a = await join(room.room_code, 'Old', 'A');
    await join(room.room_code, 'Old', 'B');
    const r1 = await startNow(room.id, room.room_code);
    await act(room.id, r1.id, 'FINISH');
    const r2 = await act(room.id, r1.id, 'NEXT');
    expect(r2.status).toBe('READY');
    await startNow(room.id, room.room_code);
    expect((await press(a, r1.id)).result).toBe('STALE_ROUND');
    const n = await su.query('select count(*)::int n from public.sync_buzzes where sync_round_id = $1', [r2.id]);
    expect(n.rows[0].n).toBe(0);
  });
});

describe('S8. Ties', () => {
  it('equal gaps share a rank (1,1,3), no hidden tie-break; rematch limits the next round to the tied teams', async () => {
    const room = await syncRoom();
    const t: Member[][] = [];
    for (const name of ['T1', 'T2', 'T3']) t.push([await join(room.room_code, name, 'A'), await join(room.room_code, name, 'B')]);
    const round = await startNow(room.id, room.room_code);
    for (const [a, b] of t) {
      await press(a, round.id);
      await press(b, round.id);
    }
    // deterministic times: T1 gap 12, T2 gap 12, T3 gap 40
    await setElapsed(round.id, t[0][0], 1000); await setElapsed(round.id, t[0][1], 1012);
    await setElapsed(round.id, t[1][0], 2000); await setElapsed(round.id, t[1][1], 1988);
    await setElapsed(round.id, t[2][0], 3000); await setElapsed(round.id, t[2][1], 3040);
    const s = await adminState(room.room_code);
    const ranks = Object.fromEntries(s.results.map((x: { team_name: string; rank: number }) => [x.team_name, x.rank]));
    expect(ranks).toEqual({ T1: 1, T2: 1, T3: 3 });

    const re = await rpc(anon, 'admin_sync_rematch', {
      p_admin_token: admin, p_room_id: room.id, p_round_id: round.id, p_team_ids: [t[0][0].team_id, t[1][0].team_id],
    });
    expect(re.team_ids).toHaveLength(2);
    const r2 = await startNow(room.id, room.room_code);
    expect((await press(t[2][0], r2.id)).result).toBe('NOT_ELIGIBLE');
    expect((await press(t[0][0], r2.id)).result).toBe('ACCEPTED');
    const st = await rpc(anon, 'sync_state', { p_token: t[2][0].token });
    expect(st.me.eligible).toBe(false);
    const s2 = await adminState(room.room_code);
    expect(s2.results.map((x: { team_name: string }) => x.team_name).sort()).toEqual(['T1', 'T2']);
  });
});

describe('S9. Reveal & privacy', () => {
  it('nothing is public before the reveal; ranks open 5th -> 1st step by step', async () => {
    const room = await syncRoom();
    const teams: Member[][] = [];
    for (let i = 1; i <= 7; i++) teams.push([await join(room.room_code, `R${i}`, 'A'), await join(room.room_code, `R${i}`, 'B')]);
    const round = await startNow(room.id, room.room_code);
    for (const [i, [a, b]] of teams.entries()) {
      await press(a, round.id);
      await press(b, round.id);
      await setElapsed(round.id, a, 1000);
      await setElapsed(round.id, b, 1000 + (i + 1) * 10); // R1 best ... R7 worst
    }
    const me = teams[0][0];

    // during RUNNING and FINISHED: no times, no ranks, no partner info
    let st = await rpc(anon, 'sync_state', { p_token: me.token });
    expect(st.results).toEqual([]);
    expect(JSON.stringify(st)).not.toContain('elapsed_ms');
    let pub = await rpc(anon, 'sync_public_state', { p_room_code: room.room_code });
    expect(pub.results).toEqual([]);
    expect(pub.progress).toBeNull(); // host has not enabled progress on the big screen

    const step = async () => (await act(room.id, round.id, 'REVEAL_NEXT')).revealed_rank;
    expect(await step()).toBe(5);
    pub = await rpc(anon, 'sync_public_state', { p_room_code: room.room_code });
    expect(pub.results.map((x: { rank: number }) => x.rank)).toEqual([5, 6, 7]);
    st = await rpc(anon, 'sync_state', { p_token: me.token });
    expect(st.results.some((x: { team_id: string }) => x.team_id === me.team_id)).toBe(false);

    expect(await step()).toBe(4);
    expect(await step()).toBe(3);
    expect(await step()).toBe(2);
    expect(await step()).toBe(1);
    expect(await step()).toBe(1); // stays fully revealed
    st = await rpc(anon, 'sync_state', { p_token: me.token });
    expect(st.results).toHaveLength(7);
    expect(st.results[0]).toMatchObject({ team_name: 'R1', rank: 1, gap_ms: 10 });
  });

  it('the browser role cannot read teams, members or presses directly', async () => {
    for (const table of ['teams', 'team_members', 'sync_buzzes']) {
      await expect(anon.query(`select * from public.${table} limit 1`)).rejects.toThrow(/permission denied/);
    }
    await expect(anon.query('insert into public.sync_rounds (room_id, round_number) values (gen_random_uuid(), 1)'))
      .rejects.toThrow(/permission denied/);
    // round state is readable (Realtime) but contains no names or times
    const cols = await su.query(
      `select column_name from information_schema.columns where table_schema = 'public' and table_name = 'sync_rounds'`);
    expect(cols.rows.map((r) => r.column_name)).not.toContain('elapsed_ms');
  });

  it('progress can be shown on the big screen when the host enables it', async () => {
    const room = await syncRoom();
    const a = await join(room.room_code, 'P', 'A');
    await join(room.room_code, 'P', 'B');
    await rpc(anon, 'admin_sync_set_progress', { p_admin_token: admin, p_room_id: room.id, p_show: true });
    const round = await startNow(room.id, room.room_code);
    await press(a, round.id);
    const pub = await rpc(anon, 'sync_public_state', { p_room_code: room.room_code });
    expect(pub.progress).toEqual({ pressed: 1, expected: 2 });
  });
});

describe('S10. Admin refresh / stale screens / auth', () => {
  it('admin state is re-readable, double START is harmless, stale round ids are refused', async () => {
    const room = await syncRoom();
    await join(room.room_code, 'Adm', 'A');
    const s1 = await adminState(room.room_code);
    const s2 = await adminState(room.room_code); // "refresh"
    expect(s2.round.id).toBe(s1.round.id);
    const r = await act(room.id, s1.round.id, 'START');
    const again = await act(room.id, s1.round.id, 'START');
    expect(again.started_ms).toBe(r.started_ms); // GO instant not moved
    expect(await rpcError(anon, 'admin_sync_action', {
      p_admin_token: admin, p_room_id: room.id, p_round_id: '00000000-0000-0000-0000-000000000000', p_action: 'FINISH',
    })).toBe('ROUND_CHANGED');
    expect(await rpcError(anon, 'admin_sync_action', {
      p_admin_token: admin, p_room_id: room.id, p_round_id: s1.round.id, p_action: 'NEXT',
    })).toBe('SYNC_RUNNING');
    expect(await rpcError(anon, 'admin_sync_action', {
      p_admin_token: admin, p_room_id: room.id, p_round_id: s1.round.id, p_action: 'REVEAL_ALL',
    })).toBe('INVALID_TRANSITION');
  });

  it('every admin_sync RPC requires a valid admin session', async () => {
    const room = await syncRoom();
    const calls: Array<[string, Record<string, unknown>]> = [
      ['admin_set_mode', { p_room_id: room.id, p_mode: 'BUZZER' }],
      ['admin_sync_state', { p_room_code: room.room_code }],
      ['admin_sync_action', { p_room_id: room.id, p_round_id: null, p_action: 'START' }],
      ['admin_sync_rematch', { p_room_id: room.id, p_round_id: null, p_team_ids: [] }],
      ['admin_sync_set_progress', { p_room_id: room.id, p_show: true }],
      ['admin_sync_reset', { p_room_id: room.id }],
      ['admin_sync_add_test_teams', { p_room_id: room.id, p_count: 1 }],
    ];
    for (const [fn, args] of calls) {
      expect(await rpcError(anon, fn, { p_admin_token: 'forged', ...args })).toBe('ADMIN_AUTH_REQUIRED');
    }
  });

  it('sync reset removes teams and invalidates member tokens', async () => {
    const room = await syncRoom();
    const a = await join(room.room_code, 'Gone', 'A');
    const r = await rpc(anon, 'admin_sync_reset', { p_admin_token: admin, p_room_id: room.id });
    expect(r).toMatchObject({ round_number: 1, status: 'WAITING' });
    expect((await rpc(anon, 'sync_state', { p_token: a.token })).error).toBe('INVALID_TOKEN');
    expect((await adminState(room.room_code)).teams).toEqual([]);
  });

  it('test-mode bot families press through sync_buzz', async () => {
    const room = await syncRoom();
    await rpc(anon, 'admin_set_test_mode', { p_admin_token: admin, p_room_id: room.id, p_enabled: true });
    const bots = await rpc(anon, 'admin_sync_add_test_teams', { p_admin_token: admin, p_room_id: room.id, p_count: 3 });
    expect(bots).toHaveLength(3);
    const round = await startNow(room.id, room.room_code);
    const res = await Promise.all(bots.flatMap((t: { members: Member[] }) => t.members.map((m) => press(m, round.id))));
    res.forEach((r) => expect(r.result).toBe('ACCEPTED'));
    expect((await adminState(room.room_code)).round.status).toBe('FINISHED');
  });
});

describe('S11. Compatibility with the quiz buzzer', () => {
  it('modes and identities stay separate', async () => {
    const room = await createRoom(anon, admin);
    // sync join only in SYNC mode
    expect(await rpcError(anon, 'sync_join', { p_room_code: room.room_code, p_team_name: 'X', p_label: 'A' }))
      .toBe('NOT_SYNC_MODE');
    const kid = await rpc(anon, 'join_room', { p_room_code: room.room_code, p_nickname: '아빠' });
    await rpc(anon, 'admin_set_mode', { p_admin_token: admin, p_room_id: room.id, p_mode: 'SYNC' });
    // a sync label may equal a buzzer nickname
    const m = await join(room.room_code, 'Fam', '아빠');

    // tokens are not interchangeable
    expect((await rpc(anon, 'participant_sync', { p_token: m.token })).error).toBe('INVALID_TOKEN');
    expect((await rpc(anon, 'buzz', { p_token: m.token, p_round_id: null })).result).toBe('INVALID_TOKEN');
    expect((await rpc(anon, 'sync_state', { p_token: kid.token })).error).toBe('INVALID_TOKEN');
    expect((await rpc(anon, 'sync_buzz', { p_token: kid.token, p_round_id: null })).result).toBe('INVALID_TOKEN');

    // buzzer views do not list sync members
    const pub = await rpc(anon, 'get_public_state', { p_room_code: room.room_code });
    expect(pub.participant_count).toBe(1);
    expect(pub.room.mode).toBe('SYNC');
    const st = await rpc(anon, 'admin_get_state', { p_admin_token: admin, p_room_code: room.room_code });
    expect(st.participants.map((p: { nickname: string }) => p.nickname)).toEqual(['아빠']);

    // cannot switch mode while a sync round runs
    await startNow(room.id, room.room_code);
    expect(await rpcError(anon, 'admin_set_mode', { p_admin_token: admin, p_room_id: room.id, p_mode: 'BUZZER' }))
      .toBe('GAME_IN_PROGRESS');
    const s = await adminState(room.room_code);
    await act(room.id, s.round.id, 'FINISH');
    const back = await rpc(anon, 'admin_set_mode', { p_admin_token: admin, p_room_id: room.id, p_mode: 'BUZZER' });
    expect(back.mode).toBe('BUZZER');

    // the buzzer still works for the buzzer player
    const round = (await rpc(anon, 'admin_get_state', { p_admin_token: admin, p_room_code: room.room_code })).round;
    await rpc(anon, 'admin_round_action', { p_admin_token: admin, p_room_id: room.id, p_round_id: round.id, p_action: 'ARM' });
    expect((await rpc(anon, 'buzz', { p_token: kid.token, p_round_id: round.id })).result).toBe('WON');
  });

  it('whole-room reset clears both games', async () => {
    const room = await syncRoom();
    const a = await join(room.room_code, 'Wipe', 'A');
    await rpc(anon, 'admin_reset_room', { p_admin_token: admin, p_room_id: room.id });
    expect((await rpc(anon, 'sync_state', { p_token: a.token })).error).toBe('INVALID_TOKEN');
    const s = await adminState(room.room_code);
    expect(s.round).toMatchObject({ round_number: 1, status: 'WAITING' });
    expect(s.teams).toEqual([]);
  });
});
