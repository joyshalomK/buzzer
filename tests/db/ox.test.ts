// OX SURVIVAL MODE — integration tests against a real PostgreSQL server
// running the production migrations. Numbers refer to the README test plan
// (O1 … O15; O16–O18 are the existing buzzer / sync / match suites).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { anonPool, createRoom, joinMany, phones, rpc, rpcError, setupAdmin, superPool } from './helpers';

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

type Room = { id: string; room_code: string };
type Player = { participant_id: string; token: string; nickname: string };
type OX = 'O' | 'X';

async function oxRoom() {
  const room = await createRoom(anon, admin);
  await rpc(anon, 'admin_set_mode', { p_admin_token: admin, p_room_id: room.id, p_mode: 'OX' });
  return room as Room;
}

const adminState = (room: Room) => rpc(anon, 'admin_ox_state', { p_admin_token: admin, p_room_code: room.room_code });
const publicState = (room: Room) => rpc(anon, 'ox_public_state', { p_room_code: room.room_code });
const myState = (p: { token: string }) => rpc(anon, 'ox_state', { p_token: p.token });

/** Runs an admin action against whatever the host currently sees. */
async function act(room: Room, action: string) {
  const s = await adminState(room);
  return rpc(anon, 'admin_ox_action', {
    p_admin_token: admin, p_room_id: room.id, p_game_id: s.game.id, p_round_id: s.game.current_round_id, p_action: action,
  });
}

async function setAnswer(room: Room, answer: OX) {
  const s = await adminState(room);
  return rpc(anon, 'admin_ox_set_answer', { p_admin_token: admin, p_room_id: room.id, p_round_id: s.game.current_round_id, p_answer: answer });
}

const roundId = async (room: Room) => (await adminState(room)).game.current_round_id as string;

let seq = 1;
const answer = (p: { token: string }, round: string, a: string, s = seq++, db: pg.Pool | pg.Client = anon) =>
  rpc(db, 'ox_answer', { p_token: p.token, p_round_id: round, p_answer: a, p_seq: s });

/** Moves the deadline of an answering round into the past (no 10 s wait). */
const expire = (round: string) =>
  su.query(`update public.ox_rounds set deadline_at = clock_timestamp() - interval '1 millisecond' where id = $1`, [round]);

/** A room in OX mode with n joined players and a started game (round 1 READY). */
async function started(n: number) {
  const room = await oxRoom();
  const players = await joinMany(anon, room.room_code, n, 'ox');
  await act(room, 'START');
  return { room, players };
}

/** Plays the READY round: store the answer, open, answer, close, reveal. */
async function play(room: Room, correct: OX, picks: Array<[Player, OX]>) {
  await setAnswer(room, correct);
  await act(room, 'OPEN');
  const r = await roundId(room);
  for (const [p, a] of picks) expect((await answer(p, r, a)).result).toBe('ACCEPTED');
  await act(room, 'CLOSE');
  await act(room, 'REVEAL');
  return r;
}

const statusOf = async (p: Player) => (await myState(p)).me.status as string;

