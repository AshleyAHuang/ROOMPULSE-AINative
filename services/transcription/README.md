# RoomPulse Local Transcription Service

This service receives browser microphone PCM over a WebSocket, runs local
Whisper transcription through `faster-whisper`, and assigns each finalized
speech window to an online `Speaker N` cluster.

```bash
cd services/transcription
uv run uvicorn server:app --host 127.0.0.1 --port 8765
```

The first run downloads the configured Whisper model into the local Hugging Face
cache. The default is `small.en` for better meeting accuracy. Use a smaller
model for lower latency:

```bash
ROOMPULSE_WHISPER_MODEL=tiny.en uv run uvicorn server:app --host 127.0.0.1 --port 8765
```

Speaker clustering uses the deterministic local DSP embedder unless a stronger
speaker-embedding backend is installed and selected. The production clusterer
keeps a bounded voiceprint exemplar set per `Speaker N` and matches against a
small top-k exemplar consensus plus the live centroid, so one mixed or noisy
segment cannot drag every future voice into `Speaker 1`.
When browser mic capture is restarted during the same meeting, RoomPulse sends
a `speakerLabelOffset` reset control so the fresh WebSocket session continues
with the next `Speaker N` label instead of colliding with earlier transcript
labels.

For better voice categorization, install the optional speaker stack and use a
neural speaker encoder from the pyannote.audio, SpeechBrain, Resemblyzer,
NVIDIA NeMo/TitaNet, or WeSpeaker projects:

```bash
uv sync --extra speaker
ROOMPULSE_SPEAKER_EMBEDDING_BACKEND=pyannote \
  ROOMPULSE_PYANNOTE_AUTH_TOKEN=hf_... \
  uv run uvicorn server:app --host 127.0.0.1 --port 8765

ROOMPULSE_SPEAKER_EMBEDDING_BACKEND=speechbrain \
  uv run uvicorn server:app --host 127.0.0.1 --port 8765

uv sync --extra speaker-nemo
ROOMPULSE_SPEAKER_EMBEDDING_BACKEND=nemo \
  uv run uvicorn server:app --host 127.0.0.1 --port 8765

uv pip install "git+https://github.com/wenet-e2e/wespeaker.git"
ROOMPULSE_SPEAKER_EMBEDDING_BACKEND=wespeaker \
  uv run uvicorn server:app --host 127.0.0.1 --port 8765
```

`ROOMPULSE_SPEAKER_EMBEDDING_BACKEND=auto` attempts pyannote first when a
Hugging Face token is configured, then SpeechBrain, then Resemblyzer, then the
built-in DSP embedder. Set `ROOMPULSE_NEMO_AUTO=1` to also try NeMo during
automatic resolution. Set `ROOMPULSE_WESPEAKER_AUTO=1` to also try WeSpeaker.
Explicit neural selections accept common aliases such as `pyannote-embedding`,
`speechbrain-ecapa`, `titanet`, and `we-speaker`, and fall back to DSP per
segment if the selected neural encoder cannot produce a valid embedding.
Explicit neural backends circuit-break to DSP after repeated failures so a
missing gated model or broken local Torch install does not stall every transcript
window. Use `dsp` for the fastest dependency-free local path.

Repeated one-phrase Whisper hallucinations such as room-hum "I'm sorry" loops
are filtered after transcription before they reach the live transcript.

Useful environment variables:

- `ROOMPULSE_WHISPER_MODEL`: default `small.en`
- `ROOMPULSE_WHISPER_DEVICE`: default `cpu`
- `ROOMPULSE_WHISPER_COMPUTE_TYPE`: default `int8`
- `ROOMPULSE_WHISPER_LANGUAGE`: default `en`
- `ROOMPULSE_WHISPER_BEAM_SIZE`: default `5`
- `ROOMPULSE_WHISPER_BEST_OF`: default `5`
- `ROOMPULSE_WHISPER_VAD`: default `1`; set `0` to disable Whisper VAD
- `ROOMPULSE_WHISPER_NO_SPEECH_THRESHOLD`: default `0.55`
- `ROOMPULSE_TRANSCRIPTION_MIN_SECONDS`: default `2.0`
- `ROOMPULSE_TRANSCRIPTION_MAX_SECONDS`: default `4.0`
- `ROOMPULSE_SPEAKER_EMBEDDING_BACKEND`: `auto`, `speechbrain`, `resemblyzer`,
  `pyannote`, `nemo`, `wespeaker`, or `dsp`; default `auto`
- `ROOMPULSE_SPEAKER_DISTANCE_THRESHOLD`: lower splits speaker clusters more
  aggressively, higher merges more aggressively. Defaults to `0.14` for DSP
  embeddings, `0.32` for pyannote embeddings, `0.28` for SpeechBrain ECAPA,
  `0.30` for Resemblyzer, `0.30` for NeMo/TitaNet, and `0.28` for WeSpeaker.
- `ROOMPULSE_SPEAKER_MIN_QUALITY`: default `0.18`; short or noisy segments
  below this quality are assigned to the closest existing cluster instead of
  creating a throwaway speaker or corrupting a centroid.
- `ROOMPULSE_PENDING_SPEAKER_PROMOTION_SAMPLES`: default `2`; repeated quiet
  but distinct voiceprints are promoted from pending candidates into a new
  `Speaker N` cluster after this many matching segments.
- `ROOMPULSE_SPEAKER_MAX_CLUSTERS`: default `12`; caps live `Speaker N`
  creation so noise or backend churn cannot create unbounded speaker labels.
  Values are hard-capped at `24`.
- `ROOMPULSE_SPEAKER_BACKEND_FAILURE_LIMIT`: default `1`; number of failed
  explicit neural speaker-encoder calls before the session uses DSP directly.
- `ROOMPULSE_WEBRTC_VAD`: default `1`; set `0` to disable optional WebRTC voice
  activity detection when installed.
- `ROOMPULSE_WEBRTC_VAD_MODE`: default `2`; valid values are `0` through `3`,
  where higher is more aggressive.
- `ROOMPULSE_PYANNOTE_MODEL`: default `pyannote/embedding`
- `ROOMPULSE_PYANNOTE_AUTH_TOKEN`: Hugging Face token for gated pyannote models.
- `ROOMPULSE_PYANNOTE_DEVICE`: optional Torch device override.
- `ROOMPULSE_SPEECHBRAIN_MODEL`: default `speechbrain/spkrec-ecapa-voxceleb`
- `ROOMPULSE_SPEECHBRAIN_DEVICE`: optional Torch device override
- `ROOMPULSE_SPEECHBRAIN_SAVEDIR`: optional local SpeechBrain model cache
- `ROOMPULSE_NEMO_MODEL`: default `nvidia/speakerverification_en_titanet_large`
- `ROOMPULSE_NEMO_DEVICE`: optional Torch device override
- `ROOMPULSE_NEMO_AUTO`: default `0`; set `1` to let auto mode try NeMo
- `ROOMPULSE_WESPEAKER_MODEL`: default `english`
- `ROOMPULSE_WESPEAKER_MODEL_DIR`: optional local WeSpeaker model directory
- `ROOMPULSE_WESPEAKER_DEVICE`: default `cpu`; accepts `cpu`, `cuda`, `cuda:N`,
  or a numeric GPU index
- `ROOMPULSE_WESPEAKER_AUTO`: default `0`; set `1` to let auto mode try
  WeSpeaker

Health check:

```bash
curl http://127.0.0.1:8765/health
```
