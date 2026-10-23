import type { RiskAssessment } from '../hooks/useLiveDetection';

/** What the caller asked for. One ask per alert: it picks the headline, the line and the question. */
export type AskKind = 'otp' | 'qr' | 'remote' | 'arrest' | 'payment' | 'general';

export type Tone = 'calm' | 'listening' | 'possible' | 'high' | 'off';

export const isHigh = (level?: string | null) => level === 'HIGH' || level === 'CRITICAL';
export const isPossible = (level?: string | null) => level === 'MEDIUM';

export function toneOf(level: string | null | undefined, listening: boolean): Tone {
  if (isHigh(level)) return 'high';
  if (isPossible(level)) return 'possible';
  return listening ? 'listening' : 'calm';
}

/** Each pattern the detector names becomes one chip on the alert ("What they said"). */
export const CHIP_FOR_CATEGORY: Record<string, string> = {
  OTP_OR_PIN_REQUEST: 'Wants a code or PIN',
  QR_SCAN_TO_RECEIVE_MONEY: 'Wants you to scan a QR',
  REMOTE_ACCESS_OR_SCREEN_SHARE: 'Wants your screen or an app',
  SUSPICIOUS_LINK_OR_APK: 'Sends a link or app',
  THREAT_ARREST_OR_LEGAL_ACTION: 'Threatens arrest',
  ACCOUNT_SUSPENSION_THREAT: 'Threatens your account',
  AUTHORITY_OR_BANK_IMPERSONATION: 'Claims to be your bank',
  URGENT_PAYMENT_DEMAND: 'Wants money',
  FINANCIAL_SOLICITATION: 'Wants money',
  PRESSURE_AND_SECRECY_TACTIC: 'Pressuring you',
  COERCIVE_THREAT: 'Pressuring you',
  SENSITIVE_DETAIL_MENTION: 'Brings up your card or bank details',
};

