import { useId, type CSSProperties } from 'react';
import type { Tone } from '../spell/signals';

/**
 * The guardian: a scalloped badge carrying the shield, with two slow rings around it.
 * Blue while listening, amber for Possible risk, red for High risk, grey with a slash when off.
 * Never green: there is no "safe" state.
 */

export type BlobKind = 'cookie' | 'soft' | 'burst' | 'ring';

export function blobPath(kind: BlobKind, r: number, cx = 100, cy = 100): string {
  const pts: string[] = [];
  const steps = kind === 'burst' ? 240 : 144;
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    let rr: number;
    if (kind === 'cookie') rr = r * (1 + 0.075 * Math.cos(9 * a));
    else if (kind === 'burst') rr = r * (0.66 + 0.34 * Math.pow((1 + Math.cos(12 * a)) / 2, 2.4));
    else if (kind === 'ring') rr = r * (1 + 0.035 * Math.sin(5 * a + 0.6) + 0.02 * Math.cos(8 * a));
    else rr = r * (1 + 0.02 * Math.cos(5 * a));
    pts.push(`${(cx + Math.cos(a) * rr).toFixed(2)},${(cy + Math.sin(a) * rr).toFixed(2)}`);
  }
  return `M${pts.join('L')}Z`;
}

const COOKIE_64 = blobPath('cookie', 64);
const SOFT_64 = blobPath('soft', 64);
const RING_78 = blobPath('ring', 78);
const RING_90 = blobPath('ring', 90);

const TONES: Record<Tone, { h1: string; h2: string; ring: string }> = {
  calm: { h1: 'var(--sb-h1)', h2: 'var(--sb-h2)', ring: 'var(--sb-ringc)' },
  listening: { h1: 'var(--sb-h1)', h2: 'var(--sb-h2)', ring: 'var(--sb-ringc)' },
  possible: { h1: 'var(--sb-warn-h1)', h2: 'var(--sb-warn-h2)', ring: 'var(--sb-warn-ring)' },
  high: { h1: 'var(--sb-danger-h1)', h2: 'var(--sb-danger-h2)', ring: 'var(--sb-danger-ring)' },
  off: { h1: 'var(--sb-off)', h2: 'var(--sb-off)', ring: 'var(--sb-ringc)' },
};

interface GuardianProps {
  tone: Tone;
  /** 0..1 from the live mic: the badge swells a little with the voice. */
  level?: number;
  size?: number;
  onClick?: () => void;
  label?: string;
  pressed?: boolean;
  className?: string;
  style?: CSSProperties;
}

export default function Guardian({ tone, level = 0, size = 200, onClick, label, pressed, className = '', style }: GuardianProps) {
  const id = useId().replace(/:/g, '');
  const c = TONES[tone];
  const off = tone === 'off';
  const swell = 1 + Math.min(Math.max(level, 0), 1) * 0.08;
  const origin: CSSProperties = { transformOrigin: '100px 100px' };

  const art = (
    <>
      {tone === 'listening' &&
        [0, 0.6].map((delay) => (
          <span
            key={delay}
            aria-hidden="true"
            className="sb-ripple absolute rounded-full pointer-events-none"
            style={{ inset: '18%', border: `2px solid ${c.ring}`, animationDelay: `${delay}s` }}
          />
        ))}
      <svg viewBox="0 0 200 200" className="w-full h-full overflow-visible" aria-hidden="true">
        <defs>
          <radialGradient id={`g-${id}`} cx="34%" cy="28%" r="85%">
            <stop offset="0%" style={{ stopColor: c.h1, stopOpacity: 0.78, transition: 'stop-color .5s' }} />
            <stop offset="45%" style={{ stopColor: c.h1, transition: 'stop-color .5s' }} />
            <stop offset="100%" style={{ stopColor: c.h2, transition: 'stop-color .5s' }} />
          </radialGradient>
        </defs>
        <g className="sb-spin-rev-slow" style={origin}>
          <path d={RING_90} fill="none" stroke={c.ring} strokeWidth={1.2} style={{ transition: 'stroke .5s' }} />
        </g>
        <g className="sb-spin-slow" style={origin}>
          <path d={RING_78} fill="none" stroke={c.ring} strokeWidth={1.6} style={{ transition: 'stroke .5s' }} />
        </g>
        <g className={off ? '' : 'sb-breathe'} style={origin}>
          <g style={{ ...origin, transform: `scale(${swell})`, transition: 'transform .12s linear' }}>
            <g className={off ? '' : 'sb-spin-slow'} style={origin}>
              <path d={off ? SOFT_64 : COOKIE_64} fill={`url(#g-${id})`} />
            </g>
            <ellipse cx="82" cy="70" rx="26" ry="14" fill="#FFFFFF" opacity={off ? 0.12 : 0.2} transform="rotate(-28 82 70)" />
            <path
              d="M100 66 L124 75 V96 C124 114 113 127 100 134 C87 127 76 114 76 96 V75 Z"
              fill="none"
              stroke="#FFFFFF"
              strokeWidth={6}
              strokeLinejoin="round"
            />
            {off && <line x1="70" y1="136" x2="130" y2="64" stroke="#FFFFFF" strokeWidth={6} strokeLinecap="round" />}
          </g>
        </g>
      </svg>
    </>
  );

  const box: CSSProperties = { width: size, height: size, ...style };

  if (!onClick) {
    return (
      <div className={`relative shrink-0 ${className}`} style={box} aria-hidden="true">
        {art}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={pressed}
      className={`relative shrink-0 rounded-full bg-transparent border-0 p-0 transition-transform duration-150 active:scale-[0.93] ${className}`}
      style={box}
    >
      {art}
    </button>
  );
}
