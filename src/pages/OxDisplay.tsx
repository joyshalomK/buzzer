import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Confetti } from '../components/Confetti';
import { ConnectionBadge } from '../components/ConnectionBadge';
import { OxAvatar } from '../components/OxAvatar';
import { QrCode } from '../components/QrCode';
import { useLiveSync } from '../hooks/useLiveSync';
import { useAtServerTime, useServerNow } from '../hooks/useServerNow';
import { useSoundState } from '../hooks/useSound';
import {
  BODY_RATIO, CHAMPION_STEPS, REVEAL_STEPS, SlotBook, VOID_STEPS, exitPoint, gridFor, slotPoint, stageTargets, stepAt,
  type Mood, type StageEntry,
} from '../lib/oxStage';
import { OX_STATUS_LABEL, survivalLine } from '../lib/oxView';
import { serverClock, timed } from '../lib/serverClock';
import { sfx, unlockAudio } from '../lib/sound';
import { errorMessage, publicBaseUrl, rpc } from '../lib/supabase';
import type { OxAnswer, OxGame, OxPublicState, OxRound } from '../lib/types';

type Move = { round_id: string; avatar_key: string; pick: OxAnswer };

/**
 * /display while the room plays OX SURVIVAL (16:9 projector). Every player is
 * a small character that walks to the O or X side when they answer; at the
 * reveal the server's verdicts decide who cheers and who walks off.
 * Read-only, no credentials.
 */
