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
speaker-embedding backend is installed and selected. For better voice
categorization, install the optional speaker stack and use a neural speaker
encoder from the pyannote.audio, SpeechBrain, or Resemblyzer projects:

```bash
uv sync --extra speaker
ROOMPULSE_SPEAKER_EMBEDDING_BACKEND=pyannote \
  ROOMPULSE_PYANNOTE_AUTH_TOKEN=hf_... \
  uv run uvicorn server:app --host 127.0.0.1 --port 8765

ROOMPULSE_SPEAKER_EMBEDDING_BACKEND=speechbrain \
  uv run uvicorn server:app --host 127.0.0.1 --port 8765
```

`ROOMPULSE_SPEAKER_EMBEDDING_BACKEND=auto` attempts pyannote first when a
Hugging Face token is configured, then SpeechBrain, then Resemblyzer, then the
built-in DSP embedder. Explicit neural selections accept common aliases such as
`pyannote-embedding` and `speechbrain-ecapa`, and fall back to DSP per segment
if the selected neural encoder cannot produce a valid embedding. Use `dsp` for
the fastest dependency-free local path.

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
  `pyannote`, or `dsp`; default `auto`
- `ROOMPULSE_SPEAKER_DISTANCE_THRESHOLD`: lower splits speaker clusters more
  aggressively, higher merges more aggressively. Defaults to `0.14` for DSP
  embeddings, `0.32` for pyannote embeddings, `0.28` for SpeechBrain ECAPA,
  and `0.30` for Resemblyzer.
- `ROOMPULSE_SPEAKER_MIN_QUALITY`: default `0.18`; short or noisy segments
  below this quality are assigned to the closest existing cluster instead of
  creating a throwaway speaker or corrupting a centroid.
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

Health check:

```bash
curl http://127.0.0.1:8765/health
```
