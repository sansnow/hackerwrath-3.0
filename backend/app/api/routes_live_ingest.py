"""
Real-Time Ingestion WebSocket & API for Telegram VoIP Voice Call Bridge.
Compatible with onfloor/apps/telegram-bridge (py-tgcalls + pyrogram).

Protocol:
1. Client connects to WS `/internal/live/ingest` with optional header `x-bridge-secret`.
2. Client sends JSON: `{"type": "call_started", "protocolVersion": 1, "telegramCallId": "...", "customer": {...}}`
   Server acknowledges: `{"type": "ack", "protocolVersion": 1, "callId": "..."}`
3. Client streams binary frames:
   - Byte 0: channel (0 = agent, 1 = customer / potential scammer)
   - Bytes 1-4: unsigned little-endian sample offset (uint32)
   - Bytes 5+: PCM16LE audio at 16kHz mono
4. Customer audio is buffered and transcribed via Sarvam Saaras / ConversationManager.
   Risk is evaluated in real-time, flagged keywords are identified, and protective alerts are dispatched.
5. Client sends JSON: `{"type": "call_ended", "reason": "telegram_hangup"}`
   Server acknowledges: `{"type": "ended", "callId": "..."}`
"""
from __future__ import annotations

import asyncio
import io
import json
import struct
import time
import uuid
import wave
from typing import Any, Dict, Optional

from app.api.routes_analysis import get_conversation_manager
from app.api.routes_transcription import get_stt_provider
from app.core.compat import APIRouter, Depends, Header, HTTPException, WebSocket, WebSocketDisconnect
from app.core.config import Settings, get_settings
from app.core.logging import get_logger
from app.schemas.calls import CallSegmentRequest
from app.services.conversation_manager import ConversationManager
from app.services.live_audio_processor import (
    LiveAudioSession,
    get_broadcaster,
)
from app.services.telegram_service import TelegramAlertService, get_telegram_service
from app.services.transcription_service import SUPPORTED_LANGUAGE_CODES, BaseSpeechToTextProvider

logger = get_logger("scam_detector.live_ingest")
router = APIRouter(prefix="/internal/live", tags=["live_ingest"])


def _supported_language(code: Optional[str]) -> str:
    """A language code the speech-to-text provider accepts, else "auto"."""
    code = (code or "").strip()
    return code if code in SUPPORTED_LANGUAGE_CODES else "auto"


@router.get("/status")
async def get_live_bridge_status(
    settings: Settings = Depends(get_settings),
) -> Dict[str, Any]:
    """Returns the readiness status of the Telegram VoIP live call audio bridge."""
    configured_secret = bool(settings.bridge_secret or settings.telegram_webhook_secret)
    return {
        "status": "ready",
        "websocket_endpoint": "/internal/live/ingest",
        "protocol_version": 1,
        "sample_rate_hz": 16000,
        "format": "PCM16LE_MONO",
        "supported_channels": ["0:agent", "1:customer"],
        "sarvam_stt_connected": settings.has_live_sarvam_key,
        "bridge_secret_configured": configured_secret,
    }


class LiveBridgeSessionRegistry:
    """Maintains active Telegram bridge sessions to support seamless client reconnections."""

    def __init__(self) -> None:
        self._sessions: Dict[str, LiveAudioSession] = {}
        self._cleanup_tasks: Dict[str, asyncio.Task] = {}

    def get(self, call_id: str) -> Optional[LiveAudioSession]:
        return self._sessions.get(call_id)

    def register(self, call_id: str, session: LiveAudioSession) -> None:
        if call_id in self._cleanup_tasks:
            self._cleanup_tasks[call_id].cancel()
            self._cleanup_tasks.pop(call_id, None)
        self._sessions[call_id] = session

    def remove(self, call_id: str) -> Optional[LiveAudioSession]:
        if call_id in self._cleanup_tasks:
            self._cleanup_tasks[call_id].cancel()
            self._cleanup_tasks.pop(call_id, None)
        return self._sessions.pop(call_id, None)

    def schedule_disconnect_grace_cleanup(self, call_id: str, grace_seconds: float = 15.0) -> None:
        if call_id not in self._sessions:
            return

        async def _grace_cleanup() -> None:
            try:
                await asyncio.sleep(grace_seconds)
                s = self._sessions.pop(call_id, None)
                if s and s.is_active:
                    logger.info(
                        "Grace period (%.1fs) expired for call '%s'; flushing resources",
                        grace_seconds,
                        call_id,
                    )
                    await s.stop_and_flush()
            except asyncio.CancelledError:
                pass
            finally:
                self._cleanup_tasks.pop(call_id, None)

        task = asyncio.create_task(_grace_cleanup())
        self._cleanup_tasks[call_id] = task


