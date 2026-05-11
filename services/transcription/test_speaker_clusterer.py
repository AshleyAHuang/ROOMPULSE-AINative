import asyncio
import json
import os
import unittest

import numpy as np

import server
from server import (
    AutoVoiceEmbedder,
    DEFAULT_NEURAL_SPEAKER_DISTANCE_THRESHOLDS,
    DEFAULT_BEAM_SIZE,
    DEFAULT_BEST_OF,
    DEFAULT_NO_SPEECH_THRESHOLD,
    DEFAULT_SPEAKER_HARD_CLUSTER_LIMIT,
    SAMPLE_RATE,
    DspVoiceEmbedder,
    FallbackVoiceEmbedder,
    NemoVoiceEmbedder,
    PyannoteVoiceEmbedder,
    SpeakerClusterer,
    TranscriptionSession,
    VoiceEmbedding,
    WeSpeakerVoiceEmbedder,
    build_dsp_voice_embedding,
    clean_transcript_text,
    cluster_voice_distance,
    embedding_to_numpy,
    estimate_pitch,
    frame_rms,
    get_voice_embedder,
    pre_emphasis_filter,
    trim_silence,
    transcribe_audio,
    transcription_window_seconds,
    voice_embedding_quality,
    wespeaker_gpu_index,
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

    def test_offsets_speaker_labels_after_mic_session_restart(self) -> None:
        clusterer = SpeakerClusterer(
            threshold=0.18,
            embedder=DspVoiceEmbedder(),
            speaker_label_offset=2,
        )

        first = asyncio.run(clusterer.assign(synthetic_voice(110)))
        second = asyncio.run(clusterer.assign(synthetic_voice(190)))

        self.assertEqual(first.id, "speaker-3")
        self.assertEqual(first.label, "Speaker 3")
        self.assertEqual(second.label, "Speaker 4")
        self.assertEqual(clusterer.labels(), ["Speaker 3", "Speaker 4"])

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

    def test_repeated_quiet_distinct_voice_promotes_pending_speaker(self) -> None:
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
                        0.1,
                    ),
                    (
                        np.array([0.0, 0.98, 0.02], dtype=np.float32),
                        0.1,
                    ),
                ]
            ),
        )

        first = asyncio.run(clusterer.assign(synthetic_voice(110)))
        second = asyncio.run(
            clusterer.assign(synthetic_voice(230, seconds=0.55))
        )
        third = asyncio.run(
            clusterer.assign(synthetic_voice(232, seconds=0.55))
        )

        self.assertEqual(first.label, "Speaker 1")
        self.assertEqual(second.label, "Speaker 1")
        self.assertEqual(third.label, "Speaker 2")
        self.assertEqual(clusterer.labels(), ["Speaker 1", "Speaker 2"])
        self.assertGreaterEqual(clusterer.clusters[1].quality_sum, 0.2)

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
        self.assertEqual(
            clusterer.distance_threshold("wespeaker"),
            DEFAULT_NEURAL_SPEAKER_DISTANCE_THRESHOLDS["wespeaker"],
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

        self.assertIsInstance(embedder, FallbackVoiceEmbedder)
        self.assertIsInstance(embedder.primary, PyannoteVoiceEmbedder)

    def test_neural_backend_aliases_are_wrapped_with_dsp_fallback(self) -> None:
        previous_backend = os.environ.get("ROOMPULSE_SPEAKER_EMBEDDING_BACKEND")
        server.voice_embedder = None
        os.environ["ROOMPULSE_SPEAKER_EMBEDDING_BACKEND"] = "speechbrain-ecapa"
        try:
            embedder = get_voice_embedder()
        finally:
            server.voice_embedder = None
            restore_env("ROOMPULSE_SPEAKER_EMBEDDING_BACKEND", previous_backend)

        self.assertIsInstance(embedder, FallbackVoiceEmbedder)
        self.assertEqual(embedder.primary.name, "speechbrain-ecapa")

    def test_explicit_nemo_backend_can_be_selected_without_loading_model(self) -> None:
        previous_backend = os.environ.get("ROOMPULSE_SPEAKER_EMBEDDING_BACKEND")
        server.voice_embedder = None
        os.environ["ROOMPULSE_SPEAKER_EMBEDDING_BACKEND"] = "titanet"
        try:
            embedder = get_voice_embedder()
        finally:
            server.voice_embedder = None
            restore_env("ROOMPULSE_SPEAKER_EMBEDDING_BACKEND", previous_backend)

        self.assertIsInstance(embedder, FallbackVoiceEmbedder)
        self.assertIsInstance(embedder.primary, NemoVoiceEmbedder)

    def test_explicit_wespeaker_backend_can_be_selected_without_loading_model(self) -> None:
        previous_backend = os.environ.get("ROOMPULSE_SPEAKER_EMBEDDING_BACKEND")
        server.voice_embedder = None
        os.environ["ROOMPULSE_SPEAKER_EMBEDDING_BACKEND"] = "we-speaker"
        try:
            embedder = get_voice_embedder()
        finally:
            server.voice_embedder = None
            restore_env("ROOMPULSE_SPEAKER_EMBEDDING_BACKEND", previous_backend)

        self.assertIsInstance(embedder, FallbackVoiceEmbedder)
        self.assertIsInstance(embedder.primary, WeSpeakerVoiceEmbedder)

    def test_wespeaker_device_env_maps_to_gpu_index(self) -> None:
        previous_device = os.environ.get("ROOMPULSE_WESPEAKER_DEVICE")
        try:
            os.environ["ROOMPULSE_WESPEAKER_DEVICE"] = "cpu"
            self.assertEqual(wespeaker_gpu_index(), -1)
            os.environ["ROOMPULSE_WESPEAKER_DEVICE"] = "cuda"
            self.assertEqual(wespeaker_gpu_index(), 0)
            os.environ["ROOMPULSE_WESPEAKER_DEVICE"] = "cuda:2"
            self.assertEqual(wespeaker_gpu_index(), 2)
            os.environ["ROOMPULSE_WESPEAKER_DEVICE"] = "0"
            self.assertEqual(wespeaker_gpu_index(), 0)
            os.environ["ROOMPULSE_WESPEAKER_DEVICE"] = "bad-device"
            self.assertEqual(wespeaker_gpu_index(), -1)
        finally:
            restore_env("ROOMPULSE_WESPEAKER_DEVICE", previous_device)

    def test_fallback_voice_embedder_keeps_clustering_when_neural_backend_fails(self) -> None:
        embedder = FallbackVoiceEmbedder(FailingVoiceEmbedder(), DspVoiceEmbedder())
        clusterer = SpeakerClusterer(
            threshold=0.18,
            embedder=embedder,
        )

        first = asyncio.run(clusterer.assign(synthetic_voice(110)))
        second = asyncio.run(clusterer.assign(synthetic_voice(190)))

        self.assertEqual(first.label, "Speaker 1")
        self.assertEqual(second.label, "Speaker 2")
        self.assertEqual(first.backend, "dsp")
        self.assertTrue(embedder.primary_disabled)

    def test_fallback_voice_embedder_circuit_breaks_repeated_neural_failures(self) -> None:
        primary = FailingVoiceEmbedder()
        embedder = FallbackVoiceEmbedder(primary, DspVoiceEmbedder(), failure_limit=1)

        first = embedder.embed(synthetic_voice(110))
        second = embedder.embed(synthetic_voice(190))

        self.assertEqual(first.backend, "dsp")
        self.assertEqual(second.backend, "dsp")
        self.assertTrue(embedder.primary_disabled)
        self.assertEqual(primary.calls, 1)
        self.assertEqual(embedder.active_backend_name(), "dsp")

    def test_auto_embedder_demotes_failed_resolved_backend_to_dsp(self) -> None:
        embedder = AutoVoiceEmbedder()
        embedder._resolved = FailingVoiceEmbedder()

        embedding = embedder.embed(synthetic_voice(150))

        self.assertEqual(embedding.backend, "dsp")
        self.assertIsInstance(embedder._resolved, DspVoiceEmbedder)

    def test_invalid_neural_embedding_falls_back_before_cluster_update(self) -> None:
        clusterer = SpeakerClusterer(
            threshold=0.18,
            embedder=FallbackVoiceEmbedder(InvalidVoiceEmbedder(), DspVoiceEmbedder()),
        )

        speaker = asyncio.run(clusterer.assign(synthetic_voice(140)))

        self.assertEqual(speaker.label, "Speaker 1")
        self.assertEqual(speaker.backend, "dsp")

    def test_clusterer_caps_speaker_count_and_reuses_existing_cluster(self) -> None:
        clusterer = SpeakerClusterer(
            threshold=0.05,
            max_clusters=2,
            embedder=FixedEmbeddingVoiceEmbedder(
                [
                    np.array([1.0, 0.0, 0.0], dtype=np.float32),
                    np.array([0.0, 1.0, 0.0], dtype=np.float32),
                    np.array([0.0, 0.0, 1.0], dtype=np.float32),
                ]
            ),
        )

        first = asyncio.run(clusterer.assign(synthetic_voice(110)))
        second = asyncio.run(clusterer.assign(synthetic_voice(150)))
        third = asyncio.run(clusterer.assign(synthetic_voice(220)))

        self.assertEqual(first.label, "Speaker 1")
        self.assertEqual(second.label, "Speaker 2")
        self.assertIn(third.label, ["Speaker 1", "Speaker 2"])
        self.assertEqual(clusterer.labels(), ["Speaker 1", "Speaker 2"])

    def test_forced_cap_assignment_does_not_pollute_existing_voiceprint(self) -> None:
        first_voiceprint = np.array([1.0, 0.0, 0.0], dtype=np.float32)
        capped_outlier = np.array([0.0, 1.0, 0.0], dtype=np.float32)
        clusterer = SpeakerClusterer(
            threshold=0.05,
            max_clusters=1,
            embedder=FixedEmbeddingVoiceEmbedder(
                [
                    first_voiceprint,
                    capped_outlier,
                ]
            ),
        )

        first = asyncio.run(clusterer.assign(synthetic_voice(110)))
        second = asyncio.run(clusterer.assign(synthetic_voice(220)))

        self.assertEqual(first.label, "Speaker 1")
        self.assertEqual(second.label, "Speaker 1")
        self.assertTrue(np.allclose(clusterer.clusters[0].centroid, first_voiceprint))
        self.assertEqual(len(clusterer.clusters[0].exemplars), 1)
        self.assertTrue(
            np.allclose(clusterer.clusters[0].exemplars[0], first_voiceprint)
        )

    def test_clusterer_keeps_voiceprint_exemplars_for_robust_matching(self) -> None:
        clusterer = SpeakerClusterer(
            threshold=0.2,
            embedder=FixedEmbeddingVoiceEmbedder(
                [
                    np.array([1.0, 0.0, 0.0], dtype=np.float32),
                    np.array([0.96, 0.04, 0.0], dtype=np.float32),
                    np.array([0.99, 0.01, 0.0], dtype=np.float32),
                ]
            ),
        )

        first = asyncio.run(clusterer.assign(synthetic_voice(110)))
        second = asyncio.run(clusterer.assign(synthetic_voice(115)))
        third = asyncio.run(clusterer.assign(synthetic_voice(118)))

        self.assertEqual(first.label, "Speaker 1")
        self.assertEqual(second.label, "Speaker 1")
        self.assertEqual(third.label, "Speaker 1")
        self.assertGreaterEqual(len(clusterer.clusters[0].exemplars), 1)
        self.assertLess(
            cluster_voice_distance(
                clusterer.clusters[0],
                np.array([1.0, 0.0, 0.0], dtype=np.float32),
            ),
            0.03,
        )

    def test_cluster_match_requires_exemplar_consensus(self) -> None:
        cluster = server.SpeakerCluster(
            id="speaker-1",
            label="Speaker 1",
            backend="test-neural",
            centroid=np.array([1.0, 0.0, 0.0], dtype=np.float32),
            exemplars=[
                np.array([0.0, 1.0, 0.0], dtype=np.float32),
                np.array([0.99, 0.01, 0.0], dtype=np.float32),
                np.array([0.98, 0.02, 0.0], dtype=np.float32),
            ],
        )

        distance = cluster_voice_distance(
            cluster,
            np.array([0.0, 1.0, 0.0], dtype=np.float32),
        )

        self.assertGreater(distance, 0.2)

    def test_centroid_match_still_requires_exemplar_support(self) -> None:
        cluster = server.SpeakerCluster(
            id="speaker-1",
            label="Speaker 1",
            backend="test-neural",
            centroid=np.array([1.0, 0.0, 0.0], dtype=np.float32),
            exemplars=[
                np.array([0.0, 1.0, 0.0], dtype=np.float32),
                np.array([0.0, 0.98, 0.02], dtype=np.float32),
                np.array([0.0, 0.96, 0.04], dtype=np.float32),
            ],
        )

        distance = cluster_voice_distance(
            cluster,
            np.array([1.0, 0.0, 0.0], dtype=np.float32),
        )

        self.assertGreater(distance, 0.2)

    def test_clusterer_bounds_voiceprint_exemplar_memory(self) -> None:
        vectors = [
            np.array([1.0, value / 1000.0, 0.0], dtype=np.float32)
            for value in range(10)
        ]
        clusterer = SpeakerClusterer(
            threshold=0.4,
            embedder=FixedEmbeddingVoiceEmbedder(vectors),
        )

        for _vector in vectors:
            asyncio.run(clusterer.assign(synthetic_voice(130)))

        self.assertEqual(clusterer.labels(), ["Speaker 1"])
        self.assertLessEqual(
            len(clusterer.clusters[0].exemplars),
            server.DEFAULT_CLUSTER_EXEMPLAR_LIMIT,
        )

    def test_invalid_max_cluster_env_uses_default(self) -> None:
        previous_max = os.environ.get("ROOMPULSE_SPEAKER_MAX_CLUSTERS")
        os.environ["ROOMPULSE_SPEAKER_MAX_CLUSTERS"] = "0"
        try:
            self.assertEqual(
                server.speaker_max_clusters(),
                server.DEFAULT_SPEAKER_MAX_CLUSTERS,
            )
        finally:
            restore_env("ROOMPULSE_SPEAKER_MAX_CLUSTERS", previous_max)

    def test_speaker_cluster_cap_is_hard_limited(self) -> None:
        previous_max = os.environ.get("ROOMPULSE_SPEAKER_MAX_CLUSTERS")
        os.environ["ROOMPULSE_SPEAKER_MAX_CLUSTERS"] = "10000"
        try:
            self.assertEqual(
                server.speaker_max_clusters(),
                DEFAULT_SPEAKER_HARD_CLUSTER_LIMIT,
            )
            self.assertEqual(
                server.parse_speaker_cluster_cap(10000, 12),
                DEFAULT_SPEAKER_HARD_CLUSTER_LIMIT,
            )
        finally:
            restore_env("ROOMPULSE_SPEAKER_MAX_CLUSTERS", previous_max)

    def test_fft_pitch_estimator_tracks_synthetic_voice(self) -> None:
        pitch = estimate_pitch(synthetic_voice(155, seconds=1.0))

        self.assertGreater(pitch, 145)
        self.assertLess(pitch, 165)

    def test_embedding_to_numpy_accepts_pyannote_like_data_containers(self) -> None:
        vector = embedding_to_numpy(FakePyannoteEmbedding([[0.1, 0.2, 0.3]]))

        self.assertTrue(np.allclose(vector, np.array([0.1, 0.2, 0.3], dtype=np.float32)))

    def test_embedding_to_numpy_keeps_numpy_arrays(self) -> None:
        vector = embedding_to_numpy(np.array([[0.4, 0.5]], dtype=np.float32))

        self.assertTrue(np.allclose(vector, np.array([0.4, 0.5], dtype=np.float32)))

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

    def test_health_caps_engine_error_fields(self) -> None:
        async def run() -> dict:
            previous_model_error = server.model_error
            previous_import_error = server.WHISPER_IMPORT_ERROR
            server.model_error = "M" * 600
            server.WHISPER_IMPORT_ERROR = RuntimeError("I" * 600)
            try:
                response = await server.health()
            finally:
                server.model_error = previous_model_error
                server.WHISPER_IMPORT_ERROR = previous_import_error
            return json.loads(response.body)

        payload = asyncio.run(run())

        self.assertEqual(len(payload["modelError"]), server.MAX_ENGINE_MESSAGE_LENGTH)
        self.assertEqual(len(payload["importError"]), server.MAX_ENGINE_MESSAGE_LENGTH)
        self.assertEqual(payload["modelError"], "M" * server.MAX_ENGINE_MESSAGE_LENGTH)
        self.assertEqual(
            payload["importError"],
            ("I" * 600)[: server.MAX_ENGINE_MESSAGE_LENGTH],
        )

    def test_health_is_not_ok_after_model_load_error(self) -> None:
        async def run() -> dict:
            previous_model_error = server.model_error
            previous_import_error = server.WHISPER_IMPORT_ERROR
            server.model_error = "model failed to load"
            server.WHISPER_IMPORT_ERROR = None
            try:
                response = await server.health()
            finally:
                server.model_error = previous_model_error
                server.WHISPER_IMPORT_ERROR = previous_import_error
            return json.loads(response.body)

        payload = asyncio.run(run())

        self.assertFalse(payload["ok"])
        self.assertEqual(payload["modelError"], "model failed to load")

    def test_reset_control_configures_session_speaker_cap(self) -> None:
        async def run() -> tuple[int, int, list[dict]]:
            websocket = FakeWebSocket()
            session = TranscriptionSession(websocket)
            await session.handle_control(
                '{"type":"reset","maxSpeakerClusters":10000,"speakerLabelOffset":2}'
            )
            return (
                session.clusterer.max_clusters,
                session.clusterer.speaker_label_offset,
                websocket.messages,
            )

        max_clusters, speaker_label_offset, messages = asyncio.run(run())

        self.assertEqual(max_clusters, DEFAULT_SPEAKER_HARD_CLUSTER_LIMIT)
        self.assertEqual(speaker_label_offset, 2)
        self.assertEqual(messages[-1]["status"], "reset")

    def test_configure_control_updates_existing_session_speaker_cap(self) -> None:
        async def run() -> tuple[int, list[dict]]:
            websocket = FakeWebSocket()
            session = TranscriptionSession(websocket)
            session.clusterer.max_clusters = 2
            await session.handle_control(
                '{"type":"configure","maxSpeakerClusters":5}'
            )
            return session.clusterer.max_clusters, websocket.messages

        max_clusters, messages = asyncio.run(run())

        self.assertEqual(max_clusters, 5)
        self.assertEqual(messages[-1]["status"], "configured")

    def test_control_json_primitives_do_not_kill_session(self) -> None:
        async def run() -> tuple[int, list[dict]]:
            websocket = FakeWebSocket()
            session = TranscriptionSession(websocket)
            await session.handle_control('"reset"')
            await session.handle_control('{"type":"configure","maxSpeakerClusters":5}')
            return session.clusterer.max_clusters, websocket.messages

        max_clusters, messages = asyncio.run(run())

        self.assertEqual(max_clusters, 5)
        self.assertEqual(messages[0]["type"], "engine_error")
        self.assertEqual(messages[0]["message"], "Invalid control message")
        self.assertEqual(messages[-1]["status"], "configured")

    def test_nonfinite_control_numbers_do_not_kill_session(self) -> None:
        async def run() -> tuple[int, int, list[dict]]:
            websocket = FakeWebSocket()
            session = TranscriptionSession(websocket)
            session.clusterer.max_clusters = 4
            session.clusterer.speaker_label_offset = 1
            await session.handle_control(
                '{"type":"configure","maxSpeakerClusters":Infinity,"speakerLabelOffset":NaN}'
            )
            await session.handle_control('{"type":"configure","maxSpeakerClusters":5}')
            return (
                session.clusterer.max_clusters,
                session.clusterer.speaker_label_offset,
                websocket.messages,
            )

        max_clusters, speaker_label_offset, messages = asyncio.run(run())

        self.assertEqual(max_clusters, 5)
        self.assertEqual(speaker_label_offset, 1)
        self.assertEqual(messages[0]["status"], "configured")
        self.assertEqual(messages[-1]["status"], "configured")

    def test_boolean_control_numbers_do_not_reconfigure_session(self) -> None:
        async def run() -> tuple[int, int, list[dict]]:
            websocket = FakeWebSocket()
            session = TranscriptionSession(websocket)
            session.clusterer.max_clusters = 4
            session.clusterer.speaker_label_offset = 2
            await session.handle_control(
                '{"type":"configure","maxSpeakerClusters":true,"speakerLabelOffset":false}'
            )
            return (
                session.clusterer.max_clusters,
                session.clusterer.speaker_label_offset,
                websocket.messages,
            )

        max_clusters, speaker_label_offset, messages = asyncio.run(run())

        self.assertEqual(max_clusters, 4)
        self.assertEqual(speaker_label_offset, 2)
        self.assertEqual(messages[-1]["status"], "configured")

    def test_unknown_control_message_reports_error_without_killing_session(self) -> None:
        async def run() -> tuple[int, list[dict]]:
            websocket = FakeWebSocket()
            session = TranscriptionSession(websocket)
            await session.handle_control('{"type":"bogus","maxSpeakerClusters":999}')
            await session.handle_control('{"type":"configure","maxSpeakerClusters":5}')
            return session.clusterer.max_clusters, websocket.messages

        max_clusters, messages = asyncio.run(run())

        self.assertEqual(max_clusters, 5)
        self.assertEqual(messages[0]["type"], "engine_error")
        self.assertEqual(messages[0]["message"], "Unknown control message")
        self.assertEqual(messages[-1]["status"], "configured")

    def test_oversized_control_message_is_rejected_without_killing_session(self) -> None:
        async def run() -> tuple[int, list[dict]]:
            websocket = FakeWebSocket()
            session = TranscriptionSession(websocket)
            session.clusterer.max_clusters = 4
            await session.handle_control(
                json.dumps(
                    {
                        "type": "configure",
                        "maxSpeakerClusters": 5,
                        "padding": "P" * 3_000,
                    }
                )
            )
            await session.handle_control('{"type":"configure","maxSpeakerClusters":6}')
            return session.clusterer.max_clusters, websocket.messages

        max_clusters, messages = asyncio.run(run())

        self.assertEqual(max_clusters, 6)
        self.assertEqual(messages[0]["type"], "engine_error")
        self.assertEqual(messages[0]["message"], "Control message too large")
        self.assertEqual(messages[-1]["status"], "configured")

    def test_append_audio_bounds_backlog_when_flush_falls_behind(self) -> None:
        async def run() -> bytes:
            websocket = FakeWebSocket()
            session = TranscriptionSession(websocket)
            session.max_seconds = 2.0
            max_buffer_bytes = server.seconds_to_bytes(
                max(server.DEFAULT_MAX_AUDIO_BUFFER_SECONDS, session.max_seconds * 3.0)
            )
            await session.append_audio(b"A" * max_buffer_bytes)
            await session.append_audio(b"B" * max_buffer_bytes)
            return bytes(session.buffer)

        buffer = asyncio.run(run())
        max_buffer_bytes = server.seconds_to_bytes(
            max(server.DEFAULT_MAX_AUDIO_BUFFER_SECONDS, 2.0 * 3.0)
        )

        self.assertEqual(len(buffer), max_buffer_bytes)
        self.assertEqual(buffer, b"B" * max_buffer_bytes)

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

    def test_clean_transcript_text_drops_repeated_noise_hallucinations(self) -> None:
        text = clean_transcript_text(
            "I'm sorry. I'm sorry. I'm sorry. I'm sorry. I'm sorry."
        )

        self.assertEqual(text, "")

    def test_clean_transcript_text_keeps_real_meeting_repetition(self) -> None:
        text = clean_transcript_text(
            "We need a launch owner. We need support coverage. We need final approval."
        )

        self.assertEqual(
            text,
            "We need a launch owner. We need support coverage. We need final approval.",
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

    def test_flush_caps_oversized_transcription_errors_before_socket_send(self) -> None:
        async def run() -> list[dict]:
            websocket = FakeWebSocket()
            session = TranscriptionSession(websocket)
            session.min_seconds = 0.1
            session.max_seconds = 2.0
            await session.append_audio(float32_to_pcm16(synthetic_voice(150, seconds=0.5)))

            previous_model = server.ensure_model_loaded
            oversized_error = "E" * 600

            async def fake_model():
                raise RuntimeError(oversized_error)

            server.ensure_model_loaded = fake_model
            try:
                await session.flush(force=True)
            finally:
                server.ensure_model_loaded = previous_model

            return websocket.messages

        messages = asyncio.run(run())
        error = next(message for message in messages if message.get("type") == "engine_error")

        self.assertEqual(len(error["message"]), 500)
        self.assertEqual(error["message"], ("Transcription failed: " + ("E" * 600))[:500])
        self.assertEqual(messages[-1].get("status"), "listening")

    def test_flush_caps_oversized_transcripts_before_socket_send(self) -> None:
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
                return "T" * 1001

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

        self.assertEqual(len(transcript["text"]), 1000)
        self.assertEqual(transcript["text"], "T" * 1000)
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

    def test_speaker_clustering_failure_respects_restart_label_offset(self) -> None:
        async def run() -> list[dict]:
            websocket = FakeWebSocket()
            session = TranscriptionSession(websocket)
            session.min_seconds = 0.1
            session.max_seconds = 2.0
            session.clusterer = FailingClusterer(speaker_label_offset=2)
            await session.append_audio(float32_to_pcm16(synthetic_voice(150, seconds=0.5)))

            previous_model = server.ensure_model_loaded
            previous_transcribe = server.transcribe_audio

            async def fake_model():
                return object()

            async def fake_transcribe(_model, _audio, _language):
                return "hello after restart"

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

        self.assertEqual(transcript["speakerId"], "speaker-3")
        self.assertEqual(transcript["speakerLabel"], "Speaker 3")
        self.assertEqual(transcript["observedSpeakerLabels"], ["Speaker 3"])

    def test_concurrent_flushes_do_not_overlap_transcription_or_clustering(self) -> None:
        async def run() -> tuple[int, list[dict]]:
            websocket = FakeWebSocket()
            session = TranscriptionSession(websocket)
            session.min_seconds = 0.1
            session.max_seconds = 0.5
            await session.append_audio(float32_to_pcm16(synthetic_voice(150, seconds=1.2)))

            previous_model = server.ensure_model_loaded
            previous_transcribe = server.transcribe_audio
            active_transcribes = 0
            max_active_transcribes = 0

            async def fake_model():
                return object()

            async def fake_transcribe(_model, _audio, _language):
                nonlocal active_transcribes, max_active_transcribes
                active_transcribes += 1
                max_active_transcribes = max(max_active_transcribes, active_transcribes)
                await asyncio.sleep(0.01)
                active_transcribes -= 1
                return "serialized transcript"

            server.ensure_model_loaded = fake_model
            server.transcribe_audio = fake_transcribe
            try:
                await asyncio.gather(session.flush(force=True), session.flush(force=True))
            finally:
                server.ensure_model_loaded = previous_model
                server.transcribe_audio = previous_transcribe

            return max_active_transcribes, websocket.messages

        max_active, messages = asyncio.run(run())
        transcripts = [
            message for message in messages if message.get("type") == "final_transcript"
        ]

        self.assertEqual(max_active, 1)
        self.assertEqual(len(transcripts), 2)
        self.assertEqual(
            [message["speakerLabel"] for message in transcripts],
            ["Speaker 1", "Speaker 1"],
        )

    def test_flush_control_drains_all_buffered_audio_before_ack(self) -> None:
        async def run() -> list[dict]:
            websocket = FakeWebSocket()
            session = TranscriptionSession(websocket)
            session.min_seconds = 0.1
            session.max_seconds = 0.5
            await session.append_audio(float32_to_pcm16(synthetic_voice(150, seconds=1.2)))

            previous_model = server.ensure_model_loaded
            previous_transcribe = server.transcribe_audio
            transcript_count = 0

            async def fake_model():
                return object()

            async def fake_transcribe(_model, _audio, _language):
                nonlocal transcript_count
                transcript_count += 1
                return f"drained transcript {transcript_count}"

            server.ensure_model_loaded = fake_model
            server.transcribe_audio = fake_transcribe
            try:
                await session.handle_control('{"type":"flush"}')
            finally:
                server.ensure_model_loaded = previous_model
                server.transcribe_audio = previous_transcribe

            return websocket.messages

        messages = asyncio.run(run())
        transcripts = [
            message for message in messages if message.get("type") == "final_transcript"
        ]
        flushed_index = next(
            index
            for index, message in enumerate(messages)
            if message.get("status") == "flushed"
        )

        self.assertEqual(len(transcripts), 3)
        self.assertEqual(
            [message["text"] for message in transcripts],
            [
                "drained transcript 1",
                "drained transcript 2",
                "drained transcript 3",
            ],
        )
        self.assertTrue(
            all(messages.index(transcript) < flushed_index for transcript in transcripts)
        )

    def test_reset_waits_for_in_flight_flush_before_resetting_session(self) -> None:
        async def run() -> list[dict]:
            websocket = FakeWebSocket()
            session = TranscriptionSession(websocket)
            session.min_seconds = 0.1
            session.max_seconds = 2.0
            await session.append_audio(float32_to_pcm16(synthetic_voice(150, seconds=0.5)))

            previous_model = server.ensure_model_loaded
            previous_transcribe = server.transcribe_audio
            transcribe_started = asyncio.Event()
            release_transcribe = asyncio.Event()

            async def fake_model():
                return object()

            async def fake_transcribe(_model, _audio, _language):
                transcribe_started.set()
                await release_transcribe.wait()
                return "old audio before reset"

            server.ensure_model_loaded = fake_model
            server.transcribe_audio = fake_transcribe
            try:
                flush_task = asyncio.create_task(session.flush(force=True))
                await transcribe_started.wait()
                reset_task = asyncio.create_task(
                    session.handle_control('{"type":"reset","maxSpeakerClusters":3}')
                )
                await asyncio.sleep(0)
                self.assertFalse(reset_task.done())
                release_transcribe.set()
                await asyncio.gather(flush_task, reset_task)
            finally:
                server.ensure_model_loaded = previous_model
                server.transcribe_audio = previous_transcribe

            return websocket.messages

        messages = asyncio.run(run())
        reset_index = next(
            index
            for index, message in enumerate(messages)
            if message.get("status") == "reset"
        )
        transcript_index = next(
            index
            for index, message in enumerate(messages)
            if message.get("type") == "final_transcript"
        )

        self.assertLess(transcript_index, reset_index)
        self.assertEqual(messages[reset_index]["observedSpeakerLabels"], [])


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
    def __init__(self, speaker_label_offset: int = 0) -> None:
        self.speaker_label_offset = speaker_label_offset

    async def assign(self, _audio: np.ndarray):
        raise RuntimeError("cluster backend failed")

    def labels(self) -> list[str]:
        return []


class FailingVoiceEmbedder:
    name = "failing-neural"

    def __init__(self) -> None:
        self.calls = 0

    def embed(self, _audio: np.ndarray) -> VoiceEmbedding:
        self.calls += 1
        raise RuntimeError("speaker encoder unavailable")


class InvalidVoiceEmbedder:
    name = "invalid-neural"

    def embed(self, _audio: np.ndarray) -> VoiceEmbedding:
        return VoiceEmbedding(
            self.name,
            np.array([float("nan"), 0.0, 0.0], dtype=np.float32),
            0.9,
        )


class FakePyannoteEmbedding:
    def __init__(self, data: list[list[float]]) -> None:
        self.data = data


def float32_to_pcm16(audio: np.ndarray) -> bytes:
    return (np.clip(audio, -1.0, 1.0) * 32767.0).astype(np.int16).tobytes()


def restore_env(name: str, value: str | None) -> None:
    if value is None:
        os.environ.pop(name, None)
    else:
        os.environ[name] = value


if __name__ == "__main__":
    unittest.main()
