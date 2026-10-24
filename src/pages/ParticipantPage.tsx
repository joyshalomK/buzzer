import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Buzzer } from '../components/Buzzer';
import { Confetti } from '../components/Confetti';
import { ConnectionBadge } from '../components/ConnectionBadge';
import { SoundToggle } from '../components/SoundToggle';
import { useLiveSync } from '../hooks/useLiveSync';
import { useSoundState } from '../hooks/useSound';
import { useWakeLock } from '../hooks/useWakeLock';
import { clampNickname, deriveParticipantView, nicknameLength, pressKey } from '../lib/participantView';
import { sfx, unlockAudio, vibrate } from '../lib/sound';
import { KEYS, load, save } from '../lib/storage';
import { RpcError, errorMessage, rpc } from '../lib/supabase';
import type { BuzzResponse, ParticipantSession, ParticipantSync, Room, Round, SyncFailure } from '../lib/types';

class SessionEnded extends Error {}

const LEAVE_MESSAGES: Record<string, string> = {
  KICKED: '사회자에 의해 퇴장되었습니다. 다시 입장하려면 사회자에게 문의해 주세요.',
  INVALID_TOKEN: '참가 정보가 초기화되었습니다. 다시 입장해 주세요.',
};

export function ParticipantPage() {
  const { roomCode } = useParams();
  const [session, setSession] = useState<ParticipantSession | null>(() => load(KEYS.session, null));
  const [notice, setNotice] = useState<string | null>(null);

  const urlCode = roomCode?.toUpperCase();
  const active = session && (!urlCode || session.room_code === urlCode) ? session : null;

  if (!active) {
    return (
      <JoinForm
        initialCode={urlCode}
        notice={notice}
        onJoined={(s) => {
          save(KEYS.session, s);
          setNotice(null);
          setSession(s);
        }}
      />
    );
  }
  return (
    <PlayScreen
      key={active.token}
      session={active}
      onLeave={(reason) => {
        save(KEYS.session, null);
        setSession(null);
        setNotice(LEAVE_MESSAGES[reason] ?? null);
      }}
    />
  );
}

// ---------------------------------------------------------------------------

function JoinForm({ initialCode, notice, onJoined }: {
  initialCode?: string;
  notice: string | null;
  onJoined: (s: ParticipantSession) => void;
}) {
  const [code, setCode] = useState(initialCode ?? '');
  const [nickname, setNickname] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (initialCode) return;
    rpc<{ room_code: string } | null>('get_latest_room')
      .then((r) => r?.room_code && setCode((c) => c || r.room_code))
      .catch(() => {});
  }, [initialCode]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    unlockAudio(); // this tap is our user gesture for iOS audio
    if (busy) return;
    const nick = nickname.trim();
    if (!nick) return setError('닉네임을 입력해 주세요.');
    if (!code.trim()) return setError('방 코드를 입력해 주세요.');
    setBusy(true);
    setError(null);
    try {
      const r = await rpc<{ participant_id: string; token: string; nickname: string; room_code: string }>('join_room', {
        p_room_code: code.trim().toUpperCase(),
        p_nickname: nick,
      });
      onJoined({ token: r.token, participant_id: r.participant_id, nickname: r.nickname, room_code: r.room_code });
      navigate(`/room/${r.room_code}`, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="stage flex min-h-dvh flex-col items-center justify-center px-5 py-10">
      <h1 className="font-display text-center text-5xl leading-none text-white drop-shadow">
        FM FAMILY<br /><span className="text-amber-300">QUIZ</span>
      </h1>
      <p className="mt-3 text-center text-lg text-white/70">닉네임을 쓰고 입장하세요!</p>

      <form onSubmit={submit} className="mt-8 w-full max-w-sm space-y-5">
        {notice && <p className="rounded-2xl bg-amber-400/15 p-4 text-center font-bold text-amber-100">{notice}</p>}
        <label className="block">
          <span className="mb-1.5 block text-base font-bold text-white/80">방 코드</span>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8))}
            inputMode="text"
            autoCapitalize="characters"
            autoComplete="off"
            className="w-full rounded-2xl border-2 border-white/15 bg-white/10 px-4 py-4 text-center font-display text-3xl tracking-[0.3em] text-white outline-none focus:border-amber-300"
            placeholder="ABCD"
          />
        </label>
        <label className="block">
          <span className="mb-1.5 flex justify-between text-base font-bold text-white/80">
            <span>닉네임</span>
            <span className="text-white/50">{nicknameLength(nickname)}/12</span>
          </span>
          <input
            value={nickname}
            onChange={(e) => setNickname(clampNickname(e.target.value))}
            autoComplete="off"
            enterKeyHint="go"
            className="w-full rounded-2xl border-2 border-white/15 bg-white/10 px-4 py-4 text-center text-2xl font-bold text-white outline-none focus:border-amber-300"
            placeholder="예) 슈퍼민수"
          />
        </label>
        {error && <p role="alert" className="text-center text-base font-bold text-rose-300">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-2xl bg-emerald-500 py-5 text-2xl font-black text-white shadow-[0_6px_0_#047857] transition active:translate-y-1 active:shadow-[0_2px_0_#047857] disabled:opacity-60"
        >
          {busy ? '입장 중…' : '입장하기'}
        </button>
      </form>
    </main>
  );
}