_bridge_registry = LiveBridgeSessionRegistry()


def get_bridge_registry() -> LiveBridgeSessionRegistry:
    return _bridge_registry


@router.post("/spike")
async def test_bridge_spike_simulation(
    payload: Dict[str, Any],
    manager: ConversationManager = Depends(get_conversation_manager),
    telegram_service: TelegramAlertService = Depends(get_telegram_service),
) -> Dict[str, Any]:
    """
    Simulates a Telegram VoIP Call Bridge event without requiring active py-tgcalls setup.
    Useful for testing the live audio analysis, keyword flagging, and Telegram alerts.
    """
    transcript = payload.get(
        "transcript",
        "Hello sir, your bank account is blocked today. Share the 6-digit OTP immediately to avoid police arrest.",
    )
    call_id = payload.get("call_id") or f"tg_spike_{uuid.uuid4().hex[:6]}"
    customer_name = payload.get("customer_name", "Telegram Suspicious Caller")

    seg_req = CallSegmentRequest(
        text=transcript,
        speaker="customer",
        language_code=payload.get("language_code", "auto"),
        start_seconds=0.0,
        end_seconds=4.0,
        transcript_confidence=0.96,
    )
    seg_resp = manager.process_segment(call_id, seg_req)

    # Dispatch alert if enabled
    alert_result = None
    if telegram_service.is_enabled:
        alert_result = telegram_service.send_risk_alert(seg_resp.assessment, call_id).model_dump()

    return {
        "status": "simulated",
        "call_id": call_id,
        "customer_name": customer_name,
        "assessment": seg_resp.assessment.model_dump(),
        "flagged_keywords": [i.keyword_or_pattern for i in seg_resp.assessment.rule_analysis.triggered_indicators],
        "telegram_alert": alert_result,
    }


