"""
Scam Risk Scoring Engine.

Scoring & Calibration Documentation:
------------------------------------
1. Weighted Combination:
   - `rule_score` in [0, 1] comes from configurable indicator weights in `RulesEngine`.
   - `contextual_score` in [0, 1] comes from `ContextualAnalyzer` ("Contextual Director").
   - When protective advice or legitimate payment intent is confirmed by the Contextual Director
     and no coercive/solicitation indicators exist, the combined score is damped toward 0.05.
   - Otherwise, `raw_score = w_rule * rule_score + w_ctx * contextual_score` (normalized by weight sum),
     with a synergy boost (+0.12) when both the Rule Engine and Contextual Director independently
     detect high-signal scam solicitation (`rule_score >= 0.40` and `contextual_score >= 0.55`).
2. Calibrated Probability `p_scam`:
   - Per Requirement 5, a heuristic score is NEVER labelled as a true probability.
   - `p_scam` is `None` (`null` in JSON) unless `CALIBRATED_PROBABILITY_ENABLED=true`,
     in which case Platt scaling `1 / (1 + exp(-(slope * risk_score + intercept)))` is applied.
3. `UNKNOWN` Risk Level Handling:
   - Returns `risk_level="UNKNOWN"` when:
     a) `transcript_confidence < settings.min_transcript_confidence` (poor audio/STT quality), OR
     b) The transcript has insufficient content (`INSUFFICIENT_CONTEXT` with no rule hits), OR
     c) The Contextual AI service failed (`TIMEOUT`, `MALFORMED_OUTPUT`, `UNAVAILABLE`) AND
        rule-based evidence alone is insufficient to establish risk.
"""
from __future__ import annotations

import math
from typing import Any, Dict, List, Optional
from app.core.config import Settings, get_settings
from app.schemas.analysis import (
    ContextualAnalysisOutput,
    DeepfakeAnalysisResult,
    EvidenceItem,
    RiskLevelType,
    RuleEngineResult,
    ScamRiskAssessment,
)
from app.services.alert_service import AlertService


