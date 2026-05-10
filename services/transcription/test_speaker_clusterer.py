import asyncio
import os
import unittest

import numpy as np

import server
from server import (
    DEFAULT_NEURAL_SPEAKER_DISTANCE_THRESHOLDS,
    DEFAULT_BEAM_SIZE,
    DEFAULT_BEST_OF,
    DEFAULT_NO_SPEECH_THRESHOLD,
    SAMPLE_RATE,
    DspVoiceEmbedder,
    PyannoteVoiceEmbedder,
    SpeakerClusterer,
    TranscriptionSession,
    VoiceEmbedding,
    build_dsp_voice_embedding,
    frame_rms,
    get_voice_embedder,
    pre_emphasis_filter,
    trim_silence,
    transcribe_audio,
    transcription_window_seconds,
    voice_embedding_quality,
)


def synthetic_voice(
    frequency: float,
    seconds: float = 2.0,
    silence_prefix: float = 0.0,
    silence_suffix: float = 0.0,
) -> np.ndarray:
    sample_count = int(SAMPLE_RATE * seconds)
    t = np.linspace(0, seconds, sample_count, endpoint=False)
    ramp = int(SAMPLE_RATE * 0.05)
    envelope = np.ones(sample_count, dtype=np.float32)
    envelope[:ramp] = np.linspace(0, 1, ramp)
    envelope[-ramp:] = np.linspace(1, 0, ramp)
    voice = (
        0.45 * np.sin(2 * np.pi * frequency * t)
        + 0.22 * np.sin(2 * np.pi * frequency * 2 * t)
        + 0.12 * np.sin(2 * np.pi * frequency * 3 * t)
    ) * envelope
    return np.concatenate(
        [
            np.zeros(int(SAMPLE_RATE * silence_prefix), dtype=np.float32),
            voice.astype(np.float32),
            np.zeros(int(SAMPLE_RATE * silence_suffix), dtype=np.float32),
        ]
    )