describe('O0. lobby and roster', () => {
  it('START freezes everyone online as ALIVE; latecomers and new nicknames only watch', async () => {
    const room = await oxRoom();
    const [a, b, c] = await joinMany(anon, room.room_code, 3, 'r');
    // a family member plays as an individual with the family token
    const fam = await rpc(anon, 'sync_join', { p_room_code: room.room_code, p_team_name: '김가족', p_label: '아빠' }).catch((e) => e);
    expect(String(fam.message ?? '')).toContain('NOT_SYNC_MODE'); // family join is not offered in OX mode…
    await rpc(anon, 'admin_set_mode', { p_admin_token: admin, p_room_id: room.id, p_mode: 'SYNC' });
    const dad = await rpc(anon, 'sync_join', { p_room_code: room.room_code, p_team_name: '김가족', p_label: '아빠' });
    await rpc(anon, 'admin_set_mode', { p_admin_token: admin, p_room_id: room.id, p_mode: 'OX' });
    // …but an existing family member keeps playing with the same phone
    // a phone that went away before the start is not put on the roster
    await su.query(`update public.participants set last_seen_at = now() - interval '5 minutes' where id = $1`, [c.participant_id]);

    expect((await myState(a)).me.role).toBe('CANDIDATE');
    const lobby = await adminState(room);
    expect(lobby.counts.candidates).toBe(3);
    expect(lobby.candidates.map((x: any) => x.name)).toContain('김가족 아빠');

    await act(room, 'START');
    const s = await adminState(room);
    expect(s.game).toMatchObject({ status: 'ROUND_READY', current_round: 1, initial_participant_count: 3 });
    expect(s.players.map((p: any) => p.name).sort()).toEqual(['r1', 'r2', '김가족 아빠'].sort());
    expect(s.players.every((p: any) => p.status === 'ALIVE')).toBe(true);
    expect((await myState(dad)).me).toMatchObject({ role: 'PLAYER', status: 'ALIVE', name: '김가족 아빠' });
    expect((await myState(c)).me.role).toBe('SPECTATOR');

    // joining after the start (e.g. under a new nickname) never makes a player
    const [late] = await joinMany(anon, room.room_code, 1, 'late');
    expect((await myState(late)).me.role).toBe('SPECTATOR');
    await setAnswer(room, 'O');
    await act(room, 'OPEN');
    const r = await roundId(room);
    expect((await answer(late, r, 'O')).result).toBe('NOT_PLAYING');
    expect((await answer(b, r, 'O')).result).toBe('ACCEPTED');
  });

  it('needs at least two players', async () => {
    const room = await oxRoom();
    await joinMany(anon, room.room_code, 1, 'solo');
    const g = (await adminState(room)).game;
    expect(await rpcError(anon, 'admin_ox_action', {
      p_admin_token: admin, p_room_id: room.id, p_game_id: g.id, p_round_id: null, p_action: 'START',
    })).toBe('NOT_ENOUGH_PLAYERS');
    expect((await adminState(room)).players).toEqual([]); // nothing half-registered
  });
});

describe('O1–O4. the secret answer', () => {
  it('O and X answers grade correctly; OPEN is blocked until an answer is stored; locked once open', async () => {
    const { room, players: [a, b, c] } = await started(3);
    // O3: no answer stored -> OPEN refused
    expect(await rpcError(anon, 'admin_ox_action', {
      p_admin_token: admin, p_room_id: room.id, p_game_id: (await adminState(room)).game.id,
      p_round_id: await roundId(room), p_action: 'OPEN',
    })).toBe('ANSWER_REQUIRED');

    // the host may correct the answer while the round is READY
    await setAnswer(room, 'X');
    await setAnswer(room, 'O');
    expect((await adminState(room)).round).toMatchObject({ answer_set: true, correct_answer: 'O' });
    await act(room, 'OPEN');
    // O4: locked after the start
    const r1 = await roundId(room);
    expect(await rpcError(anon, 'admin_ox_set_answer', { p_admin_token: admin, p_room_id: room.id, p_round_id: r1, p_answer: 'X' }))
      .toBe('ANSWER_LOCKED');
    // O1: answer O
    await answer(a, r1, 'O');
    await answer(b, r1, 'O');
    await answer(c, r1, 'X');
    await act(room, 'CLOSE');
    await act(room, 'REVEAL');
    expect((await adminState(room)).round).toMatchObject({ status: 'REVEALED', correct_answer: 'O', survivors_before: 3, survivors_after: 2 });

    // O2: answer X
    await act(room, 'NEXT');
    await play(room, 'X', [[a, 'X'], [b, 'O']]);
    const s = await adminState(room);
    expect(s.round).toMatchObject({ round_number: 2, correct_answer: 'X', survivors_after: 1 });
    expect(s.game.result).toBe('CHAMPION');
  });

  it('O11. the answer key never reaches participants or the screen before the reveal', async () => {
    const { room, players: [a, b] } = await started(2);
    await setAnswer(room, 'X');
    const leaks = async () => {
      for (const st of [await myState(a), await publicState(room)]) {
        expect(st.round.correct_answer).toBeNull();
        expect(st.round.answer_set).toBe(true);
        expect(JSON.stringify(st)).not.toMatch(/"(survivors_after|correct_count|o_count|x_count)":\s*\d/);
      }
    };
    await leaks();
    await act(room, 'OPEN');
    const r = await roundId(room);
    await answer(a, r, 'O');
    await leaks();
    // participants see no distribution while answering
    expect((await myState(b)).counts).toMatchObject({ answered: 1, o: null, x: null });
    expect((await adminState(room)).counts).toMatchObject({ answered: 1, o: 1, x: 0 });
    await act(room, 'CLOSE');
    await leaks();
    expect((await myState(a)).verdict).toBeNull();
    expect(await statusOf(a)).toBe('ALIVE'); // statuses change only at the reveal

    // no direct table access for the anon role (answer key lives in ox_rounds)
    for (const t of ['ox_rounds', 'ox_answers', 'ox_players', 'ox_round_results']) {
      expect(await anon.query(`select * from public.${t}`).catch((e) => e.message)).toMatch(/permission denied/);
    }
    // the realtime table has state only
    const { rows } = await anon.query('select * from public.ox_games where room_id = $1', [room.id]);
    expect(JSON.stringify(rows)).not.toMatch(/"X"|correct/);

    await act(room, 'REVEAL');
    expect((await publicState(room)).round).toMatchObject({ correct_answer: 'X', survivors_before: 2 });
  });
});

