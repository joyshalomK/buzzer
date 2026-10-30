import { createClient } from '@supabase/supabase-js';

const rawUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
// "same-origin" = local rehearsal backend proxied by the Vite dev server (see vite.config.ts)
const url = rawUrl === 'same-origin' ? window.location.origin : rawUrl;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const isConfigured = Boolean(url && key);

const REQUEST_TIMEOUT_MS = 8000;

export const supabase = createClient(url || 'http://localhost', key || 'missing-key', {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: {
    // Hotel Wi-Fi: never let a request hang forever.
    fetch: (input, init) =>
      fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS) }),
  },
  realtime: { heartbeatIntervalMs: 15000 },
});

export class RpcError extends Error {
  readonly code: string;
  readonly network: boolean;
  constructor(code: string, network: boolean) {
    super(code);
    this.code = code;
    this.network = network;
  }
}

/** Calls a Postgres RPC. Server errors are raised with an UPPER_CASE code as message. */
export async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  let res;
  try {
    res = await supabase.rpc(fn, args);
  } catch {
    throw new RpcError('NETWORK', true);
  }
  if (res.error) {
    const msg = res.error.message || '';
    const code = /^[A-Z_]+$/.test(msg) ? msg : 'NETWORK';
    const network = code === 'NETWORK' && !res.error.code;
    throw new RpcError(network ? 'NETWORK' : code === 'NETWORK' ? 'SERVER' : code, network);
  }
  return res.data as T;
}

const MESSAGES: Record<string, string> = {
  NETWORK: '서버에 연결할 수 없습니다. 네트워크를 확인해 주세요.',
  SERVER: '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.',
  ROOM_NOT_FOUND: '퀴즈방을 찾을 수 없습니다. 방 코드를 확인해 주세요.',
  ROOM_ENDED: '이미 종료된 퀴즈방입니다.',
  ROOM_FULL: '퀴즈방 인원이 가득 찼습니다.',
  NICKNAME_TAKEN: '이미 사용 중인 닉네임입니다. 다른 이름을 입력해 주세요.',
  NICKNAME_REQUIRED: '닉네임을 입력해 주세요.',
  NICKNAME_TOO_LONG: '닉네임은 12자 이내로 입력해 주세요.',
  ADMIN_AUTH_REQUIRED: '관리자 로그인이 필요합니다.',
  INVALID_PASSWORD: '비밀번호가 올바르지 않습니다.',
  TOO_MANY_ATTEMPTS: '로그인 시도가 너무 많습니다. 5분 후 다시 시도해 주세요.',
  ADMIN_NOT_CONFIGURED: '관리자 비밀번호가 설정되지 않았습니다. README의 관리자 설정을 확인하세요.',
  ROUND_CHANGED: '라운드가 이미 변경되었습니다. 화면을 갱신했습니다.',
  ROUND_HAS_WINNER: '이미 우승자가 있는 라운드입니다. 우승 취소 후 다시 활성화하세요.',
  INVALID_TRANSITION: '현재 상태에서는 할 수 없는 동작입니다.',
  TEST_MODE_OFF: '테스트 모드를 먼저 켜 주세요.',
  ANNOUNCEMENT_TOO_LONG: '공지는 200자 이내로 입력해 주세요.',
  NOT_SYNC_MODE: '지금은 가족 팀 게임 시간이 아닙니다.',
  TEAM_FULL: '이 가족 팀은 이미 2명이 모두 들어왔습니다. 가족 닉네임을 확인해 주세요.',
  LABEL_TAKEN: '팀에 같은 이름이 이미 있습니다. 다른 이름(호칭)을 입력해 주세요.',
  TEAM_NAME_REQUIRED: '가족 닉네임을 입력해 주세요.',
  TEAM_NAME_TOO_LONG: '가족 닉네임은 10자 이내로 입력해 주세요.',
  MEMBER_LABEL_REQUIRED: '이름 또는 호칭을 입력해 주세요.',
  MEMBER_LABEL_TOO_LONG: '이름(호칭)은 8자 이내로 입력해 주세요.',
  SYNC_RUNNING: '게임이 진행 중입니다. 끝난 뒤에 다시 시도해 주세요.',
  GAME_IN_PROGRESS: '진행 중인 게임이 있습니다. 부저를 잠그거나 라운드를 끝낸 뒤 전환하세요.',
  INVALID_MODE: '알 수 없는 게임 모드입니다.',
  INVALID_TEAMS: '재경기 팀 선택이 올바르지 않습니다.',
  INVALID_COUNT: '개수가 올바르지 않습니다.',
  INVALID_ACTION: '알 수 없는 동작입니다.',
  MATCH_OPEN: '응답을 받는 중입니다. 응답이 마감된 뒤에 다시 시도해 주세요.',
  QUESTION_LOCKED: '이미 시작한 문항은 수정할 수 없습니다.',
  INVALID_QUESTIONS: '문항 정보가 올바르지 않습니다.',
  INVALID_DURATION: '제한 시간은 5~30초 사이로 입력해 주세요.',
  GAME_TITLE_REQUIRED: '게임 제목을 입력해 주세요.',
  GAME_TITLE_TOO_LONG: '게임 제목은 40자 이내로 입력해 주세요.',
  STORY_TITLE_REQUIRED: '모든 문항의 스토리 제목을 입력해 주세요.',
  STORY_TITLE_TOO_LONG: '스토리 제목은 40자 이내로 입력해 주세요.',
  STORY_TEXT_TOO_LONG: '스토리 설명은 300자 이내로 입력해 주세요.',
  QUESTION_TEXT_REQUIRED: '모든 문항의 질문을 입력해 주세요.',
  QUESTION_TEXT_TOO_LONG: '질문은 100자 이내로 입력해 주세요.',
  OPTION_REQUIRED: '모든 문항의 A/B 보기를 입력해 주세요.',
  OPTION_TOO_LONG: '보기는 40자 이내로 입력해 주세요.',
};

export function errorMessage(e: unknown): string {
  if (e instanceof RpcError) return MESSAGES[e.code] ?? `오류: ${e.code}`;
  return MESSAGES.SERVER;
}

export function publicBaseUrl(): string {
  const configured = (import.meta.env.VITE_PUBLIC_BASE_URL as string | undefined)?.trim();
  return (configured || window.location.origin).replace(/\/+$/, '');
}
