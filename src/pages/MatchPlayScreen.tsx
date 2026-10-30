import { useCallback, useEffect, useRef, useState } from 'react';
import { Confetti } from '../components/Confetti';
import { ConnectionBadge } from '../components/ConnectionBadge';
import { MatchFinalList } from '../components/MatchResults';
import { SoundToggle } from '../components/SoundToggle';
import { useLiveSync } from '../hooks/useLiveSync';
import { useAtServerTime, useServerNow } from '../hooks/useServerNow';
import { useSoundState } from '../hooks/useSound';
import { useWakeLock } from '../hooks/useWakeLock';
import { createSeq, deriveMatchView, finalFullyRevealed, formatPercent, optionText, verdictMessage } from '../lib/matchView';
import { serverClock } from '../lib/serverClock';
import { sfx, vibrate } from '../lib/sound';
import { RpcError, errorMessage, rpc } from '../lib/supabase';
import type { MatchAnswerResponse, MatchOption, MatchParticipantState, MatchQuestion, RoomMode, SyncSession } from '../lib/types';

class SessionEnded extends Error {}

type MatchFailure = { ok: false; error: 'INVALID_TOKEN' | 'KICKED' };
/** my latest tap on this opening of the question (a restarted question opens again) */
type LocalPick = { key: string; option: MatchOption; saved: boolean };

const pickKey = (q: MatchQuestion | null) => (q ? `${q.id}:${q.opened_ms}` : '');

