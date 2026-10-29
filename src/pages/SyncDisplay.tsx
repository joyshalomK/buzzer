import { useCallback, useEffect, useRef, useState } from 'react';
import { Confetti } from '../components/Confetti';
import { ConnectionBadge } from '../components/ConnectionBadge';
import { QrCode } from '../components/QrCode';
import { useLiveSync } from '../hooks/useLiveSync';
import { useAtServerTime, useServerNow } from '../hooks/useServerNow';
import { useSoundState } from '../hooks/useSound';
import { timed } from '../lib/serverClock';
import { sfx, unlockAudio } from '../lib/sound';
import { errorMessage, publicBaseUrl, rpc } from '../lib/supabase';
import { STATUS_LABEL_KO, formatMs, formatSeconds, fullyRevealed } from '../lib/syncView';
import type { SyncPublicState, SyncTeamResult } from '../lib/types';

/** /display while the room plays FAMILY SYNC. Read-only, no credentials. */
export function SyncDisplay({ code }: { code: string }) {
  const [roomId, setRoomId] = useState<string | null>(null);
  const [fast, setFast] = useState(false);
  const [celebrate, setCelebrate] = useState(0);
  const { ready } = useSoundState();

  const fetcher = useCallback(() => timed(() => rpc<SyncPublicState>('sync_public_state', { p_room_code: code })), [code]);
  const live = useLiveSync<SyncPublicState>({ roomId, fetcher, liveIntervalMs: fast ? 1000 : 4000, pollIntervalMs: 1500 });
  const s = live.data;
  const round = s?.round ?? null;
  const running = round?.status === 'RUNNING';

  useEffect(() => {
    if (s?.room.id) setRoomId(s.room.id);
  }, [s?.room.id]);
  // progress numbers change without a realtime event: poll faster around the game
  useEffect(() => setFast(running || round?.status === 'FINISHED'), [running, round?.status]);

  const now = useServerNow(running);
  useAtServerTime(running ? round?.deadline_ms : null, () => void live.refresh(), 400);

  const countdown = running && round?.started_ms != null && now < round.started_ms
    ? Math.max(1, Math.ceil((round.started_ms - now) / 1000)) : null;
  const go = running && round?.started_ms != null && round.deadline_ms != null && now >= round.started_ms && now <= round.deadline_ms;

  // sounds — never for state that was already there on page load
  const prev = useRef<{ countdown: number | null; go: boolean; reveal: string } | null>(null);
  const revealKey = `${round?.id}:${round?.revealed_rank ?? ''}`;
  useEffect(() => {
    if (!s) return;
    const p = prev.current;
    prev.current = { countdown, go, reveal: revealKey };
    if (!p) return;
    if (countdown != null && countdown !== p.countdown) sfx.tick();
    else if (go && !p.go) sfx.start();
    else if (revealKey !== p.reveal && round?.revealed_rank != null) {
      if (round.revealed_rank === 1) {
        sfx.win();
        setCelebrate((c) => c + 1);
      } else sfx.reveal();
    }
  }, [s, countdown, go, revealKey, round?.revealed_rank]);

  if (!s) return <main className="stage flex min-h-dvh items-center justify-center text-3xl text-white/70">{live.error ? errorMessage(live.error) : '불러오는 중…'}</main>;

  const status = s.room.status === 'ENDED' ? 'ENDED' : round?.status ?? 'WAITING';
  const all = fullyRevealed(round);
  const champions = all ? s.results.filter((t) => t.rank === 1) : [];
  const others = all ? s.results.filter((t) => t.rank !== 1) : [];
  const stepCards = !all ? s.results.filter((t) => t.rank != null && t.rank <= 5) : [];
  const tail = !all ? s.results.filter((t) => t.rank != null && t.rank > 5) : [];

  return (
    <main className="stage relative flex min-h-dvh flex-col overflow-hidden p-[3vmin]" onPointerDown={unlockAudio}>
      {celebrate > 0 && <Confetti key={celebrate} count={180} />}
      <header className="flex items-start justify-between">
        <div>
          <p className="font-display text-[5vmin] leading-none text-cyan-300">FAMILY SYNC CHALLENGE</p>
          <p className="mt-2 text-[2.6vmin] font-bold text-white/70">
            ROUND {round?.round_number ?? '-'} · {s.teams.length}가족 참가
            {round?.team_ids && <span className="ml-3 rounded-full bg-amber-400/20 px-3 text-amber-200">동점 재경기</span>}
          </p>
        </div>
        <div className="flex items-start gap-4">
          <div className="flex flex-col items-end gap-2">
            <ConnectionBadge connected={live.connected} realtime={live.realtime} />
            {!ready && <span className="text-sm text-white/50">클릭하면 소리가 켜집니다</span>}
          </div>
          <div className="text-center">
            <QrCode text={`${publicBaseUrl()}/room/${s.room.room_code}`} size={150} />
            <p className="mt-1 font-display text-[3vmin] tracking-[0.25em]">{s.room.room_code}</p>
          </div>
        </div>
      </header>

      {s.room.announcement && (
        <p className="mx-auto mt-4 rounded-3xl bg-amber-300/15 px-8 py-3 text-center text-[3.2vmin] font-bold text-amber-50 ring-1 ring-amber-300/40">
          📢 {s.room.announcement}
        </p>
      )}

      <section className="flex flex-1 flex-col items-center justify-center text-center">
        {status === 'ENDED' && <p className="font-display text-[11vmin] text-white/85">게임 종료</p>}

        {(status === 'WAITING' || status === 'READY') && (
          <>
            <p className={`font-display text-[10vmin] leading-tight ${status === 'READY' ? 'text-emerald-300' : 'text-white/90'}`}>
              {status === 'READY' ? '곧 시작합니다' : '가족 팀 모집 중'}
            </p>
            <p className="mt-2 text-[3vmin] font-bold text-white/70">신호가 나오면 10초 안에, 파트너와 최대한 같은 순간에 누르세요!</p>
            {s.teams.length > 0 && (
              <ul className="mt-[3vmin] flex max-w-[90vw] flex-wrap justify-center gap-[1.2vmin]">
                {s.teams.map((t) => (
                  <li key={t.team_name} className={`rounded-full px-[2vmin] py-[0.8vmin] text-[2.6vmin] font-black ${t.members >= 2 ? 'bg-cyan-400/20 text-cyan-100' : 'bg-white/10 text-white/60'}`}>
                    {t.team_name} {t.members >= 2 ? '●●' : '●○'}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        {status === 'RUNNING' && (
          countdown != null ? (
            <p key={countdown} className="winner-pop font-display text-[30vmin] leading-none text-amber-300">{countdown}</p>
          ) : (
            <div className="relative flex items-center justify-center">
              <div className="sync-orbit absolute h-[46vmin] w-[46vmin] rounded-full border-[1.2vmin] border-dashed border-cyan-300/50" />
              <div className="sync-ring flex h-[36vmin] w-[36vmin] items-center justify-center rounded-full bg-gradient-to-b from-cyan-300 to-sky-600">
                <span className="font-display text-[11vmin] text-white drop-shadow">{go ? 'SYNC!' : '마감'}</span>
              </div>
            </div>
          )
        )}

        {status === 'FINISHED' && (
          <>
            <p className="winner-pop font-display text-[11vmin] leading-tight text-cyan-200">결과 집계 완료</p>
            <p className="mt-3 text-[3.4vmin] font-bold text-white/70">사회자가 곧 순위를 공개합니다</p>
          </>
        )}

        {(status === 'RUNNING' || status === 'FINISHED') && s.progress && (
          <p className="mt-[4vmin] rounded-full bg-white/10 px-[3vmin] py-[1vmin] text-[3.4vmin] font-black">
            입력 완료 <span className="text-cyan-300">{s.progress.pressed}</span> / {s.progress.expected}명
          </p>
        )}

        {status === 'RESULTS' && all && (
          <div className="flex w-full flex-col items-center">
            {champions.length > 0 ? (
              <>
                <p className="text-[5vmin] font-black text-amber-200">🏆 {champions.length > 1 ? '공동 1위!' : '1위!'}</p>
                {champions.map((t) => (
                  <div key={t.team_id} className="winner-pop">
                    <p className="font-display text-[14vmin] leading-none text-amber-300 drop-shadow-[0_0_60px_rgba(251,191,36,0.6)]">{t.team_name}</p>
                    <p className="mt-[1vmin] font-display text-[6vmin] text-cyan-200">차이 {formatMs(t.gap_ms)}</p>
                    <p className="text-[2.8vmin] font-bold text-white/75">{t.members.map((m) => `${m.label} ${formatSeconds(m.elapsed_ms)}`).join('  ·  ')}</p>
                  </div>
                ))}
              </>
            ) : (
              <p className="font-display text-[8vmin] text-white/80">완료한 팀이 없습니다</p>
            )}
            {others.length > 0 && (
              <ol className="mt-[3vmin] grid w-full max-w-[110vmin] grid-cols-2 gap-[1vmin] text-left text-[2.4vmin]">
                {others.slice(0, 12).map((t) => <SmallRow key={t.team_id} t={t} />)}
              </ol>
            )}
          </div>
        )}

        {status === 'RESULTS' && !all && (
          <div className="flex w-full flex-col items-center">
            <p className="mb-[2vmin] text-[4vmin] font-black text-amber-200">{round?.revealed_rank}위 발표!</p>
            <ol className="w-full max-w-[110vmin] space-y-[1.2vmin]">
              {stepCards.map((t) => (
                <li key={t.team_id} className="rank-in flex items-center gap-[2vmin] rounded-[2vmin] bg-white/10 px-[3vmin] py-[1.6vmin] ring-1 ring-white/15">
                  <span className="w-[12vmin] font-display text-[6vmin] text-amber-300">{t.rank}위</span>
                  <span className="min-w-0 flex-1 text-left">
                    <span className="block truncate font-display text-[5vmin] text-white">{t.team_name}</span>
                    <span className="block truncate text-[2.4vmin] text-white/65">{t.members.map((m) => `${m.label} ${formatSeconds(m.elapsed_ms)}`).join(' · ')}</span>
                  </span>
                  <span className="font-display text-[5vmin] text-cyan-200">{formatMs(t.gap_ms)}</span>
                </li>
              ))}
            </ol>
            {tail.length > 0 && (
              <ol className="mt-[2vmin] grid w-full max-w-[110vmin] grid-cols-3 gap-[1vmin] text-left text-[2.2vmin]">
                {tail.slice(0, 12).map((t) => <SmallRow key={t.team_id} t={t} />)}
              </ol>
            )}
          </div>
        )}
      </section>
    </main>
  );
}

function SmallRow({ t }: { t: SyncTeamResult }) {
  return (
    <li className="flex items-center gap-[1vmin] rounded-xl bg-white/5 px-[1.5vmin] py-[0.8vmin]">
      <span className="w-[7vmin] font-bold text-amber-300">{t.rank != null ? `${t.rank}위` : '–'}</span>
      <span className="min-w-0 flex-1 truncate font-bold">{t.team_name}</span>
      <span className="text-cyan-200">{t.status === 'COMPLETE' ? formatMs(t.gap_ms) : STATUS_LABEL_KO[t.status]}</span>
    </li>
  );
}
