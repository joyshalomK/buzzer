// FAMILY MATCH MODE (우리 가족 이구동성) — integration tests against a real
// PostgreSQL server running the production migrations. Numbers refer to the
// README test plan (M1 … M12).
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
type Room = { id: string; room_code: string };
type Pick = 'A' | 'B';

async function matchRoom() {
  const room = await createRoom(anon, admin);
  await rpc(anon, 'admin_set_mode', { p_admin_token: admin, p_room_id: room.id, p_mode: 'MATCH' });
  return room as Room;
}

const join = (code: string, team: string, label: string, db: pg.Pool | pg.Client = anon) =>
  rpc<Member>(db, 'sync_join', { p_room_code: code, p_team_name: team, p_label: label });

async function family(room: Room, team: string) {
  const a = await join(room.room_code, team, '아빠');
  const b = await join(room.room_code, team, '딸');
  return [a, b] as const;
}

const adminState = (room: Room) => rpc(anon, 'admin_match_state', { p_admin_token: admin, p_room_code: room.room_code });
const publicState = (room: Room) => rpc(anon, 'match_public_state', { p_room_code: room.room_code });
const myState = (m: Member) => rpc(anon, 'match_state', { p_token: m.token });

/** Runs an admin action against whatever the host currently sees. */
async function act(room: Room, action: string) {
  const s = await adminState(room);
  return rpc(anon, 'admin_match_action', {
    p_admin_token: admin, p_room_id: room.id, p_game_id: s.game.id,
    p_expected_question: s.game.current_question, p_action: action,
  });
}

async function currentQuestionId(room: Room) {
  return (await adminState(room)).question.id as string;
}

let seq = 1;
const answer = (m: Member, questionId: string, option: string, s = seq++, db: pg.Pool | pg.Client = anon) =>
  rpc(db, 'match_answer', { p_token: m.token, p_question_id: questionId, p_option: option, p_seq: s });

/** Moves the deadline of an open question into the past (no 15 s wait). */
const expire = (questionId: string) =>
  su.query(`update public.family_match_questions set closes_at = clock_timestamp() - interval '1 millisecond' where id = $1`, [questionId]);

/** Plays the current READY question: open, answer, close, reveal. */
async function play(room: Room, picks: Array<[Member, Pick]>) {
  await act(room, 'OPEN');
  const q = await currentQuestionId(room);
  for (const [m, p] of picks) expect((await answer(m, q, p)).result).toBe('ACCEPTED');
  await act(room, 'CLOSE');
  await act(room, 'REVEAL');
  return q;
}

const byTeam = (rows: any[]): Record<string, any> => Object.fromEntries(rows.map((r) => [r.team_name, r]));

describe('M1–M3. scoring per question', () => {
  it('same pick = 1, different pick = 0, one answer = 0, no answer = 0', async () => {
    const room = await matchRoom();
    const [kimA, kimB] = await family(room, '김가족');
    const [leeA, leeB] = await family(room, '이가족');
    const [parkA] = await family(room, '박가족');
    await family(room, '최가족');

    await act(room, 'PREPARE');
    await play(room, [[kimA, 'A'], [kimB, 'A'], [leeA, 'A'], [leeB, 'B'], [parkA, 'B']]);

    const s = await adminState(room);
    const r = byTeam(s.results);
    expect(r['김가족']).toMatchObject({ option_1: 'A', option_2: 'A', matched: true, points: 1, total: 1 });
    expect(r['이가족']).toMatchObject({ option_1: 'A', option_2: 'B', matched: false, points: 0 });
    expect(r['박가족']).toMatchObject({ option_1: 'B', option_2: null, matched: false, points: 0 });
    expect(r['최가족']).toMatchObject({ option_1: null, option_2: null, matched: false, points: 0 });

    // what each phone sees after the reveal
    const kim = await myState(kimA);
    expect(kim.reveal).toMatchObject({ mine: 'A', partner: { label: '딸', option: 'A' }, matched: true, points: 1 });
    expect(kim.score).toBe(1);
    const park = await myState(parkA);
    expect(park.reveal).toMatchObject({ mine: 'B', partner: null, matched: false, points: 0 });
  });
});