const PATTERNS: Array<[RegExp, string]> = [
  [/otp|one[\s-]?time|\bcode\b|\bpin\b|mpin|cvv|card number|account number|bank details|ओटीपी|पिन|सीवीवी|कार्ड नंबर|ਓਟੀਪੀ|ਪਿੰਨ/i, 'OTP_OR_PIN_REQUEST'],
  [/\bqr\b|scan|क्यूआर|स्कैन|ਕਿਊਆਰ|ਸਕੈਨ/i, 'QR_SCAN_TO_RECEIVE_MONEY'],
  [/anydesk|teamviewer|quick ?support|screen|remote|\bapk\b|install|download/i, 'REMOTE_ACCESS_OR_SCREEN_SHARE'],
  [/arrest|warrant|\bcbi\b|\bed\b|police|court|customs|गिरफ्तार|वारंट/i, 'THREAT_ARREST_OR_LEGAL_ACTION'],
  [/block|suspend|freeze|frozen|kyc|deactivat|बंद|ਬੰਦ/i, 'ACCOUNT_SUSPENSION_THREAT'],
  [/\b(bank|rbi)\b(?!\s+(account|balance|statement))|officer|headquarter|बैंक से|ਬੈਂਕ ਤੋਂ/i, 'AUTHORITY_OR_BANK_IMPERSONATION'],
  [/\bpay|payment|\bfee\b|transfer|deposit|send money|पैसे|पेमेंट/i, 'URGENT_PAYMENT_DEMAND'],
  [/urgent|immediately|right now|jaldi|turant|tuarant|secret|don'?t tell|तुरंत|जल्दी|ਜਲਦੀ/i, 'PRESSURE_AND_SECRECY_TACTIC'],
];

export function inferCategories(text: string): string[] {
  return PATTERNS.filter(([re]) => re.test(text)).map(([, cat]) => cat);
}

/** Categories the detector named, falling back to the flagged words when it only sent raw keywords. */
export function categoriesOf(a: RiskAssessment | null | undefined): string[] {
  if (!a) return [];
  const out = new Set<string>();
  const triggered = Array.isArray(a.rule_analysis?.triggered_indicators) ? a.rule_analysis.triggered_indicators : [];
  for (const t of triggered) {
    const cat = String(t?.category || '').toUpperCase();
    if (CHIP_FOR_CATEGORY[cat]) out.add(cat);
    else inferCategories(`${t?.keyword_or_pattern || ''} ${t?.explanation || ''}`).forEach((c) => out.add(c));
  }
  if (isHigh(a.risk_level) || isPossible(a.risk_level)) {
    // The detector can name only part of an ask ("scan this QR and enter your PIN" comes back as a
    // PIN request), so also read the words it flagged.
    const excerpts = (Array.isArray(a.evidence) ? a.evidence : []).map((e) => e?.excerpt || '').join(' ');
    inferCategories(excerpts).forEach((c) => out.add(c));
    if (out.size === 0) inferCategories(`${a.caption || ''} ${(a.reasons || []).join(' ')}`).forEach((c) => out.add(c));
  }
  if (a.contextual_analysis?.possible_impersonation && out.size > 0) out.add('AUTHORITY_OR_BANK_IMPERSONATION');
  return [...out];
}

export function chipsOf(a: RiskAssessment | null | undefined): string[] {
  return [...new Set(categoriesOf(a).map((c) => CHIP_FOR_CATEGORY[c]).filter(Boolean))];
}

export function askKindOf(categories: string[]): AskKind {
  const has = (c: string) => categories.includes(c);
  if (has('QR_SCAN_TO_RECEIVE_MONEY')) return 'qr';
  if (has('OTP_OR_PIN_REQUEST')) return 'otp';
  if (has('REMOTE_ACCESS_OR_SCREEN_SHARE') || has('SUSPICIOUS_LINK_OR_APK')) return 'remote';
  if (has('THREAT_ARREST_OR_LEGAL_ACTION')) return 'arrest';
  if (has('URGENT_PAYMENT_DEMAND') || has('FINANCIAL_SOLICITATION')) return 'payment';
  if (has('SENSITIVE_DETAIL_MENTION')) return 'otp';
  return 'general';
}

export interface AlertCopy {
  headline: string;
  line: string;
  question: string;
  yes: string;
  no: string;
  /** How the day story tells it afterwards. */
  story: string;
}

/** The app's own words for each ask: the alert never shows the detector's raw analysis. */
export const ALERT_COPY: Record<AskKind, AlertCopy> = {
  otp: {
    headline: "DON'T SHARE.",
    line: 'They asked for the code sent to your phone. With it, they can take your money.',
    question: 'Did they say they are from your bank?',
    yes: 'Banks never ask for an OTP on a call. Hang up and call the number on your card.',
    no: 'Whoever they are: never read an OTP out on a call.',
    story: 'A caller asked for your OTP.',
  },
  qr: {
    headline: "DON'T SCAN.",
    line: 'They said scanning a QR gets you money. Scanning sends money out.',
    question: 'Did they say scanning puts money into your account?',
    yes: 'That is the trick. Scanning and typing your PIN only ever sends money out.',
    no: 'Whatever they said: you never need to scan or enter your UPI PIN to receive money.',
    story: 'A caller asked you to scan a QR.',
  },
  remote: {
    headline: 'NO APPS.',
    line: 'They want an app on your phone or your screen. With it, they can see your codes and take your money.',
    question: "Did they say it's to fix your account?",
    yes: 'That is the trick. Nobody needs your screen or an app to fix your account.',
    no: 'Whoever they are: never install an app or share your screen for a caller.',
    story: 'A caller asked you to install an app.',
  },
  arrest: {
    headline: 'HANG UP.',
    line: 'They are threatening arrest on a call. Police and courts never arrest anyone over the phone.',
    question: "Did they say you are under 'digital arrest'?",
    yes: 'There is no such thing. Hang up and call 1930, the cyber crime helpline.',
    no: 'Whoever they are: no officer asks for money or secrecy on a call.',
    story: 'A caller threatened you with arrest.',
  },
  payment: {
    headline: "DON'T PAY.",
    line: 'They want money sent now. Rushing you is how the trick works.',
    question: "Did they say you'll lose something if you wait?",
    yes: 'That is the trick. Hang up, wait, and check with someone you trust.',
    no: 'Whoever they are: never send money because a caller is in a hurry.',
    story: 'A caller asked you for money.',
  },
  general: {
    headline: 'SLOW DOWN.',
    line: "This call shows the signs of a scam. Don't share, pay, scan or install anything.",
    question: 'Did they say they are from your bank or the police?',
    yes: 'Banks and police never ask for codes, payments or apps on a call. Hang up and call them yourself.',
    no: "Whoever they are: don't share, pay or install anything for a caller.",
    story: 'A caller showed the signs of a scam.',
  },
};

export function agoLabel(seconds: number): string {
  if (seconds < 2) return 'they asked just now';
  if (seconds < 60) return `they asked ${seconds} s ago`;
  return `they asked ${Math.floor(seconds / 60)} min ago`;
}
