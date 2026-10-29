import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Confetti } from '../components/Confetti';
import { SyncResultList } from '../components/SyncResults';
import { useLiveSync } from '../hooks/useLiveSync';
import { useAtServerTime, useServerNow } from '../hooks/useServerNow';
import { downloadCsv, syncResultsToCsv } from '../lib/csv';
import { serverClock, timed } from '../lib/serverClock';
import { sfx } from '../lib/sound';
import { RpcError, errorMessage, rpc } from '../lib/supabase';
import { formatMs, formatSeconds, fullyRevealed, tieGroups } from '../lib/syncView';
import type { Room, SyncAdminState, SyncBuzzResponse, SyncRound, SyncStatus } from '../lib/types';

const STATUS_LABEL: Record<SyncStatus, string> = {
  WAITING: '팀 모집',
  READY: '준비',
  RUNNING: '진행 중',
  FINISHED: '집계 완료',
  RESULTS: '결과 공개',
};
const STATUS_COLOR: Record<SyncStatus, string> = {
  WAITING: 'bg-slate-500',
  READY: 'bg-emerald-500',
  RUNNING: 'bg-cyan-500 animate-pulse',
  FINISHED: 'bg-amber-500',
  RESULTS: 'bg-violet-500',
};

type Action = 'READY' | 'START' | 'FINISH' | 'REVEAL_NEXT' | 'REVEAL_ALL' | 'NEXT';
type BotTeam = { team_id: string; team_name: string; members: Array<{ participant_id: string; token: string }> };

const isAuthError = (e: unknown) => e instanceof RpcError && e.code === 'ADMIN_AUTH_REQUIRED';

