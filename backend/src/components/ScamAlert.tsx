import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { ALERT_COPY, agoLabel, type AskKind } from '../spell/signals';

/**
 * The full-screen alert. It breaks the app's look on purpose and wears a different face each
 * time (red field, night siren, red frame), so the warning never turns into wallpaper.
 * Same words, same order, same buttons.
 */

interface Face {
  bg: string;
  fg: string;
  highlight: string;
  card: string;
  end: string;
  onEnd: string;
  line: string;
  entrance: 'sb-enter-zoom' | 'sb-enter-jiggle' | 'sb-enter-slam';
  frame?: string;
  hairline?: string;
}

const STANDARD: Face[] = [
  { bg: '#C4161C', fg: '#FFFFFF', highlight: '#FFFFFF', card: 'rgba(255,255,255,0.14)', end: '#FFFFFF', onEnd: '#9E0F14', line: 'rgba(255,255,255,0.75)', entrance: 'sb-enter-zoom' },
  { bg: '#0B0B0C', fg: '#FFFFFF', highlight: '#FF453A', card: '#1E1E22', end: '#FF453A', onEnd: '#0B0B0C', line: '#FF453A', entrance: 'sb-enter-jiggle' },
  { bg: '#FFFFFF', fg: '#1A1A1A', highlight: '#C4161C', card: '#FCE8E8', end: '#C4161C', onEnd: '#FFFFFF', line: '#C4161C', entrance: 'sb-enter-slam', frame: '#C4161C' },
];

const PREMIUM: Face[] = [
  { bg: '#800000', fg: '#FFFFFF', highlight: '#F3DDA8', card: 'rgba(255,255,255,0.08)', end: '#F1ECE2', onEnd: '#5C0000', line: 'rgba(243,221,168,0.7)', entrance: 'sb-enter-zoom', frame: '#800000', hairline: 'rgba(243,221,168,0.55)' },
  { bg: '#07080B', fg: '#FFFFFF', highlight: '#FF5A4E', card: '#14161C', end: '#FF5A4E', onEnd: '#07080B', line: 'rgba(255,90,78,0.8)', entrance: 'sb-enter-jiggle' },
  { bg: '#F1ECE2', fg: '#1A1408', highlight: '#800000', card: '#F6E3DF', end: '#800000', onEnd: '#FFFFFF', line: '#800000', entrance: 'sb-enter-slam', frame: '#800000' },
];

export interface AlertAction {
  label: string;
  onClick: () => void;
}

interface ScamAlertProps {
  kind: AskKind;
  chips: string[];
  /** Which face, counting alerts shown so far. */
  run: number;
  premium: boolean;
  askedAt: number;
  primary: AlertAction;
  secondary: AlertAction;
}

