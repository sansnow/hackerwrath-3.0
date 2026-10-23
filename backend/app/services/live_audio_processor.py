"""
Live Audio Processing, Bounded Buffering, Non-Blocking Streaming,
and Progressive Word-Chunked Captioning Engine for Suraksha Scam Shield.

Features:
- Bounded async queues with backpressure protection (drops oldest on overflow).
- Non-blocking audio capture loop (audio thread never waits for STT or AI).
- Progressive caption generation targeting ~7-8 words per chunk.
- Silence / pause detection with automatic buffer flushing.
- Concurrent multi-layer scam risk evaluation & Telegram alert dispatch.
- Supports both OnFloor Telegram Bridge protocol (16kHz PCM16LE) and Web Browser Live Audio.
"""
from __future__ import annotations

import asyncio
import io
import json
import time
import uuid
import wave
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Set

from app.core.logging import get_logger
from app.schemas.calls import CallSegmentRequest
from app.services.conversation_manager import ConversationManager
from app.services.telegram_service import TelegramAlertService
from app.services.transcription_service import BaseSpeechToTextProvider

logger = get_logger("scam_detector.live_audio_processor")

TARGET_WORDS_PER_CHUNK = 8
MIN_BUFFER_BYTES = 24_000   # ~0.75 seconds of 16kHz 16-bit mono
IDEAL_BUFFER_BYTES = 48_000 # ~1.5 seconds of 16kHz 16-bit mono
MAX_BUFFER_BYTES = 96_000   # ~3.0 seconds max accumulation before forcing slice
PAUSE_FLUSH_SECONDS = 1.2   # Flush if speaker pauses for > 1.2s


def pcm16_to_wav_bytes(pcm_bytes: bytes, sample_rate: int = 16000) -> bytes:
    """Wraps raw 16-bit mono PCM bytes in standard RIFF WAV container in memory."""
    wav_io = io.BytesIO()
    with wave.open(wav_io, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm_bytes)
    return wav_io.getvalue()


def split_text_into_word_chunks(text: str, target_size: int = TARGET_WORDS_PER_CHUNK) -> List[str]:
    """
    Splits continuous transcript text into progressive presentation chunks
    targeting approximately 7-8 words each.
    """
    words = [w.strip() for w in text.split() if w.strip()]
    if not words:
        return []
    if len(words) <= target_size:
        return [" ".join(words)]

    chunks = []
    for i in range(0, len(words), target_size):
        chunk = " ".join(words[i : i + target_size])
        if chunk:
            chunks.append(chunk)
    return chunks


class DashboardBroadcaster:
    """Manages active Web dashboard subscribers and broadcasts live captions & alerts."""

    def __init__(self) -> None:
        self._subscribers: Set[Any] = set()

    def register(self, ws: Any) -> None:
        self._subscribers.add(ws)
        logger.debug("Dashboard subscriber registered (total: %d)", len(self._subscribers))

    def unregister(self, ws: Any) -> None:
        self._subscribers.discard(ws)
        logger.debug("Dashboard subscriber removed (total: %d)", len(self._subscribers))

    async def broadcast(self, payload: Dict[str, Any]) -> None:
        dead = []
        for ws in list(self._subscribers):
            try:
                await ws.send_json(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self._subscribers.discard(ws)


_broadcaster = DashboardBroadcaster()


def get_broadcaster() -> DashboardBroadcaster:
    return _broadcaster


@dataclass
class ChannelState:
    """State and bounded buffering for an individual audio channel (agent or customer)."""

    channel_id: int  # 0 = agent (headset mic), 1 = customer (remote participant)
    speaker: str  # "agent" or "customer"
    queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=100))
    pcm_buffer: bytearray = field(default_factory=bytearray)
    next_expected_sample: int = 0
    total_packets_received: int = 0
    total_packets_dropped: int = 0
    total_gap_samples: int = 0
    total_duplicate_frames: int = 0
    slice_counter: int = 0
    last_packet_time: float = field(default_factory=time.time)
    worker_task: Optional[asyncio.Task] = None


