from __future__ import annotations

import asyncio
import collections
import json
import math
import os
import re
import threading
import time
import wave
from dataclasses import dataclass, field
from tempfile import NamedTemporaryFile
from typing import Protocol

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
DEFAULT_MODEL = "small.en"
DEFAULT_DEVICE = "cpu"
DEFAULT_COMPUTE_TYPE = "int8"
DEFAULT_LANGUAGE = "en"
DEFAULT_DSP_SPEAKER_DISTANCE_THRESHOLD = 0.14
DEFAULT_NEURAL_SPEAKER_DISTANCE_THRESHOLDS = {
    "pyannote-embedding": 0.32,
    "speechbrain-ecapa": 0.28,
    "resemblyzer": 0.30,
    "nemo-titanet": 0.30,
    "wespeaker": 0.28,
}
DEFAULT_NEURAL_SPEAKER_DISTANCE_THRESHOLD = 0.30
DEFAULT_SPEAKER_MIN_QUALITY = 0.18
DEFAULT_SPEAKER_MAX_CLUSTERS = 12
DEFAULT_SPEAKER_HARD_CLUSTER_LIMIT = 24
DEFAULT_SPEAKER_BACKEND_FAILURE_LIMIT = 1
DEFAULT_SPEAKER_EMBEDDING_BACKEND = "auto"
DEFAULT_CLUSTER_EXEMPLAR_LIMIT = 6
DEFAULT_PENDING_SPEAKER_EXEMPLAR_LIMIT = 8
DEFAULT_PENDING_SPEAKER_PROMOTION_SAMPLES = 2
DEFAULT_PENDING_SPEAKER_TTL_SECONDS = 45.0
DEFAULT_BEAM_SIZE = 5
DEFAULT_BEST_OF = 5
DEFAULT_NO_SPEECH_THRESHOLD = 0.55
DEFAULT_VAD_MODE = 2
SPEECHBRAIN_MODEL = "speechbrain/spkrec-ecapa-voxceleb"
PYANNOTE_MODEL = "pyannote/embedding"
NEMO_MODEL = "nvidia/speakerverification_en_titanet_large"
WESPEAKER_MODEL = "english"
REPEATED_NOISE_PHRASES = {
    "i am sorry",
    "i'm sorry",
    "sorry",
    "thank you",
    "thanks",
    "okay",
    "ok",
}

try:
    import webrtcvad
except Exception:  # pragma: no cover - optional production dependency
    webrtcvad = None


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
            "speakerEmbeddingBackend": os.getenv(
                "ROOMPULSE_SPEAKER_EMBEDDING_BACKEND",
                DEFAULT_SPEAKER_EMBEDDING_BACKEND,
            ),
            "speakerEmbeddingActiveBackend": active_voice_embedder_name(),
            "speakerMaxClusters": speaker_max_clusters(),
            "speakerClusterExemplarLimit": DEFAULT_CLUSTER_EXEMPLAR_LIMIT,
            "speakerPendingPromotionSamples": pending_speaker_promotion_samples(),
            "voiceActivityDetector": (
                "webrtcvad"
                if webrtcvad is not None and os.getenv("ROOMPULSE_WEBRTC_VAD", "1") != "0"
                else "energy"
            ),
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
                await session.append_audio(message["bytes"])
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
    backend: str
    centroid: np.ndarray
    samples: int = 1
    quality_sum: float = 1.0
    exemplars: list[np.ndarray] = field(default_factory=list)
    last_seen_at: float = field(default_factory=time.time)


@dataclass
class PendingSpeakerCandidate:
    backend: str
    centroid: np.ndarray
    samples: int = 1
    quality_sum: float = 0.0
    first_seen_at: float = field(default_factory=time.time)
    last_seen_at: float = field(default_factory=time.time)


@dataclass(frozen=True)
class VoiceEmbedding:
    backend: str
    vector: np.ndarray
    quality: float = 1.0


class VoiceEmbedder(Protocol):
    name: str

    def embed(self, audio: np.ndarray) -> VoiceEmbedding:
        ...


class DspVoiceEmbedder:
    name = "dsp"

    def embed(self, audio: np.ndarray) -> VoiceEmbedding:
        return VoiceEmbedding(
            self.name,
            build_dsp_voice_embedding(audio),
            voice_embedding_quality(audio),
        )


class SpeechBrainVoiceEmbedder:
    name = "speechbrain-ecapa"

    def __init__(self) -> None:
        self._classifier = None
        self._torch = None
        self._lock = threading.Lock()

    def embed(self, audio: np.ndarray) -> VoiceEmbedding:
        with self._lock:
            classifier, torch = self._load()
            signal = torch.from_numpy(audio.astype(np.float32)).unsqueeze(0)
            with torch.no_grad():
                embedding = classifier.encode_batch(signal)
            vector = embedding_to_numpy(embedding)
        return VoiceEmbedding(
            self.name,
            normalize_vector(vector),
            voice_embedding_quality(audio),
        )

    def _load(self):
        if self._classifier is not None and self._torch is not None:
            return self._classifier, self._torch

        try:
            from speechbrain.inference.speaker import EncoderClassifier
        except ImportError:
            from speechbrain.pretrained import EncoderClassifier  # type: ignore

        import torch

        model_name = os.getenv("ROOMPULSE_SPEECHBRAIN_MODEL", SPEECHBRAIN_MODEL)
        savedir = os.getenv(
            "ROOMPULSE_SPEECHBRAIN_SAVEDIR",
            os.path.join(
                os.path.expanduser("~"),
                ".cache",
                "roompulse",
                "speechbrain-ecapa",
            ),
        )
        run_opts: dict[str, str] = {}
        if os.getenv("ROOMPULSE_SPEECHBRAIN_DEVICE"):
            run_opts["device"] = os.environ["ROOMPULSE_SPEECHBRAIN_DEVICE"]
        self._classifier = EncoderClassifier.from_hparams(
            source=model_name,
            savedir=savedir,
            run_opts=run_opts,
        )
        self._torch = torch
        return self._classifier, self._torch


