import { useMemo } from 'react';

const COLORS = ['#fbbf24', '#f59e0b', '#fde68a', '#fb3a5d', '#34d399', '#60a5fa', '#ffffff'];

/** Lightweight CSS confetti burst; re-mount (change `key`) to replay. */
export function Confetti({ count = 70 }: { count?: number }) {
  const pieces = useMemo(
    () =>
      Array.from({ length: count }, (_, i) => ({
        id: i,
        left: Math.random() * 100,
        delay: Math.random() * 0.6,
        dur: 2.2 + Math.random() * 1.8,
        size: 6 + Math.random() * 8,
        color: COLORS[i % COLORS.length],
        drift: (Math.random() - 0.5) * 160,
        round: Math.random() > 0.6,
      })),
    [count],
  );
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-40 overflow-hidden">
      {pieces.map((p) => (
        <span
          key={p.id}
          className="confetti-piece"
          style={{
            left: `${p.left}%`,
            width: p.size,
            height: p.round ? p.size : p.size * 0.45,
            background: p.color,
            borderRadius: p.round ? '9999px' : '2px',
            animationDelay: `${p.delay}s`,
            animationDuration: `${p.dur}s`,
            ['--drift' as string]: `${p.drift}px`,
          }}
        />
      ))}
    </div>
  );
}
