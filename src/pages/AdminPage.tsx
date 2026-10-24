import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Confetti } from '../components/Confetti';
import { ConnectionBadge } from '../components/ConnectionBadge';
import { QrCode } from '../components/QrCode';
import { SoundToggle } from '../components/SoundToggle';
import { useLiveSync } from '../hooks/useLiveSync';
import { downloadCsv, roundsToCsv } from '../lib/csv';
import { sfx, unlockAudio } from '../lib/sound';
import { KEYS, load, save } from '../lib/storage';
import { RpcError, errorMessage, publicBaseUrl, rpc } from '../lib/supabase';
import type { AdminState, BuzzResponse, Room, Round, RoundStatus } from '../lib/types';

interface AdminSession {
  token: string;
  expires_at: string;
}

const isAuthError = (e: unknown) => e instanceof RpcError && e.code === 'ADMIN_AUTH_REQUIRED';

export function AdminPage() {
  const [session, setSession] = useState<AdminSession | null>(() => {
    const s = load<AdminSession | null>(KEYS.admin, null);
    return s && Date.parse(s.expires_at) > Date.now() ? s : null;
  });
  const [roomCode, setRoomCode] = useState<string | null>(() => load(KEYS.adminRoom, null));
  const [checked, setChecked] = useState(false);

  const logout = useCallback(() => {
    if (session) void rpc('admin_logout', { p_admin_token: session.token }).catch(() => {});
    save(KEYS.admin, null);
    setSession(null);
  }, [session]);

  // verify a stored session against the server once on load
  useEffect(() => {
    if (!session || checked) return;
    rpc('admin_check', { p_admin_token: session.token })
      .then(() => setChecked(true))
      .catch((e) => {
        if (isAuthError(e)) {
          save(KEYS.admin, null);
          setSession(null);
        } else setChecked(true); // network trouble: keep session, dashboard shows the error
      });
  }, [session, checked]);

  const pickRoom = (code: string | null) => {
    save(KEYS.adminRoom, code);
    setRoomCode(code);
  };

  if (!session) {
    return (
      <AdminLogin
        onLogin={(s) => {
          save(KEYS.admin, s);
          setChecked(true);
          setSession(s);
        }}
      />
    );
  }
  if (!checked) return <CenterMessage text="관리자 인증 확인 중…" />;
  if (!roomCode) return <RoomPicker token={session.token} onPick={pickRoom} onLogout={logout} onAuthError={logout} />;
  return (
    <Dashboard
      token={session.token}
      roomCode={roomCode}
      onLeaveRoom={() => pickRoom(null)}
      onLogout={logout}
    />
  );
}

function CenterMessage({ text }: { text: string }) {
  return <main className="stage flex min-h-dvh items-center justify-center text-xl font-bold text-white/80">{text}</main>;
}

// ---------------------------------------------------------------------------

function AdminLogin({ onLogin }: { onLogin: (s: AdminSession) => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    unlockAudio();
    setBusy(true);
    setError(null);
    try {
      const r = await rpc<{ ok: boolean; error?: string; token?: string; expires_at?: string }>('admin_login', {
        p_password: password,
      });
      if (!r.ok || !r.token) setError(errorMessage(new RpcError(r.error ?? 'SERVER', false)));
      else onLogin({ token: r.token, expires_at: r.expires_at! });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
      setPassword('');
    }
  };

  return (
    <main className="stage flex min-h-dvh items-center justify-center px-5">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-3xl bg-white/5 p-8 ring-1 ring-white/10">
        <h1 className="font-display text-3xl text-amber-300">사회자 로그인</h1>
        <p className="text-sm text-white/60">FM Family Quiz Buzzer 관리자 화면입니다.</p>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          placeholder="관리자 비밀번호"
          className="w-full rounded-xl border-2 border-white/15 bg-white/10 px-4 py-3 text-lg text-white outline-none focus:border-amber-300"
        />
        {error && <p role="alert" className="font-bold text-rose-300">{error}</p>}
        <button disabled={busy || !password} className="btn btn-green w-full py-3 text-lg">
          {busy ? '확인 중…' : '로그인'}
        </button>
      </form>
    </main>
  );
}

