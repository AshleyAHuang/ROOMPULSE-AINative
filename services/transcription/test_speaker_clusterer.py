import asyncio
import unittest

import numpy as np

from server import (
    SAMPLE_RATE,
    DspVoiceEmbedder,
    SpeakerClusterer,
    VoiceEmbedding,
    frame_rms,
    trim_silence,
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


class FixedEmbeddingVoiceEmbedder:
    name = "test-neural"

    def __init__(self, vectors: list[np.ndarray]) -> None:
        self.vectors = vectors
        self.index = 0

    def embed(self, _audio: np.ndarray) -> VoiceEmbedding:
        vector = self.vectors[min(self.index, len(self.vectors) - 1)]
        self.index += 1
        return VoiceEmbedding(self.name, vector)


if __name__ == "__main__":
    unittest.main()