export function SyncAdminPanel({ token, room, onAuthError, notify }: {
  token: string;
  room: Room;
  onAuthError: () => void;
  notify: (text: string, tone: 'error' | 'info') => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [fast, setFast] = useState(false);
  const [bots, setBots] = useState<BotTeam[]>([]);
  const [botCount, setBotCount] = useState(5);
  const [botResult, setBotResult] = useState<string | null>(null);
  const [celebrate, setCelebrate] = useState(0);

  const fetcher = useCallback(
    () => timed(() => rpc<SyncAdminState>('admin_sync_state', { p_admin_token: token, p_room_code: room.room_code })),
    [token, room.room_code],
  );
  const live = useLiveSync<SyncAdminState>({ roomId: room.id, fetcher, liveIntervalMs: fast ? 1000 : 3000, pollIntervalMs: 1000 });
  const s = live.data;
  const round = s?.round ?? null;
  const status = round?.status ?? 'WAITING';
  const running = status === 'RUNNING';

  // presses do not emit realtime events (by design): poll fast while the game runs
  useEffect(() => setFast(running), [running]);
  useEffect(() => {
    if (isAuthError(live.error)) onAuthError();
  }, [live.error, onAuthError]);
  // turning test mode off deletes the bots on the server
  useEffect(() => {
    if (!room.test_mode) setBots([]);
  }, [room.test_mode]);

  const now = useServerNow(running, 100);
  useAtServerTime(running ? round?.deadline_ms : null, () => void live.refresh(), 300);

  const prevReveal = useRef<string | null>(null);
  const revealKey = `${round?.id}:${round?.revealed_rank ?? ''}`;
  useEffect(() => {
    if (!s) return;
    if (prevReveal.current !== null && revealKey !== prevReveal.current && round?.revealed_rank === 1) setCelebrate((c) => c + 1);
    prevReveal.current = revealKey;
  }, [s, revealKey, round?.revealed_rank]);

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

  const setRound = (r: SyncRound) => live.setData((d) => (d ? { ...d, round: r } : d));

  const act = (a: Action) =>
    run(a, async () => {
      const r = await rpc<SyncRound>('admin_sync_action', {
        p_admin_token: token, p_room_id: room.id, p_round_id: round?.id ?? null, p_action: a,
      });
      setRound(r);
      if (a === 'REVEAL_NEXT' || a === 'REVEAL_ALL') r.revealed_rank === 1 ? sfx.win() : sfx.reveal();
    });

  const teams = s?.teams ?? [];
  const playing = useMemo(
    () => (round?.team_ids ? teams.filter((t) => round.team_ids!.includes(t.team_id)) : teams),
    [teams, round?.team_ids],
  );

  const start = () => {
    const offline = playing.flatMap((t) => t.members.filter((m) => !m.online && !m.is_test).map((m) => `${t.team_name} ${m.label}`));
    const solo = playing.filter((t) => t.members.length < 2).map((t) => t.team_name);
    const warnings = [
      playing.length === 0 && '아직 가입한 팀이 없습니다.',
      offline.length > 0 && `응답이 없는 참가자 ${offline.length}명: ${offline.slice(0, 6).join(', ')}${offline.length > 6 ? ' …' : ''}`,
      solo.length > 0 && `파트너가 없는 팀 ${solo.length}개: ${solo.slice(0, 6).join(', ')}${solo.length > 6 ? ' …' : ''}`,
    ].filter(Boolean);
    if (warnings.length && !window.confirm(`${warnings.join('\n')}\n\n그래도 시작할까요?`)) return;
    void act('START');
  };

  const pressBots = () =>
    run('BOTS', async () => {
      if (!round || round.started_ms == null) return;
      const startLocal = round.started_ms - serverClock.offset;
      let ok = 0;
      let other = 0;
      await Promise.all(
        bots.flatMap((t) => {
          // each bot family aims for the same moment, with a little human jitter
          const aim = 600 + Math.random() * 3000;
          return t.members.map(async (m) => {
            const at = startLocal + aim + Math.random() * 250;
            await new Promise((r) => setTimeout(r, Math.max(0, at - Date.now())));
            const res = await rpc<SyncBuzzResponse>('sync_buzz', { p_token: m.token, p_round_id: round.id }).catch(() => null);
            if (res?.result === 'ACCEPTED') ok++;
            else other++;
          });
        }),
      );
      setBotResult(`봇 ${ok + other}명 입력 → 접수 ${ok}건, 거절/오류 ${other}건`);
    });

  if (!s) {
    return (
      <section className="mt-4 rounded-3xl bg-white/5 p-6 text-center text-white/70 ring-1 ring-white/10">
        {live.error ? errorMessage(live.error) : 'FAMILY SYNC 불러오는 중…'}
      </section>
    );
  }

  const open = room.status === 'OPEN';
  const beforeGo = running && round?.started_ms != null && now < round.started_ms;
  const remaining = running && round?.deadline_ms != null ? Math.max(0, round.deadline_ms - now) : null;
  const ties = status === 'FINISHED' || status === 'RESULTS' ? tieGroups(s.results) : [];
  const revealedAll = fullyRevealed(round);
  const memberCount = teams.reduce((n, t) => n + t.members.length, 0);
  const onlineCount = teams.reduce((n, t) => n + t.members.filter((m) => m.online).length, 0);

  return (
    <>
      {celebrate > 0 && <Confetti key={celebrate} count={120} />}

      {/* ---------- stage + controls ---------- */}
      <section className="mt-4 grid gap-4 lg:grid-cols-[1fr_22rem]">
        <div className="relative flex min-h-[22rem] flex-col items-center justify-center rounded-3xl bg-white/5 p-6 text-center ring-1 ring-white/10">
          <div className="absolute left-5 top-4 flex flex-wrap items-center gap-3">
            <span className="font-display text-2xl text-white/80">SYNC ROUND {round?.round_number ?? '-'}</span>
            <span className={`rounded-full px-3 py-1 text-sm font-black text-white ${STATUS_COLOR[status]}`}>{STATUS_LABEL[status]}</span>
            {round?.team_ids && <span className="rounded-full bg-amber-400/20 px-3 py-1 text-sm font-bold text-amber-200">동점 재경기 {round.team_ids.length}팀</span>}
          </div>
          <div className="absolute right-5 top-4 text-right text-sm text-white/60">
            {teams.length}가족 · {memberCount}명 (접속 {onlineCount})
          </div>

          {(status === 'WAITING' || status === 'READY') && (
            <p className={`font-display text-[clamp(3rem,7vw,5.5rem)] ${status === 'READY' ? 'text-emerald-300' : 'text-white/80'}`}>
              {status === 'READY' ? '시작 대기' : '팀 가입 중'}
            </p>
          )}
          {running && (
            <>
              <p className="font-display text-[clamp(3rem,7vw,5.5rem)] text-cyan-300">
                {beforeGo ? `시작까지 ${Math.ceil((round!.started_ms! - now) / 1000)}` : '진행 중'}
              </p>
              {!beforeGo && remaining != null && (
                <p className="text-lg text-white/60">남은 시간 {(remaining / 1000).toFixed(1)}초 <span className="text-white/40">(사회자에게만 표시)</span></p>
              )}
            </>
          )}
          {status === 'FINISHED' && <p className="font-display text-[clamp(3rem,7vw,5.5rem)] text-amber-300">결과 집계 완료</p>}
          {status === 'RESULTS' && (
            <p className="font-display text-[clamp(2.5rem,6vw,4.5rem)] text-violet-200">
              {revealedAll ? '전체 순위 공개됨' : `${round?.revealed_rank}위까지 공개`}
            </p>
          )}

          {(running || status === 'FINISHED' || status === 'RESULTS') && (
            <p className="mt-4 rounded-full bg-white/10 px-5 py-2 text-2xl font-black">
              입력 완료 <span className="text-cyan-300">{s.progress.pressed}</span> / {s.progress.expected}명
            </p>
          )}
        </div>

        <div className="flex flex-col gap-3">
          <button disabled={!open || status !== 'WAITING' || !!busy} onClick={() => act('READY')} className="btn btn-green py-4 text-2xl">
            준비
          </button>
          <button disabled={!open || (status !== 'WAITING' && status !== 'READY') || !!busy} onClick={start} className="btn btn-red py-6 text-3xl">
            시작 (3·2·1 후 10초)
          </button>
          <button
            disabled={!open || !running || !!busy}
            onClick={() => window.confirm('지금 입력을 마감할까요?') && act('FINISH')}
            className="btn btn-ghost py-3"
          >
            지금 마감 (10초 전 종료)
          </button>
          <div className="grid grid-cols-2 gap-2">
            <button disabled={!open || (status !== 'FINISHED' && status !== 'RESULTS') || revealedAll || !!busy} onClick={() => act('REVEAL_NEXT')} className="btn btn-amber py-4 text-lg">
              다음 순위 공개
            </button>
            <button disabled={!open || (status !== 'FINISHED' && status !== 'RESULTS') || revealedAll || !!busy} onClick={() => act('REVEAL_ALL')} className="btn btn-ghost py-4 text-lg">
              전체 공개
            </button>
          </div>
          <button disabled={!open || running || !!busy} onClick={() => act('NEXT')} className="btn btn-blue py-4 text-xl">
            다음 라운드 ▶
          </button>
          {ties.map((g) => (
            <button
              key={g.rank}
              disabled={!open || !!busy}
              onClick={() =>
                window.confirm(`${g.rank}위 동점 팀(${g.teams.map((t) => t.team_name).join(', ')})만 재경기할까요?`) &&
                run('REMATCH', async () =>
                  setRound(await rpc<SyncRound>('admin_sync_rematch', {
                    p_admin_token: token, p_room_id: room.id, p_round_id: round!.id, p_team_ids: g.teams.map((t) => t.team_id),
                  })),
                )
              }
              className="btn btn-ghost py-3 text-amber-200"
            >
              {g.rank}위 동점 재경기 ({g.teams.length}팀)
            </button>
          ))}
          <label className="flex items-center gap-2 rounded-2xl bg-white/5 px-4 py-3 text-sm font-bold ring-1 ring-white/10">
            <input
              type="checkbox"
              checked={room.sync_show_progress}
              onChange={(e) => run('PROGRESS', () => rpc('admin_sync_set_progress', { p_admin_token: token, p_room_id: room.id, p_show: e.target.checked }))}
              className="h-5 w-5 accent-cyan-500"
            />
            대형 스크린에 입력 완료 인원 표시
          </label>
        </div>
      </section>

      {/* ---------- results (host preview) & teams ---------- */}
      <section className="mt-4 grid gap-4 lg:grid-cols-2">
        <div className="rounded-3xl bg-white/5 p-4 ring-1 ring-white/10">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="text-lg font-black">
              이번 라운드 결과 {status !== 'RESULTS' && <span className="text-sm font-bold text-white/50">(사회자만 보임)</span>}
            </h2>
            <button
              onClick={() => round && downloadCsv(`fm-sync-${room.room_code}-r${round.round_number}.csv`, syncResultsToCsv(round.round_number, s.results))}
              disabled={!round || s.results.length === 0}
              className="btn btn-ghost text-sm"
            >
              CSV 다운로드
            </button>
          </div>
          {running ? (
            <p className="text-white/60">진행 중에는 기록을 숨깁니다. 마감 후 표시됩니다.</p>
          ) : s.results.some((t) => t.status !== 'NONE') ? (
            <div className="max-h-[28rem] overflow-auto pr-1">
              <SyncResultList results={s.results} />
            </div>
          ) : (
            <p className="text-white/50">아직 기록이 없습니다.</p>
          )}
          <p className="mt-3 text-xs text-white/45">
            기록 = 서버(DB)가 요청을 받은 시각 − 시작 신호 시각. 네트워크 지연이 포함되며 실제 터치 시각과 수십 ms 다를 수 있습니다.
          </p>
        </div>

        <div className="rounded-3xl bg-white/5 p-4 ring-1 ring-white/10">
          <h2 className="mb-3 text-lg font-black">가족 팀 ({teams.length})</h2>
          <ul className="grid max-h-[28rem] grid-cols-1 gap-2 overflow-auto sm:grid-cols-2">
            {teams.length === 0 && <li className="text-white/50">QR 코드로 가족 팀을 기다리는 중…</li>}
            {teams.map((t) => {
              const inRound = !round?.team_ids || round.team_ids.includes(t.team_id);
              return (
                <li key={t.team_id} className={`rounded-2xl bg-white/5 px-3 py-2 ring-1 ${t.members.length < 2 ? 'ring-amber-400/40' : 'ring-white/10'} ${inRound ? '' : 'opacity-50'}`}>
                  <p className="flex items-center justify-between font-black">
                    <span className="truncate">{t.team_name}</span>
                    <span className={`text-xs ${t.members.length < 2 ? 'text-amber-300' : 'text-emerald-300'}`}>{t.members.length}/2</span>
                  </p>
                  <ul className="mt-1 space-y-1">
                    {t.members.map((m) => (
                      <li key={m.participant_id} className="flex items-center gap-2 text-sm">
                        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${m.online ? 'bg-emerald-400' : 'bg-slate-500'}`} title={m.online ? '접속 중' : '응답 없음'} />
                        <span className={`min-w-0 flex-1 truncate font-bold ${m.is_test ? 'text-violet-300' : ''}`}>{m.label}</span>
                        {m.elapsed_ms != null && (
                          <span className="font-bold text-cyan-200">{running ? '✓' : formatSeconds(m.elapsed_ms)}</span>
                        )}
                        <button
                          onClick={() =>
                            window.confirm(`${t.team_name}의 ${m.label}님을 팀에서 제외할까요? (빈자리에 다른 사람이 들어올 수 있습니다)`) &&
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
              );
            })}
          </ul>
        </div>
      </section>

      {/* ---------- history, test bots, reset ---------- */}
      <section className="mt-4 grid gap-4 lg:grid-cols-2">
        <div className="rounded-3xl bg-white/5 p-4 ring-1 ring-white/10">
          <h2 className="mb-3 text-lg font-black">SYNC 라운드 기록</h2>
          <table className="w-full text-left text-sm">
            <thead className="text-white/50">
              <tr><th className="py-1">라운드</th><th>1위</th><th>차이</th><th>상태</th></tr>
            </thead>
            <tbody>
              {s.rounds.map((r) => (
                <tr key={r.id} className="border-t border-white/5">
                  <td className="py-2 font-bold">{r.round_number}{r.team_ids ? ' (재경기)' : ''}</td>
                  <td className="font-bold text-amber-200">{r.winners.map((w) => w.team_name).join(', ') || <span className="text-white/40">-</span>}</td>
                  <td className="text-white/70">{r.winners[0] ? formatMs(r.winners[0].gap_ms) : ''}</td>
                  <td className="text-white/60">{STATUS_LABEL[r.status]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="space-y-4">
          {room.test_mode && (
            <div className="rounded-3xl bg-violet-500/10 p-4 ring-1 ring-violet-400/30">
              <h2 className="text-lg font-black">SYNC 테스트 봇</h2>
              <p className="mt-1 text-sm text-white/60">봇 가족(2명씩)을 만들어 실제 sync_buzz 경로로 입력해 봅니다. 테스트 모드를 끄면 삭제됩니다.</p>
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
                <button disabled={!!busy || bots.length === 0 || !running} onClick={() => void pressBots()} className="btn btn-red">
                  봇 {bots.length * 2}명 입력
                </button>
              </div>
              {bots.length === 0 && teams.some((t) => t.members.some((m) => m.is_test)) && (
                <p className="mt-2 text-xs text-white/50">새로고침 전에 만든 봇은 토큰이 없어 누를 수 없습니다. 테스트 모드를 껐다 켠 뒤 다시 추가하세요.</p>
              )}
              {botResult && <p className="mt-2 font-bold text-violet-200">{botResult}</p>}
            </div>
          )}
          <div className="rounded-3xl bg-white/5 p-4 ring-1 ring-white/10">
            <h2 className="text-lg font-black">FAMILY SYNC 관리</h2>
            <button
              disabled={!!busy || running}
              onClick={() =>
                window.confirm('가족 팀, 팀원, SYNC 라운드 기록을 모두 삭제할까요?\n(일반 퀴즈 부저 참가자와 기록은 그대로입니다)') &&
                run('SYNCRESET', async () => {
                  await rpc('admin_sync_reset', { p_admin_token: token, p_room_id: room.id });
                  setBots([]);
                  setBotResult(null);
                  notify('FAMILY SYNC 전체 초기화 완료', 'info');
                })
              }
              className="btn btn-ghost mt-3 text-rose-300"
            >
              FAMILY SYNC 전체 초기화
            </button>
          </div>
        </div>
      </section>
    </>
  );
}
