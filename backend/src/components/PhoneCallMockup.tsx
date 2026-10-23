import { useState, useEffect, useRef } from 'react';
import { Phone, PhoneOff, Volume2, Mic, MicOff, Play, ExternalLink } from 'lucide-react';
import { DEMO_SCENARIOS, DemoScenario } from '../data/demoScenarios';
import { audioAlerts } from '../utils/audioAlerts';
import type { RiskAssessment } from '../hooks/useLiveDetection';
import Guardian from './Guardian';
import { isHigh, isPossible, type Tone } from '../spell/signals';

interface PhoneCallMockupProps {
  onAnalyzeSegment: (text: string) => Promise<RiskAssessment | null>;
  activeRisk: RiskAssessment | null;
  /** A demo call was answered (counts as a checked call). */
  onCallStart?: () => void;
  /** Lets the alert's "End call" hang up this demo call. */
  onRegisterHangUp?: (hangUp: (() => void) | null) => void;
  /** Run a script's whole transcript through Text check instead of ringing. */
  onCheckAsText?: (transcript: string) => void;
}

const FILTERS: Array<{ id: string; label: string; match: (s: DemoScenario) => boolean }> = [
  { id: 'ALL', label: 'All', match: () => true },
  { id: 'EXTORTION', label: 'Digital arrest', match: (s) => s.category.includes('THREAT') || s.id.includes('digital-arrest') },
  { id: 'QR_SCAN', label: 'UPI and QR', match: (s) => s.category.includes('QR') || s.id.includes('qr') },
  {
    id: 'URGENCY',
    label: 'OTP and KYC',
    match: (s) => s.category.includes('OTP') || s.category.includes('REMOTE') || s.id.includes('kyc') || s.id.includes('anydesk'),
  },
  {
    id: 'TASK',
    label: 'Part-time tasks',
    match: (s) => s.category.includes('TASK') || s.category.includes('URGENT_PAYMENT') || s.id.includes('lottery') || s.id.includes('task'),
  },
  { id: 'SAFE', label: 'Ordinary calls', match: (s) => s.expectedRisk === 'LOW' },
];

/** Said aloud on high risk, so the warning reaches you even with the phone at your ear. */
function speakWarning(message: string) {
  if ('speechSynthesis' in window) {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(message);
    utterance.rate = 1.0;
    utterance.pitch = 1.05;
    window.speechSynthesis.speak(utterance);
  }
}

type CallState = 'IDLE' | 'RINGING' | 'IN_CALL' | 'ENDED';

const stripEmoji = (s: string) => s.replace(/^[^\p{L}\p{N}]+/u, '').trim();

