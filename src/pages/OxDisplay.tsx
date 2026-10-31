import { useCallback, useEffect, useRef, useState } from 'react';
import { Confetti } from '../components/Confetti';
import { ConnectionBadge } from '../components/ConnectionBadge';
import { QrCode } from '../components/QrCode';
import { useLiveSync } from '../hooks/useLiveSync';
import { useAtServerTime, useServerNow } from '../hooks/useServerNow';
import { useSoundState } from '../hooks/useSound';
import { survivalLine } from '../lib/oxView';
import { timed } from '../lib/serverClock';
import { sfx, unlockAudio } from '../lib/sound';
import { errorMessage, publicBaseUrl, rpc } from '../lib/supabase';
import type { OxPublicState } from '../lib/types';

/** /display while the room plays OX SURVIVAL (16:9 projector). Read-only, no credentials. */
export function OxDisplay({ code }: { code: string }) {
  const [roomId, setRoomId] = useState<string | null>(null);
  const [celebrate, setCelebrate] = useState(0);
  const [fast, setFast] = useState(false);
  const { ready } = useSoundState();

  const fetcher = useCallback(() => timed(() => rpc<OxPublicState>('ox_public_state', { p_room_code: code })), [code]);
  const live = useLiveSync<OxPublicState>({
    roomId, fetcher, liveIntervalMs: fast ? 1500 : 4000, pollIntervalMs: 1500, tables: ['rooms', 'ox_games'],
  });
  const s = live.data;
  const game = s?.game ?? null;
  const r = s?.round ?? null;
  const answering = game?.status === 'ANSWERING';

  useEffect(() => {
    if (s?.room.id) setRoomId(s.room.id);
  }, [s?.room.id]);
  // answers emit no realtime events (by design): poll faster while answering is open
  useEffect(() => setFast(answering), [answering]);

  const now = useServerNow(answering, 200);
  useAtServerTime(answering ? r?.deadline_ms : null, () => void live.refresh(), 400);
  const remaining = answering && r?.deadline_ms != null ? Math.max(0, Math.ceil((r.deadline_ms - now) / 1000)) : null;

  // sounds — never for state that was already there on page load
  const prev = useRef<{ status: string; round: string; remaining: number | null } | null>(null);
  const roundKey = r?.id ?? '';
  useEffect(() => {
    if (!s || !game) return;
    const p = prev.current;
    prev.current = { status: game.status, round: roundKey, remaining };
    if (!p) return;
    if (game.status === 'ANSWERING' && (p.status !== 'ANSWERING' || p.round !== roundKey)) sfx.start();
    else if (remaining != null && remaining <= 3 && remaining > 0 && remaining !== p.remaining) sfx.tick();
    else if (game.status === 'ANSWER_CLOSED' && p.status === 'ANSWERING') sfx.chime();
    else if ((game.status === 'RESULT_REVEALED' || game.status === 'ROUND_VOID') && p.status !== game.status) sfx.reveal();
    else if (game.status === 'FINISHED' && p.status !== 'FINISHED') {
      sfx.win();
      if (game.result !== 'ENDED') setCelebrate((c) => c + 1);
    }
  }, [s, game, roundKey, remaining]);

  if (!s) return <main className="stage flex min-h-dvh items-center justify-center text-3xl text-white/70">{live.error ? errorMessage(live.error) : '불러오는 중…'}</main>;

  const status = s.room.status === 'ENDED' ? 'ENDED' : game?.status ?? 'LOBBY';
  const c = s.counts;
  const line = survivalLine(r);
  const answerBig = (a: string | null | undefined) => (
    <span className={a === 'O' ? 'text-sky-300' : 'text-rose-300'}>{a === 'O' ? 'O' : 'X'}</span>
  );

  return (
    <main className="stage relative flex min-h-dvh flex-col overflow-hidden p-[3vmin]" onPointerDown={unlockAudio}>
      {celebrate > 0 && <Confetti key={celebrate} count={200} />}
      <header className="relative flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="font-display text-[5vmin] leading-none text-sky-300">OX SURVIVAL</p>
          <p className="mt-2 truncate text-[2.6vmin] font-bold text-white/70">
            {game && game.current_round > 0
              ? <>ROUND {game.current_round} · 생존 {c.alive} / {c.initial}명</>
              : <>참가 대기 {s.lobby.length}명</>}
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

      <section className="relative flex min-h-0 flex-1 flex-col items-center justify-center text-center">
        {status === 'ENDED' && <p className="font-display text-[11vmin] text-white/85">게임 종료</p>}

        {status === 'LOBBY' && (
          <>
            <p className="font-display text-[16vmin] leading-none">
              <span className="text-sky-300">O</span><span className="mx-[3vmin] text-white/30">/</span><span className="text-rose-300">X</span>
            </p>
            <p className="mt-[2vmin] font-display text-[6vmin] text-white">최후의 1인을 찾아라!</p>
            <p className="mt-[1.5vmin] text-[3vmin] font-bold text-white/75">
              사회자의 문제를 듣고 O 또는 X! 틀리면 탈락, 마지막까지 살아남으면 우승!
            </p>
            {s.lobby.length > 0 && (
              <ul className="mt-[3vmin] flex max-w-[90vw] flex-wrap justify-center gap-[1.2vmin]">
                {s.lobby.map((n, i) => (
                  <li key={`${n}-${i}`} className="rounded-full bg-sky-400/20 px-[2vmin] py-[0.8vmin] text-[2.6vmin] font-black text-sky-100">{n}</li>
                ))}
              </ul>
            )}
          </>
        )}

        {status === 'ROUND_READY' && game && (
          <>
            <p className="winner-pop font-display text-[18vmin] leading-none text-white">ROUND {game.current_round}</p>
            <p className="mt-[2vmin] text-[5vmin] font-black text-emerald-300">현재 참가자 {c.alive}명</p>
            <p className="mt-[3vmin] font-display text-[6vmin] text-amber-200">사회자의 문제를 들어주세요!</p>
          </>
        )}

        {status === 'ANSWERING' && game && (
          <>
            <p className="font-display text-[6vmin] text-white/85">ROUND {game.current_round}</p>
            <div className="mt-[1vmin] flex items-center gap-[6vmin]">
              <span className="flex h-[38vmin] w-[38vmin] items-center justify-center rounded-[5vmin] bg-sky-500 font-display text-[30vmin] leading-none text-white shadow-[0_1.5vmin_0_#075985]">O</span>
              <span className={`flex h-[20vmin] w-[20vmin] items-center justify-center rounded-full font-display text-[11vmin] tabular-nums
                ${remaining != null && remaining <= 3 ? 'match-tick bg-rose-500 text-white' : 'bg-white/15 text-white'}`}
              >
                {remaining ?? '-'}
              </span>
              <span className="flex h-[38vmin] w-[38vmin] items-center justify-center rounded-[5vmin] bg-rose-500 font-display text-[30vmin] leading-none text-white shadow-[0_1.5vmin_0_#9f1239]">X</span>
            </div>
            <p className="mt-[3vmin] rounded-full bg-white/10 px-[4vmin] py-[1.2vmin] text-[4vmin] font-black">
              응답 완료 <span className="text-sky-300">{c.answered}</span> / {c.alive}명
            </p>
          </>
        )}

        {status === 'ANSWER_CLOSED' && (
          <>
            <p className="winner-pop font-display text-[14vmin] leading-tight text-amber-300">응답 마감!</p>
            <p className="mt-[2vmin] font-display text-[8vmin] text-white">과연 정답은?</p>
            <p className="mt-[3vmin] text-[3.4vmin] font-bold text-white/70">응답 {c.answered} / {c.alive}명</p>
          </>
        )}

        {status === 'RESULT_REVEALED' && r && (
          <>
            <p className="winner-pop font-display text-[16vmin] leading-none text-white">정답은 {answerBig(r.correct_answer)}!</p>
            {line && (
              <>
                <p className="rank-in mt-[3vmin] font-display text-[8vmin] text-emerald-300" style={{ animationDelay: '0.6s' }}>{line.survived}</p>
                <p className="rank-in font-display text-[6vmin] text-slate-300" style={{ animationDelay: '1.2s' }}>{line.eliminated}명 탈락!</p>
              </>
            )}
            {game?.result === 'CHAMPION' && (
              <p className="rank-in mt-[2vmin] text-[5vmin] font-black text-amber-300" style={{ animationDelay: '1.8s' }}>👑 최후의 1인 탄생!</p>
            )}
            {s.survivors.length > 0 && game?.result !== 'CHAMPION' && (
              <ul className="rank-in mt-[3vmin] flex max-w-[90vw] flex-wrap justify-center gap-[1.2vmin]" style={{ animationDelay: '1.8s' }}>
                {s.survivors.map((n) => (
                  <li key={n} className="rounded-full bg-emerald-400/20 px-[2vmin] py-[0.8vmin] text-[3vmin] font-black text-emerald-100">{n}</li>
                ))}
              </ul>
            )}
          </>
        )}

        {status === 'ROUND_VOID' && r && (
          <>
            <p className="font-display text-[10vmin] leading-none text-white">정답은 {answerBig(r.correct_answer)}!</p>
            <p className="winner-pop mt-[3vmin] font-display text-[10vmin] text-amber-300">전원 오답!</p>
            <p className="mt-[2vmin] text-[4.4vmin] font-black text-white/85">이번 라운드는 무효 — {r.survivors_before}명 모두 살아남아 재경기!</p>
          </>
        )}

        {status === 'FINISHED' && game && (
          <>
            <p className="font-display text-[12vmin] leading-none text-amber-300 drop-shadow-[0_0_60px_rgba(251,191,36,0.6)]">
              {game.result === 'CHAMPION' ? 'CHAMPION' : game.result === 'CO_WINNERS' ? 'CO-CHAMPIONS' : '게임 종료'}
            </p>
            {game.result !== 'CHAMPION' && (
              <p className="mt-[1vmin] text-[4vmin] font-black text-white/80">{game.result === 'CO_WINNERS' ? '공동 우승!' : '최종 생존자'}</p>
            )}
            <ul className="mt-[3vmin] flex max-w-[92vw] flex-wrap justify-center gap-[3vmin]">
              {s.winners.map((n) => (
                <li
                  key={n}
                  className={`winner-pop font-display leading-none text-amber-200 ${s.winners.length === 1 ? 'text-[18vmin]' : s.winners.length <= 4 ? 'text-[9vmin]' : 'text-[5vmin]'}`}
                >
                  {s.winners.length > 1 && '🏆 '}{n}
                </li>
              ))}
            </ul>
            {c.initial != null && <p className="mt-[3vmin] text-[3vmin] font-bold text-white/60">{c.initial}명 중 최후의 {s.winners.length}명 · {game.current_round}라운드</p>}
          </>
        )}
      </section>
    </main>
  );
}
