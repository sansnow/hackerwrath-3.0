import { useState, useEffect, type FormEvent } from 'react';
import { RefreshCw } from 'lucide-react';
import { CHIP_FOR_CATEGORY } from '../spell/signals';
import { fetchRag, fetchRagHealth } from '../spell/rag';
import type { RAGClassificationResponse, RAGHealthResponse, RetrievedExample } from '../hooks/useLiveDetection';

interface SyncedKeyword {
  keyword: string;
  category: string;
  weight: number;
  hit_count: number;
  active: boolean;
}

const CATEGORIES: Array<[string, string]> = [
  ['OTP_OR_PIN_REQUEST', 'OTP or PIN ask'],
  ['QR_SCAN_TO_RECEIVE_MONEY', 'QR scan to “receive” money'],
  ['REMOTE_ACCESS_OR_SCREEN_SHARE', 'Remote access or screen share'],
  ['THREAT_ARREST_OR_LEGAL_ACTION', 'Arrest or legal threat'],
  ['ACCOUNT_SUSPENSION_THREAT', 'Account block or KYC threat'],
  ['AUTHORITY_OR_BANK_IMPERSONATION', 'Bank or authority impersonation'],
  ['URGENT_PAYMENT_DEMAND', 'Urgent payment demand'],
];

const RAG_SAMPLES = [
  'Scan QR code to receive Rs 25000',
  'Your electricity bill is pending, download AnyDesk',
  'Bank KYC verification OTP code',
  'Hello, I am interested in buying the sofa on OLX',
];

const VIEWS = [
  ['library', 'Real-call library'],
  ['phrases', 'Added phrases'],
] as const;

