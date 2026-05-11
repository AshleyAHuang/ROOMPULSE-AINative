# Architecture

RoomPulse is a local-first Next.js app with one core primitive: a heartbeat that
wakes the facilitator adapter and updates a shared room display.

![RoomPulse architecture](assets/architecture.svg)

## Runtime pieces

| Piece | Role |
| --- | --- |
| Browser UI | Setup feeder, raw transcript view, heartbeat controls, review document, agenda, and participation display. |
| `/api/review-document/init` | Initializes the first markdown review document from setup context before the meeting starts. |
| `/api/heartbeat` | Shapes bounded room state and calls the facilitator adapter on each heartbeat. |
| `src/lib/pi-adapter.ts` | Calls Pi/OpenRouter when configured and deterministic local fallback otherwise. |
| SQLite meeting logs | Stores sessions, transcript lines, heartbeat events, review versions, pause/end state, and resumable UI state. |
| Local transcription service | Optional FastAPI/WebSocket service that runs Whisper and online `Speaker N` clustering for mic mode. |

## Heartbeat flow

![Heartbeat loop](assets/heartbeat-loop.svg)

At every heartbeat, RoomPulse sends bounded context:

- meeting title, goal, important context, agenda, expected participants, and
  optional participant names/roles
- elapsed time, pause state, heartbeat count, and active agenda state
- fresh transcript delta plus recent transcript context
- observed `Speaker N` labels and participation status
- recent prior interventions/reminders
- current markdown review document and recent review versions

The facilitator returns:

- a concise summary
- visible cue cards
- a complete next markdown review document
- optional agenda actions
- optional one-heartbeat room reminder

The UI applies the result, saves an append-only event, creates a review version,
and resets the next heartbeat countdown.

## Local persistence

The default database path is `.roompulse/roompulse.sqlite`. The directory is
git-ignored. Set `ROOMPULSE_DB_PATH` to use another SQLite file.

Main tables:

- `meeting_sessions`: current session metadata, latest review, and resumable UI
  state
- `meeting_events`: append-only meeting events
- `transcript_lines`: queryable raw transcript rows
- `review_versions`: every markdown review version

## Fallback model

Fallback is intentional. A demo must work even when Pi auth is missing, so the
adapter catches unavailable Pi/OpenRouter paths and returns deterministic local
facilitation unless `ROOMPULSE_REQUIRE_PI=1` is set.

## Frontend boundaries

The visible product is Mode 2 only: a shared room display. RoomPulse does not
implement voice output, private invisible assistant mode, or direct autonomous
messaging. All facilitator output is rendered visibly in the room UI.
