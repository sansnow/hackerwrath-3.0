"""Pydantic schemas for Conversation State Management and Cross-Call Synchronization."""
from __future__ import annotations

from typing import Any, Dict, List, Optional
from app.core.compat import BaseModel, Field
from app.schemas.analysis import RiskLevelType, ScamRiskAssessment


class CallSegmentRequest(BaseModel):
    """Request body for POST /calls/{call_id}/segments."""

    text: str = Field(min_length=1)
    speaker: str = Field(default="caller")
    language_code: str = Field(default="auto")
    start_seconds: float = Field(default=0.0, ge=0.0)
    end_seconds: float = Field(default=3.0, ge=0.0)
    transcript_confidence: float = Field(default=0.92, ge=0.0, le=1.0)


class CallSegmentRecord(BaseModel):
    """Permitted analysis record for a processed call segment (avoids storing raw audio)."""

    segment_id: str
    sequence_number: int
    speaker: str
    language_code: str
    start_seconds: float
    end_seconds: float
    text: str = ""
    transcript_confidence: float
    detected_indicators: List[str] = Field(default_factory=list)
    risk_level_at_segment: RiskLevelType = "LOW"
    risk_score_at_segment: float = 0.0
    caption_at_segment: str = ""
    processed_at: float


class CallSegmentUpdateResponse(BaseModel):
    """Response returned by POST /calls/{call_id}/segments."""

    call_id: str
    segment_id: str
    sequence_number: int
    duplicate_evidence_suppressed: int = 0
    synced_keywords_triggered: List[str] = Field(default_factory=list)
    # Risk of the whole call so far: evidence accumulates and never decays.
    assessment: ScamRiskAssessment
    # Risk of what was just said (this segment plus an unfinished sentence before it). Use this for
    # live captions and alerts, so "Hello" after a scam line isn't shown as a scam.
    moment_assessment: Optional[ScamRiskAssessment] = None


class CallHistoryResponse(BaseModel):
    """Response returned by GET /calls/{call_id}/history."""

    call_id: str
    created_at: float
    updated_at: float
    expires_at: float
    retention_seconds: int
    segment_count: int
    unique_indicators: List[str] = Field(default_factory=list)
    synced_keywords_hit: List[str] = Field(default_factory=list)
    segments: List[CallSegmentRecord] = Field(default_factory=list)
    latest_assessment: Optional[ScamRiskAssessment] = None


class CallClearResponse(BaseModel):
    """Response returned by DELETE /calls/{call_id}."""

    call_id: str
    cleared: bool
    message: str


class KeywordSyncUpdateRequest(BaseModel):
    """Request body for POST /sync/keywords to synchronize keywords across calls."""

    keyword: str = Field(min_length=2)
    category: str = Field(default="OTP_OR_PIN_REQUEST")
    weight: float = Field(default=30.0, ge=0.0, le=100.0)
    source_call_id: Optional[str] = None


class KeywordSyncEntry(BaseModel):
    """A synchronized keyword or pattern shared across calls."""

    keyword: str
    category: str
    weight: float
    hit_count: int = 1
    source_calls: List[str] = Field(default_factory=list)
    active: bool = True
    updated_at: float


class KeywordSyncStateResponse(BaseModel):
    """Response reporting cross-call keyword synchronization state and module readiness."""

    working: bool = True
    sync_enabled: bool = True
    total_synced_keywords: int = 0
    keywords: List[KeywordSyncEntry] = Field(default_factory=list)
    component_readiness: Dict[str, Any] = Field(default_factory=dict)