class PyannoteVoiceEmbedder:
    name = "pyannote-embedding"

    def __init__(self) -> None:
        self._inference = None
        self._torch = None
        self._lock = threading.Lock()

    def embed(self, audio: np.ndarray) -> VoiceEmbedding:
        with self._lock:
            inference, torch = self._load()
            waveform = torch.from_numpy(audio.astype(np.float32)).unsqueeze(0)
            try:
                embedding = inference({"waveform": waveform, "sample_rate": SAMPLE_RATE})
            except Exception:
                path = write_temp_wav(audio)
                try:
                    embedding = inference(path)
                finally:
                    try:
                        os.unlink(path)
                    except OSError:
                        pass
            vector = embedding_to_numpy(embedding)
        return VoiceEmbedding(
            self.name,
            normalize_vector(vector),
            voice_embedding_quality(audio),
        )

    def _load(self):
        if self._inference is not None and self._torch is not None:
            return self._inference, self._torch

        from pyannote.audio import Inference, Model
        import torch

        model_name = os.getenv("ROOMPULSE_PYANNOTE_MODEL", PYANNOTE_MODEL)
        token = (
            os.getenv("ROOMPULSE_PYANNOTE_AUTH_TOKEN")
            or os.getenv("HF_TOKEN")
            or os.getenv("HUGGINGFACE_TOKEN")
        )
        try:
            model = Model.from_pretrained(model_name, token=token)
        except TypeError:
            model = Model.from_pretrained(model_name, use_auth_token=token)
        device = os.getenv("ROOMPULSE_PYANNOTE_DEVICE")
        if device:
            model.to(torch.device(device))
        window = os.getenv("ROOMPULSE_PYANNOTE_WINDOW", "whole")
        self._inference = Inference(model, window=window)
        self._torch = torch
        return self._inference, self._torch


class ResemblyzerVoiceEmbedder:
    name = "resemblyzer"

    def __init__(self) -> None:
        self._encoder = None
        self._preprocess_wav = None
        self._lock = threading.Lock()

    def embed(self, audio: np.ndarray) -> VoiceEmbedding:
        with self._lock:
            encoder, preprocess_wav = self._load()
            wav = preprocess_wav(audio.astype(np.float32), source_sr=SAMPLE_RATE)
            vector = encoder.embed_utterance(wav).astype(np.float32)
        return VoiceEmbedding(
            self.name,
            normalize_vector(vector),
            voice_embedding_quality(audio),
        )

    def _load(self):
        if self._encoder is not None and self._preprocess_wav is not None:
            return self._encoder, self._preprocess_wav

        from resemblyzer import VoiceEncoder, preprocess_wav

        self._encoder = VoiceEncoder()
        self._preprocess_wav = preprocess_wav
        return self._encoder, self._preprocess_wav


class NemoVoiceEmbedder:
    name = "nemo-titanet"

    def __init__(self) -> None:
        self._model = None
        self._torch = None
        self._lock = threading.Lock()

    def embed(self, audio: np.ndarray) -> VoiceEmbedding:
        with self._lock:
            model, torch = self._load()
            path = write_temp_wav(audio)
            try:
                with torch.no_grad():
                    embedding = model.get_embedding(path)
            finally:
                try:
                    os.unlink(path)
                except OSError:
                    pass
            vector = embedding_to_numpy(embedding)
        return VoiceEmbedding(
            self.name,
            normalize_vector(vector),
            voice_embedding_quality(audio),
        )

    def _load(self):
        if self._model is not None and self._torch is not None:
            return self._model, self._torch

        from nemo.collections.asr.models import EncDecSpeakerLabelModel
        import torch

        model_name = os.getenv("ROOMPULSE_NEMO_MODEL", NEMO_MODEL)
        self._model = EncDecSpeakerLabelModel.from_pretrained(model_name)
        device = os.getenv("ROOMPULSE_NEMO_DEVICE")
        if device and hasattr(self._model, "to"):
            self._model = self._model.to(torch.device(device))
        if hasattr(self._model, "eval"):
            self._model.eval()
        self._torch = torch
        return self._model, self._torch


class WeSpeakerVoiceEmbedder:
    name = "wespeaker"

    def __init__(self) -> None:
        self._model = None
        self._lock = threading.Lock()

    def embed(self, audio: np.ndarray) -> VoiceEmbedding:
        with self._lock:
            model = self._load()
            path = write_temp_wav(audio)
            try:
                embedding = model.extract_embedding(path)
            finally:
                try:
                    os.unlink(path)
                except OSError:
                    pass
            vector = embedding_to_numpy(embedding)
        return VoiceEmbedding(
            self.name,
            normalize_vector(vector),
            voice_embedding_quality(audio),
        )

    def _load(self):
        if self._model is not None:
            return self._model

        import wespeaker

        model_path = os.getenv("ROOMPULSE_WESPEAKER_MODEL_DIR")
        if model_path:
            self._model = wespeaker.load_model_local(model_path)
        else:
            model_name = os.getenv("ROOMPULSE_WESPEAKER_MODEL", WESPEAKER_MODEL)
            self._model = wespeaker.load_model(model_name)

        if hasattr(self._model, "set_gpu"):
            self._model.set_gpu(wespeaker_gpu_index())
        return self._model


class FallbackVoiceEmbedder:
    def __init__(
        self,
        primary: VoiceEmbedder,
        fallback: VoiceEmbedder | None = None,
        failure_limit: int | None = None,
    ) -> None:
        self.primary = primary
        self.fallback = fallback or DspVoiceEmbedder()
        self.name = f"{primary.name}+{self.fallback.name}-fallback"
        self.failure_limit = max(1, failure_limit or speaker_backend_failure_limit())
        self.primary_failures = 0
        self.primary_disabled = False

    def embed(self, audio: np.ndarray) -> VoiceEmbedding:
        if self.primary_disabled:
            return sanitize_voice_embedding(self.fallback.embed(audio))

        try:
            return sanitize_voice_embedding(self.primary.embed(audio))
        except Exception:
            self.primary_failures += 1
            if self.primary_failures >= self.failure_limit:
                self.primary_disabled = True
                self.name = f"{self.fallback.name}-fallback"
            return sanitize_voice_embedding(self.fallback.embed(audio))

    def active_backend_name(self) -> str:
        return self.fallback.name if self.primary_disabled else self.primary.name