class SpeakerClustererTest(unittest.TestCase):
    def test_keeps_nearby_voice_windows_in_same_cluster(self) -> None:
        clusterer = SpeakerClusterer(threshold=0.18, embedder=DspVoiceEmbedder())

        first = asyncio.run(clusterer.assign(synthetic_voice(110)))
        second = asyncio.run(clusterer.assign(synthetic_voice(115)))

        self.assertEqual(first.label, "Speaker 1")
        self.assertEqual(second.label, "Speaker 1")
        self.assertEqual(clusterer.labels(), ["Speaker 1"])

    def test_splits_distinct_voice_windows(self) -> None:
        clusterer = SpeakerClusterer(threshold=0.18, embedder=DspVoiceEmbedder())

        asyncio.run(clusterer.assign(synthetic_voice(110)))
        second = asyncio.run(clusterer.assign(synthetic_voice(190)))

        self.assertEqual(second.label, "Speaker 2")
        self.assertEqual(clusterer.labels(), ["Speaker 1", "Speaker 2"])

    def test_trims_silence_before_embedding(self) -> None:
        audio = synthetic_voice(150, silence_prefix=1.0, silence_suffix=1.0)

        trimmed = trim_silence(audio)

        self.assertLess(trimmed.size, audio.size)
        self.assertGreater(trimmed.size, SAMPLE_RATE)

    def test_uses_cosine_distance_for_neural_embeddings(self) -> None:
        clusterer = SpeakerClusterer(
            threshold=0.2,
            embedder=FixedEmbeddingVoiceEmbedder(
                [
                    np.array([1.0, 0.0, 0.0], dtype=np.float32),
                    np.array([0.99, 0.01, 0.0], dtype=np.float32),
                    np.array([0.0, 1.0, 0.0], dtype=np.float32),
                ]
            ),
        )

        first = asyncio.run(clusterer.assign(synthetic_voice(110)))
        second = asyncio.run(clusterer.assign(synthetic_voice(120)))
        third = asyncio.run(clusterer.assign(synthetic_voice(130)))

        self.assertEqual(first.label, "Speaker 1")
        self.assertEqual(second.label, "Speaker 1")
        self.assertEqual(third.label, "Speaker 2")

    def test_frame_rms_vectorizes_window_energy(self) -> None:
        audio = synthetic_voice(160, seconds=0.5)

        starts, rms = frame_rms(audio, frame_size=400, hop=160)

        self.assertEqual(starts[0], 0)
        self.assertEqual(starts.size, rms.size)
        self.assertGreater(float(np.max(rms)), float(np.min(rms)))

    def test_dsp_embedding_uses_stable_production_feature_vector(self) -> None:
        low_voice = build_dsp_voice_embedding(synthetic_voice(110))
        higher_voice = build_dsp_voice_embedding(synthetic_voice(210))

        self.assertEqual(low_voice.shape, (20,))
        self.assertTrue(np.all(np.isfinite(low_voice)))
        self.assertGreater(float(np.linalg.norm(low_voice - higher_voice)), 0.25)

    def test_dsp_embedding_is_gain_stable(self) -> None:
        voice = synthetic_voice(145)
        quiet = build_dsp_voice_embedding(voice * 0.35)
        loud = build_dsp_voice_embedding(voice * 0.95)

        self.assertLess(float(np.linalg.norm(quiet - loud)), 0.08)

    def test_pre_emphasis_changes_spectrum_without_changing_length(self) -> None:
        voice = synthetic_voice(130, seconds=0.5)
        emphasized = pre_emphasis_filter(voice)

        self.assertEqual(emphasized.shape, voice.shape)
        self.assertFalse(np.allclose(emphasized, voice))

    def test_low_quality_distinct_embedding_does_not_create_noise_cluster(self) -> None:
        clusterer = SpeakerClusterer(
            threshold=0.2,
            embedder=QualityEmbeddingVoiceEmbedder(
                [
                    (
                        np.array([1.0, 0.0, 0.0], dtype=np.float32),
                        1.0,
                    ),
                    (
                        np.array([0.0, 1.0, 0.0], dtype=np.float32),
                        0.05,
                    ),
                ]
            ),
        )

        first = asyncio.run(clusterer.assign(synthetic_voice(110)))
        second = asyncio.run(clusterer.assign(synthetic_voice(240, seconds=0.25)))

        self.assertEqual(first.label, "Speaker 1")
        self.assertEqual(second.label, "Speaker 1")
        self.assertEqual(clusterer.labels(), ["Speaker 1"])

    def test_uses_backend_specific_neural_thresholds(self) -> None:
        clusterer = SpeakerClusterer(embedder=FixedEmbeddingVoiceEmbedder([]))

        self.assertEqual(
            clusterer.distance_threshold("speechbrain-ecapa"),
            DEFAULT_NEURAL_SPEAKER_DISTANCE_THRESHOLDS["speechbrain-ecapa"],
        )
        self.assertEqual(
            clusterer.distance_threshold("pyannote-embedding"),
            DEFAULT_NEURAL_SPEAKER_DISTANCE_THRESHOLDS["pyannote-embedding"],
        )

    def test_invalid_speaker_threshold_env_falls_back_to_backend_default(self) -> None:
        previous_threshold = os.environ.get("ROOMPULSE_SPEAKER_DISTANCE_THRESHOLD")
        os.environ["ROOMPULSE_SPEAKER_DISTANCE_THRESHOLD"] = "not-a-number"
        try:
            clusterer = SpeakerClusterer(embedder=DspVoiceEmbedder())
            threshold = clusterer.distance_threshold("dsp")
        finally:
            if previous_threshold is None:
                os.environ.pop("ROOMPULSE_SPEAKER_DISTANCE_THRESHOLD", None)
            else:
                os.environ["ROOMPULSE_SPEAKER_DISTANCE_THRESHOLD"] = previous_threshold

        self.assertEqual(threshold, server.DEFAULT_DSP_SPEAKER_DISTANCE_THRESHOLD)

    def test_infinite_speaker_threshold_env_falls_back_to_backend_default(self) -> None:
        previous_threshold = os.environ.get("ROOMPULSE_SPEAKER_DISTANCE_THRESHOLD")
        os.environ["ROOMPULSE_SPEAKER_DISTANCE_THRESHOLD"] = "inf"
        try:
            clusterer = SpeakerClusterer(embedder=DspVoiceEmbedder())
            threshold = clusterer.distance_threshold("dsp")
        finally:
            if previous_threshold is None:
                os.environ.pop("ROOMPULSE_SPEAKER_DISTANCE_THRESHOLD", None)
            else:
                os.environ["ROOMPULSE_SPEAKER_DISTANCE_THRESHOLD"] = previous_threshold

        self.assertEqual(threshold, server.DEFAULT_DSP_SPEAKER_DISTANCE_THRESHOLD)

    def test_embedding_quality_scores_short_quiet_audio_lower(self) -> None:
        clean = voice_embedding_quality(synthetic_voice(150, seconds=1.6))
        quiet = voice_embedding_quality(synthetic_voice(150, seconds=0.3) * 0.03)

        self.assertGreater(clean, 0.6)
        self.assertLess(quiet, 0.2)

    def test_explicit_pyannote_backend_can_be_selected_without_loading_model(self) -> None:
        previous_backend = os.environ.get("ROOMPULSE_SPEAKER_EMBEDDING_BACKEND")
        server.voice_embedder = None
        os.environ["ROOMPULSE_SPEAKER_EMBEDDING_BACKEND"] = "pyannote"
        try:
            embedder = get_voice_embedder()
        finally:
            server.voice_embedder = None
            if previous_backend is None:
                os.environ.pop("ROOMPULSE_SPEAKER_EMBEDDING_BACKEND", None)
            else:
                os.environ["ROOMPULSE_SPEAKER_EMBEDDING_BACKEND"] = previous_backend

        self.assertIsInstance(embedder, PyannoteVoiceEmbedder)

    def test_transcription_window_normalizes_bad_env_order(self) -> None:
        previous_min = os.environ.get("ROOMPULSE_TRANSCRIPTION_MIN_SECONDS")
        previous_max = os.environ.get("ROOMPULSE_TRANSCRIPTION_MAX_SECONDS")
        os.environ["ROOMPULSE_TRANSCRIPTION_MIN_SECONDS"] = "4.0"
        os.environ["ROOMPULSE_TRANSCRIPTION_MAX_SECONDS"] = "2.0"
        try:
            min_seconds, max_seconds = transcription_window_seconds()
        finally:
            if previous_min is None:
                os.environ.pop("ROOMPULSE_TRANSCRIPTION_MIN_SECONDS", None)
            else:
                os.environ["ROOMPULSE_TRANSCRIPTION_MIN_SECONDS"] = previous_min
            if previous_max is None:
                os.environ.pop("ROOMPULSE_TRANSCRIPTION_MAX_SECONDS", None)
            else:
                os.environ["ROOMPULSE_TRANSCRIPTION_MAX_SECONDS"] = previous_max

        self.assertEqual(min_seconds, 4.0)
        self.assertEqual(max_seconds, 4.0)

    def test_transcribe_audio_falls_back_for_invalid_whisper_env(self) -> None:
        previous_beam = os.environ.get("ROOMPULSE_WHISPER_BEAM_SIZE")
        previous_best_of = os.environ.get("ROOMPULSE_WHISPER_BEST_OF")
        previous_no_speech = os.environ.get("ROOMPULSE_WHISPER_NO_SPEECH_THRESHOLD")
        os.environ["ROOMPULSE_WHISPER_BEAM_SIZE"] = "wide"
        os.environ["ROOMPULSE_WHISPER_BEST_OF"] = "-2"
        os.environ["ROOMPULSE_WHISPER_NO_SPEECH_THRESHOLD"] = "2"
        model = FakeWhisperModel()
        try:
            text = asyncio.run(transcribe_audio(model, synthetic_voice(150), "en"))
        finally:
            restore_env("ROOMPULSE_WHISPER_BEAM_SIZE", previous_beam)
            restore_env("ROOMPULSE_WHISPER_BEST_OF", previous_best_of)
            restore_env("ROOMPULSE_WHISPER_NO_SPEECH_THRESHOLD", previous_no_speech)

        self.assertEqual(text, "hello room")
        self.assertEqual(model.kwargs["beam_size"], DEFAULT_BEAM_SIZE)
        self.assertEqual(model.kwargs["best_of"], DEFAULT_BEST_OF)
        self.assertEqual(
            model.kwargs["no_speech_threshold"],
            DEFAULT_NO_SPEECH_THRESHOLD,
        )

    def test_flush_returns_to_listening_when_whisper_produces_no_text(self) -> None:
        async def run() -> list[dict]:
            websocket = FakeWebSocket()
            session = TranscriptionSession(websocket)
            session.min_seconds = 0.1
            session.max_seconds = 2.0
            await session.append_audio(float32_to_pcm16(synthetic_voice(150, seconds=0.5)))

            previous_model = server.ensure_model_loaded
            previous_transcribe = server.transcribe_audio

            async def fake_model():
                return object()

            async def fake_transcribe(_model, _audio, _language):
                return ""

            server.ensure_model_loaded = fake_model
            server.transcribe_audio = fake_transcribe
            try:
                await session.flush(force=True)
            finally:
                server.ensure_model_loaded = previous_model
                server.transcribe_audio = previous_transcribe

            return websocket.messages

        messages = asyncio.run(run())

        self.assertEqual(
            [message.get("status") for message in messages if message.get("type") == "engine_status"],
            ["transcribing", "listening"],
        )
        self.assertFalse(any(message.get("type") == "final_transcript" for message in messages))

    def test_flush_reports_transcription_errors_without_killing_session(self) -> None:
        async def run() -> list[dict]:
            websocket = FakeWebSocket()
            session = TranscriptionSession(websocket)
            session.min_seconds = 0.1
            session.max_seconds = 2.0
            await session.append_audio(float32_to_pcm16(synthetic_voice(150, seconds=0.5)))

            previous_model = server.ensure_model_loaded

            async def fake_model():
                raise RuntimeError("model dropped")

            server.ensure_model_loaded = fake_model
            try:
                await session.flush(force=True)
            finally:
                server.ensure_model_loaded = previous_model

            return websocket.messages

        messages = asyncio.run(run())

        self.assertIn(
            {"type": "engine_error", "message": "Transcription failed: model dropped"},
            messages,
        )
        self.assertEqual(messages[-1].get("status"), "listening")

    def test_flush_keeps_transcript_when_speaker_clustering_fails(self) -> None:
        async def run() -> list[dict]:
            websocket = FakeWebSocket()
            session = TranscriptionSession(websocket)
            session.min_seconds = 0.1
            session.max_seconds = 2.0
            session.clusterer = FailingClusterer()
            await session.append_audio(float32_to_pcm16(synthetic_voice(150, seconds=0.5)))

            previous_model = server.ensure_model_loaded
            previous_transcribe = server.transcribe_audio

            async def fake_model():
                return object()

            async def fake_transcribe(_model, _audio, _language):
                return "hello despite clustering"

            server.ensure_model_loaded = fake_model
            server.transcribe_audio = fake_transcribe
            try:
                await session.flush(force=True)
            finally:
                server.ensure_model_loaded = previous_model
                server.transcribe_audio = previous_transcribe

            return websocket.messages

        messages = asyncio.run(run())
        transcript = next(
            message for message in messages if message.get("type") == "final_transcript"
        )

        self.assertIn(
            {
                "type": "engine_error",
                "message": "Speaker clustering failed: cluster backend failed",
            },
            messages,
        )
        self.assertEqual(transcript["speakerLabel"], "Speaker 1")
        self.assertEqual(transcript["text"], "hello despite clustering")
        self.assertEqual(transcript["observedSpeakerLabels"], ["Speaker 1"])
        self.assertEqual(messages[-1].get("status"), "listening")