export function MatchPlayScreen({ session, onLeave, onMode }: {
  session: SyncSession;
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
    const r = await rpc<MatchParticipantState | MatchFailure>('match_state', { p_token: session.token });
    if (!r.ok) throw new SessionEnded(r.error);
    serverClock.sample(t0, Date.now(), r.server_now_ms);
    return r;
  }, [session.token]);

  const live = useLiveSync<MatchParticipantState>({ roomId, fetcher, liveIntervalMs: 5000, tables: ['rooms', 'family_match_games'] });
  const data = live.data;
  const game = data?.game ?? null;
  const question = data?.question ?? null;

  useEffect(() => {
    if (data?.room.id) setRoomId(data.room.id);
  }, [data?.room.id]);
  useEffect(() => {
    if (data?.room.mode) onMode(data.room.mode);
  }, [data?.room.mode, onMode]);
  useEffect(() => {
    if (live.error instanceof SessionEnded) onLeave(live.error.message);
  }, [live.error, onLeave]);

  const open = game?.status === 'QUESTION_OPEN';
  const now = useServerNow(open, 250);
  // the server closes the question at the deadline; ask for the new state right after
  useAtServerTime(open ? question?.closes_ms : null, () => void live.refresh(), 400);

  const view = deriveMatchView({ room: data?.room ?? null, game, question, teamSize: data?.team.members.length ?? 0, now });
  const key = pickKey(question);
  const mine: MatchOption | null = local?.key === key ? local.option : data?.me.answer ?? null;
  const saved = local?.key === key ? local.saved : data?.me.answer != null;
  const myFinal = data?.final.find((t) => t.team_id === data.team.id) ?? null;

  // effects on server-confirmed transitions — never on the first load
  const prev = useRef<{ phase: string; key: string; reveal: string; finalRank: number | null } | null>(null);
  const revealKey = `${key}:${data?.reveal ? 'R' : ''}`;
  const finalRank = game?.final_revealed_rank ?? null;
  useEffect(() => {
    if (!data) return;
    const p = prev.current;
    prev.current = { phase: view.phase, key, reveal: revealKey, finalRank };
    if (!p) return;
    if (view.phase === 'OPEN' && (p.phase !== 'OPEN' || p.key !== key)) {
      sfx.start();
      vibrate(50);
      setFlash(true);
    } else if (view.phase === 'REVEAL' && revealKey !== p.reveal && data.reveal) {
      if (data.reveal.matched) {
        sfx.win();
        vibrate([80, 50, 80]);
        setCelebrate((c) => c + 1);
      } else sfx.reveal();
    } else if (view.phase === 'FINISHED' && finalRank !== p.finalRank && finalRank != null) {
      if (myFinal?.rank === 1) {
        sfx.win();
        vibrate([90, 60, 90, 60, 200]);
        setCelebrate((c) => c + 1);
      } else sfx.reveal();
    }
  }, [data, view.phase, key, revealKey, finalRank, myFinal?.rank]);

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

  const choose = async (option: MatchOption) => {
    if (!view.canAnswer || !question) return;
    const seq = nextSeq();
    latestSeq.current = seq;
    const k = key;
    setLocal({ key: k, option, saved: false });
    sfx.tap();
    vibrate(25);
    try {
      let res: MatchAnswerResponse | null = null;
      for (let attempt = 0; !res; attempt++) {
        try {
          // same seq on retry: the server stores it once, a newer tap always wins
          res = await rpc<MatchAnswerResponse>('match_answer', {
            p_token: session.token, p_question_id: question.id, p_option: option, p_seq: seq,
          });
        } catch (e) {
          if (!(e instanceof RpcError && e.network) || attempt >= 2) throw e;
          await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
        }
      }
      if (res.result === 'INVALID_TOKEN' || res.result === 'KICKED') return onLeave(res.result);
      if (latestSeq.current !== seq) return; // a newer tap is in flight and owns the screen
      switch (res.result) {
        case 'ACCEPTED':
        case 'STALE': {
          const stored = res.option ?? option;
          setLocal({ key: k, option: stored, saved: true });
          live.setData((d) => (d && d.question?.id === question.id ? { ...d, me: { answer: stored, seq } } : d));
          break;
        }
        case 'TOO_LATE':
        case 'CLOSED':
          setLocal(null);
          setToast(res.option ? `시간이 지나 바뀌지 않았어요 (제출된 답: ${res.option})` : '응답 시간이 지났어요');
          break;
        case 'NOT_OPEN':
          setLocal(null);
          setToast('아직 응답 시간이 아니에요');
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

  const leaveTeam = async () => {
    if (!window.confirm('이 팀에서 나가고 가족 닉네임을 다시 입력할까요?')) return;
    try {
      await rpc('sync_leave', { p_token: session.token });
      onLeave('LEFT');
    } catch (e) {
      setToast(errorMessage(e));
    }
  };

  const members = data?.team.members ?? [];
  const showQuestion = view.phase === 'READY' || view.phase === 'OPEN' || view.phase === 'CLOSED';
  const champion = view.phase === 'FINISHED' && finalFullyRevealed(game) && myFinal?.rank === 1;

  return (
    <main
      className={`stage relative flex min-h-dvh flex-col overflow-hidden px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[max(0.75rem,env(safe-area-inset-top))]
        ${champion ? 'stage-gold' : ''}`}
    >
      {celebrate > 0 && <Confetti key={celebrate} />}
      {flash && <div aria-hidden className="pointer-events-none fixed inset-0 z-30 flash-match" />}

      <header className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="font-display text-xl leading-tight tracking-wide text-pink-300">우리 가족 이구동성</p>
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

      {showQuestion && question && game ? (
        <section className="flex flex-1 flex-col gap-4 py-4">
          <div className="flex items-center justify-between">
            <span className="rounded-full bg-white/10 px-3 py-1 font-display text-xl">
              {question.question_number} <span className="text-white/50">/ {game.question_count}</span>
            </span>
            <span
              className={`rounded-full px-4 py-1 font-display text-2xl tabular-nums
                ${view.phase === 'OPEN' ? (view.remaining != null && view.remaining <= 5 ? 'bg-rose-500 text-white' : 'bg-pink-400/25 text-pink-100') : 'bg-white/10 text-white/60'}`}
            >
              {view.phase === 'OPEN' ? `⏱ ${view.remaining ?? '-'}초` : view.phase === 'READY' ? '준비' : '마감'}
            </span>
          </div>
          <div className="text-center">
            <p className="text-lg font-black text-amber-300">{question.story_title}</p>
            {question.story_text && <p className="mt-1 text-base text-white/70">{question.story_text}</p>}
            <p className="mt-2 text-[clamp(1.6rem,7vw,2.25rem)] font-black leading-snug text-white">{question.question_text}</p>
          </div>

          <div className="flex flex-1 flex-col justify-center gap-3">
            {(['A', 'B'] as const).map((o) => {
              const selected = mine === o;
              return (
                <button
                  key={o}
                  disabled={!view.canAnswer}
                  onClick={() => void choose(o)}
                  aria-pressed={selected}
                  className={`relative flex min-h-[6.5rem] w-full items-center gap-4 rounded-3xl px-5 py-4 text-left transition active:translate-y-1
                    disabled:cursor-not-allowed
                    ${o === 'A' ? 'bg-rose-500 shadow-[0_6px_0_#9f1239]' : 'bg-sky-500 shadow-[0_6px_0_#075985]'}
                    ${selected ? 'ring-4 ring-white' : mine ? 'opacity-45' : ''}
                    ${!view.canAnswer && !selected ? 'opacity-40' : ''}`}
                >
                  <span className="font-display text-5xl text-white/90">{o}</span>
                  <span className="min-w-0 flex-1 text-[clamp(1.25rem,6vw,1.75rem)] font-black leading-tight text-white">
                    {o === 'A' ? question.option_a : question.option_b}
                  </span>
                  {selected && <span className="text-3xl">✓</span>}
                </button>
              );
            })}
          </div>

          <p className={`min-h-[3.5rem] rounded-2xl px-4 py-3 text-center text-lg font-bold
            ${mine ? 'bg-emerald-500/15 text-emerald-200' : 'bg-white/5 text-white/70'}`}
          >
            {mine
              ? `내 선택: ${mine} · ${optionText(question, mine)} ${saved ? '✓ 제출 완료' : '… 전송 중'}${view.phase === 'OPEN' ? ' (시간 안에 바꿀 수 있어요)' : ''}`
              : view.phase === 'OPEN' ? '아직 고르지 않았어요' : view.phase === 'READY' ? '사회자가 응답을 시작하면 버튼이 켜져요' : '이번 문제는 응답하지 않았어요'}
          </p>
        </section>
      ) : view.phase === 'REVEAL' && data?.reveal && question ? (
        <section className="flex flex-1 flex-col items-center justify-center gap-4 py-4 text-center">
          <p className="text-base font-bold text-white/60">{question.question_number}번 · {question.question_text}</p>
          <p className={`winner-pop font-display text-[clamp(2.25rem,11vw,3.5rem)] leading-tight ${data.reveal.matched ? 'text-amber-300' : 'text-sky-200'}`}>
            {data.reveal.matched ? '일심동체 성공!' : '다음엔 통할 거예요!'}
          </p>
          <div className="grid w-full grid-cols-2 gap-3">
            {[
              { who: `${session.label} (나)`, o: data.reveal.mine },
              { who: data.reveal.partner?.label ?? members.find((m) => !m.me)?.label ?? '파트너', o: data.reveal.partner?.option ?? null },
            ].map((x, i) => (
              <div key={i} className={`rounded-3xl p-4 ring-1 ${x.o === 'A' ? 'bg-rose-500/25 ring-rose-300/50' : x.o === 'B' ? 'bg-sky-500/25 ring-sky-300/50' : 'bg-white/5 ring-white/10'}`}>
                <p className="truncate text-sm font-bold text-white/70">{x.who}</p>
                <p className="font-display text-5xl text-white">{x.o ?? '–'}</p>
                <p className="truncate text-sm font-bold text-white/80">{x.o ? optionText(question, x.o) : '미응답'}</p>
              </div>
            ))}
          </div>
          <p className="text-xl font-black text-white/90">{verdictMessage(data.reveal.matched, data.reveal.mine, data.reveal.partner?.option ?? null)}</p>
          <p className="rounded-full bg-white/10 px-5 py-2 text-lg font-black">
            이번 문제 <span className={data.reveal.points ? 'text-amber-300' : 'text-white/70'}>{data.reveal.points ? '+1점' : '0점'}</span>
            <span className="mx-2 text-white/30">|</span>
            누적 <span className="text-pink-200">{data.score}점</span>
          </p>
        </section>
      ) : view.phase === 'FINISHED' && game ? (
        <section className="flex flex-1 flex-col items-center gap-4 overflow-y-auto py-4 text-center">
          <div className={`w-full rounded-3xl p-5 ring-1 ${champion ? 'bg-amber-400/20 ring-amber-300/60' : 'bg-white/10 ring-white/15'}`}>
            <p className="text-lg font-bold text-white/70">우리 가족 최종 기록</p>
            <p className="font-display text-[clamp(2.5rem,12vw,4rem)] leading-tight text-amber-300">
              {myFinal ? `${myFinal.rank}위` : '두근두근…'}
            </p>
            <p className="text-2xl font-black text-pink-200">
              {data?.score ?? 0} / {game.total_questions ?? game.question_count} 일치
              <span className="ml-2 text-lg text-white/70">({formatPercent(myFinal?.match_percentage ?? (game.total_questions ? Math.round(((data?.score ?? 0) * 1000) / game.total_questions) / 10 : null))})</span>
            </p>
            {!myFinal && <p className="mt-2 text-base text-white/70">최종 순위를 발표하고 있어요</p>}
          </div>
          <MatchFinalList rows={data?.final ?? []} highlightTeamId={data?.team.id} />
        </section>
      ) : (
        <section className="flex flex-1 flex-col items-center justify-center gap-5 py-4 text-center">
          <p className={`font-display text-[clamp(2.25rem,11vw,3.5rem)] leading-tight ${view.phase === 'LOBBY' && members.length >= 2 ? 'text-emerald-300' : 'text-white'}`}>
            {view.title}
          </p>
          {game && view.phase !== 'ENDED' && (
            <div className="w-full rounded-3xl bg-white/5 p-5 ring-1 ring-white/10">
              <p className="text-sm font-bold text-white/60">오늘의 이야기</p>
              <p className="mt-1 text-2xl font-black text-pink-200">{game.title}</p>
              <p className="mt-2 text-base text-white/70">A와 B 중 하나를 골라요. 파트너와 같은 답이면 1점! (총 {game.question_count}문제)</p>
            </div>
          )}
        </section>
      )}

      <footer className="space-y-2 text-center">
        {view.message && !showQuestion && view.phase !== 'REVEAL' && <p className="text-xl font-bold text-white/85">{view.message}</p>}
        <p className="text-base font-bold text-white/50">
          {game && game.current_question > 0 ? `문항 ${game.current_question} / ${game.question_count}` : ''}
          {data ? ` · ${data.team_count}가족 참가` : ''}
          {!live.connected && <span className="text-rose-300"> · 재연결 중…</span>}
        </p>
        {view.phase === 'LOBBY' && (
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