export function OxDisplay({ code }: { code: string }) {
  const [roomId, setRoomId] = useState<string | null>(null);
  const { ready } = useSoundState();

  const fetcher = useCallback(() => timed(() => rpc<OxPublicState>('ox_public_state', { p_room_code: code })), [code]);
  const [answeringNow, setAnsweringNow] = useState(false);
  const live = useLiveSync<OxPublicState>({
    roomId, fetcher,
    liveIntervalMs: answeringNow ? 1500 : 4000,
    pollIntervalMs: answeringNow ? 700 : 1500,
    tables: ['rooms', 'ox_games', 'ox_stage_moves'],
    // an answer arrived: move that character now; the follow-up fetch confirms it
    onChange: (change, table) => {
      if (table !== 'ox_stage_moves') return;
      const m = change.new as unknown as Move;
      if (!m?.avatar_key) return;
      live.setData((d) =>
        d && d.round?.id === m.round_id && d.game?.status === 'ANSWERING'
          ? { ...d, stage: d.stage.map((e) => (e.key === m.avatar_key ? { ...e, pick: m.pick } : e)) }
          : d,
      );
    },
  });
  const s = live.data;
  const game = s?.game ?? null;
  const r = s?.round ?? null;
  const status = s ? (s.room.status === 'ENDED' ? 'ENDED' : game?.status ?? 'LOBBY') : 'LOADING';

  useEffect(() => {
    if (s?.room.id) setRoomId(s.room.id);
  }, [s?.room.id]);
  useEffect(() => setAnsweringNow(status === 'ANSWERING'), [status]);
  useAtServerTime(status === 'ANSWERING' ? r?.deadline_ms : null, () => void live.refresh(), 400);

  // timelines start when this screen first sees the event; after a reload, at the server time
  const anchor = useEventAnchor(
    !!s,
    !s ? null
    : (status === 'RESULT_REVEALED' || status === 'ROUND_VOID') && r?.revealed_ms ? { key: `r:${r.id}`, serverMs: r.revealed_ms }
    : status === 'FINISHED' && game?.finished_at ? { key: `f:${game.id}`, serverMs: Date.parse(game.finished_at) }
    : null,
  );
  const steps = status === 'ROUND_VOID' ? VOID_STEPS : status === 'FINISHED' ? CHAMPION_STEPS : REVEAL_STEPS;
  const { step, elapsed } = useStep(anchor, steps);

  // sounds and confetti, only for things this screen saw happen
  const [confetti, setConfetti] = useState(0);
  const prev = useRef<{ status: string; step: number; round: string } | null>(null);
  useEffect(() => {
    if (!s) return;
    const p = prev.current;
    const roundKey = r?.id ?? '';
    prev.current = { status, step, round: roundKey };
    if (!p) return;
    if (status === 'ANSWERING' && (p.status !== 'ANSWERING' || p.round !== roundKey)) sfx.start();
    else if (status === 'ANSWER_CLOSED' && p.status === 'ANSWERING') sfx.chime();
    else if ((status === 'RESULT_REVEALED' || status === 'ROUND_VOID') && step === 1 && (p.step !== 1 || p.status !== status)) sfx.reveal();
    else if (status === 'FINISHED' && game?.result !== 'ENDED' && step === 3 && p.step !== 3 && elapsed < 9000) {
      sfx.win();
      setConfetti((c) => c + 1);
    }
  }, [s, status, step, r?.id, game?.result, elapsed]);

  if (!s) return <main className="stage flex min-h-dvh items-center justify-center text-3xl text-white/70">{live.error ? errorMessage(live.error) : '불러오는 중…'}</main>;

  const c = s.counts;
  const answering = status === 'ANSWERING';

  return (
    <main className="stage relative flex h-dvh flex-col overflow-hidden px-[2vmin] pb-[1.5vmin] pt-[1.5vmin]" onPointerDown={unlockAudio}>
      {confetti > 0 && <Confetti key={confetti} count={220} />}

      {/* ---------- header ---------- */}
      <header className="relative z-20 flex items-center justify-between gap-[2vmin]">
        <div className="flex min-w-0 items-baseline gap-[2.5vmin]">
          <p className="font-display text-[5vmin] leading-none text-sky-300 drop-shadow">OX SURVIVAL</p>
          {game && game.current_round > 0 && (
            <>
              <p className="font-display text-[4vmin] leading-none text-white">ROUND {game.current_round}</p>
              <p className="text-[2.8vmin] font-black text-emerald-300">생존 {c.alive}명</p>
            </>
          )}
          {status === 'LOBBY' && <p className="text-[2.8vmin] font-black text-white/80">참가 대기 {s.stage.length}명</p>}
        </div>
        <div className="flex shrink-0 items-center gap-[2vmin]">
          {answering && r?.deadline_ms != null && <Countdown deadline={r.deadline_ms} />}
          <div className="flex flex-col items-end gap-1">
            <ConnectionBadge connected={live.connected} realtime={live.realtime} />
            {!ready && <span className="text-xs text-white/50">클릭하면 소리가 켜집니다</span>}
          </div>
          <div className="text-center">
            <QrCode text={`${publicBaseUrl()}/room/${s.room.room_code}`} size={status === 'LOBBY' ? 120 : 72} />
            <p className="font-display text-[2.2vmin] tracking-[0.25em]">{s.room.room_code}</p>
          </div>
        </div>
      </header>

      {s.room.announcement && (
        <p className="relative z-20 mx-auto mt-1 rounded-3xl bg-amber-300/15 px-8 py-1 text-center text-[2.6vmin] font-bold text-amber-50 ring-1 ring-amber-300/40">
          📢 {s.room.announcement}
        </p>
      )}

      {/* ---------- stage ---------- */}
      {status === 'ENDED' ? (
        <section className="flex flex-1 items-center justify-center font-display text-[11vmin] text-white/85">게임 종료</section>
      ) : (
        <Stage s={s} game={game} round={r} status={status} step={step} />
      )}

      {/* ---------- footer ---------- */}
      <footer className="relative z-20 mt-[1vmin] flex items-center justify-between gap-4 rounded-full bg-black/30 px-[3vmin] py-[0.8vmin] text-[2.4vmin] font-bold">
        <span>
          {(answering || status === 'ANSWER_CLOSED') ? <>응답 완료 <span className="text-sky-300">{c.answered}</span> / {c.alive}명</>
            : game && game.current_round > 0 ? <>최초 {c.initial}명 · 생존 {c.alive}명 · 탈락 {c.eliminated}명</>
            : <>참가 예정 {s.stage.length}명</>}
        </span>
        <span className="rounded-full bg-white/10 px-4 py-0.5 text-white/85">{game ? OX_STATUS_LABEL[game.status] : ''}</span>
        <span className="text-white/60">{hostGuide(game, r)}</span>
      </footer>
    </main>
  );
}

