# RoomPulse

RoomPulse is a local-first, room-visible AI meeting facilitator. It is not a private notetaker: the core primitive is a configurable heartbeat that wakes a facilitator adapter and surfaces concise room-facing nudges on a shared display.

## Quick Start

```bash
npm install
npm run transcription
```

In another terminal:

```bash
npm run dev
```

Open `http://localhost:3000`.

### Hackathon demo

The fastest path is the **Launch live demo** button on the setup screen. It
loads a launch-readiness meeting and runs a 75-second hard-coded transcript
stream. The transcript is scripted; heartbeat reviews, agenda changes, and
reminders still go through the Pi heartbeat path each time, with local fallback
only when Pi is unavailable.

Local run flow:

1. Fill the setup/context feeder with title, goal, context, agenda, expected participant count, optional names/roles, and heartbeat interval.
2. Start the meeting. RoomPulse makes one initialization API call to generate the first markdown review document from the final setup input.
3. Click `Mic` and allow browser microphone access for local real-time transcription, or use demo transcript mode to add lines from `Speaker 1`, `Speaker 2`, etc.
4. Click `Run heartbeat` to trigger the server-side facilitator adapter.
5. Watch the three-panel room display update:
   - left: live raw transcript
   - center: a versioned AI review markdown document
   - right: agenda, participation, and a quiet one-heartbeat reminder
6. Click `End & review` when the meeting is over. RoomPulse marks the session ended and opens `/meetings/{meetingId}` with copy/export controls.

Agenda checkboxes remain manually editable. Agent-driven agenda changes happen
through the Pi tool contract during heartbeats; the deterministic local
facilitator proposes agenda changes only as a fallback when Pi is unavailable.

## Local Meeting Logs

RoomPulse stores session history locally on the Next.js server in SQLite at
`.roompulse/roompulse.sqlite`. The `.roompulse/` directory is git-ignored.
The database stores:

- `meeting_sessions`: title, goal, status, pause state, latest review document,
  setup context, and the resumable live UI state.
- `meeting_events`: append-only event stream for meeting start, transcript lines,
  heartbeat outputs, agenda changes, review restores, pause toggles, and end
  events.
- `transcript_lines`: queryable raw transcript rows.
- `review_versions`: every markdown document version produced by the
  facilitator or restored by the user.

The setup screen and sidebar list persisted sessions. Active or paused sessions
can be resumed after a page reload; ended sessions open a review page with
copy/export controls for the transcript and latest markdown review.

Backend endpoints:

```text
GET  /api/meetings
POST /api/meetings
GET  /api/meetings/{meetingId}
PATCH /api/meetings/{meetingId}
POST /api/meetings/{meetingId}/events
```

## Pi Integration

The explicit integration boundary is:

```ts
runPiHeartbeat(input): Promise<FacilitatorOutput>
```

It lives in `src/lib/pi-adapter.ts`, and the Next.js route at `src/app/api/heartbeat/route.ts` calls it on every heartbeat. The adapter imports `@earendil-works/pi-coding-agent` server-side and creates an in-memory Pi agent session with tools disabled for a concise JSON-only facilitation response.

Each heartbeat sends the full meeting state to the facilitator: meeting context,
elapsed time, pause state, current transcript, transcript delta, prior
interventions, current review markdown, review version history, participation
state, and agenda state. The facilitator returns a complete next markdown
document, optional agenda actions, concise card metadata, and a one-heartbeat
room reminder.

Before a meeting starts, `/api/review-document/init` asks Pi to initialize the
first markdown review document from the setup context and agenda. The first
heartbeat receives that entire document and every later heartbeat is instructed
to revise the whole file in place, not append a heartbeat log.

By default, RoomPulse uses Pi's OpenAI Codex subscription provider:

```bash
ROOMPULSE_PI_PROVIDER=openai-codex
ROOMPULSE_PI_MODEL=gpt-5.5
ROOMPULSE_PI_THINKING_LEVEL=minimal
```

If Pi does not already have `openai-codex` auth, RoomPulse reads the local Codex CLI ChatGPT login from `~/.codex/auth.json` into the in-memory Pi auth store for the heartbeat session. Run `codex login` first on the machine hosting the Next.js server. You can disable that bridge with:

```bash
ROOMPULSE_IMPORT_CODEX_CLI_AUTH=0 npm run dev
```

Useful adapter overrides:

```bash
ROOMPULSE_PI_PROVIDER=openai-codex
ROOMPULSE_PI_MODEL=gpt-5.5
ROOMPULSE_PI_THINKING_LEVEL=minimal
ROOMPULSE_PI_TIMEOUT_MS=25000
ROOMPULSE_CODEX_AUTH_PATH=/path/to/codex/auth.json
```

