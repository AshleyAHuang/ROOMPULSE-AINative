# Transcription And Speaker Tracking

RoomPulse supports deterministic demo transcript mode and optional local mic
transcription.

## Demo transcript mode

Demo mode is always available from the room display. It adds transcript lines
with selectable `Speaker N` labels and is enough to test the heartbeat,
participation, agenda, and review flows.

## Mic mode

Mic mode streams browser audio to a local WebSocket service:

```bash
npm run transcription
```

Default endpoint:

```text
ws://127.0.0.1:8765/ws
```

The browser audio client captures microphone input, downsamples to 16 kHz mono
PCM, and streams it to the service. The service runs `faster-whisper`, finalizes
speech windows, and assigns each segment to an online `Speaker N` cluster.

Health check:

```bash
curl http://127.0.0.1:8765/health
```

## Lighter local runs

The default Whisper model is `small.en`. Use `tiny.en` for a faster CPU smoke:

```bash
ROOMPULSE_WHISPER_MODEL=tiny.en npm run transcription
```

Useful tuning variables:

```bash
ROOMPULSE_WHISPER_MODEL=small.en
ROOMPULSE_WHISPER_DEVICE=cpu
ROOMPULSE_WHISPER_COMPUTE_TYPE=int8
ROOMPULSE_WHISPER_LANGUAGE=en
ROOMPULSE_WHISPER_BEAM_SIZE=5
ROOMPULSE_WHISPER_BEST_OF=5
ROOMPULSE_SPEAKER_DISTANCE_THRESHOLD=0.14
ROOMPULSE_SPEAKER_MAX_CLUSTERS=12
```

## Optional neural speaker embeddings

The built-in DSP speaker embedder is dependency-light. For stronger recurring
voice separation, install optional speaker backends:

```bash
cd services/transcription
uv sync --extra speaker
ROOMPULSE_SPEAKER_EMBEDDING_BACKEND=speechbrain uv run uvicorn server:app --host 127.0.0.1 --port 8765
```

Other supported explicit backends include `pyannote`, `resemblyzer`, `nemo`,
and `wespeaker`. See `services/transcription/README.md` for the full backend
matrix and environment variables.

## Limitations

Speaker labels are not biometric identity. They are recurring voice-pattern
clusters. Labels can be wrong when:

- multiple people speak at once
- the microphone is far from the room
- background noise dominates a speech window
- two voices are similar
- a person speaks too briefly to form a stable cluster

RoomPulse compares expected participant count with observed `Speaker N` clusters
for participation reminders. It does not claim that a named person has or has
not spoken unless a future calibration flow maps a speaker cluster to a person.