class LiveAudioSession:
    """
    Stateful real-time bidirectional audio capture session for an active call.
    Buffers incoming PCM chunks across Channel 0 (agent / local mic) and Channel 1 (customer / remote caller),
    maintains FIR/sample offsets, generates progressive captions, and coordinates scam risk analysis
    without blocking audio capture streams.
    """

    def __init__(
        self,
        call_id: str,
        stt_provider: BaseSpeechToTextProvider,
        conversation_manager: ConversationManager,
        telegram_service: TelegramAlertService,
        broadcaster: DashboardBroadcaster,
        language_code: str = "auto",
        source: str = "telegram_bridge",
        on_event_callback: Optional[Callable[[Dict[str, Any]], Any]] = None,
        telegram_meta: Optional[Dict[str, Any]] = None,
        queue: Optional[asyncio.Queue] = None,
        pcm_buffer: Optional[bytearray] = None,
        total_packets_received: int = 0,
        total_packets_dropped: int = 0,
        total_words_emitted: int = 0,
        slice_counter: int = 0,
        last_packet_time: Optional[float] = None,
        worker_task: Optional[asyncio.Task] = None,
    ) -> None:
        self.call_id = call_id
        self.stt_provider = stt_provider
        self.conversation_manager = conversation_manager
        self.telegram_service = telegram_service
        self.broadcaster = broadcaster
        self.language_code = language_code
        self.source = source
        self.on_event_callback = on_event_callback
        self.telegram_meta = telegram_meta or {}
        self.is_active = True
        self.created_at = time.time()
        self.last_active_time = time.time()
        self.total_words_emitted = total_words_emitted

        # Channels: 0 = Agent (Headset mic), 1 = Customer (Remote Telegram caller)
        ch0_queue = asyncio.Queue(maxsize=100)
        ch1_queue = queue if queue is not None else asyncio.Queue(maxsize=100)
        ch1_buffer = pcm_buffer if pcm_buffer is not None else bytearray()

        self.channels: Dict[int, ChannelState] = {
            0: ChannelState(channel_id=0, speaker="agent", queue=ch0_queue),
            1: ChannelState(
                channel_id=1,
                speaker="customer",
                queue=ch1_queue,
                pcm_buffer=ch1_buffer,
                total_packets_received=total_packets_received,
                total_packets_dropped=total_packets_dropped,
                slice_counter=slice_counter,
                last_packet_time=last_packet_time or time.time(),
                worker_task=worker_task,
            ),
        }

    # Backward-compatible properties for unit tests & legacy callers
    @property
    def queue(self) -> asyncio.Queue:
        return self.channels[1].queue

    @property
    def pcm_buffer(self) -> bytearray:
        return self.channels[1].pcm_buffer

    @property
    def total_packets_received(self) -> int:
        return sum(ch.total_packets_received for ch in self.channels.values())

    @property
    def total_packets_dropped(self) -> int:
        return sum(ch.total_packets_dropped for ch in self.channels.values())

    @property
    def slice_counter(self) -> int:
        return sum(ch.slice_counter for ch in self.channels.values())

    @property
    def last_packet_time(self) -> float:
        return max(ch.last_packet_time for ch in self.channels.values())

    @last_packet_time.setter
    def last_packet_time(self, val: float) -> None:
        for ch in self.channels.values():
            ch.last_packet_time = val

    @property
    def worker_task(self) -> Optional[asyncio.Task]:
        return self.channels[1].worker_task

    @worker_task.setter
    def worker_task(self, task: Optional[asyncio.Task]) -> None:
        self.channels[1].worker_task = task

    def start(self) -> None:
        """Launches background audio consumer worker loops for both channels."""
        self.is_active = True
        self.last_active_time = time.time()
        for ch in self.channels.values():
            if ch.worker_task is None or ch.worker_task.done():
                ch.worker_task = asyncio.create_task(self._channel_consumer_loop(ch))

    def reconnect(self, on_event_callback: Optional[Callable[[Dict[str, Any]], Any]] = None) -> None:
        """Resumes an ongoing call session after bridge WebSocket reconnect."""
        self.is_active = True
        self.last_active_time = time.time()
        if on_event_callback:
            self.on_event_callback = on_event_callback

        current_loop = None
        try:
            current_loop = asyncio.get_running_loop()
        except RuntimeError:
            pass

        for ch in self.channels.values():
            # Migrate queue if running under a new asyncio event loop (e.g. Starlette thread pool)
            if current_loop and getattr(ch.queue, "_loop", None) is not current_loop:
                new_q: asyncio.Queue = asyncio.Queue(maxsize=100)
                while not ch.queue.empty():
                    try:
                        new_q.put_nowait(ch.queue.get_nowait())
                    except Exception:
                        break
                ch.queue = new_q

            if ch.worker_task is None or ch.worker_task.done():
                ch.worker_task = asyncio.create_task(self._channel_consumer_loop(ch))
        logger.info("Resumed active audio session for call '%s'", self.call_id)

    def push_pcm_frame(self, pcm_bytes: bytes) -> bool:
        """Backward compatibility for single-channel/browser stream: routes to channel 1."""
        ch = self.channels[1]
        return self.push_audio_frame(1, ch.next_expected_sample, pcm_bytes)

    def push_audio_frame(self, channel_id: int, offset: int, pcm_bytes: bytes) -> bool:
        """
        Enqueues channelized PCM16 audio with absolute sample offset tracking.
        Handles duplicates, overlaps, audio gaps, and backpressure queue bounds.
        """
        if not self.is_active or not pcm_bytes:
            return False

        if channel_id not in self.channels:
            logger.warning("Call '%s' received frame on unknown channel %d", self.call_id, channel_id)
            return False

        if len(pcm_bytes) % 2 != 0:
            logger.warning("Call '%s' received unaligned PCM16 frame on channel %d", self.call_id, channel_id)
            return False

        ch = self.channels[channel_id]
        num_samples = len(pcm_bytes) // 2

        # Check sample offset alignment, gaps and duplicates
        if ch.next_expected_sample > 0:
            if offset < ch.next_expected_sample:
                overlap = ch.next_expected_sample - offset
                if overlap >= num_samples:
                    ch.total_duplicate_frames += 1
                    return True
                # Partial overlap: trim redundant leading samples
                pcm_bytes = pcm_bytes[overlap * 2 :]
                num_samples = len(pcm_bytes) // 2
                offset = ch.next_expected_sample
            elif offset > ch.next_expected_sample:
                gap = offset - ch.next_expected_sample
                ch.total_gap_samples += gap
                logger.debug(
                    "Call '%s' channel %d detected audio gap of %d samples (%.3fs)",
                    self.call_id,
                    channel_id,
                    gap,
                    gap / 16000.0,
                )

        ch.next_expected_sample = offset + num_samples
        ch.total_packets_received += 1
        ch.last_packet_time = time.time()
        self.last_active_time = time.time()

        if ch.queue.full():
            try:
                ch.queue.get_nowait()
                ch.total_packets_dropped += 1
                if ch.total_packets_dropped == 1 or ch.total_packets_dropped % 25 == 0:
                    logger.warning(
                        "Audio queue full for call '%s' channel %d; dropped %d oldest packets (backpressure)",
                        self.call_id,
                        channel_id,
                        ch.total_packets_dropped,
                    )
            except Exception:
                pass

        try:
            ch.queue.put_nowait(pcm_bytes)
            return True
        except asyncio.QueueFull:
            return False

    async def _channel_consumer_loop(self, ch: ChannelState) -> None:
        """
        Continuously pulls PCM packets for channel `ch`, evaluates speech pause thresholds,
        and transcribes slices without blocking audio ingestion.
        """
        logger.info(
            "Started continuous audio consumer worker for call '%s' ch %d (%s)",
            self.call_id,
            ch.channel_id,
            ch.speaker,
        )
        while self.is_active:
            try:
                try:
                    packet = await asyncio.wait_for(ch.queue.get(), timeout=0.3)
                    ch.pcm_buffer.extend(packet)
                    ch.queue.task_done()
                except asyncio.TimeoutError:
                    packet = None

                now = time.time()
                buf_len = len(ch.pcm_buffer)

                should_process = (
                    buf_len >= IDEAL_BUFFER_BYTES
                    or (buf_len >= MIN_BUFFER_BYTES and (now - ch.last_packet_time) >= PAUSE_FLUSH_SECONDS)
                    or buf_len >= MAX_BUFFER_BYTES
                )

                if should_process and buf_len > 0:
                    chunk = bytes(ch.pcm_buffer)
                    ch.pcm_buffer.clear()
                    await self._transcribe_and_evaluate_slice(ch, chunk, is_final=False)

            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.error(
                    "Error in audio consumer worker for call '%s' ch %d: %s",
                    self.call_id,
                    ch.channel_id,
                    exc,
                )
                await asyncio.sleep(0.05)

    async def _transcribe_and_evaluate_slice(
        self, ch: ChannelState, pcm_chunk: bytes, is_final: bool = False
    ) -> None:
        """Converts chunk to WAV, transcribes via Sarvam, emits 7-8 word captions, and evaluates scam risk."""
        if len(pcm_chunk) < 3200:  # Skip trivial clicks under 100ms
            return

        ch.slice_counter += 1
        wav_bytes = pcm16_to_wav_bytes(pcm_chunk, sample_rate=16000)
        slice_name = f"{self.call_id}_ch{ch.channel_id}_slice_{ch.slice_counter:04d}.wav"

        try:
            # Run blocking STT call in a thread pool to NEVER block the async loop
            stt_res = await asyncio.to_thread(
                self.stt_provider.transcribe_bytes,
                wav_bytes,
                slice_name,
                self.language_code,
            )

            text = (stt_res.transcript or "").strip()
            if not text:
                return

            # Progressive caption chunking targeting ~7-8 words
            word_chunks = split_text_into_word_chunks(text, target_size=TARGET_WORDS_PER_CHUNK)

            # Evaluate through conversation manager (Rules + Contextual + RiskScorer)
            seg_req = CallSegmentRequest(
                text=text,
                speaker=ch.speaker,
                language_code=stt_res.language_code or self.language_code,
                start_seconds=0.0,
                end_seconds=stt_res.duration_seconds,
                transcript_confidence=stt_res.confidence,
            )

            seg_res = self.conversation_manager.process_segment(self.call_id, seg_req)
            call_assessment = seg_res.assessment
            # Captions carry the risk of what was just said, so harmless words after a scam line
            # aren't flagged; the whole call's risk travels alongside as callRisk*.
            assessment = seg_res.moment_assessment or call_assessment

            # Extract retrieval similarity if RAG was run
            retrieval_sim = None
            if assessment.rag_analysis and isinstance(assessment.rag_analysis, dict):
                retrieval_sim = assessment.rag_analysis.get("retrieval_similarity")

            # Emit progressive caption chunks
            for idx, w_chunk in enumerate(word_chunks):
                self.total_words_emitted += len(w_chunk.split())
                is_last_in_slice = idx == len(word_chunks) - 1

                event_payload = {
                    "type": "caption_chunk",
                    "callId": self.call_id,
                    "channel": ch.channel_id,
                    "speaker": ch.speaker,
                    "text": w_chunk,
                    "fullTranscript": text,
                    "wordCount": len(w_chunk.split()),
                    "isPartial": not is_last_in_slice and not is_final,
                    "isFinal": is_final and is_last_in_slice,
                    "language": stt_res.language_code,
                    "riskScore": assessment.risk_score,
                    "riskLevel": assessment.risk_level,
                    "confidence": assessment.confidence,
                    "transcriptConfidence": stt_res.confidence,
                    "retrievalSimilarity": retrieval_sim,
                    "flaggedKeywords": [
                        i.keyword_or_pattern for i in assessment.rule_analysis.triggered_indicators
                    ],
                    "flaggedCategories": [
                        i.category for i in assessment.rule_analysis.triggered_indicators
                    ],
                    "callRiskScore": call_assessment.risk_score,
                    "callRiskLevel": call_assessment.risk_level,
                    "recommendedAction": assessment.recommended_action,
                    "source": self.source,
                    "timestamp": round(time.time(), 3),
                }

                # Send to direct callback if provided
                if self.on_event_callback:
                    try:
                        res = self.on_event_callback(event_payload)
                        if asyncio.iscoroutine(res):
                            await res
                    except Exception as cb_err:
                        logger.warning("Error in on_event_callback: %s", cb_err)

                # Broadcast to connected dashboard sessions
                await self.broadcaster.broadcast(event_payload)

            # Check if Telegram alert should be triggered
            if (
                assessment.risk_level in ("HIGH", "CRITICAL")
                and self.telegram_service.is_enabled
            ):
                alert_res = self.telegram_service.send_risk_alert(assessment, self.call_id)
                if alert_res.delivered:
                    alert_event = {
                        "type": "telegram_alert_sent",
                        "callId": self.call_id,
                        "channel": ch.channel_id,
                        "speaker": ch.speaker,
                        "messageId": alert_res.message_id,
                        "riskLevel": assessment.risk_level,
                        "riskScore": assessment.risk_score,
                    }
                    await self.broadcaster.broadcast(alert_event)

        except Exception as exc:
            logger.warning(
                "Transcription/evaluation error on call '%s' ch %d slice %d: %s",
                self.call_id,
                ch.channel_id,
                ch.slice_counter,
                exc,
            )

    async def stop_and_flush(self) -> Dict[str, Any]:
        """Stops the audio session, flushes remaining buffer across all channels, and releases resources."""
        self.is_active = False

        for ch in self.channels.values():
            if ch.worker_task and not ch.worker_task.done():
                ch.worker_task.cancel()
                try:
                    await ch.worker_task
                except asyncio.CancelledError:
                    pass

        # Flush any remaining un-processed audio across all channels
        for ch in self.channels.values():
            if len(ch.pcm_buffer) >= 3200:
                remaining = bytes(ch.pcm_buffer)
                ch.pcm_buffer.clear()
                await self._transcribe_and_evaluate_slice(ch, remaining, is_final=True)

        channel_stats = {
            f"ch_{cid}": {
                "speaker": ch.speaker,
                "totalPackets": ch.total_packets_received,
                "droppedPackets": ch.total_packets_dropped,
                "gapSamples": ch.total_gap_samples,
                "duplicateFrames": ch.total_duplicate_frames,
            }
            for cid, ch in self.channels.items()
        }

        close_event = {
            "type": "call_ended",
            "callId": self.call_id,
            "totalWords": self.total_words_emitted,
            "totalPackets": self.total_packets_received,
            "droppedPackets": self.total_packets_dropped,
            "channels": channel_stats,
        }
        await self.broadcaster.broadcast(close_event)
        logger.info(
            "Call '%s' audio session ended. Processed %d words across %d packets.",
            self.call_id,
            self.total_words_emitted,
            self.total_packets_received,
        )
        return close_event