describe('M4. time limit on the server clock', () => {
  it('rejects answers after the deadline, closes the question on the next read and keeps earlier answers', async () => {
    const room = await matchRoom();
    const [a, b] = await family(room, '늦은가족');
    await act(room, 'PREPARE');
    await act(room, 'OPEN');
    const q = await currentQuestionId(room);
    expect((await answer(a, q, 'B')).result).toBe('ACCEPTED');
    await expire(q);

    const late = await answer(b, q, 'B');
    expect(late).toMatchObject({ ok: false, result: 'TOO_LATE' });
    // a change of mind after the deadline is rejected too; the stored answer stays
    expect(await answer(a, q, 'A')).toMatchObject({ result: 'TOO_LATE', option: 'B' });

    const s = await adminState(room); // lazy settle
    expect(s.game.status).toBe('QUESTION_CLOSED');
    expect(s.question.status).toBe('CLOSED');
    expect(byTeam(s.results)['늦은가족']).toMatchObject({ option_1: 'B', option_2: null, points: 0 });
    expect(await answer(b, q, 'B')).toMatchObject({ result: 'CLOSED' });

    // the host's early close after the timer already closed it is a no-op
    const g = await act(room, 'CLOSE');
    expect(g.status).toBe('QUESTION_CLOSED');
  });

  it('answers before OPEN are rejected', async () => {
    const room = await matchRoom();
    const [a] = await family(room, '빠른가족');
    await act(room, 'PREPARE');
    const q = await currentQuestionId(room);
    expect(await answer(a, q, 'A')).toMatchObject({ ok: false, result: 'NOT_OPEN' });
  });
});

describe('M5. changing the answer', () => {
  it('the last answer counts; an overtaken older request cannot overwrite a newer one; retries are idempotent', async () => {
    const room = await matchRoom();
    const [a, b] = await family(room, '변덕가족');
    await act(room, 'PREPARE');
    await act(room, 'OPEN');
    const q = await currentQuestionId(room);

    expect(await answer(a, q, 'A', 100)).toMatchObject({ result: 'ACCEPTED', option: 'A' });
    expect(await answer(a, q, 'B', 101)).toMatchObject({ result: 'ACCEPTED', option: 'B' });
    // request 100 arrives again late (network): ignored, server keeps B
    expect(await answer(a, q, 'A', 100)).toMatchObject({ result: 'STALE', option: 'B' });
    // retry of the newest request
    expect(await answer(a, q, 'B', 101)).toMatchObject({ result: 'ACCEPTED', option: 'B' });
    expect(await answer(a, q, 'x', 102)).toMatchObject({ ok: false, result: 'INVALID_OPTION' });
    expect(await answer(b, q, 'b', 7)).toMatchObject({ result: 'ACCEPTED', option: 'B' }); // case-insensitive

    const rows = await su.query('select selected_option, change_count from public.family_match_answers where question_id = $1 and participant_id = $2', [q, a.participant_id]);
    expect(rows.rows).toEqual([{ selected_option: 'B', change_count: 1 }]);
    expect((await myState(a)).me).toEqual({ answer: 'B', seq: 101 });

    await act(room, 'CLOSE');
    expect(byTeam((await adminState(room)).results)['변덕가족']).toMatchObject({ matched: true, points: 1 });
  });
});

