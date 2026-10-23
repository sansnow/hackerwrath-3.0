import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { RiskAssessment } from '../hooks/useLiveDetection';
import { ALERT_COPY, askKindOf, categoriesOf, chipsOf, isHigh, isPossible } from '../spell/signals';
import { AskIcon } from './ScamAlert';

interface RiskDisplayProps {
  assessment: RiskAssessment | null;
  isListening: boolean;
  /** Bring the full-screen alert back after it was put away. */
  onOpenAlert?: () => void;
}

/**
 * "This call": what the guardian makes of it, in the app's own words. The detector's score and
 * reasoning stay folded away under "Detector details" (the alert never shows them).
 */
export default function RiskDisplay({ assessment, isListening, onOpenAlert }: RiskDisplayProps) {
  if (!assessment) {
    return (
      <div className="sb-card p-6 sb-rise">
        <div className="sb-eyebrow mb-2">This call</div>
        <p className="text-[19px] leading-[25px] font-bold text-head">
          {isListening ? 'Listening. Nobody has asked for anything yet.' : 'Nothing checked yet.'}
        </p>
        <p className="text-[14px] text-faint mt-1.5">
          {isListening
            ? 'If a caller asks for a code, a PIN, a QR scan or an app, you will know within seconds.'
            : 'Turn scam check on, run a demo call, or paste what a caller said.'}
        </p>
      </div>
    );
  }

  const level = assessment.risk_level || 'LOW';
  const high = isHigh(level);
  const possible = isPossible(level);
  const kind = askKindOf(categoriesOf(assessment));
  const chips = chipsOf(assessment);
  const copy = ALERT_COPY[kind];

  return (
    <div className="flex flex-col gap-4 sb-rise">
      {high || possible ? (
        <div
          className={`rounded-[22px] p-5 sm:p-6 flex flex-col gap-3.5 border ${high ? 'bg-danger-soft border-danger/20' : 'bg-warn-soft border-warn/40'}`}
        >
          <div className="flex items-center gap-2">
            <span
              className={`px-3 py-1.5 rounded-full text-[12px] leading-4 font-bold tracking-[0.16em] ${high ? 'bg-danger text-on-danger' : 'bg-warn text-on-warn'}`}
            >
              {high ? 'HIGH RISK' : 'POSSIBLE RISK'}
            </span>
            <span className="text-[12px] font-semibold text-faint">this call</span>
          </div>
          <div className="flex items-center gap-3.5">
            <h3
              className={`sb-flexword flex-1 min-w-0 text-[40px] leading-[40px] font-extrabold ${high ? 'text-danger-text' : 'text-warn-ink'}`}
              style={{ fontFamily: "'Anek Latin', 'Anek Devanagari', system-ui, sans-serif" }}
            >
              {copy.headline}
            </h3>
            <div
              className={`w-16 h-16 shrink-0 rounded-[20px] flex items-center justify-center bg-card/70 ${high ? 'text-danger-ink' : 'text-warn-ink'}`}
            >
              <AskIcon kind={kind} size={40} />
            </div>
          </div>
          <p className="text-[17px] leading-[23px] font-bold text-ink">{copy.line}</p>
          {chips.length > 0 && (
            <div className="flex flex-col gap-2">
              <span className="sb-eyebrow">What they said</span>
              <ul className="flex flex-wrap gap-2 list-none">
                {chips.map((chip) => (
                  <li key={chip} className={`sb-chip bg-card ${high ? 'text-danger-ink' : 'text-warn-ink'}`}>
                    {chip}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {high && onOpenAlert && (
            <button type="button" onClick={onOpenAlert} className="sb-btn sb-btn-end self-start mt-1 rounded-[18px]">
              Show the alert
            </button>
          )}
        </div>
      ) : (
        <div className="sb-card p-6">
          <div className="flex items-center justify-between mb-2">
            <span className="sb-eyebrow">This call</span>
            <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-faint">
              <span className="w-2 h-2 rounded-full bg-accent" />
              {level === 'UNKNOWN' ? 'not enough to go on' : 'no ask yet'}
            </span>
          </div>
          <p className="text-[19px] leading-[25px] font-bold text-head">
            {level === 'UNKNOWN'
              ? 'Too little was said to tell. Keep listening.'
              : 'Nobody has asked for a code, a PIN, a scan or an app.'}
          </p>
          {assessment.caption && <p className="text-[14px] text-faint mt-1.5">“{assessment.caption}”</p>}
        </div>
      )}

      <SoundsLike assessment={assessment} />
      <DetectorDetails assessment={assessment} />
    </div>
  );
}

/** Grounding from the RAG vector store: the nearest real dialogues, scam or genuine. */
function SoundsLike({ assessment }: { assessment: RiskAssessment }) {
  const [showAll, setShowAll] = useState(false);
  const rag = assessment.rag_classification;
  const examples = rag?.retrieved_examples || [];
  // Nothing close in the library (or no index built yet): no card rather than an empty one every time.
  if (!rag || examples.length === 0) return null;
  const shown = showAll ? examples : examples.slice(0, 2);

  return (
    <div className="sb-card p-5 flex flex-col gap-3">
      <div className="flex items-end justify-between gap-3">
        <div>
          <span className="sb-eyebrow">Sounds like</span>
          <h4 className="text-[17px] font-extrabold text-head mt-0.5">
            {rag.insufficient_evidence ? 'No close match in real calls' : 'These real calls'}
          </h4>
        </div>
        <span className="text-[12px] text-faint shrink-0">
          {rag.classification === 'SCAM' ? 'mostly scams' : rag.classification === 'LEGITIMATE' ? 'mostly genuine' : 'mixed'}
        </span>
      </div>
      {rag.explanation && <p className="text-[13px] text-muted">{rag.explanation}</p>}
      {shown.length > 0 && (
        <ul className="flex flex-col gap-2 list-none">
          {shown.map((ex) => (
            <li key={ex.example_id} className="sb-soft rounded-[16px] px-4 py-3">
              <div className="flex items-center justify-between gap-2 mb-1">
                <span
                  className={`sb-chip text-[11px] px-2.5 py-0.5 ${
                    ex.label === 'SCAM' ? 'bg-danger-soft text-danger-ink' : 'bg-accent-soft text-on-accent-soft'
                  }`}
                >
                  {ex.label === 'SCAM' ? 'Scam call' : 'Genuine call'}
                </span>
                <span className="text-[12px] text-faint">{Math.round(ex.similarity * 100)}% alike</span>
              </div>
              <p className="text-[13px] text-ink italic line-clamp-3">“{ex.text}”</p>
            </li>
          ))}
        </ul>
      )}
      {examples.length > 2 && (
        <button type="button" onClick={() => setShowAll(!showAll)} className="sb-btn sb-btn-ghost self-start min-h-9 px-3 text-[13px]">
          {showAll ? 'Show fewer' : `Show all ${examples.length}`}
        </button>
      )}
    </div>
  );
}

function DetectorDetails({ assessment }: { assessment: RiskAssessment }) {
  const {
    risk_score = 0,
    reasons = [],
    recommended_action,
    confidence,
    rule_analysis,
    contextual_analysis,
  } = assessment;
  const score = Math.round(risk_score > 1 ? risk_score : risk_score * 100);
  const triggered = Array.isArray(rule_analysis?.triggered_indicators) ? rule_analysis.triggered_indicators : [];
  const suppressed = Array.isArray(rule_analysis?.suppressed_protective_matches) ? rule_analysis.suppressed_protective_matches : [];
  const safeReasons = Array.isArray(reasons) ? reasons : [];

  return (
    <details className="sb-card group overflow-hidden">
      <summary className="flex items-center justify-between gap-3 px-5 py-4 cursor-pointer list-none select-none">
        <span className="flex flex-col">
          <span className="text-[15px] font-extrabold text-head">Detector details</span>
          <span className="text-[12px] text-faint">
            Score {score}/100
            {confidence != null ? ` · ${Math.round(confidence * 100)}% sure` : ''}
            {triggered.length ? ` · ${triggered.length} ${triggered.length === 1 ? 'pattern' : 'patterns'}` : ''}
          </span>
        </span>
        <ChevronDown className="w-5 h-5 text-faint transition-transform group-open:rotate-180" />
      </summary>

      <div className="px-5 pb-5 flex flex-col gap-4">
        <div>
          <div className="h-2 rounded-full bg-surface overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-700"
              style={{
                width: `${score}%`,
                background: score >= 60 ? 'var(--sb-end)' : score >= 30 ? 'var(--sb-warn)' : 'var(--sb-accent)',
              }}
            />
          </div>
        </div>

        {recommended_action && (
          <p className="text-[14px] text-ink">
            <span className="font-bold text-head">Detector says: </span>
            {recommended_action}
          </p>
        )}

        {safeReasons.length > 0 && (
          <ul className="flex flex-col gap-1.5 list-none">
            {safeReasons.slice(0, 5).map((reason, i) => (
              <li key={i} className="flex items-start gap-2 text-[14px] text-muted">
                <span className="mt-2 w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
                {reason}
              </li>
            ))}
          </ul>
        )}

        {triggered.length > 0 && (
          <div className="flex flex-col gap-2">
            <span className="sb-eyebrow">Patterns</span>
            {triggered.map((ind, i) => (
              <div key={i} className="sb-soft px-4 py-3 rounded-[16px]">
                <div className="flex items-center justify-between gap-2 mb-0.5">
                  <code className="font-mono text-[12px] text-head">{String(ind.category).toLowerCase()}</code>
                  <span className="text-[12px] text-faint">
                    weight {Math.round(ind.weight > 1 ? ind.weight : ind.weight * 100)}
                  </span>
                </div>
                {ind.explanation && <p className="text-[13px] text-muted">{ind.explanation}</p>}
              </div>
            ))}
          </div>
        )}

        {suppressed.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <span className="sb-eyebrow">Safety advice, not an ask</span>
            {suppressed.map((match, i) => (
              <p key={i} className="text-[13px] text-muted">
                “{match}”
              </p>
            ))}
          </div>
        )}

        {Boolean(contextual_analysis?.caller_identity_claim || contextual_analysis?.intent_classification) && (
          <dl className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-1.5 text-[13px]">
            {contextual_analysis?.caller_identity_claim && (
              <>
                <dt className="font-bold text-head">Says they are</dt>
                <dd className="text-muted">{contextual_analysis.caller_identity_claim}</dd>
              </>
            )}
            {contextual_analysis?.claimed_organisation && (
              <>
                <dt className="font-bold text-head">From</dt>
                <dd className="text-muted">{contextual_analysis.claimed_organisation}</dd>
              </>
            )}
            {contextual_analysis?.intent_classification && (
              <>
                <dt className="font-bold text-head">Intent</dt>
                <dd className="text-muted">{contextual_analysis.intent_classification}</dd>
              </>
            )}
            {contextual_analysis?.possible_impersonation && (
              <>
                <dt className="font-bold text-head">Impersonation</dt>
                <dd className="text-danger-text font-bold">Likely</dd>
              </>
            )}
          </dl>
        )}
      </div>
    </details>
  );
}
