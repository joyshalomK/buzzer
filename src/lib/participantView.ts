import type { Room, Round } from './types';

export type ViewKind =
  | 'LOADING'
  | 'DISCONNECTED'
  | 'ENDED'
  | 'WAITING'
  | 'READY'
  | 'ARMED'
  | 'PRESSED'
  | 'LOCKED'
  | 'EXCLUDED'
  | 'WINNER_ME'
  | 'WINNER_OTHER';

export interface ViewInput {
  connected: boolean;
  room: Room | null;
  round: Round | null;
  myId: string | null;
  /** server says I already pressed during the current arming */
  attempted: boolean;
  excluded: boolean;
  /** a local press for this round/arm_seq is in flight or done */
  localPressKey: string | null;
}

export interface View {
  kind: ViewKind;
  canBuzz: boolean;
  title: string;
  message: string;
}

export const pressKey = (round: Pick<Round, 'id' | 'arm_seq'>) => `${round.id}:${round.arm_seq}`;

/** Pure mapping from server state to what the participant sees. */
export function deriveParticipantView(i: ViewInput): View {
  const v = (kind: ViewKind, title: string, message: string, canBuzz = false): View => ({ kind, canBuzz, title, message });

  if (!i.room) return v('LOADING', '불러오는 중', '잠시만 기다려 주세요');
  if (i.room.status === 'ENDED') {
    return v('ENDED', '게임 종료', '참여해 주셔서 감사합니다!');
  }
  if (!i.connected) return v('DISCONNECTED', '연결 끊김', '연결이 끊어졌습니다. 재연결 중입니다');

  const r = i.round;
  if (!r) return v('WAITING', '대기 중', '사회자가 준비 중입니다');

  if (r.winner_nickname) {
    if (r.winner_id && r.winner_id === i.myId) return v('WINNER_ME', `1등! ${r.winner_nickname}`, '축하합니다! 가장 먼저 눌렀어요!');
    return v('WINNER_OTHER', `1등! ${r.winner_nickname}`, `${r.winner_nickname}님이 먼저 눌렀습니다`);
  }

  switch (r.status) {
    case 'READY':
      return v('READY', '준비!', '곧 시작합니다');
    case 'ARMED':
      if (i.excluded) return v('EXCLUDED', '이번 문제 쉬어요', '이번 문제는 다른 친구들의 차례예요');
      if (i.attempted || i.localPressKey === pressKey(r)) return v('PRESSED', '눌렀어요!', '서버 판정을 기다리는 중…');
      return v('ARMED', '지금 누르세요!', '가장 먼저 누르는 사람이 1등!', true);
    case 'LOCKED':
      return v('LOCKED', '부저 잠김', '사회자가 부저를 잠갔습니다');
    default:
      return v('WAITING', '대기 중', '사회자가 준비 중입니다');
  }
}

/** Counts user-perceived characters the same way Postgres char_length does (code points). */
export function nicknameLength(s: string) {
  return Array.from(s).length;
}

export function clampNickname(s: string, max = 12) {
  return Array.from(s).slice(0, max).join('');
}
