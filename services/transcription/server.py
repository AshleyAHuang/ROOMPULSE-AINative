from __future__ import annotations

import asyncio
import json
import math
import os
import time
from dataclasses import dataclass, field

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

try:
    from faster_whisper import WhisperModel
except Exception as exc:  # pragma: no cover - exercised by /health in bad envs
    WhisperModel = None  # type: ignore[assignment]
    WHISPER_IMPORT_ERROR = exc
else:
    WHISPER_IMPORT_ERROR = None


SAMPLE_RATE = 16_000
BYTES_PER_SAMPLE = 2
DEFAULT_MODEL = "base.en"
DEFAULT_DEVICE = "cpu"
DEFAULT_COMPUTE_TYPE = "int8"
DEFAULT_LANGUAGE = "en"


app = FastAPI(title="RoomPulse Local Transcription")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

model_lock = asyncio.Lock()
model: WhisperModel | None = None
model_error: str | None = None


@app.get("/health")
async def health() -> JSONResponse:
    return JSONResponse(
        {
            "ok": WHISPER_IMPORT_ERROR is None,
            "engine": "faster-whisper",
            "model": os.getenv("ROOMPULSE_WHISPER_MODEL", DEFAULT_MODEL),
            "device": os.getenv("ROOMPULSE_WHISPER_DEVICE", DEFAULT_DEVICE),
            "computeType": os.getenv(
                "ROOMPULSE_WHISPER_COMPUTE_TYPE", DEFAULT_COMPUTE_TYPE
            ),
            "sampleRate": SAMPLE_RATE,
            "importError": str(WHISPER_IMPORT_ERROR) if WHISPER_IMPORT_ERROR else None,
            "modelError": model_error,
        }
    )


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    await websocket.accept()
    session = TranscriptionSession(websocket)
    processor = asyncio.create_task(session.process_loop())

    try:
        await session.send_status("connected", "Local audio stream connected")
        await ensure_model_loaded()
        await session.send_status("ready", "Local Whisper model is ready")

        while True:
            try:
                message = await websocket.receive()
            except RuntimeError as exc:
                if "disconnect" in str(exc).lower():
                    break
                raise
            if message.get("type") == "websocket.disconnect":
                break
            if "bytes" in message and message["bytes"] is not None:
                session.append_audio(message["bytes"])
            elif "text" in message and message["text"] is not None:
                await session.handle_control(message["text"])
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        try:
            await session.send_error(str(exc))
        except RuntimeError:
            pass
    finally:
        session.closed = True
        processor.cancel()
        try:
            await processor
        except asyncio.CancelledError:
            pass


async def ensure_model_loaded() -> WhisperModel:
    global model, model_error

    if WHISPER_IMPORT_ERROR is not None or WhisperModel is None:
        raise RuntimeError(f"faster-whisper is unavailable: {WHISPER_IMPORT_ERROR}")

    if model is not None:
        return model

    async with model_lock:
        if model is not None:
            return model

        try:
            model_name = os.getenv("ROOMPULSE_WHISPER_MODEL", DEFAULT_MODEL)
            device = os.getenv("ROOMPULSE_WHISPER_DEVICE", DEFAULT_DEVICE)
            compute_type = os.getenv(
                "ROOMPULSE_WHISPER_COMPUTE_TYPE", DEFAULT_COMPUTE_TYPE
            )
            model = await asyncio.to_thread(
                WhisperModel,
                model_name,
                device=device,
                compute_type=compute_type,
            )
            model_error = None
            return model
        except Exception as exc:
            model_error = str(exc)
            raise


@dataclass
class SpeakerCluster:
    id: str
    label: str
    centroid: np.ndarray
    samples: int = 1
    last_seen_at: float = field(default_factory=time.time)


