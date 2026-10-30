import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Confetti } from '../components/Confetti';
import { ConnectionBadge } from '../components/ConnectionBadge';
import { QrCode } from '../components/QrCode';
import { useLiveSync } from '../hooks/useLiveSync';
import { useSoundState } from '../hooks/useSound';
import { useWakeLock } from '../hooks/useWakeLock';
import { sfx, unlockAudio } from '../lib/sound';
import { errorMessage, publicBaseUrl, rpc } from '../lib/supabase';
import type { PublicState } from '../lib/types';
import { MatchDisplay } from './MatchDisplay';
import { SyncDisplay } from './SyncDisplay';

/** Read-only big-screen view. Needs no credentials at all. */
export function DisplayPage() {
  const { roomCode: param } = useParams();
  const [code, setCode] = useState<string | null>(param?.toUpperCase() ?? null);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [celebrate, setCelebrate] = useState(0);
  const { ready } = useSoundState();
  useWakeLock(true);

  useEffect(() => {
    if (code) return;
    rpc<{ room_code: string } | null>('get_latest_room').then((r) => r && setCode(r.room_code)).catch(() => {});
  }, [code]);

  const fetcher = useCallback(() => rpc<PublicState>('get_public_state', { p_room_code: code }), [code]);
  const live = useLiveSync<PublicState>({ roomId, fetcher, enabled: !!code, liveIntervalMs: 5000 });
  const s = live.data;
  const round = s?.round;

  useEffect(() => {
    if (s?.room.id) setRoomId(s.room.id);
  }, [s?.room.id]);

  const winnerKey = round?.winner_nickname ? `${round.id}:${round.winner_nickname}:${round.winner_at}` : '';
  const prev = useRef<string | null>(null);
  const prevStatus = useRef<string | null>(null);
  useEffect(() => {
    if (!s) return; // don't celebrate a winner that was already there on page load
    if (prev.current !== null && winnerKey && winnerKey !== prev.current) {
      sfx.win();
      setCelebrate((c) => c + 1);
    } else if (prevStatus.current !== null && round?.status === 'ARMED' && prevStatus.current !== 'ARMED') {
      sfx.start();
    }
    prev.current = winnerKey;
    prevStatus.current = round?.status ?? null;
  }, [s, winnerKey, round?.status]);

  if (!code) return <main className="stage flex min-h-dvh items-center justify-center text-3xl text-white/70">진행 중인 퀴즈방이 없습니다</main>;
  if (!s) return <main className="stage flex min-h-dvh items-center justify-center text-3xl text-white/70">{live.error ? errorMessage(live.error) : '불러오는 중…'}</main>;

  if (s.room.mode === 'SYNC') return <SyncDisplay code={s.room.room_code} />;
  if (s.room.mode === 'MATCH') return <MatchDisplay code={s.room.room_code} />;

  const status = s.room.status === 'ENDED' ? 'ENDED' : round?.status;
  const headline =
    status === 'ENDED' ? '게임 종료' : status === 'ARMED' ? '지금 누르세요!' : status === 'READY' ? '곧 시작합니다' : status === 'LOCKED' ? '부저 잠김' : '사회자가 준비 중입니다';

  return (
    <main className="stage relative flex min-h-dvh flex-col overflow-hidden p-[3vmin]" onPointerDown={unlockAudio}>
      {celebrate > 0 && <Confetti key={celebrate} count={160} />}
      <header className="flex items-start justify-between">
        <div>
          <p className="font-display text-[5vmin] leading-none text-amber-300">FM FAMILY QUIZ</p>
          <p className="mt-2 text-[2.6vmin] font-bold text-white/70">
            ROUND {round?.round_number ?? '-'} · 참가자 {s.participant_count}명
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
        {round?.winner_nickname ? (
          <>
            <p className="text-[6vmin] font-black text-amber-200">🏆 1등!</p>
            <p className="winner-pop font-display text-[18vmin] leading-none text-amber-300 drop-shadow-[0_0_60px_rgba(251,191,36,0.6)]">
              {round.winner_nickname}
            </p>
          </>
        ) : (
          <p className={`font-display text-[11vmin] leading-tight ${status === 'ARMED' ? 'buzzer-text-pulse text-rose-400' : status === 'READY' ? 'text-emerald-300' : 'text-white/85'}`}>
            {headline}
          </p>
        )}
      </section>

      {s.recent_winners.length > 0 && (
        <footer className="flex flex-wrap justify-center gap-3 text-[2.4vmin]">
          {s.recent_winners.map((w) => (
            <span key={w.round_number} className="rounded-full bg-white/10 px-4 py-1.5 font-bold">
              R{w.round_number} <span className="text-amber-300">{w.winner_nickname}</span>
            </span>
          ))}
        </footer>
      )}
    </main>
  );
}
