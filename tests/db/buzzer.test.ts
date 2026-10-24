// Integration tests against a real PostgreSQL server running the production
// migration. Each scenario number refers to the test plan in the README.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import {
  ADMIN_PASSWORD, action, anonPool, createRoom, currentRound, joinMany, phones, rpc, rpcError,
  setupAdmin, superPool,
} from './helpers';

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

async function armedRoom(n: number, prefix = 'p') {
  const room = await createRoom(anon, admin);
  const players = await joinMany(anon, room.room_code, n, prefix);
  let round = await currentRound(anon, admin, room.room_code);
  await action(anon, admin, room.id, round.id, 'READY');
  round = await action(anon, admin, room.id, round.id, 'ARM');
  return { room, players, round };
}

async function acceptedCount(roundId: string) {
  const r = await su.query(
    'select count(*)::int as n from public.buzz_attempts where round_id = $1 and accepted and not revoked',
    [roundId],
  );
  return r.rows[0].n as number;
}

describe('1. 20 participants join concurrently', () => {
  it('all 20 get unique ids and tokens; only hashes are stored', async () => {
    const room = await createRoom(anon, admin);
    const { clients, close } = await phones(20);
    const joined = await Promise.all(
      clients.map((c, i) => rpc(c, 'join_room', { p_room_code: room.room_code, p_nickname: `참가자${i + 1}` })),
    );
    await close();
    expect(new Set(joined.map((j) => j.participant_id)).size).toBe(20);
    expect(new Set(joined.map((j) => j.token)).size).toBe(20);
    joined.forEach((j) => expect(j.token).toMatch(/^[0-9a-f]{64}$/));

    const stored = await su.query(
      `select encode(t.token_hash, 'hex') as h from private.participant_tokens t
       join public.participants p on p.id = t.participant_id where p.room_id = $1`,
      [room.id],
    );
    expect(stored.rowCount).toBe(20);
    const raw = new Set(joined.map((j) => j.token));
    stored.rows.forEach((r) => expect(raw.has(r.h)).toBe(false));

    const state = await rpc(anon, 'admin_get_state', { p_admin_token: admin, p_room_code: room.room_code });
    expect(state.participants).toHaveLength(20);
  });
});

describe('2. Duplicate nicknames', () => {
  it('rejects a duplicate nickname (case-insensitive, trimmed)', async () => {
    const room = await createRoom(anon, admin);
    await rpc(anon, 'join_room', { p_room_code: room.room_code, p_nickname: 'Minsu' });
    expect(await rpcError(anon, 'join_room', { p_room_code: room.room_code, p_nickname: '  minsu ' }))
      .toBe('NICKNAME_TAKEN');
  });

  it('exactly one of 8 simultaneous joins with the same nickname succeeds', async () => {
    const room = await createRoom(anon, admin);
    const { clients, close } = await phones(8);
    const results = await Promise.allSettled(
      clients.map((c) => rpc(c, 'join_room', { p_room_code: room.room_code, p_nickname: '지우' })),
    );
    await close();
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .forEach((r) => expect(r.reason.message).toBe('NICKNAME_TAKEN'));
  });

  it('validates length and empty nicknames', async () => {
    const room = await createRoom(anon, admin);
    expect(await rpcError(anon, 'join_room', { p_room_code: room.room_code, p_nickname: '1234567890123' }))
      .toBe('NICKNAME_TOO_LONG');
    expect(await rpcError(anon, 'join_room', { p_room_code: room.room_code, p_nickname: '   ' }))
      .toBe('NICKNAME_REQUIRED');
    const ok = await rpc(anon, 'join_room', { p_room_code: room.room_code, p_nickname: '가나다라마바사아자차카타' });
    expect(ok.nickname).toHaveLength(12);
  });

  it('a kicked participant frees the nickname', async () => {
    const room = await createRoom(anon, admin);
    const a = await rpc(anon, 'join_room', { p_room_code: room.room_code, p_nickname: 'bad' });
    await rpc(anon, 'admin_kick', { p_admin_token: admin, p_participant_id: a.participant_id });
    const b = await rpc(anon, 'join_room', { p_room_code: room.room_code, p_nickname: 'bad' });
    expect(b.participant_id).not.toBe(a.participant_id);
    expect((await rpc(anon, 'participant_sync', { p_token: a.token })).error).toBe('KICKED');
    expect((await rpc(anon, 'buzz', { p_token: a.token, p_round_id: null })).result).toBe('KICKED');
  });
});

