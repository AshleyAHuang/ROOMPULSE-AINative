const baseUrl = process.env.ROOMPULSE_SMOKE_BASE_URL ?? "http://localhost:3000";
const timeoutMs = Number(process.env.ROOMPULSE_SMOKE_TIMEOUT_MS ?? 30_000);
const maxElapsedMs = Number(process.env.ROOMPULSE_SMOKE_MAX_ELAPSED_MS ?? 8_000);
const now = Date.now();

const payload = {
  meeting: {
    title: "RoomPulse strict heartbeat smoke",
    goal: "Verify the real Pi heartbeat API updates the review document.",
    context:
      "This is a real local API smoke test. It must call the running Next.js API route and return Pi output, not a mocked response.",
    agenda: [
      {
        id: "agenda-1",
        title: "Confirm strict Pi heartbeat",
        done: false
      },
      {
        id: "agenda-2",
        title: "Capture visible reminder",
        done: false
      }
    ],
    expectedParticipants: 2,
    participants: [
      { name: "Mina", role: "Product" },
      { name: "Ari", role: "Pi adapter" }
    ],
    heartbeatIntervalSeconds: 30
  },
  transcript: [
    {
      id: "smoke-1",
      speakerId: "speaker-1",
      speakerLabel: "Speaker 1",
      text:
        "We need the strict Pi heartbeat to update the markdown document and provide a concise room reminder without blocking transcript capture.",
      timestamp: now - 2_000,
      source: "simulated",
      confidence: 1
    }
  ],
  observedSpeakerLabels: ["Speaker 1"],
  lastHeartbeatAt: now - 10_000,
  now,
  priorInterventions: [],
  currentReviewMarkdown:
    "# RoomPulse strict heartbeat smoke\n\n## Agenda\n- [ ] Confirm strict Pi heartbeat\n- [ ] Capture visible reminder\n\n## Notes\n- Waiting for strict Pi output.",
  reviewVersions: [],
  meetingStartedAt: now - 15_000,
  isPaused: false,
  heartbeatCount: 0
};

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), timeoutMs);
const startedAt = Date.now();

try {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/heartbeat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload),
    signal: controller.signal
  });
  const elapsedMs = Date.now() - startedAt;
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Heartbeat returned ${response.status} after ${elapsedMs}ms: ${text}`);
  }

  const output = JSON.parse(text);
  if (output.source !== "pi") {
    throw new Error(`Expected Pi output, got ${output.source ?? "missing source"}`);
  }

  if (typeof output.reviewMarkdown !== "string" || !output.reviewMarkdown.trim()) {
    throw new Error("Pi output did not include reviewMarkdown");
  }

  if (elapsedMs > maxElapsedMs) {
    throw new Error(
      `Heartbeat was too slow: ${elapsedMs}ms exceeded ${maxElapsedMs}ms`
    );
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        elapsedMs,
        source: output.source,
        summary: output.summary,
        reminder: output.ephemeralReminder ?? null,
        model: "openai-codex/gpt-5.5",
        thinkingLevel: "off"
      },
      null,
      2
    )
  );
} finally {
  clearTimeout(timeout);
}
