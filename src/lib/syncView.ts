import type { Room, SyncRound, SyncTeamResult } from './types';

export type SyncPhase =
  | 'LOADING'
  | 'DISCONNECTED'
  | 'ENDED'
  | 'WAITING_PARTNER'
  | 'TEAM_READY'
  | 'READY'
  | 'COUNTDOWN'
  | 'GO'
  | 'PRESSED'
  | 'TIME_UP'
  | 'NOT_ELIGIBLE'
  | 'TALLYING'
  | 'RESULTS';

export interface SyncViewInput {
  connected: boolean;
  room: Room | null;
  round: SyncRound | null;
  teamSize: number;
  /** server says I pressed in this round */
  pressed: boolean;
  /** a local press for this round is in flight or done */
  localPressed: boolean;
  eligible: boolean;
  /** current server time estimate (ms) */
  now: number;
}

export interface SyncView {
  phase: SyncPhase;
  canPress: boolean;
  title: string;
  message: string;
  /** 3, 2, 1 before GO; null otherwise */
  countdown: number | null;
}

/** Pure mapping from server state + server-clock estimate to the participant screen. */
export function deriveSyncView(i: SyncViewInput): SyncView {
  const v = (phase: SyncPhase, title: string, message: string, canPress = false, countdown: number | null = null): SyncView =>
    ({ phase, canPress, title, message, countdown });

  if (!i.room) return v('LOADING', '불러오는 중', '잠시만 기다려 주세요');
  if (i.room.status === 'ENDED') return v('ENDED', '게임 종료', '참여해 주셔서 감사합니다!');

  const r = i.round;
  const partner = i.teamSize < 2;
  const waiting = () =>
    partner
      ? v('WAITING_PARTNER', '파트너를 기다리는 중', '같은 가족 닉네임으로 한 명 더 들어와야 해요')
      : v('TEAM_READY', '2명 모두 접속 완료', '사회자가 곧 시작합니다');

  if (r?.status === 'RUNNING' && r.started_ms != null && r.deadline_ms != null) {
    if (!i.eligible) return v('NOT_ELIGIBLE', '이번 판은 관전', '동점 팀 재경기 중입니다');
    if (i.pressed || i.localPressed) return v('PRESSED', '입력 완료!', '결과를 기다려 주세요');
    if (i.now < r.started_ms) {
      return v('COUNTDOWN', '준비…', '숫자가 끝나면 누르세요', false, Math.max(1, Math.ceil((r.started_ms - i.now) / 1000)));
    }
    if (i.now <= r.deadline_ms) return v('GO', 'SYNC!', '파트너와 같은 순간에 누르세요!', true);
    return v('TIME_UP', '시간 종료', '이번 라운드는 입력하지 못했어요');
  }

  if (!i.connected) return v('DISCONNECTED', '연결 끊김', '연결이 끊어졌습니다. 재연결 중입니다');
  if (!r) return waiting();

  switch (r.status) {
    case 'READY':
      if (!i.eligible) return v('NOT_ELIGIBLE', '이번 판은 관전', '동점 팀 재경기가 곧 시작됩니다');
      return v('READY', '준비하세요!', partner ? '아직 파트너가 들어오지 않았어요' : '시작 신호 후 10초 안에 한 번만 누르세요');
    case 'FINISHED':
      return v('TALLYING', i.pressed ? '입력 완료!' : '시간 종료', '결과 집계 중… 발표를 기다려 주세요');
    case 'RESULTS':
      return v('RESULTS', '결과 발표', r.revealed_rank === 1 ? '최종 순위가 공개되었습니다' : '순위를 발표하고 있어요');
    default:
      return waiting();
  }
}

/** True when every rank is public. */
export const fullyRevealed = (round: Pick<SyncRound, 'status' | 'revealed_rank'> | null | undefined) =>
  round?.status === 'RESULTS' && round.revealed_rank === 1;

export function formatMs(ms: number | null | undefined) {
  if (ms == null) return '-';
  return `${ms.toLocaleString('ko-KR')}ms`;
}

export function formatSeconds(ms: number | null | undefined) {
  if (ms == null) return '-';
  return `${(ms / 1000).toFixed(3)}초`;
}

/** Groups of two or more COMPLETE teams that share a rank (candidates for a rematch). */
export function tieGroups(results: SyncTeamResult[]) {
  const byRank = new Map<number, SyncTeamResult[]>();
  for (const t of results) {
    if (t.rank == null) continue;
    byRank.set(t.rank, [...(byRank.get(t.rank) ?? []), t]);
  }
  return [...byRank.entries()]
    .filter(([, teams]) => teams.length > 1)
    .sort(([a], [b]) => a - b)
    .map(([rank, teams]) => ({ rank, teams }));
}

export const STATUS_LABEL_KO: Record<SyncTeamResult['status'], string> = {
  COMPLETE: '완료',
  PARTIAL: '미완료 (1명만 입력)',
  NONE: '미참여',
};