// ---------------------------------------------------------------------------

function RoomPicker({ token, onPick, onLogout, onAuthError }: {
  token: string;
  onPick: (code: string) => void;
  onLogout: () => void;
  onAuthError: () => void;
}) {
  const [rooms, setRooms] = useState<Room[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    rpc<Room[]>('admin_list_rooms', { p_admin_token: token })
      .then(setRooms)
      .catch((e) => (isAuthError(e) ? onAuthError() : setError(errorMessage(e))));
  }, [token, onAuthError]);

  const create = async () => {
    setBusy(true);
    try {
      const room = await rpc<Room>('admin_create_room', { p_admin_token: token });
      onPick(room.room_code);
    } catch (e) {
      if (isAuthError(e)) onAuthError();
      else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="stage min-h-dvh px-6 py-10">
      <div className="mx-auto max-w-2xl">
        <div className="flex items-center justify-between">
          <h1 className="font-display text-3xl text-amber-300">FM Family Quiz Buzzer</h1>
          <button onClick={onLogout} className="btn btn-ghost">로그아웃</button>
        </div>
        <button onClick={create} disabled={busy} className="btn btn-green mt-8 w-full py-5 text-2xl">
          + 새 퀴즈방 만들기
        </button>
        {error && <p className="mt-4 font-bold text-rose-300">{error}</p>}
        <h2 className="mt-10 text-lg font-bold text-white/70">최근 퀴즈방</h2>
        <ul className="mt-3 space-y-2">
          {rooms?.length === 0 && <li className="text-white/50">아직 만든 방이 없습니다.</li>}
          {rooms?.map((r) => (
            <li key={r.id}>
              <button
                onClick={() => onPick(r.room_code)}
                className="flex w-full items-center justify-between rounded-2xl bg-white/5 px-5 py-4 text-left ring-1 ring-white/10 hover:bg-white/10"
              >
                <span className="font-display text-2xl tracking-widest text-white">{r.room_code}</span>
                <span className="text-sm text-white/60">
                  {r.status === 'OPEN' ? '진행 중' : '종료됨'} · {new Date(r.created_at).toLocaleString('ko-KR')}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------

const STATUS_LABEL: Record<RoundStatus, string> = {
  WAITING: '대기 중',
  READY: '준비',
  ARMED: '부저 활성화',
  LOCKED: '잠김',
  FINISHED: '종료',
};
const STATUS_COLOR: Record<RoundStatus, string> = {
  WAITING: 'bg-slate-500',
  READY: 'bg-emerald-500',
  ARMED: 'bg-rose-500 animate-pulse',
  LOCKED: 'bg-amber-500',
  FINISHED: 'bg-slate-600',
};

type Action = 'READY' | 'ARM' | 'LOCK' | 'NEXT';

function reactionSeconds(r: Round) {
  if (!r.winner_at || !r.armed_at) return null;
  return (Date.parse(r.winner_at) - Date.parse(r.armed_at)) / 1000;
}

function Dashboard({ token, roomCode, onLeaveRoom, onLogout }: {
  token: string;
  roomCode: string;
  onLeaveRoom: () => void;
  onLogout: () => void;
}) {
  const [roomId, setRoomId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; tone: 'error' | 'info' } | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [celebrate, setCelebrate] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [bots, setBots] = useState<Array<{ participant_id: string; nickname: string; token: string }>>([]);
  const [botCount, setBotCount] = useState(10);
  const [botResult, setBotResult] = useState<string | null>(null);

  const fetcher = useCallback(
    () => rpc<AdminState>('admin_get_state', { p_admin_token: token, p_room_code: roomCode }),
    [token, roomCode],
  );
  const live = useLiveSync<AdminState>({ roomId, fetcher, liveIntervalMs: 3000, pollIntervalMs: 1500 });
  const state = live.data;
  const room = state?.room;
  const round = state?.round ?? null;

  useEffect(() => {
    if (room?.id) setRoomId(room.id);
  }, [room?.id]);

  useEffect(() => {
    if (isAuthError(live.error)) onLogout();
    else if (live.error instanceof RpcError && live.error.code === 'ROOM_NOT_FOUND') onLeaveRoom();
  }, [live.error, onLogout, onLeaveRoom]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 3500);
    return () => window.clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    const onFs = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  // fanfare + confetti when a new winner is confirmed
  const winnerKey = round?.winner_nickname ? `${round.id}:${round.winner_nickname}:${round.winner_at}` : '';
  const prevWinner = useRef<string | null>(null);
  const loaded = !!state;
  useEffect(() => {
    if (!loaded) return; // don't celebrate a winner that was already there on page load
    if (prevWinner.current !== null && winnerKey && winnerKey !== prevWinner.current) {
      sfx.win();
      setCelebrate((c) => c + 1);
    }
    prevWinner.current = winnerKey;
  }, [loaded, winnerKey]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      if (isAuthError(e)) return onLogout();
      setToast({ text: errorMessage(e), tone: 'error' });
    } finally {
      setBusy(null);
      void live.refresh();
    }
  };

  const act = (a: Action) =>
    run(a, async () => {
      if (!room || !round) return;
      const r = await rpc<Round>('admin_round_action', {
        p_admin_token: token, p_room_id: room.id, p_round_id: round.id, p_action: a,
      });
      if (a === 'ARM') sfx.start();
      live.setData((d) => (d ? { ...d, round: r } : d));
    });

  const canReady = round?.status === 'WAITING';
  const canArm = !!round && (round.status === 'WAITING' || round.status === 'READY' || (round.status === 'LOCKED' && !round.winner_nickname));
  const canLock = round?.status === 'ARMED';
  const open = room?.status === 'OPEN';

  // keyboard shortcuts for the host: R / A / L / N
  const actRef = useRef(act);
  actRef.current = act;
  const flags = useRef({ canReady, canArm, canLock, open });
  flags.current = { canReady, canArm, canLock, open };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || e.metaKey || e.ctrlKey || e.altKey) return;
      const f = flags.current;
      if (!f.open) return;
      const k = e.key.toLowerCase();
      if (k === 'r' && f.canReady) void actRef.current('READY');
      else if (k === 'a' && f.canArm) void actRef.current('ARM');
      else if (k === 'l' && f.canLock) void actRef.current('LOCK');
      else if (k === 'n') void actRef.current('NEXT');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const joinUrl = `${publicBaseUrl()}/room/${roomCode}`;
  const displayUrl = `${publicBaseUrl()}/display/${roomCode}`;
  const people = useMemo(() => (state?.participants ?? []).filter((p) => p.is_active), [state?.participants]);
  const realPeople = people.filter((p) => !p.is_test);
  const onlineCount = realPeople.filter((p) => p.online).length;
  const winnerRounds = (state?.rounds ?? []).filter((r) => r.winner_nickname);
  const firstAttempt = state?.attempts.find((a) => round && a.arm_seq === round.arm_seq);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen?.().catch(() => {});
  };

  if (!state || !room) {
    return <CenterMessage text={live.error ? errorMessage(live.error) : '퀴즈방 불러오는 중…'} />;
  }

  return (
    <main className="stage min-h-dvh px-4 py-4 lg:px-8">
      {celebrate > 0 && <Confetti key={celebrate} count={120} />}

      {/* ---------- top bar ---------- */}
      <header className="flex flex-wrap items-center gap-4 rounded-3xl bg-white/5 p-4 ring-1 ring-white/10">
        <QrCode text={joinUrl} size={112} downloadName={`fm-quiz-${roomCode}-qr.png`} />
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-2xl text-amber-300 lg:text-3xl">FM Family Quiz Buzzer</h1>
          <p className="mt-1 text-white/70">
            방 코드 <span className="font-display text-3xl tracking-[0.25em] text-white">{room.room_code}</span>
            {room.status === 'ENDED' && <span className="ml-2 rounded-full bg-slate-600 px-2 py-0.5 text-sm">종료됨</span>}
            {room.test_mode && <span className="ml-2 rounded-full bg-violet-500 px-2 py-0.5 text-sm font-bold">테스트 모드</span>}
          </p>
          <p className="mt-1 truncate text-sm text-white/50">{joinUrl}</p>
        </div>
        <div className="text-center">
          <p className="text-sm text-white/60">참가자</p>
          <p className="font-display text-5xl text-white">{realPeople.length}</p>
          <p className="text-xs text-emerald-300">접속 {onlineCount}명</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex items-center gap-2">
            <ConnectionBadge connected={live.connected} realtime={live.realtime} />
            <SoundToggle />
          </div>
          <div className="flex gap-2">
            <button onClick={toggleFullscreen} className="btn btn-ghost text-sm">{isFullscreen ? '전체화면 해제' : '전체화면'}</button>
            <a href={displayUrl} target="_blank" rel="noreferrer" className="btn btn-ghost text-sm">대형 스크린</a>
          </div>
        </div>
      </header>

      {!live.connected && (
        <p className="mt-3 rounded-2xl bg-rose-600/80 px-4 py-2 text-center font-bold">
          서버 연결이 불안정합니다. 자동으로 재연결 중입니다… {live.error ? `(${errorMessage(live.error)})` : ''}
        </p>
      )}

      {/* ---------- stage ---------- */}
      <section className="mt-4 grid gap-4 lg:grid-cols-[1fr_22rem]">
        <div className={`relative flex min-h-[22rem] flex-col items-center justify-center rounded-3xl p-6 text-center ring-1
          ${round?.winner_nickname ? 'bg-gradient-to-b from-amber-400/25 to-amber-600/10 ring-amber-300/50' : 'bg-white/5 ring-white/10'}`}>
          <div className="absolute left-5 top-4 flex items-center gap-3">
            <span className="font-display text-2xl text-white/80">ROUND {round?.round_number ?? '-'}</span>
            {round && (
              <span className={`rounded-full px-3 py-1 text-sm font-black text-white ${STATUS_COLOR[round.status]}`}>
                {STATUS_LABEL[round.status]}
              </span>
            )}
          </div>
          {round?.winner_nickname ? (
            <>
              <p className="text-3xl font-black text-amber-200">🏆 1등!</p>
              <p className="winner-pop font-display text-[clamp(4rem,12vw,10rem)] leading-none text-amber-300 drop-shadow-[0_0_40px_rgba(251,191,36,0.55)]">
                {round.winner_nickname}
              </p>
              {reactionSeconds(round) !== null && (
                <p className="mt-3 text-lg text-white/70">활성화 후 {reactionSeconds(round)!.toFixed(2)}초 (서버 수신 기준)</p>
              )}
            </>
          ) : (
            <p className={`font-display text-[clamp(3rem,8vw,6rem)] ${round?.status === 'ARMED' ? 'text-rose-400' : 'text-white/80'}`}>
              {room.status === 'ENDED' ? '게임 종료' : round?.status === 'ARMED' ? '부저 대기 중!' : round?.status === 'LOCKED' ? '잠김' : round?.status === 'READY' ? '곧 시작' : '준비 전'}
            </p>
          )}

          {/* receipt order of this arming */}
          {state.attempts.length > 0 && round && (
            <ol className="mt-6 flex max-w-full flex-wrap justify-center gap-2 text-sm">
              {state.attempts
                .filter((a) => a.arm_seq === round.arm_seq)
                .slice(0, 8)
                .map((a, i) => (
                  <li key={`${a.nickname}-${a.received_at}`} className={`rounded-full px-3 py-1 font-bold ${a.accepted && !a.revoked ? 'bg-amber-400 text-amber-950' : 'bg-white/10 text-white/80'}`}>
                    {i + 1}. {a.nickname}
                    {i > 0 && firstAttempt && (
                      <span className="ml-1 opacity-70">+{((Date.parse(a.received_at) - Date.parse(firstAttempt.received_at)) / 1000).toFixed(3)}s</span>
                    )}
                  </li>
                ))}
            </ol>
          )}
        </div>

        {/* ---------- controls ---------- */}
        <div className="flex flex-col gap-3">
          <button disabled={!open || !canReady || !!busy} onClick={() => act('READY')} className="btn btn-green py-5 text-2xl">
            준비 <kbd>R</kbd>
          </button>
          <button disabled={!open || !canArm || !!busy} onClick={() => act('ARM')} className="btn btn-red py-7 text-3xl">
            부저 활성화 <kbd>A</kbd>
          </button>
          <button disabled={!open || !canLock || !!busy} onClick={() => act('LOCK')} className="btn btn-amber py-4 text-xl">
            잠금 <kbd>L</kbd>
          </button>
          <button disabled={!open || !!busy} onClick={() => act('NEXT')} className="btn btn-blue py-5 text-2xl">
            다음 문제 ▶ <kbd>N</kbd>
          </button>
          {round?.winner_nickname && open && (
            <button
              disabled={!!busy}
              onClick={() =>
                window.confirm(`${round.winner_nickname}님의 우승을 취소할까요?\n(취소 후 '부저 활성화'로 다시 열면 이 참가자는 이번 문제에서 제외됩니다)`) &&
                run('CANCEL', () => rpc('admin_cancel_win', { p_admin_token: token, p_round_id: round.id }))
              }
              className="btn btn-ghost py-3"
            >
              이번 우승 취소 (오답 처리)
            </button>
          )}
          <button
            disabled={!open || !!busy}
            onClick={() =>
              window.confirm('게임을 종료할까요? 참가자 화면에 "게임 종료"가 표시됩니다.') &&
              run('END', () => rpc('admin_end_game', { p_admin_token: token, p_room_id: room.id }))
            }
            className="btn btn-ghost py-3 text-rose-300"
          >
            게임 종료
          </button>
        </div>
      </section>

      {/* ---------- announcement ---------- */}
      <section className="mt-4 rounded-3xl bg-white/5 p-4 ring-1 ring-white/10">
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run('ANNOUNCE', async () => {
              await rpc('admin_announce', { p_admin_token: token, p_room_id: room.id, p_text: announcement });
              setAnnouncement('');
            });
          }}
        >
          <input
            value={announcement}
            onChange={(e) => setAnnouncement(e.target.value.slice(0, 200))}
            placeholder="전체 공지 (예: 5분 뒤 2부가 시작됩니다!)"
            className="min-w-0 flex-1 rounded-xl border-2 border-white/15 bg-white/10 px-4 py-2.5 text-white outline-none focus:border-amber-300"
          />
          <button disabled={!announcement.trim() || !!busy} className="btn btn-amber">공지 보내기</button>
          {room.announcement && (
            <button
              type="button"
              onClick={() => run('ANNOUNCE', () => rpc('admin_announce', { p_admin_token: token, p_room_id: room.id, p_text: '' }))}
              className="btn btn-ghost"
            >
              공지 내리기
            </button>
          )}
        </form>
        {room.announcement && <p className="mt-2 text-amber-100">현재 공지: 📢 {room.announcement}</p>}
      </section>

      {/* ---------- lists ---------- */}
      <section className="mt-4 grid gap-4 lg:grid-cols-2">
        <div className="rounded-3xl bg-white/5 p-4 ring-1 ring-white/10">
          <h2 className="mb-3 text-lg font-black">참가자 목록 ({people.length})</h2>
          <ul className="grid max-h-[28rem] grid-cols-1 gap-1.5 overflow-auto sm:grid-cols-2">
            {people.length === 0 && <li className="text-white/50">QR 코드로 참가자를 기다리는 중…</li>}
            {people.map((p) => (
              <li key={p.id} className="flex items-center gap-2 rounded-xl bg-white/5 px-3 py-2">
                <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${p.online ? 'bg-emerald-400' : 'bg-slate-500'}`} title={p.online ? '접속 중' : '응답 없음'} />
                <span className={`min-w-0 flex-1 truncate font-bold ${p.is_test ? 'text-violet-300' : ''}`}>{p.nickname}</span>
                {p.wins > 0 && <span className="rounded-full bg-amber-400 px-2 text-sm font-black text-amber-950">🏆 {p.wins}</span>}
                <button
                  onClick={() =>
                    window.confirm(`${p.nickname}님을 퇴장시킬까요?`) &&
                    run('KICK', () => rpc('admin_kick', { p_admin_token: token, p_participant_id: p.id }))
                  }
                  className="rounded-lg px-2 py-1 text-xs font-bold text-rose-300 hover:bg-rose-500/20"
                >
                  퇴장
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="rounded-3xl bg-white/5 p-4 ring-1 ring-white/10">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-lg font-black">라운드별 우승 기록 ({winnerRounds.length})</h2>
            <button
              onClick={() => downloadCsv(`fm-quiz-${roomCode}-winners.csv`, roundsToCsv(state.rounds))}
              disabled={state.rounds.length === 0}
              className="btn btn-ghost text-sm"
            >
              CSV 다운로드
            </button>
          </div>
          <div className="max-h-[28rem] overflow-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-white/50">
                <tr><th className="py-1">라운드</th><th>우승자</th><th>반응</th><th>시각</th><th /></tr>
              </thead>
              <tbody>
                {state.rounds.map((r) => (
                  <tr key={r.id} className="border-t border-white/5">
                    <td className="py-2 font-bold">{r.round_number}</td>
                    <td className="font-bold text-amber-200">{r.winner_nickname ?? <span className="text-white/40">{STATUS_LABEL[r.status]}</span>}</td>
                    <td className="text-white/60">{reactionSeconds(r) != null ? `${reactionSeconds(r)!.toFixed(2)}s` : ''}</td>
                    <td className="text-white/60">{r.winner_at ? new Date(r.winner_at).toLocaleTimeString('ko-KR') : ''}</td>
                    <td className="text-right">
                      {r.winner_nickname && (
                        <button
                          onClick={() =>
                            window.confirm(`${r.round_number}라운드 ${r.winner_nickname}님의 우승 기록을 취소할까요?`) &&
                            run('CANCEL', () => rpc('admin_cancel_win', { p_admin_token: token, p_round_id: r.id }))
                          }
                          className="rounded-lg px-2 py-1 text-xs font-bold text-rose-300 hover:bg-rose-500/20"
                        >
                          취소
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ---------- test mode & maintenance ---------- */}
      <section className="mt-4 grid gap-4 lg:grid-cols-2">
        <div className="rounded-3xl bg-violet-500/10 p-4 ring-1 ring-violet-400/30">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-black">관리자 테스트 모드</h2>
            <label className="flex items-center gap-2 font-bold">
              <input
                type="checkbox"
                checked={room.test_mode}
                onChange={(e) =>
                  run('TEST', async () => {
                    await rpc('admin_set_test_mode', { p_admin_token: token, p_room_id: room.id, p_enabled: e.target.checked });
                    if (!e.target.checked) setBots([]);
                  })
                }
                className="h-5 w-5 accent-violet-500"
              />
              {room.test_mode ? 'ON' : 'OFF'}
            </label>
          </div>
          <p className="mt-1 text-sm text-white/60">
            가상 참가자(봇)를 만들어 실제 서버 판정 경로(buzz RPC)로 동시에 부저를 눌러 봅니다. 끄면 봇이 삭제됩니다.
          </p>
          {room.test_mode && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <input
                type="number" min={1} max={30} value={botCount}
                onChange={(e) => setBotCount(Math.max(1, Math.min(30, Number(e.target.value) || 1)))}
                className="w-20 rounded-xl bg-white/10 px-3 py-2 text-white"
              />
              <button
                disabled={!!busy}
                onClick={() =>
                  run('BOTS', async () => {
                    const added = await rpc<typeof bots>('admin_add_test_bots', { p_admin_token: token, p_room_id: room.id, p_count: botCount });
                    setBots((b) => [...b, ...added]);
                  })
                }
                className="btn btn-ghost"
              >
                봇 추가
              </button>
              <button
                disabled={!!busy || bots.length === 0 || round?.status !== 'ARMED'}
                onClick={() =>
                  run('BOTBUZZ', async () => {
                    const t0 = performance.now();
                    const results = await Promise.all(
                      bots.map((b) => rpc<BuzzResponse>('buzz', { p_token: b.token, p_round_id: round!.id }).catch(() => null)),
                    );
                    const won = results.filter((r) => r?.result === 'WON').length;
                    const lost = results.filter((r) => r?.result === 'LOST').length;
                    setBotResult(`${bots.length}명 동시 요청 → 우승 ${won}명, 패배 ${lost}명, 기타 ${bots.length - won - lost}건 (${Math.round(performance.now() - t0)}ms)`);
                  })
                }
                className="btn btn-red"
              >
                봇 {bots.length}명 동시 부저
              </button>
              <button
                disabled={!!busy}
                onClick={() =>
                  run('RMBOTS', async () => {
                    await rpc('admin_remove_test_bots', { p_admin_token: token, p_room_id: room.id });
                    setBots([]);
                  })
                }
                className="btn btn-ghost"
              >
                봇 모두 삭제
              </button>
            </div>
          )}
          {room.test_mode && bots.length === 0 && people.some((p) => p.is_test) && (
            <p className="mt-2 text-xs text-white/50">새로고침 전에 만든 봇은 토큰이 없어 부저를 누를 수 없습니다. 삭제 후 다시 추가하세요.</p>
          )}
          {botResult && <p className="mt-2 font-bold text-violet-200">{botResult}</p>}
        </div>

        <div className="rounded-3xl bg-white/5 p-4 ring-1 ring-white/10">
          <h2 className="text-lg font-black">관리</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              disabled={!!busy}
              onClick={() =>
                window.confirm('참가자와 라운드 기록을 모두 삭제하고 1라운드부터 다시 시작할까요?\n(방 코드와 QR은 그대로 유지됩니다)') &&
                run('RESET', async () => {
                  await rpc('admin_reset_room', { p_admin_token: token, p_room_id: room.id });
                  setBots([]);
                  setToast({ text: '전체 초기화 완료', tone: 'info' });
                })
              }
              className="btn btn-ghost text-rose-300"
            >
              참가자 전체 초기화
            </button>
            <button onClick={onLeaveRoom} className="btn btn-ghost">다른 방 선택</button>
            <button onClick={onLogout} className="btn btn-ghost">로그아웃</button>
          </div>
          <p className="mt-3 text-sm text-white/50">단축키: R 준비 · A 부저 활성화 · L 잠금 · N 다음 문제</p>
        </div>
      </section>

      {toast && (
        <div role="alert" className={`fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-2xl px-5 py-3 font-bold text-white shadow-xl ${toast.tone === 'error' ? 'bg-rose-600' : 'bg-emerald-600'}`}>
          {toast.text}
        </div>
      )}
    </main>
  );
}