@router.websocket("/ingest")
async def websocket_live_ingest(
    websocket: WebSocket,
    manager: ConversationManager = Depends(get_conversation_manager),
    stt_provider: BaseSpeechToTextProvider = Depends(get_stt_provider),
    telegram_service: TelegramAlertService = Depends(get_telegram_service),
    settings: Settings = Depends(get_settings),
    registry: LiveBridgeSessionRegistry = Depends(get_bridge_registry),
) -> None:
    """
    WebSocket endpoint ingesting real-time audio from onfloor telegram-bridge (py-tgcalls).
    Supports:
    - x-bridge-secret authentication
    - call_started handshake with protocolVersion: 1 and callId resumption
    - Dual-channel binary PCM frames (0: agent / local mic, 1: customer / remote caller)
    - 4-byte uint32 little-endian absolute sample offset validation
    - Seamless reconnection without resetting ongoing call state
    - Prompt call_ended acknowledgement
    """
    await websocket.accept()

    expected_secret = (settings.bridge_secret or settings.telegram_webhook_secret or "").strip()
    if expected_secret:
        client_secret = (
            websocket.headers.get("x-bridge-secret")
            or websocket.query_params.get("secret")
            or ""
        ).strip()
        if client_secret != expected_secret:
            logger.warning("Rejected unauthorized WebSocket live ingest connection (invalid secret)")
            await websocket.close(code=1008)
            return

    logger.info("Telegram live call audio bridge connected")

    call_id: Optional[str] = None
    session: Optional[LiveAudioSession] = None
    broadcaster = get_broadcaster()
    explicitly_ended = False

    async def forward_to_bridge_client(event: Dict[str, Any]) -> None:
        try:
            await websocket.send_json(event)
        except Exception:
            pass

    try:
        while True:
            message = await websocket.receive()

            # Handle JSON Control Messages
            if "text" in message and message["text"]:
                try:
                    data = json.loads(message["text"])
                except Exception:
                    await websocket.send_json({
                        "type": "error",
                        "code": "MALFORMED_JSON",
                        "message": "Malformed JSON control payload",
                        "retryable": False,
                    })
                    continue

                msg_type = data.get("type")

                if msg_type == "call_started":
                    protocol_version = data.get("protocolVersion", 1)
                    if protocol_version != 1:
                        await websocket.send_json({
                            "type": "error",
                            "code": "UNSUPPORTED_PROTOCOL",
                            "message": f"Unsupported protocolVersion: {protocol_version}. Expected 1.",
                            "retryable": False,
                        })
                        continue

                    # Check for reconnection to existing active call
                    requested_call_id = data.get("callId")
                    if requested_call_id and registry.get(requested_call_id):
                        call_id = requested_call_id
                        session = registry.get(call_id)
                        session.reconnect(on_event_callback=forward_to_bridge_client)
                        logger.info("Resumed ongoing Telegram call session '%s'", call_id)
                        await websocket.send_json({
                            "type": "ack",
                            "protocolVersion": 1,
                            "callId": call_id,
                        })
                    else:
                        tg_id = data.get("telegramCallId", f"peer_{uuid.uuid4().hex[:6]}")
                        call_id = f"tg_call_{uuid.uuid4().hex[:8]}"
                        logger.info("Started new Telegram call '%s' (tg: %s)", call_id, tg_id)

                        session = LiveAudioSession(
                            call_id=call_id,
                            stt_provider=stt_provider,
                            conversation_manager=manager,
                            telegram_service=telegram_service,
                            broadcaster=broadcaster,
                            language_code="auto",
                            source="telegram_bridge",
                            on_event_callback=forward_to_bridge_client,
                            telegram_meta=data.get("customer", {}),
                        )
                        registry.register(call_id, session)
                        session.start()

                        await websocket.send_json({
                            "type": "ack",
                            "protocolVersion": 1,
                            "callId": call_id,
                        })

                elif msg_type == "call_ended":
                    explicitly_ended = True
                    if session:
                        end_summary = await session.stop_and_flush()
                        registry.remove(call_id)
                        logger.info("Ended Telegram call '%s'", call_id)
                        await websocket.send_json({
                            "type": "ended",
                            "callId": call_id,
                            "summary": end_summary,
                        })
                        session = None
                    else:
                        await websocket.send_json({
                            "type": "ended",
                            "callId": call_id or "unknown",
                        })
                    break

            # Handle Binary PCM Audio Frames (16kHz 16-bit Mono, Little-Endian)
            elif "bytes" in message and message["bytes"]:
                raw_bytes = message["bytes"]
                if len(raw_bytes) < 5:
                    logger.warning("Rejected malformed binary frame (size %d < 5 bytes)", len(raw_bytes))
                    continue

                if len(raw_bytes) > 65536:
                    logger.warning("Rejected oversized binary frame (size %d > 65536 bytes)", len(raw_bytes))
                    continue

                if session is None:
                    logger.warning("Rejected pre-ack audio frame: session not initialized")
                    continue

                channel = raw_bytes[0]
                if channel not in (0, 1):
                    logger.warning("Rejected invalid channel identifier %d (expected 0 or 1)", channel)
                    continue

                offset = struct.unpack("<I", raw_bytes[1:5])[0]
                pcm = raw_bytes[5:]

                if len(pcm) % 2 != 0:
                    logger.warning("Rejected unaligned PCM16 data on channel %d (length %d)", channel, len(pcm))
                    continue

                session.push_audio_frame(channel, offset, pcm)

    except (WebSocketDisconnect, RuntimeError) as disconnect_exc:
        logger.info("Telegram bridge WebSocket disconnected cleanly (%s): %s", call_id, disconnect_exc)
    except Exception as exc:
        logger.error("Telegram bridge error: %s", exc)
    finally:
        if session and call_id and not explicitly_ended:
            logger.info("Scheduling 15s reconnect grace period for call '%s'", call_id)
            registry.schedule_disconnect_grace_cleanup(call_id, grace_seconds=15.0)
        elif session and explicitly_ended:
            registry.remove(call_id)
        try:
            await websocket.close()
        except Exception:
            pass