describe('O5–O8. survival', () => {
  it('right answers advance; wrong and missing answers are eliminated and cannot answer later', async () => {
    const { room, players: [a, b, c, d] } = await started(4);
    await play(room, 'O', [[a, 'O'], [b, 'O'], [c, 'X']]); // d does not answer
    expect(await statusOf(a)).toBe('ALIVE');
    expect(await statusOf(b)).toBe('ALIVE');
    expect((await myState(c)).me).toMatchObject({ status: 'ELIMINATED', eliminated_round: 1 });
    expect((await myState(d)).me).toMatchObject({ status: 'ELIMINATED', eliminated_round: 1 });
    expect((await myState(a)).verdict).toEqual({ selected: 'O', correct: true });
    expect((await myState(d)).verdict).toEqual({ selected: null, correct: false });

    const s = await adminState(room);
    expect(s.counts).toMatchObject({ initial: 4, alive: 2, eliminated: 2 });
    expect(s.verdicts.filter((v: any) => !v.correct).map((v: any) => v.name).sort()).toEqual(['ox3', 'ox4']);
    expect(s.game.result).toBeNull();
    expect((await publicState(room)).round).toMatchObject({ survivors_before: 4, survivors_after: 2 });

    // O8: eliminated players are refused in the next round
    await act(room, 'NEXT');
    await setAnswer(room, 'X');
    await act(room, 'OPEN');
    const r2 = await roundId(room);
    expect((await answer(c, r2, 'X')).result).toBe('ELIMINATED');
    expect((await answer(d, r2, 'X')).result).toBe('ELIMINATED');
    expect((await answer(a, r2, 'X')).result).toBe('ACCEPTED');
    // the previous round's answers do not carry over
    expect((await myState(b)).me.answer).toBeNull();
  });
});

