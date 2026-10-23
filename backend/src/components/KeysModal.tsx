import { useEffect, useState } from 'react';
import { X, Copy, Check } from 'lucide-react';

interface KeysModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const ENV_TEMPLATE = `# Sarvam AI Configuration (Speech-to-Text)
SARVAM_API_KEY="your_sarvam_api_key_here"
SARVAM_BASE_URL="https://api.sarvam.ai"
SARVAM_STT_MODEL="saaras:v3"

# Optional Telegram Bot Protective Alerts
TELEGRAM_BOT_TOKEN="your_telegram_bot_token_here"
TELEGRAM_CHAT_ID="your_telegram_chat_id_here"
TELEGRAM_ALERTS_ENABLED="true"
TELEGRAM_ALERT_THRESHOLD="HIGH"
TELEGRAM_AUTHORIZED_USERS=""

# Twilio Ingestion (Phase 2 - Telephony)
# TWILIO_ACCOUNT_SID="your_sid_here"
# TWILIO_AUTH_TOKEN="your_token_here"

# Optional Gemini AI Director
# GEMINI_API_KEY="your_gemini_key_here"`;

type HealthCheck = { state: 'checking' | 'ok' | 'demo' | 'offline'; text: string };

export default function KeysModal({ isOpen, onClose }: KeysModalProps) {
  const [copied, setCopied] = useState(false);
  const [check, setCheck] = useState<HealthCheck>({ state: 'checking', text: 'Checking the detector…' });

  const runCheck = async () => {
    setCheck({ state: 'checking', text: 'Checking the detector…' });
    try {
      const res = await fetch('/health');
      const data = await res.json();
      if (data.status === 'ok') {
        const model = data.modules?.speech_to_text?.model || 'saaras:v3';
        setCheck(
          data.sarvam_configured
            ? { state: 'ok', text: `Connected. Sarvam speech to text (${model}) has a key.` }
            : { state: 'demo', text: 'Connected, but no Sarvam key is set: speech to text runs in demo mode.' }
        );
      } else {
        setCheck({ state: 'offline', text: 'The detector answered, but not with “ok”.' });
      }
    } catch (e: any) {
      setCheck({ state: 'offline', text: `Can’t reach the detector: ${e.message}` });
    }
  };

  useEffect(() => {
    if (isOpen) runCheck();
  }, [isOpen]);

  if (!isOpen) return null;

  const handleCopyEnv = () => {
    navigator.clipboard.writeText(ENV_TEMPLATE);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const rows: Array<{ name: string; tag: string; tone: 'on' | 'later' | 'optional'; body: string }> = [
    {
      name: 'Sarvam speech to text',
      tag: check.state === 'ok' ? 'Key set' : check.state === 'demo' ? 'No key' : '—',
      tone: check.state === 'ok' ? 'on' : 'optional',
      body: 'Turns calls into words (Saaras v3) in Hindi, Indian English and Punjabi.',
    },
    {
      name: 'Contextual detector',
      tag: 'Built in',
      tone: 'on',
      body: 'Reads what the caller is after and ignores safety advice like “never share your OTP”. A Gemini key is optional.',
    },
    {
      name: 'Telegram alerts',
      tag: 'Optional',
      tone: 'optional',
      body: 'Sends a protective alert to your Telegram chat on high risk, with personal details scrubbed.',
    },
    {
      name: 'Twilio phone calls',
      tag: 'Later',
      tone: 'later',
      body: 'For real carrier calls. Not needed for the demo: the microphone works with a call on speaker.',
    },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 sb-fade backdrop-blur-sm" style={{ background: 'var(--sb-scrim)' }} onClick={onClose} />

      <div role="dialog" aria-modal="true" aria-labelledby="sb-keys-title" className="relative max-w-xl w-full max-h-[92vh] overflow-y-auto rounded-[32px] bg-paper p-6 sm:p-8 sb-rise shadow-2xl">
        <button type="button" onClick={onClose} aria-label="Close" className="sb-btn sb-btn-ghost absolute top-4 right-4 w-11 h-11 p-0 rounded-full">
          <X className="w-5 h-5" />
        </button>

        <div className="sb-eyebrow">Setup</div>
        <h2 id="sb-keys-title" className="sb-display text-[34px] mt-1 mb-1">Keys and services</h2>
        <p
          className={`text-[14px] font-semibold mb-5 ${check.state === 'offline' ? 'text-danger' : check.state === 'demo' ? 'text-warn-ink' : 'text-muted'}`}
          aria-live="polite"
        >
          {check.text}
        </p>

        <ul className="flex flex-col gap-2.5 mb-6 list-none">
          {rows.map((row) => (
            <li key={row.name} className="sb-card px-4 py-3.5">
              <div className="flex items-center justify-between gap-3 mb-1">
                <span className="text-[15px] font-extrabold text-head">{row.name}</span>
                <span
                  className={`sb-chip text-[11px] px-2.5 py-1 ${
                    row.tone === 'on' ? 'bg-accent-soft text-on-accent-soft' : row.tone === 'later' ? 'bg-surface text-faint' : 'bg-warn-soft text-warn-ink'
                  }`}
                >
                  {row.tag}
                </span>
              </div>
              <p className="text-[13px] text-muted">{row.body}</p>
            </li>
          ))}
        </ul>

        <div className="flex flex-col sm:flex-row gap-2.5 sm:justify-between">
          <button type="button" onClick={runCheck} disabled={check.state === 'checking'} className="sb-btn sb-btn-soft">
            {check.state === 'checking' ? 'Checking…' : 'Check again'}
          </button>
          <button type="button" onClick={handleCopyEnv} className="sb-btn sb-btn-primary">
            {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            {copied ? 'Copied the .env template' : 'Copy a .env template'}
          </button>
        </div>
      </div>
    </div>
  );
}