class AutoVoiceEmbedder:
    name = "auto"

    def __init__(self) -> None:
        self._resolved: VoiceEmbedder | None = None
        self._lock = threading.Lock()

    def embed(self, audio: np.ndarray) -> VoiceEmbedding:
        with self._lock:
            if self._resolved is not None:
                embedder = self._resolved
            else:
                candidates: list[VoiceEmbedder] = []
                if has_pyannote_token():
                    candidates.append(PyannoteVoiceEmbedder())
                candidates.append(SpeechBrainVoiceEmbedder())
                if os.getenv("ROOMPULSE_NEMO_AUTO", "0") == "1":
                    candidates.append(NemoVoiceEmbedder())
                if os.getenv("ROOMPULSE_WESPEAKER_AUTO", "0") == "1":
                    candidates.append(WeSpeakerVoiceEmbedder())
                candidates.append(ResemblyzerVoiceEmbedder())
                for candidate in candidates:
                    try:
                        embedding = sanitize_voice_embedding(candidate.embed(audio))
                        self._resolved = candidate
                        return embedding
                    except Exception:
                        continue

                self._resolved = DspVoiceEmbedder()
                return sanitize_voice_embedding(self._resolved.embed(audio))

        try:
            return sanitize_voice_embedding(embedder.embed(audio))
        except Exception:
            with self._lock:
                self._resolved = DspVoiceEmbedder()
                return sanitize_voice_embedding(self._resolved.embed(audio))


voice_embedder_lock = threading.Lock()
voice_embedder: VoiceEmbedder | None = None


def get_voice_embedder() -> VoiceEmbedder:
    global voice_embedder
    if voice_embedder is not None:
        return voice_embedder

    with voice_embedder_lock:
        if voice_embedder is not None:
            return voice_embedder

        backend = normalize_speaker_backend(
            os.getenv(
                "ROOMPULSE_SPEAKER_EMBEDDING_BACKEND",
                DEFAULT_SPEAKER_EMBEDDING_BACKEND,
            )
        )
        if backend == "pyannote":
            voice_embedder = FallbackVoiceEmbedder(PyannoteVoiceEmbedder())
        elif backend == "speechbrain":
            voice_embedder = FallbackVoiceEmbedder(SpeechBrainVoiceEmbedder())
        elif backend == "resemblyzer":
            voice_embedder = FallbackVoiceEmbedder(ResemblyzerVoiceEmbedder())
        elif backend == "nemo":
            voice_embedder = FallbackVoiceEmbedder(NemoVoiceEmbedder())
        elif backend == "wespeaker":
            voice_embedder = FallbackVoiceEmbedder(WeSpeakerVoiceEmbedder())
        elif backend == "dsp":
            voice_embedder = DspVoiceEmbedder()
        else:
            voice_embedder = AutoVoiceEmbedder()
        return voice_embedder


def active_voice_embedder_name() -> str:
    embedder = voice_embedder
    if isinstance(embedder, AutoVoiceEmbedder) and embedder._resolved is not None:
        return embedder._resolved.name
    if isinstance(embedder, FallbackVoiceEmbedder):
        return embedder.active_backend_name()
    return embedder.name if embedder is not None else "not-loaded"


def normalize_speaker_backend(raw: str | None) -> str:
    backend = (raw or DEFAULT_SPEAKER_EMBEDDING_BACKEND).strip().lower()
    aliases = {
        "pyannote-embedding": "pyannote",
        "pyannote_audio": "pyannote",
        "pyannote.audio": "pyannote",
        "speechbrain-ecapa": "speechbrain",
        "speechbrain_ecapa": "speechbrain",
        "ecapa": "speechbrain",
        "ecapa-tdnn": "speechbrain",
        "voiceencoder": "resemblyzer",
        "voice-encoder": "resemblyzer",
        "nemo-titanet": "nemo",
        "titanet": "nemo",
        "nvidia-titanet": "nemo",
        "we-speaker": "wespeaker",
        "wespeaker-english": "wespeaker",
        "wespeaker-voxceleb": "wespeaker",
        "local": "dsp",
        "features": "dsp",
    }
    return aliases.get(backend, backend)


def has_pyannote_token() -> bool:
    return bool(
        os.getenv("ROOMPULSE_PYANNOTE_AUTH_TOKEN")
        or os.getenv("HF_TOKEN")
        or os.getenv("HUGGINGFACE_TOKEN")
    )