describe('O9–O10. answering window', () => {
  it('answers can change until the deadline; then they are frozen', async () => {
    const { room, players: [a, b] } = await started(2);
    await setAnswer(room, 'O');
    expect((await answer(a, await roundId(room), 'O')).result).toBe('NOT_OPEN');
    await act(room, 'OPEN');
    const r = await roundId(room);
    expect((await answer(a, r, 'X')).result).toBe('ACCEPTED');
    expect((await answer(a, r, 'O')).result).toBe('ACCEPTED');
    expect((await myState(a)).me.answer).toBe('O');
    // an older request arriving late cannot overwrite the newer pick
    expect(await answer(a, r, 'X', 1)).toMatchObject({ result: 'STALE', answer: 'O' });
    // same request retried = idempotent
    const s = seq++;
    expect((await answer(b, r, 'X', s)).result).toBe('ACCEPTED');
    expect((await answer(b, r, 'X', s)).result).toBe('ACCEPTED');
    expect(await answer(a, r, 'Z')).toMatchObject({ result: 'INVALID_ANSWER' });

    await expire(r);
    expect(await answer(a, r, 'X')).toMatchObject({ ok: false, answer: 'O' }); // TOO_LATE or CLOSED
    expect((await adminState(room)).game.status).toBe('ANSWER_CLOSED'); // closed lazily by the read
    expect(await answer(b, r, 'O')).toMatchObject({ result: 'CLOSED', answer: 'X' });
    await act(room, 'REVEAL');
    expect(await statusOf(a)).toBe('ALIVE');
    expect(await statusOf(b)).toBe('ELIMINATED');
  });

  it('a close racing many answers counts each answer fully or not at all', async () => {
    const room = await oxRoom();
    const n = 30;
    const players = await joinMany(anon, room.room_code, n, 'race');
    await act(room, 'START');
    await setAnswer(room, 'O');
    await act(room, 'OPEN');
    const r = await roundId(room);
    const ph = await phones(n);
    try {
      const results = await Promise.all([
        ...players.map((p, i) => answer(p, r, 'O', seq++, ph.clients[i])),
        new Promise((res) => setTimeout(res, 5)).then(() => act(room, 'CLOSE')),
      ]);
      const accepted = results.slice(0, n).filter((x: any) => x.result === 'ACCEPTED').length;
      await act(room, 'REVEAL');
      const s = await adminState(room);
      expect(s.round.survivors_after).toBe(accepted || n); // nobody right -> void keeps everyone
      expect(s.counts.alive).toBe(accepted || n);
    } finally {
      await ph.close();
    }
  });
});

describe('O12. everybody wrong', () => {
  it('voids the round, keeps every survivor and replays the same round number', async () => {
    const { room, players: [a, b, c] } = await started(3);
    await play(room, 'O', [[a, 'O'], [b, 'O'], [c, 'X']]); // c out
    await act(room, 'NEXT');
    const voided = await play(room, 'X', [[a, 'O'], [b, 'O']]);
    const s = await adminState(room);
    expect(s.game).toMatchObject({ status: 'ROUND_VOID', current_round: 2, result: null });
    expect(s.counts.alive).toBe(2);
    expect(await statusOf(a)).toBe('ALIVE');
    expect(await statusOf(c)).toBe('ELIMINATED');
    // the void round is kept as a record
    const rec = s.rounds.find((x: any) => x.id === voided);
    expect(rec).toMatchObject({ status: 'VOID', correct_answer: 'X', correct_count: 0, survivors_after: 2, eliminated_names: [] });
    expect((await publicState(room)).round).toMatchObject({ status: 'VOID', correct_answer: 'X' });

    // replay: same round number, new round id, fresh answers
    await act(room, 'NEXT');
    const again = await adminState(room);
    expect(again.game).toMatchObject({ status: 'ROUND_READY', current_round: 2 });
    expect(again.round).toMatchObject({ seq: 3, round_number: 2, answer_set: false });
    await play(room, 'O', [[a, 'O'], [b, 'X']]);
    expect((await myState(a)).me.status).toBe('ALIVE');
    expect((await myState(b)).me).toMatchObject({ status: 'ELIMINATED', eliminated_round: 2 });
  });
});

