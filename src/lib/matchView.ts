import type { MatchFinalRow, MatchGame, MatchGameStatus, MatchOption, MatchQuestion, MatchQuestionDraft, Room } from './types';

export type MatchPhase = 'LOADING' | 'ENDED' | 'LOBBY' | 'READY' | 'OPEN' | 'CLOSED' | 'REVEAL' | 'FINISHED';

export interface MatchViewInput {
  room: Room | null;
  game: MatchGame | null;
  question: MatchQuestion | null;
  teamSize: number;
  /** current server time estimate (ms) */
  now: number;
}

export interface MatchView {
  phase: MatchPhase;
  canAnswer: boolean;
  /** whole seconds left while answering is open; null otherwise */
  remaining: number | null;
  title: string;
  message: string;
}

/** Pure mapping from server state + server-clock estimate to the participant screen. */
export function deriveMatchView(i: MatchViewInput): MatchView {
  const v = (phase: MatchPhase, title: string, message: string, canAnswer = false, remaining: number | null = null): MatchView =>
    ({ phase, canAnswer, remaining, title, message });

  if (!i.room || !i.game) return v('LOADING', '불러오는 중', '잠시만 기다려 주세요');
  if (i.room.status === 'ENDED') return v('ENDED', '게임 종료', '참여해 주셔서 감사합니다!');

  switch (i.game.status) {
    case 'QUESTION_READY':
      return v('READY', '곧 응답이 시작돼요', '문제를 읽고 사회자의 신호를 기다려 주세요');
    case 'QUESTION_OPEN': {
      const closes = i.question?.closes_ms;
      // the server decides; this only stops offering the buttons once time is up here
      if (closes != null && i.now > closes) return v('CLOSED', '응답 마감!', '과연 우리 가족의 마음은 통했을까요?');
      const remaining = closes != null ? Math.max(0, Math.ceil((closes - i.now) / 1000)) : null;
      return v('OPEN', '골라 주세요!', '파트너와 같은 답을 고르면 1점!', true, remaining);
    }
    case 'QUESTION_CLOSED':
      return v('CLOSED', '응답 마감!', '과연 우리 가족의 마음은 통했을까요?');
    case 'RESULT_REVEAL':
      return v('REVEAL', '결과 공개', '');
    case 'GAME_FINISHED':
      return v('FINISHED', '최종 결과', '');
    default:
      return i.teamSize < 2
        ? v('LOBBY', '파트너를 기다리는 중', '같은 가족 닉네임으로 한 명 더 들어와야 해요')
        : v('LOBBY', '2명 모두 접속 완료', '사회자가 게임을 시작하면 문제가 나타나요');
  }
}

/** Friendly verdict line. Never negative, even for a mismatch. */
export function verdictMessage(matched: boolean, mine: MatchOption | null, partner: MatchOption | null) {
  if (matched) return '일심동체 성공! 🎉';
  if (!mine && !partner) return '이번 문제는 쉬어 갔어요. 다음 문제에서 만나요!';
  if (!mine || !partner) return '한 분만 응답했어요. 다음엔 함께 골라 봐요!';
  return '서로 다른 생각도 재미있어요!';
}

/** Screen line for one family on /display. */
export const screenVerdict = (matched: boolean) => (matched ? '일심동체 성공!' : '아쉽지만 다음 기회!');

/**
 * Sequence numbers for answer requests. They only have to grow on this
 * device (and roughly across devices sharing a token), so the server can
 * drop a request that was overtaken by a newer one.
 */
export function createSeq(clock: () => number = Date.now) {
  let last = 0;
  return () => (last = Math.max(last + 1, clock()));
}

export function formatPercent(p: number | null | undefined) {
  if (p == null) return '-';
  return `${Number.isInteger(p) ? p : p.toFixed(1)}%`;
}

export const optionText = (q: Pick<MatchQuestion, 'option_a' | 'option_b'> | null | undefined, o: MatchOption | null | undefined) =>
  !q || !o ? '' : o === 'A' ? q.option_a : q.option_b;

/** Families that share a rank in the final ranking (FAMILY SYNC final candidates). */
export function finalTies(final: MatchFinalRow[]) {
  const byRank = new Map<number, MatchFinalRow[]>();
  for (const t of final) byRank.set(t.rank, [...(byRank.get(t.rank) ?? []), t]);
  return [...byRank.entries()]
    .filter(([, teams]) => teams.length > 1)
    .sort(([a], [b]) => a - b)
    .map(([rank, teams]) => ({ rank, teams }));
}

/** True when the whole final ranking is public. */
export const finalFullyRevealed = (g: Pick<MatchGame, 'status' | 'final_revealed_rank'> | null | undefined) =>
  g?.status === 'GAME_FINISHED' && g.final_revealed_rank === 1;

export const GAME_STATUS_LABEL: Record<MatchGameStatus, string> = {
  LOBBY: '가족 입장',
  QUESTION_READY: '문제 준비',
  QUESTION_OPEN: '응답 중',
  QUESTION_CLOSED: '응답 마감',
  RESULT_REVEAL: '결과 공개',
  GAME_FINISHED: '게임 종료',
};

export const QUESTION_LIMITS = { storyTitle: 40, storyText: 300, question: 100, option: 40, title: 40 } as const;

/** Client-side check mirroring the server's validation (returns a Korean message or null). */
export function validateDraft(d: MatchQuestionDraft): string | null {
  const len = (s: string) => [...s.trim()].length;
  if (!len(d.story_title)) return '스토리 제목을 입력해 주세요';
  if (len(d.story_title) > QUESTION_LIMITS.storyTitle) return `스토리 제목은 ${QUESTION_LIMITS.storyTitle}자 이내`;
  if (len(d.story_text) > QUESTION_LIMITS.storyText) return `스토리 설명은 ${QUESTION_LIMITS.storyText}자 이내`;
  if (!len(d.question_text)) return '질문을 입력해 주세요';
  if (len(d.question_text) > QUESTION_LIMITS.question) return `질문은 ${QUESTION_LIMITS.question}자 이내`;
  if (!len(d.option_a) || !len(d.option_b)) return 'A/B 보기를 모두 입력해 주세요';
  if (len(d.option_a) > QUESTION_LIMITS.option || len(d.option_b) > QUESTION_LIMITS.option) return `보기는 ${QUESTION_LIMITS.option}자 이내`;
  if (!Number.isInteger(d.duration_seconds) || d.duration_seconds < 5 || d.duration_seconds > 30) return '제한 시간은 5~30초';
  return null;
}

export const toDraft = (q: MatchQuestion): MatchQuestionDraft => ({
  story_title: q.story_title,
  story_text: q.story_text,
  question_text: q.question_text,
  option_a: q.option_a,
  option_b: q.option_b,
  duration_seconds: q.duration_seconds,
});
