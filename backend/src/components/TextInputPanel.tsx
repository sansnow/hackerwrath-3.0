import { useState } from 'react';
import { ArrowUp } from 'lucide-react';

const DEMO_SCENARIOS = [
  {
    label: 'Army QR scam · Hindi',
    text: 'भाई मैं आर्मी कैंट से बोल रहा हूँ, क्यूआर कोड भेज रहा हूँ, स्कैन करो और यूपीआई पिन डालो पेमेंट तुरंत आ जाएगा।',
  },
  {
    label: 'CBI digital arrest',
    text: 'This is Officer Verma calling from CBI Cyber Crime Branch. An arrest warrant is issued on your Aadhaar card for money laundering. Transfer ₹50,000 security clearance deposit to RBI escrow immediately.',
  },
  {
    label: 'Bank KYC OTP ask',
    text: 'Aapke phone pe ek 6 digit ka bank verification OTP aaya hai, jaldi se batao. Account block ho jayega agar nahi bataya.',
  },
  {
    label: 'Electricity bill, install AnyDesk',
    text: 'Your electricity power connection will be disconnected tonight. Install AnyDesk application immediately to update your payment.',
  },
  {
    label: 'Safety advice, not an ask',
    text: 'Never share your confidential OTP or enter your UPI PIN with anyone on an incoming phone call. Call your bank directly from your card number.',
  },
  {
    label: 'A real buyer',
    text: 'Hello, I saw your advertisement on OLX regarding the sofa set. Is it still available for inspection this weekend?',
  },
  {
    label: 'OTP ask · Punjabi',
    text: 'ਤੁਹਾਡੇ ਫੋਨ ਤੇ ਓਟੀਪੀ ਆਇਆ ਹੋਣਾ, ਮੈਨੂੰ ਦੱਸੋ ਜਲਦੀ। ਖਾਤਾ ਬੰਦ ਹੋ ਜਾਵੇਗਾ।',
  },
];

interface TextInputPanelProps {
  onAnalyze: (text: string) => Promise<void>;
  isProcessing: boolean;
}

export default function TextInputPanel({ onAnalyze, isProcessing }: TextInputPanelProps) {
  const [text, setText] = useState('');

  const handleSubmit = async () => {
    if (!text.trim() || isProcessing) return;
    await onAnalyze(text);
    setText('');
  };

  return (
    <div className="sb-card p-5 sm:p-6">
      <div className="sb-eyebrow">Text check</div>
      <h3 className="text-[22px] leading-7 font-extrabold text-head mt-1 mb-4">What did the caller say?</h3>

      <div className="relative mb-4">
        <label htmlFor="sb-text-check" className="sr-only">
          What the caller said
        </label>
        <textarea
          id="sb-text-check"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Type or paste their words, in English, Hindi or Punjabi…"
          className="sb-input w-full p-4 pr-16 min-h-[120px] resize-none text-[16px]"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              handleSubmit();
            }
          }}
        />
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!text.trim() || isProcessing}
          aria-label="Check these words"
          className="sb-btn sb-btn-primary absolute bottom-3 right-3 w-11 h-11 p-0 rounded-full"
        >
          <ArrowUp className={`w-5 h-5 ${isProcessing ? 'animate-pulse' : ''}`} />
        </button>
      </div>

      <p className="text-[12px] font-bold tracking-[0.12em] uppercase text-faint mb-2">Or try one</p>
      <div className="flex flex-wrap gap-2">
        {DEMO_SCENARIOS.map((scenario) => (
          <button
            key={scenario.label}
            type="button"
            onClick={() => setText(scenario.text)}
            className="sb-chip bg-accent-soft text-on-accent-soft hover:bg-accent hover:text-on-accent transition-colors active:scale-95"
          >
            {scenario.label}
          </button>
        ))}
      </div>
    </div>
  );
}
