import { describe, expect, it } from 'vitest';
import { matchFinalToCsv, matchVerdictsToCsv } from '../../src/lib/csv';
import {
  createSeq, deriveMatchView, finalFullyRevealed, finalTies, formatPercent, optionText, validateDraft, verdictMessage,
  type MatchViewInput,
} from '../../src/lib/matchView';
import type { MatchFinalRow, MatchGame, MatchQuestion, Room } from '../../src/lib/types';

const room: Room = {
  id: 'room', room_code: 'ABCD', status: 'OPEN', announcement: null, announcement_at: null,
  test_mode: false, rev: 0, created_at: '', mode: 'MATCH', sync_show_progress: false,
};
const game = (o: Partial<MatchGame> = {}): MatchGame => ({
  id: 'g', room_id: 'room', game_number: 1, title: '사라진 문화상품권', status: 'LOBBY', question_count: 10,
  current_question: 0, total_questions: null, show_standings: false, final_revealed_rank: null, rev: 0,
  created_at: '', finished_at: null, ...o,
});
const CLOSES = 1_000_000;
const question: MatchQuestion = {
  id: 'q1', question_number: 3, story_title: '수상한 식탁', story_text: '', question_text: '무엇을 먼저 먹을까요?',
  option_a: '치킨', option_b: '피자', duration_seconds: 15, status: 'OPEN', opened_ms: CLOSES - 15_000, closes_ms: CLOSES, closed_ms: null,
};
const base: MatchViewInput = { room, game: game(), question: null, teamSize: 2, now: CLOSES - 20_000 };
const view = (o: Partial<MatchViewInput>) => deriveMatchView({ ...base, ...o });

describe('deriveMatchView', () => {
  it('lobby: partner missing vs. both connected', () => {
    expect(view({ teamSize: 1 })).toMatchObject({ phase: 'LOBBY', title: '파트너를 기다리는 중', canAnswer: false });
    expect(view({}).title).toBe('2명 모두 접속 완료');
  });

  it('buttons are enabled only while the question is open on the server clock', () => {
    const g = game({ status: 'QUESTION_OPEN', current_question: 3 });
    expect(view({ game: game({ status: 'QUESTION_READY', current_question: 3 }), question: { ...question, status: 'READY', closes_ms: null } }))
      .toMatchObject({ phase: 'READY', canAnswer: false });
    expect(view({ game: g, question, now: CLOSES - 14_200 })).toMatchObject({ phase: 'OPEN', canAnswer: true, remaining: 15 });
    expect(view({ game: g, question, now: CLOSES - 4001 })).toMatchObject({ remaining: 5 });
    expect(view({ game: g, question, now: CLOSES })).toMatchObject({ phase: 'OPEN', canAnswer: true, remaining: 0 });
    expect(view({ game: g, question, now: CLOSES + 1 })).toMatchObject({ phase: 'CLOSED', canAnswer: false });
  });

  it('closed, reveal, finished and ended', () => {
    expect(view({ game: game({ status: 'QUESTION_CLOSED' }) })).toMatchObject({ phase: 'CLOSED', title: '응답 마감!' });
    expect(view({ game: game({ status: 'RESULT_REVEAL' }) }).phase).toBe('REVEAL');
    expect(view({ game: game({ status: 'GAME_FINISHED' }) }).phase).toBe('FINISHED');
    expect(view({ room: { ...room, status: 'ENDED' } }).phase).toBe('ENDED');
    expect(view({ game: null }).phase).toBe('LOADING');
  });
});

describe('helpers', () => {
  it('verdict messages stay friendly', () => {
    expect(verdictMessage(true, 'A', 'A')).toContain('일심동체');
    expect(verdictMessage(false, 'A', 'B')).toBe('서로 다른 생각도 재미있어요!');
    expect(verdictMessage(false, 'A', null)).toContain('한 분만');
    expect(verdictMessage(false, null, null)).toContain('쉬어');
  });

  it('answer sequence numbers always grow, even if the clock stands still or goes back', () => {
    let t = 5000;
    const next = createSeq(() => t);
    const a = next();
    const b = next();
    t = 4000;
    const c = next();
    t = 9000;
    const d = next();
    expect([a, b, c, d]).toEqual([5000, 5001, 5002, 9000]);
  });

  it('formats rates and options', () => {
    expect(formatPercent(66.7)).toBe('66.7%');
    expect(formatPercent(100)).toBe('100%');
    expect(formatPercent(null)).toBe('-');
    expect(optionText(question, 'B')).toBe('피자');
    expect(optionText(question, null)).toBe('');
  });

  it('finds tied families in the final ranking', () => {
    const row = (team_name: string, rank: number): MatchFinalRow => ({ team_id: team_name, team_name, matched_count: 0, total_questions: 10, match_percentage: 0, rank });
    const ties = finalTies([row('가', 1), row('나', 1), row('다', 3), row('라', 4), row('마', 4)]);
    expect(ties.map((g) => [g.rank, g.teams.map((t) => t.team_name)])).toEqual([[1, ['가', '나']], [4, ['라', '마']]]);
    expect(finalFullyRevealed(game({ status: 'GAME_FINISHED', final_revealed_rank: 1 }))).toBe(true);
    expect(finalFullyRevealed(game({ status: 'GAME_FINISHED', final_revealed_rank: 3 }))).toBe(false);
  });

  it('validates question drafts like the server', () => {
    const d = { story_title: '제목', story_text: '', question_text: '질문?', option_a: 'A안', option_b: 'B안', duration_seconds: 15 };
    expect(validateDraft(d)).toBeNull();
    expect(validateDraft({ ...d, option_b: ' ' })).toContain('보기');
    expect(validateDraft({ ...d, duration_seconds: 31 })).toContain('5~30');
    expect(validateDraft({ ...d, question_text: 'ㄱ'.repeat(101) })).toContain('100자');
  });
});

describe('CSV', () => {
  it('final ranking and per-question verdicts', () => {
    const final = matchFinalToCsv(2, [{ team_id: 't', team_name: '=김가족', matched_count: 7, total_questions: 10, match_percentage: 70, rank: 1 }]);
    const lines = final.slice(1).split('\r\n');
    expect(lines[0]).toBe('"게임","순위","가족팀","일치 문항 수","전체 문항 수","일치율(%)"');
    expect(lines[1]).toBe(`"2","1","'=김가족","7","10","70"`);

    const v = matchVerdictsToCsv(3, [{
      team_id: 't', team_name: '이가족', label_1: '아빠', option_1: 'A', label_2: '딸', option_2: null, matched: false, points: 0, total: 2,
    }]);
    expect(v.slice(1).split('\r\n')[1]).toBe('"3","이가족","아빠","A","딸","미응답","X","0","2"');
  });
});
