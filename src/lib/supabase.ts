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
};

export function errorMessage(e: unknown): string {
  if (e instanceof RpcError) return MESSAGES[e.code] ?? `오류: ${e.code}`;
  return MESSAGES.SERVER;
}

export function publicBaseUrl(): string {
  const configured = (import.meta.env.VITE_PUBLIC_BASE_URL as string | undefined)?.trim();
  return (configured || window.location.origin).replace(/\/+$/, '');
}
