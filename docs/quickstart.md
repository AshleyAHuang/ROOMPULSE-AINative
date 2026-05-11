# Quickstart

This tutorial gets RoomPulse running locally, then shows the optional mic and
strict Pi paths.

## 1. Run the fallback demo

Use this first. It proves the UI, heartbeat loop, local meeting logs, and demo
transcript path work without any external credentials.

```bash
npm install
npm run demo
```

Open `http://localhost:3000`.

Click **Launch live demo**. RoomPulse loads a launch-readiness meeting, starts a
scripted transcript stream, and displays the shared room layout. Click
**Run heartbeat** to trigger the facilitator. In demo mode, facilitation is
deterministic local fallback.

## 2. Start a custom meeting

From the dashboard:

1. Click **New meeting**.
2. Fill in the meeting title, goal, important context, agenda, expected
   participant count, optional names/roles, and heartbeat interval.
3. Click **Start meeting**.
4. Use **Demo** transcript mode or start mic mode.
5. Click **Run heartbeat** whenever you want an immediate review.
6. Click **End & review** to open the saved review/export page.

## 3. Use microphone transcription

Mic mode needs a local WebSocket service in a second terminal.

```bash
npm run transcription
```

Then run the app:

```bash
npm run dev
```

Open `http://localhost:3000`, start a meeting, click **Mic**, and approve the
browser microphone prompt.

Notes:

- The browser must run on `localhost` or another secure context for mic access.
- The default local transcription service is `ws://127.0.0.1:8765/ws`.
- The first run can download the configured Whisper model into the local Hugging
  Face cache.
- For a lighter CPU check, run
  `ROOMPULSE_WHISPER_MODEL=tiny.en npm run transcription`.

## 4. Use Pi or OpenRouter

Normal development mode attempts Pi/OpenRouter when configured and falls back to
local deterministic facilitation when unavailable.

```bash
npm run dev
```

To require remote facilitator output:

```bash
npm run dev:strict
npm run smoke:heartbeat
```

`npm run smoke:heartbeat` posts a heartbeat to the running local API and fails
unless the response source is `pi` or `openrouter`.

## 5. Verify before sharing

```bash
npm run check
```

That runs full TypeScript checking, the Vitest suite, and a production Next.js
build.
