# AGENTS.md

You are building RoomPulse, a polished local webapp MVP for a room-visible AI meeting facilitator.

Read `PRODUCT_BRIEF.md` first. Do not substitute a generic meeting notetaker: the key product is a heartbeat-driven visible facilitator that surfaces reminders/concerns/participation nudges every configurable interval.

## Product constraints
- Mode 2 only: shared room display facilitator. No voice output.
- Heartbeat loop is the core primitive. Every heartbeat should attempt to wake the Pi agent harness via a clean adapter.
- Raw transcript must appear live.
- Setup/context feeder before meeting start is required.
- Track expected participant count and observed `Speaker N` clusters; remind room when people haven’t spoken yet.
- Speaker diarization can be MVP-quality using browser audio feature clustering, but make limitations explicit.
- The app must demo even if Pi auth is not configured: implement deterministic local fallback.

## Quality bar
- Polished UI, not a bare scaffold.
- TypeScript strict where reasonable.
- Tests for heartbeat/facilitation logic and speaker tracker.
- README with demo instructions and Pi integration notes.
- Run `npm test` and `npm run build` before saying done.
