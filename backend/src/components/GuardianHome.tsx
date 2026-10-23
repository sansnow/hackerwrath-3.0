import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ChevronRight, LifeBuoy } from 'lucide-react';
import Guardian, { blobPath } from './Guardian';
import { ALERT_COPY, type Tone } from '../spell/signals';
import { weekOf, type DayTally, type HistoryRecord } from '../spell/history';

/** Home: is scam check on, what happened this week, and help if it's too late. */

interface GuardianHomeProps {
  listening: boolean;
  tone: Tone;
  level: number;
  busy?: boolean;
  onToggle: () => void;
  records: HistoryRecord[];
}

const DIAL_W = 320;
const DIAL_H = 300;
const DIAL_R = 128;
const angleOf = (i: number) => 165 - i * 25;
const rad = (deg: number) => (deg * Math.PI) / 180;

const BURST = blobPath('burst', 46, 50, 50);
const COOKIE = blobPath('cookie', 42, 50, 50);

const TITLES: Record<Tone, string> = {
  off: 'Tap the shield to listen',
  calm: 'Tap the shield to listen',
  listening: 'Listening on every call',
  possible: 'Something sounds off',
  high: 'This caller is a scam',
};

export default function GuardianHome({ listening, tone, level, busy, onToggle, records }: GuardianHomeProps) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const week = useMemo(() => weekOf(records, now), [records, now]);
  const [selected, setSelected] = useState(6);
  const stopped = records.filter((r) => r.type === 'warning' && r.outcome === 'hung_up' && now - r.at < 7 * 864e5);
  const slowest = stopped.length ? Math.max(...stopped.map((r) => r.secondsToEnd || 0)) : null;
  const fastest = stopped.length ? Math.min(...stopped.map((r) => r.secondsToEnd || 0)) : null;
  const checks = week.reduce((n, d) => n + d.checks, 0);
  const warnings = week.reduce((n, d) => n + d.warnings, 0);

  const guardianTone: Tone = listening ? tone : tone === 'high' || tone === 'possible' ? tone : 'off';

  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        role="switch"
        aria-checked={listening}
        onClick={onToggle}
        disabled={busy}
        className="self-start inline-flex items-center gap-2.5 pl-3 pr-1.5 py-1.5 rounded-full bg-card border border-line text-[13px] font-semibold text-ink transition-transform active:scale-95"
      >
        <span className={`w-2 h-2 rounded-full ${listening ? 'bg-accent' : 'bg-off'}`} />
        {listening ? 'Scam check is on' : 'Scam check is off'}
        <span className={`relative w-9 h-5 rounded-full transition-colors ${listening ? 'bg-accent' : 'bg-off'}`}>
          <span
            className="absolute top-0.5 w-4 h-4 rounded-full bg-card transition-all"
            style={{ left: listening ? 18 : 2 }}
          />
        </span>
      </button>

      <h2 className="sb-display text-[42px] sm:text-[48px] max-w-[330px]">{TITLES[guardianTone]}</h2>

      <WeekDial
        week={week}
        selected={selected}
        onSelect={setSelected}
        guardian={
          <Guardian
            tone={guardianTone}
            level={level}
            size={200}
            onClick={onToggle}
            pressed={listening}
            label={listening ? 'Scam check is on. Tap to stop listening.' : 'Scam check is off. Tap to start listening.'}
          />
        }
      />

      <div className="flex items-end gap-3.5 mt-1">
        <span className="sb-display text-[80px] leading-[0.78]">{stopped.length}</span>
        <div className="pb-0.5 flex flex-col gap-0.5">
          <span className="text-[18px] font-extrabold text-head">
            {stopped.length === 1 ? 'scam stopped this week' : 'scams stopped this week'}
          </span>
          <span className="text-[13px] text-faint leading-snug">
            {slowest !== null
              ? `You hung up within ${slowest} seconds of every ask.`
              : 'When a caller asks for the wrong thing, you will see it here.'}
          </span>
        </div>
      </div>

      <DayStory day={week[selected] ?? week[6]} isToday={selected === 6} />

      <div className="pt-1">
        <div className="sb-hairline" />
        <div className="flex items-center pt-3.5">
          <Ticker value={String(checks)} label="checked" first />
          <Ticker value={String(warnings)} label={warnings === 1 ? 'warning' : 'warnings'} />
          <Ticker value={fastest !== null ? `${fastest} s` : '–'} label="fastest hang-up" />
        </div>
      </div>

      <a
        href="https://cybercrime.gov.in"
        target="_blank"
        rel="noopener noreferrer"
        className="mt-2 flex items-center gap-3 rounded-full bg-tert text-on-tert pl-2 pr-4 py-2 no-underline transition-transform active:scale-[0.98]"
      >
        <span className="w-10 h-10 rounded-full bg-black/[0.08] flex items-center justify-center shrink-0">
          <LifeBuoy className="w-5 h-5" />
        </span>
        <span className="flex-1 min-w-0">
          <span className="block text-[15px] font-extrabold">Already paid or shared a code?</span>
          <span className="block text-[12px] opacity-85">Call 1930 now, or report it at cybercrime.gov.in</span>
        </span>
        <ChevronRight className="w-4 h-4 shrink-0" />
      </a>
    </div>
  );
}