describe('O13–O14. winners', () => {
  it('one survivor = champion: no more rounds, FINISH announces it', async () => {
    const { room, players: [a, b, c] } = await started(3);
    await play(room, 'O', [[a, 'O'], [b, 'X'], [c, 'X']]);
    const s = await adminState(room);
    expect(s.game).toMatchObject({ status: 'RESULT_REVEALED', result: 'CHAMPION' });
    for (const bad of ['NEXT', 'CO_WIN']) {
      expect(await rpcError(anon, 'admin_ox_action', {
        p_admin_token: admin, p_room_id: room.id, p_game_id: s.game.id, p_round_id: s.game.current_round_id, p_action: bad,
      })).toBe('INVALID_TRANSITION');
    }
    expect((await publicState(room)).winners).toEqual([]); // announced only by the host
    await act(room, 'FINISH');
    expect((await publicState(room)).winners).toEqual(['ox1']);
    expect((await myState(a)).me.rank).toBe(1);
    expect((await myState(b)).me.rank).toBe(2); // same round = same rank
    expect((await myState(c)).me.rank).toBe(2);
    expect((await adminState(room)).ranking.map((x: any) => x.rank)).toEqual([1, 2, 2]);
  });

  it('several survivors can be declared joint winners (also after a void round)', async () => {
    const { room, players: [a, b, c] } = await started(3);
    await play(room, 'X', [[a, 'X'], [b, 'X'], [c, 'O']]);
    await act(room, 'CO_WIN');
    const s = await publicState(room);
    expect(s.game).toMatchObject({ status: 'FINISHED', result: 'CO_WINNERS' });
    expect(s.winners).toEqual(['ox1', 'ox2']);

    const v = await started(2);
    await play(v.room, 'O', [[v.players[0], 'X']]);
    expect((await adminState(v.room)).game.status).toBe('ROUND_VOID');
    await act(v.room, 'CO_WIN');
    expect((await publicState(v.room)).winners).toEqual(['ox1', 'ox2']);
  });
});