describe('M6. 10 questions', () => {
  it('accumulates scores over all 10 questions and computes rate and rank', async () => {
    const room = await matchRoom();
    const [kA, kB] = await family(room, '김가족');
    const [lA, lB] = await family(room, '이가족');
    const [pA] = await family(room, '박가족');
    // 김가족 matches on even questions only (5/10), 이가족 on every question (10/10),
    // 박가족 has one member and never scores.
    await act(room, 'PREPARE');
    for (let n = 1; n <= 10; n++) {
      await play(room, [[kA, 'A'], [kB, n % 2 ? 'B' : 'A'], [lA, 'B'], [lB, 'B'], [pA, 'A']]);
      const s = await adminState(room);
      expect(s.game.current_question).toBe(n);
      expect(byTeam(s.standings)['이가족'].score).toBe(n);
      expect(byTeam(s.results)['김가족'].total).toBe(Math.floor(n / 2));
      if (n < 10) await act(room, 'NEXT');
    }
    expect(await rpcError(anon, 'admin_match_action', {
      p_admin_token: admin, p_room_id: room.id, p_game_id: (await adminState(room)).game.id,
      p_expected_question: 10, p_action: 'NEXT',
    })).toBe('INVALID_TRANSITION');

    const fin = await act(room, 'FINISH');
    expect(fin).toMatchObject({ status: 'GAME_FINISHED', total_questions: 10 });
    const final = byTeam((await adminState(room)).final);
    expect(final['이가족']).toMatchObject({ matched_count: 10, total_questions: 10, match_percentage: 100, rank: 1 });
    expect(final['김가족']).toMatchObject({ matched_count: 5, match_percentage: 50, rank: 2 });
    expect(final['박가족']).toMatchObject({ matched_count: 0, match_percentage: 0, rank: 3 });

    expect((await myState(kA)).score).toBe(5);
  });
});

describe('M7. fewer questions', () => {
  it('a 3-question game ends after question 3 and uses 3 as the denominator', async () => {
    const room = await matchRoom();
    const s0 = await adminState(room);
    const questions = s0.questions.map((q: any) => ({ ...q, duration_seconds: 20 }));
    questions[0].question_text = '바뀐 첫 질문';
    const setup = (count: number, qs = questions) => rpc(anon, 'admin_match_setup', {
      p_admin_token: admin, p_room_id: room.id, p_game_id: s0.game.id,
      p_title: '테스트 게임', p_question_count: count, p_questions: JSON.stringify(qs),
    });
    expect(await rpcError(anon, 'admin_match_setup', {
      p_admin_token: admin, p_room_id: room.id, p_game_id: s0.game.id, p_title: 'x', p_question_count: 11, p_questions: JSON.stringify(questions),
    })).toBe('INVALID_COUNT');
    expect(await setup(3, questions.map((q: any, i: number) => (i === 2 ? { ...q, duration_seconds: 31 } : q))).catch((e) => e.message)).toBe('INVALID_DURATION');
    expect(await setup(3, questions.map((q: any, i: number) => (i === 2 ? { ...q, option_b: '  ' } : q))).catch((e) => e.message)).toBe('OPTION_REQUIRED');
    expect(await setup(3)).toMatchObject({ question_count: 3, title: '테스트 게임' });

    const [a, b] = await family(room, '짧은가족');
    await act(room, 'PREPARE');
    const q1 = (await adminState(room)).question;
    expect(q1).toMatchObject({ question_text: '바뀐 첫 질문', duration_seconds: 20 });
    await play(room, [[a, 'A'], [b, 'A']]);
    await act(room, 'NEXT');
    await play(room, [[a, 'A'], [b, 'B']]);
    await act(room, 'NEXT');
    await play(room, [[a, 'B'], [b, 'B']]);
    expect(await act(room, 'NEXT').catch((e) => e.message)).toBe('INVALID_TRANSITION');
    // the lobby setup cannot be changed in the middle of a game
    expect(await setup(5).catch((e) => e.message)).toBe('INVALID_TRANSITION');

    await act(room, 'FINISH');
    const f = (await adminState(room)).final[0];
    expect(f).toMatchObject({ team_name: '짧은가족', matched_count: 2, total_questions: 3, match_percentage: 66.7, rank: 1 });
  });

  it('ending early: the denominator is the number of questions played', async () => {
    const room = await matchRoom();
    const [a, b] = await family(room, '조기가족');
    await act(room, 'PREPARE');
    await play(room, [[a, 'A'], [b, 'A']]);
    await act(room, 'NEXT');
    await play(room, [[a, 'A'], [b, 'B']]);
    await act(room, 'FINISH');
    expect((await adminState(room)).final[0]).toMatchObject({ matched_count: 1, total_questions: 2, match_percentage: 50 });
  });
});

