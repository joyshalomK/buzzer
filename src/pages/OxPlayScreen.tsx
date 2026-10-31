import { useCallback, useEffect, useRef, useState } from 'react';
import { Confetti } from '../components/Confetti';
import { ConnectionBadge } from '../components/ConnectionBadge';
import { SoundToggle } from '../components/SoundToggle';
import { useLiveSync } from '../hooks/useLiveSync';
import { useAtServerTime, useServerNow } from '../hooks/useServerNow';
import { useSoundState } from '../hooks/useSound';
import { useWakeLock } from '../hooks/useWakeLock';
import { createSeq } from '../lib/matchView';
import { deriveOxView, survivalLine } from '../lib/oxView';
import { serverClock } from '../lib/serverClock';
import { sfx, vibrate } from '../lib/sound';
import { RpcError, errorMessage, rpc } from '../lib/supabase';
import type { OxAnswer, OxAnswerResponse, OxParticipantState, RoomMode } from '../lib/types';

class SessionEnded extends Error {}

type OxFailure = { ok: false; error: 'INVALID_TOKEN' | 'KICKED' };
/** my latest tap in this round */
type LocalPick = { round: string; answer: OxAnswer; saved: boolean };

/** OX SURVIVAL on a phone. Works with a quiz-buzzer or a family-member token. */
export function OxPlayScreen({ token, fallbackName, onLeave, onMode }: {
  token: string;
  fallbackName: string;
  onLeave: (reason: string) => void;
  onMode: (mode: RoomMode) => void;
}) {
  const [roomId, setRoomId] = useState<string | null>(null);
  const [local, setLocal] = useState<LocalPick | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);
  const [celebrate, setCelebrate] = useState(0);
  const [nextSeq] = useState(() => createSeq());
  const latestSeq = useRef(0);
  const { muted, ready } = useSoundState();
  useWakeLock(true);

  const fetcher = useCallback(async () => {
    const t0 = Date.now();
    const r = await rpc<OxParticipantState | OxFailure>('ox_state', { p_token: token });
    if (!r.ok) throw new SessionEnded(r.error);
    serverClock.sample(t0, Date.now(), r.server_now_ms);
    return r;
  }, [token]);

  const live = useLiveSync<OxParticipantState>({ roomId, fetcher, liveIntervalMs: 5000, tables: ['rooms', 'ox_games'] });
  const data = live.data;
  const game = data?.game ?? null;
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

  const answering = game?.status === 'ANSWERING';
  const now = useServerNow(answering, 250);
  // the server closes the round at the deadline; ask for the new state right after
  useAtServerTime(answering ? round?.deadline_ms : null, () => void live.refresh(), 400);

  const view = deriveOxView({ room: data?.room ?? null, game, round, me: data?.me ?? null, verdict: data?.verdict ?? null, now });
  const roundKey = round?.id ?? '';
  const mine: OxAnswer | null = local?.round === roundKey ? local.answer : data?.me.answer ?? null;
  const saved = local?.round === roundKey ? local.saved : data?.me.answer != null;
  const winner = view.phase === 'FINISHED' && view.alive;

  // effects on server-confirmed transitions — never on the first load
  const prev = useRef<{ phase: string; round: string } | null>(null);
  useEffect(() => {
    if (!data) return;
    const p = prev.current;
    prev.current = { phase: view.phase, round: roundKey };
    if (!p || (p.phase === view.phase && p.round === roundKey)) return;
    if (view.phase === 'OPEN' && view.alive) {
      sfx.start();
      vibrate(50);
      setFlash(true);
    } else if (view.phase === 'CLOSED' && p.phase === 'OPEN') sfx.chime();
    else if (view.phase === 'REVEAL' && data.verdict) {
      if (data.verdict.correct) {
        sfx.win();
        vibrate([80, 50, 80]);
      } else {
        sfx.buzz();
        vibrate(300);
      }
    } else if (view.phase === 'REVEAL' || view.phase === 'VOID') sfx.reveal();
    else if (view.phase === 'FINISHED') {
      if (winner) {
        sfx.win();
        vibrate([90, 60, 90, 60, 200]);
        setCelebrate((c) => c + 1);
      } else sfx.reveal();
    }
  }, [data, view.phase, view.alive, roundKey, winner]);

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

  const choose = async (answer: OxAnswer) => {
    if (!view.canAnswer || !round) return;
    const seq = nextSeq();
    latestSeq.current = seq;
    const r = round.id;
    setLocal({ round: r, answer, saved: false });
    sfx.tap();
    vibrate(25);
    try {
      let res: OxAnswerResponse | null = null;
      for (let attempt = 0; !res; attempt++) {
        try {
          // same seq on retry: the server stores it once, a newer tap always wins
          res = await rpc<OxAnswerResponse>('ox_answer', { p_token: token, p_round_id: r, p_answer: answer, p_seq: seq });
        } catch (e) {
          if (!(e instanceof RpcError && e.network) || attempt >= 2) throw e;
          await new Promise((ok) => setTimeout(ok, 200 * (attempt + 1)));
        }
      }
      if (res.result === 'INVALID_TOKEN' || res.result === 'KICKED') return onLeave(res.result);
      if (latestSeq.current !== seq) return; // a newer tap is in flight and owns the screen
      switch (res.result) {
        case 'ACCEPTED':
        case 'STALE': {
          const stored = res.answer ?? answer;
          setLocal({ round: r, answer: stored, saved: true });
          live.setData((d) => (d && d.round?.id === r ? { ...d, me: { ...d.me, answer: stored, seq } } : d));
          break;
        }
        case 'TOO_LATE':
        case 'CLOSED':
          setLocal(null);
          setToast(res.answer ? `시간이 지나 바뀌지 않았어요 (제출된 답: ${res.answer})` : '응답 시간이 지났어요');
          break;
        case 'NOT_OPEN':
          setLocal(null);
          setToast('아직 응답 시간이 아니에요');
          break;
        case 'ELIMINATED':
        case 'NOT_PLAYING':
          setLocal(null);
          setToast('이번 게임에서는 응답할 수 없어요 (관전 중)');
          break;
        default:
          setLocal(null);
      }
    } catch (e) {
      if (latestSeq.current === seq) {
        setLocal(null);
        setToast(errorMessage(e));
      }
    } finally {
      void live.refresh();
    }
  };

  const me = data?.me;
  const counts = data?.counts;
  const line = survivalLine(round);
  const showButtons = view.phase === 'READY' || view.phase === 'OPEN' || view.phase === 'CLOSED';
  const badge = !me ? null
    : me.role === 'CANDIDATE' ? { text: '참가 대기', cls: 'bg-white/15 text-white' }
    : me.role === 'SPECTATOR' ? { text: '관전 중', cls: 'bg-white/15 text-white/80' }
    : me.status === 'ALIVE' ? { text: '생존', cls: 'bg-emerald-500 text-white' }
    : { text: `탈락 (R${me.eliminated_round})`, cls: 'bg-slate-600 text-white/80' };

  return (
    <main
      className={`stage relative flex min-h-dvh flex-col overflow-hidden px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[max(0.75rem,env(safe-area-inset-top))]
        ${winner ? 'stage-gold' : ''}`}
    >
      {celebrate > 0 && <Confetti key={celebrate} />}
      {flash && <div aria-hidden className="pointer-events-none fixed inset-0 z-30 flash-armed" />}

      <header className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="font-display text-xl leading-tight tracking-wide text-sky-300">OX SURVIVAL</p>
          <p className="flex items-center gap-2 truncate text-lg font-black text-white">
            <span className="truncate">{me?.name ?? fallbackName}</span>
            {badge && <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-sm ${badge.cls}`}>{badge.text}</span>}
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

      {showButtons && game ? (
        <section className="flex flex-1 flex-col gap-4 py-4">
          <div className="flex items-center justify-between">
            <span className="rounded-full bg-white/10 px-4 py-1 font-display text-2xl">ROUND {game.current_round}</span>
            <span
              className={`rounded-full px-4 py-1 font-display text-2xl tabular-nums
                ${view.phase === 'OPEN' ? (view.remaining != null && view.remaining <= 3 ? 'bg-rose-500 text-white' : 'bg-sky-400/25 text-sky-100') : 'bg-white/10 text-white/60'}`}
            >
              {view.phase === 'OPEN' ? `⏱ ${view.remaining ?? '-'}초` : view.phase === 'READY' ? '준비' : '마감'}
            </span>
          </div>
          <p className="text-center text-lg font-bold text-white/70">
            현재 생존자 <span className="font-display text-2xl text-emerald-300">{counts?.alive ?? '-'}</span>명
            {view.phase === 'OPEN' && counts && <span className="text-white/50"> · 응답 {counts.answered}명</span>}
          </p>
          <p className={`text-center font-display text-[clamp(1.8rem,8vw,2.6rem)] leading-tight ${view.phase === 'CLOSED' ? 'text-amber-300' : 'text-white'}`}>
            {view.phase === 'CLOSED' ? '응답 마감! 과연 정답은?' : view.message}
          </p>

          <div className="grid flex-1 grid-cols-2 gap-3">
            {(['O', 'X'] as const).map((o) => {
              const selected = mine === o;
              return (
                <button
                  key={o}
                  disabled={!view.canAnswer}
                  onClick={() => void choose(o)}
                  aria-pressed={selected}
                  aria-label={o}
                  className={`relative flex min-h-[12rem] items-center justify-center rounded-[2rem] transition active:translate-y-1 disabled:cursor-not-allowed
                    ${o === 'O' ? 'bg-sky-500 shadow-[0_8px_0_#075985]' : 'bg-rose-500 shadow-[0_8px_0_#9f1239]'}
                    ${selected ? 'ring-[6px] ring-white' : mine ? 'opacity-40' : ''}
                    ${!view.canAnswer && !selected ? 'opacity-35 saturate-50' : ''}`}
                >
                  <span className="font-display text-[clamp(6rem,30vw,9rem)] leading-none text-white drop-shadow">{o === 'O' ? '○' : '✕'}</span>
                  {selected && <span className="absolute right-3 top-3 rounded-full bg-white px-2 py-0.5 text-sm font-black text-slate-900">내 선택</span>}
                </button>
              );
            })}
          </div>

          <p className={`min-h-[3.5rem] rounded-2xl px-4 py-3 text-center text-lg font-bold
            ${mine ? (saved ? 'bg-emerald-500/15 text-emerald-200' : 'bg-amber-400/15 text-amber-100') : 'bg-white/5 text-white/70'}`}
          >
            {!view.alive
              ? (me?.role === 'SPECTATOR' ? '관전 중에는 응답할 수 없어요' : me?.role === 'CANDIDATE' ? '' : '응원단은 응답할 수 없어요 · 끝까지 함께 지켜봐요!')
              : mine
                ? `내 선택: ${mine} ${saved ? '✓ 서버 저장 완료' : '… 전송 중'}${view.phase === 'OPEN' ? ' (시간 안에 바꿀 수 있어요)' : ''}`
                : view.phase === 'OPEN' ? '아직 고르지 않았어요 — 미응답은 탈락!' : view.phase === 'READY' ? '사회자가 응답을 시작하면 버튼이 켜져요' : '이번 라운드는 응답하지 않았어요'}
          </p>
        </section>
      ) : (view.phase === 'REVEAL' || view.phase === 'VOID') && round ? (
        <section className="flex flex-1 flex-col items-center justify-center gap-5 py-4 text-center">
          <p className="text-lg font-bold text-white/60">ROUND {round.round_number} · 정답</p>
          <p className={`winner-pop font-display text-[clamp(7rem,40vw,11rem)] leading-none ${round.correct_answer === 'O' ? 'text-sky-300' : 'text-rose-300'}`}>
            {round.correct_answer === 'O' ? '○' : '✕'}
          </p>
          <p className={`font-display text-[clamp(2.2rem,11vw,3.5rem)] leading-tight
            ${view.phase === 'VOID' ? 'text-amber-300' : data?.verdict?.correct ? 'text-emerald-300' : data?.verdict ? 'text-slate-300' : 'text-white'}`}
          >
            {view.title}
          </p>
          <p className="text-xl font-black text-white/90">{view.message}</p>
          {data?.verdict && (
            <p className="rounded-full bg-white/10 px-5 py-2 text-lg font-bold">
              내 선택 <span className="font-display text-2xl">{data.verdict.selected ?? '미응답'}</span>
            </p>
          )}
          {line && view.phase === 'REVEAL' && (
            <p className="text-lg font-bold text-white/70">{line.survived} · {line.eliminated}명 탈락</p>
          )}
        </section>
      ) : view.phase === 'FINISHED' && game ? (
        <section className="flex flex-1 flex-col items-center justify-center gap-4 py-4 text-center">
          <p className={`winner-pop font-display text-[clamp(2.4rem,12vw,4rem)] leading-tight ${winner ? 'text-amber-300' : 'text-white'}`}>
            {view.title}
          </p>
          {winner && game.result === 'CHAMPION' && <p className="text-2xl font-black text-amber-100">최후의 1인!</p>}
          <ul className="flex flex-wrap justify-center gap-2">
            {(data?.winners ?? []).map((n) => (
              <li key={n} className={`rounded-2xl px-4 py-2 font-display text-[clamp(1.6rem,8vw,2.6rem)] ${n === me?.name ? 'bg-amber-400 text-amber-950' : 'bg-white/10 text-amber-200'}`}>
                🏆 {n}
              </li>
            ))}
          </ul>
          {me?.rank != null && !winner && <p className="text-xl font-black text-white/80">내 최종 순위 {me.rank}위 (ROUND {me.eliminated_round} 탈락)</p>}
          <p className="text-lg font-bold text-white/70">{view.message}</p>
        </section>
      ) : (
        <section className="flex flex-1 flex-col items-center justify-center gap-5 py-4 text-center">
          <p className="font-display text-[clamp(3rem,16vw,5rem)] leading-none text-white">
            <span className="text-sky-300">O</span> <span className="text-white/40">/</span> <span className="text-rose-300">X</span>
          </p>
          <p className="font-display text-[clamp(2rem,10vw,3rem)] leading-tight text-white">{view.title}</p>
          <p className="text-lg font-bold text-white/75">{view.message}</p>
          {view.phase === 'LOBBY' && (
            <div className="w-full rounded-3xl bg-white/5 p-5 text-base text-white/70 ring-1 ring-white/10">
              사회자가 문제를 말로 내면 <b className="text-sky-300">O</b> 또는 <b className="text-rose-300">X</b>를 눌러요.<br />
              틀리거나 시간 안에 못 고르면 탈락! 최후의 1인이 우승합니다.
            </div>
          )}
        </section>
      )}

      <footer className="space-y-2 text-center">
        <p className="text-base font-bold text-white/50">
          {game && game.current_round > 0 && counts ? `ROUND ${game.current_round} · 생존 ${counts.alive} / ${counts.initial ?? '-'}명` : ''}
          {!live.connected && <span className="text-rose-300"> · 재연결 중…</span>}
        </p>
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
