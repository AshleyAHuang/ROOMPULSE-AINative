# RoomPulse Local Transcription Service

This service receives browser microphone PCM over a WebSocket, runs local
Whisper transcription through `faster-whisper`, and assigns each finalized
speech window to an online `Speaker N` cluster.

```bash
cd services/transcription
uv run uvicorn server:app --host 127.0.0.1 --port 8765
```

The first run downloads the configured Whisper model into the local Hugging Face
cache. Use a smaller model for lower latency:

```bash
ROOMPULSE_WHISPER_MODEL=tiny.en uv run uvicorn server:app --host 127.0.0.1 --port 8765
```

Useful environment variables:

- `ROOMPULSE_WHISPER_MODEL`: default `base.en`
- `ROOMPULSE_WHISPER_DEVICE`: default `cpu`
- `ROOMPULSE_WHISPER_COMPUTE_TYPE`: default `int8`
- `ROOMPULSE_WHISPER_LANGUAGE`: default `en`
- `ROOMPULSE_TRANSCRIPTION_MIN_SECONDS`: default `2.0`
- `ROOMPULSE_TRANSCRIPTION_MAX_SECONDS`: default `4.0`

Health check:

```bash
curl http://127.0.0.1:8765/health
```
