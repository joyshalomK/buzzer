import { useCallback, useEffect, useRef, useState } from 'react';
import { Confetti } from '../components/Confetti';
import { ConnectionBadge } from '../components/ConnectionBadge';
import { SoundToggle } from '../components/SoundToggle';
import { SyncButton } from '../components/SyncButton';
import { SyncResultList } from '../components/SyncResults';
import { useLiveSync } from '../hooks/useLiveSync';
import { useAtServerTime, useServerNow } from '../hooks/useServerNow';
import { useSoundState } from '../hooks/useSound';
import { useWakeLock } from '../hooks/useWakeLock';
import { serverClock } from '../lib/serverClock';
import { sfx, vibrate } from '../lib/sound';
import { RpcError, errorMessage, rpc } from '../lib/supabase';
import { deriveSyncView, formatMs, formatSeconds, fullyRevealed } from '../lib/syncView';
import type { RoomMode, SyncBuzzResponse, SyncParticipantState, SyncSession } from '../lib/types';

class SessionEnded extends Error {}

type SyncFailure = { ok: false; error: 'INVALID_TOKEN' | 'KICKED' };

export function SyncPlayScreen({ session, onLeave, onMode }: {
  session: SyncSession;
  onLeave: (reason: string) => void;
  onMode: (mode: RoomMode) => void;
}) {
  const [roomId, setRoomId] = useState<string | null>(null);
  const [localPressRound, setLocalPressRound] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);
  const [celebrate, setCelebrate] = useState(0);
  const pending = useRef(false);
  const { muted, ready } = useSoundState();
  useWakeLock(true);

  const fetcher = useCallback(async () => {
    const t0 = Date.now();
    const r = await rpc<SyncParticipantState | SyncFailure>('sync_state', { p_token: session.token });
    if (!r.ok) throw new SessionEnded(r.error);
    serverClock.sample(t0, Date.now(), r.server_now_ms);
    return r;
  }, [session.token]);

  const live = useLiveSync<SyncParticipantState>({ roomId, fetcher, liveIntervalMs: 5000 });
  const data = live.data;
  const round = data?.round ?? null;

  useEffect(() => {
    if (data?.room.id) setRoomId(data.room.id);
  }, [data?.room.id]);
  useEffect(() => {
    if (data?.room.mode) onMode(data.room.mode);
  }, [data?.room.mode, onMode]);
  useEffect(() => {
    if (live.error instanceof SessionEnded) onLeave(live.error.message);
  }, [live.error, onLeave]);

  const running = round?.status === 'RUNNING';
  const now = useServerNow(running);
  // the server closes the round at the deadline; ask for the result right after
  useAtServerTime(running ? round?.deadline_ms : null, () => void live.refresh(), 400);

  const view = deriveSyncView({
    connected: live.connected,
    room: data?.room ?? null,
    round,
    teamSize: data?.team.members.length ?? 0,
    pressed: data?.me.pressed ?? false,
    localPressed: !!round && localPressRound === round.id,
    eligible: data?.me.eligible ?? true,
    now,
  });

  // countdown beeps, GO signal, reveal effects — never on the first load
  const prev = useRef<{ phase: string; countdown: number | null; revealed: string } | null>(null);
  const myResult = data?.results.find((t) => t.team_id === data.team.id) ?? null;
  const revealedKey = `${round?.id}:${round?.revealed_rank ?? ''}`;
  useEffect(() => {
    if (!data) return;
    const p = prev.current;
    prev.current = { phase: view.phase, countdown: view.countdown, revealed: revealedKey };
    if (!p) return;
    if (view.phase === 'COUNTDOWN' && view.countdown !== p.countdown) {
      sfx.tick();
      vibrate(20);
    } else if (view.phase === 'GO' && p.phase !== 'GO') {
      sfx.start();
      vibrate(60);
      setFlash(true);
    } else if (view.phase === 'RESULTS' && revealedKey !== p.revealed) {
      if (myResult?.rank === 1) {
        sfx.win();
        vibrate([90, 60, 90, 60, 200]);
        setCelebrate((c) => c + 1);
      } else sfx.reveal();
    }
  }, [data, view.phase, view.countdown, revealedKey, myResult?.rank]);

  useEffect(() => {
    if (!flash) return;
    const t = window.setTimeout(() => setFlash(false), 450);
    return () => window.clearTimeout(t);
  }, [flash]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 3500);
    return () => window.clearTimeout(t);
  }, [toast]);

  const press = async () => {
    if (pending.current || !view.canPress || !round) return;
    pending.current = true;
    setLocalPressRound(round.id);
    sfx.tap();
    vibrate(50);
    try {
      let res: SyncBuzzResponse | null = null;
      for (let attempt = 0; !res; attempt++) {
        try {
          // a retry of a press that did arrive comes back as DUPLICATE: never two records
          res = await rpc<SyncBuzzResponse>('sync_buzz', { p_token: session.token, p_round_id: round.id });
        } catch (e) {
          if (!(e instanceof RpcError && e.network) || attempt >= 2) throw e;
          await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
        }
      }
      switch (res.result) {
        case 'ACCEPTED':
        case 'DUPLICATE':
          live.setData((d) => (d && d.round?.id === round.id ? { ...d, me: { ...d.me, pressed: true } } : d));
          break;
        case 'TOO_EARLY':
          setLocalPressRound(null);
          setToast('신호보다 조금 빨랐어요! 다시 눌러 주세요');
          break;
        case 'TOO_LATE':
        case 'CLOSED':
          setLocalPressRound(null);
          setToast('10초가 지나 입력되지 않았어요');
          break;
        case 'INVALID_TOKEN':
        case 'KICKED':
          return onLeave(res.result);
        case 'NOT_ELIGIBLE':
          setToast('이번 라운드는 재경기 팀만 참여합니다');
          break;
        default:
          setLocalPressRound(null);
      }
    } catch (e) {
      setLocalPressRound(null);
      setToast(errorMessage(e));
    } finally {
      pending.current = false;
      void live.refresh();
    }
  };

  const leaveTeam = async () => {
    if (!window.confirm('이 팀에서 나가고 가족 닉네임을 다시 입력할까요?')) return;
    try {
      await rpc('sync_leave', { p_token: session.token });
      onLeave('LEFT');
    } catch (e) {
      setToast(errorMessage(e));
    }
  };

  const showResults = view.phase === 'RESULTS';
  const iWon = showResults && fullyRevealed(round) && myResult?.rank === 1;
  const members = data?.team.members ?? [];

  return (
    <main
      className={`stage relative flex min-h-dvh flex-col overflow-hidden px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[max(0.75rem,env(safe-area-inset-top))]
        ${iWon ? 'stage-gold' : ''}`}
    >
      {celebrate > 0 && <Confetti key={celebrate} />}
      {flash && <div aria-hidden className="pointer-events-none fixed inset-0 z-30 flash-sync" />}

      <header className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="font-display text-xl leading-tight tracking-wide text-cyan-300">FAMILY SYNC</p>
          <p className="truncate text-lg font-black text-white">
            {data?.team.name ?? session.team_name} <span className="text-white/60">· {session.label}</span>
          </p>
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

      {/* team member connection state */}
      <ul className="mt-3 flex justify-center gap-2">
        {[0, 1].map((i) => {
          const m = members[i];
          return (
            <li key={i} className={`flex min-w-0 items-center gap-2 rounded-full px-3 py-1.5 text-base font-bold ${m ? 'bg-white/10' : 'border border-dashed border-white/25 text-white/40'}`}>
              <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${!m ? 'bg-slate-600' : m.online ? 'bg-emerald-400' : 'bg-rose-400 animate-pulse'}`} />
              <span className="truncate">{m ? `${m.label}${m.me ? ' (나)' : ''}` : '파트너 대기'}</span>
            </li>
          );
        })}
      </ul>

      {showResults ? (
        <section className="flex flex-1 flex-col items-center gap-4 overflow-y-auto py-4 text-center">
          {myResult ? (
            <div className={`w-full rounded-3xl p-5 ring-1 ${myResult.rank === 1 ? 'bg-amber-400/20 ring-amber-300/60' : 'bg-white/10 ring-white/15'}`}>
              <p className="text-lg font-bold text-white/70">우리 가족 기록</p>
              <p className="winner-pop font-display text-[clamp(2.5rem,12vw,4rem)] leading-tight text-amber-300">
                {myResult.rank != null ? `${myResult.rank}위` : myResult.status === 'PARTIAL' ? '미완료' : '미참여'}
              </p>
              {myResult.status === 'COMPLETE' && (
                <p className="text-2xl font-black text-cyan-200">차이 {formatMs(myResult.gap_ms)}</p>
              )}
              <p className="mt-2 text-base text-white/70">
                {myResult.members.map((m) => `${m.label} ${formatSeconds(m.elapsed_ms)}`).join(' · ')}
              </p>
            </div>
          ) : (
            <p className="rounded-2xl bg-white/10 px-5 py-4 text-xl font-bold text-white/80">
              우리 가족 순위는 곧 공개됩니다… 두근두근!
            </p>
          )}
          <SyncResultList results={data?.results ?? []} highlightTeamId={data?.team.id} />
        </section>
      ) : (
        <section className="flex flex-1 flex-col items-center justify-center gap-6 py-4 text-center">
          <p
            className={`min-h-[4rem] font-display text-[clamp(2.25rem,11vw,3.75rem)] leading-tight
              ${view.phase === 'GO' ? 'buzzer-text-pulse text-cyan-300' : view.phase === 'READY' || view.phase === 'TEAM_READY' ? 'text-emerald-300' : view.phase === 'DISCONNECTED' ? 'text-rose-300' : 'text-white'}`}
          >
            {view.title}
          </p>
          {view.phase !== 'ENDED' && (
            <SyncButton phase={view.phase} enabled={view.canPress} countdown={view.countdown} onPress={() => void press()} />
          )}
        </section>
      )}

      <footer className="space-y-2 text-center">
        <p className={`text-xl font-bold ${view.phase === 'DISCONNECTED' ? 'text-rose-300' : 'text-white/85'}`}>{view.message}</p>
        <p className="text-base font-bold text-white/50">
          {round ? `ROUND ${round.round_number}` : ''}
          {data ? ` · ${data.team_count}가족 참가` : ''}
        </p>
        {!running && (view.phase === 'WAITING_PARTNER' || view.phase === 'TEAM_READY') && (
          <button onClick={() => void leaveTeam()} className="text-sm font-bold text-white/50 underline underline-offset-4">
            가족 닉네임을 잘못 입력했어요
          </button>
        )}
        {!muted && !ready && <p className="text-sm text-amber-200/80">🔈 화면을 한 번 터치하면 소리가 켜져요</p>}
      </footer>

      {toast && (
        <div role="alert" className="fixed inset-x-4 bottom-24 z-50 rounded-2xl bg-rose-600 px-4 py-3 text-center font-bold text-white shadow-xl">
          {toast}
        </div>
      )}
    </main>
  );
}
