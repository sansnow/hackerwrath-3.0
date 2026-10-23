"""
Application configuration loaded from environment variables (.env).
Never hardcodes API keys or secrets.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Dict, List

from pathlib import Path

try:
    from dotenv import load_dotenv  # type: ignore
    _env_path = Path(__file__).resolve().parent.parent.parent / ".env"
    if _env_path.exists():
        load_dotenv(dotenv_path=_env_path)
    else:
        load_dotenv()
except ImportError:
    pass


def _env_bool(name: str, default: bool = False) -> bool:
    val = os.getenv(name)
    if val is None:
        return default
    return val.strip().lower() in ("1", "true", "yes", "on")


def _env_float(name: str, default: float) -> float:
    val = os.getenv(name)
    if val is None:
        return default
    try:
        return float(val)
    except ValueError:
        return default


def _env_threshold(name: str, default: float) -> float:
    val = _env_float(name, default)
    if 0.0 < val <= 1.0:
        return val * 100.0
    return val


def _env_int(name: str, default: int) -> int:
    val = os.getenv(name)
    if val is None:
        return default
    try:
        return int(val)
    except ValueError:
        return default


DEFAULT_RULE_WEIGHTS: Dict[str, float] = {
    "OTP_OR_PIN_REQUEST": 55.0,
    "QR_SCAN_TO_RECEIVE_MONEY": 55.0,
    "REMOTE_ACCESS_OR_SCREEN_SHARE": 60.0,
    "THREAT_ARREST_OR_LEGAL_ACTION": 50.0,
    "ACCOUNT_SUSPENSION_THREAT": 40.0,
    "AUTHORITY_OR_BANK_IMPERSONATION": 35.0,
    "URGENT_PAYMENT_DEMAND": 35.0,
    "PRESSURE_AND_SECRECY_TACTIC": 30.0,
    "SUSPICIOUS_LINK_OR_APK": 45.0,
    "CROSS_CALL_SYNCED_KEYWORD": 30.0,
    # A caller bringing up an OTP, CVV, card or account number without (yet) asking for it:
    # enough for a Possible risk warning, never a High risk alert on its own.
    "SENSITIVE_DETAIL_MENTION": 38.0,
}


@dataclass
class Settings:
    """Centralized backend settings for Scam-Call Detection System."""

    app_name: str = "AI Scam-Call Detection Backend"
    app_version: str = "1.0.0"

    # Sarvam AI configuration (loaded exclusively from environment variables)
    sarvam_api_key: str = field(default_factory=lambda: os.getenv("SARVAM_API_KEY", ""))
    sarvam_base_url: str = field(
        default_factory=lambda: os.getenv("SARVAM_BASE_URL", "https://api.sarvam.ai")
    )
    sarvam_stt_model: str = field(
        default_factory=lambda: os.getenv("SARVAM_STT_MODEL", "saaras:v3")
    )
    sarvam_llm_model: str = field(
        default_factory=lambda: os.getenv("SARVAM_LLM_MODEL", "sarvam-105b")
    )
    sarvam_timeout_seconds: float = field(
        default_factory=lambda: _env_float("SARVAM_TIMEOUT_SECONDS", 5.0)
    )
    enable_live_sarvam_llm: bool = field(
        default_factory=lambda: _env_bool("ENABLE_LIVE_SARVAM_LLM", False)
    )

    # Audio validation & size limits
    max_audio_file_size_mb: float = field(
        default_factory=lambda: _env_float("MAX_AUDIO_FILE_SIZE_MB", 10.0)
    )
    allowed_audio_extensions: List[str] = field(
        default_factory=lambda: [
            ext.strip().lower()
            for ext in os.getenv(
                "ALLOWED_AUDIO_EXTENSIONS", "wav,mp3,ogg,m4a,flac,webm"
            ).split(",")
            if ext.strip()
        ]
    )

    # Risk scoring & calibration parameters
    rule_score_weight: float = field(
        default_factory=lambda: _env_float("RULE_SCORE_WEIGHT", 0.45)
    )
    contextual_score_weight: float = field(
        default_factory=lambda: _env_float("CONTEXTUAL_SCORE_WEIGHT", 0.55)
    )
    deepfake_score_weight: float = field(
        default_factory=lambda: _env_float("DEEPFAKE_SCORE_WEIGHT", 0.15)
    )
    low_risk_threshold: float = field(
        default_factory=lambda: _env_threshold("LOW_RISK_THRESHOLD", 30.0)
    )
    medium_risk_threshold: float = field(
        default_factory=lambda: _env_threshold("MEDIUM_RISK_THRESHOLD", 60.0)
    )
    high_risk_threshold: float = field(
        default_factory=lambda: _env_threshold("HIGH_RISK_THRESHOLD", 80.0)
    )
    critical_risk_threshold: float = field(
        default_factory=lambda: _env_threshold("CRITICAL_RISK_THRESHOLD", 80.0)
    )
    # Lowest score for a direct ask for an OTP / CVV / PIN / card or account detail (High risk),
    # and for a bare mention of one (Possible risk).
    credential_request_floor: float = field(
        default_factory=lambda: _env_threshold("CREDENTIAL_REQUEST_FLOOR", 65.0)
    )
    sensitive_mention_floor: float = field(
        default_factory=lambda: _env_threshold("SENSITIVE_MENTION_FLOOR", 35.0)
    )
    min_transcript_confidence: float = field(
        default_factory=lambda: _env_float("MIN_TRANSCRIPT_CONFIDENCE", 0.40)
    )

    # Calibrated probability p(scam) settings:
    # By requirement 5, heuristic scores must NEVER be labelled as true probabilities.
    # p_scam returns None (null) unless a calibrated model is explicitly enabled and validated.
    calibrated_probability_enabled: bool = field(
        default_factory=lambda: _env_bool("CALIBRATED_PROBABILITY_ENABLED", False)
    )
    calibration_slope: float = field(
        default_factory=lambda: _env_float("CALIBRATION_SLOPE", 4.2)
    )
    calibration_intercept: float = field(
        default_factory=lambda: _env_float("CALIBRATION_INTERCEPT", -2.1)
    )

    # State retention & privacy controls
    call_state_retention_seconds: int = field(
        default_factory=lambda: _env_int("CALL_STATE_RETENTION_SECONDS", 3600)
    )
    max_segments_per_call: int = field(
        default_factory=lambda: _env_int("MAX_SEGMENTS_PER_CALL", 200)
    )
    log_sensitive_transcripts: bool = field(
        default_factory=lambda: _env_bool("LOG_SENSITIVE_TRANSCRIPTS", False)
    )
    enable_cross_call_keyword_sync: bool = field(
        default_factory=lambda: _env_bool("ENABLE_CROSS_CALL_KEYWORD_SYNC", True)
    )
    enable_live_rag: bool = field(
        default_factory=lambda: _env_bool("ENABLE_LIVE_RAG", False)
    )
    rag_score_weight: float = field(
        default_factory=lambda: _env_float("RAG_SCORE_WEIGHT", 0.35)
    )
    enable_deepfake_detection: bool = field(
        default_factory=lambda: _env_bool("ENABLE_DEEPFAKE_DETECTION", False)
    )
    rule_weights: Dict[str, float] = field(
        default_factory=lambda: dict(DEFAULT_RULE_WEIGHTS)
    )

    # Telegram Bot Integration (Optional protective alert notifications)
    telegram_bot_token: str = field(
        default_factory=lambda: os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
    )
    telegram_chat_id: str = field(
        default_factory=lambda: os.getenv("TELEGRAM_CHAT_ID", "").strip()
    )
    telegram_alerts_enabled: bool = field(
        default_factory=lambda: _env_bool("TELEGRAM_ALERTS_ENABLED", True)
    )
    telegram_alert_threshold: str = field(
        default_factory=lambda: os.getenv("TELEGRAM_ALERT_THRESHOLD", "HIGH").strip().upper()
    )
    telegram_authorized_users: List[str] = field(
        default_factory=lambda: [
            u.strip()
            for u in os.getenv("TELEGRAM_AUTHORIZED_USERS", "").split(",")
            if u.strip()
        ]
    )
    telegram_webhook_secret: str = field(
        default_factory=lambda: os.getenv("TELEGRAM_WEBHOOK_SECRET", "").strip()
    )
    bridge_secret: str = field(
        default_factory=lambda: os.getenv("BRIDGE_SECRET", "").strip()
    )
    telegram_timeout_seconds: float = field(
        default_factory=lambda: _env_float("TELEGRAM_TIMEOUT_SECONDS", 10.0)
    )

    @property
    def max_audio_bytes(self) -> int:
        return int(self.max_audio_file_size_mb * 1024 * 1024)

    @property
    def has_live_sarvam_key(self) -> bool:
        key = (self.sarvam_api_key or "").strip()
        return bool(
            key
            and key not in (
                "YOUR_SARVAM_API_KEY_HERE",
                "SARVAM_API_KEY_PLACEHOLDER",
                "MY_SARVAM_API_KEY",
            )
        )

    @property
    def has_live_telegram_token(self) -> bool:
        token = (self.telegram_bot_token or "").strip()
        return bool(
            token
            and token not in ("YOUR_TELEGRAM_BOT_TOKEN_HERE", "PLACEHOLDER")
        )

    @property
    def has_live_telegram_credentials(self) -> bool:
        token = (self.telegram_bot_token or "").strip()
        chat_id = (self.telegram_chat_id or "").strip()
        return bool(
            token
            and chat_id
            and token not in ("YOUR_TELEGRAM_BOT_TOKEN_HERE", "PLACEHOLDER")
            and chat_id not in ("YOUR_CHAT_ID_HERE", "0")
        )


def get_settings() -> Settings:
    return Settings()