describe('M8. ties', () => {
  it('competition ranking (1, 1, 3), final reveal 3rd -> 1st, and a FAMILY SYNC final for the tied families', async () => {
    const room = await matchRoom();
    const [aA, aB] = await family(room, '가가족');
    const [bA, bB] = await family(room, '나가족');
    const [cA, cB] = await family(room, '다가족');
    const [dA, dB] = await family(room, '라가족');
    const [eA, eB] = await family(room, '마가족');
    await act(room, 'PREPARE');
    // q1: 가,나,다 match. q2: 가,나 match, 라 matches. => 가 2, 나 2, 다 1, 라 1, 마 0
    await play(room, [[aA, 'A'], [aB, 'A'], [bA, 'B'], [bB, 'B'], [cA, 'A'], [cB, 'A'], [dA, 'A'], [dB, 'B'], [eA, 'A'], [eB, 'B']]);
    await act(room, 'NEXT');
    await play(room, [[aA, 'B'], [aB, 'B'], [bA, 'A'], [bB, 'A'], [cA, 'A'], [cB, 'B'], [dA, 'B'], [dB, 'B'], [eA, 'B'], [eB, 'A']]);
    await act(room, 'FINISH');

    const s = await adminState(room);
    expect(s.final.map((t: any) => [t.team_name, t.rank])).toEqual([
      ['가가족', 1], ['나가족', 1], ['다가족', 3], ['라가족', 3], ['마가족', 5],
    ]);

    // nothing public until the host starts the reveal
    expect((await publicState(room)).final).toEqual([]);
    expect((await myState(aA)).final).toEqual([]);

    await act(room, 'REVEAL_FINAL_NEXT'); // rank 3 (and everything below it)
    expect((await publicState(room)).final.map((t: any) => t.team_name)).toEqual(['다가족', '라가족', '마가족']);
    await act(room, 'REVEAL_FINAL_NEXT'); // rank 2 does not exist -> straight to 1
    expect((await publicState(room)).game.final_revealed_rank).toBe(1);
    expect((await publicState(room)).final).toHaveLength(5);

    // tie-break: FAMILY SYNC final between the tied families
    const tied = s.final.filter((t: any) => t.rank === 1).map((t: any) => t.team_id);
    expect(await rpcError(anon, 'admin_match_sync_final', {
      p_admin_token: admin, p_room_id: room.id, p_game_id: s.game.id, p_team_ids: [tied[0]],
    })).toBe('INVALID_TEAMS');
    const r = await rpc(anon, 'admin_match_sync_final', { p_admin_token: admin, p_room_id: room.id, p_game_id: s.game.id, p_team_ids: tied });
    expect(r.mode).toBe('SYNC');
    const sync = await rpc(anon, 'admin_sync_state', { p_admin_token: admin, p_room_code: room.room_code });
    expect(sync.round).toMatchObject({ status: 'READY' });
    expect([...sync.round.team_ids].sort()).toEqual([...tied].sort());
    // the same phone sessions play the final
    expect((await rpc(anon, 'sync_state', { p_token: aA.token })).me.eligible).toBe(true);
    expect((await rpc(anon, 'sync_state', { p_token: cA.token })).me.eligible).toBe(false);
  });
});

