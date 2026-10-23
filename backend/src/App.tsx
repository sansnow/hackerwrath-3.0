import { useState, useCallback, useEffect, useRef } from 'react';
import { HelpCircle, KeyRound, Volume2, VolumeX } from 'lucide-react';
import RiskDisplay from './components/RiskDisplay';
import TranscriptPanel from './components/TranscriptPanel';
import TextInputPanel from './components/TextInputPanel';
import TutorialModal from './components/TutorialModal';
import KeysModal from './components/KeysModal';
import PhoneCallMockup from './components/PhoneCallMockup';
import LiveVoiceTester, { type LiveVoiceHandle } from './components/LiveVoiceTester';
import ThreatIntelPanel from './components/ThreatIntelPanel';
import StatusBar from './components/StatusBar';
import Guardian from './components/Guardian';
import GuardianHome from './components/GuardianHome';
import ScamAlert from './components/ScamAlert';
import { audioAlerts } from './utils/audioAlerts';
import { useHistory, type CheckSource } from './spell/history';
import { askKindOf, categoriesOf, chipsOf, isHigh, toneOf, type AskKind } from './spell/signals';
import { fetchRag } from './spell/rag';
import type { RiskAssessment, TranscriptSegment } from './hooks/useLiveDetection';

type ActiveTab = 'mic' | 'phone' | 'text' | 'intel';
type Edition = 'standard' | 'premium';

const TABS: Array<{ id: ActiveTab; label: string }> = [
  { id: 'mic', label: 'Home' },
  { id: 'phone', label: 'Demo calls' },
  { id: 'text', label: 'Text check' },
  { id: 'intel', label: 'Threat intel' },
];

const SOURCE_FOR_TAB: Record<ActiveTab, CheckSource> = { mic: 'mic', phone: 'call', text: 'text', intel: 'text' };

interface OpenAlert {
  kind: AskKind;
  chips: string[];
  askedAt: number;
  source: CheckSource;
  warningId: string | null;
}

