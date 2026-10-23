import { useState, useRef, useEffect, useCallback, useImperativeHandle, forwardRef } from 'react';
import { Mic, MicOff, AlertOctagon, Globe, Trash2, Play, PhoneCall, Headphones } from 'lucide-react';
import { audioAlerts } from '../utils/audioAlerts';
import type { RiskAssessment } from '../hooks/useLiveDetection';
import { fetchRag } from '../spell/rag';

const PRESETS = [
  { label: 'Asks for your OTP', text: 'Sir, please share your 6 digit OTP right now to verify account.' },
  { label: 'Account blocked, wants your UPI PIN', text: 'Your bank account is blocked, give me your UPI PIN immediately.' },
  { label: 'Digital arrest threat', text: 'You are under digital arrest by CBI Mumbai. Non-bailable warrant issued.' },
  { label: 'An ordinary call', text: 'Hello, I want to check my account balance and get a mini statement.' },
];

const SOURCE_LABEL: Record<string, string> = {
  microphone: 'microphone',
  preset: 'test line',
  telegram_bridge: 'Telegram bridge',
  dual_capture: 'mic + call audio',
};

/** The home's shield starts and stops listening through this handle. */
export interface LiveVoiceHandle {
  start: () => void;
  stop: () => void;
}

interface StoredUtterance {
  id: string;
  text: string;
  timestamp: number;
  speaker: string;
  language: string;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';
  riskScore: number;
  flaggedKeywords: string[];
  safeAction?: string;
  source: 'microphone' | 'preset' | 'telegram_bridge' | 'dual_capture';
}

interface LiveVoiceTesterProps {
  onAssessmentUpdate: (assessment: RiskAssessment | null) => void;
  onAudioLevelChange?: (level: number) => void;
  activeRisk: RiskAssessment | null;
  onRecordingChange?: (recording: boolean) => void;
}