class SpeakerClusterer:
    def __init__(self, threshold: float = 0.33) -> None:
        self.threshold = threshold
        self.clusters: list[SpeakerCluster] = []

    def assign(self, audio: np.ndarray) -> SpeakerCluster:
        embedding = build_voice_embedding(audio)
        best: tuple[float, SpeakerCluster] | None = None

        for cluster in self.clusters:
            distance = cosine_distance(cluster.centroid, embedding)
            if best is None or distance < best[0]:
                best = (distance, cluster)

        if best is None or best[0] > self.threshold:
            cluster = SpeakerCluster(
                id=f"speaker-{len(self.clusters) + 1}",
                label=f"Speaker {len(self.clusters) + 1}",
                centroid=embedding,
            )
            self.clusters.append(cluster)
            return cluster

        cluster = best[1]
        cluster.centroid = (
            cluster.centroid * cluster.samples + embedding
        ) / float(cluster.samples + 1)
        cluster.samples += 1
        cluster.last_seen_at = time.time()
        return cluster

    def labels(self) -> list[str]:
        return [cluster.label for cluster in self.clusters]


class TranscriptionSession:
    def __init__(self, websocket: WebSocket) -> None:
        self.websocket = websocket
        self.buffer = bytearray()
        self.buffer_lock = asyncio.Lock()
        self.closed = False
        self.clusterer = SpeakerClusterer()
        self.sequence = 0
        self.min_seconds = float(
            os.getenv("ROOMPULSE_TRANSCRIPTION_MIN_SECONDS", "2.0")
        )
        self.max_seconds = float(
            os.getenv("ROOMPULSE_TRANSCRIPTION_MAX_SECONDS", "4.0")
        )
        self.language = os.getenv("ROOMPULSE_WHISPER_LANGUAGE", DEFAULT_LANGUAGE)

    async def handle_control(self, raw: str) -> None:
        try:
            message = json.loads(raw)
        except json.JSONDecodeError:
            await self.send_error("Invalid control message")
            return

        if message.get("type") == "reset":
            async with self.buffer_lock:
                self.buffer.clear()
            self.clusterer = SpeakerClusterer()
            self.sequence = 0
            await self.send_status("reset", "Transcription session reset")
        elif message.get("type") == "flush":
            await self.flush(force=True)

    def append_audio(self, chunk: bytes) -> None:
        self.buffer.extend(chunk)

    async def process_loop(self) -> None:
        while not self.closed:
            await asyncio.sleep(0.5)
            await self.flush(force=False)

    async def flush(self, force: bool) -> None:
        min_bytes = seconds_to_bytes(self.min_seconds)
        max_bytes = seconds_to_bytes(self.max_seconds)

        async with self.buffer_lock:
            if len(self.buffer) < min_bytes and not force:
                return
            if not self.buffer:
                return
            take = min(len(self.buffer), max_bytes)
            if take < min_bytes and not force:
                return
            raw = bytes(self.buffer[:take])
            del self.buffer[:take]

        audio = pcm16_to_float32(raw)
        if not has_speech(audio):
            return

        await self.send_status("transcribing", "Transcribing speech segment")
        local_model = await ensure_model_loaded()
        text = await transcribe_audio(local_model, audio, self.language)
        if not text:
            return

        self.sequence += 1
        speaker = self.clusterer.assign(audio)
        duration_ms = round((len(audio) / SAMPLE_RATE) * 1000)
        await self.websocket.send_json(
            {
                "type": "final_transcript",
                "id": f"local-{int(time.time() * 1000)}-{self.sequence}",
                "speakerId": speaker.id,
                "speakerLabel": speaker.label,
                "text": text,
                "confidence": 0.9,
                "durationMs": duration_ms,
                "observedSpeakerLabels": self.clusterer.labels(),
            }
        )
        await self.send_status("listening", "Listening")

    async def send_status(self, status: str, message: str) -> None:
        await self.websocket.send_json(
            {
                "type": "engine_status",
                "status": status,
                "message": message,
                "observedSpeakerLabels": self.clusterer.labels(),
            }
        )

    async def send_error(self, message: str) -> None:
        await self.websocket.send_json({"type": "engine_error", "message": message})


