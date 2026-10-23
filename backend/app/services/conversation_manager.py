"""
Conversation State & History Manager.
Coordinates multi-segment call analysis, cross-call keyword synchronization,
duplicate evidence suppression across segments, and call history retrieval.
"""
from __future__ import annotations

import time
import uuid
from typing import List, Optional
from app.core.config import Settings, get_settings
from app.core.logging import get_logger
from app.repositories.conversation_repository import (
    ConversationRepository,
    get_conversation_repository,
)
from app.schemas.analysis import (
    RuleEngineResult,
    ScamRiskAssessment,
    TranscriptAnalysisRequest,
)
from app.schemas.calls import (
    CallClearResponse,
    CallHistoryResponse,
    CallSegmentRecord,
    CallSegmentRequest,
    CallSegmentUpdateResponse,
)
from app.services.contextual_analyzer import ContextualAnalyzer
from app.services.keyword_sync_service import KeywordSyncService, get_keyword_sync_service
from app.services.risk_scorer import RiskScorer
from app.services.rules_engine import RulesEngine
from app.services.telegram_service import TelegramAlertService, get_telegram_service

logger = get_logger("scam_detector.conversation_manager")


class ConversationManager:
    """Maintains context and cumulative risk assessment across call transcript segments."""

    def __init__(
        self,
        repository: Optional[ConversationRepository] = None,
        rules_engine: Optional[RulesEngine] = None,
        contextual_analyzer: Optional[ContextualAnalyzer] = None,
        risk_scorer: Optional[RiskScorer] = None,
        keyword_sync_service: Optional[KeywordSyncService] = None,
        telegram_service: Optional[TelegramAlertService] = None,
        rag_service: Optional[Any] = None,
        settings: Optional[Settings] = None,
    ) -> None:
        self.settings = settings or get_settings()
        self.keyword_sync = keyword_sync_service or get_keyword_sync_service()
        self.repository = repository or get_conversation_repository()
        self.rules_engine = rules_engine or RulesEngine(
            settings=self.settings, keyword_sync_service=self.keyword_sync
        )
        self.contextual_analyzer = contextual_analyzer or ContextualAnalyzer(
            settings=self.settings
        )
        self.risk_scorer = risk_scorer or RiskScorer(settings=self.settings)
        self.telegram_service = telegram_service or get_telegram_service()
        self.rag_service = rag_service

    def _get_rag_service(self) -> Optional[Any]:
        if self.rag_service is None and getattr(self.settings, "enable_live_rag", False):
            try:
                from app.rag.service import get_rag_service
                self.rag_service = get_rag_service()
            except Exception as exc:
                logger.debug("RAG service unavailable for conversation manager: %s", exc)
        return self.rag_service

    def analyze_standalone_transcript(
        self, request: TranscriptAnalysisRequest
    ) -> ScamRiskAssessment:
        """Analyses a single transcript (with optional conversation history)."""
        rule_res, _ = self.rules_engine.evaluate(
            request.transcript,
            start_seconds=request.start_seconds,
            end_seconds=request.end_seconds,
            call_id=request.call_id,
        )
        ctx_res = self.contextual_analyzer.analyze(
            request.transcript, conversation_history=request.conversation_history
        )
        rag_result_dict = None
        rag_svc = self._get_rag_service()
        if rag_svc and getattr(self.settings, "enable_live_rag", False):
            try:
                rag_resp = rag_svc.classify_text(request.transcript, top_k=3)
                rag_result_dict = rag_resp.model_dump()
            except Exception as rag_err:
                logger.debug("RAG classification skipped on standalone transcript: %s", rag_err)

        assessment = self.risk_scorer.score(
            rule_result=rule_res,
            contextual_result=ctx_res,
            transcript_confidence=request.transcript_confidence,
            start_seconds=request.start_seconds,
            end_seconds=request.end_seconds,
            sync_status=self.keyword_sync.get_sync_status(),
            rag_result=rag_result_dict,
        )
        if request.call_id and self.telegram_service.is_enabled:
            try:
                self.telegram_service.send_risk_alert(assessment, request.call_id)
            except Exception as exc:
                logger.warning("Telegram notification dispatch error: %s", exc)
        return assessment

    def process_segment(
        self, call_id: str, segment: CallSegmentRequest
    ) -> CallSegmentUpdateResponse:
        """
        Processes a new transcript segment for `call_id`, updates cumulative conversation
        state without double-counting duplicate evidence, and returns the updated risk assessment.
        """
        state = self.repository.get_or_create(call_id)

        # Detect exact duplicate segments (e.g. repeated network retries)
        is_exact_duplicate = any(
            s.speaker == segment.speaker
            and s.text.strip() == segment.text.strip()
            and abs((s.start_seconds or 0.0) - (segment.start_seconds or 0.0)) < 0.1
            for s in state.segments
        )
        if is_exact_duplicate and state.latest_assessment:
            state.total_duplicates_skipped += 1
            self.repository.save(state)
            return CallSegmentUpdateResponse(
                call_id=call_id,
                segment_id=state.segments[-1].segment_id if state.segments else f"seg_{len(state.segments):03d}",
                sequence_number=len(state.segments),
                duplicate_evidence_suppressed=state.total_duplicates_skipped,
                synced_keywords_triggered=list(state.synced_keywords_hit),
                assessment=state.latest_assessment,
                moment_assessment=state.latest_moment_assessment,
            )

        # Live speech arrives in ~1.5 s slices, so "please share the six" / "digit OTP" can be split.
        # Read this segment together with the unfinished sentence before it.
        window_text = self._window_text(state, segment)

        # Evaluate new segment against rules engine, passing `state.seen_rule_keys`
        # so repeated evidence across segments is skipped rather than double-counted.
        segment_rule_res, updated_seen_keys = self.rules_engine.evaluate(
            window_text,
            start_seconds=segment.start_seconds,
            end_seconds=segment.end_seconds,
            already_seen_keys=state.seen_rule_keys,
            call_id=call_id,
        )
        state.seen_rule_keys = updated_seen_keys
        state.total_duplicates_skipped += segment_rule_res.duplicate_indicators_skipped

        for ind in segment_rule_res.triggered_indicators:
            state.accumulated_indicators.append(ind)
        for sup in segment_rule_res.suppressed_protective_matches:
            if sup not in state.suppressed_protective_matches:
                state.suppressed_protective_matches.append(sup)
        for skw in segment_rule_res.synced_keywords_matched:
            if skw not in state.synced_keywords_hit:
                state.synced_keywords_hit.append(skw)

        # Recompute cumulative rule score across all unique indicators in this call (0–100 scale)
        if not state.accumulated_indicators:
            cumulative_rule_score = 0.0
        else:
            complement = 1.0
            for item in state.accumulated_indicators:
                w = item.weight / 100.0 if item.weight > 1.0 else item.weight
                complement *= max(0.0, 1.0 - min(0.95, w))
            cumulative_rule_score = round(min(100.0, (1.0 - complement) * 100.0), 2)

        cumulative_rule_result = RuleEngineResult(
            rule_score=cumulative_rule_score,
            triggered_indicators=list(state.accumulated_indicators),
            suppressed_protective_matches=list(state.suppressed_protective_matches),
            duplicate_indicators_skipped=state.total_duplicates_skipped,
            synced_keywords_matched=list(state.synced_keywords_hit),
        )

        # Evaluate Contextual Director with prior utterances + current segment
        contextual_result = self.contextual_analyzer.analyze(
            segment.text, conversation_history=state.recent_utterances
        )

        # Keep rolling history window bounded
        state.recent_utterances.append(segment.text)
        if len(state.recent_utterances) > 12:
            state.recent_utterances = state.recent_utterances[-12:]

        rag_result_dict = None
        rag_svc = self._get_rag_service()
        if rag_svc and getattr(self.settings, "enable_live_rag", False):
            try:
                rag_resp = rag_svc.classify_text(segment.text, top_k=3)
                rag_result_dict = rag_resp.model_dump()
            except Exception as rag_err:
                logger.debug("RAG classification skipped on segment: %s", rag_err)

        assessment = self.risk_scorer.score(
            rule_result=cumulative_rule_result,
            contextual_result=contextual_result,
            transcript_confidence=segment.transcript_confidence,
            start_seconds=segment.start_seconds,
            end_seconds=segment.end_seconds,
            sync_status=self.keyword_sync.get_sync_status(),
            rag_result=rag_result_dict,
        )

        moment_assessment = self._assess_moment(window_text, segment)

        seq_num = len(state.segments) + 1
        segment_id = f"seg_{seq_num:03d}_{uuid.uuid4().hex[:6]}"
        seg_record = CallSegmentRecord(
            segment_id=segment_id,
            sequence_number=seq_num,
            speaker=segment.speaker,
            language_code=segment.language_code,
            start_seconds=segment.start_seconds,
            end_seconds=segment.end_seconds,
            text=segment.text,
            transcript_confidence=segment.transcript_confidence,
            detected_indicators=[
                i.keyword_or_pattern for i in segment_rule_res.triggered_indicators
            ],
            risk_level_at_segment=assessment.risk_level,
            risk_score_at_segment=assessment.risk_score,
            caption_at_segment=assessment.caption,
            processed_at=round(time.time(), 3),
        )

        state.segments.append(seg_record)
        if len(state.segments) > self.settings.max_segments_per_call:
            state.segments = state.segments[-self.settings.max_segments_per_call :]

        state.latest_assessment = assessment
        state.latest_moment_assessment = moment_assessment
        self.repository.save(state)

        # Dispatch Telegram notification if enabled and risk threshold reached
        if self.telegram_service.is_enabled:
            try:
                self.telegram_service.send_risk_alert(assessment, call_id)
            except Exception as exc:
                logger.warning("Telegram notification dispatch error: %s", exc)

        return CallSegmentUpdateResponse(
            call_id=call_id,
            segment_id=segment_id,
            sequence_number=seq_num,
            duplicate_evidence_suppressed=segment_rule_res.duplicate_indicators_skipped,
            synced_keywords_triggered=list(segment_rule_res.synced_keywords_matched),
            assessment=assessment,
            moment_assessment=moment_assessment,
        )

    @staticmethod
    def _window_text(state, segment: CallSegmentRequest, max_previous: int = 2) -> str:
        """This segment plus up to `max_previous` earlier segments from the same speaker, but only
        while the earlier one ends mid-sentence (no . ! ? ।), so finished sentences never carry over."""
        parts = [segment.text.strip()]
        for prev in reversed(state.segments[-max_previous:] if max_previous else []):
            prev_text = (prev.text or "").strip()
            if prev.speaker != segment.speaker or not prev_text or prev_text[-1] in ".!?।|":
                break
            parts.insert(0, prev_text)
        return " ".join(parts)

    def _assess_moment(self, window_text: str, segment: CallSegmentRequest) -> ScamRiskAssessment:
        """Scores only what was just said: fresh rule evaluation (no call memory) and no
        conversation history for the contextual engine, so risk doesn't stick to later words."""
        moment_rules, _ = self.rules_engine.evaluate(
            window_text,
            start_seconds=segment.start_seconds,
            end_seconds=segment.end_seconds,
        )
        moment_context = self.contextual_analyzer.analyze(window_text, conversation_history=[])
        return self.risk_scorer.score(
            rule_result=moment_rules,
            contextual_result=moment_context,
            transcript_confidence=segment.transcript_confidence,
            start_seconds=segment.start_seconds,
            end_seconds=segment.end_seconds,
            sync_status=self.keyword_sync.get_sync_status(),
        )

    def get_latest_risk(self, call_id: str) -> Optional[ScamRiskAssessment]:
        state = self.repository.get(call_id)
        if state is None:
            return None
        return state.latest_assessment

    def get_history(self, call_id: str) -> Optional[CallHistoryResponse]:
        state = self.repository.get(call_id)
        if state is None:
            return None
        return CallHistoryResponse(
            call_id=state.call_id,
            created_at=state.created_at,
            updated_at=state.updated_at,
            expires_at=state.expires_at,
            retention_seconds=state.retention_seconds,
            segment_count=len(state.segments),
            unique_indicators=[
                f"{i.category}:{i.keyword_or_pattern}" for i in state.accumulated_indicators
            ],
            synced_keywords_hit=list(state.synced_keywords_hit),
            segments=list(state.segments),
            latest_assessment=state.latest_assessment,
        )

    def clear_call(self, call_id: str) -> Optional[CallClearResponse]:
        existed = self.repository.delete(call_id)
        if not existed:
            return None
        return CallClearResponse(
            call_id=call_id,
            cleared=True,
            message=f"Stored conversation state and history for call '{call_id}' cleared.",
        )