describe('M9. new game / restart', () => {
  it('a new game keeps the question set but none of the answers or scores', async () => {
    const room = await matchRoom();
    const [a, b] = await family(room, '재경기가족');
    await act(room, 'PREPARE');
    const oldQ = await play(room, [[a, 'A'], [b, 'A']]);
    await act(room, 'FINISH');
    const first = await adminState(room);

    const g2 = await act(room, 'NEW_GAME');
    expect(g2).toMatchObject({ game_number: 2, status: 'LOBBY', current_question: 0 });
    const s = await adminState(room);
    expect(s.standings).toEqual([]);
    expect(s.final).toEqual([]);
    expect(s.questions.map((q: any) => q.question_text)).toEqual(first.questions.map((q: any) => q.question_text));
    expect(s.questions.every((q: any) => q.status === 'PENDING')).toBe(true);
    expect(s.games.map((g: any) => [g.game_number, g.status, g.winners])).toEqual([
      [2, 'LOBBY', []], [1, 'GAME_FINISHED', ['재경기가족']],
    ]);
    // a request for the old game's question is stale
    expect(await answer(a, oldQ, 'A')).toMatchObject({ result: 'STALE_QUESTION' });
    // old game's records are untouched
    const old = await su.query('select count(*)::int as n from public.family_match_question_results where game_id = $1', [first.game.id]);
    expect(old.rows[0].n).toBe(1);

    await act(room, 'PREPARE');
    await play(room, [[a, 'A'], [b, 'B']]);
    expect(byTeam((await adminState(room)).standings)['재경기가족'].score).toBe(0);
  });

  it('restarting a question discards its answers', async () => {
    const room = await matchRoom();
    const [a, b] = await family(room, '다시가족');
    await act(room, 'PREPARE');
    const q = await play(room, [[a, 'A'], [b, 'A']]);
    expect((await myState(a)).score).toBe(1);
    await act(room, 'RESTART');
    const s = await adminState(room);
    expect(s.game).toMatchObject({ status: 'QUESTION_READY', current_question: 1 });
    expect(s.results).toEqual([]);
    expect(s.standings).toEqual([]);
    expect((await myState(a)).me.answer).toBeNull();
    expect((await myState(a)).score).toBe(0);
    await act(room, 'OPEN');
    expect(await currentQuestionId(room)).toBe(q);
    expect(await answer(a, q, 'B')).toMatchObject({ result: 'ACCEPTED' });
  });

  it('a stale admin screen cannot skip a question (double click)', async () => {
    const room = await matchRoom();
    await family(room, '클릭가족');
    const s = await adminState(room);
    const call = () => rpc(anon, 'admin_match_action', {
      p_admin_token: admin, p_room_id: room.id, p_game_id: s.game.id, p_expected_question: 0, p_action: 'PREPARE',
    });
    await call();
    expect(await call().catch((e) => e.message)).toBe('ROUND_CHANGED');
  });
});

describe('M13. pictures on the big screen', () => {
  it('each question carries its picture; the editor can change it, reordering moves it, bad addresses are refused', async () => {
    const room = await matchRoom();
    const s0 = await adminState(room);
    expect(s0.questions.map((q: any) => q.image_url)).toEqual(Array.from({ length: 10 }, (_, i) => `/match/q${i + 1}.jpg`));

    // swap questions 1 and 2 (picture follows), give 3 a web picture, remove 4's picture
    const qs = s0.questions.map((q: any) => ({ ...q }));
    [qs[0], qs[1]] = [qs[1], qs[0]];
    qs[2].image_url = 'https://example.com/pic.png';
    qs[3].image_url = '';
    const setup = (questions: any[]) => rpc(anon, 'admin_match_setup', {
      p_admin_token: admin, p_room_id: room.id, p_game_id: s0.game.id, p_title: s0.game.title,
      p_question_count: 10, p_questions: JSON.stringify(questions),
    });
    await setup(qs);
    let s = await adminState(room);
    expect(s.questions.slice(0, 4).map((q: any) => [q.story_title, q.image_url])).toEqual([
      ['복도에 남겨진 발자국', '/match/q2.jpg'], ['사라진 선물 상자', '/match/q1.jpg'],
      ['수상한 식탁', 'https://example.com/pic.png'], ['휴대폰 속 비밀 메시지', ''],
    ]);
    for (const bad of ['http://example.com/a.png', 'https://x.com/a.png") ; y', '/match/../a.jpg', 'javascript:alert(1)']) {
      expect(await setup(qs.map((q: any, i: number) => (i === 5 ? { ...q, image_url: bad } : q))).catch((e) => e.message)).toBe('INVALID_IMAGE');
    }
    // an older admin screen that does not send image_url keeps the picture
    const { image_url: _, ...noImage } = s.questions[1];
    await rpc(anon, 'admin_match_edit_question', {
      p_admin_token: admin, p_room_id: room.id, p_game_id: s0.game.id, p_question_number: 2, p_question: JSON.stringify(noImage),
    });
    expect((await adminState(room)).questions[1].image_url).toBe('/match/q1.jpg');

    // the screen and the next game get the picture of the question on screen
    await act(room, 'PREPARE');
    expect((await publicState(room)).question.image_url).toBe('/match/q2.jpg');
    await act(room, 'NEW_GAME');
    s = await adminState(room);
    expect(s.questions[2].image_url).toBe('https://example.com/pic.png');
  });
});