async def transcribe_audio(
    local_model: WhisperModel, audio: np.ndarray, language: str
) -> str:
    def run() -> str:
        segments, _info = local_model.transcribe(
            audio,
            language=language,
            beam_size=1,
            best_of=1,
            temperature=0,
            vad_filter=False,
            condition_on_previous_text=False,
            no_speech_threshold=0.45,
        )
        return " ".join(segment.text.strip() for segment in segments).strip()

    return await asyncio.to_thread(run)


def seconds_to_bytes(seconds: float) -> int:
    return int(seconds * SAMPLE_RATE * BYTES_PER_SAMPLE)


def pcm16_to_float32(raw: bytes) -> np.ndarray:
    if len(raw) % BYTES_PER_SAMPLE == 1:
        raw = raw[:-1]
    data = np.frombuffer(raw, dtype=np.int16).astype(np.float32)
    return data / 32768.0


def has_speech(audio: np.ndarray) -> bool:
    if audio.size == 0:
        return False
    rms = float(np.sqrt(np.mean(np.square(audio))))
    peak = float(np.max(np.abs(audio)))
    return rms > 0.012 and peak > 0.04


def build_voice_embedding(audio: np.ndarray) -> np.ndarray:
    if audio.size < 256:
        return np.zeros(20, dtype=np.float32)

    windowed = audio * np.hanning(audio.size)
    spectrum = np.abs(np.fft.rfft(windowed))
    freqs = np.fft.rfftfreq(audio.size, 1.0 / SAMPLE_RATE)
    magnitude_sum = float(np.sum(spectrum)) or 1.0
    centroid = float(np.sum(freqs * spectrum) / magnitude_sum) / 4_000.0
    bandwidth = (
        float(np.sqrt(np.sum(((freqs - centroid * 4_000.0) ** 2) * spectrum) / magnitude_sum))
        / 4_000.0
    )
    rolloff_index = min(
        len(freqs) - 1,
        int(np.searchsorted(np.cumsum(spectrum), magnitude_sum * 0.85)),
    )
    rolloff = float(freqs[rolloff_index]) / 8_000.0
    zcr = zero_crossing_rate(audio)
    rms = float(np.sqrt(np.mean(np.square(audio))))
    pitch = estimate_pitch(audio) / 320.0
    bands = log_frequency_bands(spectrum, freqs, count=14)
    embedding = np.array(
        [centroid, bandwidth, rolloff, zcr, rms, pitch, *bands],
        dtype=np.float32,
    )
    norm = float(np.linalg.norm(embedding))
    return embedding / norm if norm > 0 else embedding


def log_frequency_bands(
    spectrum: np.ndarray, freqs: np.ndarray, count: int
) -> list[float]:
    edges = np.geomspace(80, 8_000, count + 1)
    values: list[float] = []
    total = float(np.sum(spectrum)) or 1.0
    for left, right in zip(edges[:-1], edges[1:]):
        mask = (freqs >= left) & (freqs < right)
        values.append(float(np.sum(spectrum[mask]) / total))
    return values


def zero_crossing_rate(audio: np.ndarray) -> float:
    if audio.size < 2:
        return 0.0
    signs = np.signbit(audio)
    return float(np.mean(signs[1:] != signs[:-1]))


def estimate_pitch(audio: np.ndarray) -> float:
    clipped = audio[: min(audio.size, SAMPLE_RATE)]
    if clipped.size < 512:
        return 0.0
    clipped = clipped - float(np.mean(clipped))
    corr = np.correlate(clipped, clipped, mode="full")[clipped.size - 1 :]
    min_lag = int(SAMPLE_RATE / 320)
    max_lag = int(SAMPLE_RATE / 70)
    if corr.size <= max_lag:
        return 0.0
    lag = int(np.argmax(corr[min_lag:max_lag]) + min_lag)
    if lag <= 0 or math.isclose(float(corr[lag]), 0.0):
        return 0.0
    return float(SAMPLE_RATE / lag)


def cosine_distance(left: np.ndarray, right: np.ndarray) -> float:
    denominator = float(np.linalg.norm(left) * np.linalg.norm(right))
    if denominator == 0:
        return 1.0
    similarity = float(np.dot(left, right) / denominator)
    return 1.0 - max(-1.0, min(1.0, similarity))