function hostGuide(g: OxGame | null, r: OxRound | null) {
  switch (g?.status) {
    case 'LOBBY': return '사회자: 참가자가 모이면 "게임 시작"';
    case 'ROUND_READY': return r?.answer_set ? '사회자: 문제를 읽고 "응답 시작"' : '사회자: 정답 O/X를 먼저 저장해 주세요';
    case 'ANSWERING': return '휴대폰에서 O 또는 X를 누르면 내 캐릭터가 이동해요!';
    case 'ANSWER_CLOSED': return '사회자: "정답 공개 및 결과 확정"';
    case 'RESULT_REVEALED': return g.result === 'CHAMPION' ? '사회자: "우승자 발표"' : '사회자: "다음 라운드" 또는 "공동 우승 확정"';
    case 'ROUND_VOID': return '사회자: "재경기"';
    case 'FINISHED': return '함께해 주셔서 감사합니다!';
    default: return '';
  }
}

// ---------------------------------------------------------------------------

/** Isolated so the per-second tick never re-renders the stage. */
function Countdown({ deadline }: { deadline: number }) {
  const now = useServerNow(true, 200);
  const left = Math.max(0, Math.ceil((deadline - now) / 1000));
  return (
    <span className={`flex h-[8vmin] min-w-[8vmin] items-center justify-center rounded-full px-[1.5vmin] font-display text-[5vmin] tabular-nums
      ${left <= 3 ? 'match-tick bg-rose-500 text-white' : 'bg-white/15 text-white'}`}
    >
      {left}
    </span>
  );
}

/**
 * Start time (server clock) of the event `ev`: the server time when the
 * page was loaded with the event already there, otherwise the moment this
 * page first saw it — so the full sequence plays even if the event reached
 * the screen a moment late.
 */
function useEventAnchor(ready: boolean, ev: { key: string; serverMs: number } | null) {
  const seen = useRef(new Map<string, number>());
  const loaded = useRef(false);
  if (!ready) return null;
  if (!ev) {
    loaded.current = true;
    return null;
  }
  let a = seen.current.get(ev.key);
  if (a == null) {
    a = loaded.current ? Math.max(ev.serverMs, serverClock.now()) : ev.serverMs;
    seen.current.set(ev.key, a);
  }
  loaded.current = true;
  return a;
}

/** Current step of a timeline, re-rendering exactly at each step boundary. */
function useStep(anchor: number | null, steps: number[]) {
  const [, tick] = useState(0);
  const elapsed = anchor == null ? Infinity : serverClock.now() - anchor;
  const step = anchor == null ? steps.length - 1 : stepAt(elapsed, steps);
  useEffect(() => {
    if (anchor == null) return;
    const next = steps.find((t) => t > serverClock.now() - anchor);
    if (next == null) return;
    const id = window.setTimeout(() => tick((n) => n + 1), next - (serverClock.now() - anchor) + 15);
    return () => window.clearTimeout(id);
  });
  return { step, elapsed };
}

// ---------------------------------------------------------------------------

