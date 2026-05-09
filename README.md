# RoomPulse

RoomPulse is a local-first, room-visible AI meeting facilitator. It is not a private notetaker: the core primitive is a configurable heartbeat that wakes a facilitator adapter and surfaces concise room-facing nudges on a shared display.

## Quick Start

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

Demo flow:

1. Fill the setup/context feeder with title, goal, context, agenda, expected participant count, optional names/roles, and heartbeat interval.
2. Start the meeting.
3. Use demo transcript mode to add lines from `Speaker 1`, `Speaker 2`, etc.
4. Click `Run heartbeat now` to trigger the server-side facilitator adapter.
5. Watch the current facilitator cards, participation panel, agenda progress, transcript, countdown, and intervention timeline update.

## Pi Integration

The explicit integration boundary is:

```ts
runPiHeartbeat(input): Promise<FacilitatorOutput>
```

It lives in `src/lib/pi-adapter.ts`, and the Next.js route at `src/app/api/heartbeat/route.ts` calls it on every heartbeat. The adapter imports `@earendil-works/pi-coding-agent` server-side and tries to create a Pi agent session with tools disabled for a concise JSON-only facilitation response.

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