export default function PhoneCallMockup({ onAnalyzeSegment, activeRisk, onCallStart, onRegisterHangUp, onCheckAsText }: PhoneCallMockupProps) {
  const [filter, setFilter] = useState('ALL');
  const [afterCall, setAfterCall] = useState(false);
  const [selectedScenario, setSelectedScenario] = useState<DemoScenario>(DEMO_SCENARIOS[0]);
  const [callState, setCallState] = useState<CallState>('IDLE');
  const [callDuration, setCallDuration] = useState(0);
  const [displayedTranscript, setDisplayedTranscript] = useState<Array<{ speaker: string; text: string }>>([]);
  const [isSpeakerOn, setIsSpeakerOn] = useState(true);
  const [isMuted, setIsMuted] = useState(false);
  const [isSimulating, setIsSimulating] = useState(false);
  const [simulatedRisk, setSimulatedRisk] = useState<RiskAssessment | null>(null);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const scenarioTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const captionsRef = useRef<HTMLDivElement>(null);

  // Call timer
  useEffect(() => {
    if (callState === 'IN_CALL') {
      timerRef.current = setInterval(() => {
        setCallDuration((prev) => prev + 1);
      }, 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
      setCallDuration(0);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [callState]);

  // Clean timeouts on unmount
  useEffect(() => {
    return () => {
      if (scenarioTimeoutRef.current) clearTimeout(scenarioTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    captionsRef.current?.scrollTo({ top: captionsRef.current.scrollHeight, behavior: 'smooth' });
  }, [displayedTranscript]);

  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60)
      .toString()
      .padStart(2, '0');
    const s = (secs % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };

  const answer = (scenario: DemoScenario) => {
    setCallState('IN_CALL');
    audioAlerts.playClick();
    onCallStart?.();
    playScenarioSegments(scenario, 0);
  };

  const startScenario = async (scenario: DemoScenario) => {
    if (scenarioTimeoutRef.current) clearTimeout(scenarioTimeoutRef.current);
    setSelectedScenario(scenario);
    setAfterCall(false);
    setDisplayedTranscript([]);
    setSimulatedRisk(null);
    setCallState('RINGING');
    audioAlerts.playCautionAlert();

    // Auto answer after 1.5s
    scenarioTimeoutRef.current = setTimeout(() => answer(scenario), 1500);
  };

  const playScenarioSegments = (scenario: DemoScenario, index: number) => {
    if (index >= scenario.segments.length) {
      setIsSimulating(false);
      return;
    }

    setIsSimulating(true);
    const seg = scenario.segments[index];

    scenarioTimeoutRef.current = setTimeout(async () => {
      setDisplayedTranscript((prev) => [...prev, { speaker: seg.speaker, text: seg.text }]);

      // Send to real backend for full risk evaluation
      try {
        const assessment = await onAnalyzeSegment(seg.text);
        if (assessment) {
          setSimulatedRisk(assessment);
          if (assessment.risk_level === 'HIGH' || assessment.risk_level === 'CRITICAL') {
            audioAlerts.playHighRiskAlert();
            speakWarning('Warning. Do not share a code, scan a QR code, or enter your PIN.');
          } else if (assessment.risk_level === 'MEDIUM') {
            audioAlerts.playCautionAlert();
          } else {
            audioAlerts.playSafeChime();
          }
        }
      } catch (e) {
        console.error('Segment analysis error', e);
      }

      playScenarioSegments(scenario, index + 1);
    }, seg.delayMs);
  };

  const handleHangUp = () => {
    if (scenarioTimeoutRef.current) clearTimeout(scenarioTimeoutRef.current);
    setCallState('ENDED');
    setAfterCall(true);
    setIsSimulating(false);
    audioAlerts.playClick();
    setTimeout(() => {
      setCallState('IDLE');
      setDisplayedTranscript([]);
      setSimulatedRisk(null);
    }, 1800);
  };

  const hangUpRef = useRef(handleHangUp);
  hangUpRef.current = handleHangUp;
  useEffect(() => {
    onRegisterHangUp?.(() => hangUpRef.current());
    return () => onRegisterHangUp?.(null);
  }, [onRegisterHangUp]);

  const effectiveRisk = simulatedRisk || activeRisk;
  const isHighRisk = isHigh(effectiveRisk?.risk_level);
  const isMedRisk = isPossible(effectiveRisk?.risk_level);
  const live = callState === 'IN_CALL';

  const tone: Tone = !live ? (callState === 'RINGING' ? 'calm' : 'off') : isHighRisk ? 'high' : isMedRisk ? 'possible' : 'listening';
  const earLabel =
    callState === 'IDLE'
      ? 'Pick a demo call'
      : callState === 'RINGING'
        ? 'Incoming call'
        : callState === 'ENDED'
          ? 'Call ended'
          : isHighRisk
            ? 'High risk'
            : isMedRisk
              ? 'Checking…'
              : 'Listening';

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
      {/* Demo calls */}
      <div className="lg:col-span-5 flex flex-col gap-4">
        <div className="sb-card p-5">
          <div className="flex items-end justify-between mb-1">
            <div>
              <div className="sb-eyebrow">Demo calls</div>
              <h3 className="text-[22px] leading-7 font-extrabold text-head mt-1">Real scam scripts</h3>
            </div>
            <span className="text-[12px] text-faint">{DEMO_SCENARIOS.length} calls</span>
          </div>
          <p className="text-[13px] text-faint mb-4">
            Scripted callers, real detector: each line goes to the backend as it is said.
          </p>

          <div role="radiogroup" aria-label="Kind of scam" className="flex flex-wrap gap-1.5 mb-3">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                role="radio"
                aria-checked={filter === f.id}
                onClick={() => setFilter(f.id)}
                className={`sb-chip text-[12px] px-3 py-1.5 transition-colors ${
                  filter === f.id ? 'bg-accent text-on-accent' : 'bg-surface text-muted hover:text-ink'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

          <ul className="flex flex-col gap-2 max-h-[520px] overflow-y-auto pr-1 list-none">
            {DEMO_SCENARIOS.filter((FILTERS.find((f) => f.id === filter) || FILTERS[0]).match).map((scen) => {
              const isSelected = selectedScenario.id === scen.id && (callState === 'IN_CALL' || callState === 'RINGING');
              const danger = scen.expectedRisk === 'HIGH';
              return (
                <li key={scen.id} className="relative">
                  <button
                    type="button"
                    onClick={() => startScenario(scen)}
                    aria-label={`Ring me: ${scen.title}`}
                    className={`w-full text-left rounded-[18px] px-4 pt-3.5 pb-12 transition-all border active:scale-[0.99] ${
                      isSelected ? 'bg-accent-soft border-accent' : 'bg-surface border-transparent hover:border-line hover:bg-card'
                    }`}
                  >
                    <span className="flex items-start justify-between gap-2 mb-1">
                      <span className="text-[15px] font-extrabold text-head">{scen.title}</span>
                      <span
                        className={`sb-chip text-[11px] px-2.5 py-1 shrink-0 ${
                          danger ? 'bg-danger-soft text-danger-ink' : 'bg-accent-soft text-on-accent-soft'
                        }`}
                      >
                        {danger ? stripEmoji(scen.badge) : 'Ordinary call'}
                      </span>
                    </span>
                    <span className="block text-[13px] text-faint line-clamp-2">{scen.explanation}</span>
                  </button>
                  <span className="absolute left-4 right-3 bottom-2.5 flex items-center justify-between gap-2 text-[12px] pointer-events-none">
                    <span className="text-muted font-semibold">{scen.language}</span>
                    <span className="flex items-center gap-1 pointer-events-auto">
                      {onCheckAsText && (
                        <button
                          type="button"
                          onClick={() => onCheckAsText(scen.transcript)}
                          className="px-2.5 min-h-8 rounded-full font-bold text-muted hover:text-ink hover:bg-card"
                        >
                          Check the words
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => startScenario(scen)}
                        className="inline-flex items-center gap-1 px-2.5 min-h-8 rounded-full font-bold text-accent hover:bg-card"
                      >
                        <Play className="w-3 h-3 fill-current" />
                        Ring me
                      </button>
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>

        <a
          href="https://cybercrime.gov.in"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-3 rounded-full bg-tert text-on-tert pl-2 pr-4 py-2 no-underline"
        >
          <span className="w-10 h-10 rounded-full bg-black/[0.08] flex items-center justify-center font-extrabold text-[13px] shrink-0">
            1930
          </span>
          <span className="flex-1">
            <span className="block text-[15px] font-extrabold">National cyber crime helpline</span>
            <span className="block text-[12px] opacity-85">Call 1930, or report at cybercrime.gov.in</span>
          </span>
          <ExternalLink className="w-4 h-4" />
        </a>
      </div>

      {/* The call, at your ear */}
      <div className="lg:col-span-7 flex flex-col items-center gap-3">
        <div
          className="relative w-full max-w-[390px] rounded-[44px] overflow-hidden flex flex-col transition-shadow duration-500"
          style={{
            background: 'var(--sb-night)',
            color: 'var(--sb-night-ink)',
            minHeight: 720,
            boxShadow: `0 0 0 10px #1B1D22, 0 30px 70px rgba(0,0,0,0.28)${isHighRisk ? ', 0 0 80px rgba(229,72,77,0.35)' : ''}`,
          }}
        >
          <div
            className="absolute inset-x-0 top-0 h-[360px] pointer-events-none transition-all duration-500"
            style={{
              background: `radial-gradient(circle 220px at 50% 190px, ${
                isHighRisk ? 'rgba(229,72,77,0.22)' : isMedRisk ? 'rgba(242,176,53,0.22)' : 'rgba(59,91,134,0.32)'
              }, transparent)`,
            }}
          />

          <div className="relative flex flex-col items-center text-center pt-12 px-6">
            <span className="text-[12px] font-bold tracking-[0.16em] text-night-muted">
              {live ? formatTime(callDuration) : callState === 'RINGING' ? 'INCOMING' : 'DEMO CALL'}
            </span>
            <h4 className="text-[26px] leading-8 font-extrabold mt-2 line-clamp-2">{selectedScenario.callerName}</h4>
            <p className="text-[13px] text-night-muted font-mono mt-0.5">{selectedScenario.callerNumber}</p>
          </div>

          <div className="relative flex flex-col items-center mt-4">
            <Guardian tone={tone} size={168} />
            <span
              className={`mt-1 px-3 py-1 rounded-full text-[12px] font-bold tracking-[0.12em] uppercase ${
                isHighRisk && live
                  ? 'bg-[#E5484D] text-[#0E1015]'
                  : isMedRisk && live
                    ? 'bg-warn text-on-warn'
                    : 'bg-night-card text-night-muted'
              }`}
              aria-live="polite"
            >
              {earLabel}
            </span>
          </div>

          {/* What the caller is saying */}
          <div ref={captionsRef} className="relative flex-1 min-h-[150px] max-h-[220px] overflow-y-auto px-5 mt-5 flex flex-col gap-2">
            {displayedTranscript.length === 0 && (
              <p className="text-center text-[13px] text-night-muted mt-6">
                {callState === 'IDLE' ? 'Choose a call on the left. It rings here.' : 'Waiting for the caller…'}
              </p>
            )}
            {displayedTranscript.map((seg, i) => (
              <div
                key={i}
                className={`sb-rise rounded-[16px] px-3.5 py-2.5 text-[14px] leading-5 max-w-[88%] ${
                  seg.speaker === 'caller' ? 'self-start' : 'self-end'
                }`}
                style={{ background: seg.speaker === 'caller' ? 'var(--sb-night-card)' : '#2A3A55' }}
              >
                <span className="block text-[10px] font-bold tracking-[0.12em] uppercase text-night-muted mb-0.5">
                  {seg.speaker === 'caller' ? 'They said' : 'You said'}
                </span>
                {seg.text}
              </div>
            ))}
            {isSimulating && live && (
              <span className="text-[11px] text-night-muted flex items-center gap-1.5 pb-1">
                <span className="w-1.5 h-1.5 rounded-full bg-[#7DB8E8] animate-pulse" />
                checking each line as it is said
              </span>
            )}
          </div>

          <div className="relative px-6 pb-8 pt-4">
            {live ? (
              <div className="flex flex-col gap-4">
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => setIsMuted(!isMuted)}
                    aria-pressed={isMuted}
                    className="sb-btn rounded-[18px] min-h-[52px] text-[14px]"
                    style={{ background: isMuted ? 'var(--sb-night-ink)' : 'var(--sb-night-card)', color: isMuted ? 'var(--sb-night)' : 'var(--sb-night-ink)' }}
                  >
                    {isMuted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                    Mute
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsSpeakerOn(!isSpeakerOn)}
                    aria-pressed={isSpeakerOn}
                    className="sb-btn rounded-[18px] min-h-[52px] text-[14px]"
                    style={{ background: isSpeakerOn ? 'var(--sb-night-ink)' : 'var(--sb-night-card)', color: isSpeakerOn ? 'var(--sb-night)' : 'var(--sb-night-ink)' }}
                  >
                    <Volume2 className="w-4 h-4" />
                    Speaker
                  </button>
                </div>
                <button
                  type="button"
                  onClick={handleHangUp}
                  className="sb-btn w-full min-h-[64px] rounded-[24px] text-[20px]"
                  style={{ background: '#E5484D', color: '#0E1015' }}
                >
                  <PhoneOff className="w-5 h-5" />
                  End call
                </button>
              </div>
            ) : callState === 'RINGING' ? (
              <div className="flex justify-center gap-10">
                <button
                  type="button"
                  onClick={handleHangUp}
                  aria-label="Decline"
                  className="sb-btn w-16 h-16 p-0 rounded-full"
                  style={{ background: '#E5484D', color: '#0E1015' }}
                >
                  <PhoneOff className="w-6 h-6" />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (scenarioTimeoutRef.current) clearTimeout(scenarioTimeoutRef.current);
                    answer(selectedScenario);
                  }}
                  aria-label="Answer"
                  className="sb-btn w-16 h-16 p-0 rounded-full animate-pulse"
                  style={{ background: '#7DB8E8', color: '#0E1015' }}
                >
                  <Phone className="w-6 h-6" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => startScenario(selectedScenario)}
                disabled={callState === 'ENDED'}
                className="sb-btn w-full min-h-[56px] rounded-[22px]"
                style={{ background: 'var(--sb-night-card)', color: 'var(--sb-night-ink)' }}
              >
                <Play className="w-4 h-4 fill-current" />
                Ring me with this call
              </button>
            )}
          </div>
        </div>
        {afterCall && (
          <p className="sb-rise rounded-[18px] bg-tert text-on-tert px-4 py-3 text-[14px] font-semibold max-w-[390px] w-full">
            If you shared a code or made a payment, call your bank on the number on your card, or dial 1930.
          </p>
        )}
        <p className="text-[12px] text-faint text-center max-w-[390px]">
          A web page can’t hang up a real phone call. This one is a demo; on a real call, hang up from your phone.
        </p>
      </div>
    </div>
  );
}
