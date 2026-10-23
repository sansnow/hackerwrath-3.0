"""
Banking-secret detection and per-moment live risk.

- Asking for an OTP, CVV, PIN, card or account detail is High risk, in English, Hindi and Punjabi.
- Merely bringing one up is Possible risk; safety advice about them is not flagged at all.
- Harmless words said after a scam line are not flagged (moment risk), while the call's overall
  risk keeps the evidence.
- A phrase split across two live slices ("please share the six" / "digit OTP") is still caught.
"""
from __future__ import annotations

import unittest

from app.core.config import Settings
from app.repositories.conversation_repository import InMemoryConversationRepository
from app.schemas.analysis import TranscriptAnalysisRequest
from app.schemas.calls import CallSegmentRequest
from app.services.contextual_analyzer import ContextualAnalyzer
from app.services.conversation_manager import ConversationManager
from app.services.keyword_sync_service import KeywordSyncService
from app.services.risk_scorer import RiskScorer
from app.services.rules_engine import RulesEngine

HIGH = ("HIGH", "CRITICAL")
FLAGGED = ("MEDIUM", "HIGH", "CRITICAL")
CLEAR = ("LOW", "UNKNOWN")


class SensitiveTermsTestSuite(unittest.TestCase):
    def setUp(self) -> None:
        self.settings = Settings(sarvam_api_key="", calibrated_probability_enabled=False)
        self.sync_service = KeywordSyncService(settings=self.settings)
        self.manager = ConversationManager(
            repository=InMemoryConversationRepository(settings=self.settings),
            rules_engine=RulesEngine(settings=self.settings, keyword_sync_service=self.sync_service),
            contextual_analyzer=ContextualAnalyzer(settings=self.settings),
            risk_scorer=RiskScorer(settings=self.settings),
            keyword_sync_service=self.sync_service,
            settings=self.settings,
        )

    def _level(self, text: str) -> str:
        return self.manager.analyze_standalone_transcript(
            TranscriptAnalysisRequest(transcript=text, language_code="auto", transcript_confidence=0.95)
        ).risk_level

    def _segment(self, call_id: str, text: str):
        return self.manager.process_segment(
            call_id, CallSegmentRequest(text=text, speaker="customer", start_seconds=0.0, end_seconds=1.5)
        )

    def test_asks_for_banking_secrets_are_high_risk(self) -> None:
        for text in (
            "What is your CVV?",
            "Tell me your card number and expiry date",
            "Card number batao",
            "Account number bata dijiye",
            "MPIN kya hai aapka",
            "Read me the code you got on SMS",
            "Send me your net banking password",
            "कार्ड नंबर बताइए",
            "बैंक डिटेल्स भेजो",
            "अपना अकाउंट नंबर दीजिए",
            "ਓਟੀਪੀ ਦੱਸੋ",
        ):
            with self.subTest(text=text):
                self.assertIn(self._level(text), HIGH)

    def test_bare_mentions_are_possible_risk(self) -> None:
        for text in ("OTP", "OTP, OTP", "Bank account, CVV", "Bank details", "ओटीपी", "ਕਾਰਡ ਨੰਬਰ"):
            with self.subTest(text=text):
                self.assertIn(self._level(text), FLAGGED)
                self.assertNotIn(self._level(text), HIGH)

    def test_safety_advice_and_everyday_talk_are_not_flagged(self) -> None:
        for text in (
            "Hello",
            "Okay okay okay",
            "Thank you so much",
            "हाँ जी।",
            "I will deliver your parcel at 5 pm today",
            "Never share your OTP or CVV with anyone",
            "Bank will never ask for your card details",
            "Don't give your card number to anyone",
            "कार्ड नंबर किसी को मत बताइए",
            "I want to check my account balance",
            "My pin code is 560001",
        ):
            with self.subTest(text=text):
                self.assertIn(self._level(text), CLEAR)

    def test_advice_followed_by_an_ask_is_still_an_ask(self) -> None:
        for text in (
            "Don't share it with anyone, just tell me the OTP",
            "Don't tell anyone, give your card number",
        ):
            with self.subTest(text=text):
                self.assertIn(self._level(text), HIGH)

    def test_harmless_words_after_a_scam_line_are_not_flagged(self) -> None:
        call_id = "moment_after_scam"
        scam = self._segment(call_id, "Please tell me the OTP you received right now.")
        self.assertIn(scam.moment_assessment.risk_level, HIGH)
        for text in ("Hello", "Okay", "Thank you so much"):
            with self.subTest(text=text):
                res = self._segment(call_id, text)
                self.assertIn(res.moment_assessment.risk_level, CLEAR)
                # The call itself still remembers the scam.
                self.assertIn(res.assessment.risk_level, HIGH)

    def test_phrase_split_across_live_slices_is_caught(self) -> None:
        call_id = "split_phrase"
        first = self._segment(call_id, "Please share the six")
        self.assertIn(first.moment_assessment.risk_level, CLEAR)
        second = self._segment(call_id, "digit OTP you just")
        self.assertIn(second.moment_assessment.risk_level, HIGH)

    def test_finished_sentences_do_not_carry_into_the_next_slice(self) -> None:
        call_id = "no_carry_over"
        self._segment(call_id, "Please share the OTP.")
        self.assertIn(self._segment(call_id, "Thanks, bye").moment_assessment.risk_level, CLEAR)


if __name__ == "__main__":
    unittest.main()