@router.websocket("/browser-stream")
async def websocket_browser_stream(
    websocket: WebSocket,
    manager: ConversationManager = Depends(get_conversation_manager),
    stt_provider: BaseSpeechToTextProvider = Depends(get_stt_provider),
    telegram_service: TelegramAlertService = Depends(get_telegram_service),
) -> None:
    """
    Direct WebSocket endpoint for continuous browser-based live audio capture.
    Allows capturing live ongoing phone calls (e.g., phone on speaker or Telegram desktop audio)
    directly through the browser microphone without stopping after every sentence.
    """
    await websocket.accept()
    call_id = f"web_live_{uuid.uuid4().hex[:8]}"
    # This socket gets its own call's events through `forward_to_browser`. It is not registered
    # with the broadcaster, which would deliver every event twice and also push other calls'
    # captions (e.g. a Telegram call running at the same time) into this one.
    broadcaster = get_broadcaster()

    async def forward_to_browser(event: Dict[str, Any]) -> None:
        try:
            await websocket.send_json(event)
        except Exception:
            pass

    session = LiveAudioSession(
        call_id=call_id,
        stt_provider=stt_provider,
        conversation_manager=manager,
        telegram_service=telegram_service,
        broadcaster=broadcaster,
        # `?language=hi-IN` (or a later {"type": "set_language"} message) pins Sarvam to one
        # language; "auto" lets it guess per slice, which can drift into other Indian languages.
        language_code=_supported_language(websocket.query_params.get("language")),
        on_event_callback=forward_to_browser,
    )
    session.start()

    await websocket.send_json({
        "type": "session_ready",
        "callId": call_id,
        "sampleRate": 16000,
        "chunkTargetWords": 8,
        "status": "LISTENING_CONTINUOUS",
    })

    try:
        while True:
            msg = await websocket.receive()
            if "text" in msg and msg["text"]:
                try:
                    data = json.loads(msg["text"])
                    if data.get("type") == "stop":
                        break
                    if data.get("type") == "set_language":
                        session.language_code = _supported_language(data.get("language_code"))
                except Exception:
                    continue
            elif "bytes" in msg and msg["bytes"]:
                # Browser streams raw PCM16LE audio chunks continuously
                session.push_pcm_frame(msg["bytes"])

    except (WebSocketDisconnect, RuntimeError):
        logger.info("Browser audio stream disconnected (%s)", call_id)
    except Exception as exc:
        logger.error("Browser stream error: %s", exc)
    finally:
        await session.stop_and_flush()


@router.websocket("/events")
async def websocket_dashboard_events(
    websocket: WebSocket,
) -> None:
    """
    HUD broadcast WebSocket for the Suraksha frontend dashboard.
    Receives all live caption updates, risk score changes, and Telegram notifications in real-time.
    """
    await websocket.accept()
    broadcaster = get_broadcaster()
    broadcaster.register(websocket)
    try:
        while True:
            await websocket.receive_text()
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        broadcaster.unregister(websocket)