class SpeakerClusterer:
    def __init__(
        self,
        threshold: float | None = None,
        embedder: VoiceEmbedder | None = None,
        max_clusters: int | None = None,
        speaker_label_offset: int = 0,
    ) -> None:
        self.threshold = threshold
        self.embedder = embedder or get_voice_embedder()
        self.max_clusters = parse_speaker_cluster_cap(
            max_clusters,
            speaker_max_clusters(),
        )
        self.speaker_label_offset = parse_speaker_label_offset(speaker_label_offset)
        self.clusters: list[SpeakerCluster] = []
        self.pending_candidates: list[PendingSpeakerCandidate] = []

    async def assign(self, audio: np.ndarray) -> SpeakerCluster:
        speech_audio = trim_silence(audio)
        embedding = await asyncio.to_thread(self.embedder.embed, speech_audio)
        threshold = self.distance_threshold(embedding.backend)
        min_quality = speaker_min_quality()
        self.prune_pending_candidates()
        best: tuple[float, SpeakerCluster] | None = None
        second_best_distance: float | None = None

        for cluster in self.clusters:
            if cluster.backend != embedding.backend:
                continue
            distance = cluster_voice_distance(cluster, embedding.vector)
            if best is None or distance < best[0]:
                second_best_distance = best[0] if best is not None else None
                best = (distance, cluster)
            elif second_best_distance is None or distance < second_best_distance:
                second_best_distance = distance

        should_create_cluster = best is None or (
            best[0] > threshold and embedding.quality >= min_quality
        )
        if should_create_cluster:
            if len(self.clusters) >= self.max_clusters:
                return self.assign_to_existing_cluster(best, embedding)
            return self.create_cluster(embedding, min_quality)

        if (
            best is not None
            and best[0] > threshold
            and embedding.quality >= min_quality * 0.35
            and len(self.clusters) < self.max_clusters
        ):
            promoted = self.update_pending_candidate(embedding, threshold, min_quality)
            if promoted is not None:
                return promoted

        cluster = best[1]
        is_ambiguous = (
            second_best_distance is not None
            and abs(second_best_distance - best[0]) < threshold * 0.18
        )
        # Adapt only on confident matches. Updating centroids on borderline or
        # mixed-room audio is what makes future voices collapse into Speaker 1.
        if (
            embedding.quality >= min_quality
            and best[0] < threshold * 0.72
            and not is_ambiguous
        ):
            update_weight = min(
                0.18,
                max(0.035, embedding.quality / (cluster.quality_sum + embedding.quality)),
            )
            cluster.centroid = (
                cluster.centroid * (1.0 - update_weight)
                + embedding.vector * update_weight
            )
            if embedding.backend != "dsp":
                cluster.centroid = normalize_vector(cluster.centroid)
            cluster.quality_sum += embedding.quality
            update_cluster_exemplars(cluster, embedding.vector)
        cluster.samples += 1
        cluster.last_seen_at = time.time()
        return cluster

    def create_cluster(
        self,
        embedding: VoiceEmbedding,
        min_quality: float,
        samples: int = 1,
        quality_sum: float | None = None,
    ) -> SpeakerCluster:
        speaker_number = self.speaker_label_offset + len(self.clusters) + 1
        cluster = SpeakerCluster(
            id=f"speaker-{speaker_number}",
            label=f"Speaker {speaker_number}",
            backend=embedding.backend,
            centroid=embedding.vector.copy(),
            samples=samples,
            quality_sum=max(
                embedding.quality if quality_sum is None else quality_sum,
                min_quality,
            ),
            exemplars=[embedding.vector.copy()],
        )
        self.clusters.append(cluster)
        return cluster

    def update_pending_candidate(
        self,
        embedding: VoiceEmbedding,
        threshold: float,
        min_quality: float,
    ) -> SpeakerCluster | None:
        best: tuple[float, PendingSpeakerCandidate] | None = None
        for candidate in self.pending_candidates:
            if candidate.backend != embedding.backend:
                continue
            distance = voice_distance(candidate.centroid, embedding.vector)
            if best is None or distance < best[0]:
                best = (distance, candidate)

        now = time.time()
        if best is None or best[0] > threshold * 0.85:
            candidate = PendingSpeakerCandidate(
                backend=embedding.backend,
                centroid=embedding.vector.copy(),
                quality_sum=embedding.quality,
                last_seen_at=now,
            )
            self.pending_candidates.append(candidate)
            self.trim_pending_candidates()
            return None

        candidate = best[1]
        candidate.samples += 1
        candidate.quality_sum += embedding.quality
        candidate.last_seen_at = now
        update_weight = min(
            0.35,
            max(0.12, embedding.quality / max(candidate.quality_sum, 1e-6)),
        )
        candidate.centroid = (
            candidate.centroid * (1.0 - update_weight)
            + embedding.vector * update_weight
        ).astype(np.float32)
        if embedding.backend != "dsp":
            candidate.centroid = normalize_vector(candidate.centroid)

        average_quality = candidate.quality_sum / max(1, candidate.samples)
        if (
            candidate.samples >= pending_speaker_promotion_samples()
            and average_quality >= min_quality * 0.45
        ):
            self.pending_candidates.remove(candidate)
            return self.create_cluster(
                VoiceEmbedding(
                    embedding.backend,
                    candidate.centroid,
                    max(average_quality, min_quality),
                ),
                min_quality,
                samples=candidate.samples,
                quality_sum=candidate.quality_sum,
            )
        return None

    def prune_pending_candidates(self) -> None:
        if not self.pending_candidates:
            return
        cutoff = time.time() - DEFAULT_PENDING_SPEAKER_TTL_SECONDS
        self.pending_candidates = [
            candidate
            for candidate in self.pending_candidates
            if candidate.last_seen_at >= cutoff
        ]
        self.trim_pending_candidates()

    def trim_pending_candidates(self) -> None:
        if len(self.pending_candidates) <= DEFAULT_PENDING_SPEAKER_EXEMPLAR_LIMIT:
            return
        self.pending_candidates.sort(
            key=lambda candidate: (
                candidate.samples,
                candidate.quality_sum,
                candidate.last_seen_at,
            ),
            reverse=True,
        )
        del self.pending_candidates[DEFAULT_PENDING_SPEAKER_EXEMPLAR_LIMIT:]

    def assign_to_existing_cluster(
        self,
        best: tuple[float, SpeakerCluster] | None,
        embedding: VoiceEmbedding,
    ) -> SpeakerCluster:
        if best is not None:
            cluster = best[1]
        else:
            cluster = max(self.clusters, key=lambda existing: existing.last_seen_at)
        cluster.samples += 1
        cluster.last_seen_at = time.time()
        if cluster.backend == embedding.backend and embedding.quality >= speaker_min_quality():
            update_weight = min(0.08, max(0.02, embedding.quality / (cluster.quality_sum + embedding.quality)))
            cluster.centroid = (
                cluster.centroid * (1.0 - update_weight)
                + embedding.vector * update_weight
            )
            if embedding.backend != "dsp":
                cluster.centroid = normalize_vector(cluster.centroid)
            cluster.quality_sum += embedding.quality
            update_cluster_exemplars(cluster, embedding.vector)
        return cluster

    def labels(self) -> list[str]:
        return [cluster.label for cluster in self.clusters]

    def distance_threshold(self, backend: str) -> float:
        if self.threshold is not None:
            return self.threshold
        if backend == "dsp":
            default = DEFAULT_DSP_SPEAKER_DISTANCE_THRESHOLD
        else:
            default = DEFAULT_NEURAL_SPEAKER_DISTANCE_THRESHOLDS.get(
                backend,
                DEFAULT_NEURAL_SPEAKER_DISTANCE_THRESHOLD,
            )
        return parse_positive_float(
            os.getenv("ROOMPULSE_SPEAKER_DISTANCE_THRESHOLD"),
            default,
        )