function Stage({ s, game, round, status, step }: {
  s: OxPublicState;
  game: OxGame | null;
  round: OxRound | null;
  status: string;
  step: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [dim, setDim] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setDim({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const gs = (game?.status ?? 'LOBBY') as Parameters<typeof stageTargets>[0];
  const entries: StageEntry[] = s.stage;
  const targets = useMemo(() => stageTargets(gs, game?.result ?? null, entries, step), [gs, game?.result, entries, step]);

  // one slot book per round (and stage size class): slots never reflow inside a round
  const n = entries.length;
  const bookKey = `${game?.id}:${round?.id ?? 'lobby'}:${n}`;
  const book = useRef<{ key: string; book: SlotBook }>({ key: '', book: new SlotBook() });
  if (book.current.key !== bookKey) book.current = { key: bookKey, book: new SlotBook() };

  const placed = useMemo(() => {
    const { w, h } = dim;
    if (!w || !h) return [];
    const g = gridFor(n, w, h);
    const winners = targets.filter((t) => t.place === 'CHAMPION');
    const big = winners.length === 1 ? h * 0.27 : winners.length <= 3 ? h * 0.26 : winners.length <= 6 ? h * 0.17 : g.size;
    const keys = new Set(targets.map((t) => t.key));
    book.current.book.keepOnly(keys);
    return targets.map((t) => {
      let x: number;
      let y: number;
      let scale = 1;
      if (t.place === 'EXIT') ({ x, y } = exitPoint(t.key, w, h));
      else if (t.place === 'CHAMPION') {
        const i = winners.findIndex((x) => x.key === t.key);
        const span = Math.min(w * 0.8, winners.length * big * 1.6);
        x = w / 2 - span / 2 + (i + 0.5) * (span / winners.length);
        // a lone champion's name is the banner; joint winners keep their labels, so stand higher
        y = winners.length === 1 ? h * 0.97 : h * 0.84;
        scale = big / g.size;
      } else ({ x, y } = slotPoint(t.place, book.current.book.place(t.key, t.place), g, w, h, t.key));
      return { t, x, y, scale, size: g.size, nameW: g.cellW * 0.96 };
    });
  }, [targets, dim, n]);

  const answer = round?.correct_answer ?? null;
  const tense = status === 'ANSWER_CLOSED' || ((status === 'RESULT_REVEALED' || status === 'ROUND_VOID') && step === 0);
  const shown = (status === 'RESULT_REVEALED' || status === 'ROUND_VOID') && step >= 1;
  const zoneState = (z: 'O' | 'X') =>
    status === 'FINISHED' ? 'dim' : tense ? 'dim' : shown && status === 'RESULT_REVEALED' ? (answer === z ? 'glow' : 'dim') : '';

  return (
    <section ref={box} className="relative mt-[1vmin] min-h-0 flex-1 overflow-hidden rounded-[3vmin] ring-1 ring-white/15"
      style={{ background: 'radial-gradient(ellipse at 50% 0%, rgba(255,255,255,0.18), transparent 55%), linear-gradient(180deg, #3b2f86 0%, #24215e 55%, #1a1747 100%)' }}
    >
      {/* spotlights */}
      <div aria-hidden className="pointer-events-none absolute inset-0" style={{ background: 'radial-gradient(circle at 18% -5%, rgba(250,204,21,0.22), transparent 35%), radial-gradient(circle at 82% -5%, rgba(244,114,182,0.22), transparent 35%)' }} />

      {/* zones */}
      <Zone side="O" state={zoneState('O')} />
      <div className={`ox-zone absolute bottom-[2%] left-[35%] right-[35%] top-[3%] rounded-[3vmin] border-[0.4vmin] border-dashed border-white/25 bg-white/[0.06] ${status === 'FINISHED' ? 'border-amber-300/60 bg-amber-300/10' : ''}`}>
        <p className="absolute bottom-[1%] left-0 right-0 text-center text-[1.8vmin] font-black tracking-[0.3em] text-white/35">WAITING ZONE</p>
      </div>
      <Zone side="X" state={zoneState('X')} />
      {/* exit corridor */}
      <div aria-hidden className="absolute bottom-0 left-[44%] right-[44%] h-[2.2%] rounded-t-full bg-black/40" />

      <Banner s={s} game={game} round={round} status={status} step={step} />

      {placed.map(({ t, x, y, scale, size, nameW }) => (
        <Character
          key={t.key}
          avatarKey={t.key}
          name={t.name}
          x={x}
          y={y}
          w={dim.w}
          h={dim.h}
          size={size}
          scale={scale}
          nameW={nameW}
          mood={t.mood}
          exiting={t.place === 'EXIT'}
          crown={t.place === 'CHAMPION' && step >= 2}
          front={t.place === 'CHAMPION'}
          hideName={t.place === 'CHAMPION' && placed.filter((p) => p.t.place === 'CHAMPION').length === 1}
        />
      ))}
    </section>
  );
}

function Zone({ side, state }: { side: 'O' | 'X'; state: '' | 'dim' | 'glow' }) {
  const o = side === 'O';
  return (
    <div
      className={`ox-zone absolute bottom-[2%] top-[3%] overflow-hidden rounded-[3vmin] ${o ? 'left-[1.5%] right-[66.5%]' : 'left-[66.5%] right-[1.5%]'} ${state}`}
      style={{
        background: o
          ? 'linear-gradient(180deg, rgba(56,189,248,0.55), rgba(37,99,235,0.35))'
          : 'linear-gradient(180deg, rgba(251,113,133,0.55), rgba(225,29,72,0.35))',
        ['--glow' as string]: o ? 'rgba(56,189,248,0.9)' : 'rgba(251,113,133,0.9)',
      }}
    >
      <div className="absolute left-0 right-0 top-[2%] flex flex-col items-center">
        {o ? (
          <span className="flex h-[20vmin] w-[20vmin] items-center justify-center rounded-full border-[3.4vmin] border-white/90 drop-shadow-[0_0.6vmin_0_rgba(0,0,0,0.25)]" />
        ) : (
          <span className="relative block h-[20vmin] w-[20vmin] drop-shadow-[0_0.6vmin_0_rgba(0,0,0,0.25)]">
            <span className="absolute left-1/2 top-1/2 h-[3.6vmin] w-[24vmin] -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-full bg-white/90" />
            <span className="absolute left-1/2 top-1/2 h-[3.6vmin] w-[24vmin] -translate-x-1/2 -translate-y-1/2 -rotate-45 rounded-full bg-white/90" />
          </span>
        )}
        <span className="mt-[0.6vmin] text-[2.2vmin] font-black tracking-[0.35em] text-white/80">{side} ZONE</span>
      </div>
    </div>
  );
}

/** Big words above the middle of the stage. */
function Banner({ s, game, round, status, step }: { s: OxPublicState; game: OxGame | null; round: OxRound | null; status: string; step: number }) {
  const line = survivalLine(round);
  const ans = round?.correct_answer;
  const ansEl = <span className={ans === 'O' ? 'text-sky-300' : 'text-rose-300'}>{ans}</span>;
  const wrap = (key: string, children: React.ReactNode, wide = false) => (
    <div key={key} className={`ox-banner-in pointer-events-none absolute top-[2%] z-10 flex flex-col items-center text-center ${wide ? 'left-[3%] right-[3%]' : 'left-[34%] right-[34%]'}`}>
      {children}
    </div>
  );
  const big = 'font-display leading-none drop-shadow-[0_0.6vmin_0_rgba(0,0,0,0.35)]';

  switch (status) {
    case 'LOBBY':
      return wrap('lobby', <>
        <p className={`${big} text-[7vmin] text-white`}>OX SURVIVAL</p>
        <p className="mt-[1vmin] text-[2.8vmin] font-black text-amber-200">최후의 1인을 찾아라!</p>
        <p className="mt-[0.6vmin] text-[2.2vmin] font-bold text-white/75">QR로 입장하면 내 캐릭터가 나타나요</p>
      </>);
    case 'ROUND_READY':
      return wrap(`ready${game?.current_round}`, <>
        <p className={`${big} text-[9vmin] text-white`}>ROUND {game?.current_round}</p>
        <p className="mt-[1.2vmin] font-display text-[4vmin] text-amber-200">다음 문제를 들어주세요!</p>
      </>);
    case 'ANSWERING':
      return wrap('ans', <>
        <p className={`${big} text-[6vmin] text-white`}>ROUND {game?.current_round}</p>
        <p className="mt-[1vmin] font-display text-[3.6vmin] text-amber-200">O 또는 X로 이동!</p>
        <p className="mt-[0.5vmin] text-[2.4vmin] font-black text-white/80">응답 {s.counts.answered} / {s.counts.alive}명</p>
      </>);
    case 'ANSWER_CLOSED':
      return wrap('closed', <>
        <p className={`${big} text-[7vmin] text-amber-300`}>응답 마감!</p>
        <p className="mt-[1vmin] font-display text-[5vmin] text-white">과연 정답은?</p>
      </>);
    case 'RESULT_REVEALED':
      if (step === 0) return wrap('tension', <p className={`${big} text-[6.5vmin] text-white`}>과연 정답은?</p>);
      if (step < 4) return wrap('answer', <p className={`winner-pop ${big} text-[12vmin] text-white`}>정답은 {ansEl}!</p>);
      return wrap('result', <>
        <p className={`${big} text-[7vmin] text-white`}>정답 {ansEl}!</p>
        {line && <p className="mt-[1.2vmin] font-display text-[4.6vmin] text-emerald-300">{line.survived}</p>}
        {line && <p className="mt-[0.4vmin] font-display text-[3.6vmin] text-white/80">{line.eliminated}명 탈락!</p>}
        {game?.result === 'CHAMPION' && <p className="mt-[0.8vmin] text-[3vmin] font-black text-amber-300">👑 최후의 1인 탄생!</p>}
      </>);
    case 'ROUND_VOID':
      if (step === 0) return wrap('tension', <p className={`${big} text-[6.5vmin] text-white`}>과연 정답은?</p>);
      if (step === 1) return wrap('void', <>
        <p className={`${big} text-[7vmin] text-white`}>정답은 {ansEl}!</p>
        <p className="winner-pop mt-[1.2vmin] font-display text-[4.6vmin] text-amber-300">전원 탈락! 이번 문제는 무효!</p>
      </>);
      return wrap('again', <>
        <p className={`winner-pop ${big} text-[9vmin] text-amber-300`}>다시 도전!</p>
        <p className="mt-[1vmin] text-[2.8vmin] font-black text-white/85">{round?.survivors_before}명 모두 살아남아 재경기합니다</p>
      </>);
    case 'FINISHED': {
      const names = s.winners;
      if (game?.result === 'ENDED') return wrap('ended', <>
        <p className={`${big} text-[8vmin] text-white`}>게임 종료</p>
        <p className="mt-[1vmin] text-[3vmin] font-black text-amber-200">최종 생존자 {names.length}명</p>
      </>, true);
      if (step < 2) return null;
      const co = game?.result === 'CO_WINNERS';
      return wrap('champ', <>
        <p className={`${big} text-[6vmin] text-amber-300`}>{co ? '공동 우승!' : 'OX SURVIVAL CHAMPION!'}</p>
        {step >= 3 && (
          <>
            <p className="ox-trophy mt-[0.8vmin] text-[7vmin] leading-none">🏆</p>
            <p className={`winner-pop ${big} mt-[0.6vmin] ${names.length > 3 ? 'text-[5vmin]' : 'text-[9vmin]'} text-white`}>{names.join(' · ')}</p>
            {!co && <p className="mt-[0.8vmin] font-display text-[4vmin] text-amber-200">최후의 1인!</p>}
          </>
        )}
      </>, true);
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------

/**
 * One character. Its position is a CSS transform with a transition, so a
 * new destination (a changed answer) simply retargets the walk from where
 * the character is right now. It is "walking" while the transition runs.
 */
const Character = memo(function Character({ avatarKey, name, x, y, w, h, size, scale, nameW, mood, exiting, crown, front, hideName }: {
  avatarKey: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  size: number;
  scale: number;
  nameW: number;
  mood: Mood;
  exiting: boolean;
  crown: boolean;
  front: boolean;
  hideName: boolean;
}) {
  const nx = w ? x / w : 0;
  const ny = h ? y / h : 0;
  const last = useRef<{ nx: number; ny: number } | null>(null);
  const [walk, setWalk] = useState<{ on: boolean; dur: number; left: boolean; hop: number }>({ on: false, dur: 0, left: false, hop: 0 });

  useEffect(() => {
    const p = last.current;
    last.current = { nx, ny };
    if (!p || !w) return; // first appearance: no walk
    const dist = Math.hypot((nx - p.nx) * w, (ny - p.ny) * h);
    if (dist < 4) return;
    // 0.8 ~ 1.5 s depending on the distance (walking off the stage is slower)
    const dur = exiting ? 1.9 : Math.min(1.5, 0.8 + (dist / w) * 1.1);
    setWalk((s) => ({ on: true, dur, left: nx < p.nx, hop: s.hop }));
    const id = window.setTimeout(() => setWalk((s) => ({ ...s, on: false, hop: s.hop + 1 })), dur * 1000);
    return () => window.clearTimeout(id);
  }, [nx, ny]); // eslint-disable-line react-hooks/exhaustive-deps

  const bodyH = size * BODY_RATIO;
  const fontPx = Math.max(11, Math.min(size * 0.27, 30));
  return (
    <div
      className={`ox-char ${walk.left && !front ? 'face-left' : ''}`}
      style={{
        width: size,
        zIndex: Math.round(y) + (front ? 10000 : 0),
        transformOrigin: `50% ${bodyH}px`,
        transform: `translate3d(${x - size / 2}px, ${y - bodyH}px, 0) scale(${scale})`,
        transition: walk.on
          ? `transform ${walk.dur}s ${exiting ? 'ease-in' : 'cubic-bezier(0.35, 0.1, 0.4, 1)'}, opacity 1.2s linear ${exiting ? '0.7s' : '0s'}`
          : 'transform 0.6s ease, opacity 0.4s',
        opacity: exiting ? 0 : 1,
      }}
    >
      <div className="ox-facing">
        <div key={walk.hop} className={walk.hop > 0 && !walk.on && mood === 'idle' ? 'ox-hop' : ''}>
          <OxAvatar avatarKey={avatarKey} mood={mood} walking={walk.on} crown={crown} />
        </div>
      </div>
      <p className="ox-name" style={{ visibility: hideName ? 'hidden' : undefined, top: bodyH + 2, fontSize: fontPx, maxWidth: Math.max(nameW, fontPx * 3) }}>{name}</p>
    </div>
  );
});