describe('M10. other modes are unaffected', () => {
  it('buzzer and FAMILY SYNC still work in the same room; switching is blocked while a question is open', async () => {
    const room = await matchRoom();
    const [a, b] = await family(room, '모드가족');
    await act(room, 'PREPARE');
    await act(room, 'OPEN');
    expect(await rpcError(anon, 'admin_set_mode', { p_admin_token: admin, p_room_id: room.id, p_mode: 'BUZZER' })).toBe('GAME_IN_PROGRESS');
    const q = await currentQuestionId(room);
    await answer(a, q, 'A');
    await answer(b, q, 'A');
    await act(room, 'CLOSE');

    // buzzer
    await rpc(anon, 'admin_set_mode', { p_admin_token: admin, p_room_id: room.id, p_mode: 'BUZZER' });
    const p = await rpc(anon, 'join_room', { p_room_code: room.room_code, p_nickname: '부저왕' });
    const st = await rpc(anon, 'admin_get_state', { p_admin_token: admin, p_room_code: room.room_code });
    await rpc(anon, 'admin_round_action', { p_admin_token: admin, p_room_id: room.id, p_round_id: st.round.id, p_action: 'ARM' });
    expect((await rpc(anon, 'buzz', { p_token: p.token, p_round_id: st.round.id })).result).toBe('WON');
    expect(await rpcError(anon, 'sync_join', { p_room_code: room.room_code, p_team_name: '새가족', p_label: '엄마' })).toBe('NOT_SYNC_MODE');
    // family tokens never work on the buzzer and vice versa
    expect((await rpc(anon, 'buzz', { p_token: a.token, p_round_id: st.round.id })).result).toBe('INVALID_TOKEN');
    expect((await rpc(anon, 'match_state', { p_token: p.token })).error).toBe('INVALID_TOKEN');

    // FAMILY SYNC with the same families
    await rpc(anon, 'admin_set_mode', { p_admin_token: admin, p_room_id: room.id, p_mode: 'SYNC' });
    const sync = await rpc(anon, 'admin_sync_state', { p_admin_token: admin, p_room_code: room.room_code });
    const r = await rpc(anon, 'admin_sync_action', { p_admin_token: admin, p_room_id: room.id, p_round_id: sync.round.id, p_action: 'START' });
    await su.query(`update public.sync_rounds set started_at = clock_timestamp() - interval '50 milliseconds' where id = $1`, [r.id]);
    expect((await rpc(anon, 'sync_buzz', { p_token: a.token, p_round_id: r.id })).result).toBe('ACCEPTED');
    expect((await rpc(anon, 'sync_buzz', { p_token: b.token, p_round_id: r.id })).result).toBe('ACCEPTED');
    const after = await rpc(anon, 'admin_sync_state', { p_admin_token: admin, p_room_code: room.room_code });
    expect(after.results[0]).toMatchObject({ team_name: '모드가족', status: 'COMPLETE', rank: 1 });

    // back to MATCH: the game is where we left it
    await rpc(anon, 'admin_set_mode', { p_admin_token: admin, p_room_id: room.id, p_mode: 'MATCH' });
    const m = await adminState(room);
    expect(m.game).toMatchObject({ status: 'QUESTION_CLOSED', current_question: 1 });
    expect(byTeam(m.results)['모드가족'].points).toBe(1);
  });

  it('a full room reset restarts the match game and keeps the edited question set', async () => {
    const room = await matchRoom();
    const s0 = await adminState(room);
    const qs = s0.questions.map((q: any) => ({ ...q }));
    qs[4].option_a = '자전거';
    await rpc(anon, 'admin_match_setup', {
      p_admin_token: admin, p_room_id: room.id, p_game_id: s0.game.id, p_title: '우리 게임', p_question_count: 5, p_questions: JSON.stringify(qs),
    });
    const [a, b] = await family(room, '초기화가족');
    await act(room, 'PREPARE');
    await play(room, [[a, 'A'], [b, 'A']]);
    await rpc(anon, 'admin_reset_room', { p_admin_token: admin, p_room_id: room.id });
    const s = await adminState(room);
    expect(s.game).toMatchObject({ game_number: 1, status: 'LOBBY', title: '우리 게임', question_count: 5 });
    expect(s.questions[4].option_a).toBe('자전거');
    expect(s.teams).toEqual([]);
    expect(s.games).toHaveLength(1);
  });
});

