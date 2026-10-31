import { useCallback, useEffect, useState } from 'react';
import { useLiveSync } from '../hooks/useLiveSync';
import { useAtServerTime, useServerNow } from '../hooks/useServerNow';
import { OX_STATUS_LABEL, survivalLine } from '../lib/oxView';
import { timed } from '../lib/serverClock';
import { sfx } from '../lib/sound';
import { RpcError, errorMessage, rpc } from '../lib/supabase';
import type { OxAdminState, OxAnswer, OxAnswerResponse, OxGame, OxGameStatus, Room } from '../lib/types';

const STATUS_COLOR: Record<OxGameStatus, string> = {
  LOBBY: 'bg-slate-500',
  ROUND_READY: 'bg-emerald-500',
  ANSWERING: 'bg-sky-500 animate-pulse',
  ANSWER_CLOSED: 'bg-amber-500',
  RESULT_REVEALED: 'bg-violet-500',
  ROUND_VOID: 'bg-rose-600',
  FINISHED: 'bg-indigo-500',
};

type Action = 'START' | 'OPEN' | 'CLOSE' | 'REVEAL' | 'NEXT' | 'FINISH' | 'CO_WIN' | 'END' | 'NEW_GAME';
type Bot = { participant_id: string; nickname: string; token: string };

const isAuthError = (e: unknown) => e instanceof RpcError && e.code === 'ADMIN_AUTH_REQUIRED';