class TranscriptionSession:
    def __init__(self, websocket: WebSocket) -> None:
        self.websocket = websocket
        self.buffer = bytearray()
        self.buffer_lock = asyncio.Lock()
        self.flush_lock = asyncio.Lock()
        self.closed = False
        self.clusterer = SpeakerClusterer()
        self.sequence = 0
        self.min_seconds, self.max_seconds = transcription_window_seconds()
        self.language = os.getenv("ROOMPULSE_WHISPER_LANGUAGE", DEFAULT_LANGUAGE)

    async def handle_control(self, raw: str) -> None:
        try:
            message = json.loads(raw)
        except json.JSONDecodeError:
            await self.send_error("Invalid control message")
            return

        if message.get("type") == "reset":
            async with self.flush_lock:
                async with self.buffer_lock:
                    self.buffer.clear()
                max_clusters = parse_speaker_cluster_cap(
                    message.get("maxSpeakerClusters"),
                    speaker_max_clusters(),
                )
                self.clusterer = SpeakerClusterer(
                    max_clusters=max_clusters,
                    speaker_label_offset=parse_speaker_label_offset(
                        message.get("speakerLabelOffset")
                    ),
                )
                self.sequence = 0
            await self.send_status("reset", "Transcription session reset")
        elif message.get("type") == "configure":
            async with self.flush_lock:
                self.clusterer.max_clusters = parse_speaker_cluster_cap(
                    message.get("maxSpeakerClusters"),
                    self.clusterer.max_clusters,
                )
                if not self.clusterer.clusters:
                    self.clusterer.speaker_label_offset = parse_speaker_label_offset(
                        message.get("speakerLabelOffset"),
                        self.clusterer.speaker_label_offset,
                    )
            await self.send_status("configured", "Transcription session configured")
        elif message.get("type") == "flush":
            await self.flush(force=True)
            await self.send_status("flushed", "Transcription buffer flushed")

    async def append_audio(self, chunk: bytes) -> None:
        async with self.buffer_lock:
            self.buffer.extend(chunk)

    async def process_loop(self) -> None:
        while not self.closed:
            await asyncio.sleep(0.5)
            await self.flush(force=False)

    async def flush(self, force: bool) -> None:
        async with self.flush_lock:
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

            audio = prepare_speech_audio(pcm16_to_float32(raw))
            if not has_speech(audio):
                return

            await self.send_status("transcribing", "Transcribing speech segment")
            try:
                local_model = await ensure_model_loaded()
                text = await transcribe_audio(local_model, audio, self.language)
            except Exception as exc:
                await self.send_error(f"Transcription failed: {exc}")
                await self.send_status("listening", "Listening")
                return
            if not text:
                await self.send_status("listening", "Listening")
                return

            self.sequence += 1
            try:
                speaker = await self.clusterer.assign(audio)
                speaker_id = speaker.id
                speaker_label = speaker.label
                observed_speaker_labels = self.clusterer.labels()
            except Exception as exc:
                await self.send_error(f"Speaker clustering failed: {exc}")
                speaker_id = "speaker-1"
                speaker_label = "Speaker 1"
                observed_speaker_labels = self.clusterer.labels() or [speaker_label]
            duration_ms = round((len(audio) / SAMPLE_RATE) * 1000)
            await self.websocket.send_json(
                {
                    "type": "final_transcript",
                    "id": f"local-{int(time.time() * 1000)}-{self.sequence}",
                    "speakerId": speaker_id,
                    "speakerLabel": speaker_label,
                    "text": text,
                    "confidence": 0.9,
                    "durationMs": duration_ms,
                    "observedSpeakerLabels": observed_speaker_labels,
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
            beam_size=parse_positive_int(
                os.getenv("ROOMPULSE_WHISPER_BEAM_SIZE"),
                DEFAULT_BEAM_SIZE,
            ),
            best_of=parse_positive_int(
                os.getenv("ROOMPULSE_WHISPER_BEST_OF"),
                DEFAULT_BEST_OF,
            ),
            temperature=0,
            vad_filter=os.getenv("ROOMPULSE_WHISPER_VAD", "1") != "0",
            vad_parameters={
                "min_speech_duration_ms": 180,
                "min_silence_duration_ms": 350,
                "speech_pad_ms": 120,
            },
            condition_on_previous_text=False,
            no_speech_threshold=parse_probability(
                os.getenv("ROOMPULSE_WHISPER_NO_SPEECH_THRESHOLD"),
                DEFAULT_NO_SPEECH_THRESHOLD,
            ),
            initial_prompt=(
                "This is a business meeting transcript. Use ordinary punctuation. "
                "Ignore background noise, repeated apologies from noise, and room hum."
            ),
        )
        return clean_transcript_text(
            " ".join(segment.text.strip() for segment in segments).strip()
        )

    return await asyncio.to_thread(run)


def seconds_to_bytes(seconds: float) -> int:
    return int(seconds * SAMPLE_RATE * BYTES_PER_SAMPLE)


def transcription_window_seconds() -> tuple[float, float]:
    min_seconds = parse_positive_float(
        os.getenv("ROOMPULSE_TRANSCRIPTION_MIN_SECONDS"),
        2.0,
    )
    max_seconds = parse_positive_float(
        os.getenv("ROOMPULSE_TRANSCRIPTION_MAX_SECONDS"),
        4.0,
    )
    if max_seconds < min_seconds:
        max_seconds = min_seconds
    return min_seconds, max_seconds


def parse_positive_float(raw: str | None, default: float) -> float:
    if raw is None:
        return default
    try:
        value = float(raw)
    except ValueError:
        return default
    return value if math.isfinite(value) and value > 0 else default


def parse_positive_int(raw: str | None, default: int) -> int:
    return parse_positive_int_value(raw, default)


def parse_positive_int_value(raw: object, default: int) -> int:
    if raw is None:
        return default
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return default
    return value if value > 0 else default


def parse_probability(raw: str | None, default: float) -> float:
    if raw is None:
        return default
    try:
        value = float(raw)
    except ValueError:
        return default
    return value if 0.0 <= value <= 1.0 else default


def clean_transcript_text(text: str) -> str:
    normalized = " ".join(text.strip().split())
    if not normalized:
        return ""

    tokens = [
        token
        for token in (
            re.sub(r"(^[^\w']+|[^\w']+$)", "", raw).lower()
            for raw in normalized.split()
        )
        if token
    ]
    if len(tokens) < 6:
        return normalized

    for phrase_size in range(1, min(4, len(tokens) // 3) + 1):
        chunk_count = len(tokens) // phrase_size
        if chunk_count < 3:
            continue
        chunks = [
            tuple(tokens[index : index + phrase_size])
            for index in range(0, chunk_count * phrase_size, phrase_size)
        ]
        chunk, count = collections.Counter(chunks).most_common(1)[0]
        coverage = (count * phrase_size) / len(tokens)
        phrase = " ".join(chunk)
        if count >= 3 and coverage >= 0.72 and phrase in REPEATED_NOISE_PHRASES:
            return ""

    return normalized


def pcm16_to_float32(raw: bytes) -> np.ndarray:
    if len(raw) % BYTES_PER_SAMPLE == 1:
        raw = raw[:-1]
    data = np.frombuffer(raw, dtype=np.int16).astype(np.float32)
    return data / 32768.0


def embedding_to_numpy(value: object) -> np.ndarray:
    if not isinstance(value, np.ndarray) and hasattr(value, "data"):
        data = getattr(value, "data")
        if not isinstance(data, memoryview):
            value = data
    if hasattr(value, "detach"):
        value = value.detach()  # type: ignore[assignment]
    if hasattr(value, "cpu"):
        value = value.cpu()  # type: ignore[assignment]
    if hasattr(value, "numpy"):
        value = value.numpy()  # type: ignore[assignment]
    return np.asarray(value, dtype=np.float32).reshape(-1)


def sanitize_voice_embedding(embedding: VoiceEmbedding) -> VoiceEmbedding:
    vector = np.asarray(embedding.vector, dtype=np.float32).reshape(-1)
    if vector.size == 0 or not np.all(np.isfinite(vector)):
        raise ValueError(f"{embedding.backend} produced an invalid voice embedding")
    if embedding.backend != "dsp":
        vector = normalize_vector(vector)
        if not np.any(vector):
            raise ValueError(f"{embedding.backend} produced an empty voice embedding")
    quality = clamp01(float(embedding.quality))
    return VoiceEmbedding(embedding.backend, vector, quality)


def write_temp_wav(audio: np.ndarray) -> str:
    with NamedTemporaryFile(suffix=".wav", delete=False) as file:
        path = file.name
    pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).astype(np.int16)
    with wave.open(path, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(BYTES_PER_SAMPLE)
        wav_file.setframerate(SAMPLE_RATE)
        wav_file.writeframes(pcm.tobytes())
    return path


def has_speech(audio: np.ndarray) -> bool:
    if audio.size == 0:
        return False
    if webrtcvad is not None and os.getenv("ROOMPULSE_WEBRTC_VAD", "1") != "0":
        try:
            return has_webrtc_speech(audio)
        except Exception:
            pass
    rms = float(np.sqrt(np.mean(np.square(audio))))
    peak = float(np.max(np.abs(audio)))
    return rms > 0.016 and peak > 0.055


def has_webrtc_speech(audio: np.ndarray) -> bool:
    if audio.size < int(SAMPLE_RATE * 0.03):
        return False

    mode = int(os.getenv("ROOMPULSE_WEBRTC_VAD_MODE", str(DEFAULT_VAD_MODE)))
    vad = webrtcvad.Vad(max(0, min(3, mode)))  # type: ignore[union-attr]
    frame_ms = 30
    frame_size = int(SAMPLE_RATE * frame_ms / 1000)
    audio = np.clip(audio, -1.0, 1.0)
    pcm = (audio * 32767.0).astype(np.int16)
    voiced = 0
    total = 0
    for start in range(0, pcm.size - frame_size + 1, frame_size):
        frame = pcm[start : start + frame_size].tobytes()
        if vad.is_speech(frame, SAMPLE_RATE):
            voiced += 1
        total += 1
    if total == 0:
        return False
    voiced_ratio = voiced / total
    return voiced >= 2 and voiced_ratio >= 0.18


def prepare_speech_audio(audio: np.ndarray) -> np.ndarray:
    """Apply conservative cleanup before Whisper and speaker clustering."""
    if audio.size == 0:
        return audio

    cleaned = high_pass_filter(audio.astype(np.float32), cutoff_hz=85.0)
    cleaned = suppress_low_energy_noise(cleaned)
    cleaned = trim_silence(cleaned)
    return normalize_audio(cleaned)


def high_pass_filter(audio: np.ndarray, cutoff_hz: float) -> np.ndarray:
    if audio.size < 2:
        return audio

    dt = 1.0 / SAMPLE_RATE
    rc = 1.0 / (2.0 * math.pi * cutoff_hz)
    alpha = rc / (rc + dt)
    output = np.empty_like(audio)
    output[0] = audio[0]
    for index in range(1, audio.size):
        output[index] = alpha * (output[index - 1] + audio[index] - audio[index - 1])
    return output


def suppress_low_energy_noise(audio: np.ndarray) -> np.ndarray:
    if audio.size < SAMPLE_RATE // 2:
        return audio

    frame_size = int(SAMPLE_RATE * 0.025)
    hop = int(SAMPLE_RATE * 0.01)
    starts, rms = frame_rms(audio, frame_size, hop)
    if starts.size == 0:
        return audio

    noise_floor = float(np.percentile(rms, 25))
    speech_peak = float(np.max(rms))
    gate = max(0.009, noise_floor * 2.4, speech_peak * 0.10)
    frame_gain = np.where(rms >= gate, 1.0, 0.12).astype(np.float32)
    if frame_gain.size >= 5:
        frame_gain = np.convolve(
            frame_gain,
            np.ones(5, dtype=np.float32) / 5,
            mode="same",
        )

    centers = starts + frame_size // 2
    if centers.size == 1:
        return audio * float(frame_gain[0])
    gain = np.interp(
        np.arange(audio.size, dtype=np.float32),
        centers.astype(np.float32),
        frame_gain.astype(np.float32),
        left=float(frame_gain[0]),
        right=float(frame_gain[-1]),
    ).astype(np.float32)
    return audio * gain


def normalize_audio(audio: np.ndarray) -> np.ndarray:
    if audio.size == 0:
        return audio

    rms = float(np.sqrt(np.mean(np.square(audio)))) or 1.0
    gain = min(6.0, 0.08 / rms)
    return np.clip(audio * gain, -1.0, 1.0).astype(np.float32)


def build_dsp_voice_embedding(audio: np.ndarray) -> np.ndarray:
    if audio.size < 256:
        return np.zeros(20, dtype=np.float32)

    audio = audio.astype(np.float32)
    audio = audio - float(np.mean(audio))
    peak = float(np.max(np.abs(audio))) or 1.0
    audio = audio / peak
    audio = pre_emphasis_filter(audio)

    voiced_frames = voiced_analysis_frames(audio)
    if voiced_frames.size > 0:
        window = np.hanning(voiced_frames.shape[1]).astype(np.float32)
        spectra = np.abs(np.fft.rfft(voiced_frames * window, axis=1))
        spectrum = np.mean(spectra, axis=0)
        freqs = np.fft.rfftfreq(voiced_frames.shape[1], 1.0 / SAMPLE_RATE)
    else:
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
    bands = log_frequency_bands(spectrum, freqs, count=24)
    cepstra = mfcc_like_cepstra(np.array(bands, dtype=np.float32), count=8)
    contrast = spectral_contrast_features(spectrum, freqs, groups=6)
    return np.array(
        [
            clamp01(centroid),
            clamp01(bandwidth),
            clamp01(rolloff),
            clamp01(zcr / 0.35),
            clamp01(rms),
            clamp01(pitch),
            *cepstra,
            *contrast,
        ],
        dtype=np.float32,
    )


def pre_emphasis_filter(audio: np.ndarray, coefficient: float = 0.97) -> np.ndarray:
    if audio.size < 2:
        return audio
    emphasized = np.empty_like(audio)
    emphasized[0] = audio[0]
    emphasized[1:] = audio[1:] - coefficient * audio[:-1]
    return emphasized


def voiced_analysis_frames(audio: np.ndarray) -> np.ndarray:
    frame_size = int(SAMPLE_RATE * 0.025)
    hop = int(SAMPLE_RATE * 0.010)
    if audio.size < frame_size:
        return np.empty((0, frame_size), dtype=np.float32)

    starts, rms = frame_rms(audio, frame_size, hop)
    if starts.size == 0:
        return np.empty((0, frame_size), dtype=np.float32)

    stride = audio.strides[0]
    frames = np.lib.stride_tricks.as_strided(
        audio,
        shape=(starts.size, frame_size),
        strides=(hop * stride, stride),
        writeable=False,
    )
    threshold = max(float(np.percentile(rms, 55)) * 1.15, float(np.max(rms)) * 0.18)
    voiced = np.where(rms >= threshold)[0]
    if voiced.size == 0:
        return np.empty((0, frame_size), dtype=np.float32)

    # Cap work per utterance while keeping the highest-energy speech frames.
    if voiced.size > 96:
        ranked = voiced[np.argsort(rms[voiced])[-96:]]
        voiced = np.sort(ranked)
    return np.asarray(frames[voiced], dtype=np.float32)


def voice_embedding_quality(audio: np.ndarray) -> float:
    if audio.size == 0:
        return 0.0

    duration_seconds = audio.size / SAMPLE_RATE
    rms = float(np.sqrt(np.mean(np.square(audio))))
    peak = float(np.max(np.abs(audio)))
    duration_score = clamp01(duration_seconds / 1.2)
    rms_score = clamp01((rms - 0.012) / 0.075)
    peak_score = clamp01((peak - 0.035) / 0.18)
    return clamp01(0.50 * duration_score + 0.35 * rms_score + 0.15 * peak_score)


def speaker_min_quality() -> float:
    return clamp01(
        parse_positive_float(
            os.getenv("ROOMPULSE_SPEAKER_MIN_QUALITY"),
            DEFAULT_SPEAKER_MIN_QUALITY,
        )
    )


def speaker_max_clusters() -> int:
    return min(
        parse_positive_int(
            os.getenv("ROOMPULSE_SPEAKER_MAX_CLUSTERS"),
            DEFAULT_SPEAKER_MAX_CLUSTERS,
        ),
        DEFAULT_SPEAKER_HARD_CLUSTER_LIMIT,
    )


def pending_speaker_promotion_samples() -> int:
    return parse_positive_int(
        os.getenv("ROOMPULSE_PENDING_SPEAKER_PROMOTION_SAMPLES"),
        DEFAULT_PENDING_SPEAKER_PROMOTION_SAMPLES,
    )


def parse_speaker_cluster_cap(raw: object, default: int) -> int:
    return min(
        parse_positive_int_value(raw, default),
        DEFAULT_SPEAKER_HARD_CLUSTER_LIMIT,
    )


def parse_speaker_label_offset(raw: object, default: int = 0) -> int:
    return min(
        parse_nonnegative_int_value(raw, default),
        DEFAULT_SPEAKER_HARD_CLUSTER_LIMIT,
    )


def speaker_backend_failure_limit() -> int:
    return parse_positive_int(
        os.getenv("ROOMPULSE_SPEAKER_BACKEND_FAILURE_LIMIT"),
        DEFAULT_SPEAKER_BACKEND_FAILURE_LIMIT,
    )


def wespeaker_gpu_index() -> int:
    raw = os.getenv("ROOMPULSE_WESPEAKER_DEVICE", "cpu").strip().lower()
    if raw in {"", "cpu", "mps"}:
        return -1
    if raw == "cuda":
        return 0
    if raw.startswith("cuda:"):
        return parse_nonnegative_int_value(raw.split(":", 1)[1], 0)
    return parse_nonnegative_int_value(raw, -1)


def parse_nonnegative_int_value(raw: object, default: int) -> int:
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return default
    return value if value >= 0 else default


def log_frequency_bands(
    spectrum: np.ndarray, freqs: np.ndarray, count: int
) -> list[float]:
    edges = np.geomspace(80, 8_000, count + 1)
    values: list[float] = []
    total = float(np.sum(spectrum)) or 1.0
    for left, right in zip(edges[:-1], edges[1:]):
        mask = (freqs >= left) & (freqs < right)
        ratio = float(np.sum(spectrum[mask]) / total)
        values.append(clamp01(math.log1p(ratio * 100.0) / math.log1p(100.0)))
    return values


def mfcc_like_cepstra(log_bands: np.ndarray, count: int) -> list[float]:
    if log_bands.size == 0:
        return [0.5] * count

    band_count = log_bands.size
    indices = np.arange(band_count, dtype=np.float32) + 0.5
    coefficients: list[float] = []
    for coefficient in range(1, count + 1):
        basis = np.cos(np.pi * coefficient * indices / band_count)
        value = float(np.sum(log_bands * basis) / max(1.0, float(band_count)))
        coefficients.append(clamp01((value + 0.5) / 1.0))
    return coefficients


def spectral_contrast_features(
    spectrum: np.ndarray, freqs: np.ndarray, groups: int
) -> list[float]:
    edges = np.geomspace(80, 8_000, groups + 1)
    values: list[float] = []
    for left, right in zip(edges[:-1], edges[1:]):
        band = spectrum[(freqs >= left) & (freqs < right)]
        if band.size == 0:
            values.append(0.0)
            continue
        low = float(np.percentile(band, 10))
        high = float(np.percentile(band, 90))
        values.append(clamp01((math.log1p(high) - math.log1p(low)) / math.log1p(high + 1.0)))
    return values


def trim_silence(audio: np.ndarray) -> np.ndarray:
    if audio.size < 512:
        return audio

    frame_size = int(SAMPLE_RATE * 0.03)
    hop = int(SAMPLE_RATE * 0.01)
    starts, rms = frame_rms(audio, frame_size, hop)
    if starts.size == 0:
        return audio

    threshold = max(
        0.012,
        float(np.percentile(rms, 35)) * 2.2,
        float(np.max(rms)) * 0.12,
    )
    voiced = np.where(rms >= threshold)[0]
    if voiced.size == 0:
        return audio

    padding = int(SAMPLE_RATE * 0.08)
    first = max(0, int(starts[int(voiced[0])]) - padding)
    last = min(audio.size, int(starts[int(voiced[-1])]) + frame_size + padding)
    return audio[first:last]


def frame_rms(
    audio: np.ndarray,
    frame_size: int,
    hop: int,
) -> tuple[np.ndarray, np.ndarray]:
    if audio.size < frame_size or frame_size <= 0 or hop <= 0:
        return np.array([], dtype=np.int64), np.array([], dtype=np.float32)

    starts = np.arange(0, audio.size - frame_size + 1, hop, dtype=np.int64)
    if starts.size == 0:
        return starts, np.array([], dtype=np.float32)
    stride = audio.strides[0]
    frames = np.lib.stride_tricks.as_strided(
        audio,
        shape=(starts.size, frame_size),
        strides=(hop * stride, stride),
        writeable=False,
    )
    rms = np.sqrt(np.mean(np.square(frames, dtype=np.float32), axis=1))
    return starts, rms.astype(np.float32)


def zero_crossing_rate(audio: np.ndarray) -> float:
    if audio.size < 2:
        return 0.0
    signs = np.signbit(audio)
    return float(np.mean(signs[1:] != signs[:-1]))


def estimate_pitch(audio: np.ndarray) -> float:
    clipped = audio[: min(audio.size, int(SAMPLE_RATE * 0.75))]
    if clipped.size < 512:
        return 0.0
    clipped = clipped - float(np.mean(clipped))
    min_lag = int(SAMPLE_RATE / 320)
    max_lag = int(SAMPLE_RATE / 70)
    if clipped.size <= max_lag:
        return 0.0

    windowed = clipped * np.hanning(clipped.size)
    fft_size = 1 << (windowed.size * 2 - 1).bit_length()
    spectrum = np.fft.rfft(windowed, n=fft_size)
    corr = np.fft.irfft(spectrum * np.conj(spectrum), n=fft_size)[: windowed.size]
    if corr.size <= max_lag or not math.isfinite(float(corr[0])) or corr[0] <= 0:
        return 0.0

    lag_window = corr[min_lag:max_lag]
    if lag_window.size == 0:
        return 0.0
    lag = int(np.argmax(lag_window) + min_lag)
    if lag <= 0 or math.isclose(float(corr[lag]), 0.0):
        return 0.0
    return float(SAMPLE_RATE / lag)


VOICE_DISTANCE_WEIGHTS = np.array(
    [1.2, 0.8, 1.0, 0.8, 0.2, 3.6, *([0.7] * 8), *([0.45] * 6)],
    dtype=np.float32,
)


def voice_distance(left: np.ndarray, right: np.ndarray) -> float:
    if left.size != right.size or left.size == 0:
        return 1.0

    if left.size != VOICE_DISTANCE_WEIGHTS.size:
        left_norm = normalize_vector(left)
        right_norm = normalize_vector(right)
        cosine_similarity = float(np.dot(left_norm, right_norm))
        return clamp01((1.0 - cosine_similarity) / 2.0)

    delta = np.abs(left - right) * VOICE_DISTANCE_WEIGHTS
    return float(np.sqrt(np.mean(np.square(delta))))


def cluster_voice_distance(cluster: SpeakerCluster, vector: np.ndarray) -> float:
    centroid_distance = voice_distance(cluster.centroid, vector)
    exemplar_distances = [
        voice_distance(exemplar, vector)
        for exemplar in cluster.exemplars
        if exemplar.size == vector.size
    ]
    if not exemplar_distances:
        return centroid_distance

    nearest_exemplar_distance = min(exemplar_distances)
    return min(
        centroid_distance,
        nearest_exemplar_distance * 0.78 + centroid_distance * 0.22,
    )


def update_cluster_exemplars(cluster: SpeakerCluster, vector: np.ndarray) -> None:
    if vector.size == 0:
        return

    candidate = vector.copy()
    if cluster.backend != "dsp":
        candidate = normalize_vector(candidate)

    if cluster.exemplars:
        exemplar_distances = [
            (index, voice_distance(exemplar, candidate))
            for index, exemplar in enumerate(cluster.exemplars)
            if exemplar.size == candidate.size
        ]
        nearest_index, nearest_distance = min(
            exemplar_distances,
            key=lambda item: item[1],
            default=(-1, 1.0),
        )
        if 0 <= nearest_index and nearest_distance < 0.012:
            cluster.exemplars[nearest_index] = (
                cluster.exemplars[nearest_index] * 0.9 + candidate * 0.1
            ).astype(np.float32)
            if cluster.backend != "dsp":
                cluster.exemplars[nearest_index] = normalize_vector(
                    cluster.exemplars[nearest_index]
                )
            return

    cluster.exemplars.append(candidate.astype(np.float32))
    if len(cluster.exemplars) > DEFAULT_CLUSTER_EXEMPLAR_LIMIT:
        cluster.exemplars.pop(0)


def normalize_vector(vector: np.ndarray) -> np.ndarray:
    norm = float(np.linalg.norm(vector))
    if norm == 0.0 or not math.isfinite(norm):
        return np.zeros_like(vector, dtype=np.float32)
    return (vector / norm).astype(np.float32)


def clamp01(value: float) -> float:
    value = float(value)
    if not math.isfinite(value):
        return 0.0
    return max(0.0, min(1.0, value))
