import { useCallback, useEffect, useRef, useState } from 'react';
import { Confetti } from '../components/Confetti';
import { OptionBadge } from '../components/MatchResults';
import { useLiveSync } from '../hooks/useLiveSync';
import { useAtServerTime, useServerNow } from '../hooks/useServerNow';
import { downloadCsv, matchFinalToCsv, matchVerdictsToCsv } from '../lib/csv';
import { GAME_STATUS_LABEL, MATCH_IMAGES, QUESTION_LIMITS, finalFullyRevealed, finalTies, formatPercent, toDraft, validateDraft } from '../lib/matchView';
import { timed } from '../lib/serverClock';
import { sfx } from '../lib/sound';
import { RpcError, errorMessage, rpc } from '../lib/supabase';
import type { MatchAdminState, MatchAnswerResponse, MatchGame, MatchGameStatus, MatchQuestionDraft, Room } from '../lib/types';

const STATUS_COLOR: Record<MatchGameStatus, string> = {
  LOBBY: 'bg-slate-500',
  QUESTION_READY: 'bg-emerald-500',
  QUESTION_OPEN: 'bg-pink-500 animate-pulse',
  QUESTION_CLOSED: 'bg-amber-500',
  RESULT_REVEAL: 'bg-violet-500',
  GAME_FINISHED: 'bg-indigo-500',
};

type Action = 'PREPARE' | 'OPEN' | 'CLOSE' | 'REVEAL' | 'NEXT' | 'RESTART' | 'FINISH' | 'REVEAL_FINAL_NEXT' | 'REVEAL_FINAL_ALL' | 'NEW_GAME';
type BotTeam = { team_id: string; team_name: string; members: Array<{ participant_id: string; token: string }> };

const isAuthError = (e: unknown) => e instanceof RpcError && e.code === 'ADMIN_AUTH_REQUIRED';