describe('3. Near-simultaneous buzzing', () => {
  it('10 phones buzzing at once => exactly one winner', async () => {
    const { players, round } = await armedRoom(10);
    const { clients, close } = await phones(10);
    const results = await Promise.all(
      clients.map((c, i) => rpc(c, 'buzz', { p_token: players[i].token, p_round_id: round.id })),
    );
    await close();
    const winners = results.filter((r) => r.result === 'WON');
    expect(winners).toHaveLength(1);
    expect(results.filter((r) => r.result === 'LOST')).toHaveLength(9);
    // every loser is told the same server-confirmed winner
    results.forEach((r) => expect(r.winner_nickname).toBe(winners[0].winner_nickname));

    const db = await su.query('select * from public.rounds where id = $1', [round.id]);
    expect(db.rows[0].status).toBe('LOCKED');
    expect(db.rows[0].winner_nickname).toBe(winners[0].winner_nickname);
    expect(db.rows[0].winner_at).not.toBeNull();
    expect(await acceptedCount(round.id)).toBe(1);
    const attempts = await su.query('select count(*)::int n from public.buzz_attempts where round_id = $1', [round.id]);
    expect(attempts.rows[0].n).toBe(10);
  });

  it('stress: 40 rounds x 20 phones (each double-tapping) => one winner per round', async () => {
    const room = await createRoom(anon, admin);
    const players = await joinMany(anon, room.room_code, 20, 's');
    const { clients, close } = await phones(40);
    let round = await currentRound(anon, admin, room.room_code);
    const winsByPlayer = new Map<string, number>();
    for (let n = 0; n < 40; n++) {
      round = await action(anon, admin, room.id, round.id, 'ARM');
      const results = await Promise.all(
        clients.map((c, i) => rpc(c, 'buzz', { p_token: players[i % 20].token, p_round_id: round.id })),
      );
      const won = results.filter((r) => r.result === 'WON');
      // the double-tap of the winner may also report WON (idempotent), but for the same person
      expect(new Set(won.map((w) => w.winner_nickname)).size).toBe(1);
      expect(await acceptedCount(round.id)).toBe(1);
      const name = won[0].winner_nickname as string;
      winsByPlayer.set(name, (winsByPlayer.get(name) ?? 0) + 1);
      round = await action(anon, admin, room.id, round.id, 'NEXT');
    }
    await close();
    expect([...winsByPlayer.values()].reduce((a, b) => a + b, 0)).toBe(40);
  });

  it('winner holding its row lock (slow commit) still produces a single winner', async () => {
    // Every buzz runs inside a transaction that sleeps before COMMIT, so the
    // first claimant holds the row lock while all others queue behind it and
    // must re-check the WHERE clause after it commits.
    const { players, round } = await armedRoom(12, 'slow');
    const { clients, close } = await phones(12);
    const results = await Promise.all(
      clients.map(async (c, i) => {
        await c.query('begin');
        const r = await rpc(c, 'buzz', { p_token: players[i].token, p_round_id: round.id });
        await c.query('select pg_sleep(0.2)');
        await c.query('commit');
        return r;
      }),
    );
    await close();
    expect(results.filter((r) => r.result === 'WON')).toHaveLength(1);
    expect(await acceptedCount(round.id)).toBe(1);
  });

  it('DB constraint rejects a second accepted attempt even if logic were bypassed', async () => {
    const { players, round } = await armedRoom(2, 'cx');
    await rpc(anon, 'buzz', { p_token: players[0].token, p_round_id: round.id });
    const p2 = await su.query('select id from public.participants where nickname = $1 and room_id = $2',
      ['cx2', (round as any).room_id]);
    await expect(
      su.query('insert into public.buzz_attempts (round_id, arm_seq, participant_id, accepted) values ($1, 99, $2, true)',
        [round.id, p2.rows[0].id]),
    ).rejects.toThrow(/buzz_attempts_one_winner_per_round/);
  });
});