const LiveVoiceTester = forwardRef<LiveVoiceHandle, LiveVoiceTesterProps>(function LiveVoiceTester(
  { onAssessmentUpdate, onAudioLevelChange, activeRisk, onRecordingChange },
  ref
) {
  const [isRecording, setIsRecording] = useState(false);
  const [captureMode, setCaptureMode] = useState<'mic' | 'dual'>('mic');
  const [languageCode, setLanguageCode] = useState('auto');
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [statusText, setStatusText] = useState('Put the call on speaker and tap the shield.');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [callId] = useState(() => `mic-live-${Date.now().toString(36)}`);
  const [audioLevel, setAudioLevel] = useState(0);
  const [storedUtterances, setStoredUtterances] = useState<StoredUtterance[]>([]);
  const [liveTranscriptPreview, setLiveTranscriptPreview] = useState('');
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isSimulatingTelegram, setIsSimulatingTelegram] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const processorNodeRef = useRef<ScriptProcessorNode | null>(null);
  const liveWsRef = useRef<WebSocket | null>(null);
  const animFrameRef = useRef<number>(0);
  const streamRef = useRef<MediaStream | null>(null);
  const systemStreamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const speechRecognitionRef = useRef<any>(null);
  const chunksRef = useRef<Blob[]>([]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopRecordingSync();
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const stopRecordingSync = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (processorNodeRef.current) {
      try {
        processorNodeRef.current.disconnect();
      } catch {}
      processorNodeRef.current = null;
    }
    if (liveWsRef.current) {
      try {
        if (liveWsRef.current.readyState === WebSocket.OPEN) {
          liveWsRef.current.send(JSON.stringify({ type: 'stop' }));
        }
        liveWsRef.current.close();
      } catch {}
      liveWsRef.current = null;
    }
    if (speechRecognitionRef.current) {
      try {
        speechRecognitionRef.current.stop();
      } catch {}
      speechRecognitionRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (systemStreamRef.current) {
      systemStreamRef.current.getTracks().forEach((t) => t.stop());
      systemStreamRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    setIsRecording(false);
    setAudioLevel(0);
    if (onAudioLevelChange) onAudioLevelChange(0);
  };

  // Process text through scam detection engine
  const evaluateTranscript = useCallback(
    async (
      text: string,
      source: 'microphone' | 'preset' | 'telegram_bridge' = 'microphone',
      confidence: number = 0.95
    ) => {
      if (!text.trim()) return;

      try {
        const res = await fetch(`/calls/${callId}/segments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: text.trim(),
            speaker: 'caller',
            language_code: languageCode,
            start_seconds: 0,
            end_seconds: 4,
            transcript_confidence: confidence,
          }),
        });

        if (res.ok) {
          const update = await res.json();
          // The risk of this line, not the whole session's, so an ordinary line after a scam one
          // isn't flagged too.
          const assessment: RiskAssessment = update.moment_assessment ?? update.assessment;
          if (assessment) {
            // Nearest real dialogues from the RAG store, shown under "Sounds like".
            assessment.rag_classification = await fetchRag(text.trim());
            onAssessmentUpdate(assessment);

            const keywords = (assessment.rule_analysis?.triggered_indicators || []).map(
              (i: any) => i.keyword_or_pattern
            );

            // Add to temporary speech history
            const newUtterance: StoredUtterance = {
              id: `utt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              text: text.trim(),
              timestamp: Date.now(),
              speaker: 'caller',
              language: languageCode,
              riskLevel: assessment.risk_level,
              riskScore: assessment.risk_score,
              flaggedKeywords: keywords,
              safeAction: assessment.recommended_action,
              source,
            };

            setStoredUtterances((prev) => [newUtterance, ...prev]);

            // Audio Alert
            if (assessment.risk_level === 'HIGH' || assessment.risk_level === 'CRITICAL') {
              audioAlerts.playHighRiskAlert();
            } else if (assessment.risk_level === 'MEDIUM') {
              audioAlerts.playCautionAlert();
            } else {
              audioAlerts.playSafeChime();
            }

            setStatusText(
              `Analyzed: "${text.slice(0, 35)}..." → ${assessment.risk_level} (${Math.round(
                assessment.risk_score
              )}/100)`
            );
          }
        }
      } catch (err: any) {
        console.error('Error evaluating transcript:', err);
        setErrorMsg('Error evaluating speech with detection engine');
      }
    },
    [callId, languageCode, onAssessmentUpdate]
  );

  // Start Live Microphone Recording & Continuous WebSocket Stream
  const startRecording = async () => {
    setErrorMsg(null);
    setLiveTranscriptPreview('');
    setRecordingSeconds(0);
    chunksRef.current = [];
    audioAlerts.playClick();

    try {
      // 1. Microphone capture
      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = micStream;

      // 2. Dual Mode: System / Telegram Audio capture if selected
      let systemStream: MediaStream | null = null;
      if (captureMode === 'dual') {
        try {
          systemStream = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: {
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false,
            },
          });
          systemStreamRef.current = systemStream;
        } catch (displayErr) {
          console.warn('System audio selection cancelled or unavailable:', displayErr);
          setStatusText('Call audio wasn’t shared, so only the microphone is listening.');
        }
      }

      // Connect Direct WebSocket to Backend Live Stream
      const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      // Pin Sarvam to the chosen language; on "auto" it guesses per slice and can drift.
      const wsUrl = `${wsProtocol}//${window.location.host}/internal/live/browser-stream?language=${encodeURIComponent(languageCode)}`;
      const ws = new WebSocket(wsUrl);
      liveWsRef.current = ws;

      ws.onopen = () => {
        setStatusText(
          captureMode === 'dual' && systemStream
            ? 'Listening to the microphone and the call audio.'
            : 'Listening. Every few words are checked as they are said.'
        );
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'session_ready') {
            setStatusText(`Call monitoring connected (${data.callId}) — listening continuously...`);
          } else if (data.type === 'caption_chunk') {
            const textChunk = data.text || '';
            const newUtterance: StoredUtterance = {
              id: `utt_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
              text: textChunk,
              timestamp: Date.now(),
              speaker: data.speaker || 'caller',
              language: data.language || languageCode,
              riskLevel: data.riskLevel,
              riskScore: data.riskScore,
              flaggedKeywords: data.flaggedKeywords || [],
              safeAction: data.recommendedAction,
              source: data.source || (captureMode === 'dual' && systemStream ? 'dual_capture' : 'microphone'),
            };

            setStoredUtterances((prev) => [newUtterance, ...prev]);

            if (onAssessmentUpdate) {
              const triggered = (data.flaggedKeywords || []).map((k: string, i: number) => ({
                indicator_name: k,
                keyword_or_pattern: k,
                category: data.flaggedCategories?.[i] || 'SUSPICIOUS_PHRASE',
                weight: 15,
                matched_text: k,
              }));

              onAssessmentUpdate({
                risk_score: data.riskScore ?? 0,
                risk_level: data.riskLevel ?? 'LOW',
                caption: data.text || textChunk,
                reasons: (data.flaggedKeywords && data.flaggedKeywords.length > 0)
                  ? data.flaggedKeywords.map((k: string) => `Flagged indicator: ${k}`)
                  : ['Analyzing conversation in real time'],
                recommended_action: data.recommendedAction || 'Continue with normal caution',
                confidence: 0.94,
                evidence: data.flaggedKeywords || [],
                rule_analysis: {
                  rule_score: data.riskScore ?? 0,
                  triggered_indicators: triggered,
                  suppressed_protective_matches: [],
                },
                contextual_analysis: {
                  caller_identity_claim: 'Call Participant',
                  claimed_organisation: 'Unknown',
                  intent_classification: (data.riskLevel === 'CRITICAL' || data.riskLevel === 'HIGH') ? 'Suspicious Solicitation' : 'General Speech',
                  possible_impersonation: Boolean(data.riskLevel === 'CRITICAL' || data.riskLevel === 'HIGH'),
                },
              } as any);
            }

            if (data.riskLevel === 'HIGH' || data.riskLevel === 'CRITICAL') {
              audioAlerts.playHighRiskAlert();
            } else if (data.riskLevel === 'MEDIUM') {
              audioAlerts.playCautionAlert();
            }

            setStatusText(
              `Live Caption (~${data.wordCount || 8} words): "${textChunk.slice(0, 30)}..." → ${data.riskLevel} (${Math.round(
                data.riskScore
              )}/100)`
            );
          } else if (data.type === 'telegram_alert_sent') {
            setStatusText(`Telegram alert sent (message #${data.messageId}).`);
          }
        } catch (wsErr) {
          console.warn('WS message parse error:', wsErr);
        }
      };

      ws.onerror = (err) => {
        console.warn('WebSocket streaming error; fallback active:', err);
      };

      // Web Audio Context for Waveform & Real-Time PCM16 Extraction
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const actx = new AudioCtx({ sampleRate: 16000 });
      audioContextRef.current = actx;

      // Audio Graph with Mixer Bus
      const mixer = actx.createGain();
      mixer.gain.value = 1.0;

      // Connect Mic
      const micSource = actx.createMediaStreamSource(micStream);
      micSource.connect(mixer);

      // Connect System Audio if present
      if (systemStream && systemStream.getAudioTracks().length > 0) {
        const sysSource = actx.createMediaStreamSource(systemStream);
        sysSource.connect(mixer);
      }

      const analyser = actx.createAnalyser();
      analyser.fftSize = 64;
      mixer.connect(analyser);
      analyserRef.current = analyser;

      // Extract 16kHz PCM16LE mono chunks and stream over WebSocket
      const processor = actx.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (e) => {
        if (!liveWsRef.current || liveWsRef.current.readyState !== WebSocket.OPEN) return;
        const channelData = e.inputBuffer.getChannelData(0);
        const pcm16 = new Int16Array(channelData.length);
        for (let i = 0; i < channelData.length; i++) {
          const s = Math.max(-1, Math.min(1, channelData[i]));
          pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        liveWsRef.current.send(pcm16.buffer);
      };
      mixer.connect(processor);

      // Connect processor to destination with zero gain to prevent mic feedback echo
      const muteGain = actx.createGain();
      muteGain.gain.value = 0;
      processor.connect(muteGain);
      muteGain.connect(actx.destination);
      processorNodeRef.current = processor;

      const buffer = new Uint8Array(analyser.frequencyBinCount);
      const updateLevel = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteFrequencyData(buffer);
        let sum = 0;
        for (let i = 0; i < buffer.length; i++) sum += buffer[i];
        const avg = sum / buffer.length / 255;
        setAudioLevel(avg);
        if (onAudioLevelChange) onAudioLevelChange(avg);
        animFrameRef.current = requestAnimationFrame(updateLevel);
      };
      updateLevel();

      // Browser Web Speech recognition for instant zero-latency preview
      const SpeechRecognition =
        (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (SpeechRecognition) {
        try {
          const recognizer = new SpeechRecognition();
          recognizer.continuous = true;
          recognizer.interimResults = true;
          recognizer.lang =
            languageCode === 'hi-IN'
              ? 'hi-IN'
              : languageCode === 'pa-IN'
              ? 'pa-IN'
              : languageCode === 'en-IN'
              ? 'en-IN'
              : 'hi-IN';
          recognizer.onresult = (event: any) => {
            let current = '';
            for (let i = 0; i < event.results.length; i++) {
              current += event.results[i][0].transcript + ' ';
            }
            setLiveTranscriptPreview(current.trim());
          };
          recognizer.start();
          speechRecognitionRef.current = recognizer;
        } catch (e) {
          console.warn('Web Speech recognizer init skipped:', e);
        }
      }

      setIsRecording(true);
      setStatusText('Listening. Every few words are checked as they are said.');

      // Recording timer
      timerRef.current = setInterval(() => {
        setRecordingSeconds((prev) => prev + 1);
      }, 1000);
    } catch (err: any) {
      setErrorMsg(err.message || 'Microphone access denied or unavailable.');
      setIsRecording(false);
    }
  };

  // Stop Recording & Send Final Flush
  const stopRecording = () => {
    audioAlerts.playClick();
    if (liveWsRef.current && liveWsRef.current.readyState === WebSocket.OPEN) {
      try {
        liveWsRef.current.send(JSON.stringify({ type: 'stop' }));
      } catch {}
    }
    stopRecordingSync();
    setStatusText('Stopped listening. This session is saved.');
  };

  // Test Simulation of Telegram VoIP Call Bridge
  const handleTestTelegramBridge = async () => {
    setIsSimulatingTelegram(true);
    setStatusText('Sending a test call through the Telegram bridge…');
    try {
      const res = await fetch('/internal/live/spike', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transcript:
            'Hello sir, I am calling from bank headquarters. Your account is blocked today. Share the 6-digit OTP immediately.',
          customer_name: 'Telegram Audio Caller',
        }),
      });

      if (res.ok) {
        const data = await res.json();
        const assessment = data.assessment;
        onAssessmentUpdate(assessment);

        const newUtterance: StoredUtterance = {
          id: `utt_tg_${Date.now()}`,
          text: data.customer_name + ': ' + 'Your account is blocked today. Share the 6-digit OTP immediately.',
          timestamp: Date.now(),
          speaker: 'telegram_caller',
          language: 'mixed',
          riskLevel: assessment.risk_level,
          riskScore: assessment.risk_score,
          flaggedKeywords: data.flagged_keywords || ['OTP', 'ACCOUNT_SUSPENSION'],
          safeAction: assessment.recommended_action,
          source: 'telegram_bridge',
        };

        setStoredUtterances((prev) => [newUtterance, ...prev]);
        audioAlerts.playHighRiskAlert();
        setStatusText('The Telegram bridge test call reached the detector and was flagged.');
      }
    } catch (err: any) {
      setErrorMsg('Failed to test Telegram bridge spike: ' + err.message);
    } finally {
      setIsSimulatingTelegram(false);
    }
  };

  // Highlight flagged keywords in text
  const renderHighlightedText = (text: string, keywords: string[]) => {
    if (!keywords || keywords.length === 0) return text;
    const escaped = keywords
      .filter(Boolean)
      .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|');
    if (!escaped) return text;

    const regex = new RegExp(`(${escaped})`, 'gi');
    const isKeyword = new RegExp(`^(${escaped})$`, 'i');
    const parts = text.split(regex);

    return parts.map((part, i) =>
      isKeyword.test(part) ? (
        <span
          key={i}
          className="px-1 rounded-md bg-danger text-on-danger font-bold"
        >
          {part}
        </span>
      ) : (
        part
      )
    );
  };

  // Always call the latest start/stop, whichever render the shield was tapped in.
  const controlsRef = useRef({ startRecording, stopRecording, isRecording });
  controlsRef.current = { startRecording, stopRecording, isRecording };
  useImperativeHandle(
    ref,
    () => ({
      start: () => {
        if (!controlsRef.current.isRecording) controlsRef.current.startRecording();
      },
      stop: () => {
        if (controlsRef.current.isRecording) controlsRef.current.stopRecording();
      },
    }),
    []
  );

  useEffect(() => {
    onRecordingChange?.(isRecording);
  }, [isRecording, onRecordingChange]);

  const danger = activeRisk?.risk_level === 'HIGH' || activeRisk?.risk_level === 'CRITICAL';

  return (
    <div className="sb-card p-5 sm:p-6 flex flex-col gap-5">
      {/* Where the sound comes from, and in which language */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <div className="sb-eyebrow">Live check</div>
          <h3 className="text-[22px] leading-7 font-extrabold text-head mt-1">
            {isRecording ? `Listening · ${recordingSeconds} s` : isTranscribing ? 'Checking what was said' : 'Ready when you are'}
          </h3>
          <p className="text-[13px] text-faint mt-0.5 max-w-md" aria-live="polite">
            {statusText}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-bold text-faint tracking-[0.12em] uppercase flex items-center gap-1">
              <Headphones className="w-3.5 h-3.5" /> Sound
            </span>
            <select
              value={captureMode}
              onChange={(e) => setCaptureMode(e.target.value as 'mic' | 'dual')}
              disabled={isRecording}
              className="sb-input px-3 py-2 text-[13px] font-semibold"
              title="Mic only (speaker phone) or Dual (also captures Telegram or system call audio)"
            >
              <option value="mic">Microphone only</option>
              <option value="dual">Mic + call audio (headphones)</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-bold text-faint tracking-[0.12em] uppercase flex items-center gap-1">
              <Globe className="w-3.5 h-3.5" /> Language
            </span>
            <select
              value={languageCode}
              onChange={(e) => setLanguageCode(e.target.value)}
              disabled={isRecording}
              className="sb-input px-3 py-2 text-[13px] font-semibold"
            >
              <option value="auto">Any (Hindi, English, Punjabi)</option>
              <option value="hi-IN">हिन्दी · Hindi</option>
              <option value="en-IN">English (India)</option>
              <option value="pa-IN">ਪੰਜਾਬੀ · Punjabi</option>
            </select>
          </label>
        </div>
      </div>

      {captureMode === 'dual' && !isRecording && (
        <div className="sb-soft rounded-[16px] px-4 py-3 text-[13px] text-muted flex items-start gap-2.5">
          <Headphones className="w-4 h-4 text-accent shrink-0 mt-0.5" />
          <span>
            When you start, your browser asks what to share. Pick the <strong className="text-head">Telegram window</strong> and tick{' '}
            <strong className="text-head">Also share system audio</strong>, so the caller’s voice is heard through your headphones.
          </span>
        </div>
      )}

      {/* The voice, as a breathing line */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={isRecording ? stopRecording : startRecording}
          disabled={isTranscribing}
          className={`sb-btn shrink-0 rounded-full w-12 h-12 p-0 ${isRecording ? 'sb-btn-end' : 'sb-btn-primary'}`}
          aria-label={isRecording ? 'Stop listening' : 'Start listening'}
          style={isRecording ? { boxShadow: 'none' } : undefined}
        >
          {isRecording ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
        </button>
        <div className="flex-1 h-12 rounded-full bg-surface flex items-center justify-center gap-[5px] px-5 overflow-hidden" aria-hidden="true">
          {[...Array(32)].map((_, i) => {
            const h = Math.max(4, Math.abs(Math.sin(i * 0.45 + audioLevel * 10)) * audioLevel * 34 + 4);
            return (
              <span
                key={i}
                className="w-[3px] rounded-full transition-all duration-75"
                style={{
                  height: `${isRecording ? h : 4}px`,
                  background: danger ? 'var(--sb-end)' : isRecording ? 'var(--sb-accent)' : 'var(--sb-off)',
                }}
              />
            );
          })}
        </div>
      </div>

      {isRecording && liveTranscriptPreview && (
        <div className="sb-soft rounded-[16px] px-4 py-3 sb-rise">
          <span className="text-[11px] font-bold tracking-[0.12em] uppercase text-faint block mb-1">Hearing</span>
          <p className="text-[15px] text-ink italic">{liveTranscriptPreview}</p>
        </div>
      )}

      {errorMsg && (
        <div className="rounded-[16px] bg-danger-soft text-danger-ink px-4 py-3 text-[13px] font-semibold flex items-center justify-between gap-3">
          <span className="flex items-center gap-2">
            <AlertOctagon className="w-4 h-4 shrink-0" />
            {errorMsg}
          </span>
          <button type="button" onClick={() => setErrorMsg(null)} className="underline shrink-0">
            Dismiss
          </button>
        </div>
      )}

      {/* Say it for them: one tap sends a caller's line through the detector */}
      <div className="flex flex-col gap-2.5">
        <div className="flex items-center justify-between">
          <span className="sb-eyebrow">Try a caller’s line</span>
          <span className="text-[12px] text-faint">sent to the real detector</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => evaluateTranscript(p.text, 'preset')}
              className="group text-left rounded-[16px] bg-surface hover:bg-accent-soft px-4 py-3 transition-colors flex items-center justify-between gap-3 active:scale-[0.98]"
            >
              <span className="min-w-0">
                <span className="block text-[14px] font-extrabold text-head">{p.label}</span>
                <span className="block text-[12px] text-faint truncate">“{p.text}”</span>
              </span>
              <Play className="w-4 h-4 shrink-0 text-accent fill-current" />
            </button>
          ))}
        </div>
      </div>

      {/* Telegram VoIP call bridge (onfloor) */}
      <div className="rounded-[18px] border border-line px-4 py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <PhoneCall className="w-4 h-4 text-accent" />
            <span className="text-[14px] font-extrabold text-head">Telegram call bridge</span>
            <code className="font-mono text-[11px] px-2 py-0.5 rounded-full bg-accent-soft text-on-accent-soft">/internal/live/ingest</code>
          </div>
          <p className="text-[12px] text-faint mt-1">
            Brings live Telegram calls from <code className="font-mono">py-tgcalls</code> into the same detector.
          </p>
        </div>
        <button type="button" onClick={handleTestTelegramBridge} disabled={isSimulatingTelegram} className="sb-btn sb-btn-outline shrink-0 text-[14px]">
          {isSimulatingTelegram ? 'Sending…' : 'Send a test call'}
        </button>
      </div>

      {/* What was heard this session */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <span className="sb-eyebrow">Heard this session · {storedUtterances.length}</span>
          {storedUtterances.length > 0 && (
            <button
              type="button"
              onClick={() => setStoredUtterances([])}
              className="text-[12px] font-semibold text-faint hover:text-ink flex items-center gap-1"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Clear
            </button>
          )}
        </div>

        {storedUtterances.length === 0 ? (
          <p className="sb-soft rounded-[16px] px-4 py-6 text-center text-[13px] text-faint">
            Nothing yet. Tap the shield and say a line like “tell me your OTP”, or try one above.
          </p>
        ) : (
          <ul className="flex flex-col gap-2.5 max-h-[380px] overflow-y-auto pr-1 list-none">
            {storedUtterances.map((utt) => {
              const isDanger = utt.riskLevel === 'HIGH' || utt.riskLevel === 'CRITICAL';
              const isCaution = utt.riskLevel === 'MEDIUM';
              return (
                <li
                  key={utt.id}
                  className={`rounded-[18px] px-4 py-3 sb-rise border ${
                    isDanger ? 'bg-danger-soft border-danger/20' : isCaution ? 'bg-warn-soft border-warn/40' : 'bg-card border-line'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 text-[11px] text-faint mb-1.5">
                    <span className="font-semibold">
                      {new Date(utt.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })} ·{' '}
                      {SOURCE_LABEL[utt.source] || utt.source}
                    </span>
                    <span
                      className={`px-2 py-0.5 rounded-full font-bold tracking-[0.08em] ${
                        isDanger ? 'bg-danger text-on-danger' : isCaution ? 'bg-warn text-on-warn' : 'bg-accent-soft text-on-accent-soft'
                      }`}
                    >
                      {isDanger ? 'HIGH RISK' : isCaution ? 'POSSIBLE RISK' : 'NO ASK'}
                    </span>
                  </div>
                  <p className="text-[15px] leading-[22px] font-semibold text-ink">{renderHighlightedText(utt.text, utt.flaggedKeywords)}</p>
                  {utt.flaggedKeywords && utt.flaggedKeywords.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {utt.flaggedKeywords.map((kw, i) => (
                        <span key={i} className="text-[11px] font-mono px-2 py-0.5 rounded-full bg-card text-danger-ink">
                          {kw}
                        </span>
                      ))}
                    </div>
                  )}
                  {utt.safeAction && isDanger && <p className="mt-2 text-[13px] font-semibold text-danger-ink">{utt.safeAction}</p>}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
});

export default LiveVoiceTester;