class RiskScorer:
    """Combines rule-based evidence, contextual AI analysis, and optional deepfake detection."""

    def __init__(
        self,
        settings: Optional[Settings] = None,
        alert_service: Optional[AlertService] = None,
    ) -> None:
        self.settings = settings or get_settings()
        self.alert_service = alert_service or AlertService()

    def _compute_calibrated_probability(self, risk_score: float) -> Optional[float]:
        """
        Returns None (null) unless calibration is explicitly enabled and validated.
        Never labels a heuristic score as a true probability.
        """
        if not self.settings.calibrated_probability_enabled:
            return None
        norm_score = risk_score / 100.0 if risk_score > 1.0 else risk_score
        z = self.settings.calibration_slope * norm_score + self.settings.calibration_intercept
        prob = 1.0 / (1.0 + math.exp(-z))
        return round(min(0.999, max(0.001, prob)), 4)

    def score(
        self,
        *,
        rule_result: RuleEngineResult,
        contextual_result: ContextualAnalysisOutput,
        transcript_confidence: float = 0.92,
        start_seconds: Optional[float] = 0.0,
        end_seconds: Optional[float] = 5.0,
        deepfake_result: Optional[DeepfakeAnalysisResult] = None,
        sync_status: Optional[Dict[str, Any]] = None,
        rag_result: Optional[Dict[str, Any]] = None,
    ) -> ScamRiskAssessment:
        reasons: List[str] = []
        evidence: List[EvidenceItem] = []

        # Collect rule evidence
        for ind in rule_result.triggered_indicators:
            reasons.append(f"[{ind.category}] {ind.explanation}")
            evidence.append(
                EvidenceItem(
                    excerpt=ind.excerpt,
                    start_seconds=ind.start_seconds if ind.start_seconds is not None else start_seconds,
                    end_seconds=ind.end_seconds if ind.end_seconds is not None else end_seconds,
                    source="cross_call_sync" if ind.synced_across_calls else "rule_engine",
                    indicator=ind.keyword_or_pattern,
                )
            )

        # Collect RAG semantic evidence
        if rag_result and isinstance(rag_result, dict):
            rag_expl = rag_result.get("explanation")
            if rag_expl and rag_expl not in reasons:
                reasons.append(f"[RAG Semantic Analysis] {rag_expl}")
            for ex in rag_result.get("retrieved_examples", []):
                if isinstance(ex, dict) and ex.get("label") == "SCAM":
                    sim = ex.get("similarity", 0.0)
                    evidence.append(
                        EvidenceItem(
                            excerpt=f"Matched case: {ex.get('text', '')[:75]}...",
                            start_seconds=start_seconds,
                            end_seconds=end_seconds,
                            source="rag_retrieval",
                            indicator=f"Cosine similarity {sim:.2f}",
                        )
                    )

        # Collect contextual AI reasons & evidence
        if contextual_result.possible_impersonation and contextual_result.claimed_organisation:
            reasons.append(
                f"Contextual AI detected possible impersonation of {contextual_result.claimed_organisation}."
            )
        for req in contextual_result.money_or_sensitive_requests:
            msg = f"Contextual AI identified sensitive/financial solicitation: {req}."
            if msg not in reasons:
                reasons.append(msg)
        for threat in contextual_result.threats_urgency_manipulation:
            msg = f"Contextual AI identified coercive manipulation: {threat}."
            if msg not in reasons:
                reasons.append(msg)
        for prot in contextual_result.protective_or_legitimate_explanations:
            reasons.append(f"Protective/Legitimate context: {prot}")

        for exc in contextual_result.supporting_excerpts:
            if not any(e.excerpt == exc for e in evidence):
                evidence.append(
                    EvidenceItem(
                        excerpt=exc,
                        start_seconds=start_seconds,
                        end_seconds=end_seconds,
                        source="contextual_ai",
                        indicator=contextual_result.intent_classification,
                    )
                )

        # Check for UNKNOWN condition 1: Low transcription quality
        if transcript_confidence < self.settings.min_transcript_confidence:
            reasons.insert(
                0,
                f"Transcription confidence ({transcript_confidence:.2f}) is below minimum reliability threshold ({self.settings.min_transcript_confidence:.2f}).",
            )
            alert = self.alert_service.build_alert("UNKNOWN", 0.0, rule_result.triggered_indicators)
            return ScamRiskAssessment(
                risk_score=0.0,
                p_scam=None,
                risk_level="UNKNOWN",
                confidence=round(transcript_confidence, 4),
                caption="Low transcription quality; unable to verify call safety reliably",
                reasons=reasons,
                evidence=evidence,
                recommended_action=alert.safe_action,
                rule_analysis=rule_result,
                contextual_analysis=contextual_result,
                deepfake_analysis=deepfake_result,
                alert=alert,
                synchronization_status=sync_status or {"working": True},
            )

        # Check for UNKNOWN condition 2: AI service failure (timeout / malformed / unavailable)
        ai_failed = contextual_result.service_status in (
            "TIMEOUT",
            "MALFORMED_OUTPUT",
            "UNAVAILABLE",
        )
        if ai_failed and rule_result.rule_score < 45.0:
            reasons.append(
                f"Contextual AI service status is {contextual_result.service_status} and rule-based evidence alone is insufficient for a reliable classification."
            )
            alert = self.alert_service.build_alert("UNKNOWN", rule_result.rule_score, rule_result.triggered_indicators)
            return ScamRiskAssessment(
                risk_score=round(rule_result.rule_score * 0.5, 2),
                p_scam=None,
                risk_level="UNKNOWN",
                confidence=0.30,
                caption=contextual_result.contextual_caption,
                reasons=reasons,
                evidence=evidence,
                recommended_action=alert.safe_action,
                rule_analysis=rule_result,
                contextual_analysis=contextual_result,
                deepfake_analysis=deepfake_result,
                alert=alert,
                synchronization_status=sync_status or {"working": True},
            )

        # Check for UNKNOWN condition 3: Empty / insufficient context
        if (
            contextual_result.intent_classification == "INSUFFICIENT_CONTEXT"
            and not rule_result.triggered_indicators
            and not rule_result.suppressed_protective_matches
        ):
            reasons.append("Available transcript evidence is too brief or ambiguous to assess caller intent.")
            alert = self.alert_service.build_alert("UNKNOWN", 0.0, [])
            return ScamRiskAssessment(
                risk_score=0.0,
                p_scam=None,
                risk_level="UNKNOWN",
                confidence=0.25,
                caption=contextual_result.contextual_caption,
                reasons=reasons,
                evidence=[],
                recommended_action=alert.safe_action,
                rule_analysis=rule_result,
                contextual_analysis=contextual_result,
                deepfake_analysis=deepfake_result,
                alert=alert,
                synchronization_status=sync_status or {"working": True},
            )

        # Compute weighted risk score (0–100 scale)
        w_rule = self.settings.rule_score_weight
        w_ctx = 0.0 if ai_failed else self.settings.contextual_score_weight
        has_valid_rag = bool(rag_result and isinstance(rag_result, dict) and not rag_result.get("insufficient_evidence"))
        w_rag = self.settings.rag_score_weight if has_valid_rag else 0.0
        weight_sum = max(0.01, w_rule + w_ctx + w_rag)

        rag_contribution = w_rag * float(rag_result.get("risk_score", 0.0)) if has_valid_rag else 0.0
        combined = (
            w_rule * rule_result.rule_score + w_ctx * contextual_result.intent_risk_score + rag_contribution
        ) / weight_sum

        # Synergy boost when both Rule Engine and Contextual Director detect strong solicitation
        if rule_result.rule_score >= 40.0 and contextual_result.intent_risk_score >= 55.0:
            combined = min(100.0, combined + 14.0)

        # Never classify a call based ONLY on a weak keyword match if Contextual Director
        # sees no solicitation/threat intent
        # (Asks for, or mentions of, banking secrets are exempt: they are never part of a genuine call,
        # and the contextual engine doesn't know every way of asking for them.)
        rule_categories = {ind.category for ind in rule_result.triggered_indicators}
        involves_banking_secret = bool(rule_categories & {"OTP_OR_PIN_REQUEST", "SENSITIVE_DETAIL_MENTION"})
        if (
            rule_result.rule_score > 0.0
            and len(rule_result.triggered_indicators) == 1
            and not involves_banking_secret
            and contextual_result.intent_classification in ("PROTECTIVE_WARNING", "LEGITIMATE_INQUIRY")
            and contextual_result.intent_risk_score < 20.0
        ):
            combined = min(combined, 22.0)
            reasons.append(
                "Single rule indicator was tempered because contextual intent analysis found no solicitation or threat."
            )

        # Safety advice the rules engine recognised ("don't give your card number to anyone"), with no
        # other indicator: the contextual engine can misread the quoted ask, so keep it Low.
        if rule_result.suppressed_protective_matches and not rule_result.triggered_indicators:
            combined = min(combined, 15.0)

        # Floors: asking for an OTP, CVV, PIN, card or account detail is always High risk;
        # bringing one up is at least Possible risk.
        if "OTP_OR_PIN_REQUEST" in rule_categories:
            combined = max(combined, self.settings.credential_request_floor)
        elif "SENSITIVE_DETAIL_MENTION" in rule_categories:
            combined = max(combined, self.settings.sensitive_mention_floor)

        # Deepfake analysis is kept structurally separate per Requirement 6
        risk_score = round(min(100.0, max(0.0, combined)), 2)

        # Determine risk level with configurable thresholds:
        # 80-100: CRITICAL, 60-79: HIGH, 30-59: MEDIUM, 0-29: LOW
        if risk_score >= self.settings.critical_risk_threshold:
            risk_level: RiskLevelType = "CRITICAL"
        elif risk_score >= self.settings.medium_risk_threshold:
            risk_level = "HIGH"
        elif risk_score >= self.settings.low_risk_threshold:
            risk_level = "MEDIUM"
        else:
            risk_level = "LOW"

        if not reasons:
            reasons.append("No suspicious payment demands, credential requests, or coercive threats detected.")

        alert = self.alert_service.build_alert(
            risk_level, risk_score, rule_result.triggered_indicators
        )
        overall_confidence = round(
            min(
                1.0,
                transcript_confidence
                * (0.55 if ai_failed else max(0.75, contextual_result.model_confidence)),
            ),
            4,
        )

        return ScamRiskAssessment(
            risk_score=risk_score,
            p_scam=self._compute_calibrated_probability(risk_score),
            risk_level=risk_level,
            confidence=overall_confidence,
            caption=contextual_result.contextual_caption,
            reasons=reasons,
            evidence=evidence,
            recommended_action=alert.safe_action,
            rule_analysis=rule_result,
            contextual_analysis=contextual_result,
            rag_analysis=rag_result,
            deepfake_analysis=deepfake_result,
            alert=alert,
            synchronization_status=sync_status or {"working": True},
        )