describe('4. Same person taps 5 times', () => {
  it('records a single attempt and returns the same outcome every time', async () => {
    const { players, round } = await armedRoom(3, 'tap');
    const { clients, close } = await phones(5);
    const results = await Promise.all(
      clients.map((c) => rpc(c, 'buzz', { p_token: players[0].token, p_round_id: round.id })),
    );
    await close();
    results.forEach((r) => expect(r.result).toBe('WON'));
    expect(results.filter((r) => r.duplicate)).toHaveLength(4);
    const n = await su.query('select count(*)::int n from public.buzz_attempts where round_id = $1', [round.id]);
    expect(n.rows[0].n).toBe(1);
  });

  it('a loser tapping repeatedly stays LOST (network retries are safe)', async () => {
    const { players, round } = await armedRoom(2, 'rt');
    await rpc(anon, 'buzz', { p_token: players[0].token, p_round_id: round.id });
    for (let i = 0; i < 5; i++) {
      const r = await rpc(anon, 'buzz', { p_token: players[1].token, p_round_id: round.id });
      expect(r.result).toBe('LOST');
      expect(r.winner_nickname).toBe('rt1');
    }
  });
});

describe('5. Buzz before the round is armed', () => {
  it('WAITING and READY reject without recording anything', async () => {
    const room = await createRoom(anon, admin);
    const [p] = await joinMany(anon, room.room_code, 1);
    let round = await currentRound(anon, admin, room.room_code);
    expect((await rpc(anon, 'buzz', { p_token: p.token, p_round_id: round.id })).result).toBe('NOT_ARMED');
    round = await action(anon, admin, room.id, round.id, 'READY');
    expect((await rpc(anon, 'buzz', { p_token: p.token, p_round_id: round.id })).result).toBe('NOT_ARMED');
    const n = await su.query('select count(*)::int n from public.buzz_attempts where round_id = $1', [round.id]);
    expect(n.rows[0].n).toBe(0);
    // a too-early tap does not block the participant once armed
    round = await action(anon, admin, room.id, round.id, 'ARM');
    expect((await rpc(anon, 'buzz', { p_token: p.token, p_round_id: round.id })).result).toBe('WON');
  });

  it('host lock with no winner => LOCKED, and re-arming works', async () => {
    const { room, players, round } = await armedRoom(2, 'lk');
    const locked = await action(anon, admin, room.id, round.id, 'LOCK');
    expect(locked.status).toBe('LOCKED');
    expect((await rpc(anon, 'buzz', { p_token: players[0].token, p_round_id: round.id })).result).toBe('LOCKED');
    const rearmed = await action(anon, admin, room.id, round.id, 'ARM');
    expect(rearmed.arm_seq).toBe(round.arm_seq + 1);
    expect((await rpc(anon, 'buzz', { p_token: players[0].token, p_round_id: round.id })).result).toBe('WON');
  });
});

describe('6. Buzz after a winner is confirmed', () => {
  it('late presses are LOST and cannot change the winner', async () => {
    const { players, round } = await armedRoom(4, 'late');
    expect((await rpc(anon, 'buzz', { p_token: players[2].token, p_round_id: round.id })).result).toBe('WON');
    for (const p of [players[0], players[1], players[3]]) {
      const r = await rpc(anon, 'buzz', { p_token: p.token, p_round_id: round.id });
      expect(r.result).toBe('LOST');
      expect(r.winner_nickname).toBe('late3');
    }
    const db = await su.query('select winner_nickname from public.rounds where id = $1', [round.id]);
    expect(db.rows[0].winner_nickname).toBe('late3');
  });

  it('host cannot re-arm a round that has a winner', async () => {
    const { room, players, round } = await armedRoom(1, 'nr');
    await rpc(anon, 'buzz', { p_token: players[0].token, p_round_id: round.id });
    expect(await rpcError(anon, 'admin_round_action', {
      p_admin_token: admin, p_room_id: room.id, p_round_id: round.id, p_action: 'ARM',
    })).toBe('ROUND_HAS_WINNER');
  });
});