describe('O15. reconnecting, repeated commands, new games', () => {
  it('survival status is server state: reload / new connection gets it back', async () => {
    const { room, players: [a, b] } = await started(2);
    await play(room, 'O', [[a, 'O'], [b, 'O']]);
    const ph = await phones(1);
    try {
      const st = await rpc(ph.clients[0], 'ox_state', { p_token: b.token });
      expect(st.me).toMatchObject({ role: 'PLAYER', status: 'ALIVE' });
      expect(st.verdict).toEqual({ selected: 'O', correct: true });
    } finally {
      await ph.close();
    }
    expect((await myState({ token: 'not-a-token' })).error).toBe('INVALID_TOKEN');
  });

  it('a double REVEAL / CLOSE does not grade twice; a stale screen cannot skip a round', async () => {
    const { room, players: [a, b, c] } = await started(3);
    await setAnswer(room, 'O');
    await act(room, 'OPEN');
    const r = await roundId(room);
    await answer(a, r, 'O');
    await answer(b, r, 'X');
    const g = (await adminState(room)).game;
    const call = (action: string) => rpc(anon, 'admin_ox_action', {
      p_admin_token: admin, p_room_id: room.id, p_game_id: g.id, p_round_id: r, p_action: action,
    });
    await Promise.all([call('CLOSE'), call('CLOSE')]);
    await Promise.all([call('REVEAL'), call('REVEAL'), call('REVEAL')]);
    const s = await adminState(room);
    expect(s.verdicts).toHaveLength(3);
    expect(s.counts).toMatchObject({ alive: 1, eliminated: 2 });
    expect(s.round.survivors_after).toBe(1);
    void c;

    const room2 = (await started(3)).room;
    await play(room2, 'O', []);
    const g2 = (await adminState(room2)).game;
    await act(room2, 'NEXT');
    // second click of the same NEXT (old round id) is refused
    expect(await rpcError(anon, 'admin_ox_action', {
      p_admin_token: admin, p_room_id: room2.id, p_game_id: g2.id, p_round_id: g2.current_round_id, p_action: 'NEXT',
    })).toBe('ROUND_CHANGED');
    expect((await adminState(room2)).game.current_round).toBe(1); // void -> same round again, not 2 or 3
  });

  it('only the host can change the game', async () => {
    const { room, players: [a] } = await started(2);
    const s = await adminState(room);
    expect(await rpcError(anon, 'admin_ox_action', {
      p_admin_token: a.token, p_room_id: room.id, p_game_id: s.game.id, p_round_id: s.game.current_round_id, p_action: 'END',
    })).toBe('ADMIN_AUTH_REQUIRED');
    expect(await rpcError(anon, 'admin_ox_set_answer', { p_admin_token: 'x', p_room_id: room.id, p_round_id: s.game.current_round_id, p_answer: 'O' }))
      .toBe('ADMIN_AUTH_REQUIRED');
    expect(await rpcError(anon, 'admin_ox_state', { p_admin_token: null, p_room_code: room.room_code })).toBe('ADMIN_AUTH_REQUIRED');
  });

  it('NEW_GAME starts a clean game; the old one keeps its own record', async () => {
    const { room, players: [a, b] } = await started(2);
    await play(room, 'O', [[a, 'O'], [b, 'X']]);
    await act(room, 'FINISH');
    const old = (await adminState(room)).game;
    await act(room, 'NEW_GAME');
    const s = await adminState(room);
    expect(s.game).toMatchObject({ game_number: 2, status: 'LOBBY', current_round: 0, result: null });
    expect(s.players).toEqual([]);
    expect(s.rounds).toEqual([]);
    expect((await myState(b)).me).toMatchObject({ role: 'CANDIDATE', status: null });
    expect(s.games.find((x: any) => x.id === old.id)).toMatchObject({ status: 'FINISHED', result: 'CHAMPION', winners: ['ox1'] });
    // the eliminated player of game 1 plays again in game 2
    await act(room, 'START');
    expect(await statusOf(b)).toBe('ALIVE');
  });

  it('END stops the game; the time limit is applied when a round opens', async () => {
    const { room, players: [a, b] } = await started(2);
    await rpc(anon, 'admin_ox_set_time_limit', { p_admin_token: admin, p_room_id: room.id, p_seconds: 7 });
    expect(await rpcError(anon, 'admin_ox_set_time_limit', { p_admin_token: admin, p_room_id: room.id, p_seconds: 31 })).toBe('INVALID_DURATION');
    await setAnswer(room, 'O');
    await act(room, 'OPEN');
    const r = (await adminState(room)).round;
    expect(r.duration_seconds).toBe(7);
    expect(r.deadline_ms - r.started_ms).toBe(7000);
    // mode switch / END are refused while answering
    expect(await rpcError(anon, 'admin_set_mode', { p_admin_token: admin, p_room_id: room.id, p_mode: 'BUZZER' })).toBe('GAME_IN_PROGRESS');
    await act(room, 'CLOSE');
    await act(room, 'END');
    const s = await publicState(room);
    expect(s.game).toMatchObject({ status: 'FINISHED', result: 'ENDED' });
    expect(s.round.correct_answer).toBeNull(); // never revealed
    expect(s.winners.sort()).toEqual([a.nickname, b.nickname].sort());
  });

  it('room reset restarts OX SURVIVAL; other modes are untouched by OX play', async () => {
    const { room, players: [a, b] } = await started(2);
    await play(room, 'O', [[a, 'O'], [b, 'O']]);
    await rpc(anon, 'admin_set_mode', { p_admin_token: admin, p_room_id: room.id, p_mode: 'BUZZER' });
    // quiz buzzer still works with the same participants
    const st = await rpc(anon, 'participant_sync', { p_token: a.token });
    expect(st).toMatchObject({ ok: true, room: { mode: 'BUZZER' } });
    await rpc(anon, 'admin_set_mode', { p_admin_token: admin, p_room_id: room.id, p_mode: 'OX' });
    expect((await adminState(room)).game.current_round).toBe(1); // game kept across mode switches

    await rpc(anon, 'admin_reset_room', { p_admin_token: admin, p_room_id: room.id });
    const s = await adminState(room);
    expect(s.game).toMatchObject({ game_number: 1, status: 'LOBBY' });
    expect((await myState(a)).error).toBe('INVALID_TOKEN');
  });
});