export function MatchAdminPanel({ token, room, onAuthError, notify, onRoom }: {
  token: string;
  room: Room;
  onAuthError: () => void;
  notify: (text: string, tone: 'error' | 'info') => void;
  onRoom: (room: Room) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [fast, setFast] = useState(false);
  const [bots, setBots] = useState<BotTeam[]>([]);
  const [botCount, setBotCount] = useState(5);
  const [botResult, setBotResult] = useState<string | null>(null);
  const [celebrate, setCelebrate] = useState(0);

  const fetcher = useCallback(
    () => timed(() => rpc<MatchAdminState>('admin_match_state', { p_admin_token: token, p_room_code: room.room_code })),
    [token, room.room_code],
  );
  const live = useLiveSync<MatchAdminState>({
    roomId: room.id, fetcher, liveIntervalMs: fast ? 1000 : 3000, pollIntervalMs: 1000, tables: ['rooms', 'family_match_games'],
  });
  const s = live.data;
  const game = s?.game ?? null;
  const q = s?.question ?? null;
  const status: MatchGameStatus = game?.status ?? 'LOBBY';
  const open = status === 'QUESTION_OPEN';

  // answers do not emit realtime events (by design): poll fast while answering is open
  useEffect(() => setFast(open), [open]);
  useEffect(() => {
    if (isAuthError(live.error)) onAuthError();
  }, [live.error, onAuthError]);
  // turning test mode off deletes the bots on the server
  useEffect(() => {
    if (!room.test_mode) setBots([]);
  }, [room.test_mode]);

  const now = useServerNow(open, 200);
  useAtServerTime(open ? q?.closes_ms : null, () => void live.refresh(), 300);

  const prevFinal = useRef<string | null>(null);
  const finalKey = `${game?.id}:${game?.final_revealed_rank ?? ''}`;
  useEffect(() => {
    if (!s) return;
    if (prevFinal.current !== null && finalKey !== prevFinal.current && game?.final_revealed_rank === 1) setCelebrate((c) => c + 1);
    prevFinal.current = finalKey;
  }, [s, finalKey, game?.final_revealed_rank]);

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
      const g = await rpc<MatchGame>('admin_match_action', {
        p_admin_token: token, p_room_id: room.id, p_game_id: game?.id ?? null,
        p_expected_question: game?.current_question ?? 0, p_action: a,
      });
      live.setData((d) => (d ? { ...d, game: g } : d));
      if (a === 'OPEN') sfx.start();
      if (a === 'REVEAL' || a === 'REVEAL_FINAL_NEXT' || a === 'REVEAL_FINAL_ALL') g.final_revealed_rank === 1 ? sfx.win() : sfx.reveal();
    });

  const teams = s?.teams ?? [];

  const openQuestion = () => {
    const solo = teams.filter((t) => t.members.length < 2).map((t) => t.team_name);
    const offline = teams.flatMap((t) => t.members.filter((m) => !m.online && !m.is_test).map((m) => `${t.team_name} ${m.label}`));
    const warnings = [
      teams.length === 0 && '아직 입장한 가족이 없습니다.',
      solo.length > 0 && `한 명만 들어온 가족 ${solo.length}팀: ${solo.slice(0, 6).join(', ')}${solo.length > 6 ? ' …' : ''} (이 가족은 0점)`,
      offline.length > 0 && `응답이 없는 참가자 ${offline.length}명: ${offline.slice(0, 6).join(', ')}${offline.length > 6 ? ' …' : ''}`,
    ].filter(Boolean);
    if (warnings.length && !window.confirm(`${warnings.join('\n')}\n\n그래도 응답을 시작할까요?`)) return;
    void act('OPEN');
  };

  const answerBots = () =>
    run('BOTS', async () => {
      if (!q) return;
      let ok = 0;
      let other = 0;
      await Promise.all(
        bots.map(async (t) => {
          // bot families agree about 60% of the time
          const first = Math.random() < 0.5 ? 'A' : 'B';
          const second = Math.random() < 0.6 ? first : first === 'A' ? 'B' : 'A';
          await Promise.all(
            t.members.map(async (m, i) => {
              await new Promise((r) => setTimeout(r, Math.random() * 1500));
              const res = await rpc<MatchAnswerResponse>('match_answer', {
                p_token: m.token, p_question_id: q.id, p_option: i === 0 ? first : second, p_seq: Date.now(),
              }).catch(() => null);
              if (res?.result === 'ACCEPTED') ok++;
              else other++;
            }),
          );
        }),
      );
      setBotResult(`봇 ${ok + other}명 응답 → 접수 ${ok}건, 거절/오류 ${other}건`);
    });

  if (!s || !game) {
    return (
      <section className="mt-4 rounded-3xl bg-white/5 p-6 text-center text-white/70 ring-1 ring-white/10">
        {live.error ? errorMessage(live.error) : '가족 이구동성 불러오는 중…'}
      </section>
    );
  }

  const roomOpen = room.status === 'OPEN';
  const last = game.current_question >= game.question_count;
  const remaining = open && q?.closes_ms != null ? Math.max(0, (q.closes_ms - now) / 1000) : null;
  const ties = status === 'GAME_FINISHED' ? finalTies(s.final) : [];
  const finalAll = finalFullyRevealed(game);
  const memberCount = teams.reduce((n, t) => n + t.members.length, 0);
  const onlineCount = teams.reduce((n, t) => n + t.members.filter((m) => m.online).length, 0);
  const can = (a: Action) => roomOpen && !busy && ({
    PREPARE: status === 'LOBBY',
    OPEN: status === 'QUESTION_READY',
    CLOSE: status === 'QUESTION_OPEN',
    REVEAL: status === 'QUESTION_CLOSED',
    NEXT: (status === 'QUESTION_CLOSED' || status === 'RESULT_REVEAL') && !last,
    FINISH: (status === 'QUESTION_CLOSED' || status === 'RESULT_REVEAL') && last,
    RESTART: status === 'QUESTION_OPEN' || status === 'QUESTION_CLOSED' || status === 'RESULT_REVEAL',
    REVEAL_FINAL_NEXT: status === 'GAME_FINISHED' && !finalAll,
    REVEAL_FINAL_ALL: status === 'GAME_FINISHED' && !finalAll,
    NEW_GAME: status !== 'QUESTION_OPEN',
  } satisfies Record<Action, boolean>)[a];
  // the one button the host most likely wants next
  const nextStep: Action | null =
    status === 'LOBBY' ? 'PREPARE'
    : status === 'QUESTION_READY' ? 'OPEN'
    : status === 'QUESTION_OPEN' ? 'CLOSE'
    : status === 'QUESTION_CLOSED' ? 'REVEAL'
    : status === 'RESULT_REVEAL' ? (last ? 'FINISH' : 'NEXT')
    : !finalAll ? 'REVEAL_FINAL_NEXT' : null;
  const hl = (a: Action) => (a === nextStep ? 'ring-4 ring-white/80' : '');

  return (
    <>
      {celebrate > 0 && <Confetti key={celebrate} count={120} />}

      {/* ---------- stage + controls ---------- */}
      <section className="mt-4 grid gap-4 lg:grid-cols-[1fr_22rem]">
        <div className="relative flex min-h-[24rem] flex-col items-center justify-center rounded-3xl bg-white/5 p-6 pt-16 text-center ring-1 ring-white/10">
          <div className="absolute left-5 top-4 flex flex-wrap items-center gap-3">
            <span className="font-display text-2xl text-white/80">
              {game.current_question > 0 ? `문항 ${game.current_question} / ${game.question_count}` : `게임 ${game.game_number}`}
            </span>
            <span className={`rounded-full px-3 py-1 text-sm font-black text-white ${STATUS_COLOR[status]}`}>{GAME_STATUS_LABEL[status]}</span>
          </div>
          <div className="absolute right-5 top-4 text-right text-sm text-white/60">
            {teams.length}가족 · {memberCount}명 (접속 {onlineCount})
          </div>

          {status === 'LOBBY' && (
            <>
              <p className="text-white/60">게임 {game.game_number} · {game.question_count}문항</p>
              <p className="font-display text-[clamp(2rem,5vw,3.5rem)] text-pink-200">{game.title}</p>
              <p className="mt-2 text-white/70">가족들이 입장하면 '문제 준비'로 1번 문제를 띄우세요. 아래에서 문항을 수정할 수 있습니다.</p>
            </>
          )}

          {q && status !== 'LOBBY' && status !== 'GAME_FINISHED' && (
            <>
              <p className="text-lg font-black text-amber-300">Q{q.question_number}. {q.story_title}</p>
              {q.story_text && <p className="text-white/70">{q.story_text}</p>}
              <p className="mt-1 font-display text-[clamp(1.75rem,4vw,3rem)] leading-tight">{q.question_text}</p>
              <div className="mt-3 flex flex-wrap justify-center gap-2 text-lg font-black">
                <span className="rounded-2xl bg-rose-500 px-4 py-2">A {q.option_a}</span>
                <span className="rounded-2xl bg-sky-500 px-4 py-2">B {q.option_b}</span>
              </div>
              {open && (
                <p className={`mt-4 font-display text-6xl tabular-nums ${remaining != null && remaining <= 5 ? 'text-rose-400' : 'text-white'}`}>
                  {remaining != null ? `${remaining.toFixed(1)}초` : '-'}
                </p>
              )}
              {status === 'QUESTION_READY' && <p className="mt-4 text-xl font-bold text-emerald-300">제한 시간 {q.duration_seconds}초 · '응답 시작'을 누르면 타이머가 시작됩니다</p>}
              {status === 'QUESTION_CLOSED' && <p className="mt-4 text-2xl font-black text-amber-300">응답 마감 · 판정 완료 (아직 참가자에게 비공개)</p>}
              {status === 'RESULT_REVEAL' && <p className="mt-4 text-2xl font-black text-violet-200">결과 공개됨 · 일치 {s.results.filter((r) => r.matched).length}가족</p>}
              {status !== 'QUESTION_READY' && (
                <p className="mt-3 rounded-full bg-white/10 px-5 py-2 text-xl font-black">
                  응답 완료 가족 <span className="text-pink-300">{s.progress.answered_teams}</span> / {s.progress.team_count}
                  <span className="ml-2 text-base text-white/60">(응답 {s.progress.answered_people}명)</span>
                </p>
              )}
            </>
          )}

          {status === 'GAME_FINISHED' && (
            <>
              <p className="font-display text-[clamp(2.5rem,6vw,4.5rem)] text-indigo-200">게임 종료</p>
              <p className="text-xl font-bold text-white/75">
                {game.final_revealed_rank == null ? '최종 순위 비공개 · "다음 순위 공개"로 3위부터 발표하세요'
                  : finalAll ? '최종 순위 전체 공개됨' : `${game.final_revealed_rank}위까지 공개`}
              </p>
              <p className="mt-1 text-white/60">전체 {game.total_questions}문항 기준</p>
            </>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <button disabled={!can('PREPARE')} onClick={() => act('PREPARE')} className={`btn btn-green py-3 text-xl ${hl('PREPARE')}`}>문제 준비 (1번)</button>
          <button disabled={!can('OPEN')} onClick={openQuestion} className={`btn btn-red py-5 text-2xl ${hl('OPEN')}`}>
            응답 시작{q && status === 'QUESTION_READY' ? ` (${q.duration_seconds}초)` : ''}
          </button>
          <button disabled={!can('CLOSE')} onClick={() => window.confirm('지금 응답을 마감할까요?') && act('CLOSE')} className={`btn btn-ghost py-3 ${hl('CLOSE')}`}>
            응답 조기 마감
          </button>
          <button disabled={!can('REVEAL')} onClick={() => act('REVEAL')} className={`btn btn-amber py-4 text-xl ${hl('REVEAL')}`}>결과 공개</button>
          <button disabled={!can('NEXT')} onClick={() => act('NEXT')} className={`btn btn-blue py-4 text-xl ${hl('NEXT')}`}>다음 문제 ▶</button>
          <button
            disabled={!can('FINISH') && !(roomOpen && !busy && (status === 'QUESTION_CLOSED' || status === 'RESULT_REVEAL'))}
            onClick={() =>
              (last || window.confirm(`아직 ${game.question_count}문항 중 ${game.current_question}문항만 진행했습니다.\n여기서 게임을 끝내고 ${game.current_question}문항 기준으로 최종 순위를 낼까요?`)) &&
              act('FINISH')
            }
            className={`btn btn-amber py-4 text-xl ${hl('FINISH')}`}
          >
            {last ? '최종 결과 공개' : '여기서 게임 끝내기'}
          </button>
          {status === 'GAME_FINISHED' && (
            <div className="grid grid-cols-2 gap-2">
              <button disabled={!can('REVEAL_FINAL_NEXT')} onClick={() => act('REVEAL_FINAL_NEXT')} className={`btn btn-amber py-3 ${hl('REVEAL_FINAL_NEXT')}`}>다음 순위 공개</button>
              <button disabled={!can('REVEAL_FINAL_ALL')} onClick={() => act('REVEAL_FINAL_ALL')} className="btn btn-ghost py-3">전체 공개</button>
            </div>
          )}
          {ties.map((g) => (
            <button
              key={g.rank}
              disabled={!roomOpen || !!busy}
              onClick={() =>
                window.confirm(`${g.rank}위 동점 가족(${g.teams.map((t) => t.team_name).join(', ')})끼리 FAMILY SYNC 결승전을 할까요?\n게임 모드가 FAMILY SYNC로 바뀌고 이 가족들만 참여하는 라운드가 준비됩니다.`) &&
                run('SYNCFINAL', async () => {
                  const r = await rpc<Room>('admin_match_sync_final', {
                    p_admin_token: token, p_room_id: room.id, p_game_id: game.id, p_team_ids: g.teams.map((t) => t.team_id),
                  });
                  onRoom(r);
                  notify('FAMILY SYNC 결승전이 준비되었습니다', 'info');
                })
              }
              className="btn btn-ghost py-3 text-cyan-200"
            >
              {g.rank}위 동점 {g.teams.length}가족 → FAMILY SYNC 결승전
            </button>
          ))}
          <button
            disabled={!can('RESTART')}
            onClick={() => window.confirm(`${game.current_question}번 문항을 처음부터 다시 진행할까요?\n이 문항의 응답과 점수는 모두 지워집니다.`) && act('RESTART')}
            className="btn btn-ghost py-2 text-sm text-amber-200"
          >
            이 문항 다시 시작 (응답 삭제)
          </button>
          <button
            disabled={!can('NEW_GAME')}
            onClick={() => window.confirm('새 게임을 1번 문제부터 시작할까요?\n지금 게임의 기록은 아래 "게임 기록"에 보관되고, 점수는 새로 계산합니다. (가족 팀은 그대로)') && act('NEW_GAME')}
            className="btn btn-ghost py-2 text-sm text-rose-300"
          >
            게임 초기화 (새 게임)
          </button>
          <label className="flex items-center gap-2 rounded-2xl bg-white/5 px-4 py-3 text-sm font-bold ring-1 ring-white/10">
            <input
              type="checkbox"
              checked={game.show_standings}
              onChange={(e) => run('STANDINGS', () => rpc('admin_match_set_standings', { p_admin_token: token, p_room_id: room.id, p_show: e.target.checked }))}
              className="h-5 w-5 accent-pink-500"
            />
            대형 스크린에 누적 순위 표시 <span className="font-normal text-white/50">(마지막 문항부터는 자동으로 숨김)</span>
          </label>
        </div>
      </section>

      {/* ---------- verdicts & families ---------- */}
      <section className="mt-4 grid gap-4 lg:grid-cols-2">
        <div className="rounded-3xl bg-white/5 p-4 ring-1 ring-white/10">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="text-lg font-black">
              {q ? `${q.question_number}번 문항 결과` : '문항 결과'}{' '}
              {status === 'QUESTION_CLOSED' && <span className="text-sm font-bold text-white/50">(사회자만 보임)</span>}
            </h2>
            <button
              onClick={() => q && downloadCsv(`fm-match-${room.room_code}-g${game.game_number}-q${q.question_number}.csv`, matchVerdictsToCsv(q.question_number, s.results))}
              disabled={!q || s.results.length === 0}
              className="btn btn-ghost text-sm"
            >
              CSV
            </button>
          </div>
          {open ? (
            <p className="text-white/60">응답 중에는 선택 내용을 숨깁니다(공정성). 마감 후 표시됩니다.</p>
          ) : s.results.length > 0 ? (
            <div className="max-h-[28rem] overflow-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-white/50">
                  <tr><th className="py-1">가족팀</th><th>참가자 1</th><th>참가자 2</th><th className="text-center">일치</th><th className="text-center">점수</th><th className="text-center">누적</th></tr>
                </thead>
                <tbody>
                  {s.results.map((r) => (
                    <tr key={r.team_id} className="border-t border-white/5">
                      <td className="py-2 font-bold">{r.team_name}</td>
                      <td><span className="text-white/70">{r.label_1 ?? '-'}</span> <OptionBadge option={r.option_1} /></td>
                      <td><span className="text-white/70">{r.label_2 ?? '-'}</span> <OptionBadge option={r.option_2} /></td>
                      <td className="text-center text-lg">{r.matched ? '⭕' : '❌'}</td>
                      <td className="text-center font-black text-amber-200">{r.points}</td>
                      <td className="text-center font-black text-pink-200">{r.total}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-white/50">응답을 마감하면 판정 결과가 여기에 표시됩니다.</p>
          )}
        </div>

        <div className="rounded-3xl bg-white/5 p-4 ring-1 ring-white/10">
          <h2 className="mb-3 text-lg font-black">가족 팀 ({teams.length})</h2>
          <ul className="grid max-h-[28rem] grid-cols-1 gap-2 overflow-auto sm:grid-cols-2">
            {teams.length === 0 && <li className="text-white/50">QR 코드로 가족 팀을 기다리는 중…</li>}
            {teams.map((t) => (
              <li key={t.team_id} className={`rounded-2xl bg-white/5 px-3 py-2 ring-1 ${t.members.length < 2 ? 'ring-amber-400/40' : 'ring-white/10'}`}>
                <p className="flex items-center justify-between gap-2 font-black">
                  <span className="truncate">{t.team_name}</span>
                  {q && (status === 'QUESTION_OPEN' || status === 'QUESTION_CLOSED' || status === 'RESULT_REVEAL') ? (
                    <span className={`rounded-full px-2 text-xs ${t.answered === 2 ? 'bg-emerald-500/30 text-emerald-200' : 'bg-white/10 text-white/70'}`}>응답 {t.answered}/2</span>
                  ) : (
                    <span className={`text-xs ${t.members.length < 2 ? 'text-amber-300' : 'text-emerald-300'}`}>{t.members.length}/2</span>
                  )}
                </p>
                <ul className="mt-1 space-y-1">
                  {t.members.map((m) => (
                    <li key={m.participant_id} className="flex items-center gap-2 text-sm">
                      <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${m.online ? 'bg-emerald-400' : 'bg-slate-500'}`} title={m.online ? '접속 중' : '응답 없음'} />
                      <span className={`min-w-0 flex-1 truncate font-bold ${m.is_test ? 'text-violet-300' : ''}`}>{m.label}</span>
                      {m.answered && <span className="font-bold text-emerald-300">✓</span>}
                      <button
                        onClick={() =>
                          window.confirm(`${t.team_name}의 ${m.label}님을 팀에서 제외할까요? (이미 낸 답은 유지되고, 빈자리에 다른 사람이 들어올 수 있습니다)`) &&
                          run('KICK', () => rpc('admin_kick', { p_admin_token: token, p_participant_id: m.participant_id }))
                        }
                        className="rounded-lg px-2 py-0.5 text-xs font-bold text-rose-300 hover:bg-rose-500/20"
                      >
                        제외
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ---------- standings / final ---------- */}
      <section className="mt-4 rounded-3xl bg-white/5 p-4 ring-1 ring-white/10">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-lg font-black">
            {status === 'GAME_FINISHED' ? '최종 순위' : '누적 순위'}{' '}
            <span className="text-sm font-bold text-white/50">
              {status === 'GAME_FINISHED' ? '(동점 = 공동 순위, 1·1·3 방식)' : '(마감된 문항 기준 · 사회자 화면)'}
            </span>
          </h2>
          <button
            onClick={() => downloadCsv(`fm-match-${room.room_code}-g${game.game_number}-final.csv`, matchFinalToCsv(game.game_number, s.final))}
            disabled={s.final.length === 0}
            className="btn btn-ghost text-sm"
          >
            최종 순위 CSV
          </button>
        </div>
        {status === 'GAME_FINISHED' ? (
          <div className="max-h-[30rem] overflow-auto">
            <table className="w-full text-left">
              <thead className="text-sm text-white/50">
                <tr><th className="py-1">순위</th><th>가족팀</th><th className="text-center">일치 문항 수</th><th className="text-center">전체 문항 수</th><th className="text-right">일치율</th></tr>
              </thead>
              <tbody>
                {s.final.map((t) => (
                  <tr key={t.team_id} className={`border-t border-white/5 ${t.rank === 1 ? 'text-amber-200' : ''}`}>
                    <td className="py-2 font-display text-xl">{t.rank}위</td>
                    <td className="font-black">{t.team_name}</td>
                    <td className="text-center font-black">{t.matched_count}</td>
                    <td className="text-center">{t.total_questions}</td>
                    <td className="text-right font-bold">{formatPercent(t.match_percentage)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : s.standings.length > 0 ? (
          <ol className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
            {s.standings.map((t) => (
              <li key={t.team_id} className="flex items-center gap-2 rounded-xl bg-white/5 px-3 py-2">
                <span className="w-10 font-display text-amber-300">{t.rank}위</span>
                <span className="min-w-0 flex-1 truncate font-bold">{t.team_name}</span>
                <span className="font-black text-pink-200">{t.score}점</span>
                <span className="text-xs text-white/50">/ {t.played}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-white/50">아직 마감된 문항이 없습니다.</p>
        )}
      </section>

      {/* ---------- question editor ---------- */}
      <QuestionEditor token={token} room={room} state={s} busy={!!busy} run={run} notify={notify} />

      {/* ---------- history, test bots ---------- */}
      <section className="mt-4 grid gap-4 lg:grid-cols-2">
        <div className="rounded-3xl bg-white/5 p-4 ring-1 ring-white/10">
          <h2 className="mb-3 text-lg font-black">게임 기록</h2>
          <table className="w-full text-left text-sm">
            <thead className="text-white/50">
              <tr><th className="py-1">게임</th><th>진행</th><th>1위</th><th>상태</th></tr>
            </thead>
            <tbody>
              {s.games.map((g) => (
                <tr key={g.id} className="border-t border-white/5">
                  <td className="py-2 font-bold">{g.game_number}</td>
                  <td className="text-white/70">{g.status === 'GAME_FINISHED' ? `${g.total_questions}문항` : `${g.current_question}/${g.question_count}`}</td>
                  <td className="font-bold text-amber-200">{g.winners.join(', ') || <span className="text-white/40">-</span>}</td>
                  <td className="text-white/60">{g.id === game.id ? GAME_STATUS_LABEL[g.status] : g.status === 'GAME_FINISHED' ? '종료' : '중단'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {room.test_mode ? (
          <div className="rounded-3xl bg-violet-500/10 p-4 ring-1 ring-violet-400/30">
            <h2 className="text-lg font-black">이구동성 테스트 봇</h2>
            <p className="mt-1 text-sm text-white/60">봇 가족(2명씩)을 만들어 실제 match_answer 경로로 응답합니다. 봇 가족은 약 60% 확률로 같은 답을 고릅니다. 테스트 모드를 끄면 삭제됩니다.</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <input
                type="number" min={1} max={15} value={botCount}
                onChange={(e) => setBotCount(Math.max(1, Math.min(15, Number(e.target.value) || 1)))}
                className="w-20 rounded-xl bg-white/10 px-3 py-2 text-white"
              />
              <button
                disabled={!!busy}
                onClick={() =>
                  run('ADDBOTS', async () => {
                    const added = await rpc<BotTeam[]>('admin_sync_add_test_teams', { p_admin_token: token, p_room_id: room.id, p_count: botCount });
                    setBots((b) => [...b, ...added]);
                  })
                }
                className="btn btn-ghost"
              >
                봇 가족 추가
              </button>
              <button disabled={!!busy || bots.length === 0 || !open} onClick={() => void answerBots()} className="btn btn-red">
                봇 {bots.length * 2}명 응답
              </button>
            </div>
            {bots.length === 0 && teams.some((t) => t.members.some((m) => m.is_test)) && (
              <p className="mt-2 text-xs text-white/50">새로고침 전에 만든 봇은 토큰이 없어 응답할 수 없습니다. 테스트 모드를 껐다 켠 뒤 다시 추가하세요.</p>
            )}
            {botResult && <p className="mt-2 font-bold text-violet-200">{botResult}</p>}
          </div>
        ) : (
          <div className="rounded-3xl bg-white/5 p-4 text-sm text-white/60 ring-1 ring-white/10">
            <h2 className="mb-2 text-lg font-black text-white">진행 규칙</h2>
            <ul className="list-disc space-y-1 pl-5">
              <li>두 사람의 답이 같으면 1점, 다르거나 한 명이라도 응답하지 않으면 0점.</li>
              <li>제한 시간은 서버 시각 기준이며, 시간 안에는 답을 바꿀 수 있습니다(마지막 답 인정).</li>
              <li>'이 문항 다시 시작'은 해당 문항의 응답과 점수를 지우고 다시 진행합니다.</li>
              <li>'게임 초기화'는 새 게임을 시작하며 이전 게임 기록은 따로 보관됩니다.</li>
              <li>가족 팀은 FAMILY SYNC와 공유됩니다. 동점이면 FAMILY SYNC 결승전으로 가릴 수 있습니다.</li>
            </ul>
          </div>
        )}
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------

function QuestionEditor({ token, room, state, busy, run, notify }: {
  token: string;
  room: Room;
  state: MatchAdminState;
  busy: boolean;
  run: (label: string, fn: () => Promise<unknown>) => Promise<void>;
  notify: (text: string, tone: 'error' | 'info') => void;
}) {
  const game = state.game!;
  const lobby = game.status === 'LOBBY';
  const [openEditor, setOpenEditor] = useState(lobby);
  const [dirty, setDirty] = useState(false);
  const [title, setTitle] = useState(game.title);
  const [count, setCount] = useState(game.question_count);
  const [drafts, setDrafts] = useState<MatchQuestionDraft[]>(() => state.questions.map(toDraft));
  const [allDuration, setAllDuration] = useState(15);

  // follow the server while there are no unsaved edits
  const serverKey = `${game.id}:${game.rev}`;
  useEffect(() => {
    if (dirty) return;
    setTitle(game.title);
    setCount(game.question_count);
    setDrafts(state.questions.map(toDraft));
  }, [serverKey, dirty]);
  useEffect(() => setOpenEditor((o) => o || lobby), [lobby]);

  const edit = (i: number, patch: Partial<MatchQuestionDraft>) => {
    setDirty(true);
    setDrafts((d) => d.map((q, j) => (j === i ? { ...q, ...patch } : q)));
  };
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= drafts.length) return;
    setDirty(true);
    setDrafts((d) => {
      const n = [...d];
      [n[i], n[j]] = [n[j], n[i]];
      return n;
    });
  };
  const editable = (i: number) => lobby || ['PENDING', 'READY'].includes(state.questions[i]?.status ?? '');
  const changed = (i: number) => JSON.stringify(drafts[i]) !== JSON.stringify(state.questions[i] && toDraft(state.questions[i]));

  const save = () => {
    const errors = drafts
      .map((d, i) => (lobby || (editable(i) && changed(i)) ? validateDraft(d) && `${i + 1}번: ${validateDraft(d)}` : null))
      .filter(Boolean);
    if (lobby && !title.trim()) errors.unshift('게임 제목을 입력해 주세요');
    if (errors.length) return notify(errors.slice(0, 3).join(' / '), 'error');
    void run('SETUP', async () => {
      if (lobby) {
        await rpc('admin_match_setup', {
          p_admin_token: token, p_room_id: room.id, p_game_id: game.id,
          p_title: title, p_question_count: count, p_questions: drafts,
        });
      } else {
        for (let i = 0; i < drafts.length; i++) {
          if (editable(i) && changed(i)) {
            await rpc('admin_match_edit_question', {
              p_admin_token: token, p_room_id: room.id, p_game_id: game.id, p_question_number: i + 1, p_question: drafts[i],
            });
          }
        }
      }
      setDirty(false);
      notify('문항을 저장했습니다', 'info');
    });
  };

  const field = 'rounded-lg border border-white/15 bg-white/10 px-2 py-1.5 text-white outline-none focus:border-pink-300 disabled:opacity-50';

  return (
    <section className="mt-4 rounded-3xl bg-white/5 p-4 ring-1 ring-white/10">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button onClick={() => setOpenEditor((o) => !o)} className="text-lg font-black">
          {openEditor ? '▼' : '▶'} 게임 설정 · 문항 편집 {dirty && <span className="text-sm text-amber-300">(저장 안 됨)</span>}
        </button>
        {openEditor && (
          <div className="flex gap-2">
            {dirty && <button disabled={busy} onClick={() => setDirty(false)} className="btn btn-ghost text-sm">되돌리기</button>}
            <button disabled={busy || !dirty} onClick={save} className="btn btn-green">저장</button>
          </div>
        )}
      </div>
      {openEditor && (
        <>
          <p className="mt-1 text-sm text-white/55">
            {lobby
              ? '게임 시작 전에는 제목·문항 수·순서·모든 문항을 바꿀 수 있습니다.'
              : '게임 중에는 아직 시작하지 않은 문항만 수정할 수 있습니다. 문항 수·순서는 다음 게임(게임 초기화)에서 바꾸세요.'}
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label className="min-w-[16rem] flex-1">
              <span className="text-sm font-bold text-white/70">게임 제목</span>
              <input disabled={!lobby} value={title} maxLength={QUESTION_LIMITS.title} onChange={(e) => { setDirty(true); setTitle(e.target.value); }} className={`${field} w-full`} />
            </label>
            <label>
              <span className="text-sm font-bold text-white/70">전체 문항 수</span>
              <select disabled={!lobby} value={count} onChange={(e) => { setDirty(true); setCount(Number(e.target.value)); }} className={`${field} w-24`}>
                {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => <option key={n} value={n} className="bg-slate-800">{n}개</option>)}
              </select>
            </label>
            <label>
              <span className="text-sm font-bold text-white/70">제한 시간(5~30초)</span>
              <span className="flex gap-1">
                <input type="number" min={5} max={30} value={allDuration} onChange={(e) => setAllDuration(Number(e.target.value))} className={`${field} w-20`} />
                <button
                  type="button"
                  onClick={() => {
                    const d = Math.max(5, Math.min(30, Math.round(allDuration) || 15));
                    setAllDuration(d);
                    setDirty(true);
                    setDrafts((qs) => qs.map((q, i) => (editable(i) ? { ...q, duration_seconds: d } : q)));
                  }}
                  className="btn btn-ghost text-sm"
                >
                  모든 문항에 적용
                </button>
              </span>
            </label>
          </div>
          <ol className="mt-4 space-y-2">
            {drafts.map((d, i) => {
              const ok = editable(i);
              const used = i < count;
              const err = ok ? validateDraft(d) : null;
              return (
                <li key={i} className={`rounded-2xl p-3 ring-1 ${used ? 'bg-white/5 ring-white/10' : 'bg-black/20 ring-white/5 opacity-60'} ${err ? 'ring-rose-400/60' : ''}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="w-9 font-display text-xl text-pink-200">{i + 1}</span>
                    <input disabled={!ok} value={d.story_title} maxLength={QUESTION_LIMITS.storyTitle} onChange={(e) => edit(i, { story_title: e.target.value })} placeholder="스토리 제목" className={`${field} min-w-[10rem] flex-1 font-bold`} />
                    <input disabled={!ok} type="number" min={5} max={30} value={d.duration_seconds} onChange={(e) => edit(i, { duration_seconds: Number(e.target.value) })} className={`${field} w-16`} title="제한 시간(초)" />
                    <span className="text-xs text-white/50">초</span>
                    {lobby && (
                      <span className="flex gap-1">
                        <button type="button" disabled={i === 0} onClick={() => move(i, -1)} className="btn btn-ghost px-2 py-1 text-xs" aria-label="위로">↑</button>
                        <button type="button" disabled={i === drafts.length - 1} onClick={() => move(i, 1)} className="btn btn-ghost px-2 py-1 text-xs" aria-label="아래로">↓</button>
                      </span>
                    )}
                    {!used && <span className="text-xs text-white/50">(이번 게임에서 사용 안 함)</span>}
                    {!ok && <span className="text-xs text-white/50">진행됨</span>}
                  </div>
                  <div className="mt-2 grid gap-2 md:grid-cols-2">
                    <input disabled={!ok} value={d.question_text} maxLength={QUESTION_LIMITS.question} onChange={(e) => edit(i, { question_text: e.target.value })} placeholder="질문" className={`${field} w-full md:col-span-2`} />
                    <input disabled={!ok} value={d.option_a} maxLength={QUESTION_LIMITS.option} onChange={(e) => edit(i, { option_a: e.target.value })} placeholder="A 보기" className={`${field} w-full border-rose-400/40`} />
                    <input disabled={!ok} value={d.option_b} maxLength={QUESTION_LIMITS.option} onChange={(e) => edit(i, { option_b: e.target.value })} placeholder="B 보기" className={`${field} w-full border-sky-400/40`} />
                    <input disabled={!ok} value={d.story_text} maxLength={QUESTION_LIMITS.storyText} onChange={(e) => edit(i, { story_text: e.target.value })} placeholder="스토리 설명 (선택)" className={`${field} w-full md:col-span-2 text-sm`} />
                  </div>
                  <ImagePicker disabled={!ok} value={d.image_url} onChange={(image_url) => edit(i, { image_url })} field={field} />
                  {err && <p className="mt-1 text-xs font-bold text-rose-300">{err}</p>}
                </li>
              );
            })}
          </ol>
        </>
      )}
    </section>
  );
}

/** Big-screen picture of one question: a shipped picture, a web address, or none. */
function ImagePicker({ value, onChange, disabled, field }: {
  value: string;
  onChange: (url: string) => void;
  disabled: boolean;
  field: string;
}) {
  const shipped = MATCH_IMAGES.some((m) => m.url === value);
  const [custom, setCustom] = useState(!shipped && value !== '');
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    setBroken(false);
    // follow the value when questions are reordered or reloaded
    if (shipped) setCustom(false);
    else if (value) setCustom(true);
  }, [value, shipped]);
  const mode = custom ? 'URL' : value || 'NONE';

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <span className="text-xs font-bold text-white/60">대형 스크린 그림</span>
      <select
        disabled={disabled}
        value={mode}
        onChange={(e) => {
          const v = e.target.value;
          setCustom(v === 'URL');
          if (v === 'NONE') onChange('');
          else if (v !== 'URL') onChange(v);
          else if (shipped) onChange('');
        }}
        className={`${field} w-40 text-sm`}
      >
        <option value="NONE" className="bg-slate-800">그림 없음</option>
        {MATCH_IMAGES.map((m) => <option key={m.url} value={m.url} className="bg-slate-800">{m.label}</option>)}
        <option value="URL" className="bg-slate-800">다른 그림 (웹 주소)</option>
      </select>
      {custom && (
        <input
          disabled={disabled}
          value={value}
          maxLength={500}
          onChange={(e) => onChange(e.target.value)}
          placeholder="https://… 그림 주소"
          className={`${field} min-w-[14rem] flex-1 text-sm`}
        />
      )}
      {value && !broken ? (
        <img src={value} alt="" onError={() => setBroken(true)} className="h-14 w-24 rounded-lg bg-black/30 object-cover ring-1 ring-white/15" />
      ) : value ? (
        <span className="text-xs font-bold text-rose-300">그림을 불러올 수 없습니다</span>
      ) : null}
    </div>
  );
}