function Ticker({ value, label, first }: { value: string; label: string; first?: boolean }) {
  return (
    <div className="flex items-center">
      {!first && <span className="w-px h-11 bg-line" />}
      <div className={`flex flex-col gap-1 ${first ? 'pr-4' : 'px-4'}`}>
        <span className="sb-display text-[28px] leading-none">{value}</span>
        <span className="text-[12px] text-faint">{label}</span>
      </div>
    </div>
  );
}

/** The week dial: the guardian in the middle, the last seven days on an arc, a hand on the day you pick. */
function WeekDial({
  week,
  selected,
  onSelect,
  guardian,
}: {
  week: DayTally[];
  selected: number;
  onSelect: (i: number) => void;
  guardian: ReactNode;
}) {
  const arc = useMemo(() => {
    const pts: string[] = [];
    for (let a = 165; a >= 15; a -= 3) pts.push(`${(160 + DIAL_R * Math.cos(rad(a))).toFixed(1)},${(130 + DIAL_R * Math.sin(rad(a))).toFixed(1)}`);
    return `M${pts.join('L')}`;
  }, []);

  return (
    <div className="relative self-center" style={{ width: DIAL_W, height: DIAL_H, maxWidth: '100%' }}>
      <svg viewBox={`0 0 ${DIAL_W} ${DIAL_H}`} className="absolute inset-0 w-full h-full" aria-hidden="true">
        <path d={arc} fill="none" stroke="var(--sb-ringc)" strokeWidth={2} strokeLinecap="round" strokeDasharray="0.01 8" />
        <g
          style={{
            transform: `rotate(${angleOf(selected)}deg)`,
            transformOrigin: '160px 130px',
            transition: 'transform .6s cubic-bezier(.3,1.5,.5,1)',
          }}
        >
          <line x1="236" y1="130" x2="262" y2="130" stroke="var(--sb-accent)" strokeWidth={2.5} strokeLinecap="round" />
          <circle cx="236" cy="130" r="3.5" fill="var(--sb-accent)" />
        </g>
      </svg>

      <div className="absolute" style={{ left: 60, top: 30 }}>
        {guardian}
      </div>

      <div role="radiogroup" aria-label="This week">
        {week.map((day, i) => {
          const isToday = i === week.length - 1;
          const picked = i === selected;
          const warn = day.warnings > 0;
          const size = warn ? 40 : Math.min(36, 16 + day.checks * 4);
          const x = 160 + DIAL_R * Math.cos(rad(angleOf(i)));
          const y = 130 + DIAL_R * Math.sin(rad(angleOf(i)));
          const date = new Date(day.startMs);
          const name = isToday ? 'Today' : date.toLocaleDateString(undefined, { weekday: 'long' });
          const letter = isToday ? 'Today' : date.toLocaleDateString(undefined, { weekday: 'narrow' });
          return (
            <button
              key={day.startMs}
              type="button"
              role="radio"
              aria-checked={picked}
              aria-label={`${name}, ${day.checks} checked${warn ? `, ${day.warnings} ${day.warnings === 1 ? 'warning' : 'warnings'}` : ''}`}
              onClick={() => onSelect(i)}
              className="absolute w-14 flex flex-col items-center gap-1 bg-transparent border-0 p-0"
              style={{ left: x - 28, top: y - size / 2 }}
            >
              <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" className={isToday ? 'sb-spin-slow' : ''}>
                <path
                  d={warn ? BURST : COOKIE}
                  fill={warn ? 'var(--sb-danger-text)' : isToday ? 'var(--sb-accent)' : 'var(--sb-accent-c)'}
                  stroke={warn ? 'none' : 'var(--sb-ringc)'}
                  strokeWidth={7}
                />
              </svg>
              <span className={`text-[12px] ${picked ? 'font-extrabold text-accent' : 'font-semibold text-faint'}`}>{letter}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** The picked day, told as a short story, with a fuse from the ask to the hang-up. */
function DayStory({ day, isToday }: { day: DayTally; isToday: boolean }) {
  const name = isToday ? 'Today' : new Date(day.startMs).toLocaleDateString(undefined, { weekday: 'long' });
  const ev = day.latestWarning;
  const fraction = !ev ? 0 : ev.outcome === 'hung_up' ? Math.min(1, (ev.secondsToEnd || 0) / 15) : 1;
  const right = !ev
    ? ''
    : ev.outcome === 'hung_up'
      ? `you hung up · ${ev.secondsToEnd} s`
      : ev.outcome === 'kept'
        ? 'you kept talking'
        : 'still on the call';

  return (
    <div className="flex flex-col gap-2.5 pt-1.5">
      <div className="flex items-end justify-between">
        <span className="sb-eyebrow">{name}</span>
        <span className="text-[13px] text-faint">
          {day.checks} {day.checks === 1 ? 'call checked' : 'calls checked'}
        </span>
      </div>
      <p className="text-[19px] leading-[25px] font-bold text-head">
        {ev ? ALERT_COPY[ev.kind || 'general'].story : day.checks ? 'Nobody asked for anything they shouldn’t.' : 'A quiet day.'}
      </p>
      {ev ? (
        <div className="flex flex-col gap-1.5">
          <div className="relative h-6" aria-hidden="true">
            <div className="absolute left-2 right-2 top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-line" />
            <div
              className="absolute left-2 top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-danger-text transition-all duration-700"
              style={{ width: `calc((100% - 16px) * ${fraction})` }}
            />
            <svg width="18" height="18" viewBox="0 0 100 100" className="absolute left-0 top-[3px]">
              <path d={BURST} fill="var(--sb-danger-text)" />
            </svg>
            <span
              className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-6 h-6 rounded-full bg-accent border-[3px] border-card shadow transition-all duration-700"
              style={{ left: `calc(8px + (100% - 16px) * ${fraction})` }}
            />
          </div>
          <div className="flex justify-between text-[12px] font-semibold">
            <span className="text-faint">
              {new Date(ev.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · they asked
            </span>
            <span className="text-head">{right}</span>
          </div>
        </div>
      ) : (
        <div className="flex gap-1.5 py-2" aria-hidden="true">
          {Array.from({ length: Math.min(day.checks, 10) }, (_, i) => (
            <span key={i} className="w-3 h-3 rounded-full bg-accent-soft border-[1.5px] border-ring" />
          ))}
        </div>
      )}
    </div>
  );
}
