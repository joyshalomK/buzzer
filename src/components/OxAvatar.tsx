import { memo } from 'react';
import { lookOf, type Mood } from '../lib/oxStage';

/**
 * A small person: round head, body, two arms, two legs and a shadow.
 * Everything that moves is a CSS animation on a group (see index.css,
 * `.ox-avatar`), so walking costs no React renders.
 */
export const OxAvatar = memo(function OxAvatar({ avatarKey, mood, walking, crown }: {
  avatarKey: string;
  mood: Mood;
  walking: boolean;
  crown: boolean;
}) {
  const l = lookOf(avatarKey);
  const sad = mood === 'sad';
  return (
    <svg
      viewBox="0 0 60 90"
      className={`ox-avatar mood-${mood} ${walking ? 'walking' : ''}`}
      style={{ ['--ox-delay' as string]: `${-l.delay * 2.4}s` }}
      aria-hidden
    >
      <ellipse cx="30" cy="86" rx="15" ry="3.5" fill="rgba(0,0,0,0.28)" className="ox-shadow" />
      <g className="ox-figure">
        {/* legs */}
        <g className="ox-leg ox-leg-l">
          <rect x="21.5" y="58" width="7.5" height="21" rx="3.5" fill="#2d3550" />
          <rect x="19.5" y="76" width="10.5" height="6" rx="3" fill="#1b1f30" />
        </g>
        <g className="ox-leg ox-leg-r">
          <rect x="31" y="58" width="7.5" height="21" rx="3.5" fill="#2d3550" />
          <rect x="30" y="76" width="10.5" height="6" rx="3" fill="#1b1f30" />
        </g>
        {/* arms (behind the body at the shoulder) */}
        <g className="ox-arm ox-arm-l">
          <rect x="11" y="36" width="7" height="20" rx="3.5" fill={l.bodyDark} />
          <circle cx="14.5" cy="57" r="3.6" fill={l.skin} />
        </g>
        <g className="ox-arm ox-arm-r">
          <rect x="42" y="36" width="7" height="20" rx="3.5" fill={l.bodyDark} />
          <circle cx="45.5" cy="57" r="3.6" fill={l.skin} />
        </g>
        {/* body */}
        <g className="ox-body">
          <rect x="16.5" y="33" width="27" height="29" rx="11" fill={l.body} />
          <path d="M24 34 L30 41 L36 34" fill="none" stroke="rgba(255,255,255,0.55)" strokeWidth="2.2" strokeLinecap="round" />
          <circle cx="30" cy="47" r="1.5" fill="rgba(255,255,255,0.6)" />
          <circle cx="30" cy="53" r="1.5" fill="rgba(255,255,255,0.6)" />
        </g>
        {/* head */}
        <g className="ox-head">
          <Hair style={l.hairStyle} color={l.hair} back />
          <circle cx="30" cy="20" r="14.5" fill={l.skin} />
          <Hair style={l.hairStyle} color={l.hair} />
          {/* eyes look slightly to the walking side (the whole figure is mirrored for left) */}
          {sad ? (
            <>
              <path d="M24 23 q2.2 -1.6 4.4 0" stroke="#2b2b2b" strokeWidth="1.7" fill="none" strokeLinecap="round" />
              <path d="M33.4 23 q2.2 -1.6 4.4 0" stroke="#2b2b2b" strokeWidth="1.7" fill="none" strokeLinecap="round" />
            </>
          ) : (
            <>
              <ellipse cx="26.5" cy="21.5" rx="2" ry="2.6" fill="#2b2b2b" />
              <ellipse cx="35.5" cy="21.5" rx="2" ry="2.6" fill="#2b2b2b" />
              <circle cx="27.2" cy="20.6" r="0.7" fill="#fff" />
              <circle cx="36.2" cy="20.6" r="0.7" fill="#fff" />
            </>
          )}
          <circle cx="22.5" cy="26" r="2.3" fill="#ff8fa3" opacity="0.55" />
          <circle cx="39.5" cy="26" r="2.3" fill="#ff8fa3" opacity="0.55" />
          {sad ? (
            <path d="M27 30.5 q3.5 -2.6 7 0" stroke="#7a3b2e" strokeWidth="1.8" fill="none" strokeLinecap="round" />
          ) : mood === 'cheer' || mood === 'champion' ? (
            <path d="M25.5 27.5 q5 6.5 10 0 z" fill="#7a3b2e" />
          ) : (
            <path d="M26.5 28 q4 3.6 8 0" stroke="#7a3b2e" strokeWidth="1.8" fill="none" strokeLinecap="round" />
          )}
          <Accessory kind={l.accessory} />
        </g>
        {crown && (
          <g className="ox-crown">
            <path d="M17 6 L21 -6 L26 2 L30 -9 L34 2 L39 -6 L43 6 Z" fill="#facc15" stroke="#b45309" strokeWidth="1.2" />
            <circle cx="30" cy="-1" r="2" fill="#ef4444" />
          </g>
        )}
      </g>
    </svg>
  );
});

function Hair({ style, color, back }: { style: 0 | 1 | 2 | 3; color: string; back?: boolean }) {
  if (back) return style === 2 ? <path d="M15 20 Q15 40 22 40 L38 40 Q45 40 45 20 Z" fill={color} /> : null;
  switch (style) {
    case 0: // short
      return <path d="M15.5 18 Q16 5 30 5 Q44 5 44.5 18 Q38 11 30 12 Q22 11 15.5 18 Z" fill={color} />;
    case 1: // side part
      return <path d="M15.5 19 Q15 5 31 5 Q45 6 44.5 17 Q36 9 24 14 Q19 16 15.5 19 Z" fill={color} />;
    case 2: // long
      return <path d="M15.5 20 Q15 5 30 5 Q45 5 44.5 20 Q40 10 30 10.5 Q20 10 15.5 20 Z" fill={color} />;
    default: // curly top
      return (
        <g fill={color}>
          <circle cx="21" cy="9.5" r="5" />
          <circle cx="29" cy="6.5" r="5.5" />
          <circle cx="37.5" cy="9" r="5" />
          <circle cx="42" cy="15" r="3.5" />
          <circle cx="17.5" cy="15" r="3.5" />
        </g>
      );
  }
}

function Accessory({ kind }: { kind: ReturnType<typeof lookOf>['accessory'] }) {
  switch (kind) {
    case 'santa':
      return (
        <g>
          <path d="M15 11 Q22 -6 40 2 L45 10 Q30 6 15 11 Z" fill="#e11d48" />
          <rect x="13.5" y="8.5" width="32" height="5" rx="2.5" fill="#fff" />
          <circle cx="44" cy="3" r="3.2" fill="#fff" />
        </g>
      );
    case 'party':
      return (
        <g>
          <path d="M22 8 L30 -10 L38 8 Z" fill="#a855f7" />
          <path d="M24.5 3 L35.5 3" stroke="#fde047" strokeWidth="2" />
          <circle cx="30" cy="-10" r="2.6" fill="#fde047" />
        </g>
      );
    case 'bow':
      return (
        <g fill="#f472b6">
          <path d="M36 6 L42 2 L42 10 Z" />
          <path d="M36 6 L30 2 L30 10 Z" />
          <circle cx="36" cy="6" r="1.8" fill="#be185d" />
        </g>
      );
    case 'glasses':
      return (
        <g fill="none" stroke="#1f2937" strokeWidth="1.4">
          <circle cx="26.5" cy="21.5" r="4.2" />
          <circle cx="35.5" cy="21.5" r="4.2" />
          <path d="M30.7 21.5 L31.3 21.5" />
        </g>
      );
    default:
      return null;
  }
}