export default function ScamAlert({ kind, chips, run, premium, askedAt, primary, secondary }: ScamAlertProps) {
  const faces = premium ? PREMIUM : STANDARD;
  const face = faces[((run % faces.length) + faces.length) % faces.length];
  const copy = ALERT_COPY[kind];
  const [answer, setAnswer] = useState<'yes' | 'no' | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const endRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const secondaryRef = useRef(secondary);
  secondaryRef.current = secondary;
  useEffect(() => {
    endRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') secondaryRef.current.onClick();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const sheet: CSSProperties = {
    background: face.bg,
    color: face.fg,
    boxShadow: face.frame
      ? `inset 0 0 0 10px ${face.frame}${face.hairline ? `, inset 0 0 0 12px ${face.hairline}` : ''}, 0 30px 80px rgba(0,0,0,0.35)`
      : '0 30px 80px rgba(0,0,0,0.35)',
  };
  const answerBtn: CSSProperties = { border: `1.5px solid ${face.line}`, color: face.fg, background: 'transparent' };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 overflow-hidden">
      <div className="absolute inset-0 sb-fade backdrop-blur-sm" style={{ background: 'var(--sb-scrim)' }} />
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="sb-alert-title"
        aria-describedby="sb-alert-line"
        className={`relative w-full max-w-[420px] max-h-[94vh] overflow-y-auto rounded-[36px] px-[22px] pt-8 pb-6 flex flex-col gap-3.5 ${face.entrance}`}
        style={{ ...sheet, fontFamily: "'Anek Latin', 'Anek Devanagari', 'Anek Gurmukhi', system-ui, sans-serif" }}
      >
        <div className="flex items-center gap-2">
          <span
            className="px-3 py-1.5 rounded-full text-[12px] leading-4 font-bold tracking-[0.16em]"
            style={{ background: face.highlight, color: face.bg }}
          >
            HIGH RISK
          </span>
          <span className="text-[12px] font-semibold" style={{ opacity: 0.75 }}>
            {agoLabel(Math.max(0, Math.round((now - askedAt) / 1000)))}
          </span>
        </div>

        <div className="flex items-center gap-3.5">
          <h1
            id="sb-alert-title"
            className="sb-flexword flex-1 min-w-0 m-0 text-[52px] sm:text-[56px] leading-[50px] font-extrabold"
            style={{ color: face.highlight }}
          >
            {copy.headline}
          </h1>
          <div
            className="w-[84px] h-[84px] shrink-0 rounded-[26px] flex items-center justify-center sb-icon-pulse"
            style={{ background: face.card, color: face.highlight }}
          >
            <AskIcon kind={kind} />
          </div>
        </div>

        <p id="sb-alert-line" className="m-0 text-[19px] leading-[25.5px] font-bold">
          {copy.line}
        </p>

        {chips.length > 0 && (
          <section aria-label="What they said" className="flex flex-col gap-2">
            <div className="text-[12px] leading-4 font-bold tracking-[0.16em]" style={{ opacity: 0.75 }}>
              WHAT THEY SAID
            </div>
            <ul className="m-0 p-0 list-none flex flex-wrap gap-2">
              {chips.map((chip) => (
                <li key={chip} className="sb-chip" style={{ background: face.card, color: face.fg }}>
                  {chip}
                </li>
              ))}
            </ul>
          </section>
        )}

        <div className="rounded-[22px] p-4 flex flex-col gap-2.5" style={{ background: face.card }}>
          {answer === null ? (
            <>
              <div className="text-[17px] leading-[23px] font-bold">{copy.question}</div>
              <div className="flex gap-2">
                <button type="button" onClick={() => setAnswer('yes')} className="sb-btn flex-1 min-h-12" style={answerBtn}>
                  Yes
                </button>
                <button type="button" onClick={() => setAnswer('no')} className="sb-btn flex-1 min-h-12" style={answerBtn}>
                  No / not sure
                </button>
              </div>
            </>
          ) : (
            <div aria-live="polite" className="text-[17px] leading-6 font-bold">
              {answer === 'yes' ? copy.yes : copy.no}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-3.5 pt-3">
          <button
            ref={endRef}
            type="button"
            onClick={primary.onClick}
            className="sb-btn w-full min-h-[74px] rounded-[28px] text-[22px] font-extrabold"
            style={{ background: face.end, color: face.onEnd, boxShadow: '0 10px 0 rgba(0,0,0,0.18)' }}
          >
            {primary.label}
          </button>
          <button
            type="button"
            onClick={secondary.onClick}
            className="sb-btn w-full min-h-[54px] rounded-[20px] text-[16px]"
            style={{ border: `1.5px solid ${face.line}`, color: face.fg, background: 'transparent' }}
          >
            {secondary.label}
          </button>
        </div>
      </div>
    </div>
  );
}

/** What they asked for, crossed out. */
export function AskIcon({ kind, size = 56 }: { kind: AskKind; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  const slash = <line x1="2" y1="22" x2="22" y2="2" strokeWidth={2.4} />;
  switch (kind) {
    case 'qr':
      return (
        <svg {...common} strokeWidth={1.6}>
          <rect x="3" y="3" width="7" height="7" rx="1.2" />
          <rect x="14" y="3" width="7" height="7" rx="1.2" />
          <rect x="3" y="14" width="7" height="7" rx="1.2" />
          <path d="M14 14h3v3M21 14v.01M14 21h.01M17.5 21H21v-3.5" />
          {slash}
        </svg>
      );
    case 'otp':
      return (
        <svg {...common}>
          <rect x="2" y="7" width="20" height="10" rx="3" strokeWidth={1.6} />
          <circle cx="7" cy="12" r="1.1" fill="currentColor" stroke="none" />
          <circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none" />
          <circle cx="17" cy="12" r="1.1" fill="currentColor" stroke="none" />
          {slash}
        </svg>
      );
    case 'remote':
      return (
        <svg {...common} strokeWidth={1.6}>
          <rect x="6" y="2.5" width="12" height="19" rx="2.5" />
          <line x1="12" y1="7" x2="12" y2="14.5" />
          <polyline points="9,11.5 12,14.5 15,11.5" />
          {slash}
        </svg>
      );
    case 'arrest':
      return (
        <svg {...common} strokeWidth={1.6}>
          <path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6l-8-3Z" />
          <line x1="12" y1="8" x2="12" y2="13" strokeWidth={2} />
          <circle cx="12" cy="16.3" r="1.1" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'payment':
      return (
        <svg {...common} strokeWidth={1.6}>
          <path d="M7 5h10M7 9h10M10 5c3.5 0 4.5 2 4.5 4s-1.5 4-5 4H8l6.5 7" />
          {slash}
        </svg>
      );
    default:
      return (
        <svg {...common} strokeWidth={1.6}>
          <circle cx="12" cy="12" r="9.5" />
          <line x1="12" y1="7" x2="12" y2="13" strokeWidth={2} />
          <circle cx="12" cy="16.5" r="1.1" fill="currentColor" stroke="none" />
        </svg>
      );
  }
}