describe('O-D. display stage (walking characters)', () => {
  it('stage lists survivors with live picks, server verdicts after the reveal, and no raw ids', async () => {
    const { room, players: [a, b, c] } = await started(3);
    const stage = async () => (await publicState(room)).stage as Array<{ key: string; name: string; alive: boolean; pick: string | null; correct: boolean | null }>;
    const by = async () => Object.fromEntries((await stage()).map((x) => [x.name, x]));

    const ready = await stage();
    expect(ready.map((x) => x.name)).toEqual(['ox1', 'ox2', 'ox3']);
    expect(ready.every((x) => x.alive && x.pick === null && x.correct === null)).toBe(true);
    // stable avatar key per participant, never the participant id itself
    const keys = ready.map((x) => x.key);
    expect(new Set(keys).size).toBe(3);
    expect(keys.every((k) => /^[0-9a-f]{12}$/.test(k))).toBe(true);
    expect(JSON.stringify(await publicState(room))).not.toContain(a.participant_id);

    await setAnswer(room, 'O');
    await act(room, 'OPEN');
    const r = await roundId(room);
    await answer(a, r, 'O');
    await answer(b, r, 'O');
    await answer(b, r, 'X'); // change of mind
    let s = await by();
    expect([s.ox1.pick, s.ox2.pick, s.ox3.pick]).toEqual(['O', 'X', null]);
    expect(s.ox1.correct).toBeNull();
    expect((await publicState(room)).round.correct_answer).toBeNull(); // picks public, answer key not

    // one realtime move per stored answer, readable by the display (anon)
    const moves = await anon.query('select avatar_key, pick from public.ox_stage_moves where round_id = $1 order by id', [r]);
    expect(moves.rows.map((m) => m.pick)).toEqual(['O', 'O', 'X']);
    expect(moves.rows[2].avatar_key).toBe(s.ox2.key);
    // a stale retry does not emit a move
    await answer(b, r, 'O', 1);
    expect((await anon.query('select count(*)::int as n from public.ox_stage_moves where round_id = $1', [r])).rows[0].n).toBe(3);

    await act(room, 'CLOSE');
    await act(room, 'REVEAL');
    s = await by();
    expect(s.ox1).toMatchObject({ alive: true, correct: true });
    expect(s.ox2).toMatchObject({ alive: false, correct: false, pick: 'X' });
    expect(s.ox3).toMatchObject({ alive: false, correct: false, pick: null });
    expect(s.ox1.key).toBe(keys[0]);

    // the champion screen shows only the winner
    await act(room, 'FINISH');
    expect((await stage()).map((x) => x.name)).toEqual(['ox1']);
    void c;
  });

  it('the next round brings back only the survivors; a void round keeps everyone', async () => {
    const { room, players: [a, b, c, d] } = await started(4);
    await play(room, 'X', [[a, 'X'], [b, 'X'], [c, 'O']]); // c, d out
    await act(room, 'NEXT');
    const st = (await publicState(room)).stage;
    expect(st.map((x: any) => x.name)).toEqual(['ox1', 'ox2']);
    expect(st.every((x: any) => x.pick === null && x.correct === null)).toBe(true);

    await play(room, 'O', [[a, 'X'], [b, 'X']]);
    const v = await publicState(room);
    expect(v.game.status).toBe('ROUND_VOID');
    expect(v.stage.map((x: any) => [x.name, x.alive, x.correct])).toEqual([['ox1', true, false], ['ox2', true, false]]);
    void d;
  });

  it('the lobby stage shows who would play', async () => {
    const room = await oxRoom();
    await joinMany(anon, room.room_code, 2, 'lob');
    const s = await publicState(room);
    expect(s.stage.map((x: any) => x.name)).toEqual(['lob1', 'lob2']);
  });
});