class FixedEmbeddingVoiceEmbedder:
    name = "test-neural"

    def __init__(self, vectors: list[np.ndarray]) -> None:
        self.vectors = vectors
        self.index = 0

    def embed(self, _audio: np.ndarray) -> VoiceEmbedding:
        vector = self.vectors[min(self.index, len(self.vectors) - 1)]
        self.index += 1
        return VoiceEmbedding(self.name, vector)


class QualityEmbeddingVoiceEmbedder:
    name = "test-neural"

    def __init__(self, values: list[tuple[np.ndarray, float]]) -> None:
        self.values = values
        self.index = 0

    def embed(self, _audio: np.ndarray) -> VoiceEmbedding:
        vector, quality = self.values[min(self.index, len(self.values) - 1)]
        self.index += 1
        return VoiceEmbedding(self.name, vector, quality)


class FakeSegment:
    def __init__(self, text: str) -> None:
        self.text = text


class FakeWhisperModel:
    def __init__(self) -> None:
        self.kwargs = {}

    def transcribe(self, _audio: np.ndarray, **kwargs):
        self.kwargs = kwargs
        return [FakeSegment(" hello room ")], {}


class FakeWebSocket:
    def __init__(self) -> None:
        self.messages: list[dict] = []

    async def send_json(self, payload: dict) -> None:
        self.messages.append(payload)


class FailingClusterer:
    async def assign(self, _audio: np.ndarray):
        raise RuntimeError("cluster backend failed")

    def labels(self) -> list[str]:
        return []


def float32_to_pcm16(audio: np.ndarray) -> bytes:
    return (np.clip(audio, -1.0, 1.0) * 32767.0).astype(np.int16).tobytes()


def restore_env(name: str, value: str | None) -> None:
    if value is None:
        os.environ.pop(name, None)
    else:
        os.environ[name] = value


if __name__ == "__main__":
    unittest.main()
