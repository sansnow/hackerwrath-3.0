"""
Conversation State Repository Interface and In-Memory Implementation.
Designed behind an abstract base class (`ConversationRepository`) so in-memory
storage can be swapped for Redis or PostgreSQL without modifying services or routes.
"""
from __future__ import annotations

import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set
from app.core.config import Settings, get_settings
from app.schemas.analysis import EvidenceItem, ScamRiskAssessment, TriggeredIndicator
from app.schemas.calls import CallSegmentRecord


@dataclass
class CallConversationState:
    """Internal state for a single call across multiple transcript segments."""

    call_id: str
    created_at: float
    updated_at: float
    retention_seconds: int
    segments: List[CallSegmentRecord] = field(default_factory=list)
    recent_utterances: List[str] = field(default_factory=list)
    seen_rule_keys: Set[str] = field(default_factory=set)
    accumulated_indicators: List[TriggeredIndicator] = field(default_factory=list)
    accumulated_evidence: List[EvidenceItem] = field(default_factory=list)
    synced_keywords_hit: List[str] = field(default_factory=list)
    suppressed_protective_matches: List[str] = field(default_factory=list)
    total_duplicates_skipped: int = 0
    latest_assessment: Optional[ScamRiskAssessment] = None
    latest_moment_assessment: Optional[ScamRiskAssessment] = None

    @property
    def expires_at(self) -> float:
        return self.updated_at + self.retention_seconds

    def is_expired(self, now: Optional[float] = None) -> bool:
        current = now if now is not None else time.time()
        return current > self.expires_at


class ConversationRepository(ABC):
    """Abstract storage contract for multi-segment call state."""

    @abstractmethod
    def get_or_create(self, call_id: str) -> CallConversationState:
        """Retrieves active call state or initializes a new one if missing/expired."""

    @abstractmethod
    def get(self, call_id: str) -> Optional[CallConversationState]:
        """Retrieves active call state, or None if not found or expired."""

    @abstractmethod
    def save(self, state: CallConversationState) -> None:
        """Persists updated call state."""

    @abstractmethod
    def delete(self, call_id: str) -> bool:
        """Deletes stored call state and returns True if a record existed."""

    @abstractmethod
    def purge_expired(self, now: Optional[float] = None) -> int:
        """Removes expired call states according to the retention policy."""


class InMemoryConversationRepository(ConversationRepository):
    """Thread-safe in-memory implementation of ConversationRepository with TTL retention."""

    def __init__(self, settings: Optional[Settings] = None) -> None:
        self.settings = settings or get_settings()
        self._store: Dict[str, CallConversationState] = {}

    def purge_expired(self, now: Optional[float] = None) -> int:
        current = now if now is not None else time.time()
        expired_ids = [
            cid for cid, st in self._store.items() if st.is_expired(current)
        ]
        for cid in expired_ids:
            del self._store[cid]
        return len(expired_ids)

    def get(self, call_id: str) -> Optional[CallConversationState]:
        self.purge_expired()
        state = self._store.get(call_id)
        if state is None or state.is_expired():
            if state is not None:
                del self._store[call_id]
            return None
        return state

    def get_or_create(self, call_id: str) -> CallConversationState:
        existing = self.get(call_id)
        if existing is not None:
            return existing
        now = time.time()
        state = CallConversationState(
            call_id=call_id,
            created_at=now,
            updated_at=now,
            retention_seconds=self.settings.call_state_retention_seconds,
        )
        self._store[call_id] = state
        return state

    def save(self, state: CallConversationState) -> None:
        state.updated_at = time.time()
        self._store[state.call_id] = state

    def delete(self, call_id: str) -> bool:
        existed = call_id in self._store
        self._store.pop(call_id, None)
        return existed


_default_repository = InMemoryConversationRepository()


def get_conversation_repository() -> ConversationRepository:
    return _default_repository