export function OxAdminPanel({ token, room, onAuthError, notify }: {
  token: string;
  room: Room;
  onAuthError: () => void;
  notify: (text: string, tone: 'error' | 'info') => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [fast, setFast] = useState(false);
  const [pick, setPick] = useState<OxAnswer | null>(null);
  const [limit, setLimit] = useState(10);
  const [showSplit, setShowSplit] = useState(false);
  const [bots, setBots] = useState<Bot[]>([]);
  const [botCount, setBotCount] = useState(10);
  const [botResult, setBotResult] = useState<string | null>(null);

  const fetcher = useCallback(
    () => timed(() => rpc<OxAdminState>('admin_ox_state', { p_admin_token: token, p_room_code: room.room_code })),
    [token, room.room_code],
  );
  const live = useLiveSync<OxAdminState>({
    roomId: room.id, fetcher, liveIntervalMs: fast ? 1000 : 3000, pollIntervalMs: 1000, tables: ['rooms', 'ox_games'],
  });
  const s = live.data;
  const game = s?.game ?? null;
  const r = s?.round ?? null;
  const status: OxGameStatus = game?.status ?? 'LOBBY';
  const answering = status === 'ANSWERING';

  // answers do not emit realtime events (by design): poll fast while answering is open
  useEffect(() => setFast(answering || status === 'LOBBY'), [answering, status]);
  useEffect(() => {
    if (isAuthError(live.error)) onAuthError();
  }, [live.error, onAuthError]);
  // turning test mode off deletes the bots on the server
  useEffect(() => {
    if (!room.test_mode) setBots([]);
  }, [room.test_mode]);
  // a new round starts with no answer picked
  useEffect(() => setPick(r?.correct_answer ?? null), [r?.id, r?.correct_answer]);
  useEffect(() => {
    if (game) setLimit(game.time_limit_seconds);
  }, [game?.time_limit_seconds]);

  const now = useServerNow(answering, 200);
  useAtServerTime(answering ? r?.deadline_ms : null, () => void live.refresh(), 300);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      if (isAuthError(e)) return onAuthError();
      notify(errorMessage(e), 'error');
    } finally {
      setBusy(null);
      void live.refresh();
    }
  };

  const act = (a: Action) =>
    run(a, async () => {
      const g = await rpc<OxGame>('admin_ox_action', {
        p_admin_token: token, p_room_id: room.id, p_game_id: game?.id ?? null, p_round_id: game?.current_round_id ?? null, p_action: a,
      });
      live.setData((d) => (d ? { ...d, game: g } : d));
      if (a === 'OPEN') sfx.start();
      if (a === 'REVEAL') sfx.reveal();
      if (a === 'FINISH' || a === 'CO_WIN') sfx.win();
    });

  const saveAnswer = () =>
    pick && r && run('ANSWER', async () => {
      await rpc('admin_ox_set_answer', { p_admin_token: token, p_room_id: room.id, p_round_id: r.id, p_answer: pick });
      notify(`정답 ${pick} 저장됨 (참가자에게는 비공개)`, 'info');
    });

  const saveLimit = () =>
    run('LIMIT', async () => {
      const v = Math.max(5, Math.min(30, Math.round(limit) || 10));
      await rpc('admin_ox_set_time_limit', { p_admin_token: token, p_room_id: room.id, p_seconds: v });
      notify(`제한 시간 ${v}초 (다음에 시작하는 라운드부터)`, 'info');
    });

  const answerBots = () =>
    run('BOTS', async () => {
      if (!r) return;
      let ok = 0;
      let other = 0;
      // bots are right about 70% of the time (the host's screen knows the answer)
      await Promise.all(
        bots.map(async (b) => {
          await new Promise((w) => setTimeout(w, Math.random() * 1500));
          const right = r.correct_answer ?? 'O';
          const a: OxAnswer = Math.random() < 0.7 ? right : right === 'O' ? 'X' : 'O';
          const res = await rpc<OxAnswerResponse>('ox_answer', { p_token: b.token, p_round_id: r.id, p_answer: a, p_seq: Date.now() }).catch(() => null);
          if (res?.result === 'ACCEPTED') ok++;
          else other++;
        }),
      );
      setBotResult(`봇 ${ok + other}명 → 접수 ${ok}건, 거절(탈락·관전 등) ${other}건`);
    });

  if (!s || !game) {
    return (
      <section className="mt-4 rounded-3xl bg-white/5 p-6 text-center text-white/70 ring-1 ring-white/10">
        {live.error ? errorMessage(live.error) : 'OX SURVIVAL 불러오는 중…'}
      </section>
    );
  }

  const c = s.counts;
  const roomOpen = room.status === 'OPEN';
  const remaining = answering && r?.deadline_ms != null ? Math.max(0, (r.deadline_ms - now) / 1000) : null;
  const decided = game.result != null;
  const can = (a: Action) => roomOpen && !busy && ({
    START: status === 'LOBBY',
    OPEN: status === 'ROUND_READY' && !!r?.answer_set,
    CLOSE: status === 'ANSWERING',
    REVEAL: status === 'ANSWER_CLOSED',
    NEXT: (status === 'RESULT_REVEALED' && !decided && c.alive >= 2) || (status === 'ROUND_VOID' && !decided),
    FINISH: status === 'RESULT_REVEALED' && game.result === 'CHAMPION',
    CO_WIN: (status === 'RESULT_REVEALED' || status === 'ROUND_VOID') && !decided && c.alive >= 2,
    END: status !== 'FINISHED' && status !== 'ANSWERING' && status !== 'LOBBY',
    NEW_GAME: status !== 'ANSWERING',
  } satisfies Record<Action, boolean>)[a];
  const nextStep: Action | null =
    status === 'LOBBY' ? 'START'
    : status === 'ROUND_READY' ? (r?.answer_set ? 'OPEN' : null)
    : status === 'ANSWERING' ? 'CLOSE'
    : status === 'ANSWER_CLOSED' ? 'REVEAL'
    : status === 'RESULT_REVEALED' ? (game.result === 'CHAMPION' ? 'FINISH' : 'NEXT')
    : status === 'ROUND_VOID' ? 'NEXT' : null;
  const hl = (a: Action) => (a === nextStep ? 'ring-4 ring-white/80' : '');

  const onlineCandidates = s.candidates.filter((p) => p.online);
  const line = survivalLine(r);
  const survivors = s.verdicts.filter((v) => v.correct);
  const dropped = s.verdicts.filter((v) => !v.correct);

  const start = () => {
    const offline = s.candidates.length - onlineCandidates.length;
    if (!window.confirm(`지금 접속 중인 ${onlineCandidates.length}명을 참가자로 확정하고 게임을 시작할까요?${offline ? `\n(접속이 끊긴 ${offline}명은 제외되고 관전만 할 수 있습니다)` : ''}\n시작 후 들어오는 사람은 관전만 할 수 있습니다.`)) return;
    void act('START');
  };

  return (
    <>
      {/* ---------- stage + controls ---------- */}
      <section className="mt-4 grid gap-4 lg:grid-cols-[1fr_22rem]">
        <div className="relative flex min-h-[24rem] flex-col items-center justify-center rounded-3xl bg-white/5 p-6 pt-16 text-center ring-1 ring-white/10">
          <div className="absolute left-5 top-4 flex flex-wrap items-center gap-3">
            <span className="font-display text-2xl text-white/80">{game.current_round > 0 ? `ROUND ${game.current_round}` : `게임 ${game.game_number}`}</span>
            <span className={`rounded-full px-3 py-1 text-sm font-black text-white ${STATUS_COLOR[status]}`}>{OX_STATUS_LABEL[status]}</span>
            {r && r.seq > 1 && <span className="text-xs text-white/40">진행 {r.seq}번째</span>}
          </div>
          <div className="absolute right-5 top-4 text-right text-sm text-white/70">
            {status === 'LOBBY'
              ? <>참가 예정 <b className="text-white">{onlineCandidates.length}</b>명 (전체 {s.candidates.length})</>
              : <>최초 {c.initial}명 · 생존 <b className="text-emerald-300">{c.alive}</b> · 탈락 <b className="text-slate-300">{c.eliminated}</b></>}
          </div>

          {status === 'LOBBY' && (
            <>
              <p className="font-display text-[clamp(2.5rem,6vw,4rem)] text-sky-300">OX SURVIVAL</p>
              <p className="mt-2 text-white/70">문제는 사회자가 말로 냅니다. 라운드마다 정답 O/X만 비공개로 저장하세요.</p>
              <p className="mt-1 text-white/60">'게임 시작'을 누르면 지금 접속 중인 참가자로 명단이 확정됩니다.</p>
            </>
          )}

          {status === 'ROUND_READY' && r && (
            <>
              <p className="font-display text-[clamp(2.5rem,6vw,4rem)]">ROUND {r.round_number}</p>
              <p className="text-lg font-bold text-white/70">이번 라운드 참가 {c.alive}명 · 제한 시간 {game.time_limit_seconds}초</p>
              <p className="mt-4 text-sm font-bold text-white/60">① 문제를 읽기 전에 정답을 고르고 저장하세요 (참가자·스크린 비공개)</p>
              <div className="mt-2 flex items-center gap-3">
                {(['O', 'X'] as const).map((o) => (
                  <button
                    key={o}
                    disabled={!!busy}
                    onClick={() => setPick(o)}
                    className={`h-24 w-24 rounded-3xl font-display text-6xl text-white transition
                      ${o === 'O' ? 'bg-sky-500' : 'bg-rose-500'} ${pick === o ? 'ring-4 ring-white' : 'opacity-40 hover:opacity-70'}`}
                  >
                    {o}
                  </button>
                ))}
                <button disabled={!pick || !!busy || pick === r.correct_answer} onClick={() => void saveAnswer()} className="btn btn-green px-5 py-4 text-xl">
                  정답 저장
                </button>
              </div>
              <p className={`mt-3 text-lg font-black ${r.answer_set ? 'text-emerald-300' : 'text-amber-300'}`}>
                {r.answer_set ? `저장된 정답: ${r.correct_answer} — ② 문제를 읽고 '응답 시작'` : '정답이 저장되지 않아 응답을 시작할 수 없습니다'}
                {r.answer_set && pick && pick !== r.correct_answer && <span className="block text-sm text-amber-300">선택을 바꿨습니다. 다시 저장해야 반영됩니다.</span>}
              </p>
            </>
          )}

          {answering && r && (
            <>
              <p className="text-lg font-bold text-white/60">ROUND {r.round_number} · 정답 {r.correct_answer} (사회자만 보임)</p>
              <p className={`font-display text-7xl tabular-nums ${remaining != null && remaining <= 3 ? 'text-rose-400' : 'text-white'}`}>
                {remaining != null ? `${remaining.toFixed(1)}초` : '-'}
              </p>
              <p className="mt-3 rounded-full bg-white/10 px-5 py-2 text-xl font-black">
                응답 완료 <span className="text-sky-300">{c.answered}</span> / {c.alive}명
                <span className="ml-2 text-base text-white/60">(미응답 {Math.max(0, c.alive - c.answered)}명)</span>
              </p>
              <label className="mt-3 flex items-center gap-2 text-sm font-bold text-white/70">
                <input type="checkbox" checked={showSplit} onChange={(e) => setShowSplit(e.target.checked)} className="h-4 w-4 accent-sky-500" />
                O/X 선택 분포 보기 (사회자 화면만)
              </label>
              {showSplit && <SplitBar o={c.o ?? 0} x={c.x ?? 0} />}
            </>
          )}

          {status === 'ANSWER_CLOSED' && r && (
            <>
              <p className="font-display text-5xl text-amber-300">응답 마감</p>
              <p className="mt-2 text-xl font-bold">응답 {c.answered} / {c.alive}명 · 미응답 {Math.max(0, c.alive - c.answered)}명</p>
              <SplitBar o={c.o ?? 0} x={c.x ?? 0} />
              <p className="mt-3 text-lg font-black text-white/80">저장된 정답 <span className="font-display text-3xl">{r.correct_answer}</span> · 공개 버튼을 누르면 채점·탈락이 확정됩니다</p>
            </>
          )}

          {(status === 'RESULT_REVEALED' || status === 'ROUND_VOID') && r && (
            <>
              <p className="font-display text-5xl">정답 <span className={r.correct_answer === 'O' ? 'text-sky-300' : 'text-rose-300'}>{r.correct_answer}</span></p>
              {status === 'ROUND_VOID' ? (
                <p className="mt-3 rounded-2xl bg-rose-600/30 px-5 py-3 text-2xl font-black text-rose-100 ring-1 ring-rose-400/50">
                  전원 오답 — 재경기 필요 <span className="block text-base font-bold text-white/70">아무도 탈락하지 않았습니다. 생존자 {c.alive}명 그대로 ROUND {r.round_number}을(를) 다시 진행합니다.</span>
                </p>
              ) : (
                <div className="mt-3 grid w-full max-w-xl grid-cols-2 gap-2 text-lg font-black sm:grid-cols-4">
                  <Stat label="이번 라운드 참가" value={r.survivors_before} />
                  <Stat label="정답자" value={r.correct_count} tone="text-emerald-300" />
                  <Stat label="탈락자" value={line?.eliminated ?? null} tone="text-slate-300" />
                  <Stat label="현재 생존" value={c.alive} tone="text-amber-300" />
                </div>
              )}
              {game.result === 'CHAMPION' && <p className="mt-3 text-2xl font-black text-amber-300">👑 최후의 1인 확정: {survivors[0]?.name} — '우승자 발표'를 누르세요</p>}
              {status === 'RESULT_REVEALED' && !decided && c.alive >= 2 && <p className="mt-3 text-white/70">생존자 {c.alive}명 · 다음 라운드를 진행하거나 공동 우승으로 확정하세요</p>}
              {status === 'RESULT_REVEALED' && (
                <div className="mt-3 grid w-full gap-2 text-left text-sm sm:grid-cols-2">
                  <NameList title={`생존 ${survivors.length}명`} names={survivors.map((v) => v.name)} tone="text-emerald-200" />
                  <NameList title={`탈락 ${dropped.length}명`} names={dropped.map((v) => `${v.name}${v.selected ? '' : ' (미응답)'}`)} tone="text-white/60" />
                </div>
              )}
            </>
          )}

          {status === 'FINISHED' && (
            <>
              <p className="font-display text-[clamp(2.5rem,6vw,4rem)] text-amber-300">
                {game.result === 'CHAMPION' ? 'CHAMPION' : game.result === 'CO_WINNERS' ? '공동 우승' : '게임 종료'}
              </p>
              <p className="mt-2 text-2xl font-black">{s.ranking.filter((x) => x.status === 'ALIVE').map((x) => x.name).join(', ') || '-'}</p>
              <p className="mt-1 text-white/60">최초 {c.initial ?? 0}명 · {game.current_round}라운드</p>
            </>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <button disabled={!can('START')} onClick={start} className={`btn btn-green py-4 text-xl ${hl('START')}`}>
            참가자 확정 · 게임 시작 {status === 'LOBBY' && `(${onlineCandidates.length}명)`}
          </button>
          <button disabled={!can('OPEN')} onClick={() => act('OPEN')} className={`btn btn-red py-5 text-2xl ${hl('OPEN')}`}>
            응답 시작 ({game.time_limit_seconds}초)
          </button>
          <button disabled={!can('CLOSE')} onClick={() => window.confirm('지금 응답을 마감할까요?') && act('CLOSE')} className={`btn btn-ghost py-3 ${hl('CLOSE')}`}>
            응답 마감
          </button>
          <button
            disabled={!can('REVEAL')}
            onClick={() => window.confirm(`정답 ${r?.correct_answer}로 채점하고 결과를 공개할까요?\n오답·미응답 참가자는 탈락이 확정됩니다.`) && act('REVEAL')}
            className={`btn btn-amber py-4 text-xl ${hl('REVEAL')}`}
          >
            정답 공개 및 결과 확정
          </button>
          <button disabled={!can('NEXT')} onClick={() => act('NEXT')} className={`btn btn-blue py-4 text-xl ${hl('NEXT')}`}>
            {status === 'ROUND_VOID' ? `재경기 (ROUND ${game.current_round} 다시) ▶` : '다음 라운드 ▶'}
          </button>
          <button disabled={!can('FINISH')} onClick={() => act('FINISH')} className={`btn btn-amber py-4 text-xl ${hl('FINISH')}`}>
            👑 우승자 발표
          </button>
          <button
            disabled={!can('CO_WIN')}
            onClick={() => window.confirm(`생존자 ${c.alive}명을 공동 우승으로 확정하고 게임을 끝낼까요?`) && act('CO_WIN')}
            className="btn btn-ghost py-3 text-amber-200"
          >
            공동 우승 확정 ({c.alive}명)
          </button>
          <button
            disabled={!can('END')}
            onClick={() => window.confirm('게임을 여기서 끝낼까요? 지금 생존자가 최종 생존자로 표시됩니다.') && act('END')}
            className="btn btn-ghost py-2 text-sm text-rose-300"
          >
            게임 종료
          </button>
          <button
            disabled={!can('NEW_GAME')}
            onClick={() => window.confirm('새 OX 게임을 만들까요? (참가자 명단을 다시 확정합니다. 지금 게임 기록은 아래 "게임 기록"에 보관됩니다)') && act('NEW_GAME')}
            className="btn btn-ghost py-2 text-sm text-rose-300"
          >
            게임 초기화 (새 게임)
          </button>
          <div className="flex items-center gap-2 rounded-2xl bg-white/5 px-4 py-3 text-sm font-bold ring-1 ring-white/10">
            <span>응답 제한 시간</span>
            <input
              type="number" min={5} max={30} value={limit} disabled={answering}
              onChange={(e) => setLimit(Number(e.target.value))}
              className="w-16 rounded-lg border border-white/15 bg-white/10 px-2 py-1 text-white"
            />
            <span>초</span>
            <button disabled={!!busy || answering || limit === game.time_limit_seconds} onClick={() => void saveLimit()} className="btn btn-ghost ml-auto px-3 py-1 text-xs">적용</button>
          </div>
        </div>
      </section>

      {/* ---------- players ---------- */}
      <section className="mt-4 grid gap-4 lg:grid-cols-2">
        <div className="rounded-3xl bg-white/5 p-4 ring-1 ring-white/10">
          {status === 'LOBBY' ? (
            <>
              <h2 className="mb-3 text-lg font-black">참가 예정자 ({onlineCandidates.length}명 접속 중 / 전체 {s.candidates.length})</h2>
              <ul className="grid max-h-[28rem] grid-cols-1 gap-1.5 overflow-auto sm:grid-cols-2">
                {s.candidates.length === 0 && <li className="text-white/50">QR 코드로 참가자를 기다리는 중… (퀴즈 부저 닉네임·가족 팀원 모두 참가 가능)</li>}
                {s.candidates.map((p) => (
                  <li key={p.participant_id} className={`flex items-center gap-2 rounded-xl bg-white/5 px-3 py-2 ${p.online ? '' : 'opacity-50'}`}>
                    <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${p.online ? 'bg-emerald-400' : 'bg-slate-500'}`} title={p.online ? '접속 중' : '접속 끊김 (시작 시 제외)'} />
                    <span className={`min-w-0 flex-1 truncate font-bold ${p.is_test ? 'text-violet-300' : ''}`}>{p.name}</span>
                    {p.kind === 'SYNC' && <span className="text-xs text-cyan-300">가족</span>}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <>
              <h2 className="mb-3 text-lg font-black">
                참가자 ({s.players.length}) <span className="text-sm font-bold text-white/50">{answering ? '· 응답 중에는 선택을 숨깁니다' : ''}</span>
              </h2>
              <ul className="grid max-h-[28rem] grid-cols-1 gap-1.5 overflow-auto sm:grid-cols-2">
                {s.players.map((p) => (
                  <li key={p.participant_id} className={`flex items-center gap-2 rounded-xl px-3 py-2 ${p.status === 'ALIVE' ? 'bg-emerald-500/10' : 'bg-white/5 opacity-60'}`}>
                    <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${p.online ? 'bg-emerald-400' : 'bg-slate-500'}`} title={p.online ? '접속 중' : '응답 없음'} />
                    <span className={`min-w-0 flex-1 truncate font-bold ${p.is_test ? 'text-violet-300' : ''}`}>{p.name}</span>
                    {p.status === 'ALIVE' && (answering || status === 'ANSWER_CLOSED') && (
                      <span className={`rounded-full px-2 text-xs font-black ${p.answered ? 'bg-sky-500/30 text-sky-100' : 'bg-white/10 text-white/50'}`}>
                        {p.selected ?? (p.answered ? '응답 ✓' : '미응답')}
                      </span>
                    )}
                    <span className={`text-xs font-bold ${p.status === 'ALIVE' ? 'text-emerald-300' : 'text-white/50'}`}>
                      {p.status === 'ALIVE' ? '생존' : `R${p.eliminated_round} 탈락`}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        <div className="rounded-3xl bg-white/5 p-4 ring-1 ring-white/10">
          <h2 className="mb-3 text-lg font-black">라운드 기록 ({s.rounds.length})</h2>
          {s.rounds.length === 0 ? (
            <p className="text-white/50">게임을 시작하면 라운드마다 정답·생존자 수가 기록됩니다.</p>
          ) : (
            <div className="max-h-[28rem] overflow-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-white/50">
                  <tr><th className="py-1">라운드</th><th>정답</th><th className="text-center">O/X</th><th className="text-center">생존</th><th>탈락자</th></tr>
                </thead>
                <tbody>
                  {s.rounds.map((x) => (
                    <tr key={x.id} className="border-t border-white/5 align-top">
                      <td className="py-2 font-bold">
                        R{x.round_number}
                        {x.status === 'VOID' && <span className="ml-1 rounded bg-rose-600/40 px-1 text-xs">무효</span>}
                        {x.status !== 'REVEALED' && x.status !== 'VOID' && <span className="ml-1 text-xs text-white/50">진행 중</span>}
                      </td>
                      <td className="font-display text-lg">{x.correct_answer ?? '-'}</td>
                      <td className="text-center text-white/70">{x.o_count != null ? `${x.o_count}/${x.x_count}` : '-'}</td>
                      <td className="text-center font-bold">{x.survivors_after != null ? `${x.survivors_before}→${x.survivors_after}` : x.survivors_before ?? '-'}</td>
                      <td className="text-white/60">{x.eliminated_names.length ? x.eliminated_names.join(', ') : x.status === 'VOID' ? '(없음 · 무효)' : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {/* ---------- ranking, games, test bots ---------- */}
      <section className="mt-4 grid gap-4 lg:grid-cols-2">
        <div className="rounded-3xl bg-white/5 p-4 ring-1 ring-white/10">
          <h2 className="mb-3 text-lg font-black">순위 <span className="text-sm font-bold text-white/50">(생존자 1위 · 늦게 탈락할수록 높은 순위 · 같은 라운드 탈락 = 공동 순위)</span></h2>
          {s.ranking.length > 0 ? (
            <ol className="grid max-h-60 gap-1 overflow-auto sm:grid-cols-2">
              {s.ranking.map((x) => (
                <li key={x.participant_id} className="flex items-center gap-2 rounded-xl bg-white/5 px-3 py-1.5 text-sm">
                  <span className="w-10 font-display text-amber-300">{x.rank}위</span>
                  <span className="min-w-0 flex-1 truncate font-bold">{x.name}</span>
                  <span className="text-xs text-white/50">{x.status === 'ALIVE' ? '생존' : `R${x.eliminated_round}`}</span>
                </li>
              ))}
            </ol>
          ) : <p className="text-white/50">아직 시작 전입니다.</p>}
          <h3 className="mb-2 mt-4 font-black">게임 기록</h3>
          <table className="w-full text-left text-sm">
            <thead className="text-white/50"><tr><th className="py-1">게임</th><th>라운드</th><th>우승</th><th>상태</th></tr></thead>
            <tbody>
              {s.games.map((g) => (
                <tr key={g.id} className="border-t border-white/5">
                  <td className="py-2 font-bold">{g.game_number}</td>
                  <td className="text-white/70">{g.current_round} (최초 {g.initial_participant_count ?? '-'}명)</td>
                  <td className="font-bold text-amber-200">{g.winners.join(', ') || <span className="text-white/40">-</span>}</td>
                  <td className="text-white/60">{g.id === game.id ? OX_STATUS_LABEL[g.status] : g.status === 'FINISHED' ? '종료' : '중단'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {room.test_mode ? (
          <div className="rounded-3xl bg-violet-500/10 p-4 ring-1 ring-violet-400/30">
            <h2 className="text-lg font-black">OX 테스트 봇</h2>
            <p className="mt-1 text-sm text-white/60">게임 시작 전에 봇을 추가하면 참가자로 확정됩니다. 봇은 실제 ox_answer 경로로 약 70% 확률로 정답을 고릅니다. 테스트 모드를 끄면 삭제됩니다.</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <input
                type="number" min={1} max={30} value={botCount}
                onChange={(e) => setBotCount(Math.max(1, Math.min(30, Number(e.target.value) || 1)))}
                className="w-20 rounded-xl bg-white/10 px-3 py-2 text-white"
              />
              <button
                disabled={!!busy}
                onClick={() =>
                  run('ADDBOTS', async () => {
                    const added = await rpc<Bot[]>('admin_add_test_bots', { p_admin_token: token, p_room_id: room.id, p_count: botCount });
                    setBots((b) => [...b, ...added]);
                  })
                }
                className="btn btn-ghost"
              >
                봇 추가
              </button>
              <button disabled={!!busy || bots.length === 0 || !answering} onClick={() => void answerBots()} className="btn btn-red">
                봇 {bots.length}명 응답
              </button>
            </div>
            {bots.length === 0 && s.players.some((p) => p.is_test) && (
              <p className="mt-2 text-xs text-white/50">새로고침 전에 만든 봇은 토큰이 없어 응답할 수 없습니다.</p>
            )}
            {botResult && <p className="mt-2 font-bold text-violet-200">{botResult}</p>}
          </div>
        ) : (
          <div className="rounded-3xl bg-white/5 p-4 text-sm text-white/60 ring-1 ring-white/10">
            <h2 className="mb-2 text-lg font-black text-white">진행 순서</h2>
            <ol className="list-decimal space-y-1 pl-5">
              <li>참가자 확정 · 게임 시작 → ROUND 1 준비</li>
              <li>정답 O/X 선택 후 '정답 저장' (응답 시작 전까지만 변경 가능)</li>
              <li>문제를 말로 읽고 '응답 시작' → 제한 시간 후 자동 마감 (또는 '응답 마감')</li>
              <li>'정답 공개 및 결과 확정' → 오답·미응답 탈락</li>
              <li>'다음 라운드' 반복. 1명 남으면 '우승자 발표', 여러 명이면 계속하거나 '공동 우승 확정'</li>
              <li>전원 오답이면 라운드 무효 → '재경기'</li>
            </ol>
          </div>
        )}
      </section>
    </>
  );
}

function Stat({ label, value, tone = 'text-white' }: { label: string; value: number | null; tone?: string }) {
  return (
    <div className="rounded-2xl bg-white/5 px-3 py-2 ring-1 ring-white/10">
      <p className="text-xs font-bold text-white/60">{label}</p>
      <p className={`font-display text-3xl ${tone}`}>{value ?? '-'}</p>
    </div>
  );
}

function SplitBar({ o, x }: { o: number; x: number }) {
  const total = o + x;
  return (
    <div className="mt-2 w-full max-w-md">
      <div className="flex h-8 overflow-hidden rounded-full bg-white/10 text-sm font-black">
        {total > 0 && <div className="flex items-center justify-center bg-sky-500" style={{ width: `${(o / total) * 100}%` }}>{o > 0 && `O ${o}`}</div>}
        {total > 0 && <div className="flex items-center justify-center bg-rose-500" style={{ width: `${(x / total) * 100}%` }}>{x > 0 && `X ${x}`}</div>}
      </div>
      <p className="mt-1 text-xs text-white/50">O {o}명 · X {x}명</p>
    </div>
  );
}

function NameList({ title, names, tone }: { title: string; names: string[]; tone: string }) {
  return (
    <div className="rounded-2xl bg-white/5 p-3 ring-1 ring-white/10">
      <p className="font-black">{title}</p>
      <p className={`mt-1 max-h-32 overflow-auto ${tone}`}>{names.join(', ') || '-'}</p>
    </div>
  );
}