If Pi auth, model configuration, or runtime access is missing, the adapter catches the failure and returns deterministic local fallback facilitation. For a guaranteed local-only demo:

```bash
ROOMPULSE_PI_MODE=local npm run dev
```

For a real run where Pi/OpenAI Codex auth must be present, use strict mode. In
strict mode RoomPulse surfaces the heartbeat error instead of silently using the
browser fallback:

```bash
npm run dev:strict
```

## Mic and Transcript Support

RoomPulse supports two transcript paths:

- Mic mode: browser microphone capture streams 16 kHz mono PCM to a local WebSocket transcription service at `ws://127.0.0.1:8765/ws`. The service runs local `faster-whisper` transcription and assigns each finalized speech segment to an online `Speaker N` cluster.
- Demo mode: deterministic simulated transcript lines from selectable `Speaker N` labels. This is useful for tests and UI checks.

Start the local transcription service before using mic mode:

```bash
npm run transcription
```

The first run downloads the configured Whisper model into the local Hugging Face
cache. The default model is `small.en` for better meeting accuracy; for lower
latency on CPU, use:

```bash
ROOMPULSE_WHISPER_MODEL=tiny.en npm run transcription
```

The browser must run on `localhost` or another secure context for microphone
permissions. The local transcription service must be reachable from the browser
at `NEXT_PUBLIC_ROOMPULSE_TRANSCRIPTION_WS` or the default
`ws://127.0.0.1:8765/ws`.

Speaker clustering sensitivity can be tuned without code changes. Lower values
split voices more aggressively; higher values merge more aggressively:

```bash
ROOMPULSE_SPEAKER_DISTANCE_THRESHOLD=0.14 npm run transcription
```

The service also applies local background-noise cleanup before transcription:
high-pass filtering, low-energy noise suppression, silence trimming, Whisper VAD,
and RMS normalization. You can trade speed for accuracy with
`ROOMPULSE_WHISPER_MODEL`, `ROOMPULSE_WHISPER_BEAM_SIZE`, and
`ROOMPULSE_WHISPER_BEST_OF`.

## Speaker Recognition Limitations

The MVP diarization is approximate and not biometric identity. The local service
uses speech-window audio features, log-frequency-band energy, RMS,
zero-crossing rate, spectral shape, and pitch estimate to cluster recurring
voice patterns into `Speaker 1`, `Speaker 2`, etc. Room noise, overlapping
speech, microphone placement, and similar voices can produce incorrect labels.
It does not identify named people unless a later calibration flow maps a
cluster to a participant name.

Participation reminders intentionally compare only expected participant count against observed speaker clusters. RoomPulse does not claim to know that a specific named person has spoken.

## Room Display

After setup, RoomPulse uses a shared-room operator layout:

- Top bar: meeting pause/resume, manual heartbeat, title, mic status, countdown, and settings.
- Left panel: live raw transcript.
- Center panel: a single scrollable AI review markdown document. Every heartbeat creates a new version. The agent is instructed to revise non-destructively: superseded content should be struck through with replacement text added nearby rather than silently deleted.
- Right rail: agenda controls, participation status, and a quiet floating reminder. The reminder is ephemeral and should only represent the latest heartbeat.

The version controls can revert the review document to the previous version or a selected historical version.

## Commands

```bash
npm run transcription
npm test
npm run build
npm run dev
npm run dev:strict
```

## Project Structure

- `src/app/RoomPulseApp.tsx`: setup feeder, room display, heartbeat loop, demo transcript, and mic controls.
- `src/app/api/heartbeat/route.ts`: server heartbeat endpoint.
- `src/app/api/review-document/init/route.ts`: pre-meeting Pi markdown initialization endpoint.
- `src/app/api/meetings/route.ts`: SQLite session list/create endpoint.
- `src/app/api/meetings/[meetingId]/route.ts`: SQLite session read/update endpoint.
- `src/app/api/meetings/[meetingId]/events/route.ts`: append-only meeting event endpoint.
- `src/app/meetings/[meetingId]/page.tsx`: ended-session review page.
- `src/lib/meeting-log-store.ts`: SQLite session, transcript, and review-version store.
- `src/lib/local-transcription-client.ts`: browser mic capture, downsampling, PCM streaming, and transcript event handling.
- `src/lib/pi-adapter.ts`: Pi SDK adapter with deterministic fallback.
- `src/lib/facilitator.ts`: heartbeat input shaping and local facilitator output.
- `src/lib/speaker-tracker.ts`: audio feature clustering and participation status.
- `src/lib/transcript-store.ts`: typed transcript storage helper.
- `services/transcription/server.py`: local `faster-whisper` WebSocket transcription service with online speaker clustering.
