import { describe, expect, it } from 'vitest';
import { deriveOxView, resultTitle, survivalLine, type OxViewInput } from '../../src/lib/oxView';
import type { OxGame, OxParticipantState, OxRound, Room } from '../../src/lib/types';

const room: Room = {
  id: 'room', room_code: 'ABCD', status: 'OPEN', announcement: null, announcement_at: null,
  test_mode: false, rev: 0, created_at: '', mode: 'OX', sync_show_progress: false,
};
const game = (o: Partial<OxGame> = {}): OxGame => ({
  id: 'g', room_id: 'room', game_number: 1, status: 'LOBBY', current_round: 0, current_round_id: null,
  time_limit_seconds: 10, initial_participant_count: null, result: null, rev: 0, created_at: '',
  started_at: null, finished_at: null, ...o,
});
const DEADLINE = 1_000_000;
const round: OxRound = {
  id: 'r1', seq: 1, round_number: 3, status: 'ANSWERING', duration_seconds: 10, answer_set: true, correct_answer: null,
  started_ms: DEADLINE - 10_000, deadline_ms: DEADLINE, closed_ms: null, revealed_ms: null,
  survivors_before: 17, survivors_after: null, correct_count: null, o_count: null, x_count: null,
};
const me = (o: Partial<OxParticipantState['me']> = {}): OxParticipantState['me'] => ({
  participant_id: 'p', name: '민수', role: 'PLAYER', status: 'ALIVE', eliminated_round: null, answer: null, seq: null, rank: null, ...o,
});
const base: OxViewInput = { room, game: game(), round: null, me: me({ role: 'CANDIDATE', status: null }), verdict: null, now: 0 };
const view = (o: Partial<OxViewInput>) => deriveOxView({ ...base, ...o });

describe('deriveOxView', () => {
  it('lobby and round ready', () => {
    expect(view({})).toMatchObject({ phase: 'LOBBY', canAnswer: false, alive: false });
    expect(view({ game: game({ status: 'ROUND_READY', current_round: 3 }), me: me() }))
      .toMatchObject({ phase: 'READY', title: 'ROUND 3', message: '사회자의 문제를 잘 들어주세요!', canAnswer: false });
  });

  it('only alive players get the buttons, only until the server deadline', () => {
    const g = game({ status: 'ANSWERING', current_round: 3 });
    expect(view({ game: g, round, me: me(), now: DEADLINE - 9_200 })).toMatchObject({ phase: 'OPEN', canAnswer: true, remaining: 10 });
    expect(view({ game: g, round, me: me(), now: DEADLINE })).toMatchObject({ canAnswer: true, remaining: 0 });
    expect(view({ game: g, round, me: me(), now: DEADLINE + 1 })).toMatchObject({ phase: 'CLOSED', canAnswer: false });
    expect(view({ game: g, round, me: me({ status: 'ELIMINATED', eliminated_round: 2 }), now: DEADLINE - 5000 }))
      .toMatchObject({ phase: 'OPEN', canAnswer: false, message: '이제부터 응원단으로 참여해주세요!' });
    expect(view({ game: g, round, me: me({ role: 'SPECTATOR', status: null }), now: DEADLINE - 5000 }).canAnswer).toBe(false);
  });

  it('reveal messages', () => {
    const g = game({ status: 'RESULT_REVEALED', current_round: 3 });
    const r = { ...round, status: 'REVEALED' as const, correct_answer: 'O' as const };
    expect(view({ game: g, round: r, me: me(), verdict: { selected: 'O', correct: true } }))
      .toMatchObject({ phase: 'REVEAL', title: '정답입니다!', message: '다음 라운드 진출!' });
    expect(view({ game: g, round: r, me: me({ status: 'ELIMINATED', eliminated_round: 3 }), verdict: { selected: null, correct: false } }))
      .toMatchObject({ title: '아쉽지만 탈락!', message: '이제부터 응원단으로 참여해주세요!' });
    expect(view({ game: { ...g, result: 'CHAMPION' }, round: r, me: me(), verdict: { selected: 'O', correct: true } }).message).toContain('최후의 1인');
    // already out before this round: just the answer
    expect(view({ game: g, round: r, me: me({ status: 'ELIMINATED', eliminated_round: 1 }) }).title).toBe('정답은 O!');
    expect(view({ game: game({ status: 'ROUND_VOID' }), round: r, me: me() })).toMatchObject({ phase: 'VOID', title: '전원 오답!' });
  });

  it('finished, ended room, loading', () => {
    expect(view({ game: game({ status: 'FINISHED', result: 'CHAMPION' }), me: me() })).toMatchObject({ phase: 'FINISHED', title: 'OX SURVIVAL CHAMPION!' });
    expect(view({ game: game({ status: 'FINISHED', result: 'CHAMPION' }), me: me({ status: 'ELIMINATED', eliminated_round: 4 }) }).title).toBe('CHAMPION');
    expect(view({ room: { ...room, status: 'ENDED' } }).phase).toBe('ENDED');
    expect(view({ me: null }).phase).toBe('LOADING');
  });
});

describe('helpers', () => {
  it('survival line and result titles', () => {
    expect(survivalLine({ survivors_before: 17, survivors_after: 11 })).toEqual({ survived: '17명 중 11명 생존!', eliminated: 6 });
    expect(survivalLine({ survivors_before: 17, survivors_after: null })).toBeNull();
    expect(resultTitle('CO_WINNERS', true)).toBe('공동 우승!');
    expect(resultTitle('ENDED', false)).toBe('게임 종료');
  });
});