describe('M11. privacy', () => {
  it("nobody sees a partner's pick before the reveal; answer tables are not readable", async () => {
    const room = await matchRoom();
    const [a, b] = await family(room, '비밀가족');
    await act(room, 'PREPARE');
    await act(room, 'OPEN');
    const q = await currentQuestionId(room);
    await answer(a, q, 'A');

    const sb = await myState(b);
    expect(sb.me.answer).toBeNull();
    expect(sb.reveal).toBeNull();
    expect(JSON.stringify(sb)).not.toContain('"A"');

    const host = await adminState(room);
    expect(host.results).toEqual([]);
    expect(host.teams[0]).toMatchObject({ answered: 1 });
    expect(host.teams[0].members.map((m: any) => m.answered)).toEqual([true, false]);
    expect(JSON.stringify(host.teams)).not.toMatch(/"option|selected/);

    let pub = await publicState(room);
    expect(pub.results).toEqual([]);
    expect(pub.progress).toMatchObject({ answered_teams: 0, answered_people: 1, team_count: 1 });

    await answer(b, q, 'B');
    await act(room, 'CLOSE');
    // closed but not revealed: host sees the verdicts, phones and the screen do not
    expect((await adminState(room)).results).toHaveLength(1);
    expect((await myState(a)).reveal).toBeNull();
    pub = await publicState(room);
    expect(pub.results).toEqual([]);

    await act(room, 'REVEAL');
    expect((await myState(b)).reveal).toMatchObject({ mine: 'B', partner: { option: 'A' }, matched: false });
    expect((await publicState(room)).results[0]).toMatchObject({ team_name: '비밀가족', option_1: 'A', option_2: 'B' });

    // direct table access with the anon key
    for (const table of ['family_match_answers', 'family_match_questions', 'family_match_question_results', 'family_match_results']) {
      await expect(anon.query(`select * from public.${table}`)).rejects.toThrow(/permission denied/);
    }
    await expect(anon.query(`update public.family_match_games set status = 'GAME_FINISHED'`)).rejects.toThrow(/permission denied/);
    // admin RPCs need the admin token
    expect(await rpcError(anon, 'admin_match_state', { p_admin_token: 'nope', p_room_code: room.room_code })).toBe('ADMIN_AUTH_REQUIRED');
    expect(await rpcError(anon, 'admin_match_action', {
      p_admin_token: 'nope', p_room_id: room.id, p_game_id: null, p_expected_question: 1, p_action: 'NEXT',
    })).toBe('ADMIN_AUTH_REQUIRED');
  });

  it('cumulative standings on the screen only count revealed questions and stop before the last question', async () => {
    const room = await matchRoom();
    const s0 = await adminState(room);
    await rpc(anon, 'admin_match_setup', {
      p_admin_token: admin, p_room_id: room.id, p_game_id: s0.game.id, p_title: '순위 테스트', p_question_count: 2,
      p_questions: JSON.stringify(s0.questions),
    });
    await rpc(anon, 'admin_match_set_standings', { p_admin_token: admin, p_room_id: room.id, p_show: true });
    const [a, b] = await family(room, '순위가족');
    await act(room, 'PREPARE');
    await act(room, 'OPEN');
    const q = await currentQuestionId(room);
    await answer(a, q, 'A');
    await answer(b, q, 'A');
    await act(room, 'CLOSE');
    expect((await publicState(room)).standings).toEqual([]); // closed, not revealed
    await act(room, 'REVEAL');
    expect((await publicState(room)).standings[0]).toMatchObject({ team_name: '순위가족', score: 1, rank: 1 });
    await act(room, 'NEXT'); // last question
    expect((await publicState(room)).standings).toEqual([]);
  });
});

describe('M12. concurrency, duplicates, reconnects', () => {
  it('20 phones answer at once while the host closes: every accepted answer is scored, nothing else', async () => {
    const room = await matchRoom();
    const { clients, close } = await phones(20);
    const members = await Promise.all(
      clients.map((c, i) => join(room.room_code, `가족${Math.floor(i / 2) + 1}`, i % 2 ? '엄마' : '아빠', c)),
    );
    expect(new Set(members.map((m) => m.team_id)).size).toBe(10);
    await act(room, 'PREPARE');
    await act(room, 'OPEN');
    const q = await currentQuestionId(room);
    const s = await adminState(room);

    const [results] = await Promise.all([
      Promise.all(clients.map((c, i) => answer(members[i], q, i % 3 ? 'A' : 'B', 1, c))),
      new Promise((r) => setTimeout(r, 5)).then(() => rpc(anon, 'admin_match_action', {
        p_admin_token: admin, p_room_id: room.id, p_game_id: s.game.id, p_expected_question: 1, p_action: 'CLOSE',
      })),
    ]);
    await close();

    results.forEach((r) => expect(['ACCEPTED', 'CLOSED', 'TOO_LATE']).toContain(r.result));
    const verdicts = byTeam((await adminState(room)).results);
    expect(Object.keys(verdicts)).toHaveLength(10);
    members.forEach((m, i) => {
      const v = verdicts[m.team_name];
      const stored = v.label_1 === m.label ? v.option_1 : v.option_2;
      expect(stored).toBe(results[i].result === 'ACCEPTED' ? (i % 3 ? 'A' : 'B') : null);
    });
  });

  it('reloading restores my answer; a second device with the same token updates the same answer', async () => {
    const room = await matchRoom();
    const [a] = await family(room, '복구가족');
    await act(room, 'PREPARE');
    await act(room, 'OPEN');
    const q = await currentQuestionId(room);
    await answer(a, q, 'A', 1);
    const again = await myState(a); // page reload / network back
    expect(again.me).toEqual({ answer: 'A', seq: 1 });
    expect(again.question).toMatchObject({ id: q, status: 'OPEN' });
    expect(again.question.closes_ms).toBeGreaterThan(again.server_now_ms);
    await answer(a, q, 'B', 2); // the other phone
    const rows = await su.query('select count(*)::int as n from public.family_match_answers where question_id = $1', [q]);
    expect(rows.rows[0].n).toBe(1);
  });

  it('team limits, leaving and late families', async () => {
    const room = await matchRoom();
    const [a, b] = await family(room, '꽉찬가족');
    expect(await rpcError(anon, 'sync_join', { p_room_code: room.room_code, p_team_name: '꽉찬가족', p_label: '삼촌' })).toBe('TEAM_FULL');

    await act(room, 'PREPARE');
    await act(room, 'OPEN');
    const q1 = await currentQuestionId(room);
    await answer(a, q1, 'A');
    // leaving is blocked while answering is open (fixing a typo comes later)
    expect(await rpcError(anon, 'sync_leave', { p_token: b.token })).toBe('MATCH_OPEN');
    // a family joining during the game plays from now on
    const [n1, n2] = await family(room, '늦둥이네');
    await answer(n1, q1, 'B');
    await answer(n2, q1, 'B');
    await act(room, 'CLOSE');
    await act(room, 'REVEAL');

    // a kicked member's answer stays; the kicked token is refused
    await rpc(anon, 'admin_kick', { p_admin_token: admin, p_participant_id: a.participant_id });
    expect((await myState(a)).error).toBe('KICKED');
    await act(room, 'NEXT');
    await act(room, 'OPEN');
    const q2 = await currentQuestionId(room);
    expect(await answer(a, q2, 'A')).toMatchObject({ ok: false, result: 'KICKED' });
    // a replacement takes the free slot
    const c = await join(room.room_code, '꽉찬가족', '엄마');
    await answer(c, q2, 'A');
    await answer(b, q2, 'A');
    await act(room, 'CLOSE');
    const v = byTeam((await adminState(room)).results);
    expect(v['꽉찬가족']).toMatchObject({ label_1: '엄마', option_1: 'A', label_2: '딸', option_2: 'A', points: 1 });
    await act(room, 'FINISH');
    const f = byTeam((await adminState(room)).final);
    expect(f['늦둥이네']).toMatchObject({ matched_count: 1, total_questions: 2, match_percentage: 50 });
    expect(f['꽉찬가족']).toMatchObject({ matched_count: 1, total_questions: 2 });
  });
});