function loadEdition(): Edition {
  try {
    return localStorage.getItem('edgerunners_edition') === 'premium' ? 'premium' : 'standard';
  } catch {
    return 'standard';
  }
}

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('mic');
  const [activeRisk, setActiveRisk] = useState<RiskAssessment | null>(null);
  const [audioLevel, setAudioLevel] = useState<number>(0);
  const [isAudioMuted, setIsAudioMuted] = useState<boolean>(false);
  const [showTutorial, setShowTutorial] = useState(() => {
    try {
      return !localStorage.getItem('suraksha_tutorial_completed');
    } catch {
      return false;
    }
  });
  const [showKeysModal, setShowKeysModal] = useState(false);
  const [transcriptHistory, setTranscriptHistory] = useState<TranscriptSegment[]>([]);
  const [isProcessingText, setIsProcessingText] = useState(false);
  const [listening, setListening] = useState(false);
  const [edition, setEdition] = useState<Edition>(loadEdition);

  const history = useHistory();
  const [alert, setAlert] = useState<OpenAlert | null>(null);
  const [alertRun, setAlertRun] = useState(0);
  const alertRef = useRef<OpenAlert | null>(null);
  alertRef.current = alert;
  const quietRef = useRef<{ kind: AskKind; until: number } | null>(null);

  const voiceRef = useRef<LiveVoiceHandle>(null);
  const hangUpRef = useRef<(() => void) | null>(null);
  const tabRef = useRef(activeTab);
  tabRef.current = activeTab;

  useEffect(() => {
    const root = document.documentElement;
    if (edition === 'premium') root.dataset.edition = 'premium';
    else delete root.dataset.edition;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', edition === 'premium' ? '#0E1014' : '#F4F1EA');
    try {
      localStorage.setItem('edgerunners_edition', edition);
    } catch {
      // Storage blocked: the edition just won't be remembered.
    }
  }, [edition]);

  /** Every assessment goes through here: it updates the guardian and raises the alert on a high-risk ask. */
  const handleAssessment = useCallback(
    (assessment: RiskAssessment | null, source: CheckSource = SOURCE_FOR_TAB[tabRef.current]) => {
      setActiveRisk(assessment);
      if (!assessment || !isHigh(assessment.risk_level) || alertRef.current) return;
      const kind = askKindOf(categoriesOf(assessment));
      const quiet = quietRef.current;
      if (quiet && quiet.kind === kind && Date.now() < quiet.until) return;
      const next: OpenAlert = {
        kind,
        chips: chipsOf(assessment),
        askedAt: Date.now(),
        source,
        // Pasted words aren't a call, so they don't count towards the week.
        warningId: source === 'text' ? null : history.openWarning(source, kind),
      };
      alertRef.current = next;
      setAlert(next);
      setAlertRun((n) => n + 1);
    },
    [history.openWarning]
  );

  const closeAlert = (outcome: 'hung_up' | 'kept') => {
    const current = alertRef.current;
    if (!current) return;
    if (current.warningId) history.resolveWarning(current.warningId, outcome);
    if (outcome === 'kept') quietRef.current = { kind: current.kind, until: Date.now() + 30_000 };
    // Hung up: that call is over, so the guardian goes back to listening.
    if (outcome === 'hung_up') setActiveRisk(null);
    alertRef.current = null;
    setAlert(null);
  };

  const reopenAlert = () => {
    if (!activeRisk) return;
    quietRef.current = null;
    handleAssessment(activeRisk);
  };

  const handleToggleSound = () => {
    const muted = audioAlerts.toggleMute();
    setIsAudioMuted(muted);
  };

  const handleCloseTutorial = useCallback(() => {
    setShowTutorial(false);
    try {
      localStorage.setItem('suraksha_tutorial_completed', 'true');
    } catch {
      // Ignore: the tour shows again next visit.
    }
  }, []);

  const handleRecordingChange = useCallback(
    (recording: boolean) => {
      setListening(recording);
      if (recording) history.addCheck('mic');
    },
    [history.addCheck]
  );

  const toggleListening = () => {
    if (listening) voiceRef.current?.stop();
    else {
      setActiveRisk(null);
      voiceRef.current?.start();
    }
  };

  // Text analysis handler
  const handleAnalyzeText = async (text: string): Promise<void> => {
    if (!text.trim()) return;
    setIsProcessingText(true);

    try {
      const newSeg: TranscriptSegment = {
        text,
        timestamp: Date.now(),
        confidence: 0.98,
        speaker: 'text_input',
      };
      setTranscriptHistory((prev) => [...prev, newSeg]);

      // The rule and context detector and the RAG vector search run side by side.
      const [res, rag] = await Promise.all([
        fetch('/analyze/transcript', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            transcript: text,
            language_code: 'auto',
            transcript_confidence: 0.98,
          }),
        }),
        fetchRag(text),
      ]);

      if (res.ok) {
        const assessment: RiskAssessment = await res.json();
        assessment.rag_classification = rag;
        history.addCheck('text');
        handleAssessment(assessment, 'text');

        if (assessment.risk_level === 'HIGH' || assessment.risk_level === 'CRITICAL') {
          audioAlerts.playHighRiskAlert();
        } else if (assessment.risk_level === 'MEDIUM') {
          audioAlerts.playCautionAlert();
        } else {
          audioAlerts.playSafeChime();
        }
      }
    } catch (e) {
      console.error('Analyze text error:', e);
    } finally {
      setIsProcessingText(false);
    }
  };

  // Segment analysis for Phone Simulator
  const handleAnalyzeSegment = async (text: string): Promise<RiskAssessment | null> => {
    try {
      const [res, rag] = await Promise.all([
        fetch('/analyze/transcript', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            transcript: text,
            language_code: 'auto',
            transcript_confidence: 0.95,
          }),
        }),
        fetchRag(text),
      ]);

      if (res.ok) {
        const assessment: RiskAssessment = await res.json();
        assessment.rag_classification = rag;
        handleAssessment(assessment, 'call');
        setTranscriptHistory((prev) => [
          ...prev,
          {
            text,
            timestamp: Date.now(),
            confidence: 0.95,
            speaker: 'caller',
          },
        ]);
        return assessment;
      }
    } catch (e) {
      console.error('Segment analysis error', e);
    }
    return null;
  };

  const registerHangUp = useCallback((fn: (() => void) | null) => {
    hangUpRef.current = fn;
  }, []);

  const tone = toneOf(activeRisk?.risk_level, listening);

  const alertActions = (a: OpenAlert) => {
    if (a.source === 'mic') {
      return {
        primary: {
          label: 'I hung up',
          onClick: () => {
            closeAlert('hung_up');
            voiceRef.current?.stop();
          },
        },
        secondary: { label: 'Keep listening', onClick: () => closeAlert('kept') },
      };
    }
    if (a.source === 'call') {
      return {
        primary: {
          label: 'End call',
          onClick: () => {
            closeAlert('hung_up');
            hangUpRef.current?.();
          },
        },
        secondary: { label: 'Keep talking', onClick: () => closeAlert('kept') },
      };
    }
    return {
      primary: { label: 'Got it', onClick: () => closeAlert('kept') },
      secondary: { label: 'Check other words', onClick: () => closeAlert('kept') },
    };
  };

  return (
    <div className="min-h-screen flex flex-col">
      <header className="sticky top-0 z-30 border-b border-line backdrop-blur-md" style={{ background: 'var(--sb-nav)' }}>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
          <button
            type="button"
            onClick={() => setActiveTab('mic')}
            className="flex items-center gap-2.5 bg-transparent border-0 p-0 text-left"
            aria-label="Edgerunners, home"
          >
            <Guardian tone={tone} size={40} />
            <span className="sb-display text-[26px] leading-none">Edgerunners</span>
            {edition === 'premium' && (
              <span className="text-[10px] font-bold tracking-[0.18em] px-2 py-0.5 rounded-full bg-accent text-on-accent">PREMIUM</span>
            )}
          </button>

          <nav
            aria-label="Sections"
            className="order-last md:order-none w-full md:w-auto flex items-center gap-1 p-1 rounded-full bg-surface overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                aria-current={activeTab === tab.id ? 'page' : undefined}
                onClick={() => {
                  audioAlerts.playClick();
                  setActiveTab(tab.id);
                }}
                className={`flex-1 md:flex-none whitespace-nowrap px-4 min-h-10 rounded-full text-[14px] font-bold transition-colors ${
                  activeTab === tab.id ? 'bg-accent text-on-accent' : 'text-muted hover:text-ink'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </nav>

          <div className="flex items-center gap-1.5">
            <div role="radiogroup" aria-label="Edition" className="hidden sm:flex items-center p-1 rounded-full bg-surface">
              {(['standard', 'premium'] as const).map((e) => (
                <button
                  key={e}
                  type="button"
                  role="radio"
                  aria-checked={edition === e}
                  onClick={() => setEdition(e)}
                  className={`px-3 min-h-8 rounded-full text-[12px] font-bold capitalize transition-colors ${
                    edition === e ? 'bg-card text-head shadow-sm' : 'text-faint hover:text-ink'
                  }`}
                >
                  {e}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={handleToggleSound}
              className="sb-btn sb-btn-ghost w-11 h-11 p-0 rounded-full"
              aria-label={isAudioMuted ? 'Turn warning sounds on' : 'Turn warning sounds off'}
              aria-pressed={!isAudioMuted}
            >
              {isAudioMuted ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
            </button>
            <button type="button" onClick={() => setShowKeysModal(true)} className="sb-btn sb-btn-ghost w-11 h-11 p-0 rounded-full" aria-label="Keys and services">
              <KeyRound className="w-5 h-5" />
            </button>
            <button type="button" onClick={() => setShowTutorial(true)} className="sb-btn sb-btn-ghost w-11 h-11 p-0 rounded-full" aria-label="How it works">
              <HelpCircle className="w-5 h-5" />
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-6 sm:py-10">
        {/* Home stays mounted so listening carries on while you look at other sections. */}
        <div hidden={activeTab !== 'mic'} className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-12 items-start">
          <section aria-label="Scam check" className="lg:col-span-5 lg:sticky lg:top-28">
            <GuardianHome
              listening={listening}
              tone={tone}
              level={audioLevel}
              onToggle={toggleListening}
              records={history.records}
            />
          </section>
          <section aria-label="This call" className="lg:col-span-7 flex flex-col gap-5">
            <RiskDisplay assessment={activeRisk} isListening={listening} onOpenAlert={alert ? undefined : reopenAlert} />
            <LiveVoiceTester
              ref={voiceRef}
              onAssessmentUpdate={handleAssessment}
              onAudioLevelChange={setAudioLevel}
              onRecordingChange={handleRecordingChange}
              activeRisk={activeRisk}
            />
          </section>
        </div>

        {activeTab === 'phone' && (
          <div className="flex flex-col gap-6">
            <PhoneCallMockup
              onAnalyzeSegment={handleAnalyzeSegment}
              activeRisk={activeRisk}
              onCallStart={() => history.addCheck('call')}
              onRegisterHangUp={registerHangUp}
              onCheckAsText={(transcript) => {
                setActiveTab('text');
                handleAnalyzeText(transcript);
              }}
            />
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              <div className="lg:col-span-7">
                <RiskDisplay assessment={activeRisk} isListening={false} onOpenAlert={alert ? undefined : reopenAlert} />
              </div>
              <div className="lg:col-span-5">
                <TranscriptPanel segments={transcriptHistory} isListening={false} />
              </div>
            </div>
          </div>
        )}

        {activeTab === 'text' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            <div className="lg:col-span-7 flex flex-col gap-6">
              <TextInputPanel onAnalyze={handleAnalyzeText} isProcessing={isProcessingText} />
              <RiskDisplay assessment={activeRisk} isListening={false} onOpenAlert={alert ? undefined : reopenAlert} />
            </div>
            <div className="lg:col-span-5">
              <TranscriptPanel segments={transcriptHistory} isListening={false} />
            </div>
          </div>
        )}

        {activeTab === 'intel' && (
          <div className="flex flex-col gap-6">
            <ThreatIntelPanel />
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              <div className="lg:col-span-7">
                <RiskDisplay assessment={activeRisk} isListening={false} onOpenAlert={alert ? undefined : reopenAlert} />
              </div>
              <div className="lg:col-span-5">
                <TranscriptPanel segments={transcriptHistory} isListening={false} />
              </div>
            </div>
          </div>
        )}
      </main>

      <footer className="mt-auto border-t border-line">
        <StatusBar />
      </footer>

      {alert && (
        <ScamAlert
          key={alertRun}
          kind={alert.kind}
          chips={alert.chips}
          run={alertRun - 1}
          premium={edition === 'premium'}
          askedAt={alert.askedAt}
          {...alertActions(alert)}
        />
      )}
      <TutorialModal isOpen={showTutorial} onClose={handleCloseTutorial} onNavigateTab={setActiveTab} />
      <KeysModal isOpen={showKeysModal} onClose={() => setShowKeysModal(false)} />
    </div>
  );
}
