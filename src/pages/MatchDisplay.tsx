import { useCallback, useEffect, useRef, useState } from 'react';
import { Confetti } from '../components/Confetti';
import { ConnectionBadge } from '../components/ConnectionBadge';
import { OptionBadge } from '../components/MatchResults';
import { QrCode } from '../components/QrCode';
import { useLiveSync } from '../hooks/useLiveSync';
import { useAtServerTime, useServerNow } from '../hooks/useServerNow';
import { useSoundState } from '../hooks/useSound';
import { MATCH_IMAGE_COUNT, finalFullyRevealed, formatPercent, matchImage, screenVerdict } from '../lib/matchView';
import { timed } from '../lib/serverClock';
import { sfx, unlockAudio } from '../lib/sound';
import { errorMessage, publicBaseUrl, rpc } from '../lib/supabase';
import type { MatchFinalRow, MatchPublicState } from '../lib/types';

/** /display while the room plays FAMILY MATCH (16:9 projector). Read-only, no credentials. */
export function MatchDisplay({ code }: { code: string }) {
  const [roomId, setRoomId] = useState<string | null>(null);
  const [celebrate, setCelebrate] = useState(0);
  const { ready } = useSoundState();

  const fetcher = useCallback(() => timed(() => rpc<MatchPublicState>('match_public_state', { p_room_code: code })), [code]);
  const [fast, setFast] = useState(false);
  const live = useLiveSync<MatchPublicState>({
    roomId, fetcher, liveIntervalMs: fast ? 1500 : 4000, pollIntervalMs: 1500, tables: ['rooms', 'family_match_games'],
  });
  const s = live.data;
  const game = s?.game ?? null;
  const q = s?.question ?? null;
  const open = game?.status === 'QUESTION_OPEN';

  useEffect(() => {
    if (s?.room.id) setRoomId(s.room.id);
  }, [s?.room.id]);
  // load every scene image up front so a new question never shows a blank frame
  useEffect(() => {
    for (let n = 1; n <= MATCH_IMAGE_COUNT; n++) new Image().src = matchImage(n)!;
  }, []);
  // answers emit no realtime events (by design): poll faster while answering is open
  useEffect(() => setFast(open), [open]);

  const now = useServerNow(open, 200);
  useAtServerTime(open ? q?.closes_ms : null, () => void live.refresh(), 400);
  const remaining = open && q?.closes_ms != null ? Math.max(0, Math.ceil((q.closes_ms - now) / 1000)) : null;

  // sounds — never for state that was already there on page load
  const prev = useRef<{ status: string; key: string; remaining: number | null; final: number | null } | null>(null);
  const key = `${q?.id}:${q?.opened_ms}`;
  const finalRank = game?.final_revealed_rank ?? null;
  useEffect(() => {
    if (!s || !game) return;
    const p = prev.current;
    prev.current = { status: game.status, key, remaining, final: finalRank };
    if (!p) return;
    if (game.status === 'QUESTION_OPEN' && (p.status !== 'QUESTION_OPEN' || p.key !== key)) sfx.start();
    else if (remaining != null && remaining <= 5 && remaining > 0 && remaining !== p.remaining) sfx.tick();
    else if (game.status === 'QUESTION_CLOSED' && p.status === 'QUESTION_OPEN') sfx.chime();
    else if (game.status === 'RESULT_REVEAL' && p.status !== 'RESULT_REVEAL') sfx.reveal();
    else if (game.status === 'GAME_FINISHED' && finalRank != null && finalRank !== p.final) {
      if (finalRank === 1) {
        sfx.win();
        setCelebrate((c) => c + 1);
      } else sfx.reveal();
    }
  }, [s, game, key, remaining, finalRank]);

  if (!s) return <main className="stage flex min-h-dvh items-center justify-center text-3xl text-white/70">{live.error ? errorMessage(live.error) : '불러오는 중…'}</main>;

  const status = s.room.status === 'ENDED' ? 'ENDED' : game?.status ?? 'LOBBY';
  const matchedCount = s.results.filter((r) => r.matched).length;

  return (
    <main className="stage relative flex min-h-dvh flex-col overflow-hidden p-[3vmin]" onPointerDown={unlockAudio}>
      {status === 'RESULT_REVEAL' && q && matchImage(q.question_number) && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-cover bg-center opacity-15 blur-[2px]"
          style={{ backgroundImage: `url(${matchImage(q.question_number)})` }}
        />
      )}
      {celebrate > 0 && <Confetti key={celebrate} count={180} />}
      <header className="relative flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="font-display text-[5vmin] leading-none text-pink-300">우리 가족 이구동성</p>
          <p className="mt-2 truncate text-[2.6vmin] font-bold text-white/70">
            {game?.title}
            {game && game.current_question > 0 && <> · 문항 {game.current_question} / {game.question_count}</>}
            {' · '}{s.teams.length}가족 참가
          </p>
        </div>
        <div className="flex shrink-0 items-start gap-4">
          <div className="flex flex-col items-end gap-2">
            <ConnectionBadge connected={live.connected} realtime={live.realtime} />
            {!ready && <span className="text-sm text-white/50">클릭하면 소리가 켜집니다</span>}
          </div>
          <div className="text-center">
            <QrCode text={`${publicBaseUrl()}/room/${s.room.room_code}`} size={130} />
            <p className="mt-1 font-display text-[3vmin] tracking-[0.25em]">{s.room.room_code}</p>
          </div>
        </div>
      </header>

      {s.room.announcement && (
        <p className="mx-auto mt-3 rounded-3xl bg-amber-300/15 px-8 py-2 text-center text-[3vmin] font-bold text-amber-50 ring-1 ring-amber-300/40">
          📢 {s.room.announcement}
        </p>
      )}

      <div className="relative flex min-h-0 flex-1 gap-[3vmin]">
        <section className="flex min-w-0 flex-1 flex-col items-center justify-center text-center">
          {status === 'ENDED' && <p className="font-display text-[11vmin] text-white/85">게임 종료</p>}

          {status === 'LOBBY' && (
            <>
              <p className="text-[3.4vmin] font-bold text-white/70">오늘의 이야기</p>
              <p className="font-display text-[8vmin] leading-tight text-amber-300">{game?.title}</p>
              <p className="mt-3 text-[3vmin] font-bold text-white/80">
                가족 두 사람이 A/B 중 하나를 골라요. 서로 같은 답이면 1점! (총 {game?.question_count}문제)
              </p>
              {s.teams.length > 0 && (
                <ul className="mt-[3vmin] flex max-w-[90vw] flex-wrap justify-center gap-[1.2vmin]">
                  {s.teams.map((t) => (
                    <li key={t.team_name} className={`rounded-full px-[2vmin] py-[0.8vmin] text-[2.6vmin] font-black ${t.members >= 2 ? 'bg-pink-400/20 text-pink-100' : 'bg-white/10 text-white/60'}`}>
                      {t.team_name} {t.members >= 2 ? '●●' : '●○'}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          {(status === 'QUESTION_READY' || status === 'QUESTION_OPEN') && q && (
            <div className="flex w-full items-center gap-[4vmin]">
              <SceneImage n={q.question_number} />
              <div className="flex min-w-0 flex-1 flex-col items-center">
                <p className="text-[3.6vmin] font-black text-amber-300">Q{q.question_number}. {q.story_title}</p>
                {q.story_text && <p className="mt-1 text-[2.6vmin] text-white/75">{q.story_text}</p>}
                <p className="mt-[1.5vmin] font-display text-[6.5vmin] leading-tight text-white">{q.question_text}</p>
                <div className="mt-[3vmin] flex w-full flex-col gap-[2vmin]">
                  {(['A', 'B'] as const).map((o) => (
                    <div key={o} className={`flex items-center gap-[2vmin] rounded-[3vmin] px-[3vmin] py-[2.2vmin] text-left ${o === 'A' ? 'bg-rose-500 shadow-[0_1vmin_0_#9f1239]' : 'bg-sky-500 shadow-[0_1vmin_0_#075985]'}`}>
                      <span className="font-display text-[8vmin] leading-none text-white/90">{o}</span>
                      <span className="text-[4.4vmin] font-black leading-tight text-white">{o === 'A' ? q.option_a : q.option_b}</span>
                    </div>
                  ))}
                </div>
                <div className="mt-[3vmin] flex flex-wrap items-center justify-center gap-[2vmin]">
                  <span className={`rounded-full px-[3vmin] py-[1vmin] font-display text-[5vmin] tabular-nums
                    ${status === 'QUESTION_OPEN' ? (remaining != null && remaining <= 5 ? 'match-tick bg-rose-500 text-white' : 'bg-white/15 text-white') : 'bg-white/10 text-white/60'}`}
                  >
                    {status === 'QUESTION_OPEN' ? `⏱ ${remaining ?? '-'}초` : `제한 시간 ${q.duration_seconds}초`}
                  </span>
                  {status === 'QUESTION_OPEN' && s.progress && (
                    <span className="rounded-full bg-white/10 px-[3vmin] py-[1vmin] text-[3.2vmin] font-black">
                      응답 완료 <span className="text-pink-300">{s.progress.answered_teams}</span> / {s.progress.team_count}가족
                    </span>
                  )}
                  {status === 'QUESTION_READY' && <span className="text-[3.2vmin] font-black text-emerald-300">곧 응답이 시작됩니다!</span>}
                </div>
              </div>
            </div>
          )}

          {status === 'QUESTION_CLOSED' && (
            <div className="flex w-full items-center gap-[4vmin]">
              {q && <SceneImage n={q.question_number} />}
              <div className="flex min-w-0 flex-1 flex-col items-center">
                {q && <p className="text-[3vmin] font-bold text-white/60">Q{q.question_number}. {q.question_text}</p>}
                <p className="winner-pop mt-[2vmin] font-display text-[7.5vmin] leading-tight text-pink-200">
                  과연 우리 가족의 마음은<br />통했을까요?
                </p>
                {s.progress && (
                  <p className="mt-[3vmin] rounded-full bg-white/10 px-[3vmin] py-[1vmin] text-[3.2vmin] font-black">
                    두 사람 모두 응답한 가족 {s.progress.answered_teams} / {s.progress.team_count}
                  </p>
                )}
              </div>
            </div>
          )}

          {status === 'RESULT_REVEAL' && q && (
            <div className="flex w-full flex-col items-center">
              <p className="text-[3vmin] font-bold text-white/70">Q{q.question_number}. {q.question_text}</p>
              <p className="mt-1 text-[3vmin] font-bold">
                <span className="text-rose-300">A {q.option_a}</span> <span className="text-white/40">vs</span> <span className="text-sky-300">B {q.option_b}</span>
              </p>
              <p className="winner-pop mt-[1vmin] font-display text-[6vmin] text-amber-300">{matchedCount}가족 일심동체!</p>
              <ul className={`mt-[2vmin] grid w-full max-w-[150vmin] gap-[1vmin] text-left ${s.results.length > 8 ? 'grid-cols-2 text-[2.4vmin]' : 'grid-cols-1 text-[3vmin]'}`}>
                {s.results.slice(0, 24).map((r, i) => (
                  <li
                    key={r.team_id}
                    style={{ animationDelay: `${Math.min(i, 20) * 0.35}s` }}
                    className={`rank-in flex items-center gap-[1.5vmin] rounded-[1.6vmin] px-[2vmin] py-[1vmin] ring-1 ${r.matched ? 'bg-amber-400/20 ring-amber-300/50' : 'bg-white/5 ring-white/10'}`}
                  >
                    <span className="min-w-0 flex-1 truncate font-black">{r.team_name}</span>
                    <OptionBadge option={r.option_1} className="min-w-[2.2em]" />
                    <span className="text-white/40">/</span>
                    <OptionBadge option={r.option_2} className="min-w-[2.2em]" />
                    <span className={`w-[14em] shrink-0 text-right font-black ${r.matched ? 'text-amber-200' : 'text-white/60'}`}>→ {screenVerdict(r.matched)}</span>
                  </li>
                ))}
              </ul>
              {s.results.length > 24 && <p className="mt-2 text-[2.2vmin] text-white/50">외 {s.results.length - 24}가족</p>}
            </div>
          )}

          {status === 'GAME_FINISHED' && game && <FinalStage game={game} rows={s.final} />}
        </section>

        {s.standings.length > 0 && status !== 'GAME_FINISHED' && status !== 'LOBBY' && (
          <aside className="w-[34vmin] shrink-0 self-center rounded-[2vmin] bg-white/5 p-[2vmin] ring-1 ring-white/10">
            <p className="mb-[1vmin] text-[2.6vmin] font-black text-pink-200">누적 순위</p>
            <ol className="space-y-[0.6vmin] text-[2.2vmin]">
              {s.standings.slice(0, 10).map((t) => (
                <li key={t.team_id} className="flex items-center gap-[1vmin]">
                  <span className="w-[5vmin] font-bold text-amber-300">{t.rank}위</span>
                  <span className="min-w-0 flex-1 truncate font-bold">{t.team_name}</span>
                  <span className="font-display text-pink-200">{t.score}점</span>
                </li>
              ))}
            </ol>
          </aside>
        )}
      </div>
    </main>
  );
}

function FinalStage({ game, rows }: { game: NonNullable<MatchPublicState['game']>; rows: MatchFinalRow[] }) {
  if (game.final_revealed_rank == null) {
    return (
      <>
        <p className="winner-pop font-display text-[10vmin] leading-tight text-pink-200">최종 집계 완료!</p>
        <p className="mt-3 text-[3.6vmin] font-bold text-white/75">가장 마음이 잘 통한 가족은 누구일까요?</p>
      </>
    );
  }
  if (finalFullyRevealed(game)) {
    const champions = rows.filter((t) => t.rank === 1);
    const others = rows.filter((t) => t.rank !== 1);
    return (
      <div className="flex w-full flex-col items-center">
        <p className="text-[5vmin] font-black text-amber-200">🏆 {champions.length > 1 ? '공동 1위!' : '1위!'}</p>
        {champions.map((t) => (
          <div key={t.team_id} className="winner-pop">
            <p className="font-display text-[13vmin] leading-none text-amber-300 drop-shadow-[0_0_60px_rgba(251,191,36,0.6)]">{t.team_name}</p>
            <p className="mt-[1vmin] font-display text-[5.5vmin] text-pink-200">
              {t.matched_count} / {t.total_questions} 일치 · {formatPercent(t.match_percentage)}
            </p>
          </div>
        ))}
        {champions.length > 1 && <p className="mt-[1vmin] text-[2.8vmin] font-bold text-white/70">동점! 결승전으로 우승 가족을 가립니다</p>}
        {others.length > 0 && (
          <ol className="mt-[3vmin] grid w-full max-w-[120vmin] grid-cols-2 gap-[1vmin] text-left text-[2.4vmin]">
            {others.slice(0, 12).map((t) => <SmallRow key={t.team_id} t={t} />)}
          </ol>
        )}
      </div>
    );
  }
  const step = rows.filter((t) => t.rank <= 3);
  const tail = rows.filter((t) => t.rank > 3);
  return (
    <div className="flex w-full flex-col items-center">
      <p className="mb-[2vmin] text-[4vmin] font-black text-amber-200">{game.final_revealed_rank}위 발표!</p>
      <ol className="w-full max-w-[120vmin] space-y-[1.2vmin]">
        {step.map((t) => (
          <li key={t.team_id} className="rank-in flex items-center gap-[2vmin] rounded-[2vmin] bg-white/10 px-[3vmin] py-[1.6vmin] ring-1 ring-white/15">
            <span className="w-[12vmin] font-display text-[6vmin] text-amber-300">{t.rank}위</span>
            <span className="min-w-0 flex-1 truncate text-left font-display text-[5vmin] text-white">{t.team_name}</span>
            <span className="font-display text-[4.5vmin] text-pink-200">{t.matched_count}/{t.total_questions}</span>
            <span className="w-[14vmin] text-right text-[3vmin] font-bold text-white/70">{formatPercent(t.match_percentage)}</span>
          </li>
        ))}
      </ol>
      {tail.length > 0 && (
        <ol className="mt-[2vmin] grid w-full max-w-[120vmin] grid-cols-3 gap-[1vmin] text-left text-[2.2vmin]">
          {tail.slice(0, 12).map((t) => <SmallRow key={t.team_id} t={t} />)}
        </ol>
      )}
    </div>
  );
}

function SmallRow({ t }: { t: MatchFinalRow }) {
  return (
    <li className="flex items-center gap-[1vmin] rounded-xl bg-white/5 px-[1.5vmin] py-[0.8vmin]">
      <span className="w-[7vmin] font-bold text-amber-300">{t.rank}위</span>
      <span className="min-w-0 flex-1 truncate font-bold">{t.team_name}</span>
      <span className="text-pink-200">{t.matched_count}/{t.total_questions}</span>
    </li>
  );
}

/** The story picture of a question, as large as the 16:9 screen allows. */
function SceneImage({ n }: { n: number }) {
  const [failed, setFailed] = useState<number | null>(null);
  const src = matchImage(n);
  if (!src || failed === n) return null;
  return (
    <div className="flex h-[70vh] w-[55%] shrink-0 items-center justify-center">
      <img
        key={n}
        src={src}
        alt=""
        onError={() => setFailed(n)}
        className="winner-pop max-h-full max-w-full rounded-[3vmin] shadow-[0_2vmin_6vmin_rgba(0,0,0,0.45)]"
      />
    </div>
  );
}
