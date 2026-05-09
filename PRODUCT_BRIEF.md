# RoomPulse — MVP Product Brief

## One-liner
RoomPulse is a room-visible AI meeting facilitator: a webapp that listens to an in-person/corporate meeting, streams raw transcripts live, and wakes a Pi-powered facilitator agent on a configurable heartbeat to surface concise reminders, concerns, agenda drift, and participation nudges on a shared room display.

## Hanson’s must-haves
- Webapp, polished enough to demo locally.
- Mode 2 only: **room-visible facilitator**. No voice output. No invisible/private mode for MVP.
- Configurable heartbeat interval. Bare-minimum MVP is the heartbeat loop.
- Every heartbeat wakes the Pi agent harness.
- Raw transcripts appear live.
- Context feeder window before the meeting starts:
  - meeting title / goal
  - important context
  - agenda
  - expected total number of people
  - optional participant names/roles
  - heartbeat interval
- Transcription engine should have human voice recognition. MVP can label `Speaker 1`, `Speaker 2`, etc.
- Feature: remind people who haven’t spoken yet. Achieve by tracking unique speaker clusters from voice-pattern recognition and comparing `observed_speakers < expected_people`.
- No voice synthesis needed.

## Core UX
1. Landing/setup screen: meeting context feeder.
2. Start meeting.
3. Main room display with:
   - live raw transcript pane
   - large current facilitator card(s)
   - heartbeat status/countdown
   - participation panel: expected people vs observed speakers, quiet/unseen speaker reminders
   - agenda/progress panel
   - timeline of prior facilitator interventions
4. At every heartbeat:
   - collect transcript delta since last heartbeat + entire running summary/state
   - call Pi agent harness server-side
   - update facilitator cards with: reminders, concerns, agenda drift, open decisions, action items, and participation nudges
   - if Pi unavailable, use deterministic fallback so demo still works

## Technical architecture preference
- TypeScript webapp.
- Use the Pi SDK package `@earendil-works/pi-coding-agent` if feasible. If runtime/auth is not available, implement a `PiFacilitator` adapter with a clean interface and a local fallback, but the code path and docs must clearly show where Pi is invoked.
- Browser mic capture:
  - Web Speech API for live transcription where available.
  - Web Audio API for lightweight voice feature extraction / speaker clustering: pitch-ish, spectral centroid-ish, RMS, zero-crossing or other cheap features. This is MVP-quality diarization, not perfect biometric identity.
- Backend route/action for heartbeat agent calls.
- Local-first demo: should run without production infra.

## Suggested stack
- Next.js + TypeScript + Tailwind/shadcn or polished custom CSS.
- Vitest/React Testing Library for unit/component tests.
- Playwright for smoke/e2e UI if practical.

## Acceptance criteria
- `npm install`, `npm test`, `npm run build` pass.
- Local app starts and renders polished UI.
- Setup screen captures expected people and context.
- Main meeting display shows live transcript area and heartbeat facilitator updates.
- Heartbeat interval can be changed.
- Heartbeat can be triggered manually for demos.
- Participation reminder appears when expected people > observed speaker clusters.
- Pi adapter exists and is documented; fallback works if Pi credentials/package unavailable.
- README explains setup, browser mic permissions, Pi integration, limitations, and demo flow.

## Repo
- GitHub: `Hilo-Hilo/roompulse`
- Keep it private unless Hanson says otherwise.
