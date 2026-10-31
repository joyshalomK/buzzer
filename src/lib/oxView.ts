import type { OxGame, OxGameStatus, OxParticipantState, OxResult, OxRound, Room } from './types';

export type OxPhase = 'LOADING' | 'ENDED' | 'LOBBY' | 'READY' | 'OPEN' | 'CLOSED' | 'REVEAL' | 'VOID' | 'FINISHED';

export interface OxViewInput {
  room: Room | null;
  game: OxGame | null;
  round: OxRound | null;
  me: OxParticipantState['me'] | null;
  verdict: OxParticipantState['verdict'];
  /** current server time estimate (ms) */
  now: number;
}

export interface OxView {
  phase: OxPhase;
  /** this phone may send O/X now */
  canAnswer: boolean;
  /** whole seconds left while answering is open; null otherwise */
  remaining: number | null;
  /** still in the game (alive player) */
  alive: boolean;
  title: string;
  message: string;
}

const CHEER = '이제부터 응원단으로 참여해주세요!';

/** Pure mapping from server state + server-clock estimate to the participant screen. */
export function deriveOxView(i: OxViewInput): OxView {
  const alive = i.me?.role === 'PLAYER' && i.me.status === 'ALIVE';
  const v = (phase: OxPhase, title: string, message: string, canAnswer = false, remaining: number | null = null): OxView =>
    ({ phase, canAnswer, remaining, alive, title, message });
  const watching = i.me?.role === 'SPECTATOR' ? '게임이 이미 시작되어 관전 중이에요' : CHEER;

  if (!i.room || !i.game || !i.me) return v('LOADING', '불러오는 중', '잠시만 기다려 주세요');
  if (i.room.status === 'ENDED') return v('ENDED', '게임 종료', '참여해 주셔서 감사합니다!');
  const n = i.game.current_round;

  switch (i.game.status) {
    case 'LOBBY':
      return v('LOBBY', '게임 시작을 기다리는 중', '사회자가 시작하면 지금 접속한 분 모두 참가자로 확정돼요');
    case 'ROUND_READY':
      return v('READY', `ROUND ${n}`, alive ? '사회자의 문제를 잘 들어주세요!' : watching);
    case 'ANSWERING': {
      const deadline = i.round?.deadline_ms;
      // the server decides; this only stops offering the buttons once time is up here
      if (deadline != null && i.now > deadline) return v('CLOSED', '응답 마감!', '과연 정답은?');
      const remaining = deadline != null ? Math.max(0, Math.ceil((deadline - i.now) / 1000)) : null;
      return alive
        ? v('OPEN', `ROUND ${n}`, 'O 또는 X를 골라 주세요! 시간 안에는 바꿀 수 있어요', true, remaining)
        : v('OPEN', `ROUND ${n}`, watching, false, remaining);
    }
    case 'ANSWER_CLOSED':
      return v('CLOSED', '응답 마감!', '과연 정답은?');
    case 'RESULT_REVEALED':
      if (!i.verdict) return v('REVEAL', `정답은 ${i.round?.correct_answer ?? '?'}!`, watching);
      if (!i.verdict.correct) return v('REVEAL', '아쉽지만 탈락!', CHEER);
      return i.game.result === 'CHAMPION'
        ? v('REVEAL', '정답입니다!', '최후의 1인! 사회자의 발표를 기다려 주세요')
        : v('REVEAL', '정답입니다!', '다음 라운드 진출!');
    case 'ROUND_VOID':
      return v('VOID', '전원 오답!', '이번 라운드는 무효예요. 모두 살아남아 다시 겨룹니다!');
    case 'FINISHED':
      return v('FINISHED', resultTitle(i.game.result, alive), alive ? '축하합니다!' : '함께해 주셔서 감사합니다!');
  }
}

export function resultTitle(result: OxResult | null, winner: boolean) {
  if (result === 'CHAMPION') return winner ? 'OX SURVIVAL CHAMPION!' : 'CHAMPION';
  if (result === 'CO_WINNERS') return winner ? '공동 우승!' : '공동 우승';
  return winner ? '최종 생존!' : '게임 종료';
}

/** "17명 중 11명 생존!" — numbers of a revealed round. */
export function survivalLine(r: Pick<OxRound, 'survivors_before' | 'survivors_after'> | null | undefined) {
  if (r?.survivors_before == null || r.survivors_after == null) return null;
  return {
    survived: `${r.survivors_before}명 중 ${r.survivors_after}명 생존!`,
    eliminated: r.survivors_before - r.survivors_after,
  };
}

export const OX_STATUS_LABEL: Record<OxGameStatus, string> = {
  LOBBY: '참가자 대기',
  ROUND_READY: '라운드 준비',
  ANSWERING: '응답 중',
  ANSWER_CLOSED: '응답 마감',
  RESULT_REVEALED: '결과 공개',
  ROUND_VOID: '무효 (재경기)',
  FINISHED: '게임 종료',
};
