# Pi Integration

RoomPulse calls the facilitator through one clean server-side boundary:

```ts
runPiHeartbeat(input): Promise<FacilitatorOutput>
```

The implementation lives in `src/lib/pi-adapter.ts`. The Next.js heartbeat route
at `src/app/api/heartbeat/route.ts` calls it every heartbeat.

## Default provider

By default, RoomPulse targets the Pi OpenAI Codex provider:

```bash
ROOMPULSE_PI_PROVIDER=openai-codex
ROOMPULSE_PI_MODEL=gpt-5.5
ROOMPULSE_PI_THINKING_LEVEL=off
```

If Pi does not already have `openai-codex` auth, RoomPulse can import the local
Codex CLI ChatGPT login from `~/.codex/auth.json` into the in-memory Pi auth
store for the heartbeat session. Run `codex login` first on the machine hosting
the Next.js server.

Disable that bridge with:

```bash
ROOMPULSE_IMPORT_CODEX_CLI_AUTH=0 npm run dev
```

## OpenRouter provider

RoomPulse can use OpenRouter through the same heartbeat contract:

```bash
ROOMPULSE_PI_PROVIDER=openrouter \
ROOMPULSE_PI_MODEL=openai/gpt-4o-mini \
OPENROUTER_API_KEY=sk-or-... \
npm run dev
```

Optional OpenRouter overrides:

```bash
ROOMPULSE_OPENROUTER_API_KEY=sk-or-...
ROOMPULSE_OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
ROOMPULSE_OPENROUTER_REFERER=http://localhost:3000
ROOMPULSE_OPENROUTER_TITLE=RoomPulse
```

## Fallback and strict mode

Normal mode falls back locally:

```bash
npm run dev
```

Guaranteed local-only demo mode:

```bash
npm run demo
```

Strict mode requires real Pi/OpenRouter output:

```bash
npm run dev:strict
npm run smoke:heartbeat
```

Strict mode sets:

```bash
ROOMPULSE_REQUIRE_PI=1
NEXT_PUBLIC_ROOMPULSE_REQUIRE_PI=1
```

The smoke command posts to `/api/heartbeat` and fails unless the facilitator
source is `pi` or `openrouter`.

## Heartbeat contract

The adapter receives `HeartbeatInput`, including:

- setup context and agenda
- bounded transcript delta and recent transcript context
- participation status from expected participants and observed speaker labels
- prior facilitator interventions
- current markdown review document and review versions
- elapsed time, heartbeat count, and pause state

It returns `FacilitatorOutput`, including:

- `source`: `pi`, `openrouter`, or `local-fallback`
- `cards`: visible room-facing cues
- `summary`: concise heartbeat summary
- `reviewMarkdown`: the complete next review document
- `agendaActions`: optional item create/update actions
- `uiActions`: optional display-tool actions
- `ephemeralReminder`: optional one-heartbeat room reminder

The UI caps and validates facilitator output before rendering it.