describe('7. Delayed request from the previous round', () => {
  it('a buzz carrying the old round_id never affects the new round', async () => {
    const { room, players, round } = await armedRoom(3, 'old');
    await rpc(anon, 'buzz', { p_token: players[0].token, p_round_id: round.id });
    const next = await action(anon, admin, room.id, round.id, 'NEXT');
    const armed = await action(anon, admin, room.id, next.id, 'ARM');
    const stale = await rpc(anon, 'buzz', { p_token: players[1].token, p_round_id: round.id });
    expect(stale.result).toBe('STALE_ROUND');
    const db = await su.query('select status, winner_id from public.rounds where id = $1', [armed.id]);
    expect(db.rows[0]).toEqual({ status: 'ARMED', winner_id: null });
  });

  it('race: buzzes on old round fired concurrently with NEXT+ARM', async () => {
    for (let k = 0; k < 10; k++) {
      const { room, players, round } = await armedRoom(8, `race${k}-`);
      const { clients, close } = await phones(8);
      const [nextRound, ...results] = await Promise.all([
        action(anon, admin, room.id, round.id, 'NEXT').then((r) => action(anon, admin, room.id, r.id, 'ARM')),
        ...clients.map((c, i) => rpc(c, 'buzz', { p_token: players[i].token, p_round_id: round.id })),
      ]);
      await close();
      // old round: at most one winner; new round: untouched
      expect(results.filter((r) => r.result === 'WON').length).toBeLessThanOrEqual(1);
      expect(await acceptedCount(round.id)).toBeLessThanOrEqual(1);
      const db = await su.query('select status, winner_id from public.rounds where id = $1', [nextRound.id]);
      expect(db.rows[0]).toEqual({ status: 'ARMED', winner_id: null });
    }
  });

  it('a stale admin screen (double-click NEXT) cannot skip a round', async () => {
    const room = await createRoom(anon, admin);
    const r1 = await currentRound(anon, admin, room.room_code);
    const results = await Promise.allSettled([
      action(anon, admin, room.id, r1.id, 'NEXT'),
      action(anon, admin, room.id, r1.id, 'NEXT'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const now = await currentRound(anon, admin, room.room_code);
    expect(now.round_number).toBe(2);
  });
});

describe('8/9. Refresh and network switch (token based restore)', () => {
  it('participant_sync restores identity and round state from a fresh connection', async () => {
    const { players, round } = await armedRoom(2, 'rf');
    await rpc(anon, 'buzz', { p_token: players[1].token, p_round_id: round.id });
    // "reload" / "Wi-Fi -> LTE": brand new connection, only the stored token
    const { clients, close } = await phones(1);
    const s = await rpc(clients[0], 'participant_sync', { p_token: players[1].token });
    await close();
    expect(s.ok).toBe(true);
    expect(s.participant.nickname).toBe('rf2');
    expect(s.round.id).toBe(round.id);
    expect(s.round.winner_nickname).toBe('rf2');
    expect(s.me).toEqual({ attempted: true, excluded: false, wins: 1 });
  });
});

describe('10. Admin refresh', () => {
  it('admin session token survives a reload and returns full state', async () => {
    const { room, players, round } = await armedRoom(3, 'ad');
    await rpc(anon, 'buzz', { p_token: players[0].token, p_round_id: round.id });
    const { clients, close } = await phones(1);
    expect((await rpc(clients[0], 'admin_check', { p_admin_token: admin })).ok).toBe(true);
    const s = await rpc(clients[0], 'admin_get_state', { p_admin_token: admin, p_room_code: room.room_code });
    await close();
    expect(s.round.winner_nickname).toBe('ad1');
    expect(s.attempts).toHaveLength(1);
    expect(s.participants.find((p: any) => p.nickname === 'ad1').wins).toBe(1);
  });
});

describe('Host tools', () => {
  it('cancel win: winner removed, round can be re-armed, cancelled winner excluded', async () => {
    const { room, players, round } = await armedRoom(3, 'cw');
    await rpc(anon, 'buzz', { p_token: players[0].token, p_round_id: round.id });
    await rpc(anon, 'buzz', { p_token: players[1].token, p_round_id: round.id });
    const cancelled = await rpc(anon, 'admin_cancel_win', { p_admin_token: admin, p_round_id: round.id });
    expect(cancelled).toMatchObject({ status: 'LOCKED', winner_id: null, winner_nickname: null });
    await action(anon, admin, room.id, round.id, 'ARM');
    expect((await rpc(anon, 'buzz', { p_token: players[0].token, p_round_id: round.id })).result).toBe('EXCLUDED');
    // a previous loser may press again in the new arming
    expect((await rpc(anon, 'buzz', { p_token: players[1].token, p_round_id: round.id })).result).toBe('WON');
    expect(await acceptedCount(round.id)).toBe(1);
  });

  it('announce, end game, reset, test bots', async () => {
    const room = await createRoom(anon, admin);
    const [p] = await joinMany(anon, room.room_code, 1, 'ann');
    await rpc(anon, 'admin_announce', { p_admin_token: admin, p_room_id: room.id, p_text: '잠시 후 시작!' });
    expect((await rpc(anon, 'participant_sync', { p_token: p.token })).room.announcement).toBe('잠시 후 시작!');

    expect(await rpcError(anon, 'admin_add_test_bots', { p_admin_token: admin, p_room_id: room.id, p_count: 3 }))
      .toBe('TEST_MODE_OFF');
    await rpc(anon, 'admin_set_test_mode', { p_admin_token: admin, p_room_id: room.id, p_enabled: true });
    const bots = await rpc(anon, 'admin_add_test_bots', { p_admin_token: admin, p_room_id: room.id, p_count: 5 });
    expect(bots).toHaveLength(5);
    let round = await currentRound(anon, admin, room.room_code);
    round = await action(anon, admin, room.id, round.id, 'ARM');
    const res = await Promise.all(bots.map((b: any) => rpc(anon, 'buzz', { p_token: b.token, p_round_id: round.id })));
    expect(res.filter((r) => r.result === 'WON')).toHaveLength(1);
    await rpc(anon, 'admin_remove_test_bots', { p_admin_token: admin, p_room_id: room.id });
    const st = await rpc(anon, 'admin_get_state', { p_admin_token: admin, p_room_code: room.room_code });
    expect(st.participants).toHaveLength(1);
    // winner nickname kept in history even after the bot is deleted
    expect(st.round.winner_nickname).toMatch(/^테스트봇/);

    const pub = await rpc(anon, 'get_public_state', { p_room_code: room.room_code });
    expect(pub.participant_count).toBe(1);
    expect(pub).not.toHaveProperty('participants');

    await rpc(anon, 'admin_end_game', { p_admin_token: admin, p_room_id: room.id });
    expect((await rpc(anon, 'participant_sync', { p_token: p.token })).room.status).toBe('ENDED');
    expect(await rpcError(anon, 'join_room', { p_room_code: room.room_code, p_nickname: 'late' })).toBe('ROOM_ENDED');

    await rpc(anon, 'admin_reset_room', { p_admin_token: admin, p_room_id: room.id });
    expect((await rpc(anon, 'participant_sync', { p_token: p.token })).error).toBe('INVALID_TOKEN');
    const after = await currentRound(anon, admin, room.room_code);
    expect(after).toMatchObject({ round_number: 1, status: 'WAITING' });
  });
});

describe('12. Forged tokens and unauthorised calls', () => {
  it('forged / missing participant tokens are rejected', async () => {
    const { players, round } = await armedRoom(1, 'fg');
    for (const t of ['', 'x', '0'.repeat(64), players[0].token.slice(0, 63) + (players[0].token.endsWith('f') ? 'e' : 'f'), null]) {
      const r = await rpc(anon, 'buzz', { p_token: t, p_round_id: round.id });
      expect(r.result).toBe('INVALID_TOKEN');
    }
    const r = await su.query('select status from public.rounds where id = $1', [round.id]);
    expect(r.rows[0].status).toBe('ARMED');
  });

  it('a participant token cannot buzz in another room', async () => {
    const a = await armedRoom(1, 'ra');
    const b = await armedRoom(1, 'rb');
    expect((await rpc(anon, 'buzz', { p_token: a.players[0].token, p_round_id: b.round.id })).result)
      .toBe('STALE_ROUND');
  });

  it('every admin RPC rejects forged, participant and missing tokens', async () => {
    const { room, players, round } = await armedRoom(1, 'adm');
    const bad = ['', 'forged', players[0].token, null];
    const calls: Array<[string, Record<string, unknown>]> = [
      ['admin_check', {}],
      ['admin_list_rooms', {}],
      ['admin_create_room', {}],
      ['admin_get_state', { p_room_code: room.room_code }],
      ['admin_round_action', { p_room_id: room.id, p_round_id: round.id, p_action: 'NEXT' }],
      ['admin_cancel_win', { p_round_id: round.id }],
      ['admin_kick', { p_participant_id: players[0].participant_id }],
      ['admin_announce', { p_room_id: room.id, p_text: 'hacked' }],
      ['admin_end_game', { p_room_id: room.id }],
      ['admin_reset_room', { p_room_id: room.id }],
      ['admin_set_test_mode', { p_room_id: room.id, p_enabled: true }],
      ['admin_add_test_bots', { p_room_id: room.id, p_count: 1 }],
      ['admin_remove_test_bots', { p_room_id: room.id }],
    ];
    for (const [fn, args] of calls) {
      for (const t of bad) {
        expect(await rpcError(anon, fn, { p_admin_token: t, ...args })).toBe('ADMIN_AUTH_REQUIRED');
      }
    }
    const r = await su.query('select status from public.rounds where id = $1', [round.id]);
    expect(r.rows[0].status).toBe('ARMED');
  });

  it('wrong password fails and brute force is throttled', async () => {
    await su.query('truncate private.admin_login_attempts');
    for (let i = 0; i < 10; i++) {
      expect((await rpc(anon, 'admin_login', { p_password: 'guess' + i })).error).toBe('INVALID_PASSWORD');
    }
    expect((await rpc(anon, 'admin_login', { p_password: ADMIN_PASSWORD })).error).toBe('TOO_MANY_ATTEMPTS');
    await su.query('truncate private.admin_login_attempts');
    expect((await rpc(anon, 'admin_login', { p_password: ADMIN_PASSWORD })).ok).toBe(true);
  });

  it('expired admin sessions and logout are enforced', async () => {
    const login = await rpc(anon, 'admin_login', { p_password: ADMIN_PASSWORD });
    await rpc(anon, 'admin_logout', { p_admin_token: login.token });
    expect(await rpcError(anon, 'admin_check', { p_admin_token: login.token })).toBe('ADMIN_AUTH_REQUIRED');
    const l2 = await rpc(anon, 'admin_login', { p_password: ADMIN_PASSWORD });
    await su.query("update private.admin_sessions set expires_at = now() - interval '1 second'");
    expect(await rpcError(anon, 'admin_check', { p_admin_token: l2.token })).toBe('ADMIN_AUTH_REQUIRED');
    admin = await setupAdmin(su, anon);
  });

  it('anon cannot touch tables or private functions directly (RLS + grants)', async () => {
    const { room, round } = await armedRoom(1, 'rls');
    const denied = [
      `select * from public.participants`,
      `select * from public.buzz_attempts`,
      `select * from private.participant_tokens`,
      `select * from private.admin_sessions`,
      `select * from private.admin_config`,
      `update public.rounds set winner_nickname = 'hacker' where id = '${round.id}'`,
      `insert into public.rounds (room_id, round_number) values ('${room.id}', 99)`,
      `delete from public.rooms where id = '${room.id}'`,
      `insert into public.buzz_attempts (round_id, arm_seq, participant_id, accepted) values ('${round.id}', 1, gen_random_uuid(), true)`,
      `select private.set_admin_password('owned-password')`,
      `select private.require_admin('x')`,
    ];
    for (const sql of denied) {
      await expect(anon.query(sql), sql).rejects.toThrow(/permission denied/);
    }
    // read-only public tables expose no secrets
    const rooms = await anon.query('select * from public.rooms limit 1');
    expect(Object.keys(rooms.rows[0])).not.toContain('password_hash');
    const r = await su.query('select status, winner_nickname from public.rounds where id = $1', [round.id]);
    expect(r.rows[0]).toEqual({ status: 'ARMED', winner_nickname: null });
  });
});