// ---------------------------------------------------------------------------

function PlayScreen({ session, onLeave }: { session: ParticipantSession; onLeave: (reason: string) => void }) {
  const [roomId, setRoomId] = useState<string | null>(null);
  const [localPress, setLocalPress] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [celebrate, setCelebrate] = useState(0);
  const [flash, setFlash] = useState<string | null>(null);
  const pending = useRef(false);
  const { muted, ready } = useSoundState();
  useWakeLock(true);

  const fetcher = useCallback(async () => {
    const r = await rpc<ParticipantSync | SyncFailure>('participant_sync', { p_token: session.token });
    if (!r.ok) throw new SessionEnded(r.error);
    return r;
  }, [session.token]);

  const live = useLiveSync<ParticipantSync>({
    roomId,
    fetcher,
    onChange: (change, table) => {
      const row = change.new as { id?: string };
      if (!row?.id) return;
      // apply realtime rows immediately; the follow-up re-fetch confirms them
      live.setData((d) => {
        if (!d) return d;
        if (table === 'rooms') return { ...d, room: { ...d.room, ...(row as Room) } };
        const n = row as Round;
        const cur = d.round;
        if (cur && n.id !== cur.id && n.round_number < cur.round_number) return d; // stale row
        const sameArm = cur && n.id === cur.id && n.arm_seq === cur.arm_seq;
        return {
          ...d,
          round: n,
          me: sameArm ? d.me : { ...d.me, attempted: false, excluded: cur?.id === n.id ? d.me.excluded : false },
        };
      });
    },
  });
  const data = live.data;

  useEffect(() => {
    if (data?.room.id) setRoomId(data.room.id);
  }, [data?.room.id]);

  useEffect(() => {
    if (live.error instanceof SessionEnded) onLeave(live.error.message);
  }, [live.error, onLeave]);

  const round = data?.round ?? null;
  const view = deriveParticipantView({
    connected: live.connected,
    room: data?.room ?? null,
    round,
    myId: session.participant_id,
    attempted: data?.me.attempted ?? false,
    excluded: data?.me.excluded ?? false,
    localPressKey: localPress,
  });

  // sounds / vibration / confetti on server-confirmed transitions
  const prev = useRef<{ id: string; status: string; winner: string } | null>(null);
  const winnerKey = round?.winner_nickname ? `${round.winner_nickname}@${Date.parse(round.winner_at ?? '')}` : '';
  useEffect(() => {
    if (!round) return;
    const p = prev.current;
    prev.current = { id: round.id, status: round.status, winner: winnerKey };
    if (!p) return; // first load after refresh: no fanfare
    if (winnerKey && (p.id !== round.id || p.winner !== winnerKey)) {
      if (round.winner_id === session.participant_id) {
        sfx.win();
        vibrate([90, 60, 90, 60, 200]);
        setCelebrate((c) => c + 1);
      } else {
        sfx.chime();
        vibrate(40);
      }
      setFlash('winner');
    } else if (round.status === 'ARMED' && (p.status !== 'ARMED' || p.id !== round.id)) {
      sfx.start();
      vibrate(35);
      setFlash('armed');
    }
  }, [round?.id, round?.status, winnerKey]);

  useEffect(() => {
    if (!flash) return;
    const t = window.setTimeout(() => setFlash(null), 450);
    return () => window.clearTimeout(t);
  }, [flash]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 3500);
    return () => window.clearTimeout(t);
  }, [toast]);

  const press = async () => {
    if (pending.current || !view.canBuzz || !round) return;
    pending.current = true;
    const key = pressKey(round);
    setLocalPress(key);
    sfx.buzz();
    vibrate(60);
    try {
      let res: BuzzResponse | null = null;
      for (let attempt = 0; !res; attempt++) {
        try {
          // idempotent on the server: retries can never create a second attempt
          res = await rpc<BuzzResponse>('buzz', { p_token: session.token, p_round_id: round.id });
        } catch (e) {
          if (!(e instanceof RpcError && e.network) || attempt >= 2) throw e;
          await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
        }
      }
      if (res.result === 'INVALID_TOKEN' || res.result === 'KICKED') return onLeave(res.result);
      if (res.result === 'NOT_ARMED' || res.result === 'STALE_ROUND') setLocalPress(null);
      if ((res.result === 'WON' || res.result === 'LOST') && res.winner_nickname) {
        const won = res.result === 'WON';
        const r = res;
        live.setData((d) => {
          if (!d?.round || d.round.id !== r.round_id) return d;
          const round: Round = {
            ...d.round,
            status: 'LOCKED',
            winner_nickname: r.winner_nickname ?? null,
            winner_at: r.winner_at ?? null,
            winner_id: won ? session.participant_id : d.round.winner_id,
          };
          return { ...d, round };
        });
      }
    } catch (e) {
      setLocalPress(null); // allow another try; the server dedupes
      setToast(errorMessage(e));
    } finally {
      pending.current = false;
      void live.refresh();
    }
  };

  const isWinner = view.kind === 'WINNER_ME';
  const showWinnerName = view.kind === 'WINNER_ME' || view.kind === 'WINNER_OTHER';

  return (
    <main
      className={`stage relative flex min-h-dvh flex-col overflow-hidden px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[max(0.75rem,env(safe-area-inset-top))]
        ${isWinner ? 'stage-gold' : ''}`}
    >
      {celebrate > 0 && isWinner && <Confetti key={celebrate} />}
      {flash && <div aria-hidden className={`pointer-events-none fixed inset-0 z-30 flash-${flash}`} />}

      <header className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="font-display text-xl leading-tight tracking-wide text-amber-300">FM FAMILY QUIZ</p>
          <p className="truncate text-lg font-black text-white">{session.nickname}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <ConnectionBadge connected={live.connected} realtime={live.realtime} />
          <SoundToggle />
        </div>
      </header>

      {data?.room.announcement && (
        <div className="mt-3 rounded-2xl border border-amber-300/40 bg-amber-300/15 px-4 py-3 text-center text-lg font-bold text-amber-50">
          📢 {data.room.announcement}
        </div>
      )}

      <section className="flex flex-1 flex-col items-center justify-center gap-6 py-4 text-center">
        <div className="min-h-[5.5rem]">
          {showWinnerName ? (
            <>
              <p className="text-2xl font-black text-amber-200">{isWinner ? '🎉 축하해요!' : '1등!'}</p>
              <p className="winner-pop font-display text-[clamp(2.5rem,13vw,4.5rem)] leading-tight text-amber-300 drop-shadow-[0_0_24px_rgba(251,191,36,0.6)]">
                {round?.winner_nickname}
              </p>
            </>
          ) : (
            <p
              className={`font-display text-[clamp(2.25rem,11vw,3.75rem)] leading-tight
                ${view.kind === 'ARMED' ? 'text-rose-300' : view.kind === 'READY' ? 'text-emerald-300' : view.kind === 'DISCONNECTED' ? 'text-rose-300' : 'text-white'}`}
            >
              {view.title}
            </p>
          )}
        </div>

        {view.kind === 'ENDED' ? (
          <div className="rounded-3xl bg-white/10 px-8 py-8">
            <p className="text-6xl">🏆</p>
            <p className="mt-3 text-2xl font-black text-white">내 1등 횟수: {data?.me.wins ?? 0}번</p>
          </div>
        ) : (
          <Buzzer kind={view.kind} enabled={view.canBuzz} onPress={() => void press()} />
        )}

        {view.kind === 'READY' && (
          <p className="inline-flex items-center gap-2 rounded-full bg-emerald-500/20 px-4 py-2 text-lg font-black text-emerald-300">
            <span className="h-3 w-3 rounded-full bg-emerald-400" /> 준비 완료
          </p>
        )}
      </section>

      <footer className="space-y-2 text-center">
        <p className={`text-xl font-bold ${view.kind === 'DISCONNECTED' ? 'text-rose-300' : 'text-white/85'}`}>{view.message}</p>
        <p className="text-base font-bold text-white/50">
          {round ? `ROUND ${round.round_number}` : ''}
          {data ? ` · 참가자 ${data.participant_count}명` : ''}
          {data && data.me.wins > 0 ? ` · 내 1등 ${data.me.wins}번` : ''}
        </p>
        {!muted && !ready && (
          <p className="text-sm text-amber-200/80">🔈 화면을 한 번 터치하면 소리가 켜져요</p>
        )}
      </footer>

      {toast && (
        <div role="alert" className="fixed inset-x-4 bottom-24 z-50 rounded-2xl bg-rose-600 px-4 py-3 text-center font-bold text-white shadow-xl">
          {toast}
        </div>
      )}
    </main>
  );
}
