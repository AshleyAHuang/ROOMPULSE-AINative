# RoomPulse

RoomPulse is a local-first, room-visible AI meeting facilitator. It is not a private notetaker: the core primitive is a configurable heartbeat that wakes a facilitator adapter and surfaces concise room-facing nudges on a shared display.

## Quick Start

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

### Hackathon demo (one click)

The fastest path is the **Launch live demo** button on the setup screen. It loads a pre-baked launch-readiness meeting, jumps straight to the room display, and runs a 75-second scripted scenario that fires every facilitator card kind in turn (risk → drift → decision → action → participation → resolution).

You can also start it from the room display via **Run scripted demo** at any time, which resets the transcript and runs the same arc against whatever meeting config is currently loaded.

### Custom flow

1. Fill the setup/context feeder with title, goal, context, agenda, expected participant count, optional names/roles, and heartbeat interval.
2. Start the meeting.
3. Use demo transcript mode to add lines from `Speaker 1`, `Speaker 2`, etc., or switch to mic mode.
4. Click `Run heartbeat now` to trigger the server-side facilitator adapter, or wait for the next scheduled pulse — the countdown ring drains in real time and flashes when a pulse fires.
5. Watch the current facilitator cards, participation panel, agenda progress, transcript, countdown, and intervention timeline update.

Agenda checkboxes remain manually editable, and RoomPulse also auto-checks items when the transcript clearly indicates they were covered, such as “that covers launch risks” or “done with owners.”

## Pi Integration

The explicit integration boundary is:

```ts
runPiHeartbeat(input): Promise<FacilitatorOutput>
```

It lives in `src/lib/pi-adapter.ts`, and the Next.js route at `src/app/api/heartbeat/route.ts` calls it on every heartbeat. The adapter imports `@earendil-works/pi-coding-agent` server-side and creates an in-memory Pi agent session with tools disabled for a concise JSON-only facilitation response.

By default, RoomPulse uses Pi's OpenAI Codex subscription provider:

```bash
ROOMPULSE_PI_PROVIDER=openai-codex
ROOMPULSE_PI_MODEL=gpt-5.5
```

If Pi does not already have `openai-codex` auth, RoomPulse imports the local Codex CLI ChatGPT login from `~/.codex/auth.json` into Pi's `~/.pi/agent/auth.json`. Run `codex login` first on the machine hosting the Next.js server. You can disable that bridge with:

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

## Mic and Transcript Support

RoomPulse supports two transcript paths:

- Demo mode: deterministic simulated transcript lines from selectable `Speaker N` labels. This is the best path for demos and tests.
- Mic mode: browser microphone capture with the Web Speech API for transcript text and Web Audio API feature extraction for approximate speaker clustering.

Browser support varies. Chromium-based browsers usually provide the best Web Speech API support. If the browser does not expose `SpeechRecognition` or `webkitSpeechRecognition`, use demo mode.

## Speaker Recognition Limitations

The MVP diarization is approximate and not biometric identity. It uses cheap browser-side audio features: spectral centroid, RMS, zero-crossing rate, and a pitch estimate. Those features are clustered into `Speaker 1`, `Speaker 2`, etc. Room noise, overlapping speech, microphone placement, and similar voices can produce incorrect labels.

Participation reminders intentionally compare only expected participant count against observed speaker clusters. RoomPulse does not claim to know that a specific named person has spoken.

## Commands

```bash
npm test
npm run build
npm run dev
```

## Project Structure

- `src/app/RoomPulseApp.tsx`: setup feeder, room display, heartbeat loop, demo transcript, and mic controls.
- `src/app/api/heartbeat/route.ts`: server heartbeat endpoint.
- `src/lib/pi-adapter.ts`: Pi SDK adapter with deterministic fallback.
- `src/lib/facilitator.ts`: heartbeat input shaping and local facilitator output.
- `src/lib/speaker-tracker.ts`: audio feature clustering and participation status.
- `src/lib/transcript-store.ts`: typed transcript storage helper.