export default function ThreatIntelPanel() {
  const [view, setView] = useState<'library' | 'phrases'>('library');

  // The RAG library of real calls
  const [ragHealth, setRagHealth] = useState<RAGHealthResponse | null>(null);
  const [ragQuery, setRagQuery] = useState('');
  const [ragResult, setRagResult] = useState<RAGClassificationResponse | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);

  // Phrases synced across live calls
  const [keywords, setKeywords] = useState<SyncedKeyword[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [newKeyword, setNewKeyword] = useState('');
  const [newCategory, setNewCategory] = useState('OTP_OR_PIN_REQUEST');
  const [newWeight] = useState(0.45);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const fetchKeywords = async () => {
    setIsLoading(true);
    try {
      const res = await fetch('/sync/keywords');
      if (res.ok) {
        const data = await res.json();
        setKeywords(data.keywords || []);
      }
    } catch {
      // Fallback
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchKeywords();
    fetchRagHealth().then(setRagHealth);
  }, []);

  const handleRagSearch = async (query: string) => {
    if (!query.trim() || isSearching) return;
    setIsSearching(true);
    setSearchFailed(false);
    const result = await fetchRag(query.trim(), 4);
    setRagResult(result);
    setSearchFailed(!result);
    setIsSearching(false);
  };

  const handleAddKeyword = async (e: FormEvent) => {
    e.preventDefault();
    if (!newKeyword.trim()) return;

    try {
      const res = await fetch('/sync/keywords', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          keyword: newKeyword.trim().toLowerCase(),
          category: newCategory,
          weight: newWeight,
          source_call_id: 'admin_dashboard',
        }),
      });

      if (res.ok) {
        setMsg({ ok: true, text: `“${newKeyword}” now applies to every live call.` });
        setNewKeyword('');
        fetchKeywords();
        setTimeout(() => setMsg(null), 3000);
      }
    } catch (e: any) {
      setMsg({ ok: false, text: `Couldn’t add it: ${e.message}` });
    }
  };

  const docs = ragHealth?.indexed_documents_count;

  return (
    <div className="sb-card p-5 sm:p-6 flex flex-col gap-6 sb-rise">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <div className="sb-eyebrow">Threat intel</div>
          <h2 className="text-[26px] leading-8 font-extrabold text-head mt-1">
            {view === 'library' ? 'A library of real calls' : 'Phrases every call listens for'}
          </h2>
          <p className="text-[13px] text-faint mt-1">
            {view === 'library'
              ? `${docs ? docs.toLocaleString() : 'Real'} Indian scam and genuine call transcripts, searched by meaning.`
              : 'A phrase added here reaches every live call at once.'}
          </p>
        </div>
        <div role="radiogroup" aria-label="Threat intel view" className="flex items-center p-1 rounded-full bg-surface shrink-0">
          {VIEWS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={view === id}
              onClick={() => setView(id)}
              className={`px-4 min-h-10 rounded-full text-[13px] font-bold transition-colors ${
                view === id ? 'bg-accent text-on-accent' : 'text-muted hover:text-ink'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {view === 'library' ? (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-[12px] font-semibold text-faint">
            <span className="flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full ${ragHealth?.vector_index_loaded ? 'bg-accent' : 'bg-warn'}`} />
              {ragHealth ? (ragHealth.vector_index_loaded ? 'Library loaded' : 'Library not loaded yet') : 'Library status unknown'}
            </span>
            {ragHealth?.embedding_model && <span>Model: {ragHealth.embedding_model}</span>}
            {ragHealth?.vector_store_type && <span>Store: {ragHealth.vector_store_type}</span>}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleRagSearch(ragQuery);
            }}
            className="sb-soft p-4 flex flex-col gap-3"
          >
            <label htmlFor="sb-rag-query" className="text-[15px] font-extrabold text-head">
              What does this sound like?
            </label>
            <div className="flex flex-col sm:flex-row gap-2.5">
              <input
                id="sb-rag-query"
                type="text"
                value={ragQuery}
                onChange={(e) => setRagQuery(e.target.value)}
                placeholder="e.g. I am calling from Mumbai police cyber crime branch about a parcel…"
                className="sb-input flex-1 px-3.5 py-2.5 text-[14px]"
              />
              <button type="submit" disabled={!ragQuery.trim() || isSearching} className="sb-btn sb-btn-primary">
                {isSearching ? 'Searching…' : 'Find similar calls'}
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              {RAG_SAMPLES.map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => {
                    setRagQuery(q);
                    handleRagSearch(q);
                  }}
                  className="sb-chip bg-card text-muted hover:text-ink text-[12px]"
                >
                  {q}
                </button>
              ))}
            </div>
          </form>

          {searchFailed && (
            <p className="text-[13px] font-semibold text-danger-text" aria-live="polite">
              The library didn’t answer. Is the backend running with the RAG index built?
            </p>
          )}

          {ragResult && (
            <div className="flex flex-col gap-3 sb-rise">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`sb-chip text-[12px] ${
                    ragResult.classification === 'SCAM'
                      ? 'bg-danger-soft text-danger-ink'
                      : ragResult.classification === 'LEGITIMATE'
                        ? 'bg-accent-soft text-on-accent-soft'
                        : 'bg-warn-soft text-warn-ink'
                  }`}
                >
                  {ragResult.classification === 'SCAM'
                    ? 'Sounds like a scam'
                    : ragResult.classification === 'LEGITIMATE'
                      ? 'Sounds genuine'
                      : 'Not sure'}
                </span>
                <span className="text-[12px] text-faint">
                  score {Math.round(ragResult.risk_score)}/100 · {Math.round(ragResult.confidence * 100)}% sure ·{' '}
                  {ragResult.retrieval_latency_ms.toFixed(0)} ms
                </span>
              </div>
              {ragResult.explanation && <p className="text-[14px] text-muted">{ragResult.explanation}</p>}
              <ul className="grid grid-cols-1 md:grid-cols-2 gap-2.5 list-none">
                {ragResult.retrieved_examples.map((ex) => (
                  <ExampleCard key={ex.example_id} example={ex} />
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : (
        <>
          <form onSubmit={handleAddKeyword} className="sb-soft p-4 flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[15px] font-extrabold text-head">Add a phrase</span>
              <button type="button" onClick={fetchKeywords} disabled={isLoading} className="sb-btn sb-btn-ghost min-h-9 px-3 text-[13px]">
                <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
                Refresh
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-12 gap-2.5">
              <label className="sm:col-span-6">
                <span className="sr-only">Phrase</span>
                <input
                  type="text"
                  value={newKeyword}
                  onChange={(e) => setNewKeyword(e.target.value)}
                  placeholder="e.g. army gate pass fee, digital arrest warrant"
                  className="sb-input w-full px-3.5 py-2.5 text-[14px]"
                />
              </label>
              <label className="sm:col-span-4">
                <span className="sr-only">What kind of ask</span>
                <select
                  value={newCategory}
                  onChange={(e) => setNewCategory(e.target.value)}
                  className="sb-input w-full px-3.5 py-2.5 text-[14px] font-semibold"
                >
                  {CATEGORIES.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <button type="submit" className="sm:col-span-2 sb-btn sb-btn-primary">
                Add
              </button>
            </div>
            {msg && (
              <p className={`text-[13px] font-semibold ${msg.ok ? 'text-accent' : 'text-danger-text'}`} aria-live="polite">
                {msg.text}
              </p>
            )}
          </form>

          <div>
            <div className="sb-eyebrow mb-3">Added phrases · {keywords.length}</div>
            {keywords.length === 0 ? (
              <p className="sb-soft px-4 py-8 text-center text-[13px] text-faint">
                None added yet. The built-in rules already cover the main kinds of scam ask.
              </p>
            ) : (
              <ul className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2.5 list-none">
                {keywords.map((kw, i) => (
                  <li key={i} className="rounded-[18px] border border-line px-4 py-3 flex flex-col gap-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[15px] font-extrabold text-head line-clamp-1">{kw.keyword}</span>
                      <span className="text-[12px] text-faint shrink-0">
                        {kw.hit_count} {kw.hit_count === 1 ? 'hit' : 'hits'}
                      </span>
                    </div>
                    <span className="sb-chip self-start text-[12px] px-2.5 py-1 bg-danger-soft text-danger-ink">
                      {CHIP_FOR_CATEGORY[String(kw.category).toUpperCase()] || kw.category}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function ExampleCard({ example }: { example: RetrievedExample }) {
  return (
    <li className="rounded-[18px] border border-line px-4 py-3">
      <div className="flex items-center justify-between gap-2 mb-1">
        <span
          className={`sb-chip text-[11px] px-2.5 py-0.5 ${
            example.label === 'SCAM' ? 'bg-danger-soft text-danger-ink' : 'bg-accent-soft text-on-accent-soft'
          }`}
        >
          {example.label === 'SCAM' ? 'Scam call' : 'Genuine call'}
        </span>
        <span className="text-[12px] text-faint">{Math.round(example.similarity * 100)}% alike</span>
      </div>
      <p className="text-[13px] text-ink italic line-clamp-4">“{example.text}”</p>
    </li>
  );
}
